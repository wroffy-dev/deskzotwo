# Helpdesk Email, Support Inbox and Ticket Admin — Deskzo

In the Deskzo Helpdesk, emails to your support address can become tickets on their own. This guide covers turning support email into tickets, the Support inbox, bulk changes, support load, deleting tickets and ticket notifications. The Helpdesk is part of Deskzo Desk and Deskzo One.

## Q: I can't see Tickets in my menu. Why?
A: The Helpdesk shows in the menu only when all of these are true:
1. Your company's plan includes the Helpdesk (Deskzo Desk or Deskzo One).
2. The Helpdesk / Tickets module is switched on in **Settings → Modules**.
3. Your role has the **View tickets** permission, and the **Support › Helpdesk / Tickets** section is not hidden for your role.
Ask your admin to check these in **Settings → Modules** and **Settings → Roles & Permissions**. Also, your admin may have renamed "Tickets" in **Settings → Wording**, so look for another word.

## Q: How do I turn our support email into tickets?
A: An admin sets up email-to-ticket once:
1. In **Settings → Departments**, tick **Ticket assignment** for the department whose people answer tickets.
2. Open **Settings → Support email**. Under **Your helpdesk address**, select **Copy address**.
3. In your own mail service, forward the mail from your support address to the helpdesk address. **How to forward your support mail** has steps for Gmail or Google Workspace, Microsoft 365 or Outlook, Zoho Mail and other services.
4. If Gmail sends a confirmation email, it shows under **Gmail asked to confirm forwarding**. Open its link to finish.
5. Set **New tickets by email** and **Replies to customers** on the same page.
6. Send yourself a test email.
For an email to open a ticket on its own, the sender must be a contact at one of your customers. If the page says support email isn't switched on for this platform yet, you can still log tickets by hand.

## Q: What can I set under New tickets by email?
A: In **Settings → Support email**, under **New tickets by email**:
- **Reply to say we've received it**: on by default. The customer gets the ticket number and can add to the ticket by replying. It is never sent to automatic replies.
- **Give new tickets to**: a person in a support team, or **Nobody — the support team is told** (the default).

## Q: Which email address do ticket replies go out from?
A: In **Settings → Support email**, under **Replies to customers**, choose **Deskzo's mail** (the default, nothing to set up) or **Your mail server** (the one set up in **Settings → Mail & messaging**). With your own server, type your support address under **Send as**. If your server cannot send a reply, Deskzo sends it through the other mail and the ticket says why.

## Q: A customer emailed us, but no ticket appeared. What do I check?
A: First look in **Support → Support inbox**. Emails that cannot find a ticket wait there. If the email is not there, check **Settings → Support email**, which shows when the last email arrived. Some mail never becomes a ticket, to stop mail loops: automatic replies, bounces and delivery reports, newsletters and mailing lists, and more than 30 emails an hour from one address.

## Q: What is the Support inbox and how do I sort it?
A: The Support inbox holds emails that could not find their ticket. For example, the sender is not a contact yet, or is a contact at several companies. To sort an email:
1. Open **Support → Support inbox**.
2. To open a ticket, choose the company under **Open a ticket at**. Tick **Save … as a contact there** and type **Their name** if their next email should open a ticket on its own. Select **Open ticket**.
3. To add the email to an existing ticket, type its number under **Or add it to a ticket** and select **Add to ticket**.
4. If it needs no ticket, select **Leave out**.
A ticket opened from the Support inbox starts unassigned. You need the **Create tickets** permission.

## Q: Why did a customer's reply go to the Support inbox instead of its ticket?
A: Only somebody already on a ticket can add to it by email: the ticket's contact, or an address already in its email conversation. Email from anyone else waits in the **Support inbox**, so nobody can add to a customer's ticket by guessing its number. Use **Or add it to a ticket** in the Support inbox if it belongs there.

## Q: A resolved ticket opened again by itself. Why?
A: The customer answered the ticket by email. An email from somebody on the ticket sets a resolved or closed ticket back to OPEN, and the assignee (or the support team) is told.

## Q: How do I add an email sender as a contact from a ticket?
A: When somebody who isn't a contact writes to a ticket, the ticket says "… isn't a contact at … yet." Type **Their name** and select **Add as contact**. If the ticket had no contact, they become its contact. You need to be allowed to change that company's contacts.

## Q: How do I change many tickets at once?
A: In **Support → Tickets**, choose the **Table** view. Tick the tickets, or tick the box at the top for every ticket on the page. In the bar that appears, pick an agent, a status, a priority, or any of them. Select **Apply**. If one ticket cannot be changed, Deskzo stops there; the tickets before it are already changed.

## Q: How do I see which customers take the most support?
A: Open **Support → Support load**. Pick a period of months, then sort by **Most tickets**, **Most support per rupee** or **Most recorded time**. **Heavy support** means at least twice the typical customer's tickets per ₹1 lakh billed. **Light support** means half or less. Billed figures show only to people who can see payments.

## Q: Who can delete a ticket?
A: Only the workspace's super admin can delete a ticket. Anyone else sees "Only the workspace's super admin can delete tickets." Deleting removes the ticket for good, with its comments, its email conversation and its tasks.

## Q: How do I keep rude words out of tickets?
A: An admin opens **Settings → Word filter** and ticks **Keep these words out of tickets**. It is off until you switch it on. You can use Deskzo's preset of abusive words (English, Hindi and Hinglish), add **Your own words** (one a line), and **Let these preset words through**. **Try a message** shows what the filter would do. A ticket, comment or email reply your people write with a blocked word is not saved. A customer's email still reaches its ticket, with the words shown as stars.

## Q: Who gets notified about tickets?
A: Notifications are in the app. The assignee is told about tickets given to them, status changes, comments and missed deadlines. An email that opens a ticket goes to the person under **Give new tickets to**, or to the whole support team. Each person can switch these off in **Settings → Notification preferences**.
