# Deskzo: Chat Notes (Project Import → Check → Admin Console ko alag karna)

Date: 27 Nov 2026
Repo: `wroffy-dev/deskzotwo` · Branch: `claude/affectionate-curie-d4yazt`

Is file mein poori baatcheet ka record hai: kya kiya, kya nikla, kya tay hua aur aage kya karna hai.

---

## 1. Project ko Git pe daalna

**Request:** "ye pura project iss git pr daal do" (`deskzo-main_1.zip`)

**Kya kiya:**
- Zip extract karke poora project repo mein copy kiya aur ek commit kiya: `Import Deskzo project`.
- 5,676 files, branch `claude/affectionate-curie-d4yazt` pe push hui.
- Repo pehle khaali tha, isliye yahi branch default ban gayi. Koi `main` nahi thi, to PR nahi bana.
- Project ki `.gitignore` follow hui, `.env` jaisi files nahi gayi. Sirf `.env.example` gayi.
- `mobile/certs/certificate.pem` commit hui. Project ne ise jaan-boojhkar allow kiya hai (`mobile/.gitignore`), aur isme sirf public certificate hai, private key nahi.

---

## 2. Project ki jaanch

**Project kya hai:** Deskzo One, ek multi-product business suite: CRM, Pipeline, Books (GST), People (HR/payroll), Desk, Inventory, Subscriptions, Projects, Campaigns, Analytics, Vault. Add-ons: Revenue & Close, AI Copilot. Har company ko apna subdomain milta hai (`acme.deskzo.com`).

| Cheez | Detail |
|---|---|
| Stack | Next.js 16.4.6 (App Router), React 19, Prisma 6, PostgreSQL 16, Auth.js v5, Tailwind 4, Zod |
| Code | `src/` mein ~4,180 TS/TSX files, ~7.4 lakh lines |
| Database | 3 Prisma schema. Workspace: 568 models, 458 migrations. Control plane: 105 models. Reference DB (PIN codes, places) |
| Aur folders | `mobile/` (Expo app), `deploy/` (Azure, Cloudflare, Coolify), `docs/` (roadmap, runbook, pentest, load-test reports) |
| Tests | Unit tests nahi hain. ~110 check suites hain (`scripts/check-*.ts`) aur `npm run pentest` |

**Check ka result:**

| Check | Result |
|---|---|
| `npm ci` (736 packages, 3 Prisma clients) | ✅ Theek se install hua |
| `next typegen` ke baad `tsc --noEmit` | ✅ 0 errors |
| `npm run typecheck:scripts` | ❌ 6 GB par memory khatam |
| `npx eslint` (poora repo) | ❌ 12 GB aur ~14 minute baad memory khatam |

**Notes:**
- `next typegen` ke bina `tsc` ~40 errors deta hai (`PageProps`, `RouteContext`, `LayoutProps`). Ye types Next.js banata hai, code mein bug nahi hai.
- Poora lint ek baar mein bahut memory leta hai. Folder-wise chalao (`npx eslint src/lib`) ya zyada RAM wali machine pe.
- App abhi run karke nahi dekha. Uske liye Postgres aur `.env` (`AUTH_SECRET`, `PLATFORM_MASTER_KEY`) chahiye.

---

## 3. Admin console (SaaS) ko alag VM pe chalana

**Request:** CRM aur admin console abhi ek domain aur VM pe chalte hain. SaaS (admin) ko alag VM pe host karna hai, lekin wo CRM ko control kar sake.

### Abhi console CRM ko kaise control karta hai

Console CRM ko HTTP/API se control nahi karta, **seedha database se** karta hai:
- **Control database (`deskzo_control`):** workspaces, plans, entitlements, hold/close, billing, staff. CRM har request pe isi ko padhta hai. Registry cache 30 second ka hai (`src/lib/tenancy/registry.ts:32`), to console ka badlaav CRM pe 30 second mein dikh jaata hai.
- **Workspace databases:** storage, admin reset, support aur lifecycle ke liye console seedha workspace DB kholta hai (`runAsTenant`, jaise `src/actions/platform/console-workspace.ts:433`). DB ka address `PLATFORM_MASTER_KEY` se sealed hai.
- **Naya workspace DB:** provisioner banata hai (`PLATFORM_PROVISIONER_URL`, `src/lib/platform/provisioner.ts`).
- **Host routing:** `src/proxy.ts` aur `src/lib/tenancy/host.ts` host dekh ke decide karte hain: `admin.` → console, `cms.` → CMS, `partners.` → partner portal, bare domain → public site, baaki → workspace.

