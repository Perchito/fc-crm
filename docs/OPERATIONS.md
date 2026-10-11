# FC Cleaning CRM — operations guide

Live: https://crm.perchito.app (sign-in required) · booking page: https://book.fccleaningcompany.com (public)
Server: perchito, `~/fc-crm`, systemd unit `fc-crm` (port 4600, Cloudflare tunnel). Not Docker — it never was;
DocuSeal is the only Docker piece (`~/docuseal`).

## What's where

| Area | Code |
|---|---|
| HTTP server, public routes, booking, calendar, campaigns | `server.mjs`, `lib/booking.mjs`, `lib/engine.mjs` |
| Sign-in, roles, CSRF, rate limits, audit log | `lib/auth.mjs` |
| Customers, people, sites, duplicates, CSV, pipeline data | `lib/customers.mjs` |
| Tasks, appointments | `lib/tasks.mjs` |
| Pricing engine (integer pence, BigInt) | `lib/pricing.mjs` |
| Proposal builder (drafts, versions, send, accept…) | `lib/proposals.mjs` |
| Contracts (lifecycle, versions, checks) | `lib/contracts.mjs` |
| PDF rendering (proposal + agreement) | `lib/pdf.mjs` |
| DocuSeal (send, webhooks, status sync) | `lib/docuseal.mjs` |
| Private documents + storage | `lib/documents.mjs`, `lib/storage.mjs` |
| Automations + renewal/expiry scanner | `lib/automation.mjs` |
| Reports | `lib/reports.mjs` |
| Library (services, clauses, company) | `lib/library.mjs` |
| UI | `public/index.html`, `public/style.css`, `public/app.js` (pipeline, drafts, campaigns, calendar), `public/biz.js` (everything else) |
| Schema | `db/schema.sql` (original, idempotent) + `db/migrations/*.sql` via `db/migrate.mjs` |

## Roles

- **Staff** — customers, people, sites, tasks, visits, notes, draft proposals, proposal PDFs, uploads to customers.
- **Manager** — plus issue/send/accept/reject/revise proposals, all contract work, DocuSeal, contract and signed documents, CSV import/export, report export, service/clause library.
- **Administrator** — plus users, company details, automations, audit log, permanent customer deletion.

The last administrator can't remove their own admin access. A permanent delete is refused for any customer with proposals, contracts or documents; "Delete" in the UI archives.

## Environment (`~/fc-crm/.env`, mode 600, never committed)

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `PORT` | Postgres `fc_crm`, 4600 |
| `ICLOUD_SMTP_USER`, `ICLOUD_SMTP_PASS`, `ICLOUD_FROM_ADDRESS` | sending (fernando.c@fccleaningcompany.com) |
| `DOCUSEAL_URL` | `https://sign.fccleaningcompany.com` |
| `DOCUSEAL_API_KEY` | DocuSeal API token (DocuSeal → Settings → API) |
| `DOCUSEAL_WEBHOOK_SECRET` | the webhook's HMAC secret (`whsec_…`, DocuSeal → Settings → Webhooks) |
| `DOCUSEAL_COMPOSE_DIR` | `/home/perchito/docuseal` (for the template upload step) |
| `DOCUSEAL_SEND_EMAIL` | optional; `false` = DocuSeal sends no invitation emails (staging/tests only) |
| `DOCUSEAL_UPLOAD` | optional; `api` = use `POST /api/templates/pdf` (DocuSeal Pro/cloud) instead of the runner |
| `HOME_STORAGE_URL`, `HOME_STORAGE_PROJECT`, `HOME_STORAGE_KEY` | private document storage (perchito-storage project `fc-crm`) |
| `DOCS_DIR` | optional; local folder instead of perchito-storage (tests) |
| `PUBLIC_URL`, `BOOK_URL`, `ENGINE_TICK_MS` | optional, defaults are right |

Backup of the pre-change `.env`: `~/fc-crm/.env.bak-2026-10-11-business-os`.

## Deploy

```sh
# from a checkout of the branch on the Mac
rsync -a --exclude node_modules --exclude .git --exclude '.env*' ./ perchito:fc-crm/
ssh perchito 'cd ~/fc-crm && npm ci --omit=dev && set -a && . ./.env && set +a \
  && node db/migrate.mjs && sudo -n systemctl restart fc-crm'
curl -s https://crm.perchito.app/healthz      # {"ok":true}
```

Always back up first (below). Migrations run **before** the restart; they only ever add.
`node db/migrate.mjs --status` lists applied/pending migrations.

Create a login: `node scripts/create-user.mjs <email> "<name>" admin|manager|staff` (prints a one-time password;
refuses existing users — reset passwords in Settings → Users).

## Backups and restore

