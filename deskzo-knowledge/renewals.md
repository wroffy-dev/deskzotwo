# Renewals — Deskzo

Renewals in Deskzo lists every subscription you have sold that has an expiry date, soonest first. From the Renewals list you can raise renewal tasks, quote the next term, remind the customer and punch the renewal order. Renewals is part of Deskzo Subscriptions and Deskzo One.

## Q: What is the Renewals list in Deskzo?
A: Renewals lists the subscriptions your customers hold, soonest expiry first. A subscription here is an order for an item managed as a subscription that has an expiry date. Each row shows the customer, the subscription and its seats, the PO / invoice number, the start and expiry dates, the renewal manager, a status and a stage. Open it from **Renewals → Renewals**. A workspace admin can rename the word "Renewals" in **Settings → Wording**.

## Q: What does the renewal status mean?
A: The status in Renewals shows how long is left on the subscription:
- **Active**: more than 30 days left.
- **Expires in** a number of days: 30 days or less left.
- **Expired**: the expiry date has passed.

## Q: What do the renewal stages mean?
A: The stage shows how far the renewal has got. Deskzo works most stages out from what has happened:
- **Not started**: nothing yet.
- **Task raised**: an open renewal task names it.
- **Contacted**: a call has been logged against it.
- **Quoted**: a proposal, proforma or invoice quotes its next term.
- **Renewed**: the renewal order has been punched.
Three stages are set by hand: **Negotiating**, **On hold** and **Lost**.

## Q: Who can open Renewals?
A: Renewals uses the **View orders** permission. Anybody who can view orders can open Renewals. You see subscriptions only for customers you can see: your own accounts and your reports' accounts, or every customer if you have the **See every account, not just your own** permission. Other actions on a row need more permissions:
- Setting a stage by hand and punching the renewal order: **Edit products & subscriptions** or **Process orders (purchasing)**.
- Drafting a renewal proposal: **Raise and issue sales documents**.
- Adding seats mid-term: **Process orders (purchasing)**.

## Q: How do I see which subscriptions are expiring soon?
A: To see upcoming renewals:
1. Go to **Renewals → Renewals**.
2. Choose a **Window**: **Expired**, **Lapsed — not renewed**, **At risk — not started** (ending within 30 days with no call, no quote and nothing marked), **Expiring in 30 days**, **Expiring in 60 days** or **Expiring in 90 days**.
3. Search by company name, or filter by **Renewal manager** (choose **Nobody** for renewals nobody looks after).
4. Use **Columns** to choose what the table shows, or switch to the split view to read each subscription's order beside the list.

## Q: How do I create renewal tasks?
A: To raise renewal tasks from the Renewals list:
1. Tick the subscriptions you want to chase.
2. In the bar, choose who to **Assign to** (or nobody).
3. Optionally set a **Task due date**. If you leave it blank, each task is due on its subscription's expiry date.
4. Select **Create renewal tasks**.
Each task is called "Renew <product> — <customer>". A subscription that already has an open renewal task is skipped, so you do not get duplicates. The stage moves to **Task raised**.

## Q: How do I quote the next term of a subscription?
A: On the Renewals row, select the proposal icon (**Draft a renewal proposal for** the customer). Deskzo makes a draft proposal for the next term from the subscription, its added seats and its full-term price. Select **Open it** to check and send it. The stage moves to **Quoted**. You need the **Raise and issue sales documents** permission.

## Q: How do I renew a subscription?
A: To punch the renewal order:
1. On the Renewals row, select the renew icon (**Punch the renewal order**).
2. In **Renew this subscription**, check the **Quantity** (seats added mid-term are included), the **Price each, full term**, and when the **New term starts** and ends.
3. Add **Their PO** and **Notes** if you have them.
4. Select **Punch renewal**.
The renewal is raised as a normal order, pending approval, and goes through accounts and purchase like any other order. The old subscription stays as it was, and the row shows **Renewed** with the new order number. You need **Edit products & subscriptions** or **Process orders (purchasing)**.

