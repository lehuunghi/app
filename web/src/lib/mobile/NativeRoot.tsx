import { useEffect, useState, type ReactNode } from "react";
import { initializeNative } from "./runtime";
import { whenLanguageReady, t } from "@/lib/i18n";
import { withBase } from "@/lib/basePath";
import { Spinner } from "@/ui/misc";

export function NativeRoot({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        await whenLanguageReady();
        await initializeNative();
        if (live) setPhase("ready");
      } catch {
        if (live) setPhase("failed");
      }
    })();
    return () => { live = false; };
  }, [attempt]);
  if (phase === "ready") return children;
  if (phase === "loading") return <div className="center" style={{ height: "100%" }}><Spinner size="lg" /></div>;
  return <div className="login-page"><div className="login-card">
    <div className="logo"><img src={withBase("/img/webmail.svg")} alt="" width={80} height={80} /><h1>Webmail</h1></div>
    <p className="error-box" role="alert">{t("Webmail could not start.")}</p>
    <p>{t("Close and reopen the app, or try again.")}</p>
    <button type="button" className="btn btn-primary btn-block" onClick={() => {
      setPhase("loading"); setAttempt((value) => value + 1);
    }}>{t("Try again")}</button>
  </div></div>;
}
