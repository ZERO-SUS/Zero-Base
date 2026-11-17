import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAuthMiddleware } from './lib/auth';
import { rateLimitMiddleware } from './lib/rateLimit';
import { authRoutes } from './routes/auth';
import { customerRoutes } from './routes/customers';
import { dashboardRoutes } from './routes/dashboard';
import { fileRoutes } from './routes/files';
import { healthRoutes } from './routes/health';
import { paymentRoutes } from './routes/payments';
import { reminderRoutes } from './routes/reminders';
import { reportRoutes } from './routes/reports';
import { searchRoutes } from './routes/search';
import { serviceRoutes } from './routes/services';
import { settingsRoutes } from './routes/settings';
import type { AppBindings, ServiceOverrides } from './types';

export function createApp(overrides?: ServiceOverrides): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    const start = Date.now();
    c.set('requestId', requestId);

    await next();

    const durationMs = Date.now() - start;
    console.log(
      JSON.stringify({
        req_id: requestId,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        status: c.res.status,
        duration_ms: durationMs,
      })
    );

    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  app.use('*', async (c, next) => {
    const allowedRaw = c.env.ALLOWED_ORIGINS ?? 'https://zero-base.pages.dev,http://localhost:5173';
    const allowedList = allowedRaw
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean);

    const corsMiddleware = cors({
      origin: (origin) => {
        if (!origin) return allowedList[0] ?? 'https://zero-base.pages.dev';
        const normalized = origin.replace(/\/$/, '');
        return allowedList.includes(normalized) ? origin : '';
      },
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      exposeHeaders: ['Content-Disposition', 'X-Request-Id'],
      maxAge: 600,
    });

    return corsMiddleware(c, next);
  });

  app.use(
    '/api/*',
    rateLimitMiddleware({
      keyPrefix: 'api',
      maxRequests: 180,
      windowMs: 60_000,
    })
  );

  app.route('/', healthRoutes);

  app.use('/api/*', createAuthMiddleware(overrides));

  app.route('/api', authRoutes);
  app.route('/api', dashboardRoutes);
  app.route('/api', customerRoutes);
  app.route('/api', serviceRoutes);
  app.route('/api', searchRoutes);
  app.route('/api', paymentRoutes);
  app.route('/api', fileRoutes);
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
