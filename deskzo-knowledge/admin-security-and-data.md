# Security, Import & Export, and Backups — Deskzo

These admin screens protect a Deskzo workspace and its data: Security & DLP (sign-in rules and data-loss prevention), Import & export, Backups, workspace reset, data migration and API keys. They are part of every Deskzo product. You find them under Administration in the sidebar and in Settings.

## Q: Where are the security settings in Deskzo?
A: Go to Administration → Security & DLP, or Settings → Security & data protection. The screen has cards for Sign-in, Email & sign-in (Microsoft 365, Google Workspace or Zoho), Linked sign-in, Devices, networks & sign-ins, Platform support access, and Data loss prevention. You need the **Change the security and DLP policy** permission, which only a super admin can give.

## Q: How do I make two-factor authentication compulsory for everyone?
A: 1. Go to Administration → Security & DLP.
2. In the Sign-in card, tick **Require two-factor authentication**.
3. Click **Save sign-in settings**.
Every user must then set up an authenticator app before they can use the rest of the app.

## Q: How do I make people sign in with Microsoft, Google or Zoho?
A: 1. Go to Administration → Security & DLP.
2. In the "Email & sign-in" card, connect Microsoft 365, Google Workspace or Zoho and save.
3. Then, in the Sign-in card, tick **Require single sign-on** and save.
Password sign-in is then switched off for everyone except admins. You must connect a provider first; otherwise the option asks you to do that.

## Q: What is data loss prevention (DLP) in Deskzo?
A: DLP settings stop data leaving the workspace. They are on Administration → Security & DLP under "Data loss prevention". **Enforced** settings run on the server: export row limit, unusual read-volume alerts, crawler blocking, how long activity logs are kept, asking for a reason before exporting, and logging every page view. **Deterrent** settings run in the browser: block copying, cutting, pasting, selecting text, the right-click menu and printing, report developer tools, hide the screen when the window is not in front, limit screenshots per day, and watermark the screen with the viewer's name. You choose who the deterrents apply to. Click **Save security policy**.

## Q: Can Deskzo completely stop screenshots?
A: No. The screenshot limit is a deterrent. It only catches the PrintScreen key inside the page. Tools like the Windows snipping tool or a phone camera never reach the page. For a stronger deterrent, switch on **Watermark the screen with the viewer's name**.

## Q: How long are activity logs kept?
A: You choose it on Administration → Security & DLP in "Keep activity logs for (days)". The minimum is 30 days. Deskzo also keeps a sealed copy of sign-ins and activity for a year outside the app, as Indian law (CERT-In) requires; your setting does not shorten that copy.

## Q: How do I control which devices and networks people can sign in from?
A: Go to Settings → Devices, networks & sign-ins. Set rules **By role** and **By person**, and list your **Networks**. You can approve or reject devices waiting for approval, and see where everybody signed in from, with filters like "Anything unusual", "Impossible travel", "New network" and "New device". Changing rules needs **Change the security and DLP policy**. Approving devices needs **Approve devices** (nobody can approve their own). Seeing sign-in locations needs **See where people sign in**.

## Q: How do I lock a person out of Deskzo?
A: 1. Go to Settings → Account locks.
2. Choose the **Person** and write the **Notice they see**. Optionally set an end time.
3. Lock them.
They can still sign in but see only your notice on every page until you lift the lock or the time passes. You need the **Lock people out of the CRM** permission. You cannot lock yourself or the super admin. Only the super admin can lock the whole company.

## Q: How do I let Deskzo support look inside my workspace?
A: Only the super admin sees the "Platform support access" card on Administration → Security & DLP. Choose **What they can do** ("Look only — read-only" or "Change things — an administrator's access"), how long, and **What it is for**, then click **Let support in**. Deskzo support cannot see inside your workspace unless you allow it. Access ends by itself after the time you chose, or when you click **End support access now**. Everything they do is in the activity log under their own name.

## Q: How do I export my data to Excel or CSV?
A: 1. Go to Administration → Import & export.
2. Find the area, for example Companies, Leads, Ledger or People.
3. Click **Excel** or **CSV**.
You only get the records you can already see. You need an export permission for that area: **Export customer data**, **Export financial data**, **Export the catalog**, **Export employee data** or **Export user accounts**. Salary figures and bank details are never included in employee exports.

