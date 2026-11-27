# Leads and the Sales Pipeline — Deskzo

Leads is the Deskzo sales pipeline: every deal on a board, from a new enquiry to a won or lost deal, in your own stages and team pipelines. Leads is part of Deskzo CRM, Deskzo Pipeline and Deskzo One.

## Q: What is a lead in Deskzo?
A: A lead is a real requirement from a company: what they want, roughly what it is worth and when it might close. In Deskzo, Leads shows all your leads as a board (one column per stage) or as a table. Your admin may have renamed "Leads" to another word (for example "Deals" or "Enquiries") in Settings → Wording, so your menu may show a different name.

## Q: How do I add a lead?
A: To add a lead in Deskzo:
1. Go to Sales → Leads and click **New lead**.
2. If your company has more than one pipeline, choose the **Pipeline**. The lead starts at the first stage of that pipeline.
3. Choose the **Company**. If one person is behind the requirement, choose the **Contact**, or click **+ New contact**.
4. Enter a **Title** and the **Requirement details**.
5. If you know them, add the **Estimated value (₹)** and the **Expected close date**. Add the **Source** and any **Source detail**.
6. Under **Salesperson**, choose who the lead is for, or leave it empty so the lead assignment rules choose.
7. Add products with **+ Add product**, and fill in **More details** if your company has its own lead fields.
8. Click **Create lead**.
The person the lead is assigned to is notified (if it is not you).

## Q: How do I create a new deal or enquiry?
A: In Deskzo a deal or enquiry is a lead. Go to Sales → Leads, click **New lead**, choose the **Company**, enter a **Title** and **Requirement details**, and click **Create lead**.

## Q: Who can use Leads? Which permission do I need?
A: To open Sales → Leads you need the **View leads** permission. With it you can add leads, move them through stages, edit them and log activity on the leads you can see. By default the Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it. An admin sets permissions in Settings → Roles & Permissions.

## Q: Which leads can I see?
A: In Deskzo you see the leads on the companies you manage, plus the leads of the people who report to you. If your role has the **See every account, not just your own** permission, you see every company's leads. Sales does not have that permission by default.

## Q: I can't see Leads in my menu. Why?
A: There are three possible reasons:
1. Leads is not in your company's plan. Leads comes with Deskzo CRM, Deskzo Pipeline and Deskzo One.
2. The Leads module is switched off in Settings → Modules.
3. Your role does not have the **View leads** permission, or the **Sales › Leads** section is unticked for your role in Settings → Roles & Permissions.
Ask your admin to check these. Also note that your admin may have renamed "Leads" in Settings → Wording.

## Q: How do I move a lead to the next stage?
A: To move a lead in Deskzo:
1. On the board in Sales → Leads, drag the lead's card to the new stage column. Or open the lead and choose the stage in the stage list beside **Edit**.
2. If you move it to a stage that counts as lost or disqualified, Deskzo asks for the reason first.
3. If the stage needs details the lead does not have yet, the move is stopped and Deskzo tells you what to fill in.
Every move is noted on the lead's timeline.

## Q: Why won't my lead move into a stage? It says "Before ..., fill in ...".
A: The stage has a rule: a lead must have certain details before it can move there. The message looks like "Before Proposal sent, fill in Value and Expected close date." Some stages also need a quotation, and the message says "Before ..., issue a quotation for it." Click **Edit** on the lead, fill in what is missing (or issue the quotation), then move it again. An admin sets these rules in Settings → Pipeline.

## Q: What happens when a lead is won?
A: When a lead in a sales pipeline is moved to a stage that counts as Won:
- Its company becomes a customer (it shows "Awaiting Order" until its first order is placed).
- The win counts towards targets and the Wins wall.
- If the pipeline is connected to another pipeline, a new lead starts there with the same company, contact, owner and value.

## Q: What do the stage meanings (New, Contacted, Won, Lost...) mean?
A: In Deskzo your stages can have any name, like "Site visit" or "Booked". But each stage "counts as" one fixed meaning: New, Contacted, Qualifying, Qualified, Proposal sent, Negotiation, Won, Lost or Disqualified. Deskzo uses the meaning for targets, wins and the forecast. For example, the forecast weighs open leads by how far along their meaning is. Pipelines that do not count as sales use the meanings Start, Under way, Done and Dropped.

## Q: How do I log a call, email, note or meeting on a lead?
A: Open the lead and use **Log activity**. Choose the kind (call, email, note or meeting), write what happened, and log it. The lead's owner is notified if it is not you. Everything appears in the lead's **Activity** list, newest first. You can also click **Call**, **Plan visit** or **Create proposal** where those features are on and allowed.

## Q: How do I edit a lead?
A: To edit a lead in Deskzo:
1. Open the lead and click **Edit**.
2. Change the **Title**, **Value**, **Expected close date**, **Contact** or **Description**.
3. Click **Save**.
A field that is masked for you cannot be changed until the lead is unmasked.
You can also ask Deskzo AI in the chat to change one lead.

## Q: Can Deskzo AI edit a lead from the chat?
A: Yes, one lead at a time. Ask Deskzo AI (the AI copilot), for example "Change the quantity on LEAD-000123 to 60". If several leads or products fit, or a number could mean two things, it asks which you mean. Then it shows a card with each old and new value. Nothing changes until you press **Save changes**.
Deskzo AI can change the quantity of a product on the lead, and the lead's title, description, estimated value and expected close date, if you can change them yourself. A quantity needs the **Edit products & subscriptions** permission. A won lead's value is locked. It cannot change the owner, stage, contact or company, delete a lead, or change several leads at once.