Matlab control ka raasta Postgres hai. Isliye dono apps alag VM pe chal sakte hain.

### Kya nahi karna chahiye
Console ko HTTP API se CRM control karwana (alag codebase, CRM mein admin API) mat banao. Bahut kaam hai, naya attack surface khulta hai, aur pentest suite isi shared-DB model ko test karti hai.

---

## 4. Admin ka database bhi alag

**Request:** admin.deskzo ka database bhi alag rakhna hai.

Ye bhi ho sakta hai. `CONTROL_DATABASE_URL` ek alag connection hai, aur workspace DB ka address `PLATFORM_PROVISIONER_URL` ke server se banta hai (`provisioner.ts:103`). Dono databases ke beech koi cross-DB query (dblink/fdw) nahi hai.

### Setup

```
        ZONE A: CRM (customers)                  ZONE B: SaaS Admin
 ┌──────────────────────────────┐        ┌──────────────────────────────┐
 │ VM-1  CRM App                │        │ VM-2  Admin App              │
 │ *.deskzo.com, custom domains │        │ console + cms + partners     │
 │                              │        │ + worker + scheduler         │
 └──────┬───────────────┬───────┘        └───────┬──────────────┬───────┘
        │               │   private VNet / VPN   │              │
        ▼               └────────────┐  ┌────────┘              ▼
 ┌──────────────────────┐            ▼  ▼              ┌──────────────────────┐
 │ DB-A  Postgres       │◀── (console → workspace DB) │ DB-B  Postgres       │
 │ har workspace ka DB  │                              │ deskzo_control       │
 │ (w_xxxx), reference  │   (CRM → control lookup) ──▶ │ (workspaces, plans,  │
 └──────────────────────┘                              │  billing, staff, CMS)│
                                                       └──────────────────────┘
```

| Database | Kahan | Kya hai |
|---|---|---|
| `deskzo_control` | DB-B (admin side) | Workspaces, plans, billing, staff, CMS, partners |
| `w_xxxx` (har customer) | DB-A (CRM side) | Customer ka business data |
| `deskzo_reference` | DB-A | PIN codes, places. Har CRM request padhta hai |

**Zaroori:** DB alag hone ke baad bhi dono taraf connection chahiye:
1. CRM (VM-1) → control DB (DB-B): har request pe workspace, plan aur hold dekhne ke liye. Isi raaste admin CRM ko control karta hai.
2. Admin (VM-2) → workspace DBs (DB-A): provisioning, storage, admin reset, support ke liye.

Dono connection sirf private network se, public internet pe kabhi nahi.

### Environment variables

**VM-1 (CRM):**
```
CONTROL_DATABASE_URL   = postgresql://crm_app:***@DB-B:5432/deskzo_control   ← limited role
REFERENCE_DATABASE_URL = postgresql://…@DB-A:5432/deskzo_reference
PLATFORM_MASTER_KEY, AUTH_SECRET, PLATFORM_DOMAIN  = VM-2 jaise hi
(PLATFORM_PROVISIONER_URL set mat karo)
```

**VM-2 (Admin):**
```
CONTROL_DATABASE_URL     = postgresql://control_owner:***@DB-B:5432/deskzo_control
PLATFORM_PROVISIONER_URL = postgresql://provisioner:***@DB-A:5432/postgres   ← CREATEDB + CREATEROLE
REFERENCE_DATABASE_URL   = postgresql://…@DB-A:5432/deskzo_reference
PLATFORM_MASTER_KEY, AUTH_SECRET, PLATFORM_DOMAIN  = VM-1 jaise hi
```

