# Receivables, customer credit and collections — Deskzo

Receivables shows what customers owe you, aged from each invoice's due date. Customer credit rates each customer on how they pay, and My collections is a list of dues to chase, with every follow-up and promise to pay. Receivables is part of Deskzo Books and Deskzo One.

## Q: What is Receivables in Deskzo?
A: Receivables answers "who owes us what, and for how long". Every issued tax invoice that is not fully paid is aged from its due date into **Not yet due**, **1–30 days**, **31–60 days**, **61–90 days** and **90+ days**, with one row per customer. If an invoice has no due date, Receivables ages it from its issue date. Open it from **Accounts → Receivables**.

## Q: How do I see who owes us money?
A: To see what customers owe in Deskzo:
1. Go to **Accounts → Receivables**. The cards show **Total outstanding**, **Overdue**, **Not yet due** and **90+ days**.
2. Type in **Search customer name…**, or pick the **Broken promises** or **Promised this week** filter.
3. Select a customer to open their **Statement** tab. It shows what they were invoiced, what they paid, credit notes, the ageing, their open invoices and a running statement of account.
Each row on Receivables also shows the last follow-up logged for that customer.

## Q: How do I record a payment against an invoice?
A: To record a customer payment on an invoice in Deskzo:
1. Open the issued tax invoice.
2. In its **Payments & credits** panel, select **Record payment**. The **Amount** starts at the balance due.
3. Fill in **Received on**, the **Method** and a **Reference** (for example the UTR or cheque number). You can add **Notes**.
4. For an invoice in another currency, enter the **Amount received** in that currency and the **Rate on the day**.
5. Select **Record payment**.
The invoice becomes Partially paid, or Paid when nothing is left. You need the **Record payments** permission.

## Q: How do I mark an invoice as paid?
A: In Deskzo you mark a customer invoice paid by recording the payment on it. Open the issued tax invoice, select **Record payment** in the **Payments & credits** panel, fill in **Received on**, **Method** and **Reference**, and select **Record payment**. When the full balance is paid, the invoice shows Paid and drops off Receivables.

## Q: Why is there no Record payment button on the invoice?
A: The **Record payment** button on a Deskzo invoice needs the **Record payments** permission (the Accounts and Management roles have it by default). The button is also hidden when the invoice is already paid in full. A draft invoice or a cancelled invoice has no Payments & credits panel at all. Issue the invoice first.

## Q: It says only part of the amount is outstanding on this invoice.
A: A payment against a Deskzo invoice cannot be more than the invoice's balance. The message reads "Only ₹… is outstanding on this invoice. Record the excess as a separate payment so it stays unapplied." Record the balance on the invoice. Record the extra money as a separate payment under Payments, where it stays unallocated on the customer's account.

## Q: How do I apply a credit note to an invoice?
A: To set a credit note against an invoice in Deskzo:
1. Open the open invoice and select **Apply credit note**. This button appears only when the customer has an issued credit note with something left on it.
2. Choose the **Credit note** and the **Amount to apply**.
3. Select **Apply**.
You can also start from the credit note: its **Applied to invoices** card shows what is unapplied, and **Apply to an invoice** does the same. **Remove** takes an application off again (this needs the **Delete payments** permission).

## Q: Why can't I apply this credit note?
A: In Deskzo a credit note can be applied only when it is issued, it is for the same customer as the invoice, it is in the same currency, and it has something left unapplied. The invoice must still be open. If it is already applied to that invoice you see "This credit note is already applied to that invoice — remove it first to change the amount." Remove it, then apply the new amount.

## Q: An invoice I raised is not on Receivables.
A: Deskzo Receivables lists only issued tax invoices with money still owed. Drafts, cancelled invoices and invoices paid in full are not listed. You also only see customers that your role's record scope reaches.

## Q: How do I log a payment follow-up or a promise to pay?
A: To log a follow-up with a customer in Deskzo:
1. Select **Log follow-up** on the invoice's **Payment follow-ups** card or in **Accounts → My collections**. Or select **Follow up** beside an open invoice on the customer's Statement tab.
2. Choose **How you reached them** (Call, WhatsApp, Email, Visit, Meeting or Other) and write **What the client said**.
3. If they promised to pay, fill in **Will pay by** and the **Amount** under **A promise to pay (optional)**.
4. Optionally pick a **Next follow-up (optional)** date to get a task or reminder.
5. Select **Save follow-up**.
A new promise on the same invoice replaces the open one. Sales and accounts share one history.

