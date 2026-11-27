# Items & Inventory — Deskzo

Items & Inventory is your catalogue of goods, services and subscriptions, with prices, GST rates, brands, categories and stock. It is part of Deskzo Books, Deskzo Inventory, Deskzo Subscriptions and Deskzo One. Stock is kept per warehouse, and optionally per batch and serial number.

## Q: What is Items & Inventory in Deskzo?
A: Items & Inventory is the list of everything your company sells or buys. Each item has a name, a SKU, a selling price, an optional cost price, a GST rate, a unit, a brand, a product family and a category. When someone picks a product on an order, proposal, invoice or purchase order, the price and tax come from the item. For goods, Deskzo can also keep a stock count. Open it from **Accounts → Items & Inventory**.

## Q: How do I add a new item?
A: To add an item in Items & Inventory:
1. Go to **Accounts → Items & Inventory** and click **New item**.
2. Enter the **Item name** and **SKU**. The SKU must be unique.
3. Under **Goods or service**, choose Goods or Service. For a service that renews, tick **Manage as a subscription**.
4. Pick a **Brand**, then a **Product family** of that brand, and a **Category**.
5. Enter the **HSN / SAC code** (required in India), the **Selling price**, and if you know them the **Cost price**, **GST rate (%)** and **Unit**.
6. For goods, keep **Track inventory for this item** ticked to count stock. You can add a **Reorder level** and **Opening stock**.
7. Click **Save item**.
Your company's own extra fields appear under **More details**.

## Q: How do I create a product in the catalogue?
A: A product is an item in Items & Inventory. Go to **Accounts → Items & Inventory**, click **New item**, fill in the **Item name**, a unique **SKU**, Goods or Service, brand, category, HSN/SAC code and **Selling price**, then click **Save item**. Note: your admin may have renamed "Item" to another word (for example "Product") in Settings → Wording, so the button may say **New product**.

## Q: Who can add or edit items?
A: Everyone who can open Items & Inventory can add items, edit them and change many items at once. Importing and exporting the item list need the **Import the catalog** and **Export the catalog** permissions. Adding or renaming brands, families and categories needs the **Manage brands, families & industries** permission. Stock work has its own permissions: **See stock**, **Receive stock**, **Transfer stock**, **Adjust stock**, **Approve stock adjustments** and **Set up inventory**.

## Q: I can't see Items & Inventory in my menu. Why?
A: There are three common reasons. First, your company's plan must include a product with Items & Inventory (Deskzo Books, Deskzo Inventory, Deskzo Subscriptions or Deskzo One). Second, the module must be switched on in **Settings → Modules**. Third, your role must not have the **Accounts › Items & Inventory** menu section unticked in **Settings → Roles & Permissions**. Stock vouchers, Stock reports, Warehouses and Units of measure also need a stock permission such as **See stock**. Ask your admin.

## Q: How do I record a stock movement on an item?
A: Stock movements show only on goods that track inventory.
1. Open the item in **Accounts → Items & Inventory**.
2. Under **Stock movements**, choose a **Movement type**: RECEIVED, SOLD, ADJUSTMENT, RETURNED or DAMAGED.
3. For ADJUSTMENT, choose **Increase stock** or **Decrease stock**.
4. Enter the **Quantity** and, if you like, a **Reason / note**.
5. Click **Record movement**.
RECEIVED and RETURNED add stock. SOLD and DAMAGED remove stock.

## Q: It says "Not enough stock — only X on hand". What does that mean?
A: A stock movement cannot take an item's stock below zero. Stock reserved by another order is also not available. Check the quantity and the warehouse, or record the missing receipt first. An admin can allow negative stock with **Allow negative stock** in **Accounts → Accounts settings**, but never for items kept in batches.

## Q: Why didn't stock go down when we issued a tax invoice?
A: Issuing a tax invoice moves stock only when **Tax invoices issue stock** is switched on in **Accounts → Accounts settings**. All these options are off until someone turns them on. Until then, record a SOLD movement on the item for the goods that went out.

## Q: How do I receive goods against a purchase order (GRN)?
A: You need the **Receive stock** permission.
1. Go to **Accounts → Goods receipts (GRN)** and click **New goods receipt**.
2. Choose the purchase order. Its lines show what was ordered, what was already received and what is still to come.
3. Enter what was accepted and what was rejected on each line. Add batch and expiry date, or serial numbers, where the item needs them.
4. Save, then click **Post**. Stock comes into the warehouse at the order's price. When the vendor's bill comes, it is matched to the receipt, so the goods are not received twice.

## Q: How do I move stock from one warehouse to another?
A: You need the **Transfer stock** permission.
1. Go to **Accounts → Stock vouchers** and click **New transfer**.
2. Choose the warehouse the stock leaves and the warehouse it goes to, and add the items.
3. Click **Send**. The stock leaves at once and is "in transit".
4. When it arrives, open the transfer and click **Receive**. It lands at the same value it left with.

## Q: How do I do a physical stock count?
A: You need the **Adjust stock** permission.
1. Go to **Accounts → Stock vouchers** and click **New physical count**.
2. Choose the warehouse, load its count sheet, and enter the counted quantity on each line.
3. Save. If **Adjustments and counts need approval** is on in Accounts settings, click **Submit for approval**. Another person with **Approve stock adjustments** clicks **Approve & post**.
Posting writes stock up or down to the count, at cost.

