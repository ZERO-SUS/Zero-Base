import type { SupabaseClient } from '@supabase/supabase-js';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_JWT_SECRET?: string;
  OWNER_USER_IDS?: string;
  STORAGE_BUCKET?: string;
  ALLOWED_ORIGINS?: string;
  ENVIRONMENT?: string;
  BUSINESS_TIMEZONE?: string;
  MAX_UPLOAD_BYTES?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'admin';
  themeMode: 'light' | 'dark' | 'system';
  accentColor: string;
  jwt: string;
}

export interface AppVariables {
  requestId: string;
  authUser: AuthUser;
  supabase: SupabaseClient;
}

export interface AppBindings {
  Bindings: Env;
  Variables: AppVariables;
}

export interface ServiceOverrides {
  verifyJwt?: (token: string, env: Env) => Promise<{ sub: string; email?: string }>;
  createSupabase?: (env: Env, jwt: string) => SupabaseClient;
}
