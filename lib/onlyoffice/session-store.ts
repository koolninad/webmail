// host-patch target path:  lib/onlyoffice/session-store.ts
//
// The `ck` (callback-key) session store: maps a server-issued opaque key to the
// {username, path, serverUrl, authHeader, documentKey} needed to (a) stream the
// file to the Document Server on download and (b) write the edited file back to
// Stalwart on callback — WITHOUT trusting any client- or Doc-Server-supplied
// path.
//
// WHY this exists: the OnlyOffice Document Server has no Nubo session cookie, so
// when it GETs document.url (download) or POSTs to callbackUrl (save) it carries
// only Nubo-issued tokens. The real Stalwart credential (creds.authHeader) is
// per-user and resolved at /config time from the user's session cookie
// (lib/stalwart/credentials.ts:31-47). We stash it here keyed by `ck` so the
// download/callback routes can replay it to Stalwart.
//
// SECURITY TRADE-OFF (flagged): this holds the user's Stalwart auth header in
// server memory for the editing-session TTL. Acceptable for a single-replica
// deploy (k8s/30-deployment.yaml is single-replica per README). For HA/multi-
// replica, back this with Redis and consider a scoped Stalwart service account
// instead of storing per-user authHeader (see PLAN.md §Unknowns).
//
// This is an in-process Map with TTL. It is intentionally dependency-free.

export interface CkSession {
  username: string;
  /** DAV-relative path under /dav/file/<username>/, e.g. "Documents/report.docx" */
  path: string;
  /** Stalwart base URL (no trailing slash), from creds.serverUrl */
  serverUrl: string;
  /** Stalwart auth header (Basic/Bearer) replayed to DAV for GET/PUT */
  authHeader: string;
  /** Lowercase file extension, e.g. "docx" */
  fileType: string;
  /** The OnlyOffice document.key at issue time (for callback sanity-check) */
  documentKey: string;
  expiresAt: number;
}

const TTL_MS = 1000 * 60 * 60 * 8; // 8h editing session; refreshed on access.
const store = new Map<string, CkSession>();

function sweep() {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}

export function putCkSession(ck: string, session: Omit<CkSession, 'expiresAt'>): void {
  store.set(ck, { ...session, expiresAt: Date.now() + TTL_MS });
  if (store.size % 64 === 0) sweep();
}

export function getCkSession(ck: string): CkSession | null {
  const s = store.get(ck);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    store.delete(ck);
    return null;
  }
  // Sliding TTL: keep alive while the document is being edited.
  s.expiresAt = Date.now() + TTL_MS;
  return s;
}