## Q: What is My collections?
A: My collections in Deskzo is a salesperson's list of what their clients owe. Open **Accounts → My collections**. Filter by **All**, **Overdue**, **Promise broken**, **Promised this week** or **No follow-up in 14 days**, and sort by **Most overdue** or **Largest amount**. It lists accounts you manage (and your team's), plus orders you punched on any account. Orders not yet invoiced are included. Select **Log follow-up** after you speak to the client.

## Q: Who can use My collections?
A: My collections in Deskzo needs the **View payments** permission and also either **Follow up payments on their accounts** or **Record payments**. No role has **Follow up payments on their accounts** by default. An admin ticks it for a role in **Settings → Roles & Permissions**, or for one person in **Settings → Users**.

## Q: Who is told when a promise to pay is broken?
A: When a promise to pay passes unpaid in Deskzo, the person who logged it and their reporting manager are told. Everybody who can record payments gets one summary of the day's broken promises. Receivables and My collections both have a filter for broken promises.

## Q: What is Customer credit?
A: Customer credit in Deskzo rates every customer you have billed on how they actually paid: **Reliable**, **Fair**, **Risky** or **New**. The rating suggests the longest payment terms and the credit limit. Open **Accounts → Customer credit**. Customers are listed riskiest first. Select one to open their **Credit** tab, which shows suggested and standing terms, the limit, and **What the rating is based on**, bill by bill.

## Q: How do I set a customer's credit limit?
A: To set a credit limit by hand in Deskzo:
1. Go to **Accounts → Customer credit** and select the customer.
2. On the **Credit** tab, use **Set the limit by hand**.
3. Enter the **Limit (₹)** and say **Why**.
4. Select **Save limit**.
**Use the suggested limit instead** goes back to the rating's figure. You need the **Override credit terms & limits** permission. Each decision is listed under **Credit decisions** on the Credit tab, with the reason.

## Q: How do I get paid online with a pay-now link?
A: In Deskzo an admin first connects your Razorpay or Cashfree account in **Settings → Payment collection** (try test keys first; no real money moves on test keys). Then open an issued invoice. Its **Pay online** card makes a pay-now link for the amount left; select **Copy** to send it. When the customer pays, the payment is recorded on the invoice by itself.

## Q: How do I switch on automatic payment reminders?
A: To send payment reminders from Deskzo:
1. Go to **Settings → Payment collection** and tick **Send payment reminders**.
2. Choose who they are **Sent as** — someone who can open every invoice.
3. Keep the standard schedule, or edit a step's days, tone and words.
4. Select **Save**.
Each reminder goes once per invoice with the invoice attached and the pay-now link. Switching on sends nothing for days already past. You need the **Change organisation settings** permission.

## Q: How do I stop reminders for one customer?
A: Open the customer in Deskzo, go to their **Statement** tab, select **Pause reminders**, say why (for example a dispute), and select **Pause**. **Resume reminders** starts them again. A promise to pay on an invoice also holds that invoice's reminders until the promised day passes.

## Q: What is credit hold?
A: Credit hold in Deskzo is set in **Settings → Payment collection** under **Credit hold**, with **Days overdue**. When a customer has an invoice that many days overdue, their new orders wait for someone with the **Override credit terms & limits** permission to approve them with a reason. Orders paid in advance and quotes are not held.

## Q: What is MSME late-payment interest?
A: If your company is a micro or small enterprise, enter your **Udyam registration number**, **Category** and **RBI bank rate, %** in **Settings → Payment collection**. Deskzo then shows the interest the MSMED Act allows on each late invoice on the customer's Statement tab. It is never billed by itself; you can draft a debit note for it to check and issue.

## Q: How do I see how fast customers pay (DSO)?
A: Go to **Accounts → Receivables** and select the **DSO & forecast** view. Deskzo shows days sales outstanding today and at each month end for a year, and what promises and due dates say should come in over the next eight weeks. Receivables also has **Aging report** and **Balance summary** views.

## Q: I can't see Receivables, Customer credit or My collections in my menu.
A: Check three things with your admin:
1. Your company's plan must include Receivables (Deskzo Books or Deskzo One), and it must be switched on in **Settings → Modules**.
2. Your role must not have the Accounts → Receivables section unticked in **Settings → Roles & Permissions**.
3. Your role needs the **View payments** permission. My collections also needs **Follow up payments on their accounts** or **Record payments**.
