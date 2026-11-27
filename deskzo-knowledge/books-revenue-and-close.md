# Revenue & Close — Deskzo

Revenue & Close is an add-on to Accounting. It recognises subscription and service revenue as it is earned (Ind AS 115), spreads prepaid and accrued costs over their months, and gives each month a checklist before the month is locked. It is an add-on for Deskzo Books, included in Deskzo One, for workspaces in India.

## Q: What is Revenue & Close?
A: Revenue & Close in Deskzo does two jobs. First, revenue recognition: when an invoice line has a **Service period** longer than its month, the revenue waits in Deferred Revenue and moves into Sales month by month. Second, the month-end close: prepaid and accrued costs are spread over their months, and each month gets a checklist that mostly checks itself before the month is locked. Its pages are **Revenue**, **Revenue Waterfall**, **Prepaids & Accruals** and **Month-end Close** in the **Accounts** menu under Period close.

## Q: Who can use Revenue & Close?
A: Deskzo Revenue & Close uses these permissions:
- **See revenue schedules and deferred revenue** — read Revenue and Revenue Waterfall (Accounts and Management by default).
- **Manage revenue recognition** — recognise, approve, edit or cancel schedules, and open deferred revenue (no role by default).
- **Work the month-end close** — work Prepaids & Accruals and Month-end Close (Accounts by default).
- **Run the month-end close** — change the checklist and settings, make or stop prepaids and accruals, close or reopen a month (no role by default).
Closing a month also needs **Lock periods and close the year**.

## Q: I can't see Revenue & Close in my menu.
A: Check these with your admin:
1. Your company must have the Revenue & Close add-on (with Deskzo Books, or Deskzo One). It needs Accounting and is only for workspaces in India. It must be switched on in **Settings → Modules**.
2. Your role must not have the Accounts → Revenue & Close section unticked in **Settings → Roles & Permissions**.
3. Your role needs at least one of the permissions: **See revenue schedules and deferred revenue**, **Manage revenue recognition**, **Work the month-end close** or **Run the month-end close**.

## Q: How do I set up Revenue & Close?
A: An admin, or someone with **Run the month-end close**, does this once in Deskzo:
1. Check **Settings → Revenue & Close**: automatic posting, how revenue spreads, and the flux thresholds.
2. Review **Settings → Month-end checklist**. Give tasks owners, and add, reorder or switch off tasks.
3. Bring in older invoices with the **Open deferred revenue** tab on **Accounts → Revenue**.
4. Grant permissions in **Settings → Roles & Permissions**.

## Q: How is a revenue schedule created?
A: In Deskzo, issuing an invoice creates a revenue schedule when an invoice line has a **Service period** that runs past its month (a subscription or annual support), or when a project stage is invoiced before its work is delivered. Schedules made from an invoice start active without approval.

## Q: I issued an invoice but no revenue schedule appeared.
A: Deskzo makes a schedule only for a line with a **Service period** that runs past its month, or for a project stage invoiced before delivery. Everything else is recognised when it is invoiced, as before.

## Q: How do I see deferred and recognised revenue?
A: Go to **Accounts → Revenue** in Deskzo. The **Schedules** tab lists every schedule; narrow it with search, **Status**, **Customer**, **Item**, **From**, **To** or **Pending approval**. Open a schedule to see **Recognised**, **Remaining**, **Credited**, and each month marked **Posted** or **Planned**. The **Roll-forward** tab shows how Deferred Revenue moved in a month, beside the ledger balance.

## Q: What is the Revenue Waterfall?
A: **Accounts → Revenue Waterfall** in Deskzo shows revenue still to be recognised, **By customer** or **By item**, over **12 months** or **24 months**. **Export CSV** needs the **Export financial data** permission. Without it you see "You can read the waterfall but not download it."

## Q: How do I recognise revenue for a month?
A: To recognise revenue in Deskzo:
1. On **Accounts → Revenue**, find the **Recognise revenue** card.
2. Pick the month in **Recognise through**. Only months that have ended are offered.
3. Select **Recognise through** with the month.
Each due month moves from Deferred Revenue to Sales. Running it twice posts nothing twice. Anything not posted is listed under **Left for later** with the reason. With automatic posting on, this also happens each night.

## Q: Why is this revenue schedule recognising nothing?
A: In Deskzo, a schedule made or changed by hand recognises nothing until somebody other than its maker approves it on the **Review** tab of **Accounts → Revenue**.

## Q: How do I approve a revenue schedule?
A: Open the **Review** tab on **Accounts → Revenue** in Deskzo. Its count shows how many are waiting. Open a schedule, check its period, amount and note, and select **Approve**. You need **Manage revenue recognition**.

