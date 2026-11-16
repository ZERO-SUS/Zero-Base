import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAuthMiddleware } from './lib/auth';
import { rateLimitMiddleware } from './lib/rateLimit';
import { attachmentRoutes, publicSignedFileRoutes } from './routes/attachments';
import { authRoutes } from './routes/auth';
import { customerRoutes } from './routes/customers';
import { dashboardRoutes } from './routes/dashboard';
import { healthRoutes } from './routes/health';
import { paymentRoutes } from './routes/payments';
import { reminderRoutes } from './routes/reminders';
import { reportRoutes } from './routes/reports';
import { serviceRoutes } from './routes/services';
import { settingsRoutes } from './routes/settings';
import type { AppBindings, ServiceOverrides } from './types';

export function createApp(overrides?: ServiceOverrides): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  // Security headers on every response
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  // Strict CORS origin allowlist
  app.use('/api/*', async (c, next) => {
    const allowedRaw = c.env.ALLOWED_ORIGINS ?? 'http://localhost:5173';
    const allowedList = allowedRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const corsMiddleware = cors({
      origin: (origin) => {
        if (!origin) return allowedList[0] ?? '*';
        return allowedList.includes(origin) ? origin : '';
      },
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['Content-Disposition', 'X-Request-Id'],
      maxAge: 600,
    });

    return corsMiddleware(c, next);
  });

  // Global rate limit for API routes
  app.use(
    '/api/*',
    rateLimitMiddleware({
      keyPrefix: 'api',
      maxRequests: 180,
      windowMs: 60_000,
    })
  );

  // Public health endpoint (no sensitive info)
  app.route('/api', healthRoutes);

  // Short-lived HMAC-signed private R2 file streaming route
  app.route('/api', publicSignedFileRoutes);

  // All remaining /api/* routes require verified Supabase Auth + active staff profile
  app.use('/api/*', createAuthMiddleware(overrides));

  app.route('/api', authRoutes);
  app.route('/api', dashboardRoutes);
  app.route('/api', customerRoutes);
  app.route('/api', serviceRoutes);
  app.route('/api', paymentRoutes);
  app.route('/api', attachmentRoutes);
  app.route('/api', reminderRoutes);
  app.route('/api', reportRoutes);
  app.route('/api', settingsRoutes);

  app.notFound((c) => c.json({ error: 'Endpoint not found' }, 404));

  app.onError((err, c) => {
    console.error(`[${c.get('requestId') ?? 'unknown'}] Unhandled API error:`, err.message);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
