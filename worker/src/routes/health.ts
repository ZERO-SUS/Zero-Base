import { Hono } from 'hono';
import type { AppBindings } from '../types';

export const healthRoutes = new Hono<AppBindings>();

function healthResponse(c: { env: AppBindings['Bindings']; json: (data: unknown) => Response }) {
  return c.json({
    status: 'ok',
    service: 'zero-base-api',
    environment: c.env.ENVIRONMENT ?? 'development',
    storage_bucket: c.env.STORAGE_BUCKET ?? 'zero-base-files',
    timezone: c.env.BUSINESS_TIMEZONE ?? 'Asia/Kolkata',
    timestamp: new Date().toISOString(),
  });
}

healthRoutes.get('/health', (c) => healthResponse(c));
healthRoutes.get('/api/health', (c) => healthResponse(c));
