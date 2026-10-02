import { useEffect, useState, type FormEvent } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { useSession } from "@/store/session";
import { ApiError } from "@/jmap/client";
import { withBase } from "@/lib/basePath";
import { DEFAULT_SOURCE_URL } from "@/lib/source";
import { APP_VERSION } from "@/lib/version";
import { DEFAULT_APP_NAME } from "@/lib/brand";
import { t } from "@/lib/i18n";
import { UI_LANGUAGES } from "@/lib/languages";
import { useSettings } from "@/store/settings";
import { isNativeApp, mobileServerUrl, clearMobileServer } from "@/lib/mobile/config";
import { clearNativeSession } from "@/lib/mobile/runtime";
import { clearAllData, setDeviceTrusted } from "@/lib/storage";

export function LoginPage() {
  const uiLanguage = useSettings((s) => s.settings.uiLanguage);
  const updateSettings = useSettings((s) => s.update);
  const login = useSession((s) => s.login);
  // The AGPL's offer has to reach everyone who interacts with the app over the
  // network, and that includes whoever is looking at this form. The server says
  // where its own source lives, so a modified deployment points at its own.
  const [sourceUrl, setSourceUrl] = useState(DEFAULT_SOURCE_URL);
  // The server supplies this deployment's display name; keep a local fallback
  // so the sign-in screen also works when its configuration request fails.
  const [appName, setAppName] = useState(DEFAULT_APP_NAME);
  useEffect(() => {
    let live = true;
    fetch(withBase("/api/config"))
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (!live || !c) return;
        if (c.sourceUrl) setSourceUrl(c.sourceUrl as string);
        if (typeof c.appName === "string" && c.appName.trim()) setAppName(c.appName.trim());
      })
      .catch(() => { /* the default stands */ });
    return () => { live = false; };
  }, []);
  const [username, setUsername] = useState(() => localStorage.getItem("ihasmail:lastUser") ?? "");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [trustDevice, setTrustDevice] = useState(false);
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
      await login(username.trim(), password, "", trustDevice);
      if (trustDevice) localStorage.setItem("ihasmail:lastUser", username.trim());
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
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">
          <img src={withBase("/img/webmail.svg")} alt="" width={80} height={80} />
          {/* A product name, not a word: not translated, and not guessed at
              from the page it is on. */}
          <h1 className="notranslate" translate="no">{appName}</h1>
          <p className="tagline">{t("Fast, friendly webmail. Your mailbox, your way.")}</p>
        </div>
        <div className="field">
          <label htmlFor="login-language">{t("Interface language")}</label>
          <select id="login-language" className="input" value={uiLanguage} onChange={(e) => updateSettings({ uiLanguage: e.target.value })}>
            {UI_LANGUAGES.map((language) => <option key={language.tag} value={language.tag} lang={language.tag}>{language.name}{language.beta ? " (Beta)" : ""}</option>)}
          </select>
        </div>
        {error && (
          <div className="error-box mb-16" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="u">{t("Email or username")}</label>
          <input id="u" className="input" type="text" autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!username} required />
        </div>
        <div className="field">
          <label htmlFor="p">{t("Password")}</label>
          <div className="pw-wrap">
            <input id="p" className="input" type={showPw ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={Boolean(username)} required style={{ paddingRight: 40 }} />
            <button type="button" className="icon-btn" onClick={() => setShowPw((v) => !v)} aria-label={showPw ? t("Hide password") : t("Show password")} tabIndex={-1}>
              {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>
        <label className="check" style={{ marginBottom: 4 }}>
          <input type="checkbox" checked={trustDevice} onChange={(e) => setTrustDevice(e.target.checked)} />
          <span>{t("This is my own device")}</span>
        </label>
        <p className="hint" style={{ marginBottom: 12 }}>
          {isNativeApp()
            ? trustDevice
              ? t("Stay signed in, and keep settings and recent addresses on this device.")
              : t("Sign out after 5 minutes of inactivity and clear local account data. Leave this unticked on a shared device.")
            : trustDevice
              ? t("Stay signed in, and keep settings and recent addresses on this computer.")
              : t("Signed out after 5 minutes of inactivity, and nothing is kept on this computer. Leave this unticked on a shared or public one.")}
        </p>
        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
          {busy ? <span className="spinner" style={{ borderTopColor: "#fff" }} /> : <LogIn size={18} />}
          {busy ? t("Signing in…") : t("Sign in")}
        </button>
        <p className="foot">
          {/*
            The version sits directly above the source link on purpose: the
            AGPL's offer is for the source of *this* build, and naming the
            build is what makes that offer something a person can act on. It
            also means a bug report can name the build without anyone having
            to sign in to find it.

            One <p> with a break rather than two: .foot carries a 20px
            margin-top, which a second paragraph would repeat as a gap.
          */}
          <span className="notranslate" translate="no">{appName} v{APP_VERSION}</span>
          <br />
          <a href="https://github.com/lehuunghi/app/blob/main/docs/APP-DI-DONG.md" target="_blank" rel="noopener noreferrer">{t("Documentation")}</a>
          {" · "}
          <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{t("AGPL-3.0 source")}</a>
        </p>
        {isNativeApp() && <div className="hint mt-16">
          <p className="truncate">{mobileServerUrl()}</p>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={async () => {
            setBusy(true);
            try { await clearNativeSession(); } catch { /* the sign-out barrier still requires a new login */ }
            setDeviceTrusted(false);
            clearAllData(); clearMobileServer(); window.location.reload();
          }}>{t("Change Webmail server")}</button>
        </div>}
      </form>
    </div>
  );
}
