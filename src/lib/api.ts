import { supabase } from './supabase';

const DEFAULT_API = import.meta.env.DEV
  ? 'http://127.0.0.1:8787'
  : 'https://zero-base-api.suszero9.workers.dev';

const API_BASE =
  ((import.meta.env.VITE_API_BASE_URL as string | undefined) || DEFAULT_API).replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (forceRefresh) {
    const { data, error } = await supabase.auth.refreshSession();
    const refreshed = data.session?.access_token;
    if (!error && refreshed) return refreshed;
    throw new ApiError('Your session ended. Please sign in again.', 401);
  }

  const { data } = await supabase.auth.getSession();
  const session = data.session;
  if (!session?.access_token) {
    throw new ApiError('Your session ended. Please sign in again.', 401);
  }

  // Proactively refresh if token expires within the next 60 seconds
  const nowSec = Math.floor(Date.now() / 1000);
  if (session.expires_at && session.expires_at - nowSec < 60) {
    const { data: refreshedData } = await supabase.auth.refreshSession();
    if (refreshedData.session?.access_token) {
      return refreshedData.session.access_token;
    }
  }

  return session.access_token;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const execute = async (forceRefresh: boolean) => {
    const token = await getAccessToken(forceRefresh);
    const headers = new Headers(init.headers ?? {});
    headers.set('Authorization', `Bearer ${token}`);
    if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });
  };

  let response: Response;
  try {
    response = await execute(false);
    if (response.status === 401) {
      response = await execute(true);
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(
      'Unable to reach ZERO BASE right now. Please check your internet connection and try again.',
      0
    );
  }

  if (response.status === 401) {
    throw new ApiError('Your session ended. Please sign in again.', 401);
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const errObj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    throw new ApiError(
      String(errObj.error ?? `Something went wrong (${response.status}). Please try again.`),
      response.status,
      typeof errObj.code === 'string' ? errObj.code : undefined,
      errObj
    );
  }

  return data as T;
}

/**
 * Best-effort background save used when closing/refreshing the page or switching tabs.
 * Never throws; reads cached token synchronously if possible or uses getSession.
 */
export function apiFlushKeepalive(path: string, method: 'PUT' | 'POST', bodyObj: unknown): void {
  void (async () => {
    try {
      const token = await getAccessToken(false);
      await fetch(`${API_BASE}${path}`, {
        method,
        keepalive: true,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bodyObj),
      });
    } catch {
      // Non-blocking best-effort background flush
    }
  })();
}

export async function apiDownloadBlob(path: string): Promise<Blob> {
  const token = await getAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new ApiError('Failed to download export file', response.status);
  }
  return response.blob();
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
