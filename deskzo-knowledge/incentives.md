# Incentives — Deskzo

Incentives in Deskzo turn a person's target into money. You write incentive schemes with thresholds, bands and caps, attach them to targets, work out what each person earned when the period ends, have somebody else approve it, and pay it with salary. Incentives is part of Deskzo CRM and Deskzo One, and needs the Targets module.

## Q: What are Incentives in Deskzo?
A: Incentives decide what hitting a target is worth. You write a scheme (a percentage, a flat amount, an amount per unit, or bands) and attach it to a person's target. When the period ends, Deskzo works out what each person earned. Every earning shows its workings in plain words. The figure is frozen when it is worked out, so editing a scheme later does not change past earnings. Somebody other than the earner approves it. If your company runs payroll in Deskzo, approved incentives go on the next payslip as a taxable earning.

## Q: How do I see what incentive I have earned?
A: Go to **Targets & incentives → My incentives**. It shows what has been paid so far, what is still to come, and each period with its status, its workings, any reason it was held, and the payslip it went out on. Everybody has My incentives.

## Q: How do I create an incentive scheme?
A: To write an incentive scheme:
1. Go to **Targets & incentives → Schemes** and select **New scheme**.
2. Give it a **Name**. The name appears on people's payslip explanation.
3. Under **Pays on**, choose the measure. It must match the targets you will attach it to.
4. Under **How it pays**, choose a way, then fill in its **Rate (%)**, **Amount**, **Per unit** or **Bands**.
5. Optionally set **Pays from (% of target)**, a **Cap on any one payout**, and **Only pay once the money is in**.
6. Check the preview, **What this pays against a … target**, which shows the payout at several levels of achievement.
7. Fix any warnings, then select **Create**.
You need the **Manage incentive schemes** permission.

## Q: How do I set up a commission scheme for salespeople?
A: Commission in Deskzo is set up as an incentive scheme. Go to **Targets & incentives → Schemes**, select **New scheme**, give it a **Name**, choose the measure under **Pays on** (for example Invoiced value), choose **How it pays** (for example **Percentage of what was achieved**) and enter the **Rate (%)**. Select **Create**. Then attach the scheme to each salesperson's target in **Targets & incentives → All targets**.

## Q: What are the ways a scheme can pay?
A: Under **How it pays**, an incentive scheme can pay:
- **Percentage of what was achieved**: pays on the actual number, so beating the target pays more.
- **Percentage of the target**: pays the same however far past target somebody goes.
- **A flat amount**: the same sum for everybody who reaches the threshold.
- **So much per unit**: per call connected, per lead, per ticket resolved.
- **Bands**: a different rate for each range of achievement, such as 80–100% and 100% and above. Leave the top band's upper limit blank so it runs on.

## Q: What do "Pays from" and "Cap on any one payout" mean?
A: **Pays from (% of target)**: nothing is paid below this share of the target. Leave it empty to pay from the first rupee. **Cap on any one payout**: the most a single earning can be. When the cap applies, the workings say what the amount would otherwise have been.

## Q: What does "Only pay once the money is in" do?
A: This incentive scheme option is for invoiced value, order value and value of leads won. An approved incentive cannot be paid until everything invoiced in the period, where the person is the salesperson, has been collected. The incentive queue shows how much has come in.

## Q: How do I attach a scheme to a target?
A: Go to **Targets & incentives → All targets**. On the target's card, choose the scheme under **Pays on**. Only schemes for the same measure are listed. Choose **Nothing — this target pays no incentive** to take a scheme off again. Only a target for one person can pay an incentive.

## Q: How do I work out incentives at the end of the month?
A: Go to **Targets & incentives → Incentive queue** and select **Work out what's owed**. Every target with a scheme whose period has finished is worked out once. Running it again leaves those already done alone. A target that earned nothing is still recorded with its reason. You need the **Manage incentive schemes** permission.

## Q: How do I approve and pay incentives?
A: To approve incentives:
1. Go to **Targets & incentives → Incentive queue**. Filter by **Status** to see what is **Due**.
2. Read the workings on each card, then select **Approve**.
3. An approved incentive goes out on the next payroll run automatically. To record a payment made another way, select **Mark paid**.
To stop one, select **Hold** or **Cancel** and say why. The person is told, and reads your reason. You need the **Approve and pay incentives** permission.

## Q: What do the incentive statuses mean?
A: An incentive earning in Deskzo can be **Due** (waiting for approval), **Approved**, **Paid**, **Held** or **Cancelled**.

## Q: How do I give a one-off bonus?
A: To give a one-off award:
1. Go to **Targets & incentives → Incentive queue** and select **One-off award**.
2. Choose **Who**, type **How much**, **What to call it** and **What it's for**.
3. Select **Award it**.
The award goes through the same approval as any other incentive, and reaches the payslip the same way. You need the **Manage incentive schemes** permission.

## Q: Can I approve my own incentive?
A: No. Somebody else must decide your incentive, whatever permissions you hold. Deskzo says: "You can't decide your own incentive — somebody else has to."

## Q: Why is my incentive zero?
A: The workings on the incentive card say why. Most often the achievement was below the scheme's **Pays from** threshold, or did not fall in any of its bands.

## Q: Why can't I mark an approved incentive paid?
A: The scheme pays only once the money is in, and not all of what was invoiced in that period has been collected. Deskzo shows a message such as "Only 80% of what was invoiced has come in. This scheme pays once it's all collected." The card shows how much has come in.

## Q: Why isn't this month's incentive showing yet?
A: Incentives are worked out only for periods that have finished, so a late credit note cannot change a figure after somebody has seen it. While the period is running, watch the target in **Targets & incentives → My targets** instead.

## Q: Do team or company targets pay incentives?
A: No. Only a target for one person turns into an incentive earning. Team and company targets are measured but not paid.

## Q: How do I retire an incentive scheme?
A: Go to **Targets & incentives → Schemes** and use the eye button on the scheme to retire it, or to put it back in use. A retired scheme is no longer offered for new targets. What it already paid is kept.

## Q: Which permissions control Incentives?
A: These permissions are in **Settings → Roles & Permissions**:
- **Manage incentive schemes**: opens Schemes and the Incentive queue; write schemes, attach them to targets, work out what is owed, make one-off awards. Management has it by default.
- **Approve and pay incentives**: opens the Incentive queue to approve, hold, cancel or mark paid. Accounts has it by default.
- The **Targets & incentives › Incentives** section tick shows My incentives. Every role has it until an admin unticks it.

## Q: I can't see Incentives, or the Incentive queue, in my menu.
A: Incentives shows in the menu only when all of these are true:
1. Your company's plan includes Incentives (Deskzo CRM or Deskzo One).
2. The Incentives module and the Targets module are switched on in **Settings → Modules**.
3. The **Targets & incentives › Incentives** section is ticked for your role in **Settings → Roles & Permissions**.
The **Incentive queue** appears only to people with **Manage incentive schemes** or **Approve and pay incentives**. **Schemes** appears only with **Manage incentive schemes**. Ask your admin.
