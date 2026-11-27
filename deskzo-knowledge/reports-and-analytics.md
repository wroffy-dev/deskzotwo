# Reports and Analytics — Deskzo

Reports in Deskzo lets you build, save and share live reports of charts over your invoices, payments, expense claims, stock, orders, leads, tickets and field visits. It also has an Explorer for quick one-off questions. Reports is part of Deskzo Analytics and Deskzo One.

## Q: What can I do in Reports?
A: In Deskzo Reports you can:
- See headline figures, your favourite reports and recent reports on **Reports → Overview**.
- Build your own report of charts and save it in **Reports → My reports**.
- Open reports colleagues shared with you in **Reports → Shared with me**.
- Start from a ready layout in **Reports → Report templates**.
- Ask a quick one-off question in **Reports → Explorer**.
A report never shows more than you could see elsewhere in Deskzo.

## Q: What data can a report use?
A: Each report reads one data source:
- **Invoices**: invoiced (net of credit notes), tax, amount received, outstanding.
- **Payments received**: amount collected, number of receipts.
- **Expense claims**: amount claimed, tax on claims, number of claims.
- **Stock on hand**: quantity, stock value at cost.
- **Sales orders**: order value, margin, quantity.
- **Leads and deals**: number of leads, estimated value, won, lost.
- **Tickets**: raised, resolved, still open, average days to resolve.
- **Field visits**: visits, completed, distance (km).
Every source except Stock on hand can also be charted over time by day, week, month, quarter or year. Your workspace's custom fields also appear.

## Q: How do I create a report?
A: To create a report in Deskzo:
1. Go to **Reports → Overview** and select **Create report**.
2. Choose a **Data source**. The panel shows how many rows you can see and its fields.
3. Choose a **Starting point**: a blank report or a template for that source.
4. Under **Details**, name it, pick its date range and choose who can see it: only you, or your department to view or to edit.
5. Select **Create report**. The builder opens.

## Q: How do I make a new custom report?
A: Go to **Reports → Overview** and select **Create report**. Pick a **Data source**, a **Starting point** (blank or a template), give it a name and date range under **Details**, and select **Create report**. Then add charts in the builder and select **Save**.

## Q: How do I use a report template?
A: Go to **Reports → Report templates**, pick a template and select **Use template**. A template is a starting layout. The report you make from it is yours to change.

## Q: How do I add charts to a report?
A: In the report builder:
1. Select **Add chart** and pick a kind: Score, Column, Bar, Line, Area, Combo, Pie, Donut, Table or Pivot. Or click a field on the left.
2. Select the chart and set it up on the right under **Setup**: its dimension, its metrics, how each is totalled (Sum, Average, Min, Max or Count), the sort and how many to show. A Score can compare with last year or the period before.
3. Under **Style**, give it a title and width, and turn the legend and values on or off.
4. Use page tabs to split the report into pages. Use **Undo** and **Redo** (Ctrl+Z, Ctrl+Shift+Z) to step back and forth.
5. Select **Save** (Ctrl+S).

## Q: How do I filter a report?
A: To filter a report:
1. Select **Add filter** and choose a field.
2. For a breakdown field, pick values to include or exclude, or set a text condition such as "contains".
3. For a figure, set a condition such as greater than, less than or between.
4. Choose **Whole report** or **This chart only**.
A chart with its own filters shows how many it has.

## Q: How do I add a calculated field to a report?
A: In the builder, select **New calculated field**. Name it and write the calculation using the source's figures, numbers, + − × ÷ and brackets. For example, collection rate is amount received divided by invoiced. Choose to show it as rupees, a number or a percentage. Then add it to a chart like any other figure. A calculated field is worked out on each group's totals.

## Q: How do I share a report with a colleague?
A: Open the report and select **Share**. Add people or departments, and choose for each whether they can view or edit. You can also copy the report's link. Only the person who made a report can share it or delete it. Sharing gives the report, not the data: each person sees only the rows their own role allows.

## Q: Why are my totals different from a colleague's on the same report?
A: Each person sees only the records they are allowed to see in Deskzo. So the same report can show different totals to different people. Under the report's date range, it says whose records were counted.

## Q: A report shared with me says No access.
A: The report reads a data source your role cannot open. Select **Request access** and the report's owner is told. Access itself is given by an admin in your role or permissions, not by the report.

## Q: A data source is locked when I create a report.
A: A source is locked when its module is switched off for you, or your role cannot see those records. The card says what it needs, for example "Needs inventory access" or "Needs lead access". Stock on hand needs an inventory permission such as **See stock**. Invoices needs **View quotes & invoices**. Leads and deals needs **View leads**. Ask your admin.

## Q: How do I download a chart as a CSV file?
A: In the report viewer or builder, select **Export** and pick the chart, or use the chart's own menu. The CSV has the figures the chart shows, with the report name, period, whose records were counted and any filters at the top. Every download is recorded in the activity log.

## Q: It says "You can read this report but not download it."
A: Downloading needs an export permission. Orders, leads, tickets and visits need **Export customer data**. Invoices, payments, expense claims and stock need **Export financial data**. No role has these by default. Ask your admin to grant one in **Settings → Roles & Permissions**.

## Q: How do I use the Explorer?
A: To answer a quick question in Deskzo:
1. Go to **Reports → Explorer**.
2. Choose what to **Report on**, the **Measure** and what to **Break down by**. Optionally add a second breakdown in **Across (optional)**.
3. Choose the date it is **Dated on** and the period.
4. Select **Run report**.
5. Select **CSV** to download every row, or **Generate report** to open a printable sheet and select **Print or save as PDF**.

## Q: How do I change the date range when reading a report?
A: Open the report from **Reports → Overview**, **My reports** or **Shared with me**. Change the date range or add a filter of your own. Nothing you change while reading is saved to the report. Click a bar, slice or row to narrow every chart on the page to it; select the chip's cross, or **Reset**, to undo it.

## Q: How do I add a report to my favourites?
A: Open the report and select the star. Favourite reports appear on **Reports → Overview** under **Favourites**.

## Q: It says somebody saved this report after I opened it.
A: The message "Somebody saved this report after you opened it. Reload to see their changes — yours are still here until you do." means a colleague saved first. Deskzo refuses your save so it does not overwrite their work. Your changes stay on screen until you reload.

## Q: A chart says "This chart isn't set up yet".
A: The chart needs something before it can draw: a metric, a dimension to break it down by, or two metrics for a Combo chart. Select the chart and the **Setup** panel shows what is missing.

## Q: Can I change a report's data source?
A: No. A report keeps the data source it was made with. Duplicate the report to start one over another source.

## Q: Why do the parts add up to more than the total?
A: The breakdown lets one record fall in several groups, for example a customer with two tags. That record is counted in each group. The chart says so underneath.

## Q: How do I report by my own field, like region?
A: An admin adds it as a custom field in **Settings → Custom fields**. It then appears in Reports as a breakdown and filter. Number or money fields appear as figures. Restricted custom fields are offered only to people with the **See restricted custom fields** permission.

## Q: I can't see Reports in my menu.
A: Reports shows in the menu only when all of these are true:
1. Your company's plan includes Reports (Deskzo Analytics or Deskzo One).
2. The Reports module is switched on in **Settings → Modules**. Reports also needs the Workspace module to be on.
3. The **Reports** section is ticked for your role in **Settings → Roles & Permissions**.
Ask your admin to check these.
