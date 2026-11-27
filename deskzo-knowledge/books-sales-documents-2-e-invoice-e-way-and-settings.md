# Sales Documents: e-Invoice, e-Way Bills and Settings — Deskzo

This guide covers India's e-invoice (IRN) and e-way bills for sales documents, and the settings for document numbering, templates, approvals and emails. Sales Documents is part of Deskzo Books (India only) and Deskzo One. e-Invoicing and E-Way Bills are only available to a workspace set up for India.

## Q: What should I set up before issuing my first tax invoice?
A: An admin with the **Change organisation settings** permission fills these in once:
- **Settings → Profile**: legal name, head-office GSTIN, bank accounts, and the invoice defaults (**Default terms & conditions**, **Footer note**, rounding, **Signature / stamp**).
- **Settings → Branches**: each office's GSTIN and state, if you bill from more than one. A branch with no GSTIN or state is taxed as IGST.
- **Settings → Letterhead**: logo and signature block.
- **Settings → Document numbering**: prefix and running number for each document type.
- Your items in **Accounts → Items & Inventory**.

## Q: How do I generate an IRN (e-invoice) for a tax invoice?
A: First an admin turns on **Generate e-invoices automatically when an invoice is issued** in **Settings → e-Invoicing** and sets up the portal connection. Then, when you issue a tax invoice or credit note, the button reads **Issue & generate IRN**, and Deskzo reports it to the government portal in the same step. Invoices below the **Minimum invoice value** skip IRN generation. You need **Raise and issue sales documents**.

## Q: How do I set up e-invoicing?
A: Go to **Settings → e-Invoicing** (needs **Change organisation settings**). Tick **Generate e-invoices automatically when an invoice is issued** and optionally set a **Minimum invoice value**. Each GST registration has its own connection: choose the **Provider** (Mock for testing, NIC sandbox or NIC production) and, for NIC, enter the portal username, password, client ID and client secret from your GST portal account. E-way bills use the same login.

## Q: The portal rejected my invoice. What now?
A: The invoice stays issued without an IRN, and the portal's reason is shown in a red box on the invoice. Fix what the reason names — often the connection in **Settings → e-Invoicing** — then click **Retry IRN**. If the mistake is on the invoice itself, the invoice can't be edited. Cancel it and raise a corrected one.

## Q: How do I cancel an e-invoice (IRN)?
A: You need **Delete or cancel a sales document**. Open the tax invoice, click **More → Cancel e-invoice**, choose a **Reason** and type a **Remark**. The portal only allows this within 24 hours of the IRN. After 24 hours the message is "The 24-hour cancellation window has passed — raise a credit note instead." An invoice with an active IRN can't be marked Cancelled until its e-invoice is cancelled.

## Q: How do I raise an e-way bill?
A: You need the **Process orders (purchasing)** permission.
1. Open the issued tax invoice, credit note or delivery challan. Its **E-way bill** panel says if a bill is needed.
2. Click **Transport details** and fill in **Value of the goods**, **Distance**, **Transporter**, **LR / consignment note**, **Mode**, **Vehicle** and **Vehicle number**, then **Save**.
3. Click **Raise the e-way bill**.

## Q: Where do I see all e-way bills?
A: Go to **Accounts → E-Way Bills**. It lists every document that carries goods. Tabs: **Needs a bill**, **Live**, **Expired**, **Cancelled** and **All**. A bill raised on the government portal directly can be added with **Record one from the portal**. On a live bill you can **Add the vehicle** or **Change the vehicle**, and **Cancel the bill** within 24 hours of raising it.

## Q: I can't see E-Way Bills in my menu. Why?
A: E-Way Bills shows only when: your plan includes Sales Documents (Deskzo Books or Deskzo One); Sales Documents is switched on in **Settings → Modules**; your workspace is set up for India; and your role has the **Process orders (purchasing)** permission in **Settings → Roles & Permissions**. Ask your admin.

## Q: How do I switch on e-way bills?
A: Go to **Settings → e-Way bills** (needs **Change organisation settings**) and click **Enable**. E-way bills sign in with each GSTIN's e-invoicing login, so e-invoicing must be set up first. **Threshold within the state** sets a limit for movements inside the state. Left blank, the central ₹50,000 applies, and **Use the central threshold** puts it back. Transporters are kept under **Manage**.

## Q: How do I change invoice numbering?
A: Go to **Settings → Document numbering** (needs **Change organisation settings**). Each document type has a row: **Mode** (Auto or Manual), **Prefix**, **Next** number and **Digits**, with a **Preview**. In a prefix, {FY} becomes the financial year and {FY2} its short form; {GST} and {BR} print the GST registration's and branch's code. Tax invoices, credit notes and delivery challans must fit GST's 16-character limit. A number already issued never changes.

## Q: Can each branch have its own invoice number series?
A: Yes. With more than one branch or GST registration, each document type in **Settings → Document numbering** can count numbers for the whole company, per GST registration, or per branch. The gear beside the number on a document opens the same number preferences.

## Q: How do I change how my invoice looks when printed?
A: Go to **Settings → Document templates** (needs **Change organisation settings**).
1. Find the card for the document type. **Standard (built in)** is the default.
2. Click **Customise** for an editable copy, or **New template** to start from Standard, Modern, Compact or another template.
3. Set **Layout & style** (layout, accent colour, font), **Text & labels**, and switch parts off under **What to show**.
4. Choose the **Paper size** and click **Save template**.
5. Click **Set as default** to use it for every document of that type.
What GST requires (GSTIN, HSN codes, tax rates, place of supply, QR code, signatory) always stays on the page.

## Q: How do I make invoices need approval before issuing?
A: Go to **Settings → Document approvals** (needs **Change organisation settings**). Tick **Require approval** for a document type. Optionally limit it to documents **Only when worth more than (₹)** an amount (total including GST) **Or when any line is discounted more than (%)**. Leave both blank and every one needs approval. Choose approvers: **Anyone holding these roles**, **And these people by name**, and **The submitter's manager can approve**. Nobody approves what they submitted.

## Q: How do I change the email text sent with invoices?
A: Go to **Settings → Document emails** (needs **Change organisation settings**). Each emailable type has a tab with the **Subject** and **Message** that the **Mail** button fills in, a **Preview** and the **Fields you can use**. **Back to the built-in wording** undoes your changes.

## Q: Where are invoice emails sent from?
A: In **Settings → Document emails**, **Send documents from** has three choices: **Each person's own mailbox**, **The company's mail server**, or **Their own mailbox if connected, otherwise the company's**. If the chosen way isn't set up, documents go through Deskzo's mail service in the sender's name, within a daily limit. The top of the Mail dialog shows which route is used.

## Q: How do I set default terms and a footer on all invoices?
A: Go to **Settings → Profile**, under invoice defaults. **Default terms & conditions** are pre-filled on every new document and can be changed on each one. The **Footer note** prints at the bottom of every document. **Signature / stamp** is the image printed on documents. **Round document totals to the nearest rupee** adds a round-off line; turn it off to bill to the paisa.

## Q: How is CGST, SGST or IGST decided on an invoice?
A: The **Place of supply** on the document decides it. If the place of supply is in the same state as your billing branch, the tax is CGST + SGST. If it is in another state, the tax is IGST. Picking a **Location on file** for the customer fills the place of supply. A branch with no GSTIN or state in **Settings → Branches** is taxed as IGST, and the form warns you.
