// host-patch target path:  lib/onlyoffice/config-builder.ts
//
// Pure helpers shared by the three /api/onlyoffice route handlers:
//   - documentType mapping (mirrors the plugin's src/index.js documentTypeFor)
//   - document.key derivation (the co-editing strategy, §4 of NOTES.md)
//   - dt download-token sign/verify (separate secret from the OnlyOffice JWT)
//   - DAV path / URL building (mirrors app/api/webdav/route.ts:27-31)
//
// All of this runs server-side only.

import { createHash } from 'node:crypto';
import { signHs256, verifyHs256 } from './jwt';

// ── Extension → OnlyOffice documentType ──────────────────────────────────────
// Sets per OnlyOffice supported-formats matrix
// (https://api.onlyoffice.com/docs/docs-api/usage-api/config/#documentType).
const WORD = new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'odt', 'fodt', 'ott', 'rtf', 'txt', 'html', 'htm', 'mht', 'xml', 'epub', 'fb2']);
const CELL = new Set(['xls', 'xlsx', 'xlsm', 'xlt', 'xltx', 'xltm', 'ods', 'fods', 'ots', 'csv']);
const SLIDE = new Set(['ppt', 'pptx', 'pptm', 'pot', 'potx', 'potm', 'pps', 'ppsx', 'ppsm', 'odp', 'fodp', 'otp']);
const PDF = new Set(['pdf', 'djvu', 'xps', 'oxps']);

export type OoDocumentType = 'word' | 'cell' | 'slide' | 'pdf';

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function documentTypeFor(name: string): OoDocumentType | null {
  const e = extOf(name);
  if (WORD.has(e)) return 'word';
  if (CELL.has(e)) return 'cell';
  if (SLIDE.has(e)) return 'slide';
  if (PDF.has(e)) return 'pdf';
  return null;
}

// ── document.key derivation (NOTES.md §4) ────────────────────────────────────
// Constraints (OnlyOffice): charset [0-9a-zA-Z-._=], max 128 chars. Must be
// identical for the same file+version (so co-editors share a session) and must
// change when the file is saved (so the Doc Server invalidates its cache and
// re-pulls). We use sha1(username:path) as a stable base and append a sanitized
// version token (DAV etag, else lastmodified epoch).
export function sanitizeKeyToken(raw: string): string {
  return raw.replace(/[^0-9a-zA-Z._=-]/g, '').slice(0, 60);
}

export function buildDocumentKey(username: string, path: string, version: string): string {
  const base = createHash('sha1').update(`${username}:${path}`).digest('hex'); // 40 chars, legal
  const ver = sanitizeKeyToken(version) || '0';
  return `${base}-${ver}`.slice(0, 128);
}

// ── DAV path / URL (mirror of app/api/webdav/route.ts:27-31) ─────────────────
// Stalwart exposes the same FileNode store over WebDAV at
// <serverUrl>/dav/file/<username>/<path>. The Files UI browses via JMAP, but a
// single-file GET/PUT is exactly what OnlyOffice needs and DAV is the natural
// transport. `path` is the FileNode name-hierarchy path (no leading slash).
export function buildDavUrl(serverUrl: string, username: string, relPath: string): string {
  const base = serverUrl.replace(/\/+$/, '');
  const root = new URL(`${base}/dav/file/${encodeURIComponent(username)}/`);
  const rel = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return rel ? new URL(rel, root).toString() : root.toString();
}

// ── dt download token (NOTES.md §5) ──────────────────────────────────────────
// Short-lived token the Doc Server presents on document.url. It is NOT an
// OnlyOffice JWT — it is our own HS256 token over {ck} with a short exp, signed
// with NUBO_DOWNLOAD_TOKEN_SECRET. The download route resolves the real path /
// auth from the ck session store, so the token body need only carry `ck`.
export interface DtClaims { ck: string }

export function signDtToken(ck: string, secret: string, ttlSec = 60 * 60): string {
  return signHs256({ ck }, secret, ttlSec);
}

export function verifyDtToken(token: string, secret: string): DtClaims {
  return verifyHs256<DtClaims>(token, secret);
}
