# Accounting: reports and closing the books — Deskzo

Deskzo builds financial reports straight from the ledger: Trial Balance, Profit & Loss, Balance Sheet, Cash Flow, Day Book, Cash & bank books and Registers. Close the Books locks a finished period and closes the financial year. These are part of Accounting in Deskzo Books and Deskzo One, for workspaces in India.

## Q: Which financial reports does Deskzo have?
A: Under the **Accounts** menu, Deskzo Accounting has **Trial Balance**, **Profit & Loss**, **Balance Sheet**, **Cash Flow**, **Day Book** and **Registers**, plus **Cash & bank books** under Banking & Cash. Each account also has its own ledger. Reading them needs the **See the books** permission (Accounts and Management roles by default).

## Q: How do I see the Profit & Loss statement?
A: Go to **Accounts → Profit & Loss** in Deskzo. It opens on the current financial year (April to March). Change **From** and **To** at the top right. If your company has more than one branch, choose a **Branch** to see that branch's figures. Select an account name to open its ledger.

## Q: How do I see the Balance Sheet?
A: Go to **Accounts → Balance Sheet** in Deskzo. Change the **As at** date at the top right. The balance sheet is always for the whole company, not one branch. Select an account name to open its ledger.

## Q: How do I see the Trial Balance?
A: Go to **Accounts → Trial Balance** in Deskzo and set the **As at** date at the top right. Select an account name to see its ledger. Alt + T also opens the trial balance.

## Q: How do I see the Cash Flow statement?
A: Go to **Accounts → Cash Flow** in Deskzo and set **From** and **To** at the top right.

## Q: How do I see an account's ledger?
A: In any Deskzo report, select an account's name. The ledger shows the opening balance, every entry against the account with its party, and the running balance. Alt + L also lets you pick an account ledger.

## Q: What is the Day Book?
A: **Accounts → Day Book** in Deskzo lists every entry posted in a date range, whatever created it (invoice, payment, voucher, journal), with its lines. Each row opens the entry and document behind it.

## Q: What are Cash & bank books?
A: **Accounts → Cash & bank books** in Deskzo shows one cash or bank account's receipts and payments, with its opening and running balance. It needs **See the books** or **Manage finance records**.

## Q: What is in Registers?
A: **Accounts → Registers** in Deskzo has the sales and purchase registers with their GST (for one customer or vendor if you pick one), the journal register, expenses by account and month, a GST summary of output against input tax, and a log of who did what to each voucher.

## Q: How do I export a report to Excel or CSV?
A: The Day Book, Registers and Cash & bank books in Deskzo can be exported as CSV by somebody with the **Export financial data** permission. No role has it by default; ask your admin to grant it in **Settings → Roles & Permissions**.

## Q: What does Close the Books do?
A: **Accounts → Close the Books** in Deskzo does two things. The **Period lock** stops anyone posting, reversing or correcting entries dated on or before the lock date. **Financial years** closes a finished year: it moves income and expense balances to Retained Earnings and locks the books to 31 March.

## Q: How do I lock a period?
A: To lock the books in Deskzo:
1. Go to **Accounts → Close the Books**.
2. Under **Period lock**, pick a date in **Lock everything up to and including**.
3. Say **Why** (for example "GST filed to September").
4. Select **Lock**.
You need the **Lock periods and close the year** permission. No role has it by default.

## Q: Why can't I lock this month?
A: Deskzo only lets you lock a period that has finished. The message is "You can't lock a period that hasn't finished." Lock to the end of the last month you have reported or filed.

## Q: How do I remove the period lock?
A: On **Accounts → Close the Books** in Deskzo, someone with **Lock periods and close the year** can remove the lock. Everything becomes postable again. If the Revenue & Close add-on is on, months that the lock no longer covers reopen and must be closed again.

## Q: How do I close the financial year?
A: To close a year in Deskzo:
1. Go to **Accounts → Close the Books**.
2. When a year is over, it appears beside **Ready to close:** under **Financial years**.
3. Select it, read what will happen, and select **Close** with the year.
Deskzo posts one entry that brings every income and expense account back to nil, moves the difference to Retained Earnings, and locks the books to 31 March. A year cannot be closed while it is still running.

## Q: How do I reopen a closed financial year?
A: On **Accounts → Close the Books** in Deskzo, select **Reopen** beside the year, type the year to confirm, and select **Reopen the year**. The closing entry is reversed (not deleted), and the lock moves back to the start of that year. A later closed year must be reopened first.

## Q: It says "Only an admin can close the books."
A: In Deskzo this message means you do not have the **Lock periods and close the year** permission. No role has it by default. Ask your admin to grant it in **Settings → Roles & Permissions**.

## Q: My entry is refused because the books are closed.
A: Deskzo says "The books are closed to … Post this in an open period instead". Nothing dated on or before the lock date can be posted. Post the correction with a date in an open period, or ask someone with **Lock periods and close the year** to move the lock.

## Q: I can't see the reports or Close the Books in my menu.
A: Check with your admin: your plan must include Accounting (Deskzo Books or Deskzo One, India only), it must be switched on in **Settings → Modules**, the Accounting section must not be hidden for your role, and your role needs **See the books** (or **Lock periods and close the year** for Close the Books) in **Settings → Roles & Permissions**.