## Q: How do I punch a renewal order?
A: In **Renewals → Renewals**, select the renew icon on the subscription's row. Check the **Quantity**, the **Price each, full term** and the **New term starts** date, add **Their PO** and **Notes** if needed, and select **Punch renewal**. The order then goes through approval like any other order.

## Q: How do I set a renewal stage to Lost, Negotiating or On hold?
A: To set a stage by hand:
1. Select the stage on the Renewals row.
2. If you like, type why in the box, for example "lost on price".
3. Under **Set the stage by hand**, choose **Negotiating**, **On hold** or **Lost**. It is saved at once with your note.
A stage set by hand wins over the worked-out stage, except that a punched renewal order always shows **Renewed**. To go back, choose **Clear — go back to what the record says**. Marking a renewal **Lost** switches off its auto-renew; **On hold** pauses it.

## Q: Why can't I set the stage to Quoted or Contacted?
A: Quoted, Contacted, Task raised and Renewed are worked out by Deskzo from what has happened, so they cannot be set by hand. Only **Negotiating**, **On hold** and **Lost** can be set by hand.

## Q: I set the stage to Lost, but the renewal shows Renewed.
A: Once a renewal order has been punched, the Renewals row shows **Renewed**, whatever stage was set by hand. The row says that the stage you set was overtaken.

## Q: It says the subscription is already renewed.
A: The message "Already renewed by <order number>. Cancel that first if it was wrong." means a renewal order has already been punched for this subscription. If that order was wrong, cancel it first, then punch the renewal again.

## Q: How do I send a renewal reminder to the customer?
A: On the Renewals row, select the mail icon (**Send a renewal reminder**; once renewed it says **Confirm the renewal**). Choose which contacts to write to, the **Wording**, and **Add a line of your own** if you like, then send it. Contacts who cannot be written to are listed with the reason.

## Q: Are customers reminded about renewals automatically?
A: Yes, if an admin switches it on. In **Settings → Renewals**, under **Reminding the customer**, tick **Email the customer the renewal reminder by itself** and enter the **Days before it ends** (for example 30, 7). It goes to the company's primary contact and its billing contacts, and to the reseller's on a reseller's order. It is not sent when a reminder already went since, for a renewal that is renewed, Lost or On hold, or to a contact who unticked renewal reminders. Otherwise, send it by hand from the row.

