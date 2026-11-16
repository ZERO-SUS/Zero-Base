# ZERO BASE — Security Architecture & Controls

## 1. Zero-Trust Authentication & Authorization
- **Supabase Auth**: All authentication is handled by Supabase Auth with public registration disabled.
- **Worker JWT Verification**: Every protected `/api/*` request validates the `Authorization: Bearer <jwt>` token cryptographically via Supabase JWKS (`jose.createRemoteJWKSet`) or `SUPABASE_JWT_SECRET` before executing any handler.
- **No Trusted Client Claims**: The Worker never accepts user IDs, roles, or permission claims from request bodies or headers. It derives `auth.uid()` from the verified JWT and reads `profiles` directly.
- **Active Account Enforcement**: Both the Worker middleware and PostgreSQL RLS helper functions (`is_active_staff()`, `is_active_admin()`) require `profiles.is_active = true` and `role IN ('admin', 'staff')`.
- **Self-Escalation Prevention**: PostgreSQL trigger `trg_protect_profile_privileges` prevents non-admin users from altering `role` or `is_active` even if they issue direct profile updates.

## 2. Row Level Security (PostgreSQL RLS)
- RLS is enabled on all 8 tables: `profiles`, `customers`, `services`, `payments`, `attachments`, `reminders`, `audit_logs`, `business_settings`.
- The Worker connects to Supabase using `SUPABASE_ANON_KEY` + the user's verified JWT (`Authorization: Bearer <user_jwt>`). **Service-role keys are never used in the browser or standard Worker runtime**, ensuring PostgreSQL RLS policies are enforced end-to-end.
- No `DELETE` RLS policies exist on business tables; records are soft-archived via `archived_at` to prevent accidental or unauthorized data destruction.

## 3. Private Cloudflare R2 Storage
- The R2 bucket is strictly private with no public URL or public bucket policy.
- Uploads validate actual file magic bytes (`JPEG`, `PNG`, `WebP`, `GIF`, `PDF`) and enforce size limits (`15 MB` default), preventing spoofed `Content-Type` uploads.
- Downloads and image previews use short-lived (5-minute) HMAC-SHA256 signed tokens generated with `FILE_SIGNING_SECRET`, bound to `attachmentId`, `storageKey`, and `userId`.
- Responses include `X-Content-Type-Options: nosniff` and `Cache-Control: private, no-store`.

## 4. Financial & Operational Integrity
- `total_amount`, `amount_paid`, and `payment_status` are enforced by PostgreSQL triggers (`enforce_service_financials`, `recalculate_service_payment_totals`)—never trusted from client calculations.
- Payment corrections preserve original records (`archived_at`, `archived_by`, `archive_reason`, `superseded_by`) and emit immutable `audit_logs` entries.
- `idempotency_key` unique constraints prevent duplicate services or payments on double-clicks or network retries.
- CSV exports neutralize spreadsheet formula injection (`=`, `+`, `-`, `@`, tab, CR).

## 5. HTTP & Operational Hardening
- Strict CORS origin allowlist (`ALLOWED_ORIGINS`).
- Security response headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Request-Id`.
- Per-IP sliding-window rate limiting across API routes (`429 Retry-After`).
- Strict Zod input validation on every JSON payload and route UUID parameter.
