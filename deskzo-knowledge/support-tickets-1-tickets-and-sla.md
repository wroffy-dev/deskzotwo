# Helpdesk Tickets and SLAs — Deskzo

The Helpdesk in Deskzo keeps every support request as a ticket against a customer, with a priority, a service deadline (SLA), an agent and a comment thread for your team. This guide covers logging, assigning and working on tickets. The Helpdesk is part of Deskzo Desk and Deskzo One.

## Q: What is the Helpdesk in Deskzo?
A: The Helpdesk keeps each support request as a ticket against a customer company. A ticket records who raised it, what it is about, how urgent it is, who is working on it and its status. Each ticket gets a number like TCK-000123. Tickets come in two ways: somebody logs one with **New ticket**, or a customer emails your support address and the email opens a ticket. The Helpdesk links are in the **Support** section of the menu: **Tickets**, **Support inbox** and **Support load**. An admin can rename the word "Ticket" in **Settings → Wording**, so your menu may use a different word.

## Q: I can't see Tickets in my menu. Why?
A: The Helpdesk shows in the menu only when all of these are true:
1. Your company's plan includes the Helpdesk (Deskzo Desk or Deskzo One).
2. The Helpdesk / Tickets module is switched on in **Settings → Modules**.
3. Your role has the **View tickets** permission, and the **Support › Helpdesk / Tickets** section is not hidden for your role.
Ask your admin to check these in **Settings → Modules** and **Settings → Roles & Permissions**. Also, your admin may have renamed "Tickets" in **Settings → Wording**, so look for another word.

## Q: I can see Tickets but not Support inbox. Why?
A: The **Support inbox** link needs the **Create tickets** permission. Without it, the Support inbox is not in your menu. Ask your admin to give your role the **Create tickets** permission in **Settings → Roles & Permissions**.

## Q: Which permissions does the Helpdesk use?
A: The Helpdesk uses these permissions in **Settings → Roles & Permissions**:
- **View tickets**: opens the ticket list, a ticket's page, Support load and the Tickets tab on a customer's page. Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default.
- **Create tickets**: log a new ticket and sort the Support inbox. Support, Sales and Management have it by default.
- **Change organisation settings**: opens **Settings → Support email** and **Settings → Word filter**. Only admins have it by default.
Which tickets you see follows the customer: if you can see a company, you can see its tickets. An admin can also limit how far a role reaches (own, team, branch or all) in **Settings → Roles & Permissions**, or for one person in **Settings → Users**.

## Q: How do I log a new ticket?
A: To log a ticket in the Helpdesk:
1. Open **Support → Tickets** and select **New ticket**. Or open the customer's page, go to its **Tickets** tab and select **+ New ticket**.
2. Choose the **Company**, then the **Contact** if the ticket is about one person.
3. If the ticket is about something the customer bought, choose it under **Order this is about**. Otherwise the ticket is logged as **Free Support**.
4. Type a **Title** and a **Description**.
5. Pick the **Support type** (Product Support, Demo, Installation, Training or Other) and the **Priority**.
6. Under **Assign to**, choose a person from the support team, or leave it **Unassigned**.
7. Select **Create ticket**.
You need the **Create tickets** permission.

## Q: How do I raise a support ticket for a customer?
A: Open **Support → Tickets** and select **New ticket** (or use **+ New ticket** on the customer's **Tickets** tab). Choose the **Company** and **Contact**, type a **Title** and **Description**, pick the **Support type** and **Priority**, choose who to **Assign to**, and select **Create ticket**. The ticket gets a number and a deadline based on its priority. You need the **Create tickets** permission.

## Q: How is a ticket's SLA deadline worked out?
A: The ticket deadline (SLA) comes from the ticket's priority, counted from when the ticket was created:
- URGENT: 4 hours
- HIGH: 24 hours
- MEDIUM: 72 hours
- LOW: 168 hours (7 days)
The hours are fixed and cannot be changed. The clock keeps running while a ticket is ON HOLD. The SLA column shows "Due by" and a time, or "Overdue since" and a time. A resolved or closed ticket shows Resolved or Closed instead. The person the ticket is assigned to is told when it passes its deadline.

## Q: How do I change a ticket's status or priority?
A: Open the ticket from **Support → Tickets**. Pick a new **Status** (OPEN, IN PROGRESS, ON HOLD, RESOLVED or CLOSED) or a new **Priority**. Each change saves as soon as you pick it. Setting a ticket to RESOLVED or CLOSED records the date. Moving it back to OPEN, IN PROGRESS or ON HOLD clears that date.

## Q: How do I assign a ticket to a colleague?
A: Open the ticket. Select the agent button (it shows **Assigned: …** or **Unassigned**). Choose a person under **Assign to** and select **Save**. The person gets a notification in the app. Only people in a support department can hold tickets.

## Q: Why can't I assign a ticket to my colleague?
A: Only people in a department ticked for **Ticket assignment** can be given tickets. If you try someone else, Deskzo shows "Tickets can only be assigned to someone in the Tech Support department." Ask your admin to tick **Ticket assignment** for that department in **Settings → Departments**, or to move the person into a support department.

## Q: How do I leave a note on a ticket for my team?
A: Open the ticket. Type in **Add a comment…** and select **Post comment**. Comments on a ticket are for your team only. The customer never sees ticket comments. The person the ticket is assigned to is told about new comments.

## Q: How do I reply to a customer by email from a ticket?
A: To email the customer from a ticket:
1. Open the ticket and go to **Email conversation**. The box says who the reply goes to (**Reply to …**).
2. Type your reply.
3. Add people to copy in under **Cc (optional)**, separated by commas.
4. Select **Send reply**.
Your name is added under the reply. When the customer answers, the answer comes back to the same ticket. If a reply could not be sent, it shows **Not sent** with the reason.
