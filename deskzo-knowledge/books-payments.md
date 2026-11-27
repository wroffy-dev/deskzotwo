# Payments — Deskzo

Payments records the money customers pay against their orders, or as a lump sum to allocate later, and shows what is still outstanding on every order. It is part of Deskzo Books and Deskzo One. Open it from Accounts → Payments.

## Q: What is the Payments screen in Deskzo?
A: Payments is the record of money coming in from customers. Every order is listed with its total, what has been paid and the balance, and a status: **Unpaid**, **Partially paid** or **Paid**. The top shows how many orders, how much is outstanding, and how much has been received but not yet allocated. Below, **Payments received** lists every payment. Open it from **Accounts → Payments**.

## Q: How do I record a payment from a customer?
A: You need the **Record payments** permission.
1. Go to **Accounts → Payments** and click **+ Record payment**.
2. Search for the company and select it. Its orders are listed with the balance due.
3. Select the order the payment is for.
4. Fill in the **Amount**, the date received and the **Method** (Bank transfer, UPI, Cheque, Cash, Card or Other). Optionally add a **Reference** (UTR, cheque number or transaction id) and **Notes**.
5. Click **Record payment**.
Recording a payment posts it to the books.

## Q: How do I enter money received against an order?
A: Go to **Accounts → Payments**, find the order's row and click **Payments**. It shows what has been paid on that order so far. Click **Record a new payment for this order**, fill in the amount, date and method, and click **Record payment**. You can also use the Payments tab on the customer's page. You need **Record payments**.

## Q: How do I record a lump sum payment and allocate it later?
A: You need **Record payments**.
1. Click **+ Record payment** in **Accounts → Payments** and pick the company.
2. Instead of an order, choose **Record as a lump sum — don't apply to an order yet**.
3. Fill in the amount and details, and click **Record payment**.
4. Later, find it under **Payments received** (its **Unallocated** amount is shown) and click **Allocate**.
5. Choose the **Order**, enter the **Amount to allocate**, and click **Allocate**.
You can allocate part now and the rest later.

## Q: Why can't I allocate more of a payment?
A: An allocation can't be more than what is left unallocated on the payment, nor more than the order's balance. The message "Only X is unallocated on this payment." shows how much is left. Allocate a smaller amount, or choose another order.

## Q: How do I see what customers still owe on orders?
A: Go to **Accounts → Payments**. Type in **Search company name…** to see one customer's orders. Use the **Status** filter to show only **Unpaid**, **Partially paid** or **Paid** orders. Below, **Payments received** lists every payment, latest first, with how much of each is allocated and unallocated.

## Q: I applied a payment to the wrong order. How do I fix it?
A: You need the **Delete payments** permission to un-apply.
1. Click **Payments** on the wrong order's row, then click **Un-apply** beside the payment. The money becomes unallocated again.
2. Under **Payments received**, click **Allocate** on that payment and choose the right order.

## Q: How do I delete a payment?
A: You need the **Delete payments** permission. Under **Payments received** in **Accounts → Payments**, click **Delete** beside the payment and confirm. To delete several, tick them and click **Delete** in the bar. Deleting can't be undone. Its allocations go with it, so the orders become outstanding again, and its posting in the books is reversed.

## Q: Who can record or delete payments?
A: Viewing needs **View payments** (Sales, Support, Accounts, Purchase and Management by default). Recording and allocating need **Record payments** (Accounts and Management by default). Deleting and un-applying need **Delete payments** (Accounts and Management by default). An admin sets these per role in **Settings → Roles & Permissions**. Which customers you see follows your role's record scope.

## Q: Why is there no Record payment button?
A: The **+ Record payment** button needs the **Record payments** permission. Without it you can see payments but not add one. Without both **Record payments** and **Delete payments**, the Payments button on each order's row is hidden too. Ask your admin.

## Q: I can't see Payments in my menu. Why?
A: Check with your admin. First, your plan must include Payments (Deskzo Books or Deskzo One). Second, Payments must be switched on in **Settings → Modules**. Third, your role needs the **View payments** permission, and the **Accounts › Payments** menu section must not be unticked, in **Settings → Roles & Permissions**.

## Q: It says "That order is cancelled — record the payment on account instead." What do I do?
A: New money can't be applied to a cancelled order. Record the payment as a lump sum with **Record as a lump sum — don't apply to an order yet**, then allocate it to another order or leave it on the customer's account.

## Q: Where do I record a payment against a tax invoice?
A: A payment against a tax invoice is recorded on the invoice itself. Open the invoice in **Accounts → Tax Invoices** and use the **Payments & credits** panel. See the Receivables guide. The Payments screen is for payments against orders.

## Q: Why don't payments to vendors show in Payments?
A: The Payments screen lists money received from customers only. Money paid out to vendors is recorded on their vendor bills, in the **Paid to vendor** panel. See the Payables guide.

## Q: Is a recorded payment posted to the accounts?
A: Yes. Recording a customer payment in **Accounts → Payments** posts it to the books. Deleting a payment reverses that posting. Each order's total includes GST.
