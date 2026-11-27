# Users, Roles and Permissions — Deskzo

Users and Roles & Permissions are the admin screens that decide who can sign in to Deskzo and what each person can do. They are part of every Deskzo product (Deskzo One, CRM, Books, People and the others). You find them in the sidebar under Administration → Users and Administration → Roles & Permissions.

## Q: Where do I manage users in Deskzo?
A: Go to Administration → Users in the sidebar. You can also open Settings and choose Users under Staff. The left side lists everybody who can sign in. You can search, and filter by department or role. Click a person to open their details on the right. To open the Users screen you need the **Review who can do what** permission.

## Q: How do I add a new user?
A: 1. Go to Administration → Users.
2. Click the **+** button (**Add a user**) at the top of the list.
3. Fill in **Full name** and **Email address**. Job title and Phone are optional.
4. Choose a **Role**. The role decides what the person can do.
5. Choose **Status**: "Active — gets their setup email now" or "Switched off — can't sign in yet".
6. Optionally choose a **Department**, a **Reporting manager** and **Works at** (branch).
7. Click **Create account**.
You need the **Create and edit users** permission and the **Review who can do what** permission.

## Q: How do I invite someone to my Deskzo workspace?
A: Inviting is the same as adding a user. Go to Administration → Users, click **+** (**Add a user**), fill in the name, email and role, keep Status as Active, and click **Create account**. Deskzo emails the person a link to choose their own password. You never set a password for them. The link works once, for three days. Until they use it, the user shows as **Invited**.

## Q: The new user did not get the setup email. What do I do?
A: Open Administration → Users, click the person, and open the **Login & Access** tab (or use **Edit profile**). Click **Resend setup email**. A new link replaces the old one, and the old link stops working. If Deskzo could not send the email when you created the account, it shows the setup link to you once so you can pass it on. If you see "Too many setup emails for this address. Try again in … minutes.", wait and try again.

## Q: Why can't I add another user? It says the plan includes a number of users.
A: Every active user takes one seat. When all seats are used, Deskzo shows a message like "This workspace's plan includes 10 users, and every seat is taken. Switch somebody off, or ask the workspace owner to add seats." On a free trial the message says to choose a plan in Settings → Plan & billing. To fix it: switch off someone who has left, or ask the workspace owner to buy more seats (the "More people" add-on). A user who is switched off does not use a seat. Seat prices: [PRICING: to be filled by Deskzo team].

## Q: How do I edit a user's name, role, department or manager?
A: 1. Go to Administration → Users and click the person.
2. Open the **Profile** tab and click **Edit profile**.
3. Change Job title, Work phone, Role, Department, Reporting manager or Works at.
4. Save.
You need the **Create and edit users** permission. Changing the reporting manager also needs the **Change roles and permissions** permission. You cannot change your own role.

## Q: Who can change somebody's role?
A: Only a super admin can move a person to a different role. The permission is called **Change somebody's role**. Other admins see "Only a super admin can change somebody's role." The Admin role is never offered when you add a user; a super admin makes someone an admin afterwards.

## Q: How do I deactivate a user who has left the company?
A: 1. Go to Administration → Users and click the person.
2. Open the **Login & Access** tab.
3. Click **Switch off** and confirm.
The person is signed out at once and cannot sign in until someone switches them back on. Their seat is freed. Their records stay. You need the **Create and edit users** permission. You cannot switch off your own account.

## Q: How do I reactivate a user?
A: Open Administration → Users, click the person, open **Login & Access**, and click **Switch on**. Switching someone on takes a seat again, so there must be a free seat.

## Q: How do I reset a user's password or two-factor?
A: Open Administration → Users, click the person, and open **Login & Access** or **Edit profile**. Click **Send password reset** to email them a reset link. There is also an option to reset their two-factor; they then set it up again from their profile. You need the **Create and edit users** permission. You cannot reset your own password here — change it from your own profile.

## Q: What is a reporting manager in Deskzo?
A: The reporting manager is the person a user reports to. It decides whose records count as the manager's "Team". Wherever a record scope is set to Team, the manager sees the records of people who report to them. A user cannot be their own manager, and Deskzo stops reporting loops ("That would create a reporting loop — the selected manager already reports up through this user.").

## Q: What are departments for, and how do I add one?
A: A department groups people, for example Sales or Accounts. A department carries no permissions. To manage departments, go to Settings → Departments. Type a name in "Add a new department…" and save. You can rename a department, tick **Ticket assignment** to use it as a support team, and set its dashboard layout. You can only delete a department with no members. Opening the page needs **Review who can do what**; changing departments needs **Create and edit users**.

