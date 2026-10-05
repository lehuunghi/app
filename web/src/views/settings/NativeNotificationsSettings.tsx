import { useEffect, useSyncExternalStore } from "react";
import { Switch } from "@/ui/misc";
import { t } from "@/lib/i18n";
import { notificationSnapshot, subscribeNotifications, startNativeNotifications, setNativeNotificationsEnabled, showNativeNotification } from "@/lib/mobile/notifications";
import { toast } from "@/ui/toast";

export function NativeNotificationsSettings() {
  const state = useSyncExternalStore(subscribeNotifications, notificationSnapshot);
  useEffect(() => { void startNativeNotifications(false); }, []);
  return <div>
    <h1>{t("Notifications")}</h1>
    <p className="lead">{t("Receive new-mail notifications on this device.")}</p>
    <Switch checked={state.enabled && state.permission === "granted"}
      disabled={state.phase === "connecting"}
      onChange={(enabled) => { void setNativeNotificationsEnabled(enabled).catch(() => toast.error(t("Network error. Please check your connection."))); }}
      label={t("New-mail notifications")}
      hint={state.permission === "denied" ? t("Allow notifications in your phone settings, then reopen the app.")
        : state.phase === "connected" ? t("Notifications can arrive even when the app is closed.")
        : state.phase === "connecting" ? t("Connecting…")
        : t("Notifications while the app is open are available. Background delivery is not connected yet.")} />
    <p className="hint mt-16">{t("Notifications show no sender, subject or message content. Tap to open your Inbox.")}</p>
    <p className="hint">{t("Change notification sounds in your phone settings.")}</p>
    <button className="btn mt-16" disabled={!state.enabled || state.permission === "denied"}
      onClick={() => { void showNativeNotification(true).catch(() => toast.error(t("Could not show the notification."))); }}>{t("Test notification")}</button>
    <p className="hint mt-8">{t("This tests notifications on this phone. Background delivery also needs the server to be connected.")}</p>
  </div>;
}
