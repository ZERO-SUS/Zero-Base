import type { MiddlewareHandler } from 'hono';
import type { AppBindings } from '../types';

interface BucketEntry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, BucketEntry>();

export function rateLimitMiddleware(options: {
  keyPrefix: string;
  maxRequests: number;
  windowMs: number;
}): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const ip =
      c.req.header('CF-Connecting-IP') ??
      c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
      'unknown';
    const key = `${options.keyPrefix}:${ip}`;
    const now = Date.now();

    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    } else if (current.count >= options.maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        {
          error: 'Too many requests. Please wait before retrying.',
          retry_after_seconds: retryAfterSec,
        },
        429
      );
    } else {
      current.count += 1;
    }

    // Periodic lightweight cleanup to keep memory bounded
    if (buckets.size > 5000) {
      for (const [k, entry] of buckets.entries()) {
        if (entry.resetAt <= now) {
          buckets.delete(k);
        }
      }
    }

    await next();
  };
}
