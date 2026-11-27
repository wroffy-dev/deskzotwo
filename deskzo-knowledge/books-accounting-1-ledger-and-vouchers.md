# Accounting: ledger, chart of accounts, journal and vouchers — Deskzo

Accounting is the company's double-entry ledger. It fills itself when invoices, bills, payments, expense claims and payroll are recorded, and you can add journal entries and payment, receipt, contra and journal vouchers by hand. Accounting is part of Deskzo Books and Deskzo One, for workspaces in India.

## Q: What is the Accounting module in Deskzo?
A: Accounting in Deskzo is the general ledger. You rarely type entries by hand. Issuing an invoice, a credit note or a vendor bill posts it to the ledger. Recording a payment posts it too. Approving an expense claim and locking a month's payroll post their cost. The pages are under the **Accounts** menu: Overview, Chart of Accounts, Fixed Assets, Vouchers, Journal, Expense claims, Banking, Cash & bank books, GST Returns, TDS, the reports and Close the Books. GST, TDS and the April-to-March financial year are built in.

## Q: Who can see the Accounting pages?
A: Each Deskzo Accounting page needs its own permission:
- Overview, Journal, the reports (Trial Balance, Profit & Loss, Balance Sheet, Cash Flow, Day Book, Registers) and any account's ledger need **See the books** (Accounts and Management roles by default).
- Banking, Fixed Assets, GST Returns and TDS need **Manage finance records** (Accounts and Management by default).
- Writing or reversing journal entries needs **Write and reverse journal entries**. Changing accounts needs **Change the chart of accounts**. Locking periods needs **Lock periods and close the year**. No role has these three by default.
A page you lack the permission for is not in your menu.

## Q: I can't see Accounting in my menu.
A: Check these with your admin:
1. Your company's plan must include Accounting (Deskzo Books or Deskzo One). Accounting is offered only to workspaces in India. It must be switched on in **Settings → Modules**.
2. Your role must not have the **Accounts › Accounting** section unticked in **Settings → Roles & Permissions**.
3. Each link needs its own permission: **See the books** for the statements, **Manage finance records** for Banking, Fixed Assets, GST Returns and TDS.

## Q: What does the Accounting Overview show?
A: **Accounts → Overview** in Deskzo shows this financial year's income, expenses, profit and total assets, and a line saying whether debits equal credits. It also lists filings due soon. You can drag the cards by their handle into the order you like; Deskzo remembers your order.

## Q: The Overview says there are things the ledger never received.
A: In Deskzo, approving an expense claim or locking a payroll run posts to the ledger. If that posting fails, the approval still stands, and the item is listed on **Accounts → Overview**. Select **Post these now** to post them. Posting expense claims needs the **Mark expenses reimbursed** permission.

## Q: What is the Chart of Accounts?
A: The Chart of Accounts in Deskzo is the list of ledger accounts every posting lands in. Groups organise the statements; postings go to the accounts under the groups. A default chart is created the first time anything posts, so invoices reach the books from day one. Open **Accounts → Chart of Accounts** (also listed as **Settings → Chart of accounts**).

## Q: How do I add a new ledger account?
A: To add an account in Deskzo:
1. Go to **Accounts → Chart of Accounts** and select **New account**.
2. Enter a **Code**, a **Name** and a **Type** (Asset, Liability, Equity, Income or Expense).
3. Choose where it **Sits under**, and add **Notes** if you like.
4. Tick **This is a group** only for a heading that takes no postings.
5. Save.
You need the **Change the chart of accounts** permission. No role has it by default.

## Q: Why can't I delete or change this account?
A: Deskzo protects accounts that are in use:
- An account's type cannot change once it has entries ("This account already has entries, so its type can't be changed.").
- An account with entries cannot be deleted. Tick **Archived** instead; it then takes no new entries.
- Accounts used by automatic postings cannot be archived or deleted.
- A group cannot be deleted while accounts sit under it ("Move or delete the accounts under it first.").

