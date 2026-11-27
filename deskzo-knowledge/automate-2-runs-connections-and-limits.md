# Automate: Runs, Connections and Limits — Deskzo

Deskzo Automate records every workflow run and every step in Automate → Runs, and connects to outside apps through Automate → Connections. Automate is included in every Deskzo plan, with limits per plan. This file covers runs, failures, webhooks, connections and plan limits; see the Automate workflows guide for building workflows.

## Q: How do I see what my workflows did?
A: Open **Automate → Runs** in Deskzo. It lists every time a workflow ran and how it went. Choose a **State** to filter, for example only failed runs. Open a run to see each step: when it started, how long it took, a summary of what went in and came out, and any error.

## Q: What do the run states mean?
A: In **Automate → Runs**, a Deskzo run can be: **Queued** (about to start), **Running**, **Waiting** (on a wait or an approval), **Succeeded**, **Failed**, **Cancelled**, or **Needs a decision** (it stopped at a step whose outcome cannot be known).

## Q: How do I fix a failed workflow run?
A: In Deskzo:
1. Open **Automate → Runs** and choose **State: Failed**.
2. Open the run and read the error on the failed step.
3. Fix the cause, for example a connection, a module switched off, or the owner's access.
4. Click **Retry from the failed step**, or click **Cancel run**.
A step that fails for a network reason is tried again on its own a few times over several hours before the run fails.

## Q: How do I retry many failed runs at once?
A: In Deskzo:
1. Fix what made them fail first.
2. Open **Automate → Runs** and choose **State: Failed** (and a workflow, to narrow it).
3. Click **Retry failed runs**.
Each run goes back to the step that failed, the newest 200 at a time. Runs marked **Needs a decision** are left out, because each needs a person to decide.

## Q: What does Needs a decision mean on a run?
A: A Deskzo run marked **Needs a decision** stopped at a step whose outcome cannot be known, for example whether an email or call went out. Open the run and choose **Try the step again** or **Cancel run**.

## Q: My workflow paused itself. Why?
A: A Deskzo workflow that fails twenty times in a row pauses itself, and its owner is notified. The reason shows on **Automate → Workflows**. Fix the cause, then click **Switch on**.

## Q: Why can't I see what a step took in or gave out?
A: In Deskzo, a step's input and output data is what the workflow's owner could see. So it is shown only to the owner and the super admin. Everyone who can open Automate still sees each step's status, time and error. **Copy for a support ticket** copies these into a message.

## Q: A run says a step went out before the workspace was restored. What does that mean?
A: Your Deskzo workspace was restored from a backup, and the run came back with it. That step (an email, call or message) had already gone out after the backup, so Deskzo did not send it twice. Run it again if it should go again; otherwise cancel the run.

## Q: How do I let an outside app start a workflow?
A: To start a Deskzo workflow from a webhook:
1. In the builder, set **Starts when** to **An outside app calls its webhook address**.
2. Click **Make its address**, then **Copy**.
3. In the outside app (your website, a form tool or your own system), send JSON or a form to that address with POST.
4. To accept only signed calls, tick **Take only calls signed with its secret**, and give the app the secret from **Show the secret**.
Keep the address private: anyone who has it can start the workflow.

## Q: How do I change a workflow's webhook address?
A: In the Deskzo builder, click **New address**. The old address stops working at once. Only the workflow's owner sees its address and secret.

## Q: How many webhook calls can a workflow take?
A: A Deskzo webhook address takes up to 60 calls a minute and 5,000 calls a day. A call body can be up to 256 KB. A signed call is accepted once only, never again.

## Q: How do I connect Slack, Microsoft Teams or an outside API?
A: In Deskzo:
1. Open **Automate → Connections** and click **Add a connection**.
2. Choose the **Kind**: Slack, Microsoft Teams or An outside API.
3. Give it a **Name** and paste its address. For an API, also add the **Headers it needs**, such as its key. The screen says where to find each address.
4. Tick **Share with the workspace** if other people's workflows may use it.
5. Click **Add**. For Slack and Teams, **Send a test** posts a message so you can see it arrive.
Addresses and keys are kept encrypted and never shown again. To change one, enter it again.

## Q: Why can't I change or remove a connection?
A: In Deskzo Automate, only the person who added a connection can change or remove it. Others see "Only the person who added a connection changes it." If the connection is shared with the workspace, you can still use it in your workflows.

## Q: How do I connect Google Sheets or WhatsApp to a workflow?
A: In Deskzo, **Google Sheets** uses your own Google mailbox connection, with Sheets allowed. Google must first be set up for mailboxes in **Settings → Security & data protection**. **WhatsApp** uses the provider set up in **Settings → Mail & messaging**, once one is switched on for transactional messages.

## Q: What is the signing secret in Connections?
A: Every call a Deskzo workflow makes to an outside API is signed with the **Signing secret** shown in **Automate → Connections**. The app at the other end can check the call came from your workspace. Show the secret only to give it to that app.

## Q: What are Automate's plan limits?
A: The line at the top of **Automate → Workflows** shows your plan's limits: how many workflows may be switched on at once, how many steps may run in a month, how long a finished run's history is kept, and which outside apps a workflow may reach. Steps count every action that ran (never a test), across the workspace, by calendar month. The more people on your plan, the more steps. For plan details, see [PRICING: to be filled by Deskzo team].

## Q: It says this month's Automate steps are used up. What now?
A: Your Deskzo plan's steps for the month have all run. Admins are told when four fifths are used and again when none are left. No new run starts until the next month, but runs already going finish. Ask whoever manages your plan about more people or the Automate Plus add-on. [PRICING: to be filled by Deskzo team]

## Q: A step says it isn't on this workspace's plan. Why?
A: Some outside apps come with some Deskzo plans only: webhooks come with every plan; saved API connections, Slack and Teams come with every product's plan; Google Sheets comes with Deskzo One or the Automate Plus add-on; WhatsApp comes with the Automate Plus add-on. A workflow already on when the plan changed pauses at that step, and its owner is told.

## Q: What is Automate Plus?
A: Automate Plus is a Deskzo add-on. It raises every Automate limit and adds WhatsApp steps. For pricing, see [PRICING: to be filled by Deskzo team].

## Q: What happens if a step in a workflow fails?
A: On the **Starts when** card, the setting **When a step fails** decides: stop the run there, or note the failure and carry on with the next step. Network failures are retried a few times automatically first.

## Q: How does an approval step in a workflow work?
A: The Deskzo **Ask for approval** step asks named people, or anybody in a role, to approve. They see it in **My work → Approvals** and get an "Approval needed" notification. The first of them to decide does. You set how long to **Wait for a decision** (at most 30 days) and what happens **If nobody decides by then**: take it as rejected or approved.

## Q: I can't see Automate Runs or Connections in my menu. What should I do?
A: Deskzo Automate pages need three things. Check with your admin:
1. Automate must be in your company's plan (it is in every plan).
2. The Automate module must be switched on in **Settings → Modules**.
3. Your role must have the **Change organisation settings** permission in **Settings → Roles & Permissions**.
