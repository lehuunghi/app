import { useState, type FormEvent } from "react";
import { CapacitorHttp } from "@capacitor/core";
import { mobileServerUrl, normalizeServerUrl, saveMobileServer } from "./config";
import { t } from "@/lib/i18n";
import { withBase } from "@/lib/basePath";

export function ServerSetup({ onReady }: { onReady(): void }) {
  const [address, setAddress] = useState(mobileServerUrl() ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const server = normalizeServerUrl(address);
      // No account data is sent while checking a user-chosen server.
      const response = await CapacitorHttp.get({ url: server + "/api/config", connectTimeout: 10000, readTimeout: 10000, disableRedirects: true });
      if (response.status !== 200 || typeof response.data?.appName !== "string") throw new Error("invalid_server");
      saveMobileServer(server);
      onReady();
    } catch {
      setError(t("Cannot connect. Check the HTTPS address of your Webmail server."));
    } finally {
      setBusy(false);
    }
  };
  return <div className="login-page"><form className="login-card" onSubmit={submit}>
    <div className="logo"><img src={withBase("/img/webmail.svg")} alt="" width={80} height={80} /><h1>Webmail</h1></div>
    <p>{t("Connect to your Webmail server")}</p>
    <div className="field"><label htmlFor="mobile-server">{t("Webmail server address")}</label>
      <input id="mobile-server" className="input" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="https://webmail.example.com" value={address} onChange={(ev) => setAddress(ev.target.value)} required />
    </div>
    <p className="hint">{t("Use the same website address as on your computer. Your account is entered on the next screen.")}</p>
    {error && <p className="error-box" role="alert">{error}</p>}
    <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t("Connecting…") : t("Continue")}</button>
  </form></div>;
}
