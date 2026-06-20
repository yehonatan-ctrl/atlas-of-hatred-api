import { createHmac, createPublicKey, timingSafeEqual, verify } from 'crypto';
import { Request, Response } from 'express';

type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: number; error: string };

type JwtPayload = Record<string, unknown> & {
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iss?: string;
  sub?: string;
};

type JwtHeader = Record<string, unknown> & {
  alg?: string;
  kid?: string;
};

type Jwk = {
  alg?: string;
  crv?: string;
  kid?: string;
  kty?: string;
  use?: string;
  x?: string;
  y?: string;
};

type JwksCache = {
  expiresAt: number;
  keys: Jwk[];
};

const DEFAULT_SUPABASE_PROJECT_URL = 'https://lmdjxkeqggfrslljevsb.supabase.co';
const JWKS_CACHE_MS = 10 * 60 * 1000;

let jwksCache: JwksCache | null = null;

function base64urlToBuffer(value: string): Buffer {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function base64urlJson<T extends Record<string, unknown>>(value: string): T | null {
  try {
    return JSON.parse(base64urlToBuffer(value).toString('utf8')) as T;
  } catch {
    return null;
  }
}

function getSupabaseProjectUrl(): string {
  return (
    process.env.SUPABASE_PROJECT_URL ??
    process.env.SUPABASE_URL ??
    DEFAULT_SUPABASE_PROJECT_URL
  ).replace(/\/+$/, '');
}

function getExpectedIssuer(): string {
  return process.env.SUPABASE_JWT_ISSUER ?? `${getSupabaseProjectUrl()}/auth/v1`;
}

function getSupabaseJwksUrl(): string {
  return process.env.SUPABASE_JWKS_URL ?? `${getSupabaseProjectUrl()}/auth/v1/.well-known/jwks.json`;
}

function audienceIncludesAuthenticated(aud: JwtPayload['aud']): boolean {
  if (typeof aud === 'string') return aud === 'authenticated';
  if (Array.isArray(aud)) return aud.includes('authenticated');
  return true;
}

async function loadJwks(): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) return jwksCache.keys;

  const response = await fetch(getSupabaseJwksUrl(), {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`JWKS request failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { keys?: Jwk[] };
  if (!Array.isArray(payload.keys)) {
    throw new Error('JWKS response did not include keys');
  }

  jwksCache = {
    expiresAt: now + JWKS_CACHE_MS,
    keys: payload.keys,
  };

  return payload.keys;
}

function verifyHs256Signature(signingInput: string, signaturePart: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  const actual = base64urlToBuffer(signaturePart);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function verifyEs256Signature(
  signingInput: string,
  signaturePart: string,
  kid: string | undefined,
): Promise<boolean> {
  if (!kid) return false;

  const keys = await loadJwks();
  const jwk = keys.find((key) => key.kid?.toLowerCase() === kid.toLowerCase());
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return false;

  const publicKey = createPublicKey({
    format: 'jwk',
    key: jwk,
  });

  return verify(
    'sha256',
    Buffer.from(signingInput),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    base64urlToBuffer(signaturePart),
  );
}

async function authenticateRequest(req: Request): Promise<AuthResult> {
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
  const header = base64urlJson<JwtHeader>(headerPart);
  const payload = base64urlJson<JwtPayload>(payloadPart);

  if (!header || typeof header.alg !== 'string') {
    return { ok: false, status: 401, error: 'Unsupported bearer token.' };
  }
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) {
    return { ok: false, status: 401, error: 'Bearer token is missing subject.' };
  }

  if (payload.iss && payload.iss !== getExpectedIssuer()) {
    return { ok: false, status: 401, error: 'Bearer token issuer is invalid.' };
  }
  if (!audienceIncludesAuthenticated(payload.aud)) {
    return { ok: false, status: 401, error: 'Bearer token audience is invalid.' };
  }

  const signingInput = `${headerPart}.${payloadPart}`;
  let validSignature = false;

  if (header.alg === 'HS256') {
    const jwtSecret = process.env.SUPABASE_JWT_SECRET;
    if (!jwtSecret) {
      return {
        ok: false,
        status: 503,
        error: 'Legacy authentication verifier is not configured.',
      };
    }
    validSignature = verifyHs256Signature(signingInput, signaturePart, jwtSecret);
  } else if (header.alg === 'ES256') {
    try {
      validSignature = await verifyEs256Signature(signingInput, signaturePart, header.kid);
    } catch (err) {
      console.error('JWKS verification error:', err);
      return {
        ok: false,
        status: 503,
        error: 'Authentication verifier is temporarily unavailable.',
      };
    }
  } else {
    return { ok: false, status: 401, error: 'Unsupported bearer token.' };
  }

  if (!validSignature) {
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

export async function requireAuthenticatedUser(req: Request, res: Response): Promise<string | null> {
  const result = await authenticateRequest(req);
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
