import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../types';

export function createUserSupabaseClient(env: Env, userJwt: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${userJwt}`,
      },
    },
  });
}
