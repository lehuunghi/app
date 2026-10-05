import Foundation
import UIKit
import WebKit
import BackgroundTasks

typealias OfflineJSON = [String: Any]
private struct OfflineHTTPError: Error { let status: Int; let code: String }
private final class OfflineNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Short, checkpointed native refreshes. iOS chooses when background work is allowed.
final class OfflineSync {
    static let taskID = "com.lehuunghi.webmail.offline"
    private static let stateLock = NSLock()
    private static var active = true, stopped = false, configurationVersion = 0
    static var foreground: Bool { get { stateLock.lock(); defer { stateLock.unlock() }; return active } set { stateLock.lock(); active = newValue; stateLock.unlock() } }
    static var cancelled: Bool { get { stateLock.lock(); defer { stateLock.unlock() }; return stopped } set { stateLock.lock(); stopped = newValue; stateLock.unlock() } }
    static func beginConfiguration(_ foreground: Bool) -> Int { stateLock.lock(); defer { stateLock.unlock() }; active = foreground; configurationVersion += 1; return configurationVersion }
    private static func currentConfiguration(_ version: Int) -> Bool { stateLock.lock(); defer { stateLock.unlock() }; return version == configurationVersion }
    private let db = OfflineDatabase.shared
    private var config: OfflineJSON = [:], manifest: OfflineJSON = [:]
    private var scope = ""
    private var deadline = Date()
    private let delegate = OfflineNoRedirect()
    private lazy var session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    deinit { session.invalidateAndCancel() }
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskID, using: nil) { task in
            foreground = UIApplication.shared.applicationState == .active
            cancelled = false
            task.expirationHandler = { cancelled = true }
            OfflineDatabase.queue.async {
                let success = OfflineSync().run()
                task.setTaskCompleted(success: success)
                schedule()
            }
        }
    }
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
    static func cancel() { _ = beginConfiguration(true); cancelled = true; BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskID) }
    static func refresh(_ completion: @escaping (UIBackgroundFetchResult) -> Void) {
        guard !foreground else { completion(.noData); return }
        cancelled = false
        OfflineDatabase.queue.async { let result = OfflineSync().run(); DispatchQueue.main.async { completion(result ? .newData : .failed) }; schedule() }
    }
    static func configure(_ scope: String, _ account: String, _ active: Bool, _ binding: String?, _ cookies: [HTTPCookie], _ version: Int) throws {
        guard currentConfiguration(version) else { return }
        let sync = OfflineSync()
        let previous = try sync.read("profile", "native")
        guard (try sync.read("profile", "active"))?["scope"] as? String == scope else { return }
        var cookieMap: [String: HTTPCookie] = [:]
        for cookie in cookies + (HTTPCookieStorage.shared.cookies ?? []) { cookieMap[cookie.domain + "\0" + cookie.path + "\0" + cookie.name] = cookie }
        let filtered = cookieMap.values.filter { (["webmail.jmail.vn", ".webmail.jmail.vn", ".jmail.vn"].contains($0.domain)) && $0.isSecure && ($0.expiresDate == nil || $0.expiresDate! > Date()) }
        let cookie = filtered.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
        let value: OfflineJSON = ["scope": scope, "accountId": account, "cookie": cookie, "binding": binding ?? (previous?["scope"] as? String == scope ? previous?["binding"] as? String ?? "" : "")]
        try sync.db.commit("profile", [["key": "native", "value": try encode(value)]])
        if !active { schedule() }
    }
    private static func encode(_ value: Any) throws -> String { guard let text = String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8) else { throw OfflineStoreError.invalid }; return text }
    private func read(_ scope: String, _ key: String) throws -> OfflineJSON? { guard let text = try db.read(scope, key) else { return nil }; return try JSONSerialization.jsonObject(with: Data(text.utf8)) as? OfflineJSON }
    private func check() throws { if Self.foreground || Self.cancelled || Date() > deadline { throw OfflineStoreError.invalid } }
    private func save(_ changes: [OfflineJSON] = []) throws { try check(); try db.commit(scope, changes + [["key": "manifest", "value": try Self.encode(manifest)]]) }
    private func network(_ path: String, _ type: String? = nil, _ body: Data? = nil) throws -> Data {
        try check()
        guard path.hasPrefix("/api/"), let url = URL(string: "https://webmail.jmail.vn" + path) else { throw OfflineStoreError.invalid }
        var request = URLRequest(url: url); request.timeoutInterval = min(8, max(1, deadline.timeIntervalSinceNow))
        request.setValue(config["cookie"] as? String, forHTTPHeaderField: "Cookie")
        request.setValue("ihasmail", forHTTPHeaderField: "X-Requested-With")
        if let body = body { request.httpMethod = "POST"; request.httpBody = body; request.setValue(type, forHTTPHeaderField: "Content-Type") }
        let gate = DispatchSemaphore(value: 0)
        var result: (Data?, URLResponse?, Error?)?
        let task = session.dataTask(with: request) { data, response, error in result = (data, response, error); gate.signal() }
        task.resume()
        guard gate.wait(timeout: .now() + max(1, min(9, deadline.timeIntervalSinceNow))) == .success else { task.cancel(); throw OfflineStoreError.invalid }
        try check()
        guard let (data, response, error) = result, error == nil, let bytes = data, let http = response as? HTTPURLResponse else { throw OfflineStoreError.storage }
        if http.statusCode == 401 {
            if var profile = try read("profile", "active") { profile["expired"] = true; try db.commit("profile", [["key": "active", "value": try Self.encode(profile)], ["key": "native", "value": NSNull()]]) }
            Self.cancel(); throw OfflineHTTPError(status: 401, code: "unauthenticated")
        }
        guard (200..<300).contains(http.statusCode) else { let json = try? JSONSerialization.jsonObject(with: bytes) as? OfflineJSON; throw OfflineHTTPError(status: http.statusCode, code: json?["error"] as? String ?? "connection_error") }
        guard bytes.count < 128 * 1024 * 1024 else { throw OfflineStoreError.storage }
        return bytes
    }
    private func post(_ path: String, _ body: OfflineJSON) throws -> OfflineJSON { guard let result = try JSONSerialization.jsonObject(with: network(path, "application/json", JSONSerialization.data(withJSONObject: body))) as? OfflineJSON else { throw OfflineStoreError.invalid }; return result }
    private func call(_ method: String, _ args: OfflineJSON) throws -> OfflineJSON {
        var args = args; args["accountId"] = manifest["accountId"]
        let result = try post("/api/jmap", ["using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], "methodCalls": [[method, args, "native"]]])
        guard let calls = result["methodResponses"] as? [[Any]], let call = calls.first, call[0] as? String != "error", let result = call[1] as? OfflineJSON else { throw OfflineStoreError.invalid }; return result
    }
    private func replace(_ value: Any, _ map: [String: String]) -> Any {
        if let string = value as? String { return map[string] ?? string }
        if let array = value as? [Any] { return array.map { replace($0, map) } }
        if let object = value as? OfflineJSON { return Dictionary(uniqueKeysWithValues: object.map { (key, value) in (map[key] ?? key.components(separatedBy: "/").map { map[$0] ?? $0 }.joined(separator: "/"), replace(value, map)) }) }
        return value
    }
    private func unresolved(_ value: Any, _ field: String = "") -> Bool {
        if ["value", "subject", "name", "preview"].contains(field) || field.hasPrefix("header:") { return false }
        if let string = value as? String { return string.hasPrefix("offline:") }
        if let array = value as? [Any] { return array.contains { unresolved($0, field) } }
        if let object = value as? OfflineJSON { return object.contains { $0.key.hasPrefix("offline:") || unresolved($0.value, $0.key) } }
        return false
    }
    private func localBlobs(_ value: Any) -> Set<String> {
        if let array = value as? [Any] { return array.reduce(into: Set<String>()) { $0.formUnion(localBlobs($1)) } }
        if let object = value as? OfflineJSON { var ids = Set<String>(); if let id = object["blobId"] as? String, id.hasPrefix("offline:blob:") { ids.insert(id) }; object.values.forEach { ids.formUnion(localBlobs($0)) }; return ids }
        return []
    }
    private func flush() throws {
        let original = manifest["operations"] as? [OfflineJSON] ?? []
        for op in original {
            try check()
            if op["status"] as? String == "failed" || (op["readyAt"] as? Double ?? 0) > Date().timeIntervalSince1970 * 1000 { continue }
            let id = op["id"] as! String
            do {
                var mappings = manifest["mappings"] as? [String: String] ?? [:]
                for blobID in localBlobs(op["request"]!) where mappings[blobID] == nil {
                    guard let blob = try read(scope, "pendingBlob:" + blobID), let base64 = blob["data"] as? String, let bytes = Data(base64Encoded: base64) else { throw OfflineHTTPError(status: 409, code: "offline_attachment_missing") }
                    let response = try JSONSerialization.jsonObject(with: network("/api/upload/" + enc(manifest["accountId"] as! String), blob["type"] as? String, bytes)) as! OfflineJSON
                    guard let uploaded = response["blobId"] as? String else { throw OfflineStoreError.invalid }
                    mappings[blobID] = uploaded; manifest["mappings"] = mappings; try save([["key": "blob:" + uploaded, "value": try Self.encode(blob)], ["key": "pendingBlob:" + blobID, "value": NSNull()]])
                }
                let request = replace(op["request"]!, mappings) as! OfflineJSON
                if unresolved(request) { throw OfflineHTTPError(status: 409, code: "offline_dependency_missing") }
                let result = try post("/api/offline/jmap/" + enc(id), ["request": request, "base": replace(op["base"] ?? [:], mappings)])
                guard let responses = result["methodResponses"] as? [[Any]] else { throw OfflineStoreError.invalid }
                let sendAccepted = responses.contains { $0[0] as? String == "EmailSubmission/set" && !(($0[1] as? OfflineJSON)?["created"] as? OfflineJSON ?? [:]).isEmpty }
                var errors = responses.contains { response in response[0] as? String == "error" || ["notCreated", "notUpdated", "notDestroyed"].contains(where: { field in !((response[1] as? OfflineJSON)?[field] as? OfflineJSON ?? [:]).isEmpty }) }, changes: [OfflineJSON] = []
                for response in responses {
                    let args = response[1] as! OfflineJSON
                    if response[0] as? String == "error" || ["notCreated", "notUpdated", "notDestroyed"].contains(where: { !(args[$0] as? OfflineJSON ?? [:]).isEmpty }) { errors = true }
                    let local = (op["creations"] as? [String: [String: String]])?[response[2] as! String] ?? [:]
                    for (key, value) in args["created"] as? [String: OfflineJSON] ?? [:] { if let localID = local[key], let serverID = value["id"] as? String { mappings[localID] = serverID; if !errors || sendAccepted { changes += [["key": "mail:" + localID, "value": NSNull()], ["key": "full:" + localID, "value": NSNull()]] } } }
                }
                manifest["mappings"] = mappings
                var operations = manifest["operations"] as? [OfflineJSON] ?? []
                if errors { if let index = operations.firstIndex(where: { $0["id"] as? String == id }) { operations[index]["sendAccepted"] = sendAccepted; operations[index]["status"] = "failed"; operations[index]["error"] = "offline_operation_rejected" } }
                else { operations.removeAll { $0["id"] as? String == id } }
                manifest["operations"] = operations; try save(changes)
            } catch let error as OfflineHTTPError {
                if error.status >= 500 || error.status == 429 || error.status == 401 { throw error }
                if error.code == "operation_in_progress" { continue }
                var operations = manifest["operations"] as? [OfflineJSON] ?? []
                if let index = operations.firstIndex(where: { $0["id"] as? String == id }) { operations[index]["status"] = ["operation_uncertain", "operation_id_reused"].contains(error.code) ? "uncertain" : "failed"; operations[index]["error"] = error.code }
                manifest["operations"] = operations; try save()
            }
        }
    }
    private func pendingCalls() -> [[Any]] { let mappings = manifest["mappings"] as? [String: String] ?? [:]; return (manifest["operations"] as? [OfflineJSON] ?? []).flatMap { (replace($0["request"]!, mappings) as? OfflineJSON)?["methodCalls"] as? [[Any]] ?? [] } }
    private func deleted(_ id: String, _ method: String = "Email/set") -> Bool { pendingCalls().contains { $0[0] as? String == method && (($0[1] as? OfflineJSON)?["destroy"] as? [String] ?? []).contains(id) } }
    private func patch(_ object: OfflineJSON, _ path: [String], _ value: Any) -> OfflineJSON {
        var result = object; guard let key = path.first else { return result }
        if path.count == 1 { if value is NSNull { result.removeValue(forKey: key) } else { result[key] = value } }
        else { result[key] = patch(object[key] as? OfflineJSON ?? [:], Array(path.dropFirst()), value) }; return result
    }
    private func overlay(_ email: OfflineJSON, _ method: String = "Email/set") -> OfflineJSON { var result = email; for call in pendingCalls() where call[0] as? String == method { if let updates = (call[1] as? OfflineJSON)?["update"] as? [String: OfflineJSON], let values = updates[email["id"] as! String] { for (path, value) in values { result = patch(result, path.components(separatedBy: "/").map { $0.replacingOccurrences(of: "~1", with: "/").replacingOccurrences(of: "~0", with: "~") }, value) } } }; return result }
    private func pull() throws {
        var more = true
        while more {
            try check()
            let known = try db.list(scope, "mail:").keys.map { String($0.dropFirst(5)) }.filter { !$0.hasPrefix("offline:") }.prefix(10000)
            let input: OfflineJSON = ["accountId": manifest["accountId"]!, "sinceState": manifest["emailState"] ?? NSNull(), "knownIds": Array(known), "historyDays": manifest["historyDays"]!, "maxMessages": manifest["maxMessages"]!, "snapshot": manifest["backgroundPull"] ?? NSNull()]
            let result = try post("/api/offline/pull", input)
            var changes: [OfflineJSON] = []
            for id in result["removed"] as? [String] ?? [] { changes += [["key": "mail:" + id, "value": NSNull()], ["key": "full:" + id, "value": NSNull()]] }
            for email in result["list"] as? [OfflineJSON] ?? [] { let id = email["id"] as! String; if deleted(id) { continue }; let old = try read(scope, "mail:" + id); let row: OfflineJSON = ["email": overlay(email), "full": old?["full"] as? Bool ?? false, "complete": old?["complete"] as? Bool ?? false, "pinned": old?["pinned"] as? Bool ?? false]; changes.append(["key": "mail:" + id, "value": try Self.encode(row)]) }
            let mappings = manifest["mappings"] as? [String: String] ?? [:]
            let local = (manifest["mailboxes"] as? [OfflineJSON] ?? []).filter { let id = $0["id"] as? String ?? ""; return id.hasPrefix("offline:") && mappings[id] == nil }
            manifest["mailboxes"] = ((result["mailboxes"] as? [OfflineJSON] ?? []) + local).filter { !deleted($0["id"] as! String, "Mailbox/set") }.map { overlay($0, "Mailbox/set") }; manifest["mailboxState"] = result["mailboxState"]; manifest["identities"] = result["identities"]; manifest["emailState"] = result["state"]; manifest["backgroundPull"] = result["snapshot"]; try save(changes); more = result["more"] as? Bool ?? false
        }
    }
    private func enc(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~")))! }
    private func parts(_ value: Any?) -> [OfflineJSON] { if let array = value as? [Any] { return array.flatMap { parts($0) } }; if let object = value as? OfflineJSON { return (object["blobId"] is String ? [object] : []) + parts(object["subParts"]) }; return [] }
    private func full() throws {
        let rows = try db.list(scope, "mail:")
        for (key, text) in rows {
            try check(); let id = String(key.dropFirst(5)); var row = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! OfflineJSON
            if row["complete"] as? Bool == true || id.hasPrefix("offline:") { continue }
            guard try db.bytes(scope) < (manifest["maxBytes"] as? Int64 ?? 0) else { throw OfflineStoreError.storage }
            var email = try read(scope, "full:" + id)
            if email == nil {
                let props = ["id","blobId","threadId","mailboxIds","keywords","from","to","cc","bcc","replyTo","sender","subject","receivedAt","sentAt","size","preview","hasAttachment","messageId","inReplyTo","references","bodyStructure","bodyValues","textBody","htmlBody","attachments","header:List-Unsubscribe:asText","header:List-Unsubscribe-Post:asText","header:List-Id:asText","header:Disposition-Notification-To:asAddresses","header:X-Priority:asText","header:Importance:asText","header:Auto-Submitted:asText","header:Precedence:asText","header:Authentication-Results:asText","header:X-Spam-Status:asText","header:X-Spam-Score:asText","header:X-Spamd-Result:asText"]
                let result = try call("Email/get", ["ids": [id], "properties": props, "fetchTextBodyValues": true, "fetchHTMLBodyValues": true, "maxBodyValueBytes": 2 * 1024 * 1024, "bodyProperties": ["partId","blobId","size","name","type","charset","disposition","cid","subParts"]])
                email = (result["list"] as? [OfflineJSON])?.first
            }
            guard var message = email else { continue }
            row["full"] = !(message["bodyValues"] as? [String: OfflineJSON] ?? [:]).values.contains { $0["isTruncated"] as? Bool == true }
            try save([["key": "full:" + id, "value": try Self.encode(message)], ["key": key, "value": try Self.encode(row)]])
            var unique: [String: OfflineJSON] = [:]
            for field in ["bodyStructure","textBody","htmlBody","attachments"] { for part in parts(message[field]) { if let blob = part["blobId"] as? String { unique[blob] = part } } }
            for (blobID, part) in unique {
                try check(); let cached = try read(scope, "blob:" + blobID); let type = part["type"] as? String ?? "application/octet-stream"; let bytes: Data
                if let data = cached?["data"] as? String, let decoded = Data(base64Encoded: data) { bytes = decoded }
                else {
                    bytes = try network("/api/blob/" + enc(manifest["accountId"] as! String) + "/" + enc(blobID) + "/blob?accept=" + enc(type))
                    guard Double(try db.bytes(scope)) + Double(bytes.count) * 1.4 < (manifest["maxBytes"] as? Double ?? 0) else { throw OfflineStoreError.storage }
                    try save([["key": "blob:" + blobID, "value": try Self.encode(["type": type, "size": bytes.count, "data": bytes.base64EncodedString()])]])
                }
                if let partID = part["partId"] as? String, var values = message["bodyValues"] as? [String: OfflineJSON], var value = values[partID], value["isTruncated"] as? Bool == true {
                    let charset = (part["charset"] as? String ?? "utf-8").lowercased()
                    let encoding: String.Encoding = ["iso-8859-1","latin1"].contains(charset) ? .isoLatin1 : charset == "windows-1252" ? .windowsCP1252 : .utf8
                    guard let text = String(data: bytes, encoding: encoding) else { throw OfflineStoreError.invalid }
                    value["value"] = text; value["isTruncated"] = false; values[partID] = value; message["bodyValues"] = values
                }
            }
            if (message["bodyValues"] as? [String: OfflineJSON] ?? [:]).values.contains(where: { $0["isTruncated"] as? Bool == true }) { throw OfflineStoreError.invalid }
            row["full"] = true; row["complete"] = true
            try save([["key": "full:" + id, "value": try Self.encode(message)], ["key": key, "value": try Self.encode(row)]])
        }
    }
    func run() -> Bool {
        deadline = Date(timeIntervalSinceNow: 25)
        do {
            guard let config = try read("profile", "native"), let profile = try read("profile", "active"), profile["expired"] as? Bool != true, !Self.foreground, !(config["cookie"] as? String ?? "").isEmpty, let scope = config["scope"] as? String, scope == profile["scope"] as? String, let manifest = try read(scope, "manifest"), manifest["accountId"] as? String == config["accountId"] as? String else { return true }
            guard ((manifest["session"] as? OfflineJSON)?["ihasmail"] as? OfflineJSON)?["offlineSync"] as? Int == 1 else { return true }
            self.config = config; self.scope = scope; self.manifest = manifest
            try flush(); try pull(); try full(); self.manifest["lastSync"] = Date().timeIntervalSince1970 * 1000; try save(); return true
        } catch { return Self.foreground || Date() > deadline }
    }
}
