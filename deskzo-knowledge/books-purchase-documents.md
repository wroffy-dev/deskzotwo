# Purchase Documents — Deskzo

Purchase Documents holds the purchase orders you send to vendors and the vendor bills they send back, plus Reconciliation of a distributor's monthly statement against your orders. It is part of Deskzo Books, Deskzo Inventory and Deskzo One. Lists are under Accounts → Purchase Orders, Accounts → Vendor Bills and Accounts → Reconciliation.

## Q: What is Purchase Documents in Deskzo?
A: Purchase Documents is the buying side of your paperwork. A **Purchase order** is what you send to a vendor or distributor. A **Vendor bill** is the invoice the vendor sends back. When the vendor's invoice arrives, you convert the purchase order into a bill, so the two stay linked. Both start as drafts and become final when issued. A purchase order posts nothing to the books. A vendor bill is posted when issued.

## Q: I can't see Purchase Orders or Vendor Bills in my menu. Why?
A: Check with your admin. First, your plan must include Purchase Documents (Deskzo Books, Deskzo Inventory or Deskzo One). Second, Purchase Documents must be switched on in **Settings → Modules**. Third, your role needs **View quotes & invoices**, and the **Accounts › Purchase Documents** menu section must not be unticked, in **Settings → Roles & Permissions**. Reconciliation also needs **Reconcile vendor statements**.

## Q: Who can create purchase orders and vendor bills?
A: Purchase orders need **Raise purchase orders** (Purchase, Accounts and Management by default). Vendor bills need **Raise and issue sales documents**, because a bill posts to the books. Cancelling a vendor bill, marking it paid by hand, or deleting a draft bill needs **Delete or cancel a sales document**. Reconciliation needs **Reconcile vendor statements**.

## Q: How do I create a purchase order?
A: You need **Raise purchase orders**.
1. Go to **Accounts → Purchase Orders** and click **New purchase order**.
2. Under **Vendor name**, search and pick the vendor. Choose a **Location on file** and check the **Place of supply**.
3. Under **Document details**, set the **Date**, **Due date** and the **Buying branch** if you have several.
4. Fill in the **Item table**: item, **Quantity**, **Rate**, **Discount** and **Tax** on each line.
5. Click **Save purchase order**, check it with **Preview PDF**, then click **Issue**.

## Q: How do I raise a PO to a vendor?
A: A PO is a purchase order. Go to **Accounts → Purchase Orders**, click **New purchase order**, pick the vendor, set the dates, add the item lines, and click **Save purchase order**, then **Issue**. You can also create one from a customer order: click **Create vendor PO** in the order's **Purchasing** box. You need **Raise purchase orders**.

## Q: Can I create a purchase order from a customer order?
A: Yes. On an order in **Accounts → Orders**, after purchase saves the vendor and price, click **Create vendor PO** in the **Purchasing** box. A draft purchase order is made for that vendor and price, delivered to your own address. Issuing it puts its number into the order's **Our PO to vendor**. Cancelling it takes the number out again. You need **Raise purchase orders** and **Process orders (purchasing)**.

## Q: How do I record a vendor bill?
A: You need **Raise and issue sales documents**.
1. Open the issued purchase order and click **Convert to vendor bill**. A draft bill is made with the same vendor, branch and lines, dated today.
2. Open the bill from **Related documents** and click **Edit**. Check the lines, amounts and **Due date** against the vendor's invoice.
3. Click **Save changes**, then **Issue**.
For a bill without a purchase order, go to **Accounts → Vendor Bills** and click **New vendor bill**.

## Q: I can raise purchase orders, so why can't I record the vendor's bill?
A: A vendor bill posts to the books. So recording a bill, or converting a purchase order into one, needs the **Raise and issue sales documents** permission, not **Raise purchase orders**. Ask your admin to add it to your role in **Settings → Roles & Permissions**.

## Q: How do I pay a vendor bill?
A: Open the issued bill in **Accounts → Vendor Bills**. In its **Paid to vendor** panel, click **Record a payment**. Fill in the **Amount**, **Paid on**, **Method** and **Reference**, then click **Record payment**. The bill becomes Partially paid or Paid as payments are recorded. See the Payables guide for more.

## Q: I marked a bill Paid, but no payment shows anywhere. Why?
A: **More → Paid** only changes the bill's status. It takes the bill off Payables but records no payment and posts nothing to the books. To record money that actually went out, open the bill and use **Record a payment** in its **Paid to vendor** panel.

## Q: How do I confirm or cancel a purchase order?
A: Open the issued purchase order and click **More**. Choose **Accepted** when the vendor confirms it, or **Cancelled** if it won't go ahead. When cancelling, write a **Reason for cancelling**. The reason is kept with who cancelled it and when. A draft is removed with **More → Delete draft**.

## Q: Why can't I edit an issued purchase order?
A: Only a draft can be edited. Once a purchase order is issued it is final. Cancel the issued purchase order with a reason and raise a new one.

## Q: Can I email a purchase order to the vendor?
A: Not from Deskzo. The **Mail** button is only on proposals, proforma invoices, tax invoices, credit notes and debit notes. Open the purchase order, click **Print / PDF**, and send the PDF yourself.

## Q: How do I reconcile a distributor's statement?
A: You need **Reconcile vendor statements**.
1. Go to **Accounts → Reconciliation** and click **Add a statement**.
2. Choose the **Vendor**, give a **Name**, and set **Period from** and **Period to**.
3. Under **These lines are billed**, choose **Monthly**, **Annually** or **One-off**.
4. Tick **This is everything they billed for the period** for a full statement. Leave it unticked for a spot check.
5. **Upload a file** (Excel, CSV or PDF, up to 5 MB), or **Type or paste** the lines and click **Check these against our orders**.
6. Click **Import and reconcile** (or **Save and reconcile**).

## Q: What do the reconciliation results mean?
A: Each statement line is **Matched** or an exception: **Seat mismatch** (quantity differs), **Price mismatch** (price differs from your order), **Billed, not sold** (charged but no live order covers it), **Unknown SKU** (product not in your catalogue), **Unknown customer** (name matches no company), **Ambiguous** (more than one possible match), or **Sold, not billed** (live order missing from a full statement). After you deal with one, click **Clear this**, write what was done, and click **Clear**. **Reopen** puts it back.

## Q: My vendor's PDF statement won't import. Why?
A: A scanned PDF or a photo can't be read. Ask the vendor for an Excel or CSV file, or choose **Type or paste** and enter the lines yourself. Other messages: "Use a .csv, .xlsx or .pdf file." means the file type is wrong, and "That file is over 5MB. Split it and upload in parts." means the file is too big.

## Q: How do I set numbering or approvals for purchase orders?
A: An admin with **Change organisation settings** uses **Settings → Document numbering** (the **Purchase order** and **Vendor bill** rows: Mode, Prefix, Next and Digits) and **Settings → Document approvals** (tick **Require approval** on the Purchase order or Vendor bill card, optionally above a value or discount). **Settings → Document templates** controls how they print.
