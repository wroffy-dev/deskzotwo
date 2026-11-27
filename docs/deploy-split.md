# Split deployment: the CRM on one VM, the admin console on another

India only. The admin console runs as its own app ([wroffy-dev/deskzotwo-admin](https://github.com/wroffy-dev/deskzotwo-admin)) on its own VM, under its own domain, with its own database. It controls the CRM only through the CRM's internal API (docs/internal-api.md).

```
                         Internet
            ┌───────────────┴─────────────────┐
   *.deskzo.com, deskzo.com          console.example.com  (office / VPN only)
            │ 443                             │ 443
 ┌──────────▼─────────────┐        ┌──────────▼─────────────┐
 │ VM-1  CRM              │        │ VM-2  Admin app        │
 │ Caddy · app · worker · │◄───────│ Caddy · app · Postgres │
 │ scheduler · Postgres   │ 8443   │ (staff, sessions,      │
 │ (control + workspaces) │ private│  admin audit log)      │
 └────────────────────────┘  VNet  └────────────────────────┘
```

| | VM-1 (CRM) | VM-2 (admin) |
|---|---|---|
| Code | this repository: `deploy/azure` + `deploy/split` | deskzotwo-admin: `deploy/` |
| Databases | control DB, every workspace DB, reference DB | admin DB only |
| Keys | `PLATFORM_MASTER_KEY`, `AUTH_SECRET`, tick secrets, `DESKZO_INTERNAL_API_SECRET` | `ADMIN_MASTER_KEY`, `CRM_INTERNAL_API_SECRET` (same value as the CRM's) |
| Runs | the site, every workspace, signup, payment webhooks, the scheduled ticks, the platform worker, backups, mail | the console's pages only |

If VM-2 is down, customers notice nothing.

## Network

| From | To | Port | Why |
|---|---|---|---|
| Internet | VM-1 | 80, 443 | Workspaces, the site, webhooks |
| VM-2 private IP | VM-1 private IP | 8443 | The internal API (Caddy, internal TLS) |
| Office / VPN | VM-2 | 443 | The console (also `ADMIN_IP_ALLOWLIST` in the app) |
| Internet | VM-2 | 80 | Let's Encrypt's HTTP check only |

- **NSG on VM-1:** allow 8443 inbound from VM-2's private IP only. Caddy publishes 8443 on the private address only (`deploy/split/docker-compose.crm.yml`), never the public one.
- **No database port is open between the VMs.** The admin app never opens a CRM database.

## DNS

- `deskzo.com` and `*.deskzo.com` → VM-1, as before. `admin.deskzo.com` is still covered by the wildcard. Once the console is off there it answers 404, except for ticks and webhooks.
- `console.example.com` (the admin domain you choose) → VM-2.

## Setting it up

### 1. CRM VM (VM-1)

1. Add the lines from `deploy/split/env.crm.example` to `deploy/azure/.env`:
   - `CRM_PRIVATE_IP`
   - the internal API settings, with a new `DESKZO_INTERNAL_API_SECRET` (`openssl rand -hex 32`)
   - `PLATFORM_CONSOLE_ORIGIN=https://<admin domain>`
   - **leave `DESKZO_CONSOLE` unset for now**
2. Restart with the split files, from `deploy/azure`:

   ```bash
   docker compose -f docker-compose.yml -f ../split/docker-compose.crm.yml up -d
   ```

   Use the same two `-f` files in place of `docker compose up` in `deploy.sh` from now on.
3. Print Caddy's internal root certificate for VM-2:

   ```bash
   ../split/crm-ca.sh > crm-ca.crt
   ```

### 2. Admin VM (VM-2)

1. Clone deskzotwo-admin, then make the env file:

   ```bash
   cd deploy && ./make-env.sh
   ```

2. In `.env`, set:
   - `ADMIN_DOMAIN`, `ACME_EMAIL`
   - `CRM_INTERNAL_API_URL=https://<VM-1 private IP>:8443`
   - `CRM_INTERNAL_API_SECRET`: the CRM's value
   - `PLATFORM_DOMAIN`
   - `ADMIN_IP_ALLOWLIST`
3. Copy `crm-ca.crt` from VM-1 into `deploy/`.
4. Deploy:

   ```bash
   ./deploy.sh
   ```

   It ends with a check that prints `ok the CRM answered`.
5. Create the first owner:

   ```bash
   ./owner.sh you@company.com "Your Name"
   ```

   Open the printed link, choose a password, sign in, and set up the authenticator.
6. Add the other staff from **Staff**. Their old console accounts on the CRM are not carried over: each person gets a new account and enrols again.

### 3. Cut over

1. Check the admin app: workspaces, billing, a support request, settings.
2. On VM-1, set `DESKZO_CONSOLE=off` in `deploy/azure/.env` and restart the app. `admin.deskzo.com` now answers 404 for every page.
3. Payment webhooks keep working at `admin.deskzo.com/api/platform/billing/*`, and they also answer on the bare domain. When convenient, change them in the Stripe and Razorpay dashboards to `https://deskzo.com/api/platform/billing/stripe` and `…/razorpay`. Billing in the admin app shows these addresses.
4. The scheduler now calls the ticks on the bare domain. Nothing to change.

**To roll back:** unset `DESKZO_CONSOLE` on VM-1 and restart. The old console is back on `admin.deskzo.com`, with its old accounts. The admin app can keep running beside it.

## Keys and backups

**VM-1:** as before (docs/runbook.md). Also keep `DESKZO_INTERNAL_API_SECRET`.

**VM-2:**
- `deploy/backup.sh` daily (cron) dumps the admin DB.
- Keep `ADMIN_MASTER_KEY` offline. Without it, nobody's authenticator opens, and every owner needs `./owner.sh` and a new enrolment.

**Rotating the internal API secret:**
1. On VM-1:
   - Set the new secret as `DESKZO_INTERNAL_API_SECRET` with `DESKZO_INTERNAL_API_KEY_ID=k2`.
   - Keep the old one as `DESKZO_INTERNAL_API_PREVIOUS_SECRET` / `_PREVIOUS_KEY_ID=k1`.
   - Restart.
2. On VM-2: set `k2` and the new secret, then redeploy.
3. On VM-1: remove the previous secret.

## When something is wrong

| Symptom | Look at |
|---|---|
| `check:crm` says not reachable | NSG 8443 from VM-2; `CRM_PRIVATE_IP`; Caddy running with `deploy/split/Caddyfile` |
| Certificate error | `crm-ca.crt` is VM-1's current internal root (`crm-ca.sh`). Recopy it after Caddy's data volume is reset |
| 404 from the CRM | `DESKZO_INTERNAL_API=on`; `DESKZO_INTERNAL_API_HOST` equals the host:port in `CRM_INTERNAL_API_URL` exactly |
| 401 "Not signed" | The same secret and key id on both VMs; both clocks right (60-second window) |
| A page says "Your role cannot see that" | The staff member's role in the admin app; the CRM checks it again |

Both apps keep an audit log:
- The CRM's (Audit log page) has every change, under the admin staff member's id.
- The admin app's `admin_audit_log` table has every sign-in and every call to the CRM.
