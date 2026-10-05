import Foundation
import Capacitor
import CryptoKit
import Security
import SQLite3

enum OfflineStoreError: Error { case storage, key, invalid }

/// Each SQLite payload is independently authenticated and encrypted. Keys never enter JavaScript.
final class OfflineDatabase {
    static let queue = DispatchQueue(label: "vn.webmail.offline-store")
    static let shared = OfflineDatabase()
    private let service = "com.lehuunghi.webmail.offline.v1"
    private var url: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("offline-mail-v1.db")
    }
    private func key() throws -> SymmetricKey {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: "encryption", kSecReturnData as String: true]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecSuccess, let data = item as? Data { return SymmetricKey(data: data) }
        guard status == errSecItemNotFound else { throw OfflineStoreError.key }
        var bytes = Data(count: 32)
        let generated = bytes.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
        guard generated == errSecSuccess else { throw OfflineStoreError.key }
        let insert: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: "encryption", kSecValueData as String: bytes,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw OfflineStoreError.key }
        return SymmetricKey(data: bytes)
    }
    private func open() throws -> OpaquePointer {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var db: OpaquePointer?
        guard sqlite3_open(url.path, &db) == SQLITE_OK, let db = db else { throw OfflineStoreError.storage }
        do {
            try exec(db, "PRAGMA synchronous=FULL")
            try exec(db, "CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL,key TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(scope,key))")
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
            var resource = url
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try resource.setResourceValues(values)
            return db
        } catch { sqlite3_close(db); throw error }
    }
    private func exec(_ db: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw OfflineStoreError.storage }
    }
    private func statement(_ db: OpaquePointer, _ sql: String, _ strings: [String]) throws -> OpaquePointer {
        var s: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &s, nil) == SQLITE_OK, let s = s else { throw OfflineStoreError.storage }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (i, value) in strings.enumerated() {
            guard sqlite3_bind_text(s, Int32(i + 1), value, -1, transient) == SQLITE_OK else { sqlite3_finalize(s); throw OfflineStoreError.storage }
        }
        return s
    }
    private func decrypt(_ data: Data, scope: String, name: String) throws -> String {
        let box = try AES.GCM.SealedBox(combined: data)
        let plain = try AES.GCM.open(box, using: key(), authenticating: Data((scope + "\0" + name).utf8))
        guard let value = String(data: plain, encoding: .utf8) else { throw OfflineStoreError.invalid }
        return value
    }
    func read(_ scope: String, _ name: String) throws -> String? {
        let db = try open(); defer { sqlite3_close(db) }
        let s = try statement(db, "SELECT data FROM records WHERE scope=? AND key=?", [scope, name]); defer { sqlite3_finalize(s) }
        let status = sqlite3_step(s)
        if status == SQLITE_DONE { return nil }
        guard status == SQLITE_ROW, let bytes = sqlite3_column_blob(s, 0) else { throw OfflineStoreError.storage }
        return try decrypt(Data(bytes: bytes, count: Int(sqlite3_column_bytes(s, 0))), scope: scope, name: name)
    }
    func list(_ scope: String, _ prefix: String) throws -> [String: String] {
        let db = try open(); defer { sqlite3_close(db) }
        let s = try statement(db, "SELECT key,data FROM records WHERE scope=?", [scope]); defer { sqlite3_finalize(s) }
        var values: [String: String] = [:]
        var status = sqlite3_step(s)
        while status == SQLITE_ROW {
            guard let namePtr = sqlite3_column_text(s, 0), let bytes = sqlite3_column_blob(s, 1) else { throw OfflineStoreError.storage }
            let name = String(cString: namePtr)
            if name.hasPrefix(prefix) { values[name] = try decrypt(Data(bytes: bytes, count: Int(sqlite3_column_bytes(s, 1))), scope: scope, name: name) }
            status = sqlite3_step(s)
        }
        guard status == SQLITE_DONE else { throw OfflineStoreError.storage }
        return values
    }
    func commit(_ scope: String, _ changes: [[String: Any]]) throws {
        let db = try open(); defer { sqlite3_close(db) }
        try exec(db, "BEGIN IMMEDIATE")
        do {
            for change in changes {
                guard let name = change["key"] as? String else { throw OfflineStoreError.invalid }
                if let value = change["value"] as? String {
                    guard let data = try AES.GCM.seal(Data(value.utf8), using: key(), authenticating: Data((scope + "\0" + name).utf8)).combined else { throw OfflineStoreError.key }
                    let s = try statement(db, "INSERT OR REPLACE INTO records(scope,key,data) VALUES(?,?,?)", [scope, name]); defer { sqlite3_finalize(s) }
                    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
                    let bound = data.withUnsafeBytes { sqlite3_bind_blob(s, 3, $0.baseAddress, Int32(data.count), transient) }
                    guard bound == SQLITE_OK, sqlite3_step(s) == SQLITE_DONE else { throw OfflineStoreError.storage }
                } else {
                    let s = try statement(db, "DELETE FROM records WHERE scope=? AND key=?", [scope, name]); defer { sqlite3_finalize(s) }
                    guard sqlite3_step(s) == SQLITE_DONE else { throw OfflineStoreError.storage }
                }
            }
            try exec(db, "COMMIT")
        } catch { try? exec(db, "ROLLBACK"); throw error }
    }
    func bytes(_ scope: String) throws -> Int64 {
        let db = try open(); defer { sqlite3_close(db) }
        let s = try statement(db, "SELECT COALESCE(SUM(length(data)),0) FROM records WHERE scope=?", [scope]); defer { sqlite3_finalize(s) }
        guard sqlite3_step(s) == SQLITE_ROW else { throw OfflineStoreError.storage }
        return sqlite3_column_int64(s, 0)
    }
    func clear() throws {
        for suffix in ["", "-wal", "-shm", "-journal"] { let path = URL(fileURLWithPath: url.path + suffix); if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) } }
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw OfflineStoreError.key }
    }
}

