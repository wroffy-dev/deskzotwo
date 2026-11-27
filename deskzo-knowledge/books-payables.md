# Payables and vendor credits — Deskzo

Payables shows what you owe vendors, aged from each bill's due date, and lets you record the payments that settle bills. Vendor credits records credit notes and rebate payouts from distributors and OEMs. Payables is part of Deskzo Books and Deskzo One.

## Q: What is Payables in Deskzo?
A: Payables is the mirror of Receivables. It shows one row per vendor you still owe, with their bills grouped by how late they are: **Not yet due**, **1–30 days**, **31–60 days**, **61–90 days** and **90+ days**. A bill ages from its due date, or from its bill date if it has no due date. It is the list you plan a payment run from. Open it from **Accounts → Payables**.

## Q: How do I see what we owe vendors?
A: To see what you owe in Deskzo:
1. Go to **Accounts → Payables**. The cards show **Total owed**, **Overdue**, **Not yet due** and **Over 90 days**.
2. Type in **Search vendor name…** to find one vendor.
3. Select a vendor to open their page, and their bills from its Documents tab.
Payables also has **Aging report** and **Balance summary** views.

## Q: How do I pay a vendor bill?
A: To record a payment out against a bill in Deskzo:
1. Open the issued bill under **Accounts → Vendor Bills**.
2. In its **Paid to vendor** panel (Billed, Paid, Credited, Balance), select **Record a payment**.
3. Fill in the **Amount**, **Paid on**, **Method** and **Reference**.
4. For a bill in another currency, enter the **Amount paid** in that currency and the **Rate on the day**.
5. Select **Record payment**.
The bill becomes Partially paid, or Paid when nothing is left, and then drops off Payables. The payment is posted to the books. You need the **Record payments** permission.

## Q: How do I record a payment made to a supplier?
A: In Deskzo, a supplier payment is recorded on the supplier's bill. Open the bill from **Accounts → Vendor Bills**, select **Record a payment** in the **Paid to vendor** panel, fill in **Amount**, **Paid on**, **Method** and **Reference**, and select **Record payment**. You need the **Record payments** permission.

## Q: What is the difference between Record a payment and marking a bill Paid?
A: In Deskzo, marking a bill Paid from its **More** menu (under **Mark as**) takes it off Payables but records no payment and posts nothing to the books. **Record a payment** in the **Paid to vendor** panel records the money that actually went out and posts it to the ledger. Use **Record a payment** for real payments.

## Q: A bill I have paid still shows on Payables.
A: Deskzo Payables lists every issued bill that is not fully paid or cancelled. Open the bill and check its **Paid to vendor** panel. The payment must be recorded on the bill with **Record a payment**. A part payment leaves the rest outstanding.

## Q: Why is there no Record a payment button on the bill?
A: In Deskzo, **Record a payment** needs the **Record payments** permission (Accounts and Management roles by default). The button is hidden when the bill is already settled in full. A draft bill or a cancelled bill has no Paid to vendor panel. The message "Record the bill before paying it." means the bill is still a draft.

## Q: It says only part of the amount is outstanding on this bill.
A: A payment against a Deskzo bill cannot be more than its balance. The message reads "Only ₹… is outstanding on this bill. Record the excess as a separate payment." Record the bill's balance, and anything extra as a separate payment.

## Q: What are vendor credits?
A: Vendor credits in Deskzo are what distributors and OEMs give back: a credit note that reduces what you owe them, or a rebate paid into your bank. Each vendor credit is posted to the books when you record it. It can be set against the backend rebates expected on your orders and, for a credit note, against the vendor's open bills. Open **Accounts → Vendor credits**.

## Q: How do I record a credit note or rebate from a vendor?
A: To record a vendor credit in Deskzo:
1. Go to **Accounts → Vendor credits** and select **Record a credit**.
2. Under **From**, pick the distributor or OEM.
3. Under **It came as**, choose **A credit note — what we owe them goes down** or **Money paid into our bank**.
4. Under **For**, choose **A backend rebate**, **A bill above the deal price** or **Something else**.
5. Fill in the **Date** (not in the future), **Their credit note number** or **The payment's reference**, the bank account for a payout, and the amounts **Before GST**, **CGST**, **SGST** and **IGST**.
6. Under **Set against orders' rebates** (and, for a credit note, the vendor's bills) enter amounts, or select **Fill oldest first**.
7. Select **Record and post**.
What is not set against anything waits on the vendor's account.

## Q: How do I settle more of a vendor credit, or take a settlement off?
A: Open the credit from **Accounts → Vendor credits** in Deskzo. Use **Set more against rebates or bills** to place what is left. Use **Take off** beside a rebate or bill to remove that settlement. You need the **Manage rebate programmes and vendor credits** permission.

## Q: I recorded a vendor credit by mistake. How do I undo it?
A: Open the credit from **Accounts → Vendor credits**, select **Cancel this credit**, say **Why**, and select **Cancel it**. Deskzo reverses its posting that day. The rebates it was set against are due again, and the bills owe again. The cancelled credit stays in the list, struck through.

## Q: Can money paid into the bank be set against a bill?
A: No. In Deskzo only a credit note can be set against the vendor's bills. A rebate paid into your bank can be set against orders' rebates only. The message is "Money paid into the bank isn't set against bills — only a credit note is." Also, a credit note is set only against bills from the same vendor.

## Q: Who can see and record vendor credits?
A: In Deskzo, seeing **Accounts → Vendor credits** needs the **See backend rebates** permission (Management, Accounts and Purchase roles by default). Recording, settling and cancelling credits needs **Manage rebate programmes and vendor credits** (Management and Accounts by default). Without it you see "You can't record vendor credits."

## Q: Where are rebate programmes set up?
A: The standing rebates that OEMs and distributors pay are set in **Settings → Rebate programmes** in Deskzo. They are suggested on each order. Vendor credits settle those rebates when the money or credit note arrives. Anyone with **See backend rebates** can read the screen; only people with **Manage rebate programmes and vendor credits** can change it.

## Q: Who can see Payables?
A: Anybody whose role has the **View payments** permission sees Deskzo Payables and the Paid to vendor panel on a bill. Sales, Support, Accounts, Purchase and Management have it by default. Which vendors they see follows the record scope set for their role in **Settings → Roles & Permissions**.

## Q: Is there anything to set up for Payables?
A: Not in Payables itself. Record vendor bills in **Accounts → Vendor Bills** with a **Due date**, and they appear on Deskzo Payables as soon as they are issued. Without a due date, a bill ages from its bill date.

## Q: I can't see Payables or Vendor credits in my menu.
A: Check three things with your admin:
1. Your company's plan must include Payables (Deskzo Books or Deskzo One), and it must be switched on in **Settings → Modules**.
2. Your role must not have the Accounts → Payables section unticked in **Settings → Roles & Permissions**.
3. Your role needs the **View payments** permission. Vendor credits also needs **See backend rebates**.
