import { supabase } from './supabase';

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://127.0.0.1:8787';

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

async function getAccessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    throw new ApiError('Session expired. Please log in again.', 401);
  }
  return token;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  if (!(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
    });
  } catch {
    throw new ApiError('Network error while contacting ZERO BASE API. Please check your connection and retry.', 0);
  }

  if (response.status === 401) {
    throw new ApiError('Your session is invalid or expired. Please sign in again.', 401);
  }

  const contentType = response.headers.get('Content-Type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();

  if (!response.ok) {
    const errObj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    throw new ApiError(
      String(errObj.error ?? `Request failed (${response.status})`),
      response.status,
      typeof errObj.code === 'string' ? errObj.code : undefined,
      errObj
    );
  }

  return data as T;
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
