# Customer Portal — Deskzo

The Customer Portal in Deskzo gives each customer a private page with their subscriptions, invoices and support tickets. Customers open it with a private link instead of a password, and can ask to renew, ask for more licences or ask a question. The Customer Portal is part of Deskzo Desk and Deskzo One.

## Q: What is the Customer Portal in Deskzo?
A: The Customer Portal is a page your customer opens to check their account without calling you. Customers have no account and no password in Deskzo. Each person gets a private link, and opening the link is signing in. What the portal shows is one setting for every customer, in **Settings → Customer portal**. Who gets in is decided customer by customer. When a customer asks for something from the portal, it arrives in **Support → Customer requests**.

## Q: I can't see Portal access or Customer requests in my menu. Why?
A: The Customer Portal links show only when all of these are true:
1. Your company's plan includes the Customer Portal (Deskzo Desk or Deskzo One).
2. The Customer Portal module is switched on in **Settings → Modules**.
3. Your role has the **Manage the customer portal** permission, and the **Support › Customer Portal** section is not hidden for your role.
Ask your admin to check **Settings → Modules** and **Settings → Roles & Permissions**.

## Q: Who can manage the Customer Portal?
A: Everything about the Customer Portal needs the **Manage the customer portal** permission. It opens **Support → Portal access**, **Support → Customer requests**, **Settings → Customer portal** and the **Portal** tab on a customer's page. Only the Management role has it by default.

## Q: How do I switch on the Customer Portal?
A: Somebody with the **Manage the customer portal** permission sets up the portal once:
1. Open **Settings → Customer portal**.
2. Tick **The customer portal is on**.
3. Under **Who may sign in**, choose **Only customers I choose** (the safe start) or **Every customer**.
4. If links should stop working after a while, fill in **Links expire after** (days). Add a **Welcome note** if you like.
5. Tick what customers may see under **What a customer can see**, and what they may ask for under **What a customer can ask for**.
6. Select **Save settings**.
Then give each customer access and send their people a link.

## Q: How do I give a customer portal access and send them a link?
A: To give a customer a portal link:
1. Open the customer's page and its **Portal** tab.
2. If you chose **Only customers I choose**, set **Access** to **Always on for this customer**.
3. Under **Who is the link for?**, choose the contact.
4. Select **Create a link**.
5. Select **Copy link** and email it to the contact yourself.
Deskzo does not email the portal link for you. A contact who has left the company cannot be given a link.

## Q: How do I invite a customer to the portal?
A: Open the customer's page, go to the **Portal** tab, and set **Access** to **Always on for this customer** if needed. Choose the contact under **Who is the link for?**, select **Create a link**, then **Copy link**, and send the link to that person by your own email. Opening the link is the customer's sign-in.

## Q: How do I send a portal link again?
A: A portal link stays the same until it expires or is revoked. Open the customer's **Portal** tab, select **Copy link** beside the link, and send it again.

## Q: How do I stop a portal link working?
A: Open the customer's **Portal** tab and select **Revoke** beside the link. The link stops working at once and cannot be brought back. Create a new link if the person needs one. To shut a whole customer out, set **Access** to **Never for this customer**. When a contact is marked as having left, or moves to another company, their links stop working too.

## Q: What do the Access options on the Portal tab mean?
A: On a customer's **Portal** tab, **Access** has three choices:
- **Follow the default**: follows **Who may sign in** in **Settings → Customer portal**. With **Only customers I choose**, this means no access.
- **Always on for this customer**: the customer may use the portal.
- **Never for this customer**: the customer is shut out, even when the setting is **Every customer**.

## Q: How do I see who has a portal link and who uses it?
A: Open **Support → Portal access**. The page shows **Customers with a working link**, **Have actually opened it** and **Who may have one**. Search with the search box, or read the table: the customer, who holds a link, access, when it was last opened and how often. If the portal is switched off, the page says "The portal is switched off."

