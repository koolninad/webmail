// host-patch target path:  app/api/onlyoffice/config/route.ts
//
// POST /api/onlyoffice/config
// Builds and HS256-JWT-signs the OnlyOffice editor config for a Files document.
// Called same-origin by the plugin via host.http.post (apiPostPaths allowlist),
// which auto-injects the user's Authorization + X-JMAP-Username AND carries the
// Nubo session cookie that getStalwartCredentials() reads.
//
// Evidence this is the right credential path:
//   - getStalwartCredentials reads the session cookie + slot:
//     lib/stalwart/credentials.ts:31-47
//   - the WebDAV proxy uses creds.authHeader / creds.serverUrl / creds.username
//     against <serverUrl>/dav/file/<username>/<path>: app/api/webdav/route.ts:27-31,62-64
//
// Request body (built by the plugin's buildEditorConfigRequest):
//   { path, name, fileType, documentType, version?, mode? }
//
// Response: { config: <signed OnlyOffice config> }

import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { signHs256 } from '@/lib/onlyoffice/jwt';
import {
  documentTypeFor,
  extOf,
  buildDocumentKey,
  buildDavUrl,
  signDtToken,
} from '@/lib/onlyoffice/config-builder';
import { putCkSession } from '@/lib/onlyoffice/session-store';

export const runtime = 'nodejs';

// Public origin the Document Server uses to reach back to Nubo. The Doc Server
// fetches document.url and POSTs callbackUrl, so these must be absolute URLs the
// Doc Server can resolve. Defaults to the public app origin; override with
// ONLYOFFICE_APP_PUBLIC_URL if the Doc Server must use an internal hostname.
const APP_PUBLIC_URL = (process.env.ONLYOFFICE_APP_PUBLIC_URL || 'https://app.nubo.email').replace(/\/+$/, '');

const JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET || '';
const DT_SECRET = process.env.NUBO_DOWNLOAD_TOKEN_SECRET || '';

/** PROPFIND Depth:0 the DAV path to read getetag / getlastmodified. */
async function propfindVersion(davUrl: string, authHeader: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/><D:getlastmodified/></D:prop></D:propfind>`;
  try {
    const res = await fetch(davUrl, {
      method: 'PROPFIND',
      headers: { Authorization: authHeader, Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
    });
    if (res.status !== 207) return String(Date.now());
    const xml = await res.text();
    const etag = xml.match(/<[^>]*getetag[^>]*>([^<]+)<\/[^>]*getetag>/i)?.[1];
    if (etag) return etag;
    const lm = xml.match(/<[^>]*getlastmodified[^>]*>([^<]+)<\/[^>]*getlastmodified>/i)?.[1];
    if (lm) return String(Date.parse(lm) || Date.now());
  } catch {
    /* fall through */
  }
  return String(Date.now());
}

export async function POST(request: NextRequest) {
  if (!JWT_SECRET || !DT_SECRET) {
    return NextResponse.json({ error: 'OnlyOffice secrets not configured' }, { status: 500 });
  }

  const creds = await getStalwartCredentials(request);
  if (!creds) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let req: { path?: string; name?: string; mode?: string };
  try {
    req = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const name = (req.name || '').trim();
  // Path is the DAV-relative path of the file (FileNode name-hierarchy path,
  // no leading slash). Fall back to bare name (root-level file).
  const relPath = (req.path || name).replace(/^\/+/, '');
  if (!name || !relPath) {
    return NextResponse.json({ error: 'Missing file name/path' }, { status: 400 });
  }

  const documentType = documentTypeFor(name);
  if (!documentType) {
    return NextResponse.json({ error: `Unsupported file type: ${name}` }, { status: 415 });
  }
  const fileType = extOf(name);

  const davUrl = buildDavUrl(creds.serverUrl, creds.username, relPath);
  const version = await propfindVersion(davUrl, creds.authHeader);
  const documentKey = buildDocumentKey(creds.username, relPath, version);

  // Stash the editing session so download/callback can replay Stalwart auth
  // without trusting client/Doc-Server-supplied paths.
  const ck = randomUUID().replace(/-/g, '');
  putCkSession(ck, {
    username: creds.username,
    path: relPath,
    serverUrl: creds.serverUrl,
    authHeader: creds.authHeader,
    fileType,
    documentKey,
  });

  const dt = signDtToken(ck, DT_SECRET, 60 * 60); // 1h to start a download
  const mode = req.mode === 'view' ? 'view' : 'edit';

  // userId must be stable per user but need not leak the address; hash username.
  const userId = buildDocumentKey(creds.username, '', '0').slice(0, 40);

  const config: Record<string, unknown> = {
    documentType,
    document: {
      fileType,
      key: documentKey,
      title: name,
      url: `${APP_PUBLIC_URL}/api/onlyoffice/download?dt=${encodeURIComponent(dt)}`,
      permissions: { edit: mode === 'edit', download: true },
    },
    editorConfig: {
      callbackUrl: `${APP_PUBLIC_URL}/api/onlyoffice/callback?ck=${encodeURIComponent(ck)}`,
      mode,
      coEditing: { mode: 'fast', change: true },
      lang: 'en',
      user: { id: userId, name: creds.username },
    },
  };

  // The token signs the whole config (documentType + document + editorConfig).
  // The browser passes config (incl. token) to new DocsAPI.DocEditor(); the Doc
  // Server validates it. Client-only `events` are attached in the browser and
  // are intentionally NOT part of the signed payload.
  config.token = signHs256(config, JWT_SECRET);

  return NextResponse.json({ config });
}
