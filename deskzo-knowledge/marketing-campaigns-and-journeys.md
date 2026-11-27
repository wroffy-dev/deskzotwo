# Marketing Automation: Campaigns and Journeys — Deskzo

Marketing Automation sends email to your customers' contacts. You can send one-off campaigns, or set up journeys that start when something happens to a customer. Marketing Automation is part of Deskzo Campaigns and Deskzo One.

## Q: What is Marketing Automation in Deskzo?
A: Marketing Automation sends marketing email to the contacts of your customers. It has these parts, all in the Marketing section of the menu:
- **Send a mass mail**: a step-by-step way to send one email to many people.
- **Campaigns**: a template sent once to an audience, a mailing list, or both.
- **Journeys**: a series of steps that starts when something happens to a customer, such as a renewal coming up.
- **Templates**: the wording of the email.
- **Audiences**: saved filters over your companies, plus rules about which people at each company to write to.
- **Mailing lists**: people uploaded from a CSV file, with a note of how they agreed to hear from you.
- **Suppression list**: people who must not be written to, and why.

## Q: I can't see Marketing in my menu. Why?
A: There are three possible reasons. Ask your admin to check them:
1. Your company's plan must include Marketing Automation (Deskzo Campaigns or Deskzo One).
2. The Marketing Automation module must be switched on in Settings → Modules.
3. Your role must have the **Marketing › Marketing Automation** section ticked in Settings → Roles & Permissions.

## Q: Why is "Send a mass mail" or "Suppression list" missing from my Marketing menu?
A: **Send a mass mail** and **Suppression list** only show to people whose role has the **Build campaigns** permission. Ask your admin to give your role this permission in Settings → Roles & Permissions.

## Q: Which permissions does Marketing Automation use?
A: Marketing Automation uses these permissions, set in Settings → Roles & Permissions:
- **Build campaigns**: write templates, build audiences, upload mailing lists, set up journeys, save campaigns as drafts, use Send a mass mail and manage the suppression list.
- **Send campaigns**: put a campaign in the queue, start or pause a journey, stop a campaign.
- **Approve a large send**: approve a campaign that is big enough to need a second person.
- **See marketing results**: see campaigns, journeys, templates, audiences, lists and who was sent what. This is read-only.
- **Change organisation settings**: open Settings → Mail & messaging.
By default Management has the first three. Management and Sales have See marketing results.

## Q: How do I send a mass email to many customers?
A: You need the **Build campaigns** permission.
1. Go to Marketing → Send a mass mail.
2. Under **Choose the email**, pick a template, or click **New or upload**.
3. Under **Choose who gets it**, pick an **Audience**, an **Uploaded list**, or both. Nobody gets it twice.
4. Under **Check and send**, check the **Campaign name** and choose **Now** or **Later**.
5. Click **Send a test to me** if you want, then **Send to … people** or **Schedule it**.
If you do not have the **Send campaigns** permission, the button says **Save for someone to send**. A colleague who can send will send it from Marketing → Campaigns.

## Q: How do I create a campaign?
A: You need the **Build campaigns** permission.
1. Go to Marketing → Campaigns and click **New campaign**.
2. Enter a **Name**. Choose **Who it goes to** (an audience) and **What they get** (a template).
3. If it should not go at once, set **Not before**, and **Only between** for a daily time window.
4. Click **Save as draft**. Nothing is sent yet.
5. Open the campaign and click **Schedule**. Read who gets it and who is held back.
6. Click **Send to …**, or **Send for approval** for a large send. This step needs the **Send campaigns** permission.

## Q: Why is my campaign waiting for approval?
A: The campaign goes to at least as many people as **Approval needed above** in Settings → Mail & messaging (200 by default). Another person with the **Approve a large send** permission must approve it. You cannot approve a campaign you built. The message is "Somebody else has to approve a campaign you built."

## Q: How do I approve a large campaign?
A: You need the **Approve a large send** permission.
1. Go to Marketing → Campaigns.
2. Set **Status** to **Waiting for approval**.
3. Open the campaign report to check it if you want.
4. Click **Approve**. The campaign is queued straight away.

## Q: How do I see a campaign report?
A: Go to Marketing → Campaigns and click the campaign name. The report shows **Sent**, **Opened** (approximate), **Clicked**, **Unsubscribed**, **Bounced**, **Failed** and **Held back**. It also shows what people clicked, why some were not sent, recent recipients and a copy of the email.

## Q: How do I stop a campaign?
A: Go to Marketing → Campaigns and click **Stop** on the scheduled campaign. You need the **Send campaigns** permission. Messages still waiting are not sent. Messages already on their way carry on. If everything has gone, you see "It has already gone. Nothing to stop."

## Q: Why were some people held back from my campaign?
A: Deskzo checks every person before sending. The report gives a reason for each:
- **Reseller's customer**: go through the reseller instead.
- **No address**, **Address doesn't work**, **Bounced before**: get a working email address.
- **Marked us as spam**, **Unsubscribed**, **Suppressed by hand**: do not write to them.
- **Never opted in**: no consent recorded for this topic.
- **Address not verified**: the address was never checked, or is a shared or free-mail address.
- **Complaint unanswered**: a low feedback score has not been answered.
- **Ticket past its SLA**: sort out their overdue ticket first.
- **Invoice overdue**: an invoice is 60 days or more overdue.
- **Heard from us too recently**: they already got this week's share of email.

## Q: My campaign was sent but nothing has gone out. Why?
A: Open Marketing → Campaigns and look at the top of the page. It warns you if no mail provider carries marketing. It also says when the sender last ran. If you have the **Send campaigns** permission, click **run it now**. Remember that quiet hours, weekends and holidays also hold email back.

## Q: How do I set up a journey?
A: You need the **Build campaigns** permission.
1. Go to Marketing → Journeys and click **New journey**.
2. Enter a **Name**. Choose **What starts it**, for example **Subscription coming up for renewal**, **Warranty running out** or **More staff than seats**. Set the number of days if asked.
3. To limit it to some customers, choose an audience under **Narrow it further**.
4. Under **Steps**, click **Add**. For each step choose **Do what**: **Create a task for one of ours** or **Email the customer**. Set **Days after the previous step**.
5. Under **Stop the sequence if**, tick what should end it. Fill in **May start again after (days)** if it should repeat, for example 365 for a yearly renewal.
6. Click **Who'd it catch?**, then **Save as draft**.
7. Open the journey and click **Start**. This needs the **Send campaigns** permission. **Pause** holds everyone where they are.

## Q: Why didn't a journey step send an email?
A: A journey email step writes to the contact the trigger found, or else to the customer's primary contact. The email is sent only if the address has been checked, the person agreed to the template's topic, and nothing else holds them back. A task step needs the customer to have an account manager or caller to give the task to.

## Q: Can we send marketing email to a reseller's customers?
A: No. A reseller's end customers are left out of every audience and refused at every send, whatever list they are on. Their relationship belongs to the reseller.
