# ZERO BASE — Local Setup Guide

## 1. Prerequisites
- Node.js 20+ (`v24.x` tested)
- Access to Supabase project `fskcdtpdkjgjaksqwjaf` (`https://fskcdtpdkjgjaksqwjaf.supabase.co`)
- Wrangler CLI (included in `worker/` devDependencies)

## 2. Install Dependencies
```powershell
npm install
npm --prefix worker install
```

## 3. Configure Local Environment Variables
Copy [.env.example](../.env.example) to create:
1. **`E:\Zero Base\.env`** (Frontend):
   ```env
   VITE_SUPABASE_URL=https://fskcdtpdkjgjaksqwjaf.supabase.co
   VITE_SUPABASE_ANON_KEY=<your-supabase-publishable-key>
   VITE_API_BASE_URL=http://127.0.0.1:8787
   VITE_APP_NAME=ZERO BASE
   ```
2. **`E:\Zero Base\worker\.dev.vars`** (Local Worker):
   ```env
   SUPABASE_URL=https://fskcdtpdkjgjaksqwjaf.supabase.co
   SUPABASE_ANON_KEY=<your-supabase-publishable-key>
   OWNER_USER_IDS=<uid1>,<uid2>,<uid3>
   STORAGE_BUCKET=zero-base-files
   ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
   ```

> **Security rule**: Never commit `.env` or `worker/.dev.vars`, and never place a Supabase `service_role` / secret key in `VITE_*` variables.

## 4. Run Locally
```powershell
# Terminal 1: Start Worker API on http://127.0.0.1:8787
npm --prefix worker run dev -- --env development

# Terminal 2: Start React Frontend on http://localhost:5173
npm run dev
```

## 5. Run Verification Suite
```powershell
npm run typecheck
npm run typecheck:worker
npm run test:all
npm run build
```
