# Forms & Events — Deskzo

Forms & Events lets you build forms inside Deskzo: event invitations with RSVPs and attendance, requirement assessments, enquiry forms and surveys. Answers come back to the customer's record. Forms & Events is part of Deskzo Campaigns, Deskzo CRM, Deskzo Pipeline and Deskzo One.

## Q: What is Forms & Events in Deskzo?
A: Forms & Events is where you build forms and share them with customers. You can share a public link, send personal invitations, or both. Answers are saved to the customer's record. If the person is new, Deskzo creates the company and contact, and can create a lead. You find it at Marketing → Forms & events.

## Q: What kinds of form can I build?
A: There are five kinds. Each starts with useful questions that you can change:
- **Event or roundtable**: invitations, RSVPs and who came, with a date, a venue and an optional seat limit.
- **Requirement assessment**: what a customer uses today and what they need next.
- **Enquiry**: a public get-in-touch form. Every answer becomes a lead.
- **Survey**: ask customers something and count the answers.
- **Something else**: a blank form with just a name and an email.

## Q: I can't see Forms & events in my menu. Why?
A: Ask your admin to check three things:
1. Your company's plan must include Forms & Events (Deskzo Campaigns, Deskzo CRM, Deskzo Pipeline or Deskzo One).
2. The Forms & Events module must be switched on in Settings → Modules.
3. Your role must have the **Marketing › Forms & Events** section ticked in Settings → Roles & Permissions.

## Q: Why is there no New form button?
A: Your role does not have the **Build forms** permission. You can still see the forms other people shared with you. Ask your admin to add **Build forms** to your role in Settings → Roles & Permissions.

## Q: Which permissions does Forms & Events use?
A: Forms & Events uses these permissions:
- **Build forms**: build new forms (and own them), and duplicate a form you can see. Management and Sales have it by default.
- **Manage every form**: see, change, share and read the answers of every form, whoever built it. Management has it by default.
On each form, the owner can also give people **Edit**, **Invite** and **See answers**.

## Q: How do I create a form?
A: You need the **Build forms** permission.
1. Go to Marketing → Forms & events and click **New form**.
2. Under **What are you making?**, pick a kind. Starter questions are filled in.
3. Under **What it is**, enter a **Name** and check the **Web address**.
4. Under **The page**, write the **Headline**, **Introduction** and what people see **After they send it**.
5. For an event, fill in **Starts**, **Finishes (optional)**, **Where** and **Seats (optional)**.
6. Choose **Who can fill it in** and **What happens to the answers**.
7. Change the **Questions**. Use **Add** for more. Name and email are always asked.
8. Click **Preview** to check it, then **Create form**.

## Q: How do I create an event invitation with RSVP?
A: Build a form of the kind **Event or roundtable**:
1. Go to Marketing → Forms & events and click **New form**.
2. Pick **Event or roundtable**.
3. Fill in the event details: **Starts**, **Finishes (optional)**, **Where** and **Seats (optional)**.
4. Check the questions and click **Create form**.
5. Open the form, go to the **Invitations** tab and click **Invite people**, or share the public link.

## Q: How do I share a form's public link?
A: Open the form. The public address is shown under its name. Click **Copy link** and paste it on your website, in a post or a chat group. Click **Open** to see it as a visitor does. The link works while the form is open, unless the form is set to **Invited people only**.

## Q: Who can fill in a form?
A: Each form has the setting **Who can fill it in**:
- **Anyone with the link**: share it anywhere.
- **Invited people only**: only personal invitation links work. The public link says the form is not available.
- **Both**: personal invitations and a public link.

## Q: How do I invite customers to a form or event?
A: You need the **Invite** right on the form (the owner has it).
1. Open the form, go to the **Invitations** tab and click **Invite people**.
2. Under **Find people**, search by name, email or company. Select each person. Only contacts with an email, on accounts you can see, are offered.
3. Check the **Subject** and **Message**. Keep {{formLink}} in the message. It becomes each person's own link.
4. Click **Check**. People who cannot get the email are listed with the reason.
5. Click **Send to** for the people who can get it.
Invitations are sent from you and appear in the Mail log.

## Q: How do I remind people who haven't answered my form?
A: Open the form and go to the **Invitations** tab. Click **Remind … who haven't answered**. You can also click **Copy link** on one invitation to send it another way, or **Withdraw** to cancel it.

## Q: Why wasn't someone sent the form invitation?
A: After you click **Check**, Deskzo lists each person who cannot get the invitation, with the reason. For example: they asked not to get marketing, they opted out of the form's topic, the address is suppressed, or they were sent one a few minutes ago. Nothing is sent to them.

## Q: How do I record RSVPs and attendance for an event?
A: 
1. Watch the **Overview**: Invited, Replied, Coming, Can't make it, Came and No-show.
2. If someone answers you by phone or in person, go to the **Invitations** tab and click **Coming** or **Can't come** for them.
3. On the day, go to the **Answers** tab. Under **On the day**, mark each person **Came** or **No-show**.

## Q: My event says it is full. What do I do?
A: When all seats are taken, new "I'll be there" answers are refused. "Can't make it" is always accepted. The message is "The event is full. Raise the seat limit first if there is room." Edit the form and raise **Seats (optional)** if you have more room. An event also stops taking RSVPs once it starts.

## Q: How do I see and export form answers?
A: You need **See answers** on the form.
1. Open the form and go to the **Answers** tab.
2. Search by name, email or company. For an event, filter by RSVP or On the day.
3. Expand a row to see every answer and where it came from.
4. Click **Export all to CSV** for a spreadsheet.
Answers also show in the **Forms** tab of the customer's page.

## Q: How do I share a form with colleagues?
A: You must be the form's owner, or have the **Manage every form** permission.
1. Open the form and go to the **Sharing** tab.
2. Add a person, or click **Add everybody with a role**.
3. Tick **Edit**, **Invite** or **See answers** for each.
4. Click **Save sharing**.

## Q: A colleague can see the form but not its answers. Why?
A: Seeing a form and reading its answers are separate rights. The form owner, or someone with **Manage every form**, can tick **See answers** for that colleague on the form's **Sharing** tab.

## Q: Does a form create leads?
A: It can. The form setting **Make a lead from each new answer** creates a lead from each new answer, with the answers in its description. It is on by default for requirement assessments and enquiries. A lead is never made when someone declines an event. The setting only shows if your workspace has leads.

## Q: Who gets the leads from a form?
A: An answer from an invited customer goes to the person who invited them. Other answers go to the person in **Tell and route to**. If that is empty, Deskzo uses your lead rules in Settings → Lead assignment.

## Q: How do I close, reopen or duplicate a form?
A: Open the form:
- **Close** stops it taking answers. **Reopen** starts again.
- **Duplicate** copies it as a new form of your own. The copy is closed until you reopen it.
You can also set **Stop taking answers at (optional)** so the form closes by itself.

## Q: Why can't I delete a form?
A: Only the owner can delete a form, and only while nobody has answered and no invitation has gone out. Otherwise you see "People have answered this form, so it can't be deleted. Close it instead." or "Invitations have gone out for this form, so it can't be deleted. Close it instead." Close the form instead. The answers are kept.

## Q: What happens if I change a form's web address?
A: The public link changes, so old copies of the public link stop working. Personal invitation links keep working. If another form uses the address, you see "Another form already uses that web address."

## Q: Someone answered a form twice. What happens?
A: For an event on the public link, an email already registered is left as it was. This stops people cancelling or double-booking someone else's place. Answering again from a personal invitation updates that person's one answer.
