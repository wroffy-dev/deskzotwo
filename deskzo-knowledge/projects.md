# Projects — Deskzo

Projects in Deskzo track work you deliver for one customer, such as a website build, a migration or an implementation. Each project has milestones, billing stages, a team, risks and updates, documents and stored credentials. Projects is part of Deskzo Projects and Deskzo One.

## Q: What is the Projects module in Deskzo for?
A: The Projects module tracks a piece of work you deliver for one customer. Each project has a code like PRJ-2026-0001, a status, a health, a project manager, a start date, a "Promised by" date and a contract value. A project has these tabs:
- **Plan & billing**: milestones (which give the project its progress) and billing stages (each can raise its invoice).
- **People**: your team on the project and the customer's people.
- **Risks & updates**: what might go wrong, and posted updates.
- **Documents**: the agreement, NDA, scope of work, sign-offs and more.
- **Credentials**: passwords and keys for the customer's systems, encrypted.

## Q: How do I create a new project?
A: To create a project in Deskzo:
1. Go to **Projects → Projects** and select **New project**. You can also start it from the customer's **Projects** tab.
2. Choose the **Customer**. You cannot change the customer later.
3. Choose the **Kind of work** if it is one of your project types. Type a **Name** and **What it covers**.
4. Set the **Status**, **Health** and **Project manager**.
5. Set the dates: **Starts**, **Promised by**, and later **Actually finished**.
6. Fill in the **Contract value**.
7. Leave **Start from this project type's standard plan** ticked to get its milestones automatically.
8. Select **Create project**.
You and the project manager are added to the project team automatically. You need the **Run projects** permission.

## Q: How do I start a project for a customer?
A: Go to **Projects → Projects** and select **New project**, or open the customer and use their **Projects** tab. Choose the **Customer**, give the project a **Name**, set the **Project manager**, dates and **Contract value**, and select **Create project**. You need the **Run projects** permission to create a project.

## Q: Who can see a project in Deskzo?
A: A project is visible only to the people on it, not to everyone. You see a project when you are on its team, are its project manager, or created it. People with the **See every project** permission see all projects. The customer's people listed on a project are contacts only. They do not get a login or any access. To let a colleague see a project, add them on the project's **People** tab.

## Q: Why is my project list empty?
A: Your project list in Deskzo shows only projects you are on. You have not been added to any project yet. Projects show only to the team, the project manager and the person who created the project. Ask a project manager to add you on the project's **People** tab.

## Q: A colleague cannot see a project. What do I do?
A: Add the colleague to the project team:
1. Open the project and go to the **People** tab.
2. Under **Our team**, choose the colleague under **Add a colleague**.
3. Pick their role on the project and add them.
The colleague can see the project from then on and gets a notification. You need the **Run projects** permission and must be able to see the project yourself.

## Q: Why can't I change anything on a project?
A: Changing a project needs the **Run projects** permission. Without it, being on a project lets you read the project and download its documents only. The **Run projects** permission also works only on projects you can see. Ask your admin to check your role in **Settings → Roles & Permissions**.

## Q: Which permissions control Projects?
A: These permissions are in **Settings → Roles & Permissions**:
- **View projects**: opens the Projects module and a customer's Projects tab. Profiling, Calling, Sales, Support, Management, Accounts and Purchase roles have it by default.
- **Run projects**: create and edit projects, milestones, billing stages, team, risks, updates and documents. Management and Support have it by default.
- **See every project**: see all projects, not only your own. Management has it by default.
- **Open stored credentials**: shows the Credentials tab and lets a person reveal a stored password. Nobody has it by default.
- The **Operations › Projects** section tick shows Projects in the menu. Every role has it until an admin unticks it.

## Q: How do I add milestones to a project?
A: To add project milestones in Deskzo:
1. Open the project's **Plan & billing** tab.
2. Under **Milestones**, type a name under **Add a milestone**.
3. Pick its due date and add it.
4. Tick a milestone when it is done. Deskzo keeps who ticked it and when.
**Progress** is the number of milestones done out of all milestones. A due date turns red when it has passed and the milestone is not done. If the project has a project type with a standard plan and no milestones yet, select **Use this project type's standard plan**.

## Q: How do I bill a project in stages?
A: To set up billing stages on a project:
1. Open the project's **Plan & billing** tab.
2. Under **Billing stages**, type a name under **Add a stage**, for example "Advance" or "Payment on sign-off", and its amount.
3. Choose whether it is **Not yet due**, **Due** or **Waived**. If it is earned when a milestone is done, choose that milestone. Add it.
4. When it is time to bill, select **Raise invoice**. A draft invoice opens in Sales Documents.
5. Check the draft, including the tax, and issue it in the usual way.
Raising the invoice also needs the **Raise and issue sales documents** permission. The stage then shows **Invoiced**, and **Paid** once the invoice is paid. If the invoice is cancelled or the draft deleted, the stage goes back to **Due**.

