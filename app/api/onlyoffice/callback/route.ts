// host-patch target path:  app/api/onlyoffice/callback/route.ts
//
// POST /api/onlyoffice/callback?ck=<key>
// The Document Server POSTs edit status here. On status 2 (ready to save) or 6
// (force-save while editing) we download the edited file from body.url and PUT
// it back to Stalwart WebDAV using the user's authHeader from the ck session.
//
// OnlyOffice callback spec:
//   status 1=editing, 2=ready to save, 3=save error, 4=closed-no-change,
//   6=force-save, 7=force-save error.
//   (https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/)
//
// MUST respond {"error":0} on success or the editor surfaces an error.
//
// Save-back transport note: Files content lives in Stalwart's FileNode store,
// which is ALSO exposed over WebDAV (app/api/webdav/route.ts:27-31). A WebDAV
// PUT to the file's path overwrites the content in place, so the existing
// FileNode keeps its id/parent and the JMAP Files UI sees the new bytes on next
// refresh. This avoids the JMAP "updateFileNode can't change blobId" limitation
// (lib/jmap/client-interface.ts:321 only allows name/parentId patches) — we let
// DAV rebind the content instead of minting a new FileNode.

import { NextRequest, NextResponse } from 'next/server';
import { verifyHs256 } from '@/lib/onlyoffice/jwt';
import { buildDavUrl } from '@/lib/onlyoffice/config-builder';
import { getCkSession } from '@/lib/onlyoffice/session-store';

export const runtime = 'nodejs';

const JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET || '';

interface OoCallbackBody {
  key?: string;
  status?: number;
  url?: string;
  token?: string; // JWT signed by the Doc Server (inbox/outbox secret)
}

export async function POST(request: NextRequest) {
  // Always answer with JSON; the Doc Server treats non-{error:0} as failure.
  if (!JWT_SECRET) {
    return NextResponse.json({ error: 1 }, { status: 200 });
  }

  const ck = request.nextUrl.searchParams.get('ck') || '';
  const session = getCkSession(ck);
  if (!session) {
    // Unknown/expired session: nothing safe to write. Report error to editor.
    return NextResponse.json({ error: 1 }, { status: 200 });
  }

  let body: OoCallbackBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 1 }, { status: 200 });
  }

  // Verify the Doc Server's JWT. It arrives in body.token and/or as
  // Authorization: Bearer <jwt>. Accept either.
  const headerToken = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  const token = body.token || headerToken;
  if (!token) {
    return NextResponse.json({ error: 1 }, { status: 200 });
  }
  try {
    // When the token wraps the payload, OnlyOffice nests it under `payload`.
    verifyHs256(token, JWT_SECRET);
  } catch {
    return NextResponse.json({ error: 1 }, { status: 200 });
  }

  const status = body.status ?? 0;

  // 1 (editing) and 4 (closed, no changes) need no save; just ack.
  if (status !== 2 && status !== 6) {
    return NextResponse.json({ error: 0 }, { status: 200 });
  }

  if (!body.url) {
    return NextResponse.json({ error: 1 }, { status: 200 });
  }

  try {
    // 1) Fetch the edited document from the Doc Server.
    const edited = await fetch(body.url, { redirect: 'follow' });
    if (!edited.ok || !edited.body) {
      return NextResponse.json({ error: 1 }, { status: 200 });
    }

    // 2) PUT it back to Stalwart WebDAV at the session's path (server-trusted).
    const davUrl = buildDavUrl(session.serverUrl, session.username, session.path);
    const put = await fetch(davUrl, {
      method: 'PUT',
      headers: {
        Authorization: session.authHeader,
        'Content-Type': edited.headers.get('Content-Type') || 'application/octet-stream',
      },
      body: edited.body,
      // undici requires duplex for a streaming request body.
      ...( { duplex: 'half' } as Record<string, unknown> ),
    } as Parameters<typeof fetch>[1]);

    if (put.status >= 200 && put.status < 300) {
      return NextResponse.json({ error: 0 }, { status: 200 });
    }
    return NextResponse.json({ error: 1 }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 1 }, { status: 200 });
  }
}
