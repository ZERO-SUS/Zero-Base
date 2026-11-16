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
      // Fall through to JWKS verification (for asymmetric ES256/RS256 Supabase keys)
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

    const supabaseFactory = overrides?.createSupabase ?? createUserSupabaseClient;
    const supabase = supabaseFactory(c.env, token);

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, is_active, theme_mode, accent_color')
      .eq('id', claims.sub)
      .single();

    if (error || !profile) {
      return c.json({ error: 'User profile not found or access denied' }, 403);
    }

    if (!profile.is_active) {
      return c.json({ error: 'Account is deactivated. Contact the primary administrator.' }, 403);
    }

    if (profile.role !== 'admin' && profile.role !== 'staff') {
      return c.json({ error: 'Insufficient authorization role' }, 403);
    }

    const authUser: AuthUser = {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role,
      isActive: profile.is_active,
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
    return c.json({ error: 'Administrator privileges required' }, 403);
  }
  await next();
};
