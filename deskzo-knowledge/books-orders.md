# Orders — Deskzo

Orders tracks each customer order from sale to delivery: sales punches the order, accounts approves the payment terms, purchase buys it from a vendor and marks it fulfilled. Orders is part of Deskzo Inventory, Deskzo Subscriptions and Deskzo One. It also includes the Purchase savings and Backend rebates reports.

## Q: What is Orders in Deskzo?
A: An order in Deskzo is one product sold to one customer: the product, quantity, price, site, payment terms and, for a subscription, start and expiry dates. Each order has a number starting with ORD-. Every order goes through the same steps:
1. Sales punches it. It is **Pending Approval**.
2. Accounts approves or rejects it. Approved, it is **Approved**.
3. Purchase chooses the vendor and price. It is **Processing**.
4. When delivered, purchase marks it **Fulfilled**. It then shows on the customer's Products & Subscriptions tab.
Open it from **Accounts → Orders**.

## Q: How do I punch a new order?
A: To punch an order:
1. Go to **Accounts → Orders** and click **Punch order**.
2. Under **Customer**, choose the customer and its **Location**. Add the **Customer PO / invoice number** if you have it.
3. Under **Product and price**, choose the **Product**, **Quantity** and **Sales price / unit** (blank uses the list price). For a subscription, set the **Start date** and a **Term** or **Expiry date**.
4. Check **New or renewal?**.
5. Under **Terms and hand-off**, choose the **Payment terms** and the **Purchase hand-off**: **Send to purchase now**, **Hold (in-hand order)** or **Schedule on a date**.
6. Optionally fill **Cost and margin**, **Backend rebate**, **Expenses and watchers** and **Notes**.
7. Check the **Order summary** and click **Punch order**, or **Punch and add another**.

## Q: How do I create a sales order?
A: In Deskzo a sales order is "punched". Go to **Accounts → Orders**, click **Punch order**, choose the customer, product, quantity, price and payment terms, choose the **Purchase hand-off**, and click **Punch order**. The order then waits as **Pending Approval** for accounts. Your admin may have renamed "Order" in Settings → Wording.

## Q: Who can punch, approve and process orders?
A: Anybody who can open Orders (permission **View orders**) can punch an order. Approving needs **Approve or reject orders** (Accounts and Management by default). Purchasing needs **Process orders (purchasing)** (Purchase and Management by default). Selling below cost needs **Approve orders sold below cost**. Approving terms longer than the customer's credit supports needs **Override credit terms & limits**. You see the orders of the customers you can see.

## Q: I can't see Orders in my menu. Why?
A: Check three things with your admin. First, your plan must include Orders (Deskzo Inventory, Deskzo Subscriptions or Deskzo One). Second, Orders must be switched on in **Settings → Modules**. Third, your role needs the **View orders** permission, and the **Accounts › Orders** menu section must not be unticked, in **Settings → Roles & Permissions**.

## Q: How do I approve or reject an order?
A: You need the **Approve or reject orders** permission.
1. Open an order from the **Pending Approval** tab in **Accounts → Orders**.
2. Under **Awaiting your review**, check the **Credit** line: the terms on the order, the suggested terms, and what the customer owes.
3. Add **Notes (optional)** and click **Approve**. If it needs a credit override, write why and click **Approve with credit override**.
4. Or click **Reject**, give a reason if you like, and confirm.
The salesperson is told either way.

## Q: Why can't I approve this order?
A: There are three common reasons. You punched the order yourself, and nobody can approve their own order. Or the order needs a credit override, which needs the **Override credit terms & limits** permission. Or the order sells below cost, which needs **Approve orders sold below cost**. The review box on the order says which. The message "This order has already been reviewed." means someone else already approved or rejected it.

## Q: How do I send a held order to purchase?
A: An order punched as **Hold (in-hand order)** or scheduled for a later date stays out of purchase's queue. The **In hand** view in **Accounts → Orders** lists them. Open the order and, under **Actions**:
- Click **Send to purchase now**, or
- Pick a day in **Or schedule for** and click **Schedule**.
- For a scheduled order, **Hold instead** takes it off the schedule.
Only the salesperson who punched it or an order approver can do this.

