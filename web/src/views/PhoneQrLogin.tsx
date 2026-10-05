import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/jmap/client";
import { useSession } from "@/store/session";
import { Dialog } from "@/ui/dialog";
import { t } from "@/lib/i18n";
import { QrLoginScanner, parseLoginQr } from "@/lib/mobile/qrLogin";
const post = <T,>(action: string, id?: string) => apiFetch<T>("/api/auth/qr/" + action, { method: "POST", body: JSON.stringify({ id }) });
const message = (error: unknown) => error instanceof ApiError && error.status !== 410 && error.status !== 404 ? t("Network error. Please check your connection.") : t("QR code expired or unavailable. Create a new code.");
interface Challenge { id: string; code: string; expiresAt: number }
export function PhoneQrLogin({ onClose }: { onClose(): void }) {
  const [target, setTarget] = useState<(Challenge & { userAgent: string; ip: string }) | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const [remaining, setRemaining] = useState(0);
  useEffect(() => { if (!target) return; const update = () => setRemaining(Math.max(0, Math.ceil((target.expiresAt - Date.now()) / 1000))); update(); const timer = setInterval(update, 1000); return () => clearInterval(timer); }, [target]);
  const scan = async () => {
    setBusy(true); setError(""); setTarget(null);
    try {
      const { value } = await QrLoginScanner.scan(); const id = parseLoginQr(value);
      const data = await post<Omit<Challenge, "id"> & { userAgent: string; ip: string }>("inspect", id);
      setTarget({ ...data, id });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "cancelled") setError(err instanceof Error && err.message === "invalid_qr" ? t("This is not a sign-in QR code for this mail server.") : err instanceof ApiError ? message(err) : t("Could not scan. Check camera access and try again."));
    } finally { setBusy(false); }
  };
  const approve = async () => {
    if (!target || busy) return; setBusy(true); setError("");
    try { await post("approve", target.id); setDone(true); }
    catch (err) { setError(message(err)); } finally { setBusy(false); }
  };
  return <Dialog open onClose={onClose} title={t("Scan QR to sign in to webmail")} size="sm" closeOnBackdrop={!busy}>
    {error && <div className="error-box mb-16" role="alert">{error}</div>}
    {done ? <><p role="status">{t("Approved. Webmail will sign in automatically.")}</p><button className="btn" onClick={onClose}>{t("Close")}</button></> : target ? <>
      <p>{t("Sign in to this browser as {account}?", { account: useSession.getState().session?.username ?? "" })}</p>
      <p className="notranslate" translate="no">{target.userAgent}</p><p className="hint notranslate" translate="no">{target.ip}</p>
      <p>{t("Verification code")}: <strong className="notranslate" translate="no">{target.code}</strong></p>
      <p>{t("Only approve if this code matches the browser in front of you.")}</p>
      <button className="btn btn-primary" disabled={busy || remaining <= 0} onClick={() => void approve()}>{t("Allow sign-in")}</button>
      {remaining <= 0 && <p role="status">{t("QR code expired or unavailable. Create a new code.")}</p>}
      <button className="btn mt-16" disabled={busy} onClick={() => void scan()}>{t("Scan again")}</button>
    </> : <><p>{t("Scan the QR code shown on the webmail sign-in screen.")}</p><button className="btn btn-primary" disabled={busy} onClick={() => void scan()}>{busy ? t("Scanning…") : t("Scan QR code")}</button></>}
  </Dialog>;
}
