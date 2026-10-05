import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";

export type Platform = "android" | "ios";
export type PushResult = "sent" | "invalid" | "retry";
export interface NativeMessage { binding: string; emailId: string; offlineSync?: boolean }
export interface NativeProvider {
  ready(platform: Platform): boolean;
  send(platform: Platform, token: string, message: NativeMessage): Promise<PushResult>;
}

const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
export function signedToken(header: Record<string, unknown>, claims: Record<string, unknown>, key: string): string {
  const input = `${encode(header)}.${encode(claims)}`;
  const signature = header.alg === "ES256"
    ? sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" })
    : sign("RSA-SHA256", Buffer.from(input), key);
  return `${input}.${signature.toString("base64url")}`;
}

// Alert payloads are deliberately generic. Mail content and credentials never
// leave the mail server for Firebase/APNs or appear on a locked device.
export function androidPayload(token: string, message: NativeMessage) {
  const data = { binding: message.binding, emailId: message.emailId };
  if (message.offlineSync) return { message: { token, data, android: { priority: "HIGH", ttl: "300s" } } };
  return { message: { token, notification: { title: "Webmail", body: "Bạn có email mới." },
    data, android: { priority: "HIGH", ttl: "300s", notification: {
      channel_id: "webmail-new-mail", icon: "ic_notification", tag: "webmail-new-mail", sound: "default",
    } } } };
}
export function iosPayload(message: NativeMessage) {
  return { aps: { alert: { title: "Webmail", body: "Bạn có email mới." }, sound: "default", "thread-id": "webmail-new-mail", ...(message.offlineSync ? { "content-available": 1 } : {}) }, binding: message.binding, emailId: message.emailId };
}

/** Optional providers: missing configuration disables only that platform. */
export class PushProviders implements NativeProvider {
  private fcm?: { project_id: string; client_email: string; private_key: string };
  private apns?: { key: string; keyId: string; teamId: string; topic: string; sandbox: boolean };
  private access?: { value: string; expires: number };
  private accessRequest?: Promise<string>;
  private appleJwt?: { value: string; expires: number };

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (env.FCM_SERVICE_ACCOUNT_FILE) {
      const value = JSON.parse(readFileSync(env.FCM_SERVICE_ACCOUNT_FILE, "utf8"));
      if (![value.project_id, value.client_email, value.private_key].every((v) => typeof v === "string" && v)) throw new Error("Invalid FCM service account");
      if (createPrivateKey(value.private_key).asymmetricKeyType !== "rsa") throw new Error("FCM requires an RSA key");
      this.fcm = value;
    }
    const apple = [env.APNS_KEY_FILE, env.APNS_KEY_ID, env.APNS_TEAM_ID, env.APNS_TOPIC];
    if (apple.some(Boolean)) {
      if (!apple.every(Boolean)) throw new Error("APNs needs KEY_FILE, KEY_ID, TEAM_ID and TOPIC");
      const key = readFileSync(env.APNS_KEY_FILE!, "utf8");
      const parsed = createPrivateKey(key);
      if (parsed.asymmetricKeyType !== "ec" || parsed.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("APNs requires a P-256 key");
      this.apns = { key, keyId: env.APNS_KEY_ID!, teamId: env.APNS_TEAM_ID!, topic: env.APNS_TOPIC!, sandbox: env.APNS_SANDBOX === "1" };
    }
  }

  ready(platform: Platform): boolean { return platform === "android" ? !!this.fcm : !!this.apns; }

  private async googleAccess(): Promise<string> {
    if (this.access && this.access.expires > Date.now()) return this.access.value;
    this.accessRequest ??= (async () => {
      const s = this.fcm!;
      const now = Math.floor(Date.now() / 1000);
      const assertion = signedToken({ alg: "RS256", typ: "JWT" }, {
        iss: s.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
      }, s.private_key);
      const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        signal: AbortSignal.timeout(10_000) });
      const body = await res.json() as { access_token?: string; expires_in?: number };
      if (!res.ok || !body.access_token) throw new Error("FCM authorization failed");
      this.access = { value: body.access_token, expires: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000 };
      return body.access_token;
    })().finally(() => { this.accessRequest = undefined; });
    return this.accessRequest;
  }

  async send(platform: Platform, token: string, message: NativeMessage): Promise<PushResult> {
    if (!this.ready(platform)) return "retry";
    try {
      if (platform === "ios") return await this.sendApple(token, message);
      const auth = await this.googleAccess();
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.fcm!.project_id)}/messages:send`, {
        method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
        body: JSON.stringify(androidPayload(token, message)), signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return "sent";
      if (res.status === 401) this.access = undefined;
      const error = await res.json() as { error?: { details?: Array<{ errorCode?: string }> } };
      // INVALID_ARGUMENT can be a malformed payload; do not discard a valid
      // token for configuration failures. Only explicit UNREGISTERED is final.
      return error.error?.details?.some((e) => e.errorCode === "UNREGISTERED") ? "invalid" : "retry";
    } catch { return "retry"; }
  }

  private sendApple(token: string, message: NativeMessage): Promise<PushResult> {
    const a = this.apns!;
    if (!this.appleJwt || this.appleJwt.expires <= Date.now()) {
      this.appleJwt = { value: signedToken({ alg: "ES256", kid: a.keyId }, {
        iss: a.teamId, iat: Math.floor(Date.now() / 1000),
      }, a.key), expires: Date.now() + 50 * 60_000 };
    }
    return new Promise((resolve) => {
      const connection = connect(a.sandbox ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
      let done = false;
      const finish = (result: PushResult) => {
        if (done) return;
        done = true; clearTimeout(timer); connection.destroy(); resolve(result);
      };
      const timer = setTimeout(() => finish("retry"), 10_000);
      connection.on("error", () => finish("retry"));
      connection.on("connect", () => {
        const request = connection.request({ ":method": "POST", ":path": `/3/device/${token}`,
          authorization: `bearer ${this.appleJwt!.value}`, "apns-topic": a.topic,
          "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": `${Math.floor(Date.now() / 1000) + 300}`,
          "apns-collapse-id": "webmail-new-mail" });
        let status = 0, body = "";
        request.on("response", (headers) => { status = Number(headers[":status"]); });
        request.setEncoding("utf8");
        request.on("data", (chunk) => { if (body.length < 4096) body += chunk; });
        request.on("error", () => finish("retry"));
        request.on("end", () => {
          let reason = ""; try { reason = JSON.parse(body).reason; } catch { /* no body on success */ }
          if (reason === "ExpiredProviderToken") this.appleJwt = undefined;
          finish(status === 200 ? "sent" : status === 410 || reason === "BadDeviceToken" ? "invalid" : "retry");
        });
        request.end(JSON.stringify(iosPayload(message)));
      });
    });
  }
}
