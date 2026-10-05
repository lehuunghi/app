import { config } from "./config.js";
import { absoluteUpstream, getUpstreamSession, upstreamFor } from "./upstream.js";
import type { LiveSession } from "./sessions.js";

const MAIL = "urn:ietf:params:jmap:mail";
export interface MailChange { state: string; emailId?: string; more?: boolean }
export type MailWatch = (session: LiveSession, state?: string) => Promise<MailChange>;

/** Email/changes only reports mail created after a baseline, never all old
 * messages, and read/flag/folder updates cannot cause new-mail alerts. */
export const watchNativeMail: MailWatch = async (session, state) => {
  const upstream = await getUpstreamSession(session.id, session.authorization, upstreamFor(session.username));
  const accountId = upstream.primaryAccounts[MAIL];
  if (!accountId) throw new Error("Mail account unavailable");
  const call = async (methodCalls: unknown[]) => {
    const res = await fetch(absoluteUpstream(upstream.apiUrl, upstream.baseUrl), {
      method: "POST", headers: { authorization: session.authorization, "content-type": "application/json" },
      body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", MAIL], methodCalls }),
      signal: AbortSignal.timeout(config.upstreamTimeout),
    });
    if (!res.ok) throw new Error("Mail check unavailable");
    const data = await res.json() as { methodResponses: Array<[string, Record<string, any>, string]> };
    return data.methodResponses;
  };
  if (!state) {
    const response = await call([["Email/get", { accountId, ids: [], properties: ["id"] }, "baseline"]]);
    const value = response.find(([name]) => name === "Email/get")?.[1].state;
    if (typeof value !== "string") throw new Error("Mail baseline unavailable");
    return { state: value };
  }
  const response = await call([
    ["Mailbox/get", { accountId, properties: ["id", "role"] }, "folders"],
    ["Email/changes", { accountId, sinceState: state, maxChanges: 100 }, "changes"],
    ["Email/get", { accountId, "#ids": { resultOf: "changes", name: "Email/changes", path: "/created" }, properties: ["id", "mailboxIds", "keywords"] }, "messages"],
  ]);
  const error = response.find(([name, , id]) => name === "error" && id === "changes")?.[1];
  if (error?.type === "cannotCalculateChanges") return watchNativeMail(session);
  const changes = response.find(([name]) => name === "Email/changes")?.[1];
  const folders = response.find(([name]) => name === "Mailbox/get")?.[1].list;
  const emails = response.find(([name]) => name === "Email/get")?.[1].list;
  if (typeof changes?.newState !== "string" || !Array.isArray(folders) || !Array.isArray(emails)) throw new Error("Mail changes unavailable");
  const inbox = folders.find((folder) => folder.role === "inbox")?.id;
  const fresh = emails.find((email) => inbox && email.mailboxIds?.[inbox] && !email.keywords?.$seen && !email.keywords?.$draft);
  return { state: changes.newState, emailId: typeof fresh?.id === "string" ? fresh.id : undefined, more: !!changes.hasMoreChanges };
};
