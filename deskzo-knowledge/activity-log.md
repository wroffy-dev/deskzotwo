# Activity Log and Work Activity — Deskzo

The Activity log and Work activity pages show what has happened in a Deskzo workspace and who did it. The Activity log is the security log (sign-ins, exports, refused permissions, data-loss-prevention events). Work activity shows everything one person did with records. Both are in every Deskzo product, under Reports → Activity log and Reports → Work activity.

## Q: What is the Activity log in Deskzo?
A: The Activity log is the security log. It records sign-ins and sign-outs, password and two-factor changes, new devices and networks, records viewed, searches, exports, prints, refused permissions, blocked crawlers, blocked copy or screenshot attempts, and changes to the security policy. Open it from Reports → Activity log. In Settings it is listed as **Audit logs** under Staff.

## Q: Who can see the Activity log?
A: Everybody can open the Activity log and see their own activity. To see everyone's activity you need the **See everyone's activity log** permission. By default only the Management role has it. Without it, the page says "You are seeing your own activity."

## Q: Why should I look at my own Activity log?
A: Your Activity log shows everything your account has done. Check it if you ever get a sign-in alert or see a sign-in you don't recognise. If you see one, change your password and tell your admin.

## Q: How do I filter the Activity log?
A: On Reports → Activity log, use:
- **Search** — search the summary, user, page or address.
- **Event** — one kind of event, such as Signed in or Exported data.
- **Who** — one person (only if you can see everyone's activity).
- **More filters** — **Area** (Sessions, Where and on what, Data access, Data loss prevention, Perimeter, Administration), **At least** (severity), **View-as**, and **Date**.
Click a row to expand it and see the details.

## Q: What do the severity levels mean in the Activity log?
A: Each event has a severity: **Info**, **Notice**, **Warning** or **Critical**. The top of the page counts events at each level. Warnings include failed actions like a blocked device, impossible travel or rate limiting. Use the "At least" filter to see only the more serious events.

## Q: How do I export the Activity log?
A: Filter the Activity log to the rows you want, then click **Export these rows**. Deskzo downloads a CSV file. You need the **Export the activity log** permission. Without it you see "You can't export the activity log." The export itself is recorded.

## Q: How can I see what an admin did while viewing the app as another user?
A: In Reports → Activity log, open More filters and set **View-as** to "Only while viewing as someone". Each such row shows who was "Really at the keyboard". Starting and stopping view-as are also logged as "Started viewing as" and "Stopped viewing as".

## Q: What is Work activity?
A: Work activity shows everything one person did, newest first: records added and changed, calls, notes, emails and sign-ins. Open it from Reports → Work activity. There is also a **Work activity** link at the top of the Activity log.

## Q: Whose work activity can I see?
A: You always see your own. A manager sees the work activity of the people who report to them. People with the **See everyone's activity log** permission see everyone's. Use the **Whose** picker to choose a person. If you try to open someone outside your reach, Deskzo shows a "not found" page.

## Q: How do I see what a team member did today?
A: 1. Go to Reports → Work activity.
2. In **Whose**, choose the team member.
3. Read the feed, newest first.
You can see them if they report to you, or if you have the **See everyone's activity log** permission.

## Q: Why don't I see some items in someone's Work activity?
A: Work activity only shows records you are allowed to see. For example, lead activity shows only if you can see leads, and changes to settings, roles or the vault show only for the person themselves and for people who can see everyone's activity. Masked lead fields stay masked.

## Q: What is the difference between the Activity log and Work activity?
A: The Activity log is about security: sign-ins, exports, refused permissions and blocked actions. Work activity is about the work itself: which records a person created and changed, and their calls, notes and emails. Use the Activity log for an investigation and Work activity to follow a person's day.

## Q: Is every page view logged in the Activity log?
A: Not by default. Viewing records, exports and refused actions are always logged. Logging every page view is an option an admin can switch on in Administration → Security & DLP ("Log every page view").

## Q: How long does Deskzo keep the Activity log?
A: An admin sets this in Administration → Security & DLP, in "Keep activity logs for (days)". The minimum is 30 days. Deskzo separately keeps a sealed copy of sign-ins and activity for a year outside the app.

## Q: Where do I see the history of permission changes?
A: Permission changes are shown on the person's page in Administration → Users (a history of changes to their access) and on the role's Summary tab in Administration → Roles & Permissions ("This role's history"). Changes to the security policy itself appear in the Activity log under Administration.

## Q: I can't see the Activity log in my menu.
A: The Activity log and Work activity need no special permission: every user can open them and see their own activity. Both links are in the Reports section of the sidebar. If you still cannot find them, ask your workspace admin to check your role in Administration → Roles & Permissions.