## Q: What built-in roles does Deskzo have?
A: Deskzo comes with these roles:
- **Admin** — runs the system and holds everything by default.
- **Management** — leadership view across the business.
- **Sales** — sells to customers and owns accounts.
- **Sales manager** — sells and runs a sales team.
- **Calling** — works call lists and books meetings.
- **Profiling** — builds and cleans customer records.
- **Support** — answers tickets and looks after customers.
- **Accounts** — invoicing, payments, reconciliation and the ledger.
- **Purchase** — buys from vendors and checks their bills.
- **HR**, **HR head** and **Recruiter** — people records, hiring and payroll.
- **Renewal specialist** — keeps subscriptions renewed.
Built-in roles cannot be deleted, but you can rename them and change what they grant.

## Q: What is a super admin?
A: The super admin is the workspace owner's account. A super admin holds every permission and sees every field, whatever their role says. A super admin cannot be locked out or viewed-as by an ordinary admin. Some permissions can only be given by a super admin, for example **Change somebody's role**, **View the app as another user** and **Change the security and DLP policy**.

## Q: How do I create a custom role?
A: 1. Go to Administration → Roles & Permissions.
2. Click **Create custom role** (or **Create role** at the top).
3. Enter a **Role name** and a description, and click **Create role**.
4. A new role holds only the menu sections. Open the **Module Access** tab and tick the permissions it needs.
You can also open an existing role and click **Duplicate** to start a new role with everything that role has. You need the **Change roles and permissions** permission.

## Q: How do I give a role a permission?
A: 1. Go to Administration → Roles & Permissions and click the role.
2. Open the **Module Access** tab and choose a module on the left.
3. In the Actions table, tick **Allow** for the action you want, and choose a **Record scope** if shown.
Changes save as you make them. You cannot give a permission you do not hold yourself ("You don't hold this yourself, so you can't change it for a role."). Only a super admin can change what admins can do.

## Q: How do I hide a whole menu section from a role?
A: Go to Administration → Roles & Permissions, click the role, open **Module Access**, choose the module, and switch off "<module> enabled for this role". These are the section permissions, such as "Sales → Leads" or "Reports". Every role has them until you switch one off. The section disappears from that role's menu and its pages stop opening.

## Q: What does the Record Access tab do?
A: Record Access decides which records people in a role can reach for each action (view, edit, delete, assign). The levels are **None**, **Own**, **Team**, **Branch**, **All** and **As the account**. Edit, delete and assign cannot reach wider than view. Make your choices and click **Save changes**. The rule is enforced on the server, not just hidden in the menu.

## Q: Can I give one person an extra permission without changing their role?
A: Yes. Go to Administration → Users, click the person and open **Permissions**, **Record Access** or **Field Permissions**. Make the change, then click **Save changes** at the top. You can add a reason and an **Until** date to make it temporary. The person's header shows how many exceptions they have. **Reset to role defaults** removes all their exceptions. You cannot change your own access.

## Q: How do I see what a user can actually do?
A: Open Administration → Users, click the person, and look at the **Permissions** tab. It shows what their role gives, their own exceptions, and what applies in the end. The **Role** tab shows each module as Full access, Limited access or No access. For a side-by-side view of all roles, click **Permission matrix** on Roles & Permissions.

## Q: How do I view Deskzo as another user?
A: Click **View as user** on the person's page in Administration → Users, or use the "View the app as another user" icon at the top of the screen and search for the person. You then see exactly what they see. Click **Back to <your name>** to return. You need the **View the app as another user** permission, given only by a super admin. Every action is logged under your own name.

## Q: Why can't I view the app as a particular user?
A: Deskzo blocks view-as in these cases: the person is a super admin and you are not ("Only a super admin can view the app as another super admin."), the person holds permissions you don't ("… holds permissions you don't, so you can't view the app as them. A super admin can."), or their account is deactivated.

## Q: How do I delete a role?
A: Open the role in Administration → Roles & Permissions and click **Delete**. You can only delete a custom role with nobody in it. If people hold it, move them to another role first. A role that approves documents must be removed from those approval policies first. Built-in roles cannot be deleted.

## Q: I can't see Users or Roles & Permissions in my menu.
A: These links need the **Review who can do what** permission. Changing anything also needs **Change roles and permissions**; without it you see "You can review access but not change it." Ask your workspace admin. Any user can see their own access under Settings → What I can do.
