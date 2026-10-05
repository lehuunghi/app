import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/jmap/client";
import { useSession } from "@/store/session";
import { withBase } from "@/lib/basePath";
import { QrCode } from "@/ui/qrcode";
import { t } from "@/lib/i18n";

const post = <T,>(action: string, id?: string, signal?: AbortSignal) => apiFetch<T>("/api/auth/qr/" + action, { method: "POST", body: JSON.stringify({ id }), signal });
const message = (error: unknown) => error instanceof ApiError && error.status !== 410 && error.status !== 404
  ? t("Network error. Please check your connection.") : t("QR code expired or unavailable. Create a new code.");
interface Challenge { id: string; code: string; expiresAt: number }

export function BrowserQrLogin({ remember = true }: { remember?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(120);
  useEffect(() => {
    let live = true; let id: string | undefined; let timeout: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setError(""); setChallenge(null);
    const poll = async () => {
      try {
        const result = await post<{ status: string }>("poll", id, controller.signal);
        if (!live) return;
        if (result.status === "approved") { await useSession.getState().bootstrap(); return; }
        timeout = setTimeout(() => void poll(), 2000);
      } catch (err) { if (live) setError(message(err)); }
    };
    void apiFetch<Challenge>("/api/auth/qr/create", { method: "POST", body: JSON.stringify({ remember }), signal: controller.signal }).then((c) => {
      id = c.id;
      if (!live) { void post("cancel", id).catch(() => undefined); return; }
      setChallenge(c); void poll();
    }).catch((err) => { if (live) setError(message(err)); });
    return () => { live = false; controller.abort(); clearTimeout(timeout); if (id) void post("cancel", id).catch(() => undefined); };
  }, [attempt, remember]);
  useEffect(() => {
    if (!challenge) return;
    const update = () => setSeconds(Math.max(0, Math.ceil((challenge.expiresAt - Date.now()) / 1000)));
    update(); const timer = setInterval(update, 1000); return () => clearInterval(timer);
  }, [challenge]);
  const api = new URL(withBase("/api/auth/qr"), window.location.href).href;
  return <div className="qr-login-panel">
    <p>{t("Open the signed-in phone app and choose Scan QR to sign in to webmail.")}</p>
    {error ? <div className="error-box" role="alert">{error}</div> : challenge && seconds > 0 ? <>
      <QrCode value={JSON.stringify({ type: "webmail-login", version: 1, api, id: challenge.id })} size={240} />
      <p>{t("Verification code")}: <strong className="notranslate" translate="no">{challenge.code}</strong></p>
      <p className="hint">{t("Expires in {seconds} seconds", { seconds })}</p>
      <p className="hint">{t("Confirm this code on your phone. Do not share this QR code.")}</p>
    </> : challenge ? <p role="status">{t("QR code expired or unavailable. Create a new code.")}</p> : <span className="spinner" />}
    <button type="button" className="btn" onClick={() => setAttempt((v) => v + 1)}>{t("Create new QR code")}</button>
  </div>;
}

