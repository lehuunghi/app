import type { Comparator, Email, EmailFilter } from "@/jmap/types";

/** Only the supported filter subset is evaluated. Never silently ignore an unknown constraint. */
export function matchesOffline(email: Email, filter: EmailFilter | undefined): boolean {
  if (!filter) return true;
  const f = filter as Record<string, unknown>;
  if (f.operator) {
    const conditions = (f.conditions ?? []) as EmailFilter[];
    if (f.operator === "AND") return conditions.every((c) => matchesOffline(email, c));
    if (f.operator === "OR") return conditions.some((c) => matchesOffline(email, c));
    if (f.operator === "NOT") return !conditions.some((c) => matchesOffline(email, c));
    throw new Error("offline_filter_unavailable");
  }
  for (const [key, value] of Object.entries(f)) {
    if (value == null) continue;
    switch (key) {
      case "inMailbox": if (!email.mailboxIds[String(value)]) return false; break;
      case "inMailboxOtherThan": if (!Object.keys(email.mailboxIds).some((id) => !(value as string[]).includes(id))) return false; break;
      case "hasKeyword": if (!email.keywords[String(value)]) return false; break;
      case "notKeyword": if (email.keywords[String(value)]) return false; break;
      case "hasAttachment": if (Boolean(email.hasAttachment) !== value) return false; break;
      case "after": if (email.receivedAt < String(value)) return false; break;
      case "before": if (email.receivedAt >= String(value)) return false; break;
      case "minSize": if (email.size < Number(value)) return false; break;
      case "maxSize": if (email.size > Number(value)) return false; break;
      case "subject": if (!(email.subject ?? "").toLocaleLowerCase().includes(String(value).toLocaleLowerCase())) return false; break;
      case "from": case "to": case "cc": case "bcc":
        if (!(email[key] ?? []).some((a) => `${a.name} ${a.email}`.toLocaleLowerCase().includes(String(value).toLocaleLowerCase()))) return false;
        break;
      case "text": case "body": {
        const body = Object.values(email.bodyValues ?? {}).map((b) => b.value).join(" ");
        const text = key === "body" ? body : `${email.subject ?? ""} ${email.preview ?? ""} ${body} ${JSON.stringify(email.from ?? [])} ${JSON.stringify(email.to ?? [])}`;
        if (!text.toLocaleLowerCase().includes(String(value).toLocaleLowerCase())) return false;
        break;
      }
      default: throw new Error("offline_filter_unavailable");
    }
  }
  return true;
}

export function sortOffline(emails: Email[], sort: Comparator[] = [{ property: "receivedAt", isAscending: false }]): Email[] {
  return emails.sort((a, b) => {
    for (const c of sort) {
      let cmp: number;
      switch (c.property) {
        case "receivedAt": cmp = a.receivedAt.localeCompare(b.receivedAt); break;
        case "sentAt": cmp = (a.sentAt ?? "").localeCompare(b.sentAt ?? ""); break;
        case "subject": cmp = (a.subject ?? "").localeCompare(b.subject ?? ""); break;
        case "size": cmp = a.size - b.size; break;
        case "hasKeyword": cmp = Number(Boolean(a.keywords[c.keyword ?? ""])) - Number(Boolean(b.keywords[c.keyword ?? ""])); break;
        case "from": case "to": cmp = (a[c.property]?.[0]?.name ?? a[c.property]?.[0]?.email ?? "").localeCompare(b[c.property]?.[0]?.name ?? b[c.property]?.[0]?.email ?? ""); break;
        default: throw new Error("offline_sort_unavailable");
      }
      if (cmp) return c.isAscending ? cmp : -cmp;
    }
    return a.id.localeCompare(b.id);
  });
}
