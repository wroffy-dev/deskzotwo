# Internal API: how the separate admin app controls the CRM

Owner decision, 27 Nov 2026:

- The admin console runs as its **own app**, in its **own repository**, on its **own VM**, under its **own domain**, with its **own database**.
- The CRM (`<workspace>.deskzo.com`) keeps its code and databases:
  - the control/platform DB: workspaces, plans, billing, mail queue, AI credit;
  - every workspace DB.
- The admin app controls the CRM **only through this API**, server to server.
- The browser never sees the API. Admin staff's browsers only talk to the admin app's own server.

```
 Staff browser ──► admin app (VM-2, its own domain, its own DB: staff, sessions, MFA, admin audit)
                      │
                      │  POST /api/internal/v1/rpc   (private network, HMAC-signed)
                      ▼
                   CRM (VM-1) ── control DB + workspace DBs
```

If the admin app is down, nothing changes for customers. Sign-in, signup, payments, webhooks, scheduled jobs, mail and AI all run on the CRM VM.

## Where it answers (`src/lib/internal-api/gate.ts`)

| Condition | Required |
|---|---|
| `DESKZO_INTERNAL_API=on` | Off by default. Off means a plain 404. |
| Host is `DESKZO_INTERNAL_API_HOST` exactly | The private name or address the admin app uses for the CRM, e.g. `10.0.1.4:3000`. Never a workspace address, the public site or a custom domain. |
| From the private network | No public forwarded address and no CDN header (`cameFromPrivateNetwork`). |
| Signature | See below. |

`src/proxy.ts` checks these before any workspace is looked up, and the route checks them again. Firewall the port as well (NSG): only the admin VM's private IP may reach it.

## Signing (`src/lib/internal-api/signing.ts`; the admin app carries a byte-identical copy)

| Header | Value |
|---|---|
| `x-deskzo-key` | Key id (`DESKZO_INTERNAL_API_KEY_ID`, default `k1`) |
| `x-deskzo-ts` | Unix ms. Must be within ±60 s |
| `x-deskzo-nonce` | 16+ random bytes, hex. Accepted once |
| `x-deskzo-actor` | base64url JSON `{ id, email, name, role, sessionRef, stepUpAt }`. The staff member acting |
| `x-deskzo-signature` | hex HMAC-SHA256 under `DESKZO_INTERNAL_API_SECRET` |

The signed string is `v1\nPOST\n/api/internal/v1/rpc\n<ts>\n<nonce>\n<actor>\n<sha256(body)>`.

- **Secret:** 32+ bytes, separate from `PLATFORM_MASTER_KEY`. The admin app never holds the master key, workspace DB passwords or `PLATFORM_PROVISIONER_URL`.
- **Rotation:** set the new secret as `DESKZO_INTERNAL_API_SECRET` with a new `DESKZO_INTERNAL_API_KEY_ID`. Keep the old one as `DESKZO_INTERNAL_API_PREVIOUS_SECRET` / `_PREVIOUS_KEY_ID` until the admin app has switched.
- **Replay guard:** nonces are remembered per process. Run the CRM's internal listener as one process, or accept that the 60 s window bounds a replay inside the private network.

## Calls

```
POST /api/internal/v1/rpc
{ "op": "console.consoleSuspend", "args": ["<tenantId>", "reason"] }

200 { "ok": true,  "data": <codec-encoded result> }
200 { "ok": false, "error": "<refusal in the console's own words>" }
401 not signed / replayed · 404 unknown op or wrong place · 413 too large · 500 bug
```

- **Actions** return the console's own `ConsoleResult` inside `data`, so the admin app's UI code handles it as it always did.
- **Codec** (`codec.ts`): Dates, BigInts, Decimals and bytes survive the trip.

### Who is acting (`actor.ts`)

Inside a verified call:

- `requireStaff` / `currentStaffSession` answer with the admin app's staff member, in the role it sent.
- Every console action keeps its own role check, refusals and `platform_audit_log` entry (actor = the admin app's staff id).
- **Step-up codes** (closing a workspace, restores, backup downloads): the admin app checks the authenticator code itself and sends `stepUpAt`. The CRM accepts it only within the 10-minute window.
- The CRM keeps a **shadow** `platform_users` row per staff id (no password, nothing to sign in with), so support requests and entries can still point at staff.

### What can be called (`ops.ts`)

Only what is in the table:

- **Actions:** console server actions as `<module>.<function>`.
- **Loaders:** what console pages read, as `load.<function>`. Each carries its page's role set.
- **Never callable:** staff accounts, staff sign-in, sessions and authenticators. The admin app owns those.

The admin app is [wroffy-dev/deskzotwo-admin](https://github.com/wroffy-dev/deskzotwo-admin). It copies the console's pages from this repository and calls these operations by the same names (its `scripts/sync-from-crm.mjs`).

| Phase | Area | Status |
|---|---|---|
| 1 | Every console action module (`console*.ts`), staff accounts excepted. Loaders for the workspace directory and Workspace 360 | Done |
| 2 | Loaders for every other console page, each with its page's roles (`pages(...)`). `console-page-reads.ts` for what pages read inline. The file bridge. Staff mail | Done. All 42 pages tested from the admin app against a local CRM |
| 3 | Switch the CRM's own `admin.` host off (`DESKZO_CONSOLE=off`), deploy files, docs | Next |

### Files: `/api/internal/v1/http`

The console's file routes are bridged here for the admin app:

- `backup-files/[id]`
- `backup-uploads`
- `backup-uploads/[id]`
- `support-files/[id]`

How a call works:

- The admin app sends the browser's request as it came: method, `x-deskzo-target` (the console path), a few named headers and the body, up to one 16 MB part.
- The signature covers the target as well as the method and the body bytes.
- The route handler runs as the admin app's staff member, and its response is streamed back.
- Nothing but those four routes can be reached.

### Staff mail: `admin.sendStaffMail`

The admin app has no mail of its own. This operation sends, through the CRM's mail, only:

- the three staff templates (`staff.setup`, `staff.reactivated`, `staff.passwordLink`);
- a plain note to owners;

and only inside a verified call.

### Never reachable

- `getSecret`: pages ask `secretIsSet`.
- The writers that share modules with loaders: `chargeTurn`, attachment access and audit.
- Staff accounts, sessions and authenticators.

`check:internal-api` holds all three.

## Environment

**CRM (VM-1)**

```
DESKZO_INTERNAL_API=on
DESKZO_INTERNAL_API_HOST=10.0.1.4:3000          # what the admin app calls; private only
DESKZO_INTERNAL_API_KEY_ID=k1
DESKZO_INTERNAL_API_SECRET=<openssl rand -hex 32>
```

**Admin app (VM-2):** `CRM_INTERNAL_API_URL=http://10.0.1.4:3000`, plus the same key id and secret. Nothing else of the CRM's.

## Verify

```bash
npm run check:internal-api
```

End to end, as run on 27 Nov 2026 against a local Postgres:

| Call | Result |
|---|---|
| `load.workspaceDirectory` | Returned the workspace list |
| Suspend and resume as OWNER/ADMIN | Status changed; `platform_audit_log` shows the admin staff id |
| Suspend as READONLY | Refused |
| Close without a step-up | Refused |
| Staff action | 404 |
| Tampered signature | 401 |
| Replayed nonce | 401 |
| `/api/internal` on a workspace host | 404 |