### Security
- CRM ko control DB ka owner role mat do. Alag `crm_app` role banao: read/write ho, DDL nahi. CRM control DB mein likhta bhi hai (signup, handoff pass, job leases), isliye read-only nahi chalega. **Exact grants abhi map karne baaki hain.**
- Migrations sirf VM-2 se (`control_owner`), aur `npm run tenants:migrate` sirf ek jagah se.
- DB-A aur DB-B ka port 5432 sirf VM-1 aur VM-2 ke private IP ke liye khulo.
- Admin domain sirf office IP ya VPN se khule.
- Dono DB ka backup alag. `PLATFORM_MASTER_KEY` ka backup bhi zaroori hai.
- Worker (`platform:worker`) aur scheduler (`deploy/scheduler.mjs`) ka sirf ek copy, VM-2 pe.

### Dhyan rakhne wali baatein
1. **Files:** storage box ek Azure Blob container hai (`src/lib/storage/box.ts`). Dono VM same container use karein, local disk nahi.
2. **Turant cache saaf hona:** `src/lib/cluster/hub.ts` ka broadcast sirf ek VM ke processes ke beech chalta hai. Console se maintenance ya IP rule badla to CRM VM pe asar thodi der se (~30 sec) aayega. Turant chahiye to Postgres `LISTEN/NOTIFY` ya Redis jodna padega.

### Fayda
- CRM VM hack ho to bhi attacker naye DB ya role nahi bana sakta, aur control DB ka schema nahi chhed sakta.
- Admin down ho to customers ka CRM chalta rahega.
- Billing, staff aur CMS data customers ke DB server pe nahi hoga.

---

## 5. Global multi-region plan ka review

**Diagram:** Global SaaS Users → Azure DNS → Front Door Premium + WAF → Global Control Plane (Tenant Registry / Region Resolver, Tenant Management API, Billing, Provisioning, Metadata) → 5 Data Planes (India, UAE, Singapore, Germany, USA). Har data plane mein Node.js Container Apps, Blob Storage, PostgreSQL aur Passive DR.

**Faisla:** disha sahi hai, lekin pehle din 5 region mein launch karna sahi nahi.

### Sahi kya hai
- Control plane aur data plane alag rakhna. Code mein ye aadha pehle se hai.
- Har tenant ka region. `Tenant` table mein `region` column hai (default `"in"`), abhi use nahi hota.
- Germany aur UAE mein data residency, enterprise customers ke liye.

### Code ki kami (diagram ke hisaab se)

| # | Diagram | Code mein abhi | Asar |
|---|---|---|---|
| 1 | Front Door tenant ko region bhejega | Front Door ko pata nahi ki tenant kis region ka hai. Custom domains Cloudflare se chalte hain (`cloudflare-hostnames.ts`) | Routing design chahiye. Front Door ya Cloudflare mein se ek chuno |
| 2 | Har region ka Postgres | Ek hi provisioner (`PLATFORM_PROVISIONER_URL`) | Region-wise provisioner chahiye |
| 3 | Har region ka Blob | Ek hi storage container | Data residency tootegi |
| 4 | Tenant Management API | Console seedha tenant DB kholta hai (`runAsTenant`) | Cross-border DB access, GDPR ke liye theek nahi |
| 5 | Regional app → control plane | Har request registry padhti hai (30 sec cache) | Cross-region latency. Read replica ya cache chahiye |
| 6 | Container Apps replicas | Lockout, throttle, TOTP, chat ka state ek container mein (`cluster/hub.ts`) | Kai replica pe lockout bypass aur chat loss. Redis ya PG NOTIFY chahiye |
| 7 | Alag regions | Migrations aur ticks ek jagah se | 5 region × saare tenant DB × 458 migrations ka pipeline |

### Business aur kharcha
- Product India ke liye bana hai (GST, e-invoice, TDS, PF/ESI). Germany, UAE aur USA mein Books aur People bina local tax/payroll ke nahi bikenge.
- Kharcha: Front Door Premium (~$330/mahina base) + 5× Postgres + 5× DR + 5× Container Apps, yaani bina customer ke ~$2,000–3,000/mahina.
- 5 region ka monitoring, backup, migration aur on-call chhoti team ke liye bhaari hai.
- Diagram mein Singapore "same-region zone recovery" hai aur baaki cross-region DR. RPO/RTO ek jaisa tay karna chahiye.

