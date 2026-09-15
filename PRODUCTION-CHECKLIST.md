# Production checklist

Launch day is a checklist, not a memory test. Work top to bottom — every box
is verifiable, and the verification command is written next to it. Nothing on
this page is optional unless it says so.

---

## 1. Secrets & environment

Set in the hosting platform (Vercel → Settings → Environment Variables) —
never in the repo, never in a `.env` that ships.

- [ ] `DATABASE_URL` — Supabase **transaction-mode pooler** (port **6543**), not the direct host
- [ ] `PGPOOL_MAX=3` on Vercel (serverless instances keep tiny pools)
- [ ] `JWT_SECRET` — long random value (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`)
      · the server **refuses to start in production without it**; this is by design
- [ ] `UPLOAD_SIGN_SECRET` — another long random value; required in production for the same reason
- [ ] `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — attachments + backups must not fall back to disk
- [ ] `CORS_ORIGINS` — exact production origin(s), comma-separated
- [ ] `JWT_TTL_SECONDS` — default 7 days; shorten if phones are shared
- [ ] SMTP keys + `OFFICE_EMAIL` (only if day-end email is wanted)
- [ ] `UPI_VPA` + `UPI_PAYEE_NAME` (only if the Collect-screen QR should be live)

Verify:

```bash
curl -s https://<your-app>/api/health          # {"ok":true,…}
curl -sI https://<your-app>/uploads/nope.jpg   # 403 — unsigned access refused
```

---

## 2. Accounts & password rotation

Provisioned accounts are created with strong random passwords and a forced
rotation flag — first sign-in allows **nothing** except setting a new password.
The well-known dev passwords (`admin123` / `ops123` / `field123`) are public in
the README and must never exist in production.

- [ ] `npm run provision` (NO `PROVIDE_SEEDED_PASSWORDS=1`) — prints each
      account's password **once**; hand them out over a secure channel
- [ ] Confirm every seeded account is flagged: they should land on the
      "Set your own password" screen at first sign-in
- [ ] Confirm `admin123` / `ops123` / `field123` are rejected at login
- [ ] Set `PROVIDE_SEEDED_PASSWORDS=1` **nowhere** — not in Vercel, not in CI secrets
- [ ] Purge the README's dev-credential table from any copy shared with the field team? No —
      instead confirm it simply doesn't work on the prod DB (previous box)

Verify:

```bash
curl -s -X POST https://<your-app>/api/auth/login -H 'Content-Type: application/json' \
  -d '{"code":"admin","password":"admin123"}'   # expect 401
```

---

## 3. Database

- [ ] `npm run db:init` against the production DB — idempotent, brings schema + column upgrades current
- [ ] Row-level security helpers installed (`tools/setup-rls.js`) if connecting as a non-owner role
- [ ] Prod uses the **pooler URL** (6543); the realtime listener (VPS/Node host only) uses `REALTIME_DATABASE_URL` on 5432

---

## 4. Backups

The ledger is the system of record for cash. A backup that has never been
restored is a hope, not a plan.

- [ ] `.github/workflows/backup.yml` active — repo secrets `DATABASE_URL`,
      `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` present
- [ ] Trigger once manually: **Actions → backup → Run workflow**
- [ ] Confirm the zip landed: Supabase Storage → bucket → `backups/`
- [ ] **Restore drill (do it now, repeat monthly):**
      ```bash
      npm run restore -- <downloaded-backup.zip> --list    # row counts sane?
      ```
- [ ] Retention understood — newest `BACKUP_KEEP` (default 14) kept, older pruned
- [ ] A second copy exists somewhere else (download a zip monthly; Storage alone is one basket)

---

## 5. Smoke the deployed app

Walk the real product on the real URL — mobile **and** desktop:

- [ ] Admin sign-in lands on Reconciliation; Expected/Collected/Variance render with figures
- [ ] Salesman sign-in lands on Start day; four-step rail visible
- [ ] Upload today's dispatch sheet (Excel or PDF) — bills appear
- [ ] Collect a cash payment with the denomination grid; the admin's numbers move
- [ ] End day as the salesman; the office email arrives (if SMTP configured) or Share works
- [ ] **Airplane-mode test:** load the field app, go offline, open Bills — cached
      data renders; make an entry — it queues; go online — it syncs and a
      notification may appear ("background sync" is Chrome/Edge only; other
      browsers flush on next app open)
- [ ] Photo attachment uploads, and opens via its signed URL
- [ ] Export Excel + PDF on any admin screen
- [ ] Admin → Errors page loads (it should be quiet on day one)

---

## 6. Monitoring & knowing-when-it's-broken

- [ ] `/api/health` wired to an uptime checker (UptimeRobot, Better Stack, or a cron pinger) — 1-minute interval
- [ ] `/api/status` watched by the same checker with these alert rules —
      it reports DB latency, storage reachability, and backup age, so a
      "process up, database down" or "backups stopped" outage alerts too:

      | # | Alert | Trigger | Why this threshold |
      |---|---|---|---|
      | 1 | **Service degraded** | HTTP status `!= 200` (i.e. 503) | 503 means the **database or attachment storage is down** — the app may still render but the book can't be written. This is the page-the-admin alert. |
      | 2 | **Backups stopped** | body contains `"stale":true` (or `age_hours > 26`) | Backup runs daily; >26 h (schedule + 2 h grace) means the workflow silently died. A ledger without backups is one bad day from data loss. Keyword monitors can match the literal string `"stale":true`. |
      | 3 | **DB slow** | any `latency_ms > 2000` (rule of thumb: `checks.database`) | Healthy round-trips run well under 1 s even through the pooler (dev typically 150–700 ms). Above 2 s the field app feels broken even when it works — investigate before someone gives up and double-enters a collection. The DIY snippet below matches all three checks' latencies; storage/backup being slow is also worth knowing. |

      Setup per checker (1-minute interval, alert after 2 consecutive failures to ignore the 30 s status cache refreshing mid-check):

      - **UptimeRobot** — Monitor 1: HTTP(s) on `/api/status`, alert on non-200. Monitor 2: **Keyword monitor** on `/api/status`, alert when the page **contains** `"stale":true`. Latency: watch the response-time graph; its alerting is threshold-on-average, so keep rule 3 in the body-based checker if you need it strict.
      - **Better Stack / Checkly** — one API check on `/api/status`, **assert** `status = 200` **and** extract `checks.backup.stale` / `checks.database.latency_ms` from the JSON body (Browser/check scripts can assert body fields directly) — all three rules in one check.
      - **Cron pinger (DIY)** — the same three rules in five lines:
        ```bash
        s=$(curl -s https://<your-app>/api/status)
        echo "$s" | grep -q '"ok":true'            || alert "status: degraded"
        echo "$s" | grep -q '"stale":true'         && alert "backup stale"
        echo "$s" | grep -o '"latency_ms":[0-9]*' | \
              awk -F: '$2 > 2000 {print "db slow"}' | grep -q . && alert "db latency >2s"
        ```

      Do **not** alert on `checks.backup.ok` alone — it's `false` only when *no backup exists at all*; rule 2 is the one that catches a stopped schedule. During a sustained outage the endpoint may replay a cached failure for up to ~90 s (by design, see `server/status.js`); the 2-failure requirement absorbs that too.
- [ ] **Errors page** (`/admin/errors`) reviewed at least daily for the first fortnight;
      client crashes and server faults land there automatically
- [ ] Error sink tested: submit a fake report and see it on the page
      ```bash
      curl -s -X POST https://<your-app>/api/errors -H 'Content-Type: application/json' \
        -d '{"kind":"probe","message":"sink check"}'    # 204
      ```
- [ ] Supabase dashboard alerts on CPU/disk (their defaults are fine)
- [ ] Vercel: enable deployment + function error notifications
- [ ] Day-end email missing = salesman didn't end his day (or SMTP broke) — treat a missing
      report as a signal, not silence as success

---

## 7. Hardening (recommended, not launch-blocking)

- [ ] Rotate `JWT_SECRET` and `UPLOAD_SIGN_SECRET` quarterly — signing out every device is the trade-off
- [ ] Review the Errors page after each release; a new kind appearing repeatedly is a bug finding you
- [ ] Keep `npm run verify` in CI (it is) and never deploy a red build
- [ ] Test the backup restore drill **monthly** — calendar entry, not intention
- [ ] When the team grows: admin accounts are provisioned by editing `tools/provision-accounts.mjs`,
      never by sharing logins

---

## The one-minute version

```bash
# every box above, compressed:
curl -s https://<app>/api/health                       # alive
curl -s https://<app>/api/status | grep -o '"ok":false' # broken parts, if any
curl -s -X POST https://<app>/api/auth/login ...       # seeds rejected
gh workflow run backup && open Supabase → backups/     # backup exists
npm run restore -- <zip> --list                        # restore plausible
```

Ship.
