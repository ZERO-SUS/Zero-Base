import { Hono } from 'hono';
import type { AppBindings } from '../types';

export const healthRoutes = new Hono<AppBindings>();

healthRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'zero-base-api',
    environment: c.env.ENVIRONMENT ?? 'development',
    timezone: c.env.BUSINESS_TIMEZONE ?? 'Asia/Kolkata',
    timestamp: new Date().toISOString(),
  });
});