@objc(OfflineMailStorePlugin)
public class OfflineMailStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OfflineMailStorePlugin"
    public let jsName = "OfflineMailStore"
    public let pluginMethods: [CAPPluginMethod] = ["read", "list", "commit", "clear", "bytes", "configure", "sync"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private func run(_ call: CAPPluginCall, _ task: @escaping () throws -> [String: Any]) {
        OfflineDatabase.queue.async { do { call.resolve(try task()) } catch { call.reject("Không thể lưu hoặc đọc dữ liệu trên máy.", "offline_storage_error", error) } }
    }
    @objc func read(_ call: CAPPluginCall) { run(call) { ["value": try OfflineDatabase.shared.read(call.getString("scope") ?? "", call.getString("key") ?? "") as Any? ?? NSNull()] } }
    @objc func list(_ call: CAPPluginCall) { run(call) { ["values": try OfflineDatabase.shared.list(call.getString("scope") ?? "", call.getString("prefix") ?? "")] } }
    @objc func commit(_ call: CAPPluginCall) { run(call) { guard let changes = call.getArray("changes") as? [[String: Any]] else { throw OfflineStoreError.invalid }; try OfflineDatabase.shared.commit(call.getString("scope") ?? "", changes); return [:] } }
    @objc func clear(_ call: CAPPluginCall) { OfflineSync.cancel(); run(call) { try OfflineDatabase.shared.clear(); return [:] } }
    @objc func bytes(_ call: CAPPluginCall) { run(call) { ["bytes": try OfflineDatabase.shared.bytes(call.getString("scope") ?? "")] } }
    @objc func configure(_ call: CAPPluginCall) {
        let active = call.getBool("active") ?? true
        let version = OfflineSync.beginConfiguration(active)
        DispatchQueue.main.async {
            guard let store = self.bridge?.webView?.configuration.websiteDataStore.httpCookieStore else { call.reject("Không thể lưu phiên đăng nhập.", "offline_storage_error"); return }
            store.getAllCookies { cookies in
                self.run(call) { try OfflineSync.configure(call.getString("scope") ?? "", call.getString("accountId") ?? "", active, call.getString("binding"), cookies, version); return [:] }
            }
        }
    }
    @objc func sync(_ call: CAPPluginCall) { OfflineSync.schedule(); call.resolve() }
}

class OfflineBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() { bridge?.registerPluginInstance(OfflineMailStorePlugin()) }
}

#if DEBUG
/// CI-only launch argument; refuses to touch a device with a saved account.
func runOfflineStoreSmoke() {
    OfflineDatabase.queue.async {
        let db = OfflineDatabase.shared
        var result: [String: Any] = ["passed": false]
        do {
            guard try db.read("profile", "active") == nil else { throw OfflineStoreError.invalid }
            try db.clear()
            let large = String(repeating: "Thư riêng 🔐\n", count: 400000)
            try db.commit("test", [["key": "full:mail", "value": large], ["key": "mail:mail", "value": "secret-subject"]])
            guard try db.read("test", "full:mail") == large, try db.list("test", "mail:")["mail:mail"] == "secret-subject" else { throw OfflineStoreError.invalid }
            let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("offline-mail-v1.db")
            guard try Data(contentsOf: url).range(of: Data("secret-subject".utf8)) == nil else { throw OfflineStoreError.invalid }
            do { try db.commit("test", [["key": "mail:mail", "value": "changed"], ["value": "invalid"]]); throw OfflineStoreError.invalid }
            catch OfflineStoreError.invalid { }
            guard try db.read("test", "mail:mail") == "secret-subject" else { throw OfflineStoreError.invalid }
            try db.clear()
            guard try db.read("test", "mail:mail") == nil else { throw OfflineStoreError.invalid }
            try db.clear()
            result = ["passed": true, "encrypted": true, "largeUnicodeRecord": true, "atomicRollback": true, "logoutErases": true]
        } catch { result["error"] = "Native encrypted store check failed" }
        let report = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("offline-store-smoke.json")
        if let data = try? JSONSerialization.data(withJSONObject: result) { try? data.write(to: report, options: .atomic) }
    }
}
#endif