## Q: How do I import records from a CSV or Excel file?
A: 1. Go to Administration → Import & export.
2. Click **Import** beside the area, for example Companies, Contacts, Leads or Items & catalog.
3. Click **Download the template** to get the right column headings.
4. Fill in your file and click **Choose a file**.
5. Check the preview: how many rows are new, changed or unusable.
6. Click **Import … row(s)**.
Nothing is written until you have seen the preview. Records are matched on their key, so importing the same file twice changes nothing the second time. Files can be .csv or .xlsx, up to 25 MB.

## Q: Which permission do I need to import data?
A: Each area needs its own import permission: **Import customer data** (companies, customers, contacts, leads, vendors, resellers, tickets, visits, IT assets and more), **Import financial data** (chart of accounts/ledger and expense claims), **Import the catalog** (items), **Import employee data** (people and hiring) and **Import user accounts** (only a super admin can give this). Without it you see "You can't import …".

## Q: Why can't I import orders, payments or renewals?
A: Orders, renewals, payments and statements of account are export only. An order is the record of a process the app ran, with ledger entries and stock movements, so an imported order would not match the books. A statement is calculated from invoices and payments. Import those records instead, or enter orders through the normal flow.

## Q: Some rows failed during import. What do I do?
A: After the import, Deskzo lists the rows that could not be written, with the row number and the reason. The other rows went in. Fix those rows and import the file again. Nothing duplicates, because matching is by key. If the file is too big you see "That file is over 25MB. Split it and import in batches."

## Q: How do I move my accounts from Zoho Books to Deskzo partway through the year?
A: Go to Administration → Import & export and click "Switching to Deskzo partway through the year?". Choose **Moving from** (Zoho Books, or another system using Deskzo's templates), the date the year started, and the first day in Deskzo. Then bring across, step by step: invoices, credit notes, customer receipts, bills, vendor credits, vendor payments, expenses, manual journals, open quotes, open sales orders and open purchase orders. Each step is checked, and a migration can be undone. You need the Accounting module plus the **Write and reverse journal entries** and **Import financial data** permissions.

## Q: How do I bring data across from our old CRM?
A: The super admin can use Settings → Old CRM migration. It brings customers, contacts, addresses, products, leads, renewals, tickets, field visits and call logs from the old CRM's export. Nothing is written until you see the preview and confirm. A full backup is taken first, and an import can be undone.

## Q: How do backups work in Deskzo?
A: Settings → Backups shows the backup log and lets you take a **Full backup** or an **Incremental** one now. You can switch on "Back up automatically, once a day" and choose how many days to keep. You need the **Take database backups** permission. Downloading a backup needs **Download a backup**; the file is encrypted under a passphrase you choose. Restoring needs **Restore from a backup**. Only a super admin can give the download and restore permissions. Whether backups are managed for you on Deskzo's hosted service: [POLICY: to be filled by Deskzo team].

## Q: What happens when I restore a backup?
A: Restoring replaces everything. The app goes offline while it runs. Every record made since the backup was taken is lost, and there is no undo. Before it starts, Deskzo takes a copy of the workspace as it is now and keeps it 30 days, so you can restore that copy to go back. Only this workspace's own downloaded backups can be restored here.

## Q: How do I reset my workspace and start again?
A: Only the super admin can, from Settings → Backups. Choose **Clear my data, keep my setup** (records go; people, roles, settings, catalogue and templates stay; numbering restarts) or **Start completely fresh** (everything goes except your account and the workspace address, plan and billing). Click **Schedule the reset**. It runs a day later, and every admin who looks after backups is told and can cancel it. A copy is kept 30 days. A reset is refused once e-invoices or e-way bills have been generated, because those records must be kept by law.

## Q: How do I make an API key?
A: Go to Settings → Developers & API. Enter a name in "New key for", choose when it expires, tick what it may touch, and click **Make key**. Copy the key at once — it is shown only once. A key acts as you and can never do more than you can. Click **Revoke** to stop a key; anything using it stops at once. You need the **Make API keys** permission. Security admins see and can revoke everybody's keys.

## Q: I can't see Security & DLP or Import & export in my menu.
A: Security & DLP needs the **Change the security and DLP policy** permission. Import & export appears if you hold any import or export permission. Backups needs **Take database backups**. Ask your workspace admin or super admin.
