# Sales Forecast — Deskzo

Forecasting shows what is coming, period by period: open deals weighted by how often each stage really wins, renewals by how each brand really renews, and cash by how each customer really pays, beside targets, last year and each salesperson's commit. Forecasting is part of Deskzo Analytics and Deskzo One, and appears in the sidebar as Sales → Forecast. It needs Leads in your workspace.

## Q: What does the Forecast show?
A: The Deskzo forecast answers "what will we book, renew and collect, and when?" from the records you already keep: open leads, subscriptions, invoices and customers' machines. It has five tabs that share the same periods and salesperson filter: **Sales**, **Renewals**, **Collections**, **Warranty → AMC** and **Commits**. Figures are before GST, except Collections, which is cash and includes GST.

## Q: How do I open the sales forecast?
A: Go to Sales → Forecast. The **Sales** tab opens first. Choose the period type (Month, Quarter or Financial year) and how many periods in **How far ahead**.

## Q: Who can see the Forecast?
A: Everybody can open the Deskzo forecast. It adds up the accounts you can see: a salesperson sees their own accounts, a manager also sees their team's, and someone with the **See every account, not just your own** permission sees the whole company. If you can see more than one person's accounts, you can pick one salesperson, or **Everybody I can see**.

## Q: I can't see Forecast in my menu. Why?
A: Check these with your admin:
1. Forecasting must be in your company's plan (Deskzo Analytics or Deskzo One), and Leads must also be in the plan.
2. The Forecasting module must be switched on in Settings → Modules.
3. The **Sales › Forecasting** section must be ticked for your role in Settings → Roles & Permissions.

## Q: How do I read the Sales tab?
A: For each period, the Sales tab shows the deals closing in it and:
- **Pipeline**: the full value of those deals.
- **Best case**: deals at Proposal sent or Negotiation.
- **In negotiation**: deals at Negotiation.
- **Weighted**: each deal's value times its stage's weight.
Compare with **Booked so far**, **Target**, **Salespeople commit** and **Last year**. Click a period to list its deals, biggest weighted value first.

## Q: How is a deal weighted in the forecast?
A: A deal counts at the share of deals at its stage that went on to be won over the last twelve months. Deskzo learns this from your own history. If a stage has fewer than ten closed deals behind it, a standard figure is used. A later stage never counts for less than an earlier one. The weights are learned from the whole company, whoever is looking.

## Q: A deal I'm working on isn't in any month. Why?
A: The deal (lead) has no expected close date, so it is under **No close date**. Or its date has passed, so it is under **Slipped — close date passed**. Give it an expected close date on the lead. A lead in a pipeline that does not count as sales is not forecast at all.

## Q: Why does a deal count for nothing in the forecast?
A: The deal has no value: no estimate on the lead and no live proposal. Add an estimated value on the lead, or raise a proposal. A deal's value is its latest live proposal, or its estimate when there is no proposal.

## Q: Why does a stage say "standard" rather than "learned"?
A: Fewer than ten closed deals have been at that stage in the last year, which is too few to learn from. Deskzo uses a standard figure until there are more. Someone with the **Set forecast weights** permission can override it.

## Q: How do I override a stage's weight?
A: You need the **Set forecast weights** permission (Management by default).
1. On the **Sales** tab, scroll to **How deals are weighted**.
2. Type a percentage (0 to 100) under **Override** for the stage and click **Set**.
3. To go back to the learned figure, click **Clear**.
An override applies for everybody until cleared. Without the permission you see "You can't change how deals are weighted."

## Q: Why are the forecast stage names different from our pipeline's?
A: The forecast weighs each lead by what its stage counts as: New, Contacted, Qualifying, Qualified, Proposal sent and Negotiation. Your own stage names map onto these. An admin sets which meaning each stage has in Settings → Pipeline.

## Q: How do I enter my sales commit?
A: In Deskzo:
1. Go to Sales → Forecast and click the **Commits** tab.
2. For each of the next three months, enter your **Commit** (what you will close) and, if you like, a **Best case** and a note.
3. Click **Commit** (or **Update** to change it).
Beside each month you see what your own deals say. If you can see others' accounts, **Your team** shows each person's commit. Best case cannot be less than the commit.

## Q: I can't change last month's commit.
A: That is on purpose. A month that has ended keeps the commit made for it ("That month is over — its commit stays as it was made."), so the forecast can be compared with what people actually called.

## Q: How do I forecast renewals?
A: Click the **Renewals** tab. For each period you see subscriptions falling due, how many renewed or were lost, how many are still open, and the expected value. Open ones count at their brand's renewal rate. **Renewal rates used** shows the rates. Click a period to see each subscription.

## Q: How do I see when cash will come in?
A: Click the **Collections** tab. Compare **Due, as invoiced** with **Expected in** for each period. Expected in pushes each bill back by how late that customer usually pays. Bills already past due are listed under **Already overdue**.

## Q: What is the Warranty → AMC tab?
A: The **Warranty → AMC** tab counts customers' machines whose warranty ends in each period with no AMC (annual maintenance contract) to follow, plus those that ended in the last 90 days. Click a period to see them by customer, so you can offer an AMC.

## Q: What periods can I choose in the forecast?
A: Month (3, 6 or 12 ahead), Quarter (2, 4 or 8 ahead) or Financial year (1, 2 or 3 ahead). Quarters follow the Indian financial year: Q1 is April to June. The choice applies to every tab except Commits, which is always the next three months.

## Q: How do I set up the forecast so it is accurate?
A: Give each lead an **Expected close date** and a value (an estimate, or better, a proposal). In Settings → Pipeline, mark which pipelines **Count as sales**; only those are forecast. For the **Target** column, set order value targets in Targets.
