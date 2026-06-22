// host-patch target path:  app/api/onlyoffice/download/route.ts
//
// GET /api/onlyoffice/download?dt=<token>
// The Document Server fetches document.url here. It has no Nubo session cookie,
// so it authenticates with the short-lived `dt` token (NUBO_DOWNLOAD_TOKEN_SECRET).
// We resolve the editing session from the embedded ck and stream the file from
// Stalwart WebDAV with the user's real authHeader.
//
// Mirrors the GET path of app/api/webdav/route.ts:92-113 but auth comes from the
// dt token + ck session store rather than the user's cookie.

import { NextRequest, NextResponse } from 'next/server';
import { verifyDtToken, buildDavUrl } from '@/lib/onlyoffice/config-builder';
import { getCkSession } from '@/lib/onlyoffice/session-store';

export const runtime = 'nodejs';

const DT_SECRET = process.env.NUBO_DOWNLOAD_TOKEN_SECRET || '';

export async function GET(request: NextRequest) {
  if (!DT_SECRET) {
    return NextResponse.json({ error: 'not configured' }, { status: 500 });
  }
  const dt = request.nextUrl.searchParams.get('dt');
  if (!dt) return NextResponse.json({ error: 'missing dt' }, { status: 400 });

  let ck: string;
  try {
    ({ ck } = verifyDtToken(dt, DT_SECRET));
  } catch {
    return NextResponse.json({ error: 'bad dt token' }, { status: 401 });
  }

  const session = getCkSession(ck);
  if (!session) {
    return NextResponse.json({ error: 'session expired' }, { status: 410 });
  }

  const davUrl = buildDavUrl(session.serverUrl, session.username, session.path);
  const upstream = await fetch(davUrl, {
    method: 'GET',
    headers: { Authorization: session.authHeader },
    redirect: 'follow',
  });

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: `upstream ${upstream.status}` }, { status: 502 });
  }

  const headers = new Headers();
  headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
  const len = upstream.headers.get('Content-Length');
  if (len) headers.set('Content-Length', len);
  return new NextResponse(upstream.body, { status: 200, headers });
}
