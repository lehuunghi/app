import type { Email, Id, Invocation, JmapResponse, JmapSession, Mailbox, Identity } from "@/jmap/types";

export interface StoredEmail { email: Email; full: boolean; complete: boolean; pinned?: boolean }
export interface OfflineOperation {
  id: string;
  accountId: Id;
  createdAt: number;
  readyAt: number;
  status: "pending" | "uncertain" | "failed";
  error?: string;
  request: { using: string[]; methodCalls: Invocation[]; createdIds?: Record<string, Id> };
  /** call id -> creation key -> temporary local id, never Message-ID deduplication. */
  creations: Record<string, Record<string, Id>>;
  base: Record<Id, { mailboxIds: Record<Id, boolean>; keywords: Record<string, boolean> }>;
  before?: Record<Id, StoredEmail | null>;
  send: boolean;
  sendAccepted?: boolean;
}
export interface OfflineManifest {
  v: 1;
  session: JmapSession;
  accountId: Id;
  mailboxes: Mailbox[];
  identities: Identity[];
  emailState: string | null;
  mailboxState: string | null;
  lastSync: number | null;
  operations: OfflineOperation[];
  mappings: Record<Id, Id>;
  historyDays: number;
  maxMessages: number;
  maxBytes: number;
  backgroundPull?: { state: string; position: number } | null;
}
export interface StoreChange { key: string; value?: string | null }
export interface OfflineStorage {
  read(scope: string, key: string): Promise<string | null>;
  list(scope: string, prefix: string): Promise<Record<string, string>>;
  /** All changes commit together or reject. Failure must never be treated as success. */
  commit(scope: string, changes: StoreChange[]): Promise<void>;
  clear(): Promise<void>;
  bytes(scope: string): Promise<number>;
}
export interface OfflineTransport {
  request(body: OfflineOperation["request"]): Promise<JmapResponse>;
  operation(op: OfflineOperation, request: OfflineOperation["request"]): Promise<JmapResponse>;
  blob(accountId: Id, blobId: Id, type: string): Promise<Blob>;
  upload(accountId: Id, blob: Blob): Promise<{ blobId: Id; accountId: Id; type: string; size: number }>;
}
export interface OfflineStatus {
  enabled: boolean;
  online: boolean;
  syncing: boolean;
  lastSync: number | null;
  pending: number;
  issues: number;
  complete: number;
  cached: number;
  error: string | null;
}
