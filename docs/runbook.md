# Deskzo One — operations and recovery runbook

For whoever runs the platform: what runs where, what to back up, how to release, and what to do when something breaks. Kept with the code so it changes with it.

## 1. What runs

| Part | What it is | How it runs |
|---|---|---|
| App server | `npm run build` then `npm start` — every workspace, the public site (`www.`), the staff console (`admin.`) and the website's CMS (`cms.`) | Behind a reverse proxy doing TLS, with `TRUST_PROXY=1`; `NODE_ENV=production` |
| Partner portal | `partners.<domain>` — resellers' and distributors' own portal (§12), with its own accounts; served by the same app server, from `src/app/platform-partners` | Nothing more to run: `partners.<domain>` in DNS and the proxy's certificate (§8) |
| Platform worker | `npm run platform:worker` — sets new workspaces up, keeps the warm pool full, runs Automate's workflows (§13) | Long-lived: on Coolify inside the app's container (`DESKZO_WORKER=in-app`, deploy/start.mjs, restarted when it stops); under Compose its own service; elsewhere pm2 or systemd |
| Schedulers | Plain HTTPS calls with a bearer secret | cron / systemd timers (below) |
| PostgreSQL 16 | One database per workspace, plus the control plane and the reference database | With continuous archiving (point-in-time recovery) |
| PgBouncer | Pools the app's connections to workspace databases | Transaction mode (§7) |

On Coolify ([deploy-coolify.md](deploy-coolify.md)) the app is one container behind Coolify's Traefik, and the worker and the three calls below are Coolify Scheduled Tasks (`node deploy/scheduler.mjs once <name>`). With Docker Compose ([deploy-azure.md](deploy-azure.md)) each is a service in `deploy/azure/`, with Caddy as the reverse proxy. PgBouncer is not set up in either yet.

### Scheduled calls

| Every | Call | Secret |
|---|---|---|
| 5 minutes | `GET https://admin.<domain>/api/marketing/tick` — campaigns, lead scores, sales wins, for every workspace | `MARKETING_TICK_SECRET` |
| 15 minutes | `GET https://admin.<domain>/api/backup/tick` — each workspace's scheduled backups | `BACKUP_TICK_SECRET` |
| hour | `GET https://admin.<domain>/api/platform/tick` — trials, grace periods, billing holds, reminders; once a day the gateways read back and each workspace's use recorded | `PLATFORM_TICK_SECRET` |

Each with `Authorization: Bearer <secret>`. Unset, an endpoint refuses everything. A non-200 answer means some workspace failed — the body says which.

The hourly platform tick also does the partner programme's chores (§12), under a lease of their own, `partner-commissions` (twenty minutes), so two schedulers calling at once never do them twice: every hour it works out commission on invoices newly paid, refunded or credited; once a day it expires lapsed deal registrations and, from `partners.statementDay` (the 5th, India time) to the month's end, drafts last month's statements. Its answer includes `partners: { accrued, reversed, statements, expiredDeals, failed }`. A partner chore that fails is counted there and logged — it never fails the tick or the billing chores.

## 2. Configuration

Set in the server's environment (pm2 ecosystem file or systemd unit), never in the repository.