- **Nightly** (`fc-outreach-backup.timer`, 07:15): pg_dump of `fc_crm` and every project DB, DocuSeal `/data`, config tarball;
  copied offsite to Backblaze B2. Documents live in perchito-storage project `fc-crm`, which the same job syncs to B2 (`files/`).
- **Before a deploy:**
  ```sh
  d=~/backups/fc-crm-predeploy-$(date +%Y%m%d-%H%M%S); mkdir -m 700 $d
  pg_dump --no-owner "$DATABASE_URL" | gzip > $d/fc_crm.sql.gz
  tar czf $d/fc-crm-app.tgz --exclude node_modules -C ~ fc-crm
  ```
- **Restore test (done 2026-10-11):** the pre-deploy dump was restored into the empty test database `p_fc_crm_test`;
  contacts 185 / events 896 / sends 309 / tasks 2 / appointments 6 matched production. The copy was then deleted.
- **Restore for real:** stop the service, `dropdb`/`createdb fc_crm` (needs `PG_ADMIN_URL` from `/etc/perchito/perchito.env`),
  `zcat fc_crm.sql.gz | psql "$DATABASE_URL"`, start the service. Documents are restored from B2 `files/` into
  `/srv/fc-outreach/storage/projects/fc-crm` if storage itself was lost.

## Rollback

1. `sudo -n systemctl stop fc-crm`
2. Code: `tar xzf ~/backups/fc-crm-predeploy-*/fc-crm-app.tgz -C ~` (or rsync an older commit).
3. Database: the old code ignores the new tables/columns, so a code-only rollback works without touching the DB.
   Only if the schema itself must go, restore the pre-deploy dump (this loses anything entered since).
   Per-migration rollback SQL is at the bottom of each file in `db/migrations/`.
4. `.env`: `cp ~/fc-crm/.env.bak-2026-10-11-business-os ~/fc-crm/.env` (removes DocuSeal/storage settings).
5. `sudo -n systemctl start fc-crm`.

## DocuSeal (self-hosted 3.3.0)

- The open-source API can't create a template from a PDF (`POST /api/templates/pdf` is Pro-only). Step 1 of sending
  therefore runs DocuSeal's own `Templates::CreateAttachments` inside its container with `rails runner` (the same code its
  upload page uses), passing the PDF inline. Every other step is the official API: field placement
  (`PUT /api/templates/:id`), the request (`POST /api/submissions`, signer order FC → customer by default),
  status (`GET /api/submissions/:id`), reminders (`PUT /api/submitters/:id`), cancel (`DELETE /api/submissions/:id`).
- Signature/date/name fields go exactly where the PDF renderer drew the lines (positions recorded at render time).
- Webhook: `https://crm.perchito.app/api/webhooks/docuseal`, events form.* and submission.*. Verified like DocuSeal's
  `WebhookUrls::Signatures.verify`: header `X-Docuseal-Signature: <ts>.<hex HMAC-SHA256(secret, "<ts>.<raw body>")>`,
  5-minute tolerance, constant-time compare. Each delivery is de-duplicated (`webhook_events`), and the status is always
  re-read from the DocuSeal API before anything changes. A 30-minute reconcile job catches missed webhooks.
- Completed: the signed PDF and the audit trail are downloaded into private storage and linked to the contract and its version.
- **After a DocuSeal upgrade** (`docker compose pull`): run `scripts/docuseal-live-test.mjs` against a test schema before
  sending a real contract (it depends on DocuSeal internals for the upload step), and re-check the branding patches.
- Live test (2026-10-11): real submission through sign.fccleaningcompany.com with no emails sent, both parties completed via
  the API, CRM went sent → partially signed → signed, signed PDF + audit trail stored, unauthenticated download refused (401),
  test submission and template archived. Real webhook deliveries to production verified (HMAC accepted).

## Tests

On perchito (needs the test DB `p_fc_crm_test`; the suite creates and drops its own schema):

```sh
cd ~/fc-crm-t     # rsync of the repo
export TEST_DATABASE_URL=$(grep ^DATABASE_URL ~/fc-crm/.env | cut -d= -f2- | sed 's#/fc_crm$#/p_fc_crm_test#')
npm test          # module self-checks + 14 end-to-end tests (real Postgres, mock DocuSeal)
```

## Automations (Settings → Automations)

Internal tasks only — no customer emails: new lead → follow-up, visit booked → prep task, proposal sent → follow-up,
accepted → "create contract", sent for signature → chase, signed → "check and activate" (or auto-activate, off by default),
active → 6-step onboarding checklist + 5 weekly quality follow-ups, renewal due (60 days before) → status + task,
proposal past valid-until → expired + review task, contract past end date → expired. Each task has a unique key, so
re-running never duplicates. AI-discovered leads don't get a new-lead task (they arrive 20 a day).
