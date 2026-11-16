# ZERO BASE — Water-Tank Cleaning Business Management Platform

**ZERO BASE** is a production-ready, free-tier compatible cloud application for managing customers, year-wise cleaning service history, partial/full payments, IST reminders, and private service documents.

---

## Live Infrastructure & Stack

| Component | Service / Technology | URL / Identifier |
| :--- | :--- | :--- |
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS on **Cloudflare Pages** | `https://zero-base.pages.dev/` |
| **Backend API** | **Cloudflare Workers** (Hono, Zod, Jose) | `https://zero-base-api.suszero9.workers.dev/` |
| **Database** | **Supabase PostgreSQL** (Free Plan) | `https://fskcdtpdkjgjaksqwjaf.supabase.co` |
| **Authentication** | **Supabase Auth** (3 emergency owner logins, zero public signup) | `fskcdtpdkjgjaksqwjaf` |
| **File Storage** | **Supabase Storage** (Private Bucket) | `zero-base-files` |
| **Source Control** | GitHub | `https://github.com/ZERO-SUS/Zero-Base` |

---

## Core Architecture

1. **Three Emergency Owner Accounts (Single Owner)**: Three existing Supabase Auth users share identical full administrator privileges via a database `owner_allowlist` table + Worker `OWNER_USER_IDS` allowlist. Any other authenticated user is rejected at both the Worker API and PostgreSQL/Storage RLS layers.
2. **JWT Forwarding (No Exposed Service-Role Key)**: The Worker verifies incoming Supabase JWTs and forwards the authenticated owner's JWT to Supabase PostgreSQL and Supabase Storage, so Row Level Security (`is_authorized_owner()`) is enforced on every operation.
3. **Private File Storage (`zero-base-files`)**: Uploads validate magic bytes (`JPEG`, `PNG`, `WebP`, `GIF`, `PDF`), store metadata in `public.service_files`, roll back storage objects on DB errors, and serve files exclusively through 5-minute signed URLs.
4. **Year-Wise Service History**: Grouped strictly by actual cleaning `service_date` in `Asia/Kolkata` (IST), never by `created_at`.

---

## Documentation
- [Local Setup Guide](docs/SETUP.md)
- [Database Schema, Triggers & RLS](docs/DATABASE.md)
- [Security Architecture](docs/SECURITY.md)
- [Free-Plan Backup & Restore](docs/BACKUP_AND_RESTORE.md)
- [Production Deployment Guide](docs/DEPLOYMENT.md)
