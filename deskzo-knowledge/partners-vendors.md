# Vendors — Deskzo

Vendors keeps the companies you buy from or work with (vendors, OEMs, distributors and partners) separate from your customers. Each vendor has an onboarding status, a vendor code, bank accounts and its purchase documents. Vendors is part of Deskzo Books, Deskzo Inventory and Deskzo One.

## Q: What is the Vendors module in Deskzo?
A: Vendors is the supply side of your company list. It holds the companies you buy from or partner with. Each one is a **Vendor**, **OEM**, **Distributor**, **Partner** or **Other**. A vendor has its locations and GST numbers, contacts, payment terms, onboarding status and vendor code. You find it at Partners → Vendors.

## Q: I can't see Vendors in my menu. Why?
A: Ask your admin to check:
1. Your company's plan includes Vendors (Deskzo Books, Deskzo Inventory or Deskzo One).
2. The Vendors module is switched on in Settings → Modules.
3. Your role has the **Partners › Vendors** section ticked in Settings → Roles & Permissions.
Your admin may also have renamed "Vendor" (for example to "Supplier") in Settings → Wording.

## Q: How do I add a vendor?
A: 
1. Go to Partners → Vendors and click **New vendor**.
2. Enter the **Company name** and choose its **Relationship**: Vendor, OEM, Distributor, Partner or Other. Add industry, website and **Payment terms** if you know them.
3. Under **Primary location**, enter the **Location label**, **Address**, **GST number** and **GST treatment**.
4. Under **Contacts**, click **+ Add contact** to add people you deal with.
5. Click **Save company**.
A new vendor starts as **Onboarding** and gets the next vendor code automatically.

## Q: How do I add a new supplier?
A: Suppliers are added as vendors. Go to Partners → Vendors and click **New vendor**. Enter the **Company name**, choose the **Relationship** (Vendor, OEM, Distributor, Partner or Other), fill in the **Primary location** with GST details, add contacts, and click **Save company**. The company name must be unique; if it already exists, open it instead.

## Q: Which permissions does Vendors use?
A: 
- **See every account, not just your own**: see every vendor, not only those you manage.
- **Manage finance records**: add or change a vendor's bank accounts and PAN.
- **Record payments**: see full bank account numbers instead of masked ones.
- **Raise purchase orders**: raise a purchase order from a vendor's page.
- **Change organisation settings**: set the vendor code prefix in Settings → Vendor codes.

## Q: I can't find a vendor a colleague added. Why?
A: Without the **See every account, not just your own** permission, you see only vendors you are account manager for, and your team's. Ask your admin to widen your access, or ask the colleague to reassign the vendor to you.

## Q: How do I change a vendor's onboarding status?
A: Every vendor is **Onboarding**, **Active** or **Inactive**. Open the vendor and use the status menu at the top of the page. For many vendors at once, tick them on the Partners → Vendors list, choose a status in the bar, and click **Apply**.

## Q: How do I give a vendor a vendor code?
A: 
1. Open the vendor's page and click **Vendor code** (or **Set vendor code** if it has none).
2. Type the code and click **Save**.
A code can be up to 30 characters. It is saved in capitals and must be unique. Leave it empty to remove it.

## Q: How do I set up automatic vendor codes?
A: An admin with **Change organisation settings** does this:
1. Go to Settings → Vendor codes.
2. Enter the **Prefix**: 1 to 12 letters or digits, and optionally - / or _.
3. Save. Every new vendor gets the prefix plus the next number.
To number older vendors in one go, click **Give them codes**. Changing the prefix does not change existing codes.

## Q: It says the vendor code is already another vendor's. What do I do?
A: Every vendor code must be unique. Choose a different code, or correct the other vendor's code first.

## Q: How do I add a vendor's bank account?
A: You need the **Manage finance records** permission.
1. Open the vendor's page and find **Payout details**.
2. Click **+ Add bank account** and fill in the account.
3. If there is more than one, click the star (**Make primary**) on the default account.
The vendor's PAN is shown in the same card.

## Q: Why is the vendor's bank account number masked?
A: Full bank account numbers only show to people with the **Manage finance records** or **Record payments** permission. Everyone else sees them masked.

## Q: How do I raise a purchase order to a vendor?
A: You need the **Raise purchase orders** permission. Open the vendor's **Documents** tab and click **New purchase order**. For details, see the Purchase Documents guide.

## Q: A customer is also our vendor. Do I add them again?
A: No. One company can be both. Open the customer and, under Roles on its **Details** tab, click **Add as a vendor too**. Choose its **Vendor manager**. It gets a vendor code, starts as Onboarding, and appears in Vendors. Its statement shows what you owe them, what they owe you, and the net.

## Q: Why does a vendor's page have fewer tabs than a customer's?
A: You don't sell to a vendor, so sales tabs like Products & Subscriptions, Payments, Leads and Renewals are not shown. The vendor's **Documents** tab holds purchase documents instead.

## Q: How do I find and filter vendors?
A: Go to Partners → Vendors. Search by company name. Filter by **Type**, **Status**, **Source**, **Industry**, **Assigned to** and **Added on**, and by your own vendor fields. Use **Columns** to choose what the table shows. Tick vendors to reassign them, change status or add tags in bulk.

## Q: How do I add custom fields for vendors?
A: An admin goes to Settings → Custom fields and adds fields under Vendors. These fields are separate from the fields on customers.

## Q: Where do I see what we owe a vendor?
A: Go to Payables. Payables ages each vendor's bills. See the Payables guide.
