# Payroll — Deskzo

Payroll turns each employee's salary structure and monthly attendance into payslips, with PF, ESI, professional tax and TDS worked out for India. It is part of Deskzo People and Deskzo One, for workspaces in India only, and needs People (HR) switched on. In the sidebar it is **People → Payroll**.

## Q: What is Payroll in Deskzo?
A: Payroll is the Deskzo module for salaries. You set each person's salary structure, calculate a month, check and adjust it, lock it and mark it paid. Everyone sees their own payslips once the month is locked. PF, ESI, professional tax and income tax (TDS) are worked out for you. Loss of pay comes from attendance and unpaid leave. Payroll also prepares a leaver's full & final settlement.

## Q: I can't see Payroll in my menu. Why?
A: Check with your admin:
1. Your plan must include Deskzo People or Deskzo One. Payroll is only offered to workspaces in India.
2. People (HR) and Payroll must be switched on in **Settings → Modules**. Payroll needs People (HR).
3. Your role must have the section **People › Payroll** ticked in **Settings → Roles & Permissions**.
Most people see Payroll only for their own payslips.

## Q: Who can run payroll?
A: Running payroll needs the **Run payroll** permission in **Settings → Roles & Permissions**. It lets you see and set everyone's salary and tax declaration, calculate, adjust, lock and pay each month, and prepare settlements. No role has it by default except admins; the built-in HR head role starts with it. Being someone's manager never shows you their pay.

## Q: How do I set up Payroll for the first time?
A: Someone with **Run payroll** does this once:
1. Check each employee record is complete, especially the joining date. Payslips show PAN, UAN and bank account from the record.
2. Make sure each person has a state for professional tax: the branch in **Works at** in **Settings → Users**, or the state in their address.
3. Set how a CTC is split in **Settings → Salary structure**.
4. Open each person in **People → People** and select **Set salary** on the **Salary** card. People without a salary structure are skipped.
5. For anyone on the old tax regime, or paid elsewhere earlier in the tax year, record a **Declaration** on the **Income tax** card.

## Q: How do I set an employee's salary?
A: To set a salary in Deskzo Payroll:
1. Open the person in **People → People**.
2. On the **Salary** card, select **Set salary**.
3. Type the **Annual CTC**. It is split by the rules in **Settings → Salary structure**, with the special allowance taking up the rest.
4. Change any part if needed. With **Keep to the CTC** ticked, the special allowance absorbs the difference.
5. Tick whether **Provident fund**, **ESI** and **Professional tax** apply.
6. Set **Effective from**, check the totals, and select **Save structure**.

## Q: How do I give an employee a salary increase?
A: Open the person in **People → People** and select **Revise** on the **Salary** card. Choose **Revise by**: **A percentage**, **An amount a year (₹)** or **A new CTC (₹)**, and type it. Set **Effective from** and select **Save structure**. Earlier structures are kept as history. A structure cannot start on or before a month that is already locked.

## Q: How do I add a custom allowance to a salary?
A: On the salary form, under **Custom fields**, select **Add custom field** and type its name and amount a month. Or pick a company component from **+ Company component…**. To offer a component on every salary, add it under **Your own components** in **Settings → Salary structure**, at ₹ a month or % of basic.

## Q: Can I fix PF, ESI or TDS at my own amount?
A: Yes, on the salary structure. Under **PF, ESI and TDS a month**, each box shows Deskzo's own figure. Leave it empty to keep that, or type a whole-rupee amount for **PF — employee**, **PF — employer**, **ESI — employee**, **ESI — employer** or **TDS (income tax)**. The arrow beside a typed amount puts Deskzo's figure back. If the amounts are more than the monthly gross, you see "PF, ESI and TDS come to more than the monthly gross. Check the amounts fixed for them."

## Q: How do I run payroll for a month?
A: To calculate a month:
1. Go to **People → Payroll**.
2. Under **Run a month**, choose the month and year.
3. Select **Calculate**.
4. Read the result: how many payslips were calculated, and anyone **Skipped** with the reason.
You can calculate again as often as you like while the month is a draft. Approved incentives waiting to be paid are added to the payslip if your company uses Incentives.

