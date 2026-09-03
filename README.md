# Field Ledger

Bill delivery, cash collection and reconciliation for FMCG distribution — a mobile-first
field app for salesmen and a numbers-first back office for the desk.

```
Expected = Σ(Bill Amounts) − Σ(Cancelled) − Σ(Short Items)
Actual   = Σ(Cash) + Σ(Online) + Σ(Cheque) + Σ(Credit Notes)
Variance = Expected − Actual
```

That one identity is the product. The field app exists to capture its inputs in seconds on a
phone; the admin panel exists to make its output impossible to misread.

---

## Running it

```bash
npm install
npm run seed          # 6 salesmen, 48 shops, 10 days of bills, collections, shortages
npm run dev           # API on :4000, Vite dev server on :5173
```

Open **http://localhost:5173** (the field app and the admin panel are the same bundle — you
get routed by role).

Alternatively, run the two processes separately, which is what the hosted preview does:

```bash
npm run dev:api       # Express + PostgreSQL on :4000
npm run dev:web       # Vite on :5173, proxies /api → :4000
```

For a production-style run: `npm run build && npm start` — Express then serves the built app
from `:4000` as well as the API.

The server needs a PostgreSQL database. Point `DATABASE_URL` at one (Supabase works out of the
box), then bootstrap the schema and seed the demo ledger:

```bash
npm run db:init       # apply server/schema.sql (safe to re-run)
npm run seed          # 6 salesmen, 10 days of demo data (--force wipes first)
```

Your real connection string lives in `.env` (gitignored) — never commit it.

### Demo logins

| Login code | Password | What you get |
|---|---|---|
| `admin` | `admin123` | Back office — every salesman, every day |
| `ops` | `ops123` | Second back-office user |
| `SLM-01` … `SLM-06` | `field123` | Field app for one route (SLM-01 = Ramesh Yadav) |

---

## What's in it

### Field app (salesman, one-handed, one screen per action)

- **Start day** — opening book (bill count + value), four-step rail: Start day → Visit shop →
  Collect → End day.
- **Bills** — today's route, searchable, filterable, open bills first, running total pinned to
  the top of every screen.
- **Bill → Deliver & collect** — one screen, any combination of cash / online / cheque /
  credit note. Cash is entered on a **denomination grid** (notes, then coins) because that is
  how a bundle is actually counted; the grid total *is* the cash amount.
