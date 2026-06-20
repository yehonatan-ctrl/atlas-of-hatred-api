import { createHmac, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';

type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string };

function base64urlToBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function base64urlJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(base64urlToBuffer(value).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function verifyHs256Signature(signingInput: string, signaturePart: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  const actual = base64urlToBuffer(signaturePart);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function authenticateRequest(req: Request): AuthResult {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) {
    return {
      ok: false,
      status: 503,
      error: 'Authentication verifier is not configured.',
    };
  }

  const authHeader = req.header('authorization');
  const match = /^Bearer\s+(.+)$/i.exec(authHeader ?? '');
  if (!match) {
    return { ok: false, status: 401, error: 'Missing bearer token.' };
  }

  const token = match[1].trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, status: 401, error: 'Invalid bearer token.' };
  }

  const [headerPart, payloadPart, signaturePart] = parts;
  const header = base64urlJson(headerPart);
  const payload = base64urlJson(payloadPart);

  if (!header || header.alg !== 'HS256') {
    return { ok: false, status: 401, error: 'Unsupported bearer token.' };
  }
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) {
    return { ok: false, status: 401, error: 'Bearer token is missing subject.' };
  }
  if (!verifyHs256Signature(`${headerPart}.${payloadPart}`, signaturePart, jwtSecret)) {
    return { ok: false, status: 401, error: 'Bearer token signature is invalid.' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp <= nowSeconds) {
    return { ok: false, status: 401, error: 'Bearer token has expired.' };
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds) {
    return { ok: false, status: 401, error: 'Bearer token is not active yet.' };
  }

  return { ok: true, userId: payload.sub };
}

export function requireAuthenticatedUser(req: Request, res: Response): string | null {
  const result = authenticateRequest(req);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return null;
  }

  return result.userId;
}

export function assertRequestedUserMatchesAuthenticated(
  res: Response,
  requestedUserId: string | null,
  authenticatedUserId: string,
): boolean {
  if (requestedUserId && requestedUserId !== authenticatedUserId) {
    res.status(403).json({ error: 'Requested user_id does not match authenticated user.' });
    return false;
  }

  return true;
}
