import { useSyncExternalStore, useState } from "react";
import { Link } from "wouter";
import { CloudOff, RefreshCw } from "lucide-react";
import { offline, startOfflineSync } from "./runtime";
import { isNativeApp } from "@/lib/mobile/config";
import { t } from "@/lib/i18n";
import { formatSize } from "@/lib/format";
import { toast } from "@/ui/toast";
import { confirmDialog } from "@/ui/dialog";

export function useOfflineStatus() { return useSyncExternalStore((fn) => offline.subscribe(fn), () => offline.status); }
export function OfflineBanner() {
  const s = useOfflineStatus();
  if (!isNativeApp() || !s.enabled || s.online && !s.syncing && !s.pending && !s.issues && !s.error) return null;
  return <div role="status" className="offline-banner">
    {s.online ? <RefreshCw size={15} /> : <CloudOff size={15} />}
    <span>{!s.online ? t("Connection error. Please check your connection.") : s.syncing ? t("Syncing mail…") : t("Changes waiting to sync")}</span>
    <Link href="/settings/offline">{s.issues ? t("Review pending changes") : t("Offline mail")}</Link>
  </div>;
}
export function OfflineSettings() {
  const s = useOfflineStatus();
  const [busy, setBusy] = useState(false);
  const m = offline.manifest;
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch { toast.error(t("Could not complete this action. Please try again.")); } finally { setBusy(false); } };
  if (!m) return <div><h1>{t("Offline mail")}</h1><p>{t("Sign in online once to enable offline mail on this device.")}</p></div>;
  return <div>
    <h1>{t("Offline mail")}</h1>
    {!m.session.ihasmail?.offlineSync && <p role="status">{t("Offline changes and background sync need the updated server. Downloaded mail is still readable.")}</p>}
    <p className="lead">{t("New mail downloads automatically, including attachments. Downloaded messages can be read without a connection.")}</p>
    <p>{t("Downloaded {complete} of {total} messages", { complete: s.complete, total: s.cached })}</p>
    <p className="hint">{t("Offline search and folder counts cover downloaded messages only. Older mail remains available online.")}</p>
    <div className="field"><label>{t("Download recent mail")}</label><select className="select" value={m.historyDays} disabled={busy} onChange={(e) => void run(() => offline.configureCache(Number(e.target.value), m.maxBytes / 1024 / 1024))}>
      {[7, 30, 90, 365].map((days) => <option key={days} value={days}>{t("{days} days", { days })}</option>)}
    </select></div>
    <div className="field"><label>{t("Device storage limit")}</label><select className="select" value={m.maxBytes / 1024 / 1024} disabled={busy} onChange={(e) => void run(() => offline.configureCache(m.historyDays, Number(e.target.value)))}>
      {[100, 500, 1024].map((mb) => <option key={mb} value={mb}>{formatSize(mb * 1024 * 1024)}</option>)}
    </select></div>
    <p className="hint">{t("Downloads pause when storage is full. Drafts and pending changes are kept. Sign-out removes this device's mail and pending changes.")}</p>
    {s.error === "offline_storage_full" && <p role="alert">{t("Device storage is full. Increase the limit or clear downloaded mail.")}</p>}
    <button className="btn" disabled={busy || s.syncing} onClick={startOfflineSync}>{t("Sync now")}</button>{" "}
    <button className="btn btn-ghost" disabled={busy || s.syncing} onClick={() => void run(async () => {
      if (await confirmDialog({ title: t("Clear downloaded mail"), message: t("Remove downloaded copies from this device? Server mail, drafts and pending changes are kept."), confirmLabel: t("Clear") })) await offline.clearDownloaded();
    })}>{t("Clear downloaded mail")}</button>
    <h2>{t("Pending changes")}</h2>
    {!m.operations.length && <p>{t("Everything is synced")}</p>}
    {m.operations.map((op) => <div key={op.id} className="field">
      <strong>{op.send ? t("Mail waiting to send") : t("Mailbox changes")}</strong>
      <p>{op.sendAccepted ? t("The message was accepted for sending, but related mailbox changes need review.") : op.status === "uncertain" ? t("The server may have accepted this action. It will be checked again without sending another copy.") : op.status === "failed" ? t("This action could not be synced. Review it before continuing.") : t("Waiting for a connection")}</p>
      {op.sendAccepted && <button className="btn btn-sm" disabled={busy || s.syncing} onClick={() => void run(async () => { await offline.dismissAccepted(op.id); startOfflineSync(); })}>{t("Reviewed, sync again")}</button>}
      {op.status !== "uncertain" && !op.sendAccepted && <button className="btn btn-sm" disabled={busy || s.syncing} onClick={() => void run(async () => {
        if (await confirmDialog({ title: t("Cancel pending change"), message: t("Cancel this change on the device? A queued message will not be sent."), confirmLabel: t("Cancel change") })) { await offline.cancel(op.id); window.dispatchEvent(new CustomEvent("webmail:offline-updated")); }
      })}>{t("Cancel change")}</button>}
    </div>)}
    <p className="hint">{t("Background downloads depend on Android or iOS allowing the app to run. Opening the app resumes unfinished downloads.")}</p>
  </div>;
}
