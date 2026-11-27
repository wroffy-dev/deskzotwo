# Sales Documents: Proposals, Invoices and Notes — Deskzo

Sales Documents is where you write proposals (quotes), proforma invoices, tax invoices, credit notes, debit notes and delivery challans for customers, with GST worked out on every line. It is part of Deskzo Books (India only) and Deskzo One. Each document type has its own list in the Accounts menu.

## Q: What is Sales Documents in Deskzo?
A: Sales Documents holds what you send to customers: a **Proposal** (a quote), a **Proforma invoice** (a request for payment before supply, not a tax invoice), a **Tax invoice**, a **Credit note** (reduces an issued invoice), a **Debit note** (adds to an issued invoice) and a **Delivery challan** (goods moving but not sold). The lists are in the Accounts menu: **Accounts → Proposals**, **Accounts → Proforma Invoices**, **Accounts → Tax Invoices**, **Accounts → Credit Notes**, **Accounts → Debit Notes** and **Accounts → Delivery Challans**.

## Q: I can't see Sales Documents or Tax Invoices in my menu. Why?
A: Check three things with your admin. First, your plan must include Sales Documents (Deskzo Books or Deskzo One). Second, Sales Documents must be switched on in **Settings → Modules**. Third, your role needs the **View quotes & invoices** permission, and the **Accounts › Sales Documents** menu section must not be unticked, in **Settings → Roles & Permissions**.

## Q: Who can create and issue sales documents?
A: Viewing needs **View quotes & invoices**. Creating, editing, issuing and converting needs **Raise and issue sales documents** (Sales, Accounts and Management by default). Marking a status, cancelling and deleting drafts needs **Delete or cancel a sales document** (Accounts and Management). Emailing needs **Email sales documents to customers**. Which documents you see follows your role's record scope in **Settings → Roles & Permissions**.

## Q: Why is there no New button on the Tax Invoices list?
A: The **New** buttons, **Edit** and **Issue** need the **Raise and issue sales documents** permission. Without it you can read documents but not create one. Ask your admin to add it to your role in **Settings → Roles & Permissions**.

## Q: How do I create a proposal (quote)?
A: You need **Raise and issue sales documents**.
1. Go to **Accounts → Proposals** and click **New proposal**. (On a lead, **Create proposal** starts from the lead's products.)
2. Under **Customer name**, search and pick the customer. Choose a **Location on file** to fill the address and GST details.
3. Check the **Place of supply**. It decides CGST + SGST (same state) or IGST (other state).
4. Under **Document details**, set the **Date**, **Expiry date** and **Reference # / their PO**.
5. In the **Item table**, pick an item on each line and set **Quantity**, **Rate**, **Discount** and **Tax**. **Add new row** adds a line.
6. Fill **Customer notes** and **Terms & conditions**, then click **Save proposal**.
It is saved as a draft. **Preview PDF** shows what the customer will get.

## Q: How do I make a quotation for a customer?
A: A quotation is called a Proposal in Deskzo. Go to **Accounts → Proposals**, click **New proposal**, pick the customer and location, check the place of supply, add item lines with quantity, rate, discount and tax, and click **Save proposal**. Then click **Issue** to make it final, and **Mail** to email it.

## Q: How do I create a tax invoice?
A: You need **Raise and issue sales documents**.
1. Go to **Accounts → Tax Invoices** and click **New tax invoice**.
2. Pick the customer and a **Location on file**, and check the **Place of supply**.
3. Set the date and other document details.
4. Add the item lines in the **Item table**.
5. Click **Save tax invoice**, check it with **Preview PDF**, then click **Issue**.
You can also convert an issued proposal or proforma invoice, or create an invoice from an order.

## Q: How do I issue a document?
A: A document starts as a draft. To issue it:
1. Open the draft and read the **What's next?** line.
2. Click **Preview PDF** to check address, lines and tax.
3. If it needs approval, click **Submit for approval** and wait for an approver to **Approve** it.
4. Click **Issue**. With e-invoicing on, a tax invoice or credit note shows **Issue & generate IRN** instead.
Issuing makes the document final. A tax invoice or credit note is posted to the books when issued.

## Q: Why can't I issue my document?
A: Common messages: "Add at least one line before issuing." means the document has no lines. "Branch X is inactive. Move this draft to an active branch, then issue it." means you must change the branch. "This needs approving first." means the document type needs approval in Settings → Document approvals — click **Submit for approval**. In India, a tax invoice, credit note or delivery challan can't be issued from a branch without an active GST registration.

## Q: Why can't I edit an issued invoice?
A: Only a draft can be edited. The message is "An issued document can't be edited — raise a credit note instead." Once issued, the number is final and the invoice may already be with the GST portal. Raise a credit note or debit note against it, or cancel it and raise a new one.

## Q: How do I turn a proposal into an invoice?
A: Open the issued proposal. When the customer agrees, you can mark it **Accepted** from the **More** menu. Then click **Convert to proforma invoice** (for advance payment) or **Convert to tax invoice**. A new draft is made with the same customer, branch and lines, dated today. Open it from **Related documents**, check it and issue it. A cancelled or rejected document can't be converted.

## Q: How do I raise a credit note?
A: Open the issued tax invoice and click **Convert to credit note**. Or go to **Accounts → Credit Notes**, click **New credit note**, and choose the invoice under **Against invoice**. Change the lines to what is being reduced (a return, a discount, a correction). Save it and click **Issue**. The credit note uses the invoice's branch. To reduce what the customer owes, apply it to the invoice.

## Q: How do I raise a debit note?
A: Open the issued tax invoice and click **Convert to debit note**. Or go to **Accounts → Debit Notes**, click **New debit note**, and choose the invoice under **Against invoice**. Change the lines to what is being added (a higher price, short billing, late-payment interest). Save it and click **Issue**. The customer owes a debit note like an invoice.

## Q: How do I raise a delivery challan?
A: A delivery challan is raised from a consignment. Open the consignment in **IT Assets → Consignments** and click **Raise the challan**. It then appears in **Accounts → Delivery Challans**. A challan carries no tax and is not posted to the books.

## Q: How do I email an invoice to a customer?
A: You need **Email sales documents to customers**.
1. Open an issued proposal, proforma invoice, tax invoice, credit note or debit note and click **Mail**.
2. Under **To**, tick the contacts. Contacts marked **Receives invoices** are labelled.
3. Check the **Subject** and **Message**. **Back to the template** undoes your changes.
4. Click **Send to**. The same PDF as **Print / PDF** is attached.
Each document keeps a history of its emails. Purchase orders and vendor bills have no Mail button.

## Q: Why can't I mark my proposal Accepted?
A: Marking a status (Accepted, Rejected, Expired or Cancelled) needs the **Delete or cancel a sales document** permission. Without it the **More** menu doesn't appear. You can still convert the proposal into a proforma or tax invoice.

## Q: How do I cancel an invoice or delete a draft?
A: You need **Delete or cancel a sales document**. Open the issued document, click **More** and choose **Cancelled**. Write a **Reason for cancelling** and confirm. Cancelling an invoice or credit note reverses its posting in the books. A draft is removed with **More → Delete draft**. A draft that other documents were made from can't be deleted. An invoice with an active IRN must have its e-invoice cancelled first.

## Q: The issue button says the document needs approving. What do I do?
A: The document type has approval switched on in **Settings → Document approvals**, and this document is over the value or discount limit. Click **Submit for approval**. Once an approver clicks **Approve**, **Issue** works. Nobody can approve a document they submitted. If it was rejected, the reason is shown — fix it and submit again. Editing an approved document sends it back for approval.