## Q: How do I work through customer requests?
A: To handle portal requests:
1. Open **Support → Customer requests**. **Open** shows new and in-progress requests; **Everything** shows all.
2. Select **I'll take this** to mark a request in progress.
3. Do what the customer asked in the usual way, for example raise a quote or a renewal.
4. Select **Done**, add a note of what was done if you like, and select **Mark done**. Or select **Decline**, say why, and confirm **Decline**.
Your note is for your team only; tell the customer yourself. **Reopen** brings a closed request back.

## Q: What does my customer see in the portal?
A: The customer's portal page can show these sections:
- **Your subscriptions and orders**: what they bought, quantity and days left, with **Renew this** and **Add licences** when you allow those requests.
- **Your invoices**: number, date, due date, amount, what is still to pay and status. Drafts are never shown. Each invoice can be downloaded as a PDF.
- **Your support tickets**: each ticket's number, title, date and status. Never the assignee, your comments or the SLA deadline.
- **Ask us something**: a box to send you a question, when you allow it.
A section shows only when it is ticked in **Settings → Customer portal** and its module is in use in your workspace.

## Q: Can customers pay invoices from the portal?
A: Yes, when your business has connected an online payment gateway. An invoice with a balance in rupees then shows a **Pay** button. If paying online is not possible for an invoice, the customer sees "Paying online isn't available for this invoice just now. Please pay by bank transfer, or ask us."

## Q: What can a customer ask for from the portal?
A: In **Settings → Customer portal**, under **What a customer can ask for**:
- **Ask to renew**: one click against a subscription.
- **Ask for more licences**: with a number.
- **Ask a question**: a free-text message.
All three are on by default. Each one raises a request in **Support → Customer requests**, never an order or a price.

## Q: Can a customer raise a support ticket from the portal?
A: No. A customer cannot create a ticket from the Customer Portal. A question sent with **Ask us something** arrives as a request in **Support → Customer requests**. Your team can then log a ticket if needed.

## Q: What is "Ask for a code on a new device"?
A: **Ask for a code on a new device** is a setting in **Settings → Customer portal**. When it is on, the first time a link is opened in a browser, Deskzo emails a 6-digit code to the person the link was made for. The customer selects **Email me a code**, types the code and selects **Open my account**. The browser is then remembered for 30 days. A forwarded link opens nothing without the person's mailbox.

## Q: My customer says the portal link "is no longer valid". Why?
A: The portal shows "This link is no longer valid." for every refusal, on purpose. Common reasons: the portal is switched off, the link was revoked or has expired, the customer is not allowed a portal (not chosen, or set to **Never for this customer**), the customer belongs to a reseller, or the person has left the company. Check the customer's **Portal** tab and create a new link if they should have one.

## Q: Why can't I create a portal link for a customer?
A: The **Portal** tab says why. Common messages: "The customer portal is switched off. Turn it on in Settings first.", "This customer hasn't been given portal access yet." or "This customer belongs to a reseller, so the portal isn't ours to give." Resellers' end customers never get a portal. Vendors cannot have one either.

## Q: Can a customer sign in with an email and password?
A: No. The Customer Portal has no password and no sign-in form. The private link is the only way in.

## Q: Can one customer see more than another in the portal?
A: No. What a customer can see is one setting for all customers in **Settings → Customer portal**. Only who gets in is decided per customer.

## Q: Do links expire?
A: Only if you set **Links expire after** in **Settings → Customer portal** (1 to 3650 days; blank means never). A link gets its expiry when it is created, so changing the setting later does not change links already sent.

## Q: Who is told when a customer asks for something in the portal?
A: The person assigned to the customer as their caller gets an in-app notification. If nobody is assigned, nobody is notified, so check **Support → Customer requests** regularly. Each person can switch the notification off in **Settings → Notification preferences**.

## Q: Why is there no Portal tab on a company's page?
A: You need the **Manage the customer portal** permission, and the company must be a customer or a reseller. Vendors do not have a Portal tab.
