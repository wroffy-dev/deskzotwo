# Resellers — Deskzo

Resellers are channel partners who buy from you to sell to their own customers. Deskzo tracks each reseller's onboarding, partner tier, special prices and credit, and keeps their end customers off limits to direct contact and marketing. Resellers is part of Deskzo CRM and Deskzo One.

## Q: What is a reseller in Deskzo?
A: A reseller is a company that buys from you to sell on to its own customers. You invoice the reseller, not the end customer. Orders and payments belong to the reseller. The reseller's customers (end customers) are recorded under the reseller. You find resellers at Partners → Resellers.

## Q: I can't see Resellers in my menu. Why?
A: Ask your admin to check:
1. Your company's plan includes Resellers (Deskzo CRM or Deskzo One).
2. The Resellers module is switched on in Settings → Modules.
3. Your role has the **Partners › Resellers** section ticked in Settings → Roles & Permissions.

## Q: Which permissions does Resellers use?
A: 
- **See every account, not just your own**: see every reseller, not only those you or your team manage.
- **Manage finance records**: set a reseller's PAN and manage its bank accounts.
- **View reseller-managed contact details**: see the email and phone of a reseller's end customers. Management and Support have it by default.
- **Override credit terms & limits**: set or change a credit limit from the Credit tab.
- **Export customer data**: download resellers from Settings → Import & export.

## Q: How do I add a reseller?
A: 
1. Go to Partners → Resellers and click **New reseller**.
2. Fill in the form like any company: name, details, primary location with its GST number, and first contact.
3. Click **Save company**.
The reseller starts as **Onboarding**, with you as account manager.

## Q: How do I add a channel partner?
A: Channel partners who resell your products are added as resellers. Go to Partners → Resellers, click **New reseller**, fill in the company details and GST number, and click **Save company**. Then complete the onboarding checklist and make the reseller **Active**.

## Q: How do I onboard a reseller and make it Active?
A: 
1. Open the reseller. On the **Details** tab, find **Reseller onboarding**. Each open step says what it needs.
2. Click **Edit onboarding details**. Fill in **Agreement signed on**, **Agreement reference**, **Approved by**, **Partner tier** and **Standard discount (%)**. Click **Save**.
3. Add the GST number on the reseller's primary location (**Locations** tab).
4. Someone with **Manage finance records** clicks **Set PAN** at the top of the page.
5. Make sure a credit limit is set from the **Credit** tab.
6. When every step is ticked, change the status to **Active**.

## Q: What are the reseller onboarding steps?
A: The **Reseller onboarding** checklist has four steps: **Signed partner agreement**, **GSTIN & PAN on file**, **Credit limit & payment terms agreed**, and **Partner tier & discount set**. A reseller can only be made Active when all four are done.

## Q: Why can't I make a reseller Active?
A: A step in the onboarding checklist is still open. Deskzo lists what is missing. The PAN step needs someone with the **Manage finance records** permission.

## Q: Why can't I create an order for a reseller?
A: Orders can only be created for a reseller whose status is **Active**. Finish the onboarding checklist on the reseller's page and change the status to Active. The statuses **Onboarding**, **Suspended** and **Inactive** block orders.

## Q: How do I set a reseller's credit limit?
A: The credit limit is changed on the reseller's **Credit** tab. You need the **Override credit terms & limits** permission and must give a reason. The **Credit limit (₹)** field in **Edit onboarding details** is read-only. If you try to change it there you see "Change the credit limit from the Credit tab — it needs the credit permission and a reason."

## Q: How do I check a reseller's credit?
A: Open the reseller. The onboarding card shows **Credit limit**, **Outstanding**, **Available** and **Tier**. If the balance goes over the limit, a warning shows by how much. Chase payment or raise the limit.

## Q: How are reseller prices worked out?
A: When an order is created for a reseller, each product's price is filled in this way: first a special price agreed for that product; else the tier's **Standard discount (%)** off the catalogue price; else the catalogue price. The order form says which was used. Tiers are **Silver**, **Gold** and **Platinum**.

## Q: How do I give a reseller a special price for one product?
A: 
1. On the reseller's **Details** tab, find **Special reseller pricing** and click **+ Add special price**.
2. Pick the **Product** and enter **Their price (₹ per unit)**. Add **Notes** if needed.
3. Click **Save price**.
A special price wins over the tier discount. Click **Remove** to go back to the tier discount.

## Q: How do I add a reseller's end customer?
A: 
1. On the reseller's **Details** tab, under **End customers**, click **+ Add end customer**.
2. Fill in the customer like any company.
3. Click **Save company**.
The end customer is marked do-not-contact automatically.

## Q: How do I record who a reseller's order is for, after it was placed?
A: Open the reseller's order and select **Set end customer** (or **Change end customer**) on its banner, search by name and choose the customer. It works on running and fulfilled orders too, and the order's added seats follow. **Take off** removes it. You need to be the order's salesperson, an order approver, or hold **Process orders (purchasing)**.

## Q: A reseller sold to a customer who is already ours. How do I record it?
A: Set that customer as the order's end customer (see above). The order stays the reseller's and is billed to them, but the customer stays yours: it is not handed to the reseller and not marked do-not-contact. The order's banner says it was sold through the reseller, and the customer's **Products & Subscriptions** tab marks it **Bought via reseller**. It can't be another reseller's end customer, a reseller, or a company that isn't a customer.

## Q: Where are a reseller's end customers? They aren't in the Customer list.
A: End customers are kept out of the Companies and Customer lists on purpose. Open the reseller and look under **End customers** on its **Details** tab.

## Q: Why can't I see an end customer's email or phone?
A: End customers belong to the reseller and are contacted only through them. Their email and phone show only to people with the **View reseller-managed contact details** permission. End customers are also left out of all marketing email.

## Q: How do I change the status or tier of many resellers at once?
A: 
1. Go to Partners → Resellers and tick the resellers.
2. Pick a status in **Status — no change** or a tier in **Tier — no change**.
3. Click **Apply**.
If you chose Active, resellers with incomplete onboarding are left unchanged, and Deskzo names them.

## Q: Can I turn an existing customer into a reseller?
A: No. A company cannot move between the customer, reseller, vendor and commission party modules. Create the reseller in Partners → Resellers instead.