## Q: Why can't I approve this schedule?
A: In Deskzo you cannot approve a revenue schedule you made or last changed. Somebody else with **Manage revenue recognition** must approve it. Only the super admin may approve their own, and the audit log records that.

## Q: How do I change or cancel a revenue schedule?
A: Open the schedule in Deskzo and select **Edit**. Change **Service from**, **Service to**, the **Amount (₹)**, **Spread evenly by month** or the **Note**, and select **Save** (or **Post and save** if the change moves money now). Months already recognised never change. Changing period, amount or spreading sends the schedule back for approval. To stop it, select **Cancel schedule**, say **Why** and select **Continue**; what it still holds is recognised at once. To give revenue back to a customer, raise a credit note instead.

## Q: How do I bring in invoices issued before Revenue & Close?
A: To open deferred revenue in Deskzo:
1. On **Accounts → Revenue**, open the **Open deferred revenue** tab.
2. Choose the month end to open it at and select **List the invoices**.
3. Tick the service and subscription lines that covered a period, and set each period.
4. Select **Preview**, then **Post**.
The schedules it makes wait on the **Review** tab until somebody else approves them.

## Q: What happens to revenue for a month whose books are locked?
A: Deskzo never posts into a locked period. Revenue for a locked month is caught up in the first open month, and the schedule's month is marked posted there.

## Q: How do I spread a prepaid cost or accrue a cost?
A: To create a prepaid or accrual in Deskzo:
1. Go to **Accounts → Prepaids & Accruals** and select **New schedule**.
2. Choose **Prepaid — paid ahead, expensed over the months** or **Accrual — incurred before its bill arrives**, and give it a **Name**. A prepaid can start **From a vendor bill**.
3. Pick the **Expense account**, where it is **Held in** or **Owed in**, the **Amount (₹)**, the **First month** and the number of **Months**.
4. Check the months, then select **Make the prepaid** or **Make the accrual**.
Each month, under **Post the months that have ended**, pick **Through** and select **Post through**. It is safe to press twice.

## Q: How do I work the month-end checklist?
A: To work the close in Deskzo:
1. Go to **Accounts → Month-end Close**. It opens on the last ended month.
2. On the **Checklist** tab, open a task. Automatic checks say what they found.
3. Select **Mark done**, or **Not applicable…** with a reason and **Mark not applicable**. **Back to to-do** undoes either.
4. Set an **Owner**; they are reminded before the due day and when overdue.
5. Use **Add a note** and **Attach a file** (PDF, Word or an image, up to 4 MB) for evidence.

## Q: What is the Flux tab?
A: The **Flux** tab on **Accounts → Month-end Close** in Deskzo lists accounts that moved a lot against last month. An account is flagged when its change meets both the **Percentage change** and the **Amount (₹)** set in **Settings → Revenue & Close**. For each flagged account, write why it moved and select **Save explanation**.

## Q: How do I close the month?
A: In **Accounts → Month-end Close** in Deskzo, when the checklist is done, select **Close** with the month's name, read what it will do, and select **Lock the books and close**. This moves the books' period lock to the month's last day. If tasks are still open you can use **Close with open tasks…** and write a reason.

## Q: Why can't I close the month?
A: Deskzo shows the reason under the button: the month has not ended, an earlier month is still open, or tasks are still open. Closing also needs both **Run the month-end close** and **Lock periods and close the year**. Without both you see "Closing a month needs both managing the close and closing the books."

## Q: How do I reopen a closed month?
A: In **Accounts → Month-end Close** in Deskzo, select **Reopen** with the month's name and answer **Why reopen it?**. The lock moves back to the previous month's end, and any later closed months reopen too.

## Q: What settings does Revenue & Close have?
A: In **Settings → Revenue & Close** (needs **Run the month-end close**), Deskzo lets you set: automatic nightly posting of revenue and prepaid/accrual months (on at start); how new revenue schedules spread, **By day (exact)** or **Evenly by month**; and the flux thresholds (20% and ₹25,000 at start). Select **Save settings**. Automatic entries show "Posted automatically" in the journal.

## Q: How do I change the month-end checklist tasks?
A: Go to **Settings → Month-end checklist** in Deskzo. **Add a task** asks for the **Task**, **What done looks like (optional)**, an **Automatic check** or **None — ticked by hand**, an **Owner (optional)** and **Due on working day**. You can move tasks, **Edit**, **Deactivate** or **Reactivate** them. Changes apply to months opened from then on.