## Q: How do I check and adjust payslips before paying?
A: Open the month from **Runs** on **People → Payroll**. The top shows **Gross**, **Deductions**, **Net to pay** and **Cost to company**. Use **Show** to list **Has loss of pay** or **Has a warning**. To change a payslip, select **Adjust**, change **Income tax (TDS)** or enter an **Other deduction** with what it is for, and select **Save**. A typed TDS figure is kept when you calculate again.

## Q: How do I lock payroll and mark it paid?
A: When the figures are right, select **Lock the month**. Payslips then become visible to employees. If you find a mistake before paying, select **Unlock**, fix it and calculate again. When salaries have left the bank, select **Mark paid**. A paid month cannot go back to draft ("A run that has been paid can't go back to draft.").

## Q: Where do I get the bank file, the PF ECR and the ESI return?
A: Open a locked or paid month in **People › Payroll**. The **Statutory and bank files** card under the register has three downloads:
- **Bank transfer** — a CSV for your bank's bulk upload (name, account number, IFSC, amount, "Salary <month>"), and an **Advice letter** to print and sign for the bank.
- **PF ECR** — the ECR text file to upload on the EPFO employer portal. Members aged 58 or over get no pension (EPS) share; the employer's whole 12% goes to EPF.
- **ESI return** — the monthly contribution sheet. Save it as Excel 97-2003 (.xls) before uploading on the ESIC portal, and check the reason codes for anyone with zero days.

Each file lists anyone it had to leave out, such as no UAN, no 10-digit ESI IP number or no bank account. Add the detail on the person's employee record and download again. A draft month has no files, because its figures can still change.

## Q: Why can't I calculate or adjust a month?
A: The month is locked or paid. Select **Unlock** on a locked month to work on it again. A paid month is final.

## Q: Someone is missing from this month's payroll.
A: After **Calculate**, the result lists everyone skipped and why: no salary structure, a joining date after the month, or a month paid in their full & final settlement. Set their salary on the **Salary** card and calculate again.

## Q: Why is an employee's pay lower this month?
A: Common reasons in Deskzo Payroll:
- Loss of pay: days recorded as Absent, and days of unpaid leave. A day nobody recorded is never counted.
- They joined or left during the month, so they are paid for the days employed.
- A typed income tax figure or other deduction on the payslip.

## Q: Can I change PF, ESI or professional tax on a payslip?
A: No. PF, ESI and professional tax come from the salary structure. Change the structure (you can fix PF and ESI amounts there), then calculate the month again while it is a draft. Professional tax follows the state of the person's branch, or the state on their record.

## Q: How does Deskzo work out TDS on salary?
A: Each month's TDS is worked out from the person's income tax declaration, their payslips so far in the tax year and the months to come. To record a declaration, open the person, pick the tax year on the **Income tax** card, select **Declaration**, choose **New regime** or **Old regime**, enter the details and earlier pay, add a **Note** and **Save**. If Deskzo does not work out TDS for a tax year, type it on the payslip with **Adjust**, or fix it on the salary structure.

## Q: Where do employees see their payslips?
A: Employees go to **People → Payroll** or **People → My HR**. Under **Your payslips**, select **Download** on the month. Payslips appear only once the month is locked.

## Q: An employee can't see their payslip.
A: Payslips appear only after the month is locked with **Lock the month**. Until then, only people with **Run payroll** can see the figures. Also check that the file is not switched off for that person in **People → File manager**.

## Q: How do I do a full & final settlement for a leaver?
A: To prepare a full & final settlement:
1. Record the person's exit in People (HR) first.
2. Open their record and select **Full & final settlement →**.
3. Select **Prepare settlement**. It needs a last working day, a joining date and a salary structure.
4. Check **Payable** and **Recoverable**. Select **Adjust** to change bonus, other earnings, recoveries and deductions.
5. Select **Recalculate** if their record changed, then **Approve**.
6. When paid, select **Mark paid**. **Reopen** takes an approved settlement back to draft; a paid one cannot go back.
Gratuity, leave encashment and notice recovery are calculated from the record.

## Q: Can I import salaries from another payroll system?
A: Yes. On **People → Payroll**, people with **Run payroll** see **Import from another system**. It brings in one row per person (found by employee code or email): salary, bank and statutory numbers, and this tax year's pay so far. Import People records first.

## Q: A locked payroll month did not reach the accounts.
A: If your company uses Accounting, locking and marking paid post to the books automatically. If Accounting could not take the entry, locking says so. Go to **Accounts → Overview**, find the payroll run in the list, and select **Post these now**.
