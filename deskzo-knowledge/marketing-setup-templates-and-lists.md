# Marketing Automation: Setup, Templates, Audiences and Consent — Deskzo

This guide covers setting up marketing email, writing templates, building audiences, uploading mailing lists, and managing consent and the suppression list. Marketing Automation is part of Deskzo Campaigns and Deskzo One.

## Q: I can't see Marketing in my menu. Why?
A: There are three possible reasons. Ask your admin to check them:
1. Your company's plan must include Marketing Automation (Deskzo Campaigns or Deskzo One).
2. The Marketing Automation module must be switched on in Settings → Modules.
3. Your role must have the **Marketing › Marketing Automation** section ticked in Settings → Roles & Permissions.

## Q: Which permissions does Marketing Automation use?
A: Marketing Automation uses these permissions, set in Settings → Roles & Permissions:
- **Build campaigns**: write templates, build audiences, upload mailing lists, set up journeys, save campaigns as drafts, use Send a mass mail and manage the suppression list.
- **Send campaigns**: put a campaign in the queue, start or pause a journey, stop a campaign.
- **Approve a large send**: approve a campaign that is big enough to need a second person.
- **See marketing results**: see campaigns, journeys, templates, audiences, lists and who was sent what. This is read-only.
- **Change organisation settings**: open Settings → Mail & messaging.
By default Management has the first three. Management and Sales have See marketing results.

## Q: How do I set up email sending for marketing?
A: An admin with the **Change organisation settings** permission does this once:
1. Go to Settings → Mail & messaging.
2. Under **Mail providers**, click **Set up** on the service you will send with. Fill in its details.
3. Tick **Switched on** and **Carries marketing**. Enter a **From name** and **From address**. Save, then click **Test**.
4. Under **Sending domain**, enter the domain marketing goes out from. Deskzo suggests a subdomain, separate from the domain your invoices come from. Click **Check SPF, DKIM and DMARC** and fix any problems with whoever runs your domain.
5. Give your provider the address shown under **Delivery reports**, so bounces and spam complaints come back to Deskzo.
6. Check **When, and how often** and click **Save**.
Then give people their permissions in Settings → Roles & Permissions.

## Q: What are the sending limits and quiet hours for marketing email?
A: These are in Settings → Mail & messaging, under **When, and how often**:
- **Quiet from** and **Until**: no marketing email goes out between these times. The default is 8:00 pm to 9:00 am.
- **Skip weekends and company holidays**: on by default. It uses the company holiday calendar.
- **Most a contact hears from us**: the most marketing emails one contact gets per week, across all campaigns and journeys. The default is 2.
- **Approval needed above**: a send to this many people or more needs a second person to approve it. The default is 200.
- **Postal address for the footer**: printed at the bottom of every marketing email. Leave it blank to use your registered office.

## Q: How do I write an email template?
A: You need the **Build campaigns** permission.
1. Go to Marketing → Templates and click **New template**.
2. Enter a **Name**. Choose the **Topic**. Only contacts who agreed to that topic will get the email.
3. Write the **Subject**, the **Preview line** and the **Body**. Or click **Upload .html or .zip** to use a design from an email builder.
4. Click **Insert a field** to add things like the person's first name or company.
5. Click **Save**, then **Send a test to me** to check it in your own inbox.

## Q: What does {{firstName|there}} mean in a template?
A: It is a field. Deskzo puts each person's first name in its place. The word after the bar ("there") is used when the person has no first name. If a field has no value and nothing after the bar, Deskzo holds that person back instead of sending a half-filled email.

## Q: What topics can a marketing template have?
A: Each template has one topic: **Renewal reminders**, **Service notices**, **Offers and pricing**, **Product news**, **Events and webinars** or **Newsletter**. A contact only gets the email if they agreed to hear about that topic.

## Q: How do I build an audience?
A: You need the **Build campaigns** permission.
1. Go to Marketing → Audiences and click **New audience**.
2. Enter a **Name** and **What it's for**.
3. Choose the company filters, for example owner, products bought, renewals, pipeline or last call.
4. Under **Who at each company**, pick the **Job titles** and **At most, per company**. Or tick **Primary contact only**.
5. Click **Who'd get this?** to see how many people would get the email, and why others would not.
6. Click **Save**.

## Q: How do I upload a mailing list?
A: You need the **Build campaigns** permission.
1. Go to Marketing → Mailing lists. Under **Upload a list**, enter a **List name**.
2. Choose a CSV file. The first row must name the columns: Email (required), Name, Company, Phone, Designation.
3. Under **What did they agree to hear about?**, tick the topics.
4. Under **How did they agree?**, say where and when they agreed.
5. Tick the box to confirm these people agreed to hear from you and the list was not bought or scraped.
6. Click **Upload list**.
A CSV file can be up to 5 MB. Only the first 5,000 people are taken. Each person is matched to a contact by email, or added as a new contact.

## Q: My mailing list upload shows an error. What does it mean?
A: Common messages:
- "That CSV is over 5 MB — split it into smaller lists." Make smaller files.
- "Upload the list as a .csv — Excel can save one with File › Save As." Save the file as CSV.
- "Confirm that these people agreed to hear from us." Tick the confirmation box.
- "Say how they agreed — for example “signed up at our Pune roundtable on 12 Sep”." Write a longer consent note.
- "Pick what they agreed to hear about." Tick at least one topic.

## Q: How do I stop someone from getting marketing email?
A: You need the **Build campaigns** permission.
1. Go to Marketing → Suppression list and click **Suppress somebody**.
2. Under **What**, choose an **Address** or a **Whole domain** (or a contact or company). Type it and say **Why**.
3. Click **Add**.
Unsubscribes, bounces and spam complaints are added to the Suppression list automatically.

## Q: Can I remove an unsubscribed person from the suppression list?
A: No. An unsubscribe or a spam complaint cannot be removed by hand. Deskzo shows: "They asked us to stop. If they've since asked to be added back, record that as consent instead." The person can choose topics again on their own preferences page, using the link in any email you sent them.

## Q: How does a customer unsubscribe from Deskzo marketing email?
A: Every marketing email ends with a link to the person's own preferences page. There they choose topics or unsubscribe from everything. Unsubscribing puts them on the Suppression list and ends any journey they are in. Business emails such as invoices, quotes, order confirmations and ticket replies still reach them.