| Setting | Required | What |
|---|---|---|
| `DATABASE_URL` | yes | The installation's first workspace's database, and the server the provisioner uses in development |
| `CONTROL_DATABASE_URL` | yes | The control plane: workspaces, plans, billing, staff |
| `REFERENCE_DATABASE_URL` | yes | Shared reference data (PIN codes, world places) |
| `PLATFORM_MASTER_KEY` | yes — **back it up (§4)** | Seals every workspace's database address and key bundle, and the platform's secrets |
| `AUTH_SECRET` | yes | Kept for the first workspace's older sessions and links |
| `PLATFORM_DOMAIN`, `PLATFORM_PORT` | yes / no | Workspaces are `<slug>.<domain>`; `admin.` is the console, `www.` the public site, `cms.` the website's CMS (§10) |
| `TRUST_PROXY` | yes, `1` behind the proxy | Believe the proxy's forwarded host and address — and nothing else's. Without it no caller's address is known: IP rules match nobody, lockouts are per account only, and the activity log records no address |
| `TRUST_PROXY_HOPS` | with a chain of proxies (1) | How many proxies of ours append to X-Forwarded-For — 2 for a CDN in front of nginx; the caller is that many entries from the end |
| `PLATFORM_PROVISIONER_URL` | yes | A role with CREATEDB and CREATEROLE, on the maintenance database |
| `PLATFORM_WARM_POOL` | no (2) | Databases made ahead of signups |
| `PLATFORM_SMTP_URL`, `PLATFORM_MAIL_FROM` | no | The fallback for the platform's own mail while the console's Settings › Mail has no default account; with neither, mail is written to `platform-outbox/` |
| `PLATFORM_SALES_EMAIL` | yes, before launch | Where the public website's contact form is mailed (through `PLATFORM_SMTP_URL`; the visitor's address leads the message, as the mailer sets no reply-to). Unset, a contact request is **not mailed anywhere**: the visitor is still thanked and the server logs `[site] a contact request arrived, but PLATFORM_SALES_EMAIL is not set`. Every request is also kept in the CMS's leads inbox (§10), mailed or not. The address the site *shows* is separate — the CMS's site settings |
| `PLATFORM_CONSOLE_IP_ALLOWLIST` | recommended | CIDRs allowed to reach the console (needs `TRUST_PROXY=1`) |
| `MARKETING_TICK_SECRET`, `BACKUP_TICK_SECRET`, `PLATFORM_TICK_SECRET` | yes | §1 |
| `TENANCY_POOLER_URL` | yes with PgBouncer | e.g. `postgresql://127.0.0.1:6432` — the app's workspace queries go there |
| `TENANCY_MAX_CLIENTS` (35), `TENANCY_CONNECTION_LIMIT` (2), `TENANCY_IDLE_CONNECTION_S` (30) | tune | Workspace pools kept per process, connections each, and how long an unused connection stays open (§7) |
| `TENANCY_STATEMENT_TIMEOUT_MS` (30000), `TENANCY_LOCK_TIMEOUT_MS` (10000), `TENANCY_IDLE_IN_TRANSACTION_MS` (60000), `TENANCY_ROLE_CONNECTION_LIMIT` (20) | tune | Each workspace role's limits; after changing, `npm run platform:tenant -- limits` |
| `BACKUP_DIR` | no (`backups/`) | Where workspace backups are written; each workspace under `workspaces/<id>/` |
| `BACKUP_LOCAL_KEEP` | no (1) | While backups go off-site (a store set in the console, or the storage box, §4.2): how many of each workspace's newest backups — and of the control plane's dumps — stay on this server. Older ones are removed here once the store has them; their rows stay in Settings › Backups, and Download and Restore fetch them back (§4.1). A large number keeps the old behaviour. Without a store it does nothing |
| `SUPPORT_DIR` | no (`storage/support` in the app's folder) | Contact Support's attachments and screen recordings (§11) — **back it up** (§4). Every app process must see the same folder: a file is uploaded to one and claimed when the request is sent, perhaps by another |
| `LOG_DIR` | no (`logs/`; `/data/logs` in the image) | The web access log, a file a day per web process (§14). On the persistent volume with `BACKUP_DIR`: the platform worker archives it from there, so it must see the same folder |
| `ACCESS_LOG` | no | `on` or `off`; unset, on in production only (§14.1) |
| `LOG_LOCAL_KEEP_DAYS` | no (1) | While logs are archived off-site (a store set in the console, or the storage box): days of the access log kept on this server, counting today — 1 keeps only today's, the file being written; a finished day goes as soon as every file of it is archived (§14.1). Without a store it does nothing |
| `RECORDINGS_AZURE_CONTAINER_URL` + `RECORDINGS_AZURE_SAS`, or `RECORDINGS_DIR` | no | Where call recordings go (`src/lib/calls/recordings.ts`). With none set, the storage box (§4.2), each workspace's `workspaces/<id>/recordings/`; a server that already has one of these keeps it, so the recordings kept there are still found |
| `PDF_BROWSER_PATH`, `PDF_BROWSER_NO_SANDBOX` | for PDFs | A Chromium for printing documents |

The gateways' keys (Stripe, Razorpay) are **not** environment settings: an owner enters them in the console, under Billing, where they are sealed and never shown back.

**The gateways' webhooks.** Set each at the gateway's dashboard, to the address console → Billing → Gateway connections shows:

- **Stripe:** the events `checkout.session.completed`, `customer.subscription.*`, `invoice.*`, **`charge.refunded`** and **`credit_note.*`**, and the endpoint **pinned to API version `2024-06-20`** — the version the platform's own requests use. Webhooks arrive in the endpoint's version, not the requests': from `2025-03-31.basil` on, Stripe moved an invoice's subscription and a line's price elsewhere and dropped a charge's invoice, so on a newer version invoices come in with no subscription or plan lines (commission falls back to the subscription's plan) and refunds find no invoice at all.
- **Razorpay:** the events `subscription.*`, **`payment.refunded`** and **`refund.processed`**.

Without the refund and credit-note events, money that goes back to a customer is never taken back out of its partner's commission (§12).

**The partner programme's settings** (§12) are platform settings too, not environment settings: an owner changes them in the console → Partners → Programme settings, each change audited as `partner.settings` (`npm run partners -- two-factor` pins the first from the server).

| Setting | Unset | What |
|---|---|---|
| `partners.twoFactor` | required in production, optional elsewhere | The portal's two-factor policy |
| `partners.statementDay` | 5 (1–28) | The day of the month, India time, from which the tick drafts last month's statements |
| `partners.dealDays` | 90 (30–365) | How long an approved deal registration protects the company for its partner |
| `partners.refCookieDays` | 0 — off (0–90) | The referral cookie's lifetime in days. **Leave it off** until the public site has a consent mechanism (§12) |
| `partners.applications` | 1 — open | The public "Become a partner" form at `/partners` (and its sitemap entry). Applications are mailed to `PLATFORM_SALES_EMAIL` and kept in the console either way |
| `partners.directory` | 0 — off | The public partner directory at `/partners/find` |
| `partners.clawbackMonths` | 12 (1–60) | A refund more than this many months after a commission was paid out is not clawed back |
| `partners.twoPersonPayout` | 0 — off | On: whoever approved a statement cannot also mark it paid |

## 3. Releasing

1. **Migrations first, code second.** Migrations are written expand-then-contract, so the running code keeps working on the new schema.
2. `npm run tenants:migrate` — the control plane, the reference database, the warm pool, then the first workspace (the canary), then the rest eight at a time. It stops for the rest if the canary fails.
3. A workspace whose migration fails is held at MIGRATING — its users see the maintenance page, its data is untouched. Console → Migrations shows why; fix, then **Retry** there.
4. Deploy the build; restart the app and the worker.
5. `npm run check:tenancy`, `check:module-guards` and the suites for what changed run before every release; `npm run pentest` before any release touching sign-in, tenancy or billing (§9).

Migrations lift a workspace role's time limits while they run and put them back after — a long backfill is not cut off at thirty seconds.

## 4. What to back up

| What | Why | How |
|---|---|---|
| `PLATFORM_MASTER_KEY` | Without it no workspace's database address or keys can be opened — every workspace, and every backup of one, is unreadable. | Offline, in two places (a password manager with a break-glass entry and a sealed paper copy). Never with the database backups. The break-glass entry also holds the off-site store's address and a credential that can read it (§4.1). |
| The control plane | Holds every workspace's sealed address and key bundle, plans, subscriptions, staff. Losing it loses the keys to every workspace's backups. | Point-in-time recovery with the cluster, **and** dumped every night by the platform worker (after 01:00, console time): sealed, the newest week in `BACKUP_DIR/platform/control/` (with a store in use, only the newest `BACKUP_LOCAL_KEEP` once the older ones are there), and off-site as long as the backups (§4.1). |
| Workspace databases | The customers' data. | Cluster point-in-time recovery (base backup + WAL archive), plus each workspace's own scheduled backups in `BACKUP_DIR` (sealed, per workspace), copied off the server (§4.1). |
| `BACKUP_DIR` | The per-workspace archives a customer or staff restore from. Encrypted on disk under a key derived from `PLATFORM_MASTER_KEY` for each workspace, so a copy is unreadable without that key — keep the two apart. Backups from before this release are encrypted by running `npm run db:backup -- --seal-existing --all-workspaces` once; until then they restore as they always did, and go off-site encrypted anyway. | Copied off-site every hour by the platform worker, still encrypted; kept there 35 days, the newest three of each workspace whatever their age. Once a backup is there, its copy here goes at the workspace's next backup, keeping the newest `BACKUP_LOCAL_KEEP` (1) (§4.1). |
| `SUPPORT_DIR` | Support requests' attachments and screen recordings. The requests themselves are in the control plane; their files are only here — or, with a storage box (§4.2), those sent since it was set up are in the box instead. | Mirrored off-site with `BACKUP_DIR`, encrypted under each workspace's key — and deleted there when the support retention deletes them here. |
| `LOG_DIR` | The web access log CERT-In asks for (§14). | Archived off-site every night, sealed; kept a year (180 days at least). Removed here as soon as a day is archived — only today's stays (`LOG_LOCAL_KEEP_DAYS`, §14.1). |
| The reference database | Shared PIN and place data. | Re-loadable from source (`db:reference`, `db:geonames`); a dump is quicker. |

A restore drill runs every week by itself (§4.1). Still rehearse §5.2 and §5.10 once a quarter on a spare server, and write down how long each took.

### 4.1 Off-site storage

Set up in the console under **Settings › Backups & logs** (owners). Without one, the server's storage box (§4.2) is used in its place — everything below goes under `offsite/` in its container, with nothing to set up here, and the page says so; a store set in the console still wins. With neither, nothing leaves the server, and the console says so in red in production.

**Where.** One of:

- **Azure Blob Storage** — a container in a storage account in Central India or South India, with a SAS token on the container: read, add, create, write, delete, list; a year's expiry or more, with a reminder to renew it.
- **S3-compatible** — AWS S3 in `ap-south-1` (Mumbai), or Cloudflare R2, Wasabi, MinIO…: an access key for that one bucket, allowed to put, get, list and delete. Tick "address the bucket in the path" for MinIO.
- **A folder** — a disk mounted from elsewhere (an Azure Files share, NFS). Never one on the same disk: the console refuses a folder inside `BACKUP_DIR` or `LOG_DIR`.

Keep it in India: CERT-In requires the logs (§14) to stay in the country. Use **Check connection** before saving — it writes, reads, lists and deletes a small object and says which of the four failed.

**Protect it from deletion** with the store's own controls, so a stolen key or a ransomware run on the server can't empty it: Azure blob soft delete (14 days) and versioning, or an immutability policy; S3 versioning, or Object Lock in governance mode. A delete the store refuses is reported as "kept by the store's own retention", not as a failure — the old backup simply stays until the store lets it go.

**What runs** — in the platform worker, beside its other work (never with `--once`, which signups start):

| Every | What |
|---|---|
| hour | Each workspace's new backups (pieces first, then the manifest naming them) and support files sent; once a day per workspace, backups past the days set removed there and the pieces nothing names any more; once a week, what this server thinks is there checked against a listing of the store, and anything missing sent again; once a day, a closed workspace's backups removed. |
| night, after 01:00 | The control plane dumped (`deskzo-control-<UTC time>.dump`), sealed, sent. Logs archived (§14). Tried again two hours after a failure. |
| week, 03:00–07:00 | **The restore drill:** the newest backup of the workspace drilled longest ago, and the control plane's newest dump, fetched back from the store, checked against their checksums, restored into scratch databases made like a workspace's, read (the backup's own migration, people in it; workspaces in the control plane) and dropped. Timed; the result is on the page. |
| day | This server's clock against NPL's and NIC's (§14.2). |

Each runs under a lease, so two workers never run the same one. **Run now** on the page asks the worker, which starts it within a minute. From the server: `npm run offsite -- status | check | run <sync|control|logs|drill|clock> [--workspace <slug>] | list <prefix> | fetch <key> <out> | recover <slug>`.

**In the store**, under the folder set (`deskzo/` by default):

```
backups/workspaces/<id>/chunks/ab/<hash>.gz       a piece of a chunked backup
backups/workspaces/<id>/manifests/<backup>.json   its list of pieces
backups/workspaces/<id>/dumps/<file>.dump(.json)  a full backup and its sidecar
backups/control/deskzo-control-<UTC>.dump         the control plane
support/<id>/<request>/<attachment>               a support file
logs/<UTC day>/access/<host>-<pid>.jsonl.gz       the access log (§14)
logs/<UTC day>/workspaces/<id>.jsonl.gz           a workspace's security logs that day
logs/<UTC day>/platform.jsonl.gz                  the console's, the CMS's and the partner portal's
```

Everything is sealed before it leaves (AES-256-GCM, keys derived from `PLATFORM_MASTER_KEY`), so the store only ever holds ciphertext; `npm run offsite -- fetch` opens any of it. Changing the store, the bucket or the folder starts again from nothing in the new one; the old one is left as it was.

**The copies left on the server.** With a store in use, each workspace's backup run ends by removing the copies here of its older backups that are off-site, keeping the newest `BACKUP_LOCAL_KEEP` (1 unless set): a dump with its sidecar, or a chunked backup's manifest — and then the pieces no remaining manifest names, never one a kept manifest still needs. A backup goes only when the sync's own record says it was sent to *this* store and the store, listed then, has it; never one not sent yet, a safety copy inside its 30 days, or anything while a restore runs. A failed upload leaves everything. Its row stays in Settings › Backups marked "kept off-site": **Download** and **Restore** fetch it back from the store first (checked against its checksum, as a drill does), or say why they couldn't. The control plane's older dumps go the same way once the store lists them. Without a store nothing is removed for being off-site; `BACKUP_KEEP_DAYS` (14) still applies either way.

**Alerts:** not set up (production); nothing copied for 3 hours (the worker stopped); copying failing; no control plane dump for a day; the log archive two nights behind; a drill failed; no drill working for two weeks; the clock more than a second out.

**Break glass.** The store's address is saved in the control plane — the thing that may be lost. Keep it in the break-glass entry with `PLATFORM_MASTER_KEY`, with a credential that can read and list (a second SAS token or key, read-only), for §5.3 and §5.10.

**Checks:** `npm run check:offsite` — fake S3 (each signature checked with AWS's own signer) and Azure servers, a folder, a scratch control plane, a real backup restored, recovery, the logs, the console.

### 4.2 Storage box

Every file the workspaces keep — employee and project documents, attachments, receipts, photos, ID-card pictures, the documents a migration brings, support requests' attachments and recordings — goes to **one private Azure Blob container**, not the server's disk and not the databases (`src/lib/storage/box.ts`). Until a box is set up, nothing changes: files stay in each workspace's database and on this server, exactly as before.

**Set it on the server** (the app's environment, never the repository; the console only shows it, under **Settings › Backups & logs**):

| Variable | |
|---|---|
| `STORAGE_AZURE_CONNECTION_STRING` | The storage account's connection string (Azure portal › Storage account › Access keys). Its key never leaves the server: each request carries a container SAS signed with it for the hour. |
| `STORAGE_AZURE_CONTAINER` | The container; `deskzo` when unset. |
| `STORAGE_AZURE_CONTAINER_URL` + `STORAGE_AZURE_SAS` | Instead of the two above: `https://<account>.blob.core.windows.net/<container>` and a SAS token on it with read, add, create, write, delete and list. Renew it before it expires — files can't be saved or read after. |
| `STORAGE_DIR` | A folder instead of Azure — for trying a server out, and the check suites. Not for production. |
| `STORAGE_PREFIX` | A folder inside the container for this installation (empty when unset). Tidiness only, **not isolation**: the connection string or SAS opens the whole container whatever the prefix, so a staging server sharing production's container can read and delete production's files. Give every environment (production, staging, a developer's machine) its own container — better, its own storage account — and its own `PLATFORM_MASTER_KEY` (security audit round three, 14 Nov 2026). |

**Creating the container.** A storage account in Central India or South India; a container with **public access level: Private (no anonymous access)** — the app never hands out a link to it; every file is fetched by the server and is sealed anyway. Then, on the storage account, **turn on blob soft delete (at least as many days as backups are kept, 35 by default) and blob versioning**. This matters more than it did: a workspace's database backup no longer holds its files, only references to them, so a file deleted or overwritten in the container can't be brought back from a database backup — only from the container's own soft delete and versions. The off-site copies of backups (§4.1) can go to the same container if the console sets no store of its own; they sit under `offsite/` there.

**`PLATFORM_MASTER_KEY` must never change** once files are in the box: each file is sealed under a key derived from it and the workspace's id (AES-256-GCM, as the backups are), and a different key opens none of them. It is in the break-glass entry already (§4); the connection string belongs there too.

**In the container**, under `STORAGE_PREFIX`:

```
workspaces/<id>/files/<kind>/<yyyy-mm>/<file>      a workspace's documents, attachments and photos
workspaces/<id>/recordings/…                       call recordings
support/<id>/<request>/<attachment>                support requests' attachments and screen recordings
offsite/…                                          backups and archived logs, when §4.1 sets no store of its own
```

Every file in `workspaces/<id>/` is sealed under that workspace's key — call recordings too, from 14 Nov 2026 (ones sent before stay unsealed and still play). When a closed workspace is purged after its 90 days, its `workspaces/<id>/` and `support/<id>/` folders are deleted with its backups (security audit round three, R3-24); the container's soft delete still holds them for its own days.

**From the server** — `npm run storage -- …`:

1. `check` — writes, reads, lists and deletes a small object in the box, and says which of the four failed. Run it after setting the variables and restarting the app.
2. `status [--workspace <slug>]` — the box, and for each workspace how many files are in the box and how many (and how many MB) are still in its database.
3. `move [--workspace <slug>] [--only <Model>] [--limit <n>]` — **a dry run first**: it only counts what would move. Then `move --apply --workspace <slug>`, one workspace at a time, smallest first; each file is copied into the box, and its row then points at the copy — unless the row changed meanwhile, which is left for the next run. Safe to stop and run again — what moved is skipped. New files go to the box as soon as it is set up; `move` is only for the ones from before. Take a backup of the workspace first, and run `status` after.
4. `sweep [--workspace <slug>]` — see below.

Support requests' files sent before the box stay in `SUPPORT_DIR` and keep working; new ones go to the box, and retention deletes them there. The hourly off-site mirror (§4.1) copies only the ones still on disk.

**The sweep.** Deleting a record never deletes its file from the box — a workspace restored from last month's backup points at files that must still be there. Once a day the platform tick (`/api/platform/tick`, the daily run) goes through every active workspace and deletes the files no row has pointed at for longer than backups are kept: 45 days, or the backup days plus ten if that is longer. A workspace that fails is named in the tick's `daily.failed` and the others carry on. Without the platform tick (a single-workspace server), run `npm run storage -- sweep` from cron once a day.

**Checks:** `npm run check:storage-box` (the box, sealing, the move and the sweep), `npm run check:storage-support` (support files in the box, the sweep in the tick, exports with files in the box).

### 4.3 Backup & Restore bundles

One file (`.dzbk`) that carries everything needed to bring the whole installation — or one workspace — up on another server: built here, **downloaded**, later **uploaded** to the server it is restored on. Bundles are never kept in a store (owner, 26 Nov 2026): the server builds one in `BACKUP_DIR/platform/bundles/` (written as `<name>.part` and renamed once whole), offers it for download, and gives it a day to be fetched (`expiresAt` on its record): after that its file is removed and the record marked expired — by the platform tick's daily run, and whenever the console's Backups page is opened. Each one built is recorded in the control plane (`platform_backups`: status, size, the file's SHA-256, its header). The format and the builder are `src/lib/bundle/` (`format.ts`, `build.ts`, `control-rows.ts`).

**Two kinds.**

- **Full** — the control plane (staff, plans, settings, billing, CMS with its media, partners, mail accounts…: its whole `pg_dump`), and every workspace that isn't closed — suspended ones and ones still being set up too — each with everything below. Plus `platform/inventory.json`: which settings this server had, **by name only**, and what was left out. Restorable on a fresh install.
- **Workspace** — one workspace: its database (`pg_dump`, custom format), its control-plane rows (`control.json` — its row, domains, subscriptions with their plans, invoices, credit notes, offline payments, usage, AI credits and usage, notes, support requests and their attachments, its partner, gateway webhooks, the automation steps already taken outside; never its sealed database address, staff's audit log, sign-in tickets, leases, support access grants, linked sign-in links or the partner's commission ledger), and its files: everything under `workspaces/<id>/` in the storage box (documents, attachments, photos, call recordings — copied as the box holds them, sealed), its support attachments (`support/<id>/` in the box, and those still in `SUPPORT_DIR/<id>/` on disk, never `staging/`), and its recordings when they are kept in a separate `RECORDINGS_*` store. Restorable into this server or, as that workspace, on another.

**What is never in a bundle, and must be given to the server it is restored on:**

| Left out | Why, and what to do |
|---|---|
| `PLATFORM_MASTER_KEY` | Never carried. The bundle's header holds only a **fingerprint** of it (an HMAC under the key; it can't be turned back into the key). Everything sealed under it — workspaces' key bundles, the platform's secrets, every file in the box — travels sealed, so **the restoring server must be given the same key**; a restore refuses a different one, saying so, before it touches anything. `npm run bundle -- inspect <file>` says whether this server's key is the one. |
| Environment secrets and settings | SMTP, `STORAGE_*`, `RECORDINGS_*`, gateway keys, `AUTH_SECRET`… — set them again (`platform/inventory.json` lists which were set). Settings saved in the console are in the control plane and travel with a full bundle. |
| The reference database | Reloaded from its sources (§4, `db:reference`, `db:geonames`). |
| Logs, GeoIP data | `LOG_DIR` and archived logs stay; GeoIP is downloaded again. |
| Other backups | `BACKUP_DIR` (workspaces' own backups) and the box's `offsite/` folder. |
| Closed workspaces | `DEPROVISIONED` ones: their rows are in the control plane's dump, their data is gone. |

**The file.** The header (kind, when, by whom, the app's version and commit, each workspace with its schema version, the control plane's, the key's fingerprint) is readable **without** the passphrase. Everything after it is AES-256-GCM in 1 MiB frames under a key from the passphrase (scrypt, the same rules as a workspace archive: at least 12 characters); each frame's tag binds the header, its position and whether it is the last. A wrong passphrase is refused before anything is read; a truncated, altered, reordered or appended-to file is refused, naming the frame; every entry is checked against the manifest at the end. A restore reads the whole file through once itself before it changes anything; **Verify** first anyway, to know before you plan the downtime.

**From the console** — Admin › **Backups** (`admin.<domain>/backups`; `src/app/platform-console/(console)/backups`). Owners and admins see it; only **owners** make, download, upload, verify, restore or delete a backup.

1. **New backup** — the full application, or one workspace (searchable). The passphrase is typed twice (at least 12 characters); without it, and without this server's `PLATFORM_MASTER_KEY`, the file can't be opened by anybody. Before it starts, the size is estimated — each workspace's database (`pg_database_size`) plus its files as last measured, and for a full one the control plane's database — against the free space where `BACKUP_DIR/platform/bundles/` is; it is refused, with both numbers, when it won't fit. One build at a time for the same kind and workspace. It is made by a detached worker (`scripts/bundle-worker.ts`, spawned like the restore worker); the passphrase reaches it sealed under the platform key in a 0600 file under `bundles/.jobs/` that the worker deletes as it reads it — never on its command line, in its environment, on the record or in the audit log. The page shows the entry being written, entries done of the total and the bytes against the estimate, refreshing itself while anything runs; then READY with the size and SHA-256, or FAILED with the reason.
2. **Download** — asks for a fresh code from the owner's authenticator (it counts for ten minutes, on that session only), then streams the file as `deskzo-full-<UTC time>.dzbk` or `deskzo-<workspace>-<UTC time>.dzbk` from `admin.<domain>/backup-files/<id>`, only from the console's own page. Recorded (`backup.download`) and every other owner is emailed. A file that has expired or was deleted is refused, saying so.
3. **Upload a backup** — on the server it is to be restored on. Sent in 16 MB parts, each with its SHA-256, to `admin.<domain>/backup-uploads` (appended in order to `bundles/incoming/<id>.part`); a dropped connection or a reload carries on from the part the server asks for when the same file is chosen again. A file that isn't a bundle, or is larger than the disk has free, is refused before any part is sent. Once whole it is a READY backup (source *uploaded*) for a day. Uploads abandoned for a day are cleared.
4. **Verify** — asks for the passphrase (refused at once if it doesn't open the file), then reads the whole file in the worker and records when, whether it was sound, and what was wrong. Each backup also shows, without the passphrase, **whether it can be restored here**: the same `PLATFORM_MASTER_KEY` or not ("made with a different PLATFORM_MASTER_KEY — set that key on this server before restoring"), the control plane's and each workspace's schema against this server's migrations (newer means this server must be updated first), whether each workspace is already here (same id), and the app's version.
5. **Delete** — removes the file; the record stays, marked deleted.

A build or a check whose worker died (nothing heard for 30 minutes — a restart) is marked failed: "stopped — the server restarted while it was being made". Each workspace's page in the console links to its backups.

6. **Restore…** — on a READY backup (owners). A wizard shows whether it can be restored here (the compatibility report above — a different key or a newer schema stops it), **exactly what will happen, in order**, the option below, then asks for the passphrase, a fresh authenticator code and a typed confirmation: the workspace's address name (slug) for a workspace, **`RESTORE EVERYTHING`** for a full one. Every other owner is emailed. It runs in a detached worker (`scripts/restore-bundle-worker.ts`, the passphrase handed over sealed as for a build); the page shows its log as it goes. The **Restores** section lists every restore — what, from which backup, who, when, its status, its safety copy and its log.

**How a restore goes** (`src/lib/bundle/restore.ts`). First the checks — *before anything is touched*: the file is there and READY, its SHA-256 is still the one recorded when it was made or uploaded, it is read through once with the passphrase (every frame, every entry against the manifest — whatever an earlier Verify said), it is the kind asked for, it was made under this server's `PLATFORM_MASTER_KEY` (by fingerprint), no schema in it is newer than this server's, the storage box is set up here when it carries files for one ("set up the storage box first"), the disk where `BACKUP_DIR` is has room for its largest database dump, its largest file and the safety copy, and no other restore is running. Any of these fails: the restore is recorded **FAILED**, saying which, and **nothing has changed**. Then every entry is hashed again as it is used and checked against what was read, so a file swapped in between is refused at once.

- **A workspace this server has** (the same id) — restored **in place**: it is closed to its users (the maintenance page), a **safety copy** is taken — a full workspace backup kept 30 days, with its control-plane records sealed beside it (`<copy>.dump.control.json`) — no copy, no restore. Then its database is cleared and the backup's put in its place and migrated, every sign-in ends, its files are written back into its part of the box (files added since the backup are **kept** — nothing is deleted), its keys are installed when the backup was made under others (audited), and its plan, billing and settings records are **left as they are** — they are live here — unless the owner ticks *Also put back its plan, billing and settings records from the backup*, which puts the backup's back over them by their keys (never a duplicate; records added since are kept; audited). Then the backup list, the sign-in index, the terminals' routes, Automate and the seat count are brought in line, and it opens again. **Any failure after the safety copy puts everything back** — the database from the safety copy, its keys, its records — and the run says ROLLED_BACK with the reason. If putting it back fails too, the run says FAILED with exactly what is left and the `npm run db:restore` line that puts the safety copy back, and **the workspace stays closed** (its lock is held — remove `<its backup folder>/.restore/restore.lock` once it is put right).
- **A workspace this server hasn't got** (a fresh install, another server) — added **as new**: refused if its address name or any of its domains belongs to another workspace here (said which). A new database is made for it, the backup's put in it and migrated, its records added to the control plane — its row with an address sealed for *this* server (never the old one), plans and partners matched to this server's by key (this server's are used as they are), subscriptions, invoices, domains as they were — its files written to this server's box, its entitlements worked out. A failure drops the new database and takes away every record and file it added.
- **The whole application** — see the recipe below. While it runs, the console's address shows a plain **"Restore in progress"** page (no data; it polls `/restore-status`) and every other address "being restored"; the run's log is in `BACKUP_DIR/platform/restores/<run id>.json`, copied into the restored control plane's Restores at the end. The owner's own session ends when the control plane is replaced — **they sign in afterwards with a staff account from the backup**. If this server already holds workspaces, the wizard says so first: they are **not** deleted — every workspace in the backup gets a **new** database, and the old databases are listed in the run for an owner to drop later — but the console after the restore is the backup's. A **safety copy of this server's control plane** is always taken first (`BACKUP_DIR/platform/restore-safety/<run id>/control.dump`, sealed under the platform key). Then the control plane is replaced and migrated; this server's **storage box and off-site store settings are kept** (the old server's removed); everything that belonged to the old server is cleared — staff, website-editor and partner sign-ins, job leases, the warm database pool, backup records whose files aren't here, its off-site record when the store differs. Every workspace then gets a new database here, its files and support files; **one that fails is left SUSPENDED with the reason and the others carry on** — the run ends FAILED, "Partly restored: n of m", with each workspace's outcome. The reference data is reloaded from its source. If it fails before any workspace is restored, the control plane is **put back from the safety copy** (ROLLED_BACK); if even that fails, the application stays closed and the run's file gives the command: `npm run bundle -- put-back-control <run id> --i-understand`.

**A fresh install from a full backup — step by step**

1. Install Deskzo on the new server as usual (§1–§3), with **the same `PLATFORM_MASTER_KEY`** as the old server — and the same `AUTH_SECRET` if any workspace is older than the platform key (its sessions and some of its sealed values were made under it). Give it its own `CONTROL_DATABASE_URL`, `PLATFORM_PROVISIONER_URL`, `BACKUP_DIR` with room for the largest database and file in the backup, and run `npm run control:migrate`.
2. Set up the **storage box** (console › Settings › Backups & logs › Storage box, or `STORAGE_*`) — a restore of a backup with files refuses without one.
3. Make the bootstrap owner (`npm run platform:staff -- create --email … --name … --role OWNER`), sign in, set up their authenticator.
4. Console › **Backups** › **Upload a backup** — the `.dzbk` file; **Verify** it with its passphrase.
5. **Restore…** → read what will happen → passphrase, a fresh code, type `RESTORE EVERYTHING`. The "Restore in progress" page follows it.
6. When it says *Done*, **sign in again with your staff account from the backup** (the bootstrap owner is gone with the old control plane). Open Backups › Restores: the run's log names any workspace not restored and the old server's environment settings this one still needs.
7. Enter by hand what a backup never carries: the environment's secrets — SMTP (`PLATFORM_SMTP_URL`), the payment gateways' and other integrations' keys kept in the environment, `STORAGE_*`/`RECORDINGS_*`, `REFERENCE_DATABASE_URL` — and point DNS (and each custom domain) at the new server.
8. Reference data: the restore starts the reload from its sources when `REFERENCE_DATABASE_URL` is set; otherwise, once it is: `npm run reference:migrate && npm run db:reference && npm run db:geonames:download`.
9. Start the platform worker and run the ticks once; sign in to a workspace or two.

On a server that is already running (not a fresh install), **stop the platform worker** (`npm run platform:worker`) before a full restore and start it again after: the web app is held by the "Restore in progress" page, but a worker process reads the control plane on its own while it is being replaced.

Without a working console: `BUNDLE_PASSPHRASE=… npm run bundle -- restore <file> --i-understand` (full), or `… restore <file> --workspace <slug> [--put-back-records] --i-understand` — the same checks, steps and log, recorded in Restores. Afterwards, the restored control plane's staff sign in as above.

**From the server** — `npm run bundle -- …` (the passphrase from `BUNDLE_PASSPHRASE`, never the command line):

1. `create --full [--out <file>]` — the whole installation.
2. `create --workspace <slug> [--out <file>]` — one workspace.
3. `inspect <file>` — the header, and whether this server's `PLATFORM_MASTER_KEY` matches.
4. `verify <file>` — the whole file read once: every frame, every entry against the manifest.
5. `restore <file> [--workspace <slug> [--put-back-records]] --i-understand` — a restore, as from the console (above).
6. `put-back-control <run id> --i-understand` — the control plane put back from a full restore's safety copy, when the restore's own rollback could not.

Building streams everything — `pg_dump` straight into the file, the box's files one at a time — so memory stays flat however large the workspace; the disk needs room for the bundle and the largest single file besides.

**Checks:** `npm run check:bundle`, `npm run check:console-backups`, `npm run check:bundle-restore`.

## 5. Recovering

### 5.1 One workspace's data damaged (a bad import, a mistaken deletion)

1. Hold it: console → the workspace → Hold, with the reason.
2. Restore its latest good backup: its owner from Settings → Backups, or staff for an archive that is not platform-signed. For a point between backups, restore the cluster to that time on a spare server and copy that one database back.
3. Reopen it; tell the owner what was lost between the backup and the damage.

### 5.2 The database server lost

1. Stand up PostgreSQL 16; restore the cluster from the base backup and WAL to the latest point.
2. Check the control plane opens and lists every workspace: `npm run platform:tenant -- list`.
3. Start PgBouncer, the app, the worker; run the ticks once by hand.
4. `npm run check:tenancy`; sign in to two workspaces and the console.

### 5.3 The control plane lost, workspace databases intact

Restore it from the cluster's recovery, or from its nightly dump off-site (§4.1) — it is the only record of each workspace's keys. With the store's address and a read credential from the break-glass entry, and the same `PLATFORM_MASTER_KEY`:

```
OFFSITE_STORE='{"provider":"azure","containerUrl":"https://<account>.blob.core.windows.net/<container>","prefix":"deskzo"}' OFFSITE_SECRET='<SAS token>' npm run offsite -- list backups/control/
OFFSITE_STORE=… OFFSITE_SECRET=… npm run offsite -- fetch backups/control/deskzo-control-<newest>.dump control.dump
pg_restore --no-owner --no-privileges --dbname=<an empty control database> control.dump
npm run control:migrate
```

(S3: `{"provider":"s3","endpoint":"https://s3.ap-south-1.amazonaws.com","region":"ap-south-1","bucket":"…","accessKeyId":"…","prefix":"deskzo"}` with the secret key as `OFFSITE_SECRET`.) A copy taken up to a day before the loss: a workspace created or a plan changed since is not in it. Without either copy, the first workspace can be adopted again (`npm run platform:adopt`), but **no other workspace can be recovered**: their keys are gone. This is why §4 keeps the control plane in two places.

### 5.4 `PLATFORM_MASTER_KEY` lost

Nothing sealed can be opened. Restore it from its offline copies (§4). There is no other way back.

### 5.5 Setting up a workspace failed

Console → Provisioning shows the step and the error; **Try again** after fixing it (usually the provisioner's credentials or disk). The signup's owner is waiting on the progress page, which picks it up.

### 5.6 Billing webhooks failing

Console → Billing → "What the gateways said" shows each failure; the gateway retries for days. Check the webhook secret matches the gateway's dashboard. The daily reconcile reads every subscription back regardless, so nothing is lost if a webhook never arrives.

### 5.7 Staff locked out of the console

- A lost password: `npm run platform:staff -- link <email>` prints a new one-time link.
- A lost phone: `npm run platform:staff -- reset-2fa <email>`.
- No owner can get in at all: from the server, `npm run platform:staff -- reset-2fa <owner's email>` — they set up a new authenticator at their next sign-in. `two-factor off` lets everyone in on a password alone; if you use it to get in, put `two-factor required` back straight after.

### 5.8 A workspace overloading the server

Each workspace's role has its own limits: a statement stops at thirty seconds, a lock wait at ten, an idle transaction at a minute, and it opens at most twenty connections. If one workspace still crowds the others, hold it from the console and talk to its owner.

### 5.9 Suspected exposure of one workspace's data to another

1. Hold the workspaces involved (console → Hold, reason "security incident").
2. Preserve the logs: every line names its workspace (`[slug] …`), so the relevant lines can be extracted per workspace.
3. Establish scope: which records, which people, which window.
4. The customers are the controllers of their data: notify each affected workspace's owner without undue delay, and within the time the DPA promises (docs/privacy/data-processing-agreement.md), so they can meet their own duties under GDPR and the DPDP Act.
5. Fix, add a probe for it to `scripts/pentest.ts`, reopen.

### 5.10 Everything lost — recovering from the off-site store

The server and the cluster's own backups both gone; the off-site store (§4.1) is what is left.

1. A new server, the app deployed with the same `PLATFORM_MASTER_KEY`, `AUTH_SECRET` and settings; an empty PostgreSQL 16. Give the database server the name the old one had (the Compose service `postgres`, or the same DNS name): the workspaces' sealed addresses name it.
2. The control plane, from its dump (§5.3).
3. Each workspace: `npm run offsite -- recover <slug>`. Its database and role are made again under the names and password its sealed address holds, its newest backup off-site fetched, checked and restored, and this release's migrations run over it. `--backup <id or file>` for an older one (`npm run offsite -- list backups/workspaces/<id>/manifests/`); a database already there with tables is left alone unless `--replace`. It takes about as long as the drill reports for that workspace.
4. The reference database, from its sources (`npm run db:reference`, `npm run db:geonames`).
5. Support files a request still needs: `npm run offsite -- fetch support/<workspace>/<request>/<file> <SUPPORT_DIR>/<workspace>/<request>/<file>`.
6. `npm run tenants:migrate`, `npm run check:tenancy`; sign in to two workspaces and the console. Tell each owner what was lost between their last backup and the loss — up to a day.

## 6. Everyday operations from the server

| Task | Command |
|---|---|
| List workspaces | `npm run platform:tenant -- list` |
| Hold, reopen, close, purge | `npm run platform:tenant -- suspend <slug> --reason …` / `resume` / `deprovision` / `purge` |
| A workspace's plans; what it may use | `npm run platform:tenant -- plans <slug> <plan>[:qty] …` / `entitlements <slug>` |
| Re-apply every workspace role's limits | `npm run platform:tenant -- limits` |
| Invitations | `npm run platform:tenant -- invite [--plan <key>]` |
| Staff | `npm run platform:staff -- list / create / link / role / reset-2fa / deactivate / two-factor` |
| Website CMS accounts | `npm run cms:user -- list / create / link / role / reset-2fa / deactivate / two-factor` (§10) |
| Partners, and their portal accounts | `npm run partners -- list` / `user list <partner>` / `user create <partner> --email … --name … [--role ADMIN\|FINANCE\|SALES\|VIEWER]` / `user link <email>` / `user reset-2fa <email>` / `user deactivate <email>` (§12) |
| Workspaces to a partner, or back to direct | `npm run partners -- assign <partner-slug\|direct> <workspace-slug…> --reason "…" [--no-commission]` — from now, never backdated |
| The portal's two-factor; commission and statements now | `npm run partners -- two-factor [required\|optional]` / `accrue` / `statements` |

## 7. Capacity: connections and PgBouncer

The app reaches every workspace database through one Prisma client (the Rust-free engine, over Prisma's pg driver adapter), which sends each query to its workspace's own small pool of connections (src/lib/tenancy/clients.ts). A workspace costs a pool — a few milliseconds to open, most of them waiting on the server — not a copy of the schema.

Every app process keeps up to `TENANCY_MAX_CLIENTS` workspace pools, each opening up to `TENANCY_CONNECTION_LIMIT` connections — and Postgres allows `max_connections` for everything. An evicted pool is ended as soon as the work on it ends, and a connection unused for `TENANCY_IDLE_CONNECTION_S` closes too, so in practice connections follow the work in progress; the product of the two settings is the worst case, and the one to size against.

- **The engine works on one core.** The Rust-free client compiles each query on the process's own thread, where the old engine used threads of its own. Measured on 2026-09-26 (20-core machine, one busy workspace, 32 requests at a time): a process topped out at about 345 of the load test's requests a second against the old engine's 690, for slightly less CPU per request. So run several app processes (pm2 cluster mode, one per core or two) and keep `TENANCY_MAX_CLIENTS × TENANCY_CONNECTION_LIMIT × processes` within the connection budget — or put PgBouncer in front, below.
- With more than one app process, routing each workspace to the same process (hash on the host at the load balancer) keeps its pool warm — useful, not essential.
- A query outside any workspace is refused; so is starting at all if Prisma's internals change where the client expects them (see the top of clients.ts) — after upgrading Prisma, run `npm run check:hardening` before anything else.

Run PgBouncer in transaction mode, so the server sees a bounded pool however many workspaces are busy:

```ini
; /etc/pgbouncer/pgbouncer.ini
[databases]
; Any database, as the connecting workspace role — each workspace keeps its own pool.
* = host=127.0.0.1 port=5432 auth_user=pgbouncer

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = scram-sha-256
auth_user = pgbouncer
auth_dbname = postgres
auth_query = SELECT usename, passwd FROM pgbouncer.user_lookup($1)
pool_mode = transaction
default_pool_size = 3
max_db_connections = 10
max_client_conn = 5000
ignore_startup_parameters = extra_float_digits
```

```sql
-- In the postgres database, as a superuser: PgBouncer looks workspace roles' passwords up, and only theirs.
CREATE ROLE pgbouncer LOGIN PASSWORD '<in its own secret store>';
CREATE SCHEMA pgbouncer AUTHORIZATION pgbouncer;
CREATE FUNCTION pgbouncer.user_lookup(p_user text, OUT usename text, OUT passwd text) RETURNS record
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS
  $$ SELECT rolname::text, rolpassword::text FROM pg_authid WHERE rolname = p_user AND rolname ~ '^w_[0-9a-f]{12}$' $$;
REVOKE ALL ON FUNCTION pgbouncer.user_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.user_lookup(text) TO pgbouncer;
```

The lookup only answers for provisioned workspace roles (`w_` and twelve hex characters). A workspace adopted from the single install (tenant #1) keeps its original role: widen the pattern to name that role too, or list it in PgBouncer's `auth_file` — otherwise it cannot sign in through PgBouncer.

Then set `TENANCY_POOLER_URL=postgresql://127.0.0.1:6432`. Only the app's queries go through it; migrations, backups and provisioning keep connecting directly. Without PgBouncer, keep `TENANCY_MAX_CLIENTS × TENANCY_CONNECTION_LIMIT × app processes` under about 70% of `max_connections`. Re-run `npm run load:test` after any of these change.

### 7.1 Several web processes in one container

The app answers on one thread, and a page that has to work something out holds every other request — of every workspace — until it is done (the large-workspace load test, docs/reports/load-test-large.md). `DESKZO_WEB_PROCESSES=N` (1–16; one when unset) runs N copies of the web app in the container, on the one port, taking requests in turn (deploy/start.mjs; Node's cluster). Start with 2, and no more than the server's cores.

What one process keeps in memory, the copies keep in step — each tells the others (src/lib/cluster/hub.ts):

- **Caches cleared on a save** — IP rules, security and workplace settings, maintenance, a company's lock, support access, linked sign-in, help, site content, redirects, search policy, name rules, announcements, partner and support settings: cleared in all at once. Every other cache already expires within a minute.
- **Sign-in failures and once-a-window allowances** (src/lib/security/lockout.ts, throttle.ts): counted in all, so eight wrong passwords lock an account whichever copy each landed on.
- **Team chat**: who has chat open, in every copy; a message published in one reaches a stream held by another.

A copy that stops is started again five seconds later, and the others forget what it held. The database pools are shared out: unless `TENANCY_MAX_CLIENTS` is set, each copy keeps 35 ÷ N (at least 4), so the connections stay within the same budget. Memory is about 0.5–1 GB a copy.

Not covered: several *containers*. Their memory isn't shared — sign-in counters would be one budget per container, and chat would need Postgres NOTIFY or Redis between them.

Checked by `npm run check:cluster` (a real three-process cluster, with a probe in place of `next start`).

## 8. Before the first paying customer

- [ ] `NODE_ENV=production`, TLS at the proxy, `TRUST_PROXY=1`.
- [ ] `PLATFORM_MASTER_KEY` backed up offline, twice (§4), with the off-site store's address and a read-only credential beside it.
- [ ] Settings › Backups & logs: an off-site store in India that passes **Check connection**, protected from deletion by its own controls (§4.1); after the first night, a sync, a control plane dump and the log archive all **Done**, and **Run a drill** passing.
- [ ] CERT-In (§14): chrony on the VM pointed at NPL and NIC, and the clock on the page within a second; the point of contact and a deputy named and sent to CERT-In; whoever runs the platform knows the 6-hour rule.
- [ ] Staff two-factor **required** (console → Staff); `PLATFORM_CONSOLE_IP_ALLOWLIST` set.
- [ ] `cms.<domain>` in DNS and the proxy's certificate; the first CMS admin invited; CMS two-factor **required** (CMS → Settings → Security, or `npm run cms:user -- two-factor required`); the placeholders (tagline, display domain, sales email) replaced and published.
- [ ] PgBouncer in front of workspace databases (§7); the three schedulers running (§1); the worker under pm2.
- [ ] Gateways: live keys entered, webhooks set, one test-mode checkout run end to end first (docs: billing is proven only against fakes so far).
- [ ] Settings › Mail: a default account that passes **Send test**; a signup code and a billing reminder received, and both in the Mail log.
- [ ] Contact Support (§11): console → Settings → Support has a real support address in place of the placeholder `support@yourdomain.com`, a mailbox somebody reads; the helpline and hours if there is one; `SUPPORT_DIR` on a disk that is backed up.
- [ ] Before the first partner (§12): `partners.<domain>` in DNS and the proxy's certificate; at Stripe, the endpoint pinned to API version `2024-06-20` and `charge.refunded` and `credit_note.*` among its events, at Razorpay `payment.refunded` and `refund.processed` (§2); the programme's settings looked at in the console → Partners (two-factor **required**, the statement day, deal protection, the clawback window, the two-person rule — and the referral cookie left off); `PLATFORM_SALES_EMAIL` set, as applications are mailed there; the first partner created with its terms, and its first admin invited (the partner's page → Invite partner admin, or `npm run partners -- user create`); the accountant's answers to the tax questions in §12.
- [ ] Privacy documents reviewed by counsel and published (docs/privacy).
- [ ] `npm run pentest` and `npm run load:test` on the production-like server; reports kept.

## 9. Regular checks

| When | What |
|---|---|
| Every release | The check suites; `npm run pentest` for anything touching sign-in, tenancy or billing |
| After changing capacity settings, and before a large onboarding | `npm run load:test` |
| Weekly | Settings › Backups & logs: last week's restore drills passed, and how long they took (§4.1) |
| Quarterly | §5.2 and §5.10 rehearsed on a spare server, timed; the SAS token or access key's expiry checked (§4.1) |
| Monthly | Console → Billing: failed webhooks; console → Migrations: anything behind; console → Provisioning: anything failed |
| Monthly, from the statement day | Console → Commissions: the flagged entries reviewed, the drafted statements approved and paid; console → Partners → Requests: applications, deals, changes and flagged attributions |

## 10. The website CMS

The public website's pages, blog, images, navigation and contact-form leads are managed in their own small app at `https://cms.<domain>` — not in the console, and with accounts of its own (`cms_users`): marketing people get a CMS account and never see the console or any customer's data. Its content lives in the control plane (`site_pages`, `site_page_versions`, `site_posts`, `site_media` — images, in the database — `site_settings`, `site_leads`, `cms_audit_log`), so the control plane's backup (§4) is the CMS's backup.

- **Roles.** ADMIN: everything, including CMS accounts and security. EDITOR: edits and publishes pages, posts, images, navigation and settings; works the leads. AUTHOR: drafts pages and posts and uploads images; publishes nothing and changes nobody else's posts. VIEWER: reads everything, leads included.
- **The first admin.** An owner, in the console → Website CMS → Invite a CMS admin; or on the server: `npm run cms:user -- create --email … --name … --role ADMIN`. Either emails (and shows once) a one-time link to choose a password. Nobody ever types a password for anybody; the last active admin cannot be demoted or switched off.
- **Two-factor** is the CMS's own setting: "required" (everybody enrols an authenticator at their next sign-in) or "optional" (only those who set one up are asked). Until an admin chooses it is required in production and optional elsewhere. Sessions: sixty minutes idle, twelve hours at most; failed sign-ins lock out per account and per known caller.
- **Locked out.** A lost password: `npm run cms:user -- link <email>`. A lost phone: `npm run cms:user -- reset-2fa <email>`. No admin can get in: `two-factor optional`, get in, put `required` back. The console's Website CMS page also sends a CMS admin a new link (emailed to them only).
- **Publishing.** Pages have a draft and a published copy; the site shows only what is published, and a built-in page (home, pricing, security, contact, sign-in, signup, terms, privacy) shows its default content until the CMS publishes one — it can be changed but never unpublished or deleted. Every publish is kept as a version. Posts are published now or scheduled: a scheduled post appears once its time has passed, with no job to run. The site caches published content for 45 seconds per process, so another server process may show the change up to 45 seconds later.
- **Previews** are links on the public site, `/preview/<token>`, signed with a key derived from `PLATFORM_MASTER_KEY`, for one draft as it was when the link was made, for fifteen minutes. Never indexed, never cached.
- **Images** are PNG, JPEG, WebP or GIF, told by their bytes (never SVG), at most 5 MB, served at `/media/<id>` with a year's caching. Uploads go through a server action, whose body Next caps at 1 MB unless `next.config.ts` sets `experimental.serverActions.bodySizeLimit` (6 MB covers the 5 MB limit and the form's overhead). An image cannot be deleted while a page, post or the settings use it, and nothing using it is published until it has alt text.
- **Leads** are kept from the contact form (with the caller's address only when `TRUST_PROXY` makes it known) and mailed to `PLATFORM_SALES_EMAIL` when set. Editors change their status and export them as CSV (audited).
- **The CMS host** answers no `/api` path — its work is server actions — and is never indexed or cached. `npm run check:cms` covers all of the above on a scratch control plane; `npm run pentest` probes CMS-1 to CMS-6.

## 11. Contact Support

Anyone signed in to a workspace can ask the platform for help with the **Contact Support** button at the bottom right of every page: a subject, the details, how critical it is, up to five files and, with their consent, a screen recording of up to five minutes. Requests are kept in the control plane (`support_requests`, `support_attachments`, `support_entries`) and worked in the console at `admin.<domain>/support` — owners, admins and support staff act on them, read-only staff read them. This is the platform's support desk; the helpline a workspace shows its own people (its Settings, under Helpline) is its admins' and is unrelated. The button is not shown to anybody viewing as someone else, or to platform staff inside a workspace on a support grant.

**Settings** — console → Settings → Support, changed by owners and admins, audited as `support.settings`:

| Setting | Unset | What |
|---|---|---|
| Contact Support in workspaces | on | Off hides the button in every workspace at once |
| Support email | `support@yourdomain.com` (a placeholder, shown with a warning) | Where each new request is announced, and the Reply-To of every mail to a requester |
| Helpline, hours | not shown | Shown in the dialog and in the acknowledgement mail |
| Screen recording | on | Off removes the Record button everywhere |
| Keep files after closing | 365 days (30–3650) | How long a closed request's files are kept (below) |

**Where the mail goes.** All of it goes through the platform's mailer — the account the console's Settings › Mail names for its type, else the default's, else `PLATFORM_SMTP_URL`, else into `platform-outbox/` — and every send is in the console's Mail log:

- each new request is announced to the support email, `[SR-1042][URGENT] {workspace}: {subject}`, with a link to it in the console;
- the person who sent it gets an acknowledgement with its number, Reply-To the support email;
- a staff reply from the console is emailed to them, `Re: [SR-1042] {subject}`, Reply-To the support email, and kept on the request's timeline — marked "Email failed" with the reason when the mail server refuses it.

There is no inbound mail: when a customer answers, the answer lands in the support mailbox, not the console. Somebody must read that mailbox, and paste anything that matters into the request as an internal note.

**Files.** Uploads are streamed to `SUPPORT_DIR` as soon as they are chosen, told apart by their bytes (images, PDF, office documents and zips, plain text; recordings only WebM or MP4; never SVG or HTML), 10 MB a file, 80 MB a recording, 150 MB waiting per person:

```text
SUPPORT_DIR/<workspace id>/staging/<upload id>(.json)          chosen, not yet sent — swept after a day
SUPPORT_DIR/<workspace id>/<request id>/<attachment id>          sent with a request
```

Staff open them only through `admin.<domain>/support-files/<id>` (owners, admins, support), which sends them with the type they were sniffed as, `nosniff` and a sandboxing policy; each opening is audited as `support.file.open`, once per person per file per ten minutes. Size the disk for recordings: a screen recording runs at about 1 MB a minute, so a five-minute one is 5–40 MB depending on what was on screen.

**Retention.** The hourly platform tick (§1) deletes uploads left in staging for a day, and the files of requests closed longer ago than the retention setting; each attachment is then marked as removed, and the request, its timeline and the list of what was attached stay. Its answer includes `support: { swept, purged, stuck }` — `stuck` counts files the disk would not let go of (held open, a permission), tried again next hour. A request reopened before then keeps its files; its retention starts again from its next close.

**Screen recording** needs the person to tick a consent box that lists what it collects: the recording, the browser's console errors and warnings while it ran, page-load timings, their IP address and device details, and sound only if they switch the microphone on. It is not offered where the console switched it off, or where the workspace's DLP deterrents apply to the person (as the workspace's DlpGuard decides it). Only the deterrents an admin chose refuse it: blocking copy, print and the like, or a screenshot limit of zero. A daily screenshot allowance (the default is two a day) does not, so a workspace nobody configured offers recording to everyone.

**Checks.** `npm run check:support` covers all of the above on a scratch control plane and a temporary `SUPPORT_DIR`; `npm run pentest` probes SUP-1 to SUP-5.

## 12. The partner programme

Resellers and distributors sell the platform and are paid commission on what their customers pay. They work in their own small app at `https://partners.<domain>` — the partner portal — with accounts of its own (`partner_users`): a partner's people never see the console, the CMS or anything inside any workspace. Staff run the programme from the console (Partners, Commissions, and the Partner panel on a workspace's page). Everything lives in the control plane (`partners`, `partner_terms`, `partner_users`, `partner_sessions`, `tenant_attributions`, `partner_referral_links`, `partner_deals`, `commission_entries`, `commission_invoice_states`, `partner_statements`, `partner_requests`, `partner_applications`, `partner_audit_log`), so the control plane's backup (§4) is the programme's backup.

- **Roles, the partner's side.** ADMIN: everything, including the partner's people and its activity log. FINANCE: commissions, statements, the CSVs, the payout details' mask and new payout details. SALES: invitation codes, referral links and deal registrations. VIEWER: reads the customers, codes, links and registrations. Every role sees the dashboard, the customers and the company profile; only ADMIN and FINANCE see any commission figure. A distributor also sees its resellers' totals and its own override on their customers.
- **Roles, the console's side.** Owners and admins create and edit partners, change their status, invite their first admin and decide applications, profile changes and new resellers. Owners, admins and billing staff see the money, set terms, decide deal registrations, move workspaces between partners, and review and adjust commission. Only **owners and billing staff** approve and pay statements, and reveal or set payout details: admins see the amounts and set terms, but cannot approve or pay. Support and read-only staff see the partners, without any money.
- **The first admin.** A partner is created in the console (Partners → New partner) with its terms, and starts as onboarding. Then the partner's page → Invite partner admin, or on the server `npm run partners -- user create <partner> --email … --name …`; either emails (and shows once) a one-time link to choose a password, valid for three days. Later people are invited by the partner's own admins, at most fifty active a partner; the last active admin cannot be demoted or switched off. Staff activate the partner once its terms are in force and it has an active admin — only then can it make codes, links and registrations.
- **Two-factor** is the portal's own setting, `partners.twoFactor`: "required" (everybody enrols an authenticator at their next sign-in) or "optional" (only those who set one up are asked). Until an owner chooses it is required in production and optional elsewhere; keep it required. Sessions: sixty minutes idle, twelve hours at most; failed sign-ins lock out per account and per known caller.
- **Locked out.** A lost password: `npm run partners -- user link <email>`. A lost phone: `npm run partners -- user reset-2fa <email>`. No admin of a partner can get in: `npm run partners -- two-factor optional`, get in, then `two-factor required` again. The partner's page in the console (its Users tab) also sends a new link or resets two-factor.
- **Attribution.** A workspace is credited to a partner when it signs up, by the first of: an approved deal registration for the email's domain (protected for `partners.dealDays`, 90 days, from approval); the partner's invitation code; the partner's referral code (from a `/signup?ref=` link, or typed in "Have a partner code?"); a territory default (exactly one active distributor whose terms set a territory rate for the signup's country). Only active partners' claims count. Other claims naming a different partner, and a signup from outside the winner's territories, are flagged for review (console → Partners → Requests → Attributions); a flag never changes who is credited. Staff move a workspace (its page → Change partner, with a reason of 10 to 500 characters), and `npm run partners -- assign` moves many — always from now, never backdated, with both partners' activity logs told (without the reason). A partner's own workspace is attributed with `--no-commission` and never earns. The workspace itself sees "Sold and supported by {partner}" on its Billing page, read-only.
- **The referral cookie is off** (`partners.refCookieDays` 0). When on, a visitor arriving with `?ref=` gets a `deskzo_ref` cookie so a later signup is credited; the site promises no tracking cookies and has no consent banner, so it stays off until one exists. Referral links still credit a signup made from the link itself — and while signup is by invitation, a link never opens signup without an invitation.
- **Commission, in plain words.** When a customer's invoice is paid at a gateway, the partner earns a share of what was paid before tax, at the rate its terms in force on that day give: a territory rate for a customer credited by territory; otherwise the plan's own rate, else the customer's country's rate, else the new-customer rate for the first months (twelve by default) from the customer's first payment and the renewal rate after, else the default rate. Terms are set by staff, never backdated, and a new partner's form starts from 20 % for the first 12 months, then 10 %, for as long as the customer stays (5 % override for a distributor) — nothing applies until staff save them. A distributor also earns its override rate on its resellers' customers, on top. Nothing is earned on the platform's own workspace, a workspace credited without commission, after the partner was terminated, without terms, or beyond the terms' duration. A suspended partner keeps earning; a terminated one stops at termination and is paid what it was owed. The tick works it out every hour; staff can run it now (Commissions → Run commissions now, or `npm run partners -- accrue`).
- **The monthly cycle.** From `partners.statementDay` (the 5th, India time) the tick drafts a statement per partner and currency for last month: the commission earned by the month's end that is on no statement yet, with any clawback of it. A total of nothing or less rolls forward to next month; nothing is converted between currencies. Staff can draft them any day (Commissions → Generate statements, or `npm run partners -- statements`), still for last month.
- **Approving and paying a statement.** An owner or billing staff member reviews the draft (Commissions → Statements), approves it — the partner's payout details must be on file; up to six tax lines, added or withheld, give the net payable — and the partner's admins and finance people are emailed. A GST- or VAT-registered partner then adds its own invoice number in the portal. Pay it outside the platform (a bank transfer), then **Mark paid** with the payment's reference and date. With `partners.twoPersonPayout` on, the person who approved it cannot mark it paid. A draft or approved statement can be voided (its entries go back to the next one); a paid one is final — correct it with an adjustment.
- **Payout details** are sealed, and shown to staff only as a mask; **Reveal payout** (owners and billing staff) shows them whole and is written to the platform's audit log and the partner's activity log. A partner never sees its own in full: to change them it submits new ones, which an owner or billing staff approve; every admin of the partner is emailed the new mask.
- **Clawbacks.** When an invoice is refunded, credited or voided after commission was earned on it, a negative entry takes the commission on the money that went back out of the next statement. The exception (`partners.clawbackMonths`, 12): once a commission has been paid out, a refund that comes more than that many months after the payment is not taken back — the console marks it "Refunded after the clawback window — not recovered". Unpaid commission is always taken back. This needs the gateways' refund and credit-note events (§2).
- **For the accountant.** Tax is not worked out here; staff enter tax lines on each statement. Ask the owner's accountant: in India, TDS on commission (section 194H) at the rate and threshold in force, on the partner's PAN, and higher without one; GST — a registered partner invoices its commission with GST on top, whether reverse charge applies to an unregistered one, and the right SAC code; partners abroad — paying a non-resident is an import of services (IGST under reverse charge) and may need withholding under section 195 or a tax treaty, with Forms 15CA/15CB; whether the statement or the partner's invoice is the document of record; statements kept eight years like billing records; each statement paid in its own currency. The console's statement page lists the same questions.
- **What partners see, and never see.** Their own profile, terms, payout mask and activity; the customers credited to them now — the workspace's name and address, country, status, billing standing, plans, what it pays each month (at list prices), its renewal date, and how it was credited — and, for ADMIN and FINANCE, the commission earned from each. Never: anything inside a workspace (no workspace database is opened for them, and there is no support entry), a customer's contact addresses, tax id or invoices, another partner's anything (a refused registration or a conflict never names the other partner), staff notes and reasons, or — for a distributor — its resellers' rates, entries, statements or people.
- **Applications.** The public "Become a partner" form (`/partners`) is open by default and limited per address, per caller and in all; each application is mailed to `PLATFORM_SALES_EMAIL` and kept in the console (Partners → Requests → Applications), where staff turn one into a partner. The public directory (`/partners/find`) lists only active partners who chose to be listed, and is off by default.
- **The portal host** answers no `/api` path — its work is server actions — and is never indexed or cached. `npm run check:partners` covers all of the above on a scratch control plane; `npm run pentest` probes PRT-1 to PRT-12.

## 13. Deskzo Automate

Workflows run in the **platform worker** (§1): it follows the wake list in the control plane (`automation_wake`) every couple of seconds, works up to four workspaces at a time and five runs at once in each, and sweeps every workspace every ten minutes for a wake that was lost. The five-minute marketing tick also runs Automate, as the fallback when the worker isn't running — then delays and waits are only as punctual as the tick. Load: `npm run load:automate` (docs/reports/automate-load-test.md).

### 13.1 Pausing automations — one workspace, or all

- **One workspace:** its admins press **Pause every workflow** on Automate › Workflows. Nothing starts or moves on until they let workflows run again; runs keep their place.
- **Every workspace:** console → Settings → Automate → pause. The worker does nothing at all until it is lifted, and the health board shows Automate as off. Use it for an incident that isn't one workspace's (a bad release, a runaway connector).
- A workflow that fails twenty times in a row pauses itself and tells its owner. One whose owner left, or lost what a step needs, pauses at its next step.

### 13.2 Retrying failed runs in bulk

Fix the cause first — a connection mended, a module switched back on, the owner's access restored. Then, in the workspace: Automate › Runs, **State: Failed** (and a workflow, to narrow it) → **Retry failed runs**. Each goes back to the step that failed, newest first, two hundred at a time (press it again for the rest); it is audited. Runs marked **Needs a decision** are left out on purpose: each stopped at a step whose outcome isn't known (an email or a call that may have gone out), and a person decides it — **Try the step again** or **Cancel run** — one by one.

### 13.3 Reading a run for a support ticket

Open the run (Automate › Runs, or RUN-000123 from the ticket) and press **Copy for a support ticket**: the run, its workflow and version, who it runs as, and each step's status, time and error — never what went in or came out. Each step's data is shown only to the workflow's owner and the super admin (owner, 18 Oct 2026), so support staff entering through a grant see statuses and errors, which is what a ticket needs. Errors are masked as they are stored: keys, tokens, `?token=` values, hook addresses.

A workflow runs as its owner, so only its owner changes, tests or publishes it. Another admin can pause it, run it, duplicate it, or **Take over** — it becomes theirs, switched off until they publish it, and the owner before is told.

### 13.4 The backlog alarm

The health board's Automate row and the console alerts **automate.backlog** (work waiting more than five minutes) and **automate.stalled** (more than an hour, critical) mean workflow work is due and not being taken up.

1. Is the worker running? On Coolify it is a Scheduled Task (§1); on the server, `npm run platform:worker -- --once` works one pass by hand and prints what it did.
2. One workspace, or all? The alert says how many. One workspace stuck while the rest move usually means its turns fail: search the logs for `[automate]` and the workspace's `[slug]`. An event no rule could read, or a step that threw, is now passed over or fails its run rather than stopping the turn — so a repeated failure there is a bug to report.
3. All of them, with the worker running: it isn't keeping up. Look at the database (slow queries, connections — §7) and at the load report's numbers. Pause Automate for everybody (13.1) if pages are slowing down, while you find out.

### 13.5 Restores and outside steps

A workspace restored from a backup resumes its runs where the backup left them; the restore lets go of runs a worker held then and wakes the workspace. A step that reached outside Deskzo (an email, a webhook, a message) after the backup was taken is not done again: such steps are recorded in the control plane (`automation_sent_steps`, kept 120 days), and a run that reaches one again stops at **Needs a decision**, saying it went out before the restore. The worker leaves a workspace alone while it is being restored.

**Checks:** `npm run check:automate-hardening` (restores, the security review's fixes, the alarm), `check:automate-limits`, and the other `check:automate*` suites.

## 14. CERT-In: logs, time and incidents

CERT-In's Directions of 28 April 2022 (under section 70B(6) of the IT Act) apply to Deskzo as a service provider:

| They ask | Here |
|---|---|
| Report a cyber security incident within **6 hours** of noticing it | §14.3 |
| Keep the logs of all ICT systems for a rolling **180 days, in India**, and hand them over when asked | §14.1 — a year, off-site, sealed; the store in an Indian region (§4.1) |
| Keep every system's clock to the NTP servers of **NIC or NPL** (or time traceable to them) | §14.2 |
| Name a **point of contact** for CERT-In | §14.4 |

Ask counsel whether part (vi) — five years of subscriber records, written for data centres, VPS, cloud and VPN providers — reaches a software service like this one; the control plane keeps workspaces' owners and billing details for as long as their workspaces exist anyway.

### 14.1 The logs

- **The web access log.** Every request through the proxy, one JSON line each — time (UTC), the address asked for, method, path (never the query), the proxy's own answer when it gave one, the caller's address as `src/lib/client-ip.ts` decides it, user agent, and the person when signed in. A file per UTC day per web process in `LOG_DIR/access/` (`/data/logs` in the image), on in production (`ACCESS_LOG=off` to turn it off, `on` to have it elsewhere). Biometric terminals (`/iclock`) and Automate's webhook addresses don't pass the proxy and aren't in it; Traefik's and Cloudflare's own logs cover the edge.
- **Each workspace's security logs** — its activity log (sign-ins, failed ones, exports, prints, screenshots, page views where on), its sign-ins with address and place, its audit log (who changed what — the fields' names, not their values). Exported every night, a file per workspace per day; the first export reaches back 180 days. Kept whatever the workspace's own retention setting says: that is how long its admins see them in the app (the setting says so).
- **The platform's own** — the console's audit log and staff sign-ins, the CMS's, the partner portal's.

Archived nightly to the off-site store (`logs/<day>/…`) — or the storage box's `offsite/logs/…` when the console sets none — sealed, kept a year unless changed (Settings › Backups & logs; never under 180 days). Access log files leave the server as soon as their day is archived: it keeps `LOG_LOCAL_KEEP_DAYS` days counting today (1 unless set — today's alone, which is never touched; a day not archived yet stays). Without a store they stay on the server for the whole period instead.

**Handing them over:** `npm run offsite -- fetch logs/<day>/workspaces/<id>.jsonl.gz out.jsonl` (or `…/access/<file>.gz`, `…/platform.jsonl.gz`) gives the plain JSON lines. Give only what is asked, for the days asked; it is personal data.

### 14.2 Time

The containers use the host's clock, so it is the VM that is kept: chrony, pointed at NPL and NIC. In `/etc/chrony/chrony.conf` (Ubuntu: `apt install chrony`), before any other `pool`/`server` line:

```
server time.nplindia.org iburst prefer
server samay1.nic.in iburst
server samay2.nic.in iburst
```

then `systemctl restart chrony` and `chronyc sources -v` (one marked `*`). Outgoing UDP 123 must be open — Azure's default outbound rules allow it. The platform worker asks NPL, then NIC, once a day how far the clock is from theirs; Settings › Backups & logs shows it, and more than a second out is an alert. "Couldn't check" there means UDP 123 is blocked from the container.

### 14.3 Incidents — the 6 hours

The clock starts when anybody here *notices* an incident — not when it is understood. CERT-In's list includes targeted scanning of our systems, a compromised server or account, unauthorised access to data, a data breach or leak, malicious code, an attack on the application, identity theft, spoofing and phishing aimed at us, and a DoS that takes the service down.

1. **Whoever notices** tells the point of contact (§14.4) at once, by phone, with what they saw and when.
2. **Within 6 hours**, the point of contact reports to CERT-In with what is known — it can be completed later: email `incident@cert-in.org.in`, phone 1800-11-4949, fax 1800-11-6969, using the incident form on cert-in.org.in. Keep a copy of what was sent and when.
3. Contain: hold affected workspaces (console), revoke sessions and keys, rotate secrets; keep the evidence — don't wipe a server before its logs are archived (`npm run offsite -- run logs`).
4. If personal data was involved: tell the affected workspaces' companies within 48 hours (the DPA's promise), and the Data Protection Board of India and the people affected as the DPDP Rules require (§5.9 for one workspace exposed to another).
5. Answer CERT-In's follow-up questions, and hand over logs when asked (§14.1).

### 14.4 Point of contact

Name one person, and a deputy, and send CERT-In their name, designation, email, phone and address, as the Directions require (the format is on cert-in.org.in). Write them here, and update CERT-In when they change:

| | Name | Phone | Email |
|---|---|---|---|
| Point of contact | — | — | — |
| Deputy | — | — | — |

## 15. Switch to Deskzo, section by section

A company moving from Zoho Books mid-year brings its year across under Settings › Import & export › Switch to Deskzo (`src/lib/migration`). Each section — invoices, credit notes, customer receipts, bills, vendor credits, vendor payments, expenses, manual journals, open quotes, sales orders and purchase orders — works by itself, in any order.

### 15.1 Getting a section's data

- **Upload** its Zoho export file (CSV or XLSX) on the section's card, or the whole Zoho backup ZIP at the top.
- **Pull it from Zoho**: the card's "Pull … from Zoho" fetches only that section's modules (`startPull` with `only`). A section that already has its file — the backup's, uploaded — offers "Pull new and changed … since" instead: a top-up of only what Zoho created or changed on or after that day, added to the file rather than replacing it, so the daily calls aren't spent on what is there ("or pull all of them again" stays beside it). "Pull everything" stays above. Each module goes to its section the moment it is fetched (`handBooks`, `src/lib/zoho/pull.ts`), so a section can be imported while the rest is still being fetched.
- One pull runs at a time, and Zoho's limits apply to it as before: calls spaced under 100 a minute, 90% of the plan's daily allowance, and a wait for the next day that carries on by itself (the heartbeat's `zohoChores`).
- Customers, vendors and items come in through Import & export (Zoho's `Contacts.csv` and `Vendors.csv` go straight in), or pulled to the old-CRM import's master lists by the super admin.
- **Part of a pull handed over** ("Hand over what's fetched so far") only ever adds, to the section's file and to the archive. Only a module's list read to its end says what Zoho no longer has, and takes that out of the archive. Until 25 Nov 2026 a part replaced what was kept, so a pull of the quotes handed over and then stopped took the earlier years' quotes out, with their PDFs.
- **The earlier years' quotes** come from Zoho's list, one call per 200, without their lines. "Pull the earlier years' quotes from Zoho", under Earlier years, brings them by themselves (`startPull` with `earlier`) and leaves this year's as they are. Their PDFs come only with "Fetch the archive's PDFs only" — a call and a file each, and no nightly top-up while it runs.
- **An earlier document's PDF not kept yet** opens from a company's Earlier years tab while the workspace is connected to Zoho: that one PDF is fetched, kept and served (`src/lib/zoho/open-archived-pdf.ts`). Each call counts against the day's with the pulls', and the page says when the calls or the storage are used, Zoho is disconnected, or Zoho refuses — nothing is kept then, so it can be tried again.
- The nightly top-up counts from the last finished pull of everything (`sinceDay`, `src/lib/zoho/nightly.ts`); a pull of one section, or of the PDFs, isn't one.

### 15.2 Rows that wait

A row that only lacks what another section brings is kept as **waiting**, not failed (`src/lib/migration/sections.ts`): a receipt or credit note for its invoice, a vendor payment or credit for its bill, an invoice or bill for its customer or vendor, a journal or expense for an account. The card shows "Waiting for Invoices: N" and the page says which section to do next. Importing invoices or bills tries the rows waiting for them again by themselves; "Retry waiting" tries any section's again — after customers are imported, say (`retryWaitingPart`).

### 15.3 Undoing one section

"Undo this section" takes back what that section brought, with every entry it posted (`src/lib/migration/undo-section.ts`). It shows first what goes with it: undoing invoices also takes back the credit notes and receipts set against them, undoing bills the vendor credits and payments. It is refused while something made in Deskzo itself is set against them — a payment recorded here, a document converted from one. The section's file stays, as if not yet imported, to bring again. "Undo all of it" still undoes the whole switch, and Finish still locks the year once every month's trial balance agrees.