- **Report shortage** — product, quantity, rate, reason. Auto-deducted from what's expected.
- **Mark cancelled** — invoice, amount, reason.
- **Add bills** — Excel/CSV batch (header order and wording don't matter) or one at a time
  with a photo.
- **Me** — delivered, cancelled, collected by mode, shortage total, pending list, cash in hand.
- **End day** — the day's own reconciliation, cash to deposit, optional note for the office.

### Admin panel

- **Reconciliation strip** — Expected / Collected / Variance as the hero of the page, with the
  arithmetic spelled out under each number.
- **Collected by mode** and **day-by-day** tables, so you can see *where* the variance sits.
- **Salesman-wise table** — sortable, with day status and last-entry time; click through to a
  drill-down with that salesman's bills, collection entries, cancellations, shortages and day log.
- **Cancellations** and **Shortages** — with reason/product roll-ups.
- **Cash denomination roll-up** — note-by-note, for planning the bank deposit.
- **Export** — every screen exports to Excel or PDF with the active date range and salesman filter.

### Reconciliation rules

- Reconciliation is measured on **bill dates**: a period's expected and collected figures both
  follow the bills dated in that period, so cash collected today against yesterday's bill still
  shows as variance until it lands.
- The **cash roll-up** is measured on **collection dates**, because that is the number the bank
  deposit needs. Both are labelled on screen.
- A bill is `delivered` once collected ≥ (amount − shortage); `pending` at zero; `partial`
  in between; `cancelled` is terminal and zeroes out what's expected.

---

## Working without signal

The field app never loses an entry. Every write is attempted against the API first; if the
request fails because there is no connection, the entry is queued in `localStorage` with a
client-generated id and replayed through `POST /api/sync` when signal returns. Photos taken
offline are compressed client-side and carried as data URLs, then materialised as files on sync.

The server de-duplicates on that client id (`client_id` columns), so a replay after a
half-succeeded request can never double-collect a payment. The queue is visible in the app —
"3 entries waiting to sync" — with a manual **Sync now**.

---

## Stack

| Layer | Choice |
|---|---|
| Front end | React 18 + Vite 5 + Tailwind 3, IBM Plex Sans (UI) / IBM Plex Mono (numbers) |
| Back end | Express 4 (`server/app.js` shared by Node and serverless hosts) |
| Database | Supabase PostgreSQL via `pg` (`server/schema.sql`) |
| Realtime | PostgreSQL `LISTEN/NOTIFY` triggers → SSE endpoint (`/api/realtime`) |
| Security | Row-level security policies + per-request DB session context, scrypt hashes |
| Uploads | multer → Supabase Storage (`server/storage.js`), workbooks parsed with ExcelJS |
| Exports | ExcelJS (`.xlsx`), PDFKit (`.pdf`) |
| Auth | Login code + scrypt password hash, random session token in `Authorization: Bearer` |

Environment variables: `DATABASE_URL` (required), `DATABASE_SSL=false` (disable TLS for a local
Postgres), `PORT`, `CORS_ORIGINS` (comma-separated, production), `PGPOOL_MAX` (DB pool size).

**Connection model:** the app connects through a shared pool, and each HTTP request runs inside
**one database transaction** that is opened lazily on the first query and committed when the response
finishes. The RLS session variables (`app.current_user_id`, `app.current_user_role`) are set with
`set_config(…, is_local)` at the start of that transaction, so **reads and writes both carry RLS
context** — the app stays correct even if `DATABASE_URL` ever connects as a non-owner role (today it
connects as the table owner, which bypasses RLS). This is exactly the pattern Supabase's
**transaction-mode pooler** supports: point `DATABASE_URL` at the pooler on **port 6543**
(`postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`) so concurrent
requests share a few backends instead of exhausting the 15-session cap of port 5432. The realtime
`LISTEN` listener needs a long-lived session, so it uses `REALTIME_DATABASE_URL` when set (the
session-mode URL on port 5432, or the direct host); on plain local/CI Postgres just leave it unset
and it falls back to `DATABASE_URL`.

Attachment storage: `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` store invoice photos and
collection screenshots in a private Supabase Storage bucket (default name `field-ledger`,
override with `SUPABASE_STORAGE_BUCKET`). Without those keys files fall back to `server/uploads/`
on disk — fine for dev and a single VPS, but not serverless.

Attachment access: `/uploads/*` is never public. The API signs short-lived per-file URLs
(`POST /api/attachments/sign`, logged-in only) and the client requests a fresh signature each
time an attachment is opened. Signatures are HMAC-SHA256 over the file name + expiry; they live
typically one hour (`UPLOAD_SIGN_TTL` seconds) and are rejected after that or when tampered.
The signing key is derived from `DATABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, or pin it explicitly
with `UPLOAD_SIGN_SECRET` (recommended on multi-instance hosts).

---

## Deploying to Vercel

The SPA is built by Vercel and served as static files; every `/api/*` request is rewritten to the
Express app exported from `api/index.js` (serverless function). Push to `main` → CI runs → the
**Deploy** workflow ships the validated commit.

**One-time setup:**

1. Create a project on Vercel for this repo. Framework preset **Vite**, build command
   `npm run build`, output directory **client/dist**.
2. Add the production environment variables in Vercel: `DATABASE_URL` (your Supabase
   **transaction-mode pooler** connection string on port **6543**), `PGPOOL_MAX=3` (serverless
   instances keep tiny pools), and the storage keys `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
   so photo uploads survive cold starts. (Realtime is off on Vercel, so no `REALTIME_DATABASE_URL`
   is needed there.)
3. Create a token: `vercel login && vercel tokens create`.
4. Get the IDs: `vercel whoami` (username), then `vercel project inspect <name>` — note the
   **org id** (`org.id`) and **project id** (`id`).
5. Add repo secrets so the workflow can deploy: `VERCEL_TOKEN`, `VERCEL_ORG_ID`,
   `VERCEL_PROJECT_ID`.

**Serverless caveats:** with the storage keys set, attachments live in Supabase Storage and are
streamed back through `/uploads/*` — nothing is written to the function's ephemeral disk. The
realtime SSE listener is disabled when `VERCEL` is set — Realtime runs on the Node/VPS host.

Photos uploaded before the keys were added remain in `server/uploads/`; the `/uploads/*` route
still serves them from disk.

---

## Layout

```
server/
  index.js            Express app, static serving, error handling, auto-seed
  db.js               schema + the reconciliation queries (reconcile, billRows, cashRollup)
  mutations.js        every write operation + its validation (shared by HTTP and sync)
  routes/             auth · field · admin · sync · exports
  import.js           tolerant spreadsheet → bills importer
  seed.js             deterministic demo ledger (mulberry32, seeded)
client/src/
  lib/                api · outbox (offline queue) · context (auth/toast/sync) · format
  components/         ui primitives · DenomGrid · StepRail · FieldLayout · AdminLayout
  pages/field/        StartDay · Bills · BillDetail · Collect · CancelBill · Shortage · Upload · Me · EndDay
  pages/admin/        Reconciliation · Salesmen · SalesmanDetail · Bills · Cancellations · Shortages · CashRollup · Upload
tools/
  smoke.mjs           jsdom smoke test: signs in, walks every screen, fails on React errors
  apitest.mjs         API regression: reconciliation identity, validation, replay, exports
  classcheck.mjs      proves every Tailwind class in the source exists in the built CSS
  mkbook.mjs          makes a sample dispatch workbook for trying the importer
```

### Tests

```bash
npm run verify        # build → class check → UI smoke (the one to run before shipping)
npm run smoke         # 25 UI checks: login, every admin screen, drill-down, field flow,
                      #   collect screen, three-tab nav, end-day screen
npm run apitest       # API regression: reconciliation identity, every validation rule,
                      #   offline replay idempotency, imports, exports, attachment
                      #   storage round-trip (needs the API running + DATABASE_URL)
npm run check:classes # every Tailwind class used in the source exists in the built CSS
```

`apitest.mjs` cleans up after itself — it deletes the bills and collections it creates so the
demo ledger stays intact across runs.

There is no browser in this environment, so `classcheck.mjs` exists to catch the failure you
otherwise cannot see: a mistyped responsive class (`md:table-cell`) compiles to nothing, and a
column you meant to hide on phones quietly stays visible.

---

## Design notes

- **Two accents, both meaningful.** Reconciled Green `#1E7F5C` = settled; Variance Rust
  `#B0472C` = needs attention. Neither is used decoratively. Both clear 4.5:1 on white.
- **Monospace, tabular numbers** for every invoice, UTR, cheque number and rupee figure —
  a mismatched digit is a real cost in this business, and aligned columns make it visible.
- **Buttons and confirmations share a verb.** "Mark cancelled" → "Cancelled". "Save
  collection" → "Collection saved". No "Submit", no "Process".
- **Errors say what happened and what to do.** `Cash counted (₹1,300) doesn't match the cash
  amount entered (₹28,710). Re-count the bundle below.`
- **Empty states invite action.** "No bills yet — upload today's batch to start."
- Accessibility: visible focus rings on everything, ARIA labels on icon buttons and steppers,
  `prefers-reduced-motion` honoured, tables and forms keyboard-navigable.

---

## Mobile

The field app is designed phone-first: single column, running total pinned to the top, one
action per screen, and a three-tab bar (Bills · Collect · Me) inside thumb reach with
safe-area padding for the home indicator. Cash entry steppers are 40 px tall.

The admin panel is desktop-first but has to survive being opened on a phone in the godown:

- The hero strip stacks and switches its dividers from vertical to horizontal.
- Wide tables drop their least-important columns instead of exploding — salesman-wise keeps
  Salesman / Expected / Collected / Variance, bills keeps Invoice / Shop / Amount / Balance /
  Status, and the rest appear from `md` and `xl` up. What's left scrolls sideways.
- The filter bar collapses to two rows: title plus export, then a scrollable row of range
  presets and dates.
- Segmented controls and the salesman filter go full width so they're thumb-sized.

Everything is specified at the smallest width first (`grid-cols-2 sm:grid-cols-4`,
`hidden md:table-cell`), so a 320 px screen is the baseline, not an afterthought.
