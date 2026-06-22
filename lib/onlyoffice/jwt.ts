// host-patch target path:  lib/onlyoffice/jwt.ts
//
// Minimal HS256 (HMAC-SHA256) JWT sign/verify using Node's crypto. We do NOT
// pull in a new dependency (jsonwebtoken) so the fork surface stays small and
// auditable; OnlyOffice only ever uses HS256 for its self-hosted token, which
// is a trivial JWS to produce/verify.
//
// References:
//   - OnlyOffice JWT: alg HS256, secret = services.CoAuthoring.secret
//     (https://api.onlyoffice.com/docs/docs-api/additional-api/signature/)
//   - RFC 7519 (JWT) / RFC 7515 (JWS compact serialization).

import { createHmac, timingSafeEqual } from 'node:crypto';

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function b64urlJson(obj: unknown): string {
  return b64url(JSON.stringify(obj));
}

function fromB64url(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Sign an arbitrary payload as an HS256 JWT.
 * `expiresInSec` (optional) adds an `exp` claim; OnlyOffice does not require it
 * on the editor-config token, but it is good hygiene for the dt token.
 */
export function signHs256(payload: Record<string, unknown>, secret: string, expiresInSec?: number): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body: Record<string, unknown> = { ...payload };
  if (expiresInSec != null) {
    const now = Math.floor(Date.now() / 1000);
    body.iat = now;
    body.exp = now + expiresInSec;
  }
  const signingInput = `${b64urlJson(header)}.${b64urlJson(body)}`;
  const sig = b64url(createHmac('sha256', secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

/**
 * Verify an HS256 JWT and return its payload, or throw. Checks signature
 * (constant-time) and `exp` if present.
 */
export function verifyHs256<T = Record<string, unknown>>(token: string, secret: string): T {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');
  const [h, p, s] = parts;
  const signingInput = `${h}.${p}`;
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  const got = fromB64url(s);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    throw new Error('Bad JWT signature');
  }
  const payload = JSON.parse(fromB64url(p).toString('utf8')) as T & { exp?: number };
  if (typeof payload.exp === 'number' && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('JWT expired');
  }
  return payload as T;
}
