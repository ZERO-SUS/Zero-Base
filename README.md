# ZERO BASE — Business Management Platform

**ZERO BASE** is a production-ready, cloud-hosted business management platform built for water-tank cleaning operations. It combines a fast React/TypeScript frontend (Cloudflare Pages), an authenticated REST API (Cloudflare Workers), a normalized PostgreSQL database with Row Level Security (Supabase), and private cloud file storage (Cloudflare R2).

---

## Architecture Overview

| Layer | Technology | Responsibility |
| :--- | :--- | :--- |
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS, Lucide Icons | Responsive UI, customizable Light/Dark/Accent theme, instant search, year-wise history |
| **Backend API** | Cloudflare Workers (Hono + Zod + Jose) | JWT validation, role authorization, rate limiting, R2 uploads/signed file access, CSV exports |
| **Database** | Supabase PostgreSQL | 8 normalized tables, IST (`Asia/Kolkata`) analytics, DB-side financial triggers, RLS, audit logs |
| **Authentication** | Supabase Auth | Private administrator login, password reset, session validation, zero public signup |
| **File Storage** | Cloudflare R2 (Private Bucket) | Bills, UPI screenshots, before/after tank photos stored privately via Worker bindings |

---

## Key Features

- **Customer Management**: Permanent UUIDs, verbatim phone numbers (preserving leading zeros and `+91` country codes), trigram partial search across name/phone/address/locality/ID, automatic duplicate phone warning with direct link to existing record, and soft-archive/restore.
- **Year-Wise Service History**: Grouped strictly by actual cleaning date (`service_date`) in `Asia/Kolkata`, sorted newest year -> newest month -> newest date, collapsible groups, multi-filter support.
- **Service & Financial Integrity**: Server-side PostgreSQL triggers compute `total_amount = price - discount`, `amount_paid`, and `payment_status` (`Unpaid`, `Partially Paid`, `Paid`, `Refunded`). Supports full, partial, multiple payments, refunds, idempotency keys, and audit-preserving payment corrections.
- **Private Cloudflare R2 Storage**: Magic-byte validation (JPEG, PNG, WebP, GIF, PDF), compensating R2 rollback if metadata save fails, short-lived HMAC-SHA256 signed access links, retry queue for failed uploads, and admin orphan detection/cleanup.
- **Reminders & Reports**: IST-accurate reminder categories (`Overdue`, `Due Today`, `Upcoming`, `Contacted`, `Confirmed`, `Snoozed`, `Dismissed`), one active reminder per service enforced by partial unique index, Daily/Monthly/Yearly/Custom reports with formula-safe CSV export.
- **Complete Theme System**: Light, Dark, and System Default modes, 8 preset accent palettes, custom HEX + colour picker with automatic WCAG contrast foreground calculation, zero flash of wrong theme on initial paint, and profile sync across devices.

---

## Project Structure

```text
├── public/                 # Cloudflare Pages SPA fallback (_redirects)
├── src/                    # React + TypeScript frontend
│   ├── components/         # Layout, modals, attachments panel, UI primitives
│   ├── context/            # AuthContext & ThemeContext
│   ├── lib/                # API client, Supabase client, theme engine, formatters
│   ├── pages/              # Dashboard, History, Customers, Services, Reminders, Payments, Reports, Settings
│   └── test/               # Vitest frontend unit tests
├── worker/                 # Cloudflare Worker REST API
│   ├── src/
│   │   ├── lib/            # JWT auth, rate limiter, R2 file validation, HMAC signing, IST helpers
│   │   └── routes/         # Modular Hono route handlers
│   ├── tests/              # Vitest API integration & security tests
│   └── wrangler.toml       # Worker dev & production bindings
├── supabase/
│   ├── migrations/         # Ordered PostgreSQL SQL migrations (0001..0004)
│   └── seed_admin.sql      # Administrator activation helper
├── scripts/                # PostgreSQL & R2 backup, restore, and integrity verification scripts
└── docs/                   # Deployment, Security, and Backup/Recovery guides
```

---

## Local Development Setup

### 1. Prerequisites
- Node.js 20+ (`v24.x` tested)
- A Supabase project (PostgreSQL + Auth)
- Cloudflare account (for Wrangler local/remote R2 & deployment)

### 2. Configure Environment Files
Copy `.env.example`:
- Create `.env` at the repository root with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_BASE_URL=http://127.0.0.1:8787`.
- Create `worker/.dev.vars` with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `FILE_SIGNING_SECRET`, `ALLOWED_ORIGINS=http://localhost:5173`.

### 3. Apply Database Migrations
Run SQL migrations in `supabase/migrations/` in order (`0001` through `0004`), create your first admin user in Supabase Auth, and activate their profile using `supabase/seed_admin.sql`.

### 4. Run Locally
```bash
# Terminal 1: Cloudflare Worker API (http://127.0.0.1:8787)
npm run dev:worker

# Terminal 2: React Frontend (http://localhost:5173)
npm run dev
```

---

## Verification Commands

```bash
# Typecheck frontend & worker
npm run typecheck
npm run typecheck:worker

# Run all automated tests
npm run test:all

# Production frontend build (outputs dist/)
npm run build
```

---

## Documentation
- [Production Deployment Guide](docs/DEPLOYMENT.md)
- [Security Architecture & Controls](docs/SECURITY.md)
- [Backup & Disaster Recovery Guide](docs/BACKUP_AND_RECOVERY.md)
