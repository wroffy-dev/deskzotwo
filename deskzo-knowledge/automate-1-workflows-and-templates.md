# Automate: Workflows and Templates — Deskzo

Deskzo Automate runs workflows on their own: on a schedule, when something happens in your workspace, when an outside app calls, or when somebody presses Run. Automate is included in every Deskzo plan, with limits per plan, and sits in the sidebar under the Automate section (Workflows, Templates, Runs, Connections). This file covers building workflows and templates; see the Automate runs and connections guide for runs, connections and limits.

## Q: What is Deskzo Automate?
A: Deskzo Automate does routine follow-up work for you. A workflow has one thing that starts it and a list of steps it then carries out, in order. Examples: a lead arrives, so it is assigned and thanked; an invoice falls overdue, so the customer is sent it again; every morning, yesterday's wins are emailed to the managers. Every run and every step is recorded in **Automate → Runs**.

## Q: Who can use Automate?
A: For now, Deskzo Automate is only for people with the **Change organisation settings** permission. These are the workspace admins, unless an admin has given that permission to another role. Nobody else sees Automate in the menu. Anyone else who tries sees "Only workspace admins can use Automate for now." Because this permission also opens the organisation's settings, give it to as few people as possible.

## Q: What can start a workflow?
A: In the Deskzo workflow builder, the **Starts when** card offers: **On a schedule**; **When somebody presses Run**; **An outside app calls its webhook address**; a lead is created, arrives in a pipeline, moves stage, is won, is lost or has gone quiet; a ticket is opened or its status changes; a document is issued, an invoice is paid in full, falls due within a week or is overdue; a payment comes in; an order is placed, approved or fulfilled; a subscription is coming up for renewal; a form is sent; somebody books a slot; a customer starts a conversation or needs a person; a task is created or done; somebody joins the company. Triggers marked "(daily)" are checked once a day.

## Q: What steps can a workflow do?
A: Deskzo workflow steps include: **Create a task**, **Notify a person**, **Create a lead**, **Assign a lead**, **Move a lead to a stage**, **Add a note to a lead**, **Look up a lead**, **Look up a ticket**, **Open a ticket**, **Escalate a ticket**, **Send an email**, **Email a document**, **Email a report**, **Schedule a meeting**, **Call a webhook or API**, **Post to Slack**, **Post to Microsoft Teams**, **Send a WhatsApp template** and **Add a Google Sheets row**. Flow steps include **Only carry on if…**, **Branch into paths**, **Wait**, **Wait for something to happen**, **Ask for approval**, **For each item in a list**, **Paths at the same time** and **End the run**.

## Q: How do I start a workflow from a template?
A: To use a Deskzo Automate template:
1. Open **Automate → Templates**.
2. Pick a template and click **Use this template**.
3. Fill in its few blanks, such as who to tell or how long to wait, if it has any.
4. Click **Open it in the builder**.
It opens as a draft. Nothing runs until you publish it.

## Q: Which workflow templates are available?
A: **Automate → Templates** in Deskzo includes:
- **Website enquiry: assign, acknowledge, remind**
- **New lead assignment**
- **Follow up when a lead goes quiet**
- **Invoice payment reminders** (makes two workflows: one before the due date, one after)
- **Subscription renewal notices** (30, 15 and 7 days before the end)
- **Escalate unanswered tickets**
- **Booking confirmation and reminder**
- **Daily sales report**
- **Customer onboarding after a won deal**
- **Employee onboarding checklist**
Your company's own saved templates also show there.

## Q: How do I build a workflow from nothing?
A: To build a new Deskzo workflow:
1. In **Automate → Workflows**, click **New workflow**. It opens in the builder.
2. Give it a **Workflow name** and a line in **What it is for**.
3. Click the **Starts when** card and choose what starts it. Add rules under **Only when** to narrow it, for example only leads from one source.
4. Click **Add a step here** (the +) and choose a step.
5. Click a step's card to fill it in. Use **Insert data** to put in a value from what started the workflow or an earlier step, such as the lead's title.
The draft saves as you go; the top of the builder says **Saved**. Problems are marked on the cards and must be fixed before you can publish.

## Q: Can AI build a workflow for me?
A: Yes, if AI is available in your workspace. In **Automate → Templates**, use **Describe it**. Say what should happen in a sentence or two (up to 2,000 characters), then click **Draft it**. Deskzo drafts the workflow and lists what you still need to choose in the builder. It is a draft: nothing runs until you publish it. Your words are sent to the AI service the copilot uses.

