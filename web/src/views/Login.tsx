import { BrowserQrLogin } from "./QrLogin";
import { isNativeApp } from "@/lib/mobile/config";
import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useSession } from "@/store/session";
import { ApiError } from "@/jmap/client";
import { withBase } from "@/lib/basePath";
import { DEFAULT_APP_NAME } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { UI_LANGUAGES } from "@/lib/languages";
import { useSettings } from "@/store/settings";
import { BrandLogo } from "@/ui/BrandLogo";

export function LoginPage() {
  const uiLanguage = useSettings((s) => s.settings.uiLanguage);
  const updateSettings = useSettings((s) => s.update);
  const login = useSession((s) => s.login);
  const [appName, setAppName] = useState(DEFAULT_APP_NAME);
  const [logoUrl, setLogoUrl] = useState("");
  useEffect(() => {
    let live = true;
    fetch(withBase("/api/config"))
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (!live || !c) return;
        if (typeof c.logoUrl === "string") setLogoUrl(c.logoUrl);
        if (typeof c.appName === "string" && c.appName.trim()) setAppName(c.appName.trim());
      })
      .catch(() => { /* the default stands */ });
    return () => { live = false; };
  }, []);
  const [qrMode, setQrMode] = useState(false);
  const [username, setUsername] = useState(() => localStorage.getItem("ihasmail:lastUser") ?? "");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    setError(null);
    try {
      // No two-factor code: the field is not on this form until the flow works
      // end to end, and the server treats an absent code as none given.
      await login(username.trim(), password, "", true);
      localStorage.setItem("ihasmail:lastUser", username.trim());
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "invalid_credentials") {
          setError(t("Invalid username or password."));
        } else if (err.code === "rate_limited") setError(t("Too many attempts. Please wait a few minutes and try again."));
        else setError(err.message || t("Could not sign in."));
      } else setError(t("Network error. Please check your connection."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page gmail-login">
      <div className="login-container">
        <form className="login-card" onSubmit={submit}>
          <div className="login-intro">
            <div className="login-brand"><BrandLogo url={logoUrl} size={32} /><span className="notranslate" translate="no">{appName}</span></div>
            <h1>{t("Sign in")}</h1>
            <p>{t("Use your account to access your workspace.")}</p>
          </div>
          <div className="login-fields">
            {!isNativeApp() && <div className="login-mode-tabs"><button className="btn" type="button" aria-pressed={!qrMode} onClick={() => setQrMode(false)}>{t("Sign in with email")}</button><button className="btn" type="button" aria-pressed={qrMode} onClick={() => setQrMode(true)}>{t("Sign in with QR")}</button></div>}
            {qrMode ? <BrowserQrLogin /> : <>
            {error && <div className="error-box mb-16" role="alert">{error}</div>}
            <div className="field">
              <label htmlFor="u">{t("Email or username")}</label>
              <input id="u" className="input" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!username} required />
            </div>
            <div className="field">
              <label htmlFor="p">{t("Password")}</label>
              <div className="pw-wrap">
                <input id="p" className="input" type={showPw ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={Boolean(username)} required />
                <button type="button" className="icon-btn" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? t("Hide password") : t("Show password")}>
                  {showPw ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
            </div>
            <div className="login-actions">
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy && <span className="spinner" />}{busy ? t("Signing in…") : t("Sign in")}
              </button>
            </div>
            </>}
          </div>
        </form>
        <footer className="login-footer">
          <select id="login-language" aria-label={t("Interface language")} value={uiLanguage} onChange={(e) => updateSettings({ uiLanguage: e.target.value })}>
            {UI_LANGUAGES.map((language) => <option key={language.tag} value={language.tag} lang={language.tag}>{language.name}</option>)}
          </select>
        </footer>
      </div>
    </div>
  );
}
