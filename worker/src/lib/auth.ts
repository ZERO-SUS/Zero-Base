import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { MiddlewareHandler } from 'hono';
import { createUserSupabaseClient } from './supabase';
import type { AppBindings, AuthUser, Env, ServiceOverrides } from '../types';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(supabaseUrl: string) {
  const normalized = supabaseUrl.replace(/\/$/, '');
  const url = `${normalized}/auth/v1/.well-known/jwks.json`;
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

export function parseOwnerAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))
  );
}

export async function verifySupabaseJwt(
  token: string,
  env: Env
): Promise<{ sub: string; email?: string }> {
  const issuer = `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;

  if (env.SUPABASE_JWT_SECRET) {
    try {
      const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
      const { payload } = await jwtVerify(token, secret, {
        issuer,
        audience: 'authenticated',
      });
      if (!payload.sub) {
        throw new Error('Missing subject claim');
      }
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
      };
    } catch {
      // Fall through to JWKS verification (ES256/RS256 Supabase keys)
    }
  }

  const jwks = getJwks(env.SUPABASE_URL);
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: 'authenticated',
  });
  if (!payload.sub) {
    throw new Error('Missing subject claim');
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : undefined,
  };
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function createAuthMiddleware(
  overrides?: ServiceOverrides
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    if (!token) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    let claims: { sub: string; email?: string };
    try {
      const verifier = overrides?.verifyJwt ?? verifySupabaseJwt;
      claims = await verifier(token, c.env);
    } catch {
      return c.json({ error: 'Invalid or expired authentication token' }, 401);
    }

    // 1. Optional Worker-level owner allowlist check (OWNER_USER_IDS secret)
    const configuredOwners = parseOwnerAllowlist(c.env.OWNER_USER_IDS);
    if (configuredOwners.size > 0 && !configuredOwners.has(claims.sub.toLowerCase())) {
      return c.json({ error: 'Access denied: account is not an authorized owner.' }, 403);
    }

    const supabaseFactory = overrides?.createSupabase ?? createUserSupabaseClient;
    const supabase = supabaseFactory(c.env, token);

    // 2. Database-level owner_allowlist verification (enforced via PostgreSQL RLS)
    const { data: allowRow, error: allowErr } = await supabase
      .from('owner_allowlist')
      .select('user_id, is_active')
      .eq('user_id', claims.sub)
      .eq('is_active', true)
      .maybeSingle();

    if (allowErr || !allowRow) {
      return c.json(
        { error: 'Access denied: account is not authorized in owner allowlist.' },
        403
      );
    }

    // 3. Load or initialize owner profile
    let { data: profile, error: profErr } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, theme_mode, accent_color')
      .eq('id', claims.sub)
      .maybeSingle();

    if (!profile && !profErr && claims.email) {
      const { data: created } = await supabase
        .from('profiles')
        .insert({
          id: claims.sub,
          email: claims.email,
          full_name: 'Owner Administrator',
          role: 'admin',
        })
        .select('id, email, full_name, role, theme_mode, accent_color')
        .single();
      profile = created;
    }

    if (profErr || !profile) {
      return c.json({ error: 'Owner profile unavailable or access denied' }, 403);
    }

    const authUser: AuthUser = {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      role: 'admin',
      themeMode: profile.theme_mode,
      accentColor: profile.accent_color,
      jwt: token,
    };

    c.set('authUser', authUser);
    c.set('supabase', supabase);

    await next();
  };
}

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const user = c.get('authUser');
  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Owner administrator privileges required' }, 403);
  }
  await next();
};
