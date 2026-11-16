# ZERO BASE — Production Deployment Guide

Target production resources (Free Tier):
- **Frontend (Cloudflare Pages)**: `https://zero-base.pages.dev/`
- **Backend API (Cloudflare Worker)**: `https://zero-base-api.suszero9.workers.dev/`
- **Database & Storage (Supabase)**: `https://fskcdtpdkjgjaksqwjaf.supabase.co` (bucket: `zero-base-files`)
- **GitHub Repository**: `https://github.com/ZERO-SUS/Zero-Base`

---

## 1. Apply Database & Storage Migrations in Supabase
Open Supabase Dashboard (`fskcdtpdkjgjaksqwjaf`) -> **SQL Editor** and run in order:
1. `supabase/migrations/0001_initial_schema.sql`
2. `supabase/migrations/0002_financial_triggers_and_audit.sql`
3. `supabase/migrations/0003_rls_policies.sql`
4. `supabase/migrations/0004_reporting_and_search_functions.sql`
5. `supabase/migrations/0005_storage_rls.sql` *(replaces overly broad Storage policies on `zero-base-files`)*

## 2. Authorize the Three Emergency Owner Accounts
1. Go to **Authentication -> Providers -> Email** and ensure **Enable Sign Ups** is **disabled**.
2. Go to **Authentication -> URL Configuration**:
   - **Site URL**: `https://zero-base.pages.dev`
   - **Redirect URLs**: `https://zero-base.pages.dev/reset-password`, `http://localhost:5173/reset-password`
3. Go to **Authentication -> Users**, copy the 3 existing User UIDs, paste them into `supabase/seed_admin.sql`, and run it in the SQL Editor.

## 3. Configure Cloudflare Worker Secrets & Deploy (`zero-base-api`)
In `E:\Zero Base\worker`:
```powershell
npx wrangler login
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put OWNER_USER_IDS
# Paste the 3 owner UUIDs separated by commas: uid1,uid2,uid3
npm run deploy
```
Verify live health:
```powershell
curl https://zero-base-api.suszero9.workers.dev/health
```

## 4. Configure Cloudflare Pages (`zero-base.pages.dev`)
In Cloudflare Dashboard -> **Workers & Pages -> zero-base -> Settings**:
- **Build command**: `npm run build`
- **Build output directory**: `dist`
- **Environment variables (Production)**:
  - `VITE_SUPABASE_URL` = `https://fskcdtpdkjgjaksqwjaf.supabase.co`
  - `VITE_SUPABASE_ANON_KEY` = your Supabase publishable anon key
  - `VITE_API_BASE_URL` = `https://zero-base-api.suszero9.workers.dev`
  - `VITE_APP_NAME` = `ZERO BASE`

Trigger a deployment (or push to `main` on `ZERO-SUS/Zero-Base`).

## 5. Live Production Verification Checklist
1. Verify `GET https://zero-base-api.suszero9.workers.dev/health` returns `200 OK` with `storage_bucket: "zero-base-files"`.
2. Verify `GET https://zero-base-api.suszero9.workers.dev/api/customers` without auth returns `401`.
3. Log in on `https://zero-base.pages.dev/` with each of the 3 emergency owner accounts and verify they see the exact same customers, services, and files.
4. Create a customer, add a service, record a partial payment, upload a file to `zero-base-files`, open the 5-minute signed URL, and verify direct unauthenticated bucket URLs fail.