## Q: How do I raise an invoice from a project?
A: Open the project's **Plan & billing** tab. Find the billing stage under **Billing stages** and select **Raise invoice**. A draft invoice opens in Sales Documents. Check it, including tax, and issue it. You need the **Run projects** and **Raise and issue sales documents** permissions. The billing stage then shows **Invoiced**, and later **Paid**.

## Q: Why can't I delete a milestone or a billing stage?
A: A milestone cannot be deleted when a billing stage's revenue is waiting for that milestone. A billing stage cannot be deleted when revenue has already been scheduled on it. In both cases the item stays on the project.

## Q: How do I add customer contacts to a project?
A: Open the project's **People** tab. Under **At the customer**, choose one of the customer's contacts under **Add a customer contact**, pick their role, and add them. Customer contacts on a project are for reference only. They do not get a login or any access to Deskzo.

## Q: Can I remove the project manager from the project team?
A: No. The project manager cannot be removed from the team while they are the project manager. First change the project manager on the project (select **Edit**), then remove the person. Removing a colleague takes away their access to the project, except for the project manager and the person who created it.

## Q: How do I raise a risk or post an update on a project?
A: To raise a risk:
1. Open the project's **Risks & updates** tab and select **Raise a risk or issue**.
2. Say what might go wrong. Choose the **Kind**, the **Severity** and the **Owner**. Write what is being done about it.
3. Select **Raise it**.
To post an update, write where things stand under **Updates**, choose the **Health**, and select **Post**. Posting an update also sets the project's health. An open risk with nothing written about what is being done is flagged.

## Q: What do project status and health mean?
A: The project status shows where the work is: Proposed, Discovery, Planning, In progress, Customer testing, Go live, Handover, Completed, On hold or Cancelled. You can choose any status at any time. Colleagues on the project are told when the status changes. The project health is **On track**, **At risk** or **Off track**. Health is set by hand, either under **Edit** or by posting an update. Deskzo does not work out health for you.

## Q: How do I upload a document to a project?
A: To add a project document:
1. Open the project's **Documents** tab.
2. Under **Add a document**, choose its type (Agreement, NDA, Scope of work and so on) and, if you like, a name.
3. Select **Choose file**. The file uploads as soon as you pick it.
Files can be a PDF, Word file or image, up to 4 MB. Everybody on the project can download documents. Adding and deleting documents needs the **Run projects** permission.

## Q: How do I store a password for a customer's system in a project?
A: To store a credential on a project:
1. Open the project's **Credentials** tab and select **Store one**.
2. Fill in **What it opens**, **Username**, **Where**, **Password or key**, and **Expires** if it has an expiry.
3. Select **Save**.
You need the **Open stored credentials** permission and the **Run projects** permission. Credentials are encrypted. For the company's own logins, such as the bank or domain registrar, use the Credential Vault instead.

## Q: How do I see a stored password on a project?
A: Open the project's **Credentials** tab and select **Reveal** on the credential. Type **Your password** (the password you sign in to Deskzo with) and select **Reveal**. Select **Done** when you have finished. Every reveal asks for your password again, is recorded, and the project manager is told. You need the **Open stored credentials** permission.

## Q: Where is the Credentials tab on a project?
A: The Credentials tab shows only to people with the **Open stored credentials** permission. Nobody has this permission by default, not even Management. An admin can grant it in **Settings → Roles & Permissions**, or for one person in **Settings → Users**.

## Q: It says "That password isn't right" when I reveal a project credential.
A: Deskzo wants your own sign-in password, not the stored password. Type the password you use to sign in to Deskzo. If it says "This account has no password set.", your account has no sign-in password (for example, you sign in another way). Ask your admin about setting a password for you.

## Q: How do I set up project types with a standard plan?
A: An admin can save kinds of work with a standard list of milestones:
1. Open **Settings → Lists** and find **Project types**.
2. Type a name under **Add a kind of project**, such as "Mail migration", and add it.
3. Select **Standard plan**, then **Add a step** for each milestone, with how many **days in** from the project start it is due.
4. Select **Save plan**. Untick **Offered** to stop offering a kind for new projects.
Opening Settings → Lists needs the permission to change organisation settings, and saving project types also needs **Run projects**. Changing a plan does not change existing projects.

## Q: Who gets notified about projects?
A: In Deskzo you are notified when somebody adds you to a project. Colleagues on a project are notified when its status changes. The project manager is notified whenever somebody else reveals a stored credential; this cannot be switched off. Other project notifications can be switched off in **Settings → Notification preferences**.

## Q: I can't see Projects in my menu.
A: Projects shows in the menu only when all of these are true:
1. Your company's plan includes Projects (Deskzo Projects or Deskzo One).
2. The Projects module is switched on in **Settings → Modules**.
3. Your role has the **View projects** permission and the **Operations › Projects** section is ticked in **Settings → Roles & Permissions**.
Ask your admin to check these.