## Q: Who is reminded inside Deskzo before a subscription ends?
A: The renewal manager (the customer's account manager unless someone else was chosen). In **Settings → Renewals** an admin sets:
- **Remind the renewal manager, days before it ends**: for example 60, 30, 15, 7, 1. Reminders come in the bell, and by email where **Settings → Email notifications** sends "A renewal is coming up".
- **Tell their manager when it isn't started** and **Tell the admins when it still isn't started**: so many days before the end, if there has been no call, no proposal, proforma or invoice, and nobody marked it Negotiating or On hold.
- **Raise a renewal task for the renewal manager**: a task "Renew <product> — <customer>" so many days before the end, once a term.
- **Who hears about renewals nobody looks after**: for customers with no renewal manager or account manager still in the company. Nobody chosen means every admin.
Every Monday, each renewal manager also gets their list (due within 30 days, not started, lapsed) and each manager their team's.

## Q: How do I add seats to a subscription in the middle of the term?
A: On the customer's **Products & Subscriptions** tab, select **Add seats** on the subscription. Enter **How many extra**, **From** when, the **Full-year price a seat** and **What we pay for it**, then add them. The seats are raised as their own order through the usual approval. They end with the subscription and come back with it at renewal. You need the **Process orders (purchasing)** permission.

## Q: What is a renewal manager?
A: The renewal manager is the person who looks after a customer's renewals. By default it is the customer's account manager. To give renewals to someone else, open the customer and select the **Renewals: account manager** chip at the top, or tick the subscriptions in Renewals and choose a person under **Set renewal manager…**. Choose **Back to the account manager** to undo it. Only people who may change the customer's account manager can do this. An admin can limit who may be a renewal manager in **Settings → Departments** (tick **Renewal manager** on a department).

## Q: What happens when a subscription expires and nobody renews it?
A: The day after it ends, the account owner is notified that it lapsed. It appears in Renewals under the **Lapsed — not renewed** window. An admin can set Deskzo to mark it **Lost** by itself after a number of days in **Settings → Renewals** (tick **Mark it Lost by itself if still nobody has renewed or marked it**). The owner and their manager are then told. A renewal somebody has marked (Negotiating, On hold) is never marked Lost this way.

## Q: Is there a report of renewed and lost subscriptions?
A: Yes. In **Renewals → Renewals**, select **Report**. The **Renewal report** shows subscriptions that came up for renewal in a range of months: how many were renewed, lost and still open, the renewal rate, why lost ones were lost, and figures by product and by salesperson. Choose **Last 12 months**, **This financial year**, **Last financial year**, or pick months.

## Q: How do I make a subscription invoice itself automatically?
A: Open the subscription's order and set **Recurring billing**:
- **Off**: invoiced by hand.
- **Renew itself at the end of the term**: on the first day of the next term the renewal order is punched for approval and its invoice raised as a draft.
- **Invoice the term in parts**: **Monthly**, **Quarterly** or **Yearly**, each part raised as a draft on the day it begins.
Nothing is issued automatically; the drafts wait for somebody to check and issue them. Whoever issues sales documents is told the day drafts are raised, and reminded every Monday of drafts still waiting three days or more. Deleting a draft skips that part for good. You need the **Raise and issue sales documents** permission.

## Q: A customer pays monthly, or quarterly, but signed for a year. How do I set that up?
A: Punch one order for the whole year at the year's price, then set **Recurring billing** to **Invoice the term in parts** and choose **Monthly** (a twelfth drafted on the first day of each month) or **Quarterly** (a quarter drafted on the first day of each quarter). For a customer on a month-to-month order, punch a one-month term and choose **Renew itself at the end of the term**: each month the next month's order is punched for approval and its invoice drafted.

## Q: How do I check that no subscription is left unbilled?
A: In **Renewals → Renewals**, select **Billing check**. It lists:
- **Nothing set to bill**: running subscriptions with recurring billing off that are not invoiced in full, or a month's term ending soon that is renewed by hand.
- **Held up**: switched on, but it can't bill when due, with the reason (no price, no term dates, no site to renew to, or a reseller not through onboarding).
- **Drafts waiting to be issued**: drafts recurring billing raised that nobody has issued, oldest first. You need permission to see sales documents to see these.
The **Next bill** column on the Renewals list shows when each subscription invoices itself next, or why it won't: **Not set**, **Held up**, **Renewed**, **Lost**, **On hold** or **All parts raised**.

## Q: A subscription I sold is not in Renewals.
A: Check these points:
1. The item must be ticked **Manage as a subscription** in Items.
2. The order must have an expiry date, set by the **Term** or **Expiry date** when the order is punched.
3. You only see subscriptions on customers you can see.
Seats added mid-term appear in their subscription's row, not on their own. Goods and one-time services never appear in Renewals.

## Q: I can't see Renewals in my menu.
A: Renewals shows in the menu only when all of these are true:
1. Your company's plan includes Renewals (Deskzo Subscriptions or Deskzo One). Renewals also needs the Orders module.
2. The Renewals module is switched on in **Settings → Modules**.
3. Your role has the **View orders** permission and the **Orders & Renewals** section is ticked in **Settings → Roles & Permissions**.
Ask your admin to check these. The menu word may also be different if your admin renamed it in **Settings → Wording**.