## Q: How does purchase buy and fulfil an order?
A: You need the **Process orders (purchasing)** permission.
1. Open the **Ready for purchase** view in **Accounts → Orders** and open an order.
2. Under **Purchasing**, choose the **Vendor**, enter the **Purchase price / unit** and **Our PO to vendor**, and click **Save purchasing details**. The order is now Processing.
3. If purchase orders are available, click **Create vendor PO** to make a draft purchase order. Issue it, and its number fills in Our PO to vendor. This needs **Raise purchase orders**.
4. When delivered, click **Mark fulfilled**.

## Q: Purchase can't process an order. Why?
A: Purchase can only process an order after accounts approves it and sales sends it to purchase. A held order or one scheduled for later waits. A higher price waiting for sales to accept also holds it. The message "This order isn't ready for purchasing yet — it needs accounts approval first." means it is not approved yet.

## Q: Why is Mark fulfilled greyed out?
A: Save the vendor and purchase price first with **Save purchasing details**. If a higher price is waiting for sales to accept, that must be settled before the order can be marked fulfilled.

## Q: Purchase can only buy above the distributor price. What happens?
A: Purchase enters the higher price, gives a reason, and clicks **Ask sales to accept**. The order waits in the **Price to approve** view. The salesperson who punched the order, or an order approver, opens it, reads the price and reason under **Purchase needs a higher price**, and clicks **Accept this price** or **Send back** with a note. The person who proposed the price cannot decide on it.

## Q: What does "Sold below cost — needs a manager's approval" mean?
A: The order's sale price is below the best known cost (deal price, distributor quote or purchase price). Someone with **Approve orders sold below cost** must write why the sale is worth it and click **Approve selling below cost**. Nobody can approve this on their own order. If purchase later buys it for more, it needs approving again.

## Q: How do I cancel an order?
A: Open the order and click **Cancel order**. Read what will happen and give a reason (required once the order has gone to purchase). Click **Cancel order** to confirm, or **Keep order**. Its purchase order is cancelled too, unless the vendor already billed it or it covers other orders. Money paid against it moves on account. A fulfilled order can't be cancelled — a return goes through a credit note.

## Q: What does "Vendor PO to cancel" mean on an order?
A: The order was cancelled after its purchase order was already sent to the vendor. The order shows **Vendor PO to cancel** until purchase confirms what happened to that purchase order with the vendor. Purchase works through these in the **Vendor PO to cancel** view.

## Q: Can I change an order after punching it?
A: Partly. On the order, the distributor price can be changed until purchase processes it, and the deal registration and custom fields until it is fulfilled. The quantity, site, PO number, dates and notes are edited from the customer's Products & Subscriptions tab, by people allowed to edit products & subscriptions.

## Q: What happens to a rejected order?
A: A rejected order stays Rejected, and the salesperson sees the reason. To go ahead, punch the order again with the changes accounts asked for.

## Q: How do I create a tax invoice from an order?
A: You need **Raise and issue sales documents**, and Sales Documents must be in your plan. On the order, the **Invoicing** card shows Ordered, Invoiced and **To bill**. Click **Create tax invoice** to bill what is left. The **To invoice** view in Accounts → Orders lists orders not yet fully billed, grouped by customer PO. Choose **One invoice for all**, **One per product**, or **Invoice** beside one order.

## Q: What is Purchase savings?
A: **Accounts → Purchase savings** shows how much purchase bought below the distributor price sales had. The difference times the quantity counts as a saving. Purchase staff see their own figures. People with **Approve or reject orders** or **View team performance** see everyone's.

## Q: What are Backend rebates?
A: Backend rebates are money that distributors and OEMs pay back on orders. **Accounts → Backend rebates** shows what is due and what has come in. You need the **See backend rebates** permission. Only people with it see an order's rebates and its net margin. Rebates never count toward targets or incentives.

## Q: How do I set up rebate programmes?
A: Go to **Settings → Rebate programmes**. You need **Manage rebate programmes and vendor credits** to change it. Click **Add a programme** and enter the **Name**, **OEM (brand)**, **Through distributor**, how it is **Worked out as** (percentage of cost, of sale, or fixed amount), who it is **Paid by**, how it **Comes as** (credit note or bank payment), and its dates. A matching programme is suggested when an order is punched.

## Q: Can I add my own steps to orders?
A: Yes. In **Settings → Pipeline**, the Orders section holds your own steps within Approved, Processing and Fulfilled (for example "Material ordered", "Installed"). This needs **Manage the sales pipeline**. Each order then shows **Progress**: choose a step under **Move to**, add a note, and click **Move**. Orders only move forward.
