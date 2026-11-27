# Accounting: banking, fixed assets, expense claims, GST and TDS — Deskzo

These Accounting pages keep the books correct: Banking reconciles the books with the bank statement, Fixed Assets keeps the asset register and depreciation, Expense claims pays back approved claims, and GST Returns and TDS prepare the tax figures. They are part of Deskzo Books and Deskzo One, for workspaces in India.

## Q: Who can use Banking, Fixed Assets, GST Returns and TDS?
A: In Deskzo these Accounting pages need the **Manage finance records** permission. The Accounts and Management roles have it by default. Without it, the links are not in your menu. Ask your admin to grant it in **Settings → Roles & Permissions**.

## Q: How do I add a bank account?
A: To add a bank account in Deskzo:
1. Go to **Accounts → Banking** and select **Add an account**.
2. Enter the **Name**, **Bank**, **Branch**, **Account number** and **IFSC**.
3. Save.
Each bank account gets its own ledger account and reconciles against its own statement. The first one you add takes over the single bank account used before, so nothing already posted moves. An IFSC must look like HDFC0001234.

## Q: How do I change the default bank account or stop using one?
A: Go to **Accounts → Banking** in Deskzo and select the account. Use **Make … the default** to make it the default. Use **Stop using …** for an account the company has closed; it stays on past transactions but leaves the lists for new ones. The default account cannot be stopped ("That's the default account. Make another one the default first.").

## Q: How do I reconcile a bank account?
A: To reconcile a bank in Deskzo:
1. Go to **Accounts → Banking** and select the bank account.
2. Select **Import a statement** and choose the bank's CSV file. It needs a header row, a date column, and an amount column or separate withdrawal and deposit columns. Rows already imported are skipped.
3. Type the **Closing balance on the statement** and select **Compare**.
4. Read **Books say**, **Bank says**, **Adjusted for what's in flight** and **Difference**.
5. Select **Match** on suggested pairs, or **Accept all**.
6. Record anything left unmatched, such as bank charges or interest.
7. Select **Sign this off**. Deskzo records the date, both balances and the difference.

## Q: The books and the bank statement don't agree.
A: In Deskzo Banking, first clear the cheques the bank has cleared under **Cheques that haven't cleared** (pick the date and select **Cleared**). Then import the latest statement and match the rows. What is left unmatched is usually bank charges or interest nobody recorded. You can still sign off a reconciliation with a difference; it is recorded as it is.

## Q: How do I clear a cheque?
A: In **Accounts → Banking** in Deskzo, cheques wait under **Cheques that haven't cleared**. Pick the date the bank cleared each one and select **Cleared**. This moves the money into the bank account. A cheque cannot clear before the day it was written.

## Q: How do I add a fixed asset?
A: To add an asset in Deskzo:
1. Go to **Accounts → Fixed Assets** and select **Add an asset**.
2. Fill in the **Tag** (the label on the item), **What it is**, **Bought on** and **Cost**.
3. Choose the **Method**: **Straight line** needs a **Useful life (years)**; **Written down value** needs a **Rate (% a year)**.
4. Optionally add a **Salvage value**, the account it **Sits in**, a **Cost centre** and who it is **Held by**.
5. Select **Add**.

## Q: How do I charge monthly depreciation?
A: In **Accounts → Fixed Assets** in Deskzo, pick the **Month** and **Year** at the top (last month is chosen for you), check the preview, and select **Charge**. A month can be charged only after it is over ("That month isn't over yet."). Running it twice does not charge twice.

## Q: How do I sell or scrap a fixed asset?
A: In **Accounts → Fixed Assets** in Deskzo, select **Dispose** on the asset's row. Enter **Disposed on** and what it was **Sold for** (zero if scrapped), and select **Dispose**. Deskzo works out the gain or loss from the asset's book value.

## Q: How do I pay back approved expense claims?
A: To reimburse claims in Deskzo:
1. Go to **Accounts → Expense claims**. **To pay** lists every approved claim owed to somebody, with who approved it and its ledger entry.
2. Tick the claims you have paid.
3. Type the **Payment reference**, pick the **Paid on** date, and select **Mark … paid**.
The claims move to **Paid**, the payment is posted, and the claimants are told. **Company paid** lists approved spend nobody is owed. You need the **Mark expenses reimbursed** permission.

## Q: Who can see Accounts → Expense claims?
A: In Deskzo, **Accounts → Expense claims** needs **Mark expenses reimbursed** (to pay claims) or **View all company expenses** (to read only). Accounts and Management have both by default. The Expenses module must also be switched on.

## Q: How do I prepare the GST returns?
A: To prepare GST figures in Deskzo:
1. Go to **Accounts → GST Returns**. It opens on last month.
2. Change the **Month** and **Year** if needed. With more than one registration, choose the **GST registration**; each return is per GSTIN.
3. Read the warnings first. Red means the return shows more output tax than the ledger supports. Amber lists other problems the GST portal may reject.
4. Check **GSTR-3B — what's payable** and **GSTR-1 — what was supplied** (B2B invoice by invoice, B2C as totals, with the HSN summary).
Deskzo prepares and checks figures; you file the return on the GST portal.

## Q: Can I download GSTR-1 and GSTR-3B as JSON for the GST portal?
A: Yes. On **Accounts → GST Returns** Deskzo offers download buttons for GSTR-1 and GSTR-3B as the portal's JSON file. Open it in the GST offline tool to check, then upload it on the portal.

## Q: How do I match GSTR-2B with my purchase bills?
A: On **Accounts → GST Returns** in Deskzo, use **Reconcile with GSTR-2B**. Download GSTR-2B from the GST portal as JSON and select **Upload GSTR-2B JSON**. Each vendor invoice is matched to a bill by the vendor's GSTIN and invoice number. You see credit on bills vendors have not reported, and credit in 2B with no bill entered. Nothing is saved; select **CSV** to download the result.

## Q: GST Returns says there is no GST registration.
A: Deskzo prepares GST returns per GSTIN. Ask an admin to add the head office's GSTIN in **Settings → Profile**, or a branch's GSTIN in **Settings → Branches**.

## Q: How do I check the month's TDS?
A: To review TDS in Deskzo:
1. Go to **Accounts → TDS** and pick the month.
2. Read **We deducted, and owe** (payable to the government), **Customers withheld from us** and **Due on** (the 7th of the next month).
3. Check the **Deducted from vendors** and **Withheld by customers** tables. A party with no PAN shows **missing**; fix it before filing.
Figures come from TDS on issued invoices and vendor bills dated in the month. Drafts and cancelled documents are left out.

## Q: How do I record a TDS challan?
A: On **Accounts → TDS** in Deskzo, the **Deposits** section groups the month's deductions by section and head. Select **Record challan** on a row, check the deductions, tax and interest, pick the bank account, and select **Save challan**. The page also offers the quarterly statement file with **Download Form 140 file**.

## Q: Where do I see filing due dates?
A: **Accounts → Overview** in Deskzo shows **Filings due** in the next six weeks and any missed. When you file one, select **Mark filed** and add an optional ARN or challan number. Deskzo uses the government's standard dates and does not know about announced extensions.

## Q: I can't see Banking, GST Returns or TDS in my menu.
A: Check with your admin: your plan must include Accounting (Deskzo Books or Deskzo One, India only), it must be switched on in **Settings → Modules**, the Accounting section must not be hidden for your role, and your role needs the **Manage finance records** permission in **Settings → Roles & Permissions**.