## Q: How do I write a journal entry?
A: To post a manual journal entry in Deskzo:
1. Go to **Accounts → Journal** and select **New journal entry**.
2. Set the **Date** and write a **Narration**. Every entry needs one.
3. Choose the **Kind**: **Manual entry** or **Opening balance**.
4. On each line pick the **Account** and type a **Debit** or a **Credit** (not both). Use **Add line** for more lines.
5. With more than one branch or GSTIN, fill in the **Branch** and **GSTIN** columns. A GST line must name its GSTIN.
6. When the total says **Balanced.**, select **Post entry**.
You need the **Write and reverse journal entries** permission.

## Q: Why is there no New journal entry button?
A: In Deskzo, **New journal entry** needs the **Write and reverse journal entries** permission. No role has it by default, so only admins can post journals until an admin grants it in **Settings → Roles & Permissions**.

## Q: Why won't my journal entry post?
A: Deskzo shows the rule that was broken. Common messages:
- "Debits are … and credits are … — they must match."
- "Every entry needs a narration — it's what makes the books readable later."
- "An entry needs at least two lines with an amount."
- "A line carries either a debit or a credit, not both."
- "Say which GSTIN this GST line belongs to."
- "The books are closed to … Post this in an open period instead…"
Also, you cannot post to a group or to an archived account.

## Q: How do I enter opening balances?
A: In Deskzo, post opening balances on **Accounts → Journal**. Either select **New journal entry** and set **Kind** to **Opening balance**, or use **Import opening balances** to bring in a trial balance from your old software as one entry on the day your books start. Import your chart of accounts first; accounts are matched by code, then by name. Importing again replaces the earlier import.

## Q: Can I edit or delete a posted entry?
A: No. The Deskzo ledger is never rewritten. To fix a mistake, reverse the entry and post the correct one. Both stay visible in the Journal. To undo an invoice or bill, cancel the document instead; cancelling reverses its posting for you.

## Q: How do I reverse a journal entry?
A: To reverse an entry in Deskzo:
1. Find it in **Accounts → Journal**. Search by entry number or narration, or narrow by **Source**, **From** and **To**.
2. Select **Reverse** on the entry.
3. Say why it is being reversed.
The reversal is posted as "Reversal of" the original, and the original shows **Reversed by**. An entry can be reversed only once, and a reversal cannot itself be reversed.

## Q: What are vouchers?
A: Vouchers in Deskzo are hand-written accounting entries of four kinds:
- **Payment** — money paid out of a bank or cash account.
- **Receipt** — money received into a bank or cash account.
- **Contra** — money moved between your own bank and cash accounts.
- **Journal** — any other entry, with no bank or cash lines.
Open **Accounts → Vouchers**.

## Q: How do I create a payment or receipt voucher?
A: To write a voucher in Deskzo:
1. Go to **Accounts → Vouchers** and select **New voucher**.
2. Choose the **Kind**: Payment, Receipt, Contra or Journal.
3. Set the **Date**, a **Narration** and, if you like, a **Reference** and **Party (optional)**.
4. Add lines: an account and a **Debit** or **Credit** on each.
5. Select **Save draft**. A draft changes nothing in the books.
6. Open it and select **Post** — or **Submit for approval** if your company requires approval.
You need **Write vouchers** to create and **Write and reverse journal entries** to post.

## Q: How does voucher approval work?
A: If **Vouchers need approval** is switched on in **Accounts → Accounts settings**, a Deskzo voucher must be submitted with **Submit for approval**. Somebody else with the **Approve vouchers** permission selects **Approve** or **Send back**. Nobody can approve their own voucher ("You can't approve a voucher you wrote — somebody else has to."). After approval, someone with **Write and reverse journal entries** selects **Post**.

## Q: How do I undo a posted voucher?
A: A posted Deskzo voucher is never edited or deleted. Open it and select **Reverse**, pick the **Reverse on** date and say **Why**. The reversal is a dated, opposite entry, and both stay on record. A draft, waiting or approved voucher can be cancelled with **Cancel voucher** instead.

## Q: Do BUSY shortcut keys work in Deskzo?
A: Yes. Deskzo Accounting supports BUSY-style keys, for example Alt + F5 for a payment voucher, Alt + F6 for a receipt, Alt + B for the balance sheet, Alt + T for the trial balance, Alt + L for an account ledger, F2 to save a voucher and F7 to repeat the line above. Press ? outside a text field to see every key. Where BUSY uses Ctrl with a letter, use Alt.
