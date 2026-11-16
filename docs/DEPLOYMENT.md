# ZERO BASE — Production Deployment Guide

Follow these 10 steps in order to deploy ZERO BASE safely with separate development and production environments.

---

## 1. Create the Supabase Project
1. Create a new Supabase project in the region closest to your business (e.g., `ap-south-1` Mumbai for India).
2. Save the **Project URL** (`SUPABASE_URL`) and **Anon Public Key** (`SUPABASE_ANON_KEY`).
3. Never expose the `service_role` key in browser code or Worker public config.

## 2. Configure Authentication
1. In Supabase Dashboard -> **Authentication -> Providers -> Email**:
   - **Disable** `Enable Sign Ups` (or restrict signups completely) so no public users can register.
   - Enable email/password login and password recovery emails.
2. Under **Authentication -> URL Configuration**:
   - Set **Site URL** to your production Cloudflare Pages URL (e.g., `https://zero-base.pages.dev`).
   - Add `https://zero-base.pages.dev/reset-password` (and `http://localhost:5173/reset-password` for dev) to **Redirect URLs**.
3. Under **Authentication -> Users**:
   - Click **Add user** -> create your primary administrator email and strong password (with Auto Confirm enabled).

## 3. Apply Database Migrations
Apply the migrations in order via Supabase CLI (`supabase db push`) or the Supabase SQL Editor:
1. `supabase/migrations/0001_initial_schema.sql`
2. `supabase/migrations/0002_financial_triggers_and_audit.sql`
3. `supabase/migrations/0003_rls_policies.sql`
4. `supabase/migrations/0004_reporting_and_search_functions.sql`

Then run `supabase/seed_admin.sql` (editing the email address to match the administrator created in Step 2) to set `role = 'admin'` and `is_active = true`.

## 4. Create the Private R2 Bucket
1. In Cloudflare Dashboard -> **R2 Object Storage**, create:
   - Production bucket: `zero-base-files`
   - Development bucket: `zero-base-files-dev`
2. Leave **Public Access disabled** on both buckets. Files are served exclusively through authenticated/signed Worker routes.

## 5. Configure Worker Bindings
`worker/wrangler.toml` defines separate development (`[vars]`, `zero-base-files-dev`) and production (`[env.production]`, `zero-base-files`) configurations.
Verify `bucket_name` in `worker/wrangler.toml` matches your created R2 bucket names.

## 6. Configure Cloudflare Worker Secrets
From `worker/`, set encrypted secrets for production:
```bash
cd worker
npx wrangler secret put SUPABASE_URL --env production
npx wrangler secret put SUPABASE_ANON_KEY --env production
npx wrangler secret put FILE_SIGNING_SECRET --env production
npx wrangler secret put ALLOWED_ORIGINS --env production
# Optional if your Supabase project uses HS256 instead of JWKS asymmetric JWTs:
# npx wrangler secret put SUPABASE_JWT_SECRET --env production
```
- Generate `FILE_SIGNING_SECRET` with: `openssl rand -hex 32`
- Set `ALLOWED_ORIGINS` to your exact Cloudflare Pages domain (e.g., `https://zero-base.pages.dev`).

## 7. Connect the Private GitHub Repository
1. Initialize Git, commit your source (verify `.gitignore` excludes `.env`, `.dev.vars`, `backups/`), and push to a **private** GitHub repository.
2. Confirm no secrets exist in commit history before pushing.

## 8. Deploy Cloudflare Workers
```bash
cd worker
npm install
npm run deploy:prod
```
Record the deployed Worker URL (e.g., `https://zero-base-api-prod.<subdomain>.workers.dev` or a custom API domain like `https://api.yourdomain.com`).
Verify liveness:
```bash
curl https://<your-worker-url>/api/health
```

## 9. Deploy Cloudflare Pages (Frontend)
1. In Cloudflare Dashboard -> **Workers & Pages -> Create -> Pages -> Connect to Git**, select your private GitHub repository.
2. Configure build settings:
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
3. Add **Production Environment Variables** in Cloudflare Pages:
   - `VITE_SUPABASE_URL` = your production Supabase URL
   - `VITE_SUPABASE_ANON_KEY` = your production Supabase anon key
   - `VITE_API_BASE_URL` = your production Worker URL (from Step 8)
   - `VITE_APP_NAME` = `ZERO BASE`
4. Trigger deployment.

## 10. Verify the Complete Production Flow
Run through this verification checklist after deploying:
1. Open your Cloudflare Pages URL and confirm **no signup form** is present.
2. Log in with your activated administrator account; confirm `/api/me` succeeds and Dashboard loads real metrics.
3. Verify unauthenticated `GET https://<worker-url>/api/customers` returns `401`.
4. Create a test customer with leading zeros / `+91`, verify duplicate phone check works.
5. Add a service backdated to a previous year (e.g., `2025-12-20`) and confirm it appears under **December 2025** in Service History.
6. Record a partial payment, verify status becomes `Partially Paid`, then complete payment (`Paid`).
7. Upload an image attachment, verify temporary signed link opens it, and verify accessing `/api/attachments/:id/file` without a token returns `401`.
8. Switch Light/Dark/Custom Accent HEX and reload the page to confirm persistence without theme flash.
9. Run your first backup via `scripts/backup-db.sh` + `scripts/backup-r2.sh` + `scripts/verify-backup.mjs`.
