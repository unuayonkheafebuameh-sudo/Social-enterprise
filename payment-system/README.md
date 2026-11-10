# Paystack + Supabase payment system

Status: written, NOT yet tested against live Supabase or Paystack. Do not take real payments until section 7 is done.

## 1. What was built

Backend functions (supabase/functions):
- `checkout` – validates the request, creates the order and a pending payment from DB prices, initialises Paystack, returns only the Paystack payment URL and references.
- `verify-payment` – customer status check. Verifies directly with Paystack, then reads the result back from the database. Also serves "Check order status" (order number + email).
- `paystack-webhook` – signature-verified, deduplicated, idempotent webhook receiver (charge.success, refund.*).
- `reconcile` – rechecks pending/processing payments with Paystack. Runs on a schedule (CRON_SECRET) or by an admin.
- `admin-api` – admin only: list/search, detail, verify, reconcile, refund, webhook failures, receipt email retry. There is no "mark as paid" action.
- `_shared/lib.ts` – Paystack calls, verifyAndApply, receipt email, admin check, reconciliation.

Database (supabase/migrations/001_payments.sql): products, orders, order_items, payments, payment_webhook_events, receipts, refunds, payment_audit_logs, app_settings, admin_users, rate_limits. Money-moving logic lives in SQL functions callable only by the service role: create_order, finalize_payment, set_payment_status, flag_payment, mark_initialized, record_refund_status, hit_rate_limit.

Front end: `index.html` (shop, checkout, status panel, printable receipt) and `admin.html` (admin interface). Amounts are integers in kobo.

How integrity is enforced:
- Totals are computed in `create_order` from the products table. The browser sends only product slugs and quantities.
- `finalize_payment` is the only code that sets a payment to success. It row-locks, checks amount and currency against the order, and creates the receipt in the same transaction.
- Unique constraints: transaction_reference, paystack_transaction_id, one successful payment per order, one receipt per payment, webhook dedupe_key.
- A retried checkout reuses the same idempotency key, so no second order or charge. Paystack rejects a reused reference.
- Audit logs are append-only (trigger blocks update and delete).

## 2. Setup

1. Create a Supabase project and a Paystack account. Use TEST keys first.
2. Install the CLI and deploy (run inside this folder):
```
npm i -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase secrets set PAYSTACK_SECRET_KEY=sk_test_xxx ALLOWED_ORIGINS=https://your-site.workers.dev SITE_URL=https://your-site.workers.dev CRON_SECRET=a-long-random-string
supabase functions deploy checkout verify-payment paystack-webhook reconcile admin-api
```
3. Edit business details: `update app_settings set value='...' where key='business_name';` (also business_email, business_phone, business_address).
4. Set real products and prices (kobo) in the `products` table.
5. In `index.html` and `admin.html` set SUPABASE_URL and SUPABASE_ANON_KEY (Project Settings > API, the anon/public key only). Upload both to Cloudflare.
6. Create an admin: add a user in Supabase Auth, then run `insert into admin_users(user_id) select id from auth.users where email='you@example.com';`. Turn on MFA for admins.

## 3. Required secrets (Supabase Edge Function secrets)
| Name | Purpose |
|---|---|
| PAYSTACK_SECRET_KEY | Paystack secret key (test, later live). Server only. |
| ALLOWED_ORIGINS | Your site origin(s), comma separated (CORS). |
| SITE_URL | Where Paystack sends customers after payment. |
| CRON_SECRET | 16+ characters. Lets the scheduler call `reconcile`. |
| RECONCILE_MIN_AGE_MINUTES | Optional, default 10. |
| RESEND_API_KEY, RESEND_FROM | Optional. Enables receipt emails (resend.com). Without them receipts show "not_configured". |

SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided to functions automatically. Never put them in the HTML.

## 4. Paystack webhook
Paystack Dashboard > Settings > API Keys & Webhooks. Set the Test webhook URL (and later the Live one) to:
`https://YOUR_PROJECT_REF.supabase.co/functions/v1/paystack-webhook`
Signature is HMAC SHA-512 of the raw body with your secret key, header `x-paystack-signature`. Use the test secret for test mode and the live secret for live mode.

