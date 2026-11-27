# IT Assets — Deskzo

IT Assets is a register of every machine and software licence: your own, yours at a client, and client estates you look after. It tracks who holds each one, warranty and AMC cover, movement history, and consignments that ship kit. It is part of Deskzo Inventory and Deskzo One. In the sidebar it is the **IT Assets** section: **Assets**, **What I'm holding** and **Consignments**.

## Q: What is IT Assets in Deskzo?
A: IT Assets tracks each machine and licence on its own: tag, serial number, make, model, who has it, where it is, and whether warranty or AMC covers it. Every hand-over, return, repair and transfer is recorded as a movement. Consignments move kit between places, with delivery challans and, in India, e-way bills.

## Q: I don't see IT Assets in my menu.
A: Check with your admin:
1. Your plan must include Deskzo Inventory or Deskzo One.
2. IT Assets must be switched on in **Settings → Modules**.
3. Your role needs the section **IT Assets** in **Settings → Roles & Permissions**.
**Consignments** also needs the **Manage IT assets** permission.

## Q: Which permissions does IT Assets use?
A: In **Settings → Roles & Permissions**:
- **Manage IT assets** — add assets, record movements, see licence keys, and run Consignments. Includes seeing every asset.
- **See every IT asset** — see the whole register, including other people's kit, client estates, and a customer's IT Assets tab.
- **Process orders (purchasing)** — also opens **Settings → Transporters**.
Everyone with the IT Assets section has **What I'm holding**.

## Q: What does "Whose is it?" mean on an asset?
A: Every asset in Deskzo IT Assets says whose it is:
- **Ours — used internally**: your own kit, in the office or with a person.
- **Ours — at a client**: yours, standing at a customer's site. It must come back.
- **The client's — we manage it**: the client's property, on your register because you look after it. It can never be linked to a fixed-asset record.

## Q: How do I add an asset?
A: To add an asset:
1. Go to **IT Assets → Assets** and select **Add an asset**.
2. Choose **Whose is it?**. For a client's asset, choose the client under **Whose?**.
3. Enter the **Asset tag**, **Serial number**, **What kind**, **Name**, **Make** and **Model**.
4. For your own kit, say where it is **Sitting at** and **Which site**. For a software licence, enter the **Licence key** and **Seats**.
5. Add **Bought on**, **Cost**, **Warranty ends**, **AMC ends**, **Bought from** and **Catalogue item** if you have them. For your own kit you can link its **Financial record**.
6. Select **Add**.
You need **Manage IT assets**.

## Q: How do I register a new laptop?
A: A laptop is an asset. Go to **IT Assets → Assets**, select **Add an asset**, choose **Whose is it?**, enter the **Asset tag** (the label on the machine), **Serial number**, **Name**, **Make** and **Model**, add warranty dates, and select **Add**.

## Q: How do I assign an asset to an employee?
A: To hand an asset to someone:
1. Open the asset from **IT Assets → Assets**.
2. Under **Record a movement**, select **Assigned**.
3. Choose **When** and **To whom**, add a **Note** if you like, and confirm.
The person is told it is theirs. It stays on their name until it is returned. When it comes back, select **Returned**.

## Q: What movements can I record on an asset?
A: Under **Record a movement** on an asset: **Assigned**, **Returned**, **Sent for repair** (with **Where to**), **Back from repair**, **Transferred** (to a company and site), **Scrapped** and **Reported lost**. The asset's status follows from the last movement.

## Q: Why is a movement button greyed out?
A: The movement does not make sense from where the asset is now. For example, an asset away for repair must come back first, and a scrapped asset cannot be moved. Point at the button to see why.

## Q: How do I confirm I have an asset?
A: Go to **IT Assets → What I'm holding**. On the asset handed to you, select **Yes, I have it**. Only the person it was handed to can confirm. The card then shows the day you confirmed.

## Q: Where can I see the equipment issued to me?
A: Go to **IT Assets → What I'm holding**. It lists the company equipment on your name. This list is also used by the offboarding checklist when someone leaves.

## Q: The Assets page shows only my own kit.
A: Seeing other people's kit and client estates needs the **See every IT asset** permission (or **Manage IT assets**). Without it, **IT Assets → Assets** shows only what you are holding. Ask an admin.

## Q: Why can't I see the licence key?
A: Licence keys show only to people with the **Manage IT assets** permission.

## Q: How do I track warranty and AMC expiry?
A: The **IT Assets → Assets** page counts assets whose **Cover running out** is within 30 days or already lapsed. Each asset's **Cover** card shows the warranty and AMC end dates. An asset is covered if either is still live.

## Q: How do I see the assets at a customer's site?
A: Open the customer company and go to its **IT Assets** tab. It shows **Theirs, managed**, **Ours at their site**, **On the road** and **Cover running out**. Select **Add to their estate** to add one of their machines. You need **See every IT asset**.

## Q: I can't open Consignments.
A: **IT Assets → Consignments** needs the **Manage IT assets** permission. Without it, Consignments is not in the menu. Ask an admin.

## Q: How do I create a consignment to ship assets?
A: To create a consignment:
1. Go to **IT Assets → Consignments** and select **New consignment**.
2. Choose **Why is it moving?**, **Dispatch from**, **To** and the **Site**.
3. Pick the **Transporter** and the **Expected** day.
4. Under **What's going**, tick the assets. Software licences cannot be sent.
5. Add **Notes** if you like and select **Create**.
It starts as **Being packed**. For anything that is not a sale, open it and select **Raise the challan** to make the delivery challan.

## Q: How do I dispatch and deliver a consignment?
A: Open the consignment and select **Dispatch**. Fill in **Dispatched on**, **Courier**, **Docket number**, **LR number**, **Vehicle** and, where needed, **E-way bill number** and **Valid until**. Select **Dispatch**. When it arrives, select **Mark delivered**, enter **Delivered on** and **Received by**, tick **Installed and working, not just dropped off** if true, and select **Delivered**. To call one off before delivery, select **Cancel**, say why, and select **Cancel it**.

## Q: Dispatch says the consignment needs an e-way bill.
A: In India, a consignment over the value threshold, or crossing a state line, needs an e-way bill even if nothing is sold. Deskzo says "This needs an e-way bill before it moves." Raise the e-way bill from the consignment once the challan exists, or enter the number of one already raised, then dispatch again. The threshold and portal connection are in **Settings → e-Way bills**.

## Q: How do I add a courier or transporter?
A: Go to **Settings → Transporters** and select **New transporter**. Enter the **Name**, **GSTIN or TRANSIN** (15 characters, letters and digits), contact details and **Usual mode** (Road, Rail, Air or Ship). Retired transporters can be restored; **Show retired** lists them. You need **Manage IT assets** or **Process orders (purchasing)**.

## Q: Why can't a client's laptop have a fixed-asset record?
A: An asset marked **The client's — we manage it** is their property, not yours. Linking it to a fixed-asset record would put someone else's asset on your balance sheet, so Deskzo does not allow it.