## Q: How do I test a workflow before switching it on?
A: In the Deskzo builder, click **Test**. The draft runs on the latest real record of its kind that you can see, for example the newest lead. Read the result on each card. The test also shows in **Automate → Runs**, marked as a test. In a test, conditions and branches are worked out for real, look-ups are done, and waits are skipped. Every other step only says what it would have done.

## Q: Does a test send emails or call outside apps?
A: No. A Deskzo workflow test never sends emails, documents, meetings or outside calls. If you tick **Do the safe steps for real**, the test also really does the safe steps on the test record: creating a task, adding a note to a lead and notifying a person.

## Q: How do I publish a workflow and switch it on?
A: To publish a Deskzo workflow:
1. In the builder, click **Publish**. It stays greyed out while any problem is marked.
2. Optionally say what changed in **What changed (optional)**.
3. Click **Publish**.
The draft becomes the version that runs, and the workflow is switched on. Runs already under way finish on the version they started with.

## Q: I changed a workflow, but runs still do the old thing. Why?
A: Your changes are in the draft. In Deskzo Automate, the draft does not run until you publish it. Click **Publish** in the builder. Runs that had already started finish on their own version.

## Q: How do I go back to an earlier version of a workflow?
A: In the Deskzo builder, open **More → Versions**. Click **Back into the draft** next to the version you want, then click **Publish**.

## Q: How do I pause, switch on, run or archive a workflow?
A: In Deskzo Automate:
- In **Automate → Workflows**, **Pause** stops a workflow starting new runs, and **Switch on** starts it again.
- **Run now** appears for a workflow that starts **When somebody presses Run**.
- In the builder, **More** has **Pause it**, **Switch it on**, **Duplicate** and **Archive**. Archiving stops a workflow for good; its runs stay in the history.

## Q: How do I stop all workflows at once?
A: On **Automate → Workflows** in Deskzo, click **Pause every workflow**. Nothing starts or moves on in the workspace until you click **Let workflows run again**.

## Q: Who does a workflow run as?
A: A Deskzo workflow runs as its owner, the person who made it, shown under **Runs as** on the Workflows page. Every step is checked against what that person may do at the moment it runs. It starts only on records the owner can see. If the owner's account is switched off, every step is refused.

## Q: Why can't I change a colleague's workflow?
A: A Deskzo workflow runs as its owner, using their mailbox, connections and access. So only the owner can change, test or publish it. Others who can open Automate see it read-only, and may pause it, switch it on, run it or duplicate it. To change it, use **More → Duplicate** to make your own copy, or take it over.

## Q: How do I take over a colleague's workflow?
A: In Deskzo:
1. Open the workflow. The builder shows it read-only, with who it runs as.
2. Click **Take over** and confirm. It is now yours, and switched off.
3. Check its steps (it now runs as you, with your access and connections) and click **Publish** to switch it on.
The previous owner is told.

## Q: Why is a step greyed out when I add it?
A: In the Deskzo builder, a step is greyed out when the workflow's owner cannot use it right now. The step may need a module your plan does not include, or one switched off in **Settings → Modules**. Or the owner may not have the module or permission it needs, for example **Email sales documents to customers** for **Email a document**, **Schedule meetings** for **Schedule a meeting**, or **Create tickets** for **Open a ticket**. The reason shows under the step's name.

## Q: How do I export, import or save a workflow as a template?
A: In the Deskzo builder, **More** has **Export as a file** and **Save as a company template**. A company template then shows under **Automate → Templates** for others to start from. To bring in a workflow file, use **Import a workflow** on **Automate → Workflows**. A workflow file can be up to 512 KB. People and records from another workspace are cleared on import or export.

## Q: How do I start a workflow for a pipeline?
A: Pipeline automations are now Deskzo workflows. Go to **Settings → Pipeline**. Each pipeline lists its workflows with a link to each. Choose **When a lead arrives** or a stage, then click **New workflow for this** to start a draft for that pipeline.

## Q: I can't see Automate in my menu. What should I do?
A: If the **Automate** section is missing in Deskzo, check with your admin:
1. Automate must be in your company's plan (it is in every plan).
2. The Automate module must be switched on in **Settings → Modules**.
3. Your role must have the **Change organisation settings** permission in **Settings → Roles & Permissions**. Automate needs it for now.
