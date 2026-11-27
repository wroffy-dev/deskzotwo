# Troubleshooting: Books and Finance — Deskzo

Common Deskzo messages in Items & Inventory, Orders, Sales Documents, e-invoices, Payments, Receivables, Accounting, Close the Books, Month-end Close and Expenses. Deskzo Books is sold in India.

## Q: Deskzo says "Not enough stock — only X on hand."
A: The Deskzo stock movement would take stock below zero, or into stock reserved for orders. Check the quantity and warehouse. If goods arrived but were not recorded, record the goods receipt first. An admin can allow negative stock in **Accounts → Accounts settings**, but never for batch items.

## Q: Deskzo says "An issued document can't be edited — raise a credit note instead."
A: In Deskzo, only draft documents can be edited. For an issued invoice, raise a credit note or debit note, or cancel it and issue a new one.

## Q: Deskzo says "Add at least one line before issuing."
A: The Deskzo document has no item lines. Add at least one line in the item table, then issue it.

## Q: Deskzo says "Branch X is inactive. Move this draft to an active branch, then issue it."
A: The Deskzo draft belongs to a branch that was switched off. Edit the draft, choose an active branch, then issue it.

## Q: Deskzo says "The 24-hour cancellation window has passed — raise a credit note instead."
A: An e-invoice (IRN) can only be cancelled within 24 hours. After that, raise a credit note in Deskzo instead.

## Q: Deskzo says "This order isn't ready for purchasing yet — it needs accounts approval first."
A: A Deskzo order must be approved by accounts before purchase can process it. Ask accounts to approve the order. If the order is held, sales must also send it to purchase.

## Q: Deskzo says "That order is cancelled — record the payment on account instead."
A: You cannot apply money to a cancelled Deskzo order. Record the payment as a lump sum (on account) and allocate it to another order or invoice later.

## Q: Deskzo says "Only X is unallocated on this payment."
A: You tried to allocate more than is left on the Deskzo payment. Allocate a smaller amount, up to the unallocated balance.

## Q: Deskzo says "Only ₹… is outstanding on this invoice. Record the excess as a separate payment so it stays unapplied."
A: The payment is more than the Deskzo invoice balance. Record the balance against the invoice, and record the rest as a separate payment under Payments.

## Q: Deskzo says "This credit note is already applied to that invoice — remove it first to change the amount."
A: Remove the existing Deskzo credit note application first (this needs the **Delete payments** permission), then apply the new amount.

## Q: Deskzo says "Debits are … and credits are … — they must match."
A: The Deskzo journal entry or voucher is not balanced. Change the line amounts until the total says Balanced.

## Q: Deskzo says "The books are closed to …. Post this in an open period instead."
A: The date is inside a locked Deskzo period. Use a date in an open period, or ask someone with **Lock periods and close the year** to move the lock.

## Q: Deskzo says "You can't lock a period that hasn't finished."
A: A Deskzo period lock must be at the end of a month that is already over. Choose an earlier date.

## Q: Deskzo says "Only an admin can close the books". I am not an admin.
A: To close the Deskzo books you need the **Lock periods and close the year** permission. Ask your admin to give it to your role.

## Q: Deskzo says "Closing a month needs both managing the close and closing the books."
A: To close a month in Deskzo Month-end Close, you need both **Run the month-end close** and **Lock periods and close the year**. Ask your admin.

## Q: Deskzo says "That receipt is over 512KB — use a smaller file."
A: A Deskzo expense receipt can be up to 512 KB, as PNG, JPEG, WebP or PDF. Use a smaller photo or a lower-quality PDF.

## Q: Deskzo says "Submitted, but there's nobody to route it to".
A: Your Deskzo expense claim was submitted, but you have no reporting manager and nobody else can approve claims. An admin should set your reporting manager in Settings → Users, or give someone **Approve or reject expense claims**.

## Q: Why can't I import orders, payments or renewals into Deskzo?
A: In Deskzo, orders, renewals, payments and statements of account are export only. Import invoices, receipts and other records instead, or enter orders through the normal order flow.

## Q: My item import skipped some rows in Deskzo. Why?
A: Deskzo lists each skipped item row with its reason. Common reasons: the row names a brand, family or category that is not on your list and you do not have **Manage brands, families & industries**; or, in India, the HSN/SAC code is missing, the wrong kind, or not in the GST portal's list. "File is too large (max 2MB)" means the item file must be smaller. Fix the rows and import them again.

## Q: I can't see Accounts or Tax Invoices in my Deskzo menu.
A: Deskzo Books must be in your plan, the module must be switched on in Settings → Modules, and your role needs the right permission. Ask your Deskzo admin. Deskzo Books is only sold in India.