Schedule reconciliation (enable pg_cron and pg_net in Supabase, replace values):
```sql
select cron.schedule('payments-reconcile','*/10 * * * *',$$
 select net.http_post(url:='https://YOUR_PROJECT_REF.supabase.co/functions/v1/reconcile',
 headers:='{"Content-Type":"application/json","x-cron-secret":"SAME_AS_CRON_SECRET"}'::jsonb, body:='{}'::jsonb) $$);
```

## 5. RLS policies (in the migration)
RLS is enabled on every table. anon and authenticated have no insert, update or delete rights anywhere.
- products: anyone reads active products.
- orders, order_items, payments, receipts: a signed-in customer reads only their own (customer_id = auth.uid()); admins read all. Customers get only safe payment columns (no review notes, access codes or URLs).
- refunds, payment_audit_logs, payment_webhook_events: admins read only.
- app_settings, admin_users, rate_limits: no policies, so only the service role can touch them.
Guest checkout is used by the site, so guests see their order through `verify-payment`, not the Data API.

## 6. Security limitations
- Untested. Written without access to Supabase, Paystack or a Deno runtime. Expect to fix small errors on first deploy.
- The Paystack webhook documentation I worked from describes the `x-paystack-signature` check and no timestamp. I implemented the signature check, deduplication and independent API verification of every event. Re-read Paystack's current docs for any newer timestamp or IP rules.
- Refund webhook field names (refund id and reference) are matched with a fallback. Confirm with a test refund.
- Rate limiting is per IP using a database counter. It is basic, with no CAPTCHA.
- Discounts, stock levels and multiple currencies are not implemented (discount is always 0, NGN only).
- Customer accounts exist in the database rules, but the site has guest checkout only.
- A payment initialised by Paystack whose response was lost cannot show the customer the payment link again. They are told to wait, and reconciliation closes the attempt so they can start a new one.
- Receipt email uses Resend only.
- Admin sign in is email and password. Add MFA and keep the admin list small.

## 7. Payment testing report
No test has been run, because I cannot reach Paystack or Supabase from my environment. What I did check: the JavaScript in index.html and admin.html passes a Node syntax check. SQL and TypeScript were not compiled or run.

| # | Scenario | How to test (Paystack test mode) | Result |
|---|---|---|---|
| 1 | Successful payment | Pay with a Paystack test card | Not run |
| 2 | Failed payment | Use a Paystack declined test card | Not run |
| 3 | Cancelled payment | Close the Paystack page, return to site | Not run |
| 4 | Browser closed after paying | Pay, close tab; check order status or wait for webhook | Not run |
| 5 | Network interruption during checkout | Go offline after pressing Pay; retry | Not run |
| 6 | Callback does not load | Pay, block the return page; webhook should still confirm | Not run |
| 7 | Duplicate webhook | Resend the same event from Paystack dashboard; expect one payment, one receipt | Not run |
| 8 | Invalid webhook signature | POST with a wrong signature; expect 401 and no change | Not run |
| 9 | Incorrect amount | Change the order amount in the DB, then verify; expect payment_review | Not run |
| 10 | Incorrect currency | Same, with currency | Not run |
| 11 | Unknown reference | Send a webhook for a reference not in the DB; expect no change | Not run |
| 12 | Duplicate payment attempt | Double click Pay; expect one order | Not run |
| 13 | Payment stays pending | Start payment, leave it; run reconcile | Not run |
| 14 | DB update fails after payment | Break the DB write temporarily; webhook returns 500 and Paystack retries | Not run |
| 15 | Receipt generation failure | Force an error in the receipt insert; payment must not be marked paid without it | Not run |
| 16 | Email delivery failure | Use a bad RESEND key; retry from admin | Not run |
| 17 | Refund | Refund from admin; confirm refund.processed webhook | Not run |
| 18 | Customer reads another customer's order | Query the Data API as a different user; expect no rows | Not run |
| 19 | Customer changes payment status | Try an update through the Data API; expect denied | Not run |
| 20 | Admin reconciles an unresolved payment | Use Verify with Paystack in admin.html | Not run |

Do not go live until every row says Passed.