## Q: What is the lead score (Hot, Warm, Cold)?
A: Every open lead in Deskzo has a score out of 100, graded Hot, Warm or Cold. The **Lead score** card on the lead's page explains every point: fit, intent, engagement and stage, minus points for going quiet or for a close date that has passed. Won and lost leads have no score. In the lead list you can sort by **Highest score** to work the hottest leads first.

## Q: How do I find a lead or filter the lead list?
A: In Sales → Leads:
- Choose **Board**, **Table** or **Split** view. Split shows the table with a lead open beside it.
- If you have several pipelines, choose one from the row under the title.
- Search by title or company, and filter by **Stage** and **Owner** (including **Unassigned**).
- Open **More** for Source, Score, Quotation, Sort, Expected close and your own fields, then click **Apply**.
If a lead is missing, check the pipeline you are viewing and your filters. If the lead is on an account you cannot see, it is not shown to you.

## Q: I can't choose the salesperson when I add a lead.
A: Your role does not have the **Assign leads to others** permission (or **Reassign accounts and leads**). The new lead form tells you where the lead will go: to you if your role is Sales, otherwise to whoever the lead assignment rules choose. If you get "You can't assign leads to other people.", ask your admin for the permission.

## Q: How do I change the owner of a lead or give it to a colleague?
A: Open the lead and change the owner. To pass a lead you own to a colleague you need the **Hand off your own accounts and leads** permission. To change the owner of anyone's lead, or to leave a lead with nobody, you need the **Reassign accounts and leads** permission. Every owner change is written to the activity log.

## Q: How do I reassign or move many leads at once?
A: In Deskzo:
1. Go to Sales → Leads and switch to the **Table** view.
2. Tick the leads.
3. In the bar that appears, choose a new owner (or **Unassign**) and/or a stage. A lost or disqualified stage needs a **Reason (required)**.
4. Click **Apply**.
An owner change is all or nothing: if any lead is not yours to hand on, no owner changes and you see "Some of the selected leads are not yours to change." Stage changes are made lead by lead and stop at the first lead that cannot move.

## Q: How do I move a lead to another team's pipeline?
A: Open the lead and click **Move to pipeline**. Choose the **Pipeline** and the **Stage**, then click **Move to** with the pipeline's name. The lead keeps its history. A won or lost lead cannot be moved: you will see "A won or lost lead stays where it closed. Reopen it first."

## Q: How do I export leads to a spreadsheet?
A: In Sales → Leads click **Export**. You get a CSV file of the leads you can see, with title, company, owner, value, close date and products.  Exporting needs the **Export customer data** permission. No built-in role has it by default; admins do. Without it you see "You can't export leads."

## Q: Can I delete a lead?
A: Normally no. A lead that did not work out should be moved to a stage that counts as Lost or Disqualified, with a reason, so the pipeline history stays complete. Only the workspace's super admin sees a **Delete** button on a lead. Deleting cannot be undone.

## Q: Some fields on a lead say they are masked.
A: Your role's field access hides those fields. If your role may unmask, opening the lead unmasks it for the rest of the day, within a daily limit. Otherwise ask your admin.

## Q: How do I set up pipelines and stages?
A: A person with the **Manage the sales pipeline** permission (Management by default) opens Settings → Pipeline. There you can:
- Rename, reorder and colour stages, add new ones and retire unused ones. Each stage has a Name, what it **Counts as**, and a Colour.
- Tick what a lead must have before it moves into a stage: Value, Expected close date, Contact, Owner, Description, an issued quotation, or your own lead fields.
- Add a pipeline for each team, and choose if it **Counts as sales**. Use "carry it on into" to connect one pipeline's won leads to the next pipeline.
A workspace can have up to 15 pipelines. The main pipeline cannot be retired. A pipeline with open leads cannot be retired.

## Q: How do I make new leads go to the right salesperson automatically?
A: An admin with the **Change organisation settings** permission opens Settings → Lead assignment. Rules are tried top to bottom, and the first rule that fits decides. A rule can match things like Brand, Product type, Contact's designation, Source, State or Customer category. Under **Assign by** choose **Round robin**, **Fewest open leads**, **By performance**, **A named person** or **The account manager**, and pick the people. You can tick **Skip anyone on approved leave that day**. Use **Test a lead** to see who a lead would go to without assigning anything.

## Q: Website leads arrive unassigned. How do I fix this?
A: No lead assignment rule fits those leads. An admin can add a rule with no conditions, placed last in Settings → Lead assignment, so every lead that nothing else catches still goes to somebody. Use **Test a lead** to check.

## Q: How do I get enquiries from my website into Deskzo as leads?
A: An admin opens Settings → Lead capture API and creates a key with **New key for**, with an optional Source label. The key ID and secret are shown once, so copy them. Give the documentation on the same screen (**Download (.md)**) to your website developer. The secret must stay on the website's server. To stop a key, click **Revoke**; leads already sent stay. Booking pages and forms can also open leads.

## Q: Can a pipeline run automations when a lead enters a stage?
A: Yes. In Settings → Pipeline, an admin can click **New workflow for this** to start a workflow in Automate, for example to make a task or email the contact when a lead enters a stage.
