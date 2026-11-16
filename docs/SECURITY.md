# ZERO BASE — Security Architecture & Controls

## 1. Three-Account Owner Allowlist
- Public registration is disabled in Supabase Auth.
- All three existing Supabase Auth accounts belong to **one owner** as emergency logins.
- **Defense in Depth**:
  1. **Worker Layer** ([worker/src/lib/auth.ts](../worker/src/lib/auth.ts)): Verifies Supabase JWT via JWKS / `SUPABASE_JWT_SECRET`, checks `OWNER_USER_IDS` secret if configured, and queries `public.owner_allowlist` using the caller's JWT.
  2. **Database Layer** ([0003_rls_policies.sql](../supabase/migrations/0003_rls_policies.sql)): Every table checks `public.is_authorized_owner()`.
  3. **Storage Layer** ([0005_storage_rls.sql](../supabase/migrations/0005_storage_rls.sql)): `storage.objects` policies restrict `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on bucket `zero-base-files` exclusively to `public.is_authorized_owner()`.

## 2. Zero Exposed Privileges
- The frontend uses only `VITE_SUPABASE_URL` and the public `VITE_SUPABASE_ANON_KEY`.
- No `service_role` key is placed in browser code or required by the standard Worker runtime—the Worker forwards the owner's verified JWT to Supabase so PostgreSQL RLS remains active.

## 3. Private Supabase Storage (`zero-base-files`)
- Bucket `public` flag is set to `false`.
- Uploads inspect magic bytes (`JPEG`, `PNG`, `WebP`, `GIF`, `PDF`) and enforce a 15 MB size limit.
- Compensating rollback deletes uploaded storage objects if `service_files` metadata insertion fails.
- File views and downloads use 5-minute signed URLs (`createSignedUrl`)—permanent public URLs are never generated or stored.

## 4. API & Financial Hardening
- Strict CORS origin allowlist (`https://zero-base.pages.dev` in production).
- Security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`).
- Per-IP sliding-window rate limiting (`429 Retry-After`) without paid dependencies.
- Safe structured request logging (`req_id`, `method`, `path`, `status`, `duration_ms`) without secrets or customer PII.
- CSV exports escape spreadsheet formula injection (`=`, `+`, `-`, `@`, tab, CR).
