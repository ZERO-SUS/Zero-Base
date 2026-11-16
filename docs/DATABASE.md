# ZERO BASE — Database Architecture (`Supabase PostgreSQL`)

All schema changes are tracked in ordered SQL migrations under `supabase/migrations/`.

---

## Tables

| Table | Purpose | Key Constraints & Indexes |
| :--- | :--- | :--- |
| `owner_allowlist` | Stores the 3 authorized Supabase Auth UUIDs for the owner | `user_id` PK -> `auth.users(id)` |
| `profiles` | Administrator profile & synced theme preferences | `id` PK -> `auth.users(id)`, `role = 'admin'` |
| `customers` | Permanent customer records | `id` UUID PK, unique `customer_code` (`ZB-00001`), verbatim `phone_number`, trigram GIN search indexes, `archived_at` |
| `services` | Individual cleaning records | `id` UUID PK, `customer_id` FK (`ON DELETE RESTRICT`), `service_date` DESC index, `balance_amount`, `payment_status`, `idempotency_key` |
| `payments` | Cash/UPI/Other payment & refund ledger | `id` UUID PK, `service_id` & `customer_id` FKs, `reference_number`, `superseded_by`, `archive_reason` |
| `reminders` | Follow-up & service-due reminders | `id` UUID PK, partial unique indexes preventing duplicate active reminders per service & due date |
| `service_files` | Metadata for private Supabase Storage objects | `id` UUID PK, `customer_id`, `service_id`, nullable `payment_id`, unique `storage_path` |
| `audit_logs` | Append-only change history | Trigger-populated on insert/update/archive/restore/file delete |
| `business_settings` | Singleton configuration (`app_name`, `service_types`, `timezone`) | `singleton_key` unique |

---

## Server-Side Triggers & Business Rules
1. **Financial Integrity**: `trg_services_enforce_financials` and `trg_payments_recalculate_service` compute `total_amount = price - discount`, `amount_paid`, `balance_amount`, and `payment_status` (`Unpaid`, `Partially Paid`, `Paid`, `Refunded`) directly inside PostgreSQL.
2. **Payment Corrections**: Corrections archive the old `payments` row (`archived_at`, `archive_reason`, `superseded_by`) and insert a replacement row without ever silently erasing history.
3. **Timezone Standard**: `public.ist_today()` and all dashboard/report/reminder RPCs operate in `Asia/Kolkata`.
4. **Row Level Security**: Every table enforces `public.is_authorized_owner()`, ensuring only the 3 allowlisted owner accounts can read or write business data.
5. **Storage RLS (`0005_storage_rls.sql`)**: Replaces broad `authenticated` access on `storage.objects` with `bucket_id = 'zero-base-files' AND public.is_authorized_owner()`.