## Q: What kinds of stock vouchers are there?
A: In **Accounts → Stock vouchers** you can create: **New goods receipt**, **New transfer**, **New adjustment**, **New physical count** and **New purchase return** (goods sent back to a vendor). Each button shows only if your role has the matching stock permission. A posted voucher can be undone with **Cancel & reverse**, which asks you why.

## Q: Can I approve my own stock adjustment?
A: No. When **Adjustments and counts need approval** is on in Accounts settings, an adjustment or physical count must be approved by somebody else with the **Approve stock adjustments** permission. Nobody can approve their own adjustment. The approver can also click **Send back** with a note.

## Q: What stock reports are there?
A: Go to **Accounts → Stock reports**. The tabs are: Summary, By warehouse, Item ledger, Movements, Transfers, Batches & expiry, Serials, Reorder, Count variance, Valuation, Aging, Slow & dead, and Profitability (shown only to people allowed to see it). You can filter by warehouse, category, brand and dates. You need a stock permission such as **See stock**.

## Q: How do I set up warehouses and units of measure?
A: You need the **Set up inventory** permission. Go to **Accounts → Warehouses** to add the places where stock is kept. One warehouse is the default, used when a document doesn't name another. A warehouse with stock in it can't be closed until the stock is transferred out. Go to **Accounts → Units of measure** to add units and how many decimals each takes. An item can also be bought or sold in another unit, like a box of 12.

## Q: What is in Accounts settings for inventory?
A: **Accounts → Accounts settings** needs the **Change Accounts settings** permission. It sets: Periodic or Perpetual inventory accounting; the costing method (**Weighted average** or **FIFO (first in, first out)**); quantity decimals; the default warehouse; switches for **Tax invoices issue stock**, **Vendor bills receive stock**, **Credit notes return stock**, **Reserve stock when an order is approved**, **Allow negative stock**, **Adjustments and counts need approval** and **Vouchers need approval**; and voucher numbering.

## Q: How do I add brands and product families?
A: You need the **Manage brands, families & industries** permission.
1. Go to **Accounts → Brands & families**.
2. Type a name in **Add a brand** and click **Add**.
3. Under a brand, type a family name and click **Add family**.
4. Use the pencil to rename and the bin to delete.
Renaming changes the name on every item. A brand or family that still has items can't be deleted until the items are moved.

## Q: Why can't I add a brand or category?
A: Changing brands, product families and categories needs the **Manage brands, families & industries** permission. No role has it by default; admins do. Ask your admin to give it to your role in **Settings → Roles & Permissions**, or ask someone who has it to add what you need.

## Q: How do I manage item categories?
A: On **Accounts → Items & Inventory**, click **Categories** at the top of the list. Add, rename or delete categories there. This needs the **Manage brands, families & industries** permission. Reports group items by category.

## Q: How do I change many items at once?
A: In **Accounts → Items & Inventory**, tick the items (or the top box for the whole page). In the bar that appears, choose a brand (or **Remove brand**), a product family, the type, a category (or **Remove category**), an HSN/SAC code, or **Mark active** / **Mark inactive**. Then click **Apply to** with the number of items. Fields left on "no change" stay the same. Moving items to another brand clears their product family.

## Q: How do I import items from a CSV file?
A: You need the **Import the catalog** permission.
1. In **Accounts → Items & Inventory**, click **Import CSV**.
2. Click **Download sample CSV** to see the columns.
3. Fill in one row per item. A row with an existing SKU updates that item; a new SKU adds one.
4. Choose the file (2 MB at most) and click **Import**.
5. Read the result: items created and updated, and each skipped row with its reason.
Importing never changes stock.

## Q: My item import skipped some rows. Why?
A: Each skipped row is listed with its reason. Common reasons: the row names a brand, family or category that isn't on your list and you don't have **Manage brands, families & industries**; or, in India, the HSN/SAC code is missing, the wrong kind, or not in the GST portal's list. "File is too large (max 2MB)" means the file must be smaller.

## Q: How do I export my item list?
A: In **Accounts → Items & Inventory**, click **Export CSV**. You need the **Export the catalog** permission. The file can be edited and imported back. If you leave the brand, family or HSN column out, items keep their values. If you include the column with a blank cell, that value is cleared.

## Q: How do I delete an item?
A: Normally you don't delete an item, because orders and documents use it. Instead, untick **Active (sellable / orderable)** on the item, or tick items on the list and choose **Mark inactive**. Inactive items stop appearing in product pickers but stay on old records. Only the workspace's super admin can delete an item, and only one that nothing has used yet.

## Q: Why must I enter an HSN or SAC code?
A: In India, every item needs an HSN code (for goods) or a SAC code (for services) for GST. Deskzo checks the code against the GST portal's list and copies it onto every document line. When items have a missing, wrong-kind or unknown code, the items list shows how many. Click **Show them**, then fix each item, or tick several and set one code from the bar. Outside India the code is optional.

## Q: Why can't I tick "Manage as a subscription"?
A: **Manage as a subscription** is offered only on a Service item, and only when Renewals is available in your plan (Deskzo Subscriptions or Deskzo One). Without Renewals, nothing would renew the item.