### Recommendation: phases
- **Phase 1 (abhi):** Control plane alag + sirf India data plane (DR: Central India → South India). CDN/WAF ke liye ek chuno, Cloudflare pehle se integrated hai.
- **Phase 1 ke saath code region-ready banao:** region-wise provisioner, region-wise storage, routing design, cross-replica state (Redis/NOTIFY), console → tenant ke liye regional API.
- **Phase 2:** doosra region tab, jab asli customer ya contract maange (UAE/Singapore pehle, Germany GDPR enterprise ke saath).
- **Phase 3:** USA, jab wahan ka product (tax/payroll) taiyaar ho.

---

## 6. Final faisla aur chal raha kaam

**Request:** "abhi sirf India rakh kr code mein se admin console ko alag kro taaki vo VM pr host kr sku, admin console ka database alag hoga, but vo main CRM ko billing and all control kr payega jaise abhi kr rha hai, bs different VM pr run hoga and different domain pr host hoga"

### Requirements
1. Sirf India region.
2. Admin console alag VM pe.
3. Admin console **alag domain** pe (sirf `admin.deskzo.com` nahi, koi bhi domain).
4. Admin ka apna database (control DB alag Postgres server pe).
5. Console CRM ko billing, plans, hold aur baaki sab pehle jaisa control kare.

### Ab tak code mein kya mila
- **Host classification** `src/lib/tenancy/host.ts` mein hai: `classifyHost()` sirf `admin.<PLATFORM_DOMAIN>` ko `console` maanta hai. Alag domain ke liye naya env chahiye, jaise `PLATFORM_CONSOLE_HOST`.
- **Hardcoded console address** src mein sirf ek jagah hai: `src/lib/platform/staff.ts:32` (`admin.${PLATFORM_DOMAIN}`, staff setup links ke liye). Ek mail template mein example link hai: `src/lib/console-shared/mail-templates/staff-partners.ts:30`.
- **`kind === "console"` use hota hai:**
  - `src/proxy.ts:228` (platform API ticks), `:262` (console folder routing), `:445`
  - `src/lib/tenancy/certificates.ts:20` (TLS certificate allow)
  - `src/lib/tenancy/host.ts:115` (forwarded host check)
  - `src/lib/tenancy/log-labels.ts:47`
  - `src/lib/platform/fanout.ts:131` (ticks saare workspaces ke liye)
  - `src/lib/billing/platform-request.ts:12` (Stripe/Razorpay webhooks)
- Check suites aur pentest `admin.localhost:3000` use karte hain. Default behaviour same rakhna hai taaki ye na tootein.

### Planned code changes (abhi baaki)
1. **Alag console domain:** `PLATFORM_CONSOLE_HOST` env (jaise `console.deskzoadmin.com`). `classifyHost()` ise `console` maane. Unset ho to `admin.<domain>` jaisa abhi hai. Ek helper `consoleHost()` banao aur `staff.ts:32` usse badlo.
2. **Deployment role:** `DESKZO_SERVES=all|app|console` env.
   - `app` (VM-1): sirf workspaces aur public site. Console, CMS aur partners ke hosts pe 404, taaki DNS galat hone par bhi console CRM VM pe na khule.
   - `console` (VM-2): sirf console, CMS, partners, ticks aur billing webhooks. Workspace hosts pe 404.
   - `all` (default): jaisa abhi hai.
3. **TLS/certificates:** har VM sirf apne hosts ke certificate le (`certificates.ts`).
4. **Deploy files:** `deploy/split/` mein VM-1 aur VM-2 ke compose files, Caddyfiles aur `.env` templates.
5. **`crm_app` role:** CRM ki control-DB writes ki list nikalo aur SQL grant script banao.
6. **Docs:** `docs/deploy-split.md` mein poore setup ke steps (DB-A, DB-B, VNet, NSG, migrations, worker, backup).
7. **Verify:** `tsc`, touched files pe ESLint, aur related check suites (`check:console`, `check:billing`, `check:fanout`, `check:domains`, `check:tenancy-isolation`, `pentest`). Inke liye Postgres chahiye.

---

## Useful commands

```bash
npm ci
npx next typegen && npx tsc --noEmit
npx eslint src/lib            # folder-wise lint
npm run tenants:migrate       # sirf admin VM se
npm run platform:worker       # sirf admin VM pe
```
