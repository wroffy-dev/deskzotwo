/**
 * Every server action that saves something bounds what it is sent (owner, 15 Nov 2026: "input field sanitization and
 * validations"). A schema in src/lib/validation carries a maximum on every text field (check-audit-fixes-e walks them);
 * an action without one must cap its text itself — `.slice(`, a length test, `TEXT_MAX`, `tooLong`, or a pure helper
 * that does. This reads every exported action in src/actions and fails on one that writes to the database with none of
 * those in its body, so a new action can't forget.
 *
 * Static, by design: an action is called with whatever a script sends, and sending every action oversized input
 * would mean a session, a fixture and a side effect per action. The 6 MB body limit (next.config.ts) is the ceiling
 * either way; this is about what gets stored.
 *
 *   npx tsx scripts/check-input-bounds.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "src", "actions");
const WRITES = /\b(?:db|tx|controlDb\(\))\.\w+\.(?:create|createMany|update|updateMany|upsert)\(/;
const BOUNDED =
  /safeParse\(|\.parse\(|\.slice\(|\.substring\(|\.length\s*[<>]=?|TEXT_MAX|tooLong|maxLength|\bMAX_[A-Z_]+|clean(?:Name|Text|Line)\(|boundedText\(|text\(|clip\(|trimTo\(|limit\(/;
/** Parameters that carry nothing typed: ids looked up, booleans, enums checked against a list. */
const ONLY_IDS = /^\(\s*(?:\w+\s*:\s*(?:string|boolean|number)(?:\s*\|\s*null)?\s*,?\s*)*\)$/;

/** Actions read and judged as bounded by hand — each with why. Keep this short; prefer a cap in the action. */
const REVIEWED = new Set<string>([
  // no text (booleans; unknownNetwork checked against NETWORK_ACTIONS)
  "src/actions/access-control.ts:saveRolePolicy",
  // no text (tri-state flags)
  "src/actions/access-control.ts:savePersonDeviceRule",
  // messageFrom caps at LOCK_MESSAGE_MAX; until parsed as a date
  "src/actions/access-lock.ts:lockUser",
  // messageFrom caps; confirm compared to a fixed phrase
  "src/actions/access-lock.ts:lockCompany",
  // no text (audience in AUDIENCES, numbers, flags)
  "src/actions/activity-awards.ts:saveActivityAwardSettings",
  // no text (ids looked up; date parsed)
  "src/actions/bank.ts:clearCheque",
  // no text
  "src/actions/branding.ts:removeBrandingImage",
  // no text (RETENTION_CHOICES)
  "src/actions/call-recordings.ts:saveRecordingSettings",
  // no text (ids, enum method)
  "src/actions/calling-activity.ts:redistributeActivity",
  // no text (enum)
  "src/actions/company.ts:setVendorStatus",
  // no text (CLIENT/RESELLER only)
  "src/actions/company.ts:changeCustomerKind",
  // no text (flags, bounded number)
  "src/actions/copilot.ts:saveCopilotSettings",
  // no text (sortOrder)
  "src/actions/custom-fields.ts:moveCustomFieldDefinition",
  // checkCategory caps name and guidance
  "src/actions/customer-category.ts:saveCustomerCategory",
  // no text (sortOrder)
  "src/actions/customer-category.ts:moveCustomerCategory",
  // no text (ASSIGN_ROLES flag, boolean)
  "src/actions/department.ts:setDepartmentAssignTeam",
  // no text (enum type; body built on the server)
  "src/actions/employee-docs.ts:draftLetter",
  // no text (12-digit pattern, dates parsed)
  "src/actions/eway.ts:associateEwayBill",
  // normaliseVehicleNumber (6-14 chars); reasonNote only sent to the portal
  "src/actions/eway.ts:updateEwayVehicle",
  // no text (EXPENSE_APPROVAL_FLOWS)
  "src/actions/expense.ts:setExpenseApprovalFlow",
  // no text (bounded number)
  "src/actions/expense.ts:setExpenseReceiptRule",
  // readPolicy (flags and lists only)
  "src/actions/field-access.ts:setRoleFieldAccess",
  // no text (bounded integer)
  "src/actions/field-access.ts:setRoleUnmaskLimit",
  // no text (isFolderKey, boolean)
  "src/actions/file-manager.ts:setFolderVisible",
  // cleanGrants plus ids checked to exist
  "src/actions/forms.ts:saveFormSharing",
  // no text (enum)
  "src/actions/forms.ts:markAttendance",
  // no text (date parsed; rows from stored targets)
  "src/actions/incentive.ts:generateEarnings",
  // no text (user ids checked)
  "src/actions/insurance.ts:addInsuranceMembers",
  // dependentsOrRefusal (8 at most, name 2-80, relation from a list)
  "src/actions/insurance.ts:saveMyDependents",
  // nameFrom (80 characters)
  "src/actions/item-category.ts:createItemCategory",
  // nameFrom (80 characters)
  "src/actions/item-category.ts:renameItemCategory",
  // no text (numbers; role checked)
  "src/actions/lead-limits.ts:setRoleLeadLimit",
  // no text (day pattern, boolean)
  "src/actions/loan.ts:recordDisbursal",
  // no text (topics from TOPICS; user agent cut to 160)
  "src/actions/marketing-public.ts:updatePreferences",
  // no text (enum)
  "src/actions/marketing.ts:setJourneyStatus",
  // parseReminderSounds (flags only)
  "src/actions/notification.ts:saveReminderSounds",
  // no text (type from describeNotification)
  "src/actions/notification.ts:setNotificationPreference",
  // no text (numbers)
  "src/actions/payroll.ts:saveSplitRules",
  // no text (sortOrder)
  "src/actions/pipeline.ts:movePipeline",
  // no text (SUPPORT_STATUSES)
  "src/actions/platform/console-support.ts:setSupportStatus",
  // no text (SUPPORT_PRIORITIES)
  "src/actions/platform/console-support.ts:setSupportPriority",
  // noteBody (4,000 characters)
  "src/actions/platform/console-workspace.ts:consoleAddNote",
  // no text (boolean or null)
  "src/actions/portal.ts:setCompanyPortalAccess",
  // no text
  "src/actions/portal.ts:revokePortalLogin",
  // no text (RACES)
  "src/actions/prizes.ts:announcePrizesNow",
  // no text (ids, numbers)
  "src/actions/receivable.ts:applyPaymentToInvoice",
  // no text
  "src/actions/reconcile.ts:reopenLine",
  // no text (enum)
  "src/actions/reseller.ts:setResellerStatus",
  // no text (OPEN/CLOSED)
  "src/actions/reviews.ts:setReviewCycleStatus",
  // no text (day check, owner looked up)
  "src/actions/service-cycles.ts:updateCycle",
  // no text (enum)
  "src/actions/settlement.ts:setSettlementStatus",
  // shiftOrRefusal (name 2-60, code 1-4)
  "src/actions/shifts.ts:saveShift",
  // no text (day; shift looked up or OFF)
  "src/actions/shifts.ts:setRosterDay",
  // no text (numbers)
  "src/actions/short-leave.ts:saveShortLeavePolicy",
  // no text (readSignInMethod; role from listRoles)
  "src/actions/sign-in-rules.ts:setRoleSignIn",
  // no text (readSignInMethod; user looked up)
  "src/actions/sign-in-rules.ts:setPersonSignIn",
  // checkCompanyFrom (254 characters and address shape)
  "src/actions/support-mail.ts:saveSupportMailSettings",
  // no text (ids, ticket number parsed)
  "src/actions/support-mail.ts:addEmailToTicket",
  // no text (enum)
  "src/actions/survey.ts:setSurveyStatus",
  // no text (TASK_REMINDER_REPEATS; date parsed)
  "src/actions/task-extras.ts:setTaskReminder",
  // no text (15-digit pattern, numbers, date)
  "src/actions/tds-statement.ts:saveTdsStatementToken",
  // no text (member from CallerDesk's own list)
  "src/actions/telephony.ts:saveTelephonyAgent",
  // readTimeZone (a known IANA zone)
  "src/actions/time-zone.ts:setWorkspaceTimeZone",
  // no text (boolean)
  "src/actions/transporter.ts:setTransporterActive",
  // no text
  "src/actions/user-photo.ts:removeProfilePhoto",
  // no text (password and code go only to confirmIdentity)
  "src/actions/vault.ts:revealSecret",
  // no text (ids, enum level, date)
  "src/actions/vault.ts:shareCredential",
  // no text (booleans)
  "src/actions/verifiable.ts:saveVerifiableSearch",
  // companionsOf (10 at most, each capped) plus upload checks
  "src/actions/visitor-public.ts:checkInWithInvite",
  // no text (SCOPES; enum list; numbers)
  "src/actions/wins.ts:saveWinsSettings",
  // cleanWordList (WORD_MAX_LENGTH, WORD_LIST_MAX)
  "src/actions/word-filter.ts:saveWordFilter",
  // no text (GOOGLE/ZOHO only)
  "src/actions/workplace.ts:removeWorkplaceApp",
  // readExpiry: only nothing or a real YYYY-MM-DD day
  "src/actions/access.ts:extendUserPermission",
  // times parsed by a pattern; the audit label uses the parsed value
  "src/actions/attendance.ts:saveOfficeHours",
  // time parsed by a pattern; the audit label uses the parsed value
  "src/actions/backup.ts:saveBackupSchedule",
  // parseStatementCsv (src/lib/ledger/reconcile.ts) caps narration and reference
  "src/actions/bank.ts:importStatement",
  // checkWebsite / httpsImage (src/lib/forms/website-rules.ts) refuses an over-long image address
  "src/actions/form-website.ts:saveFormWebsite",
  // checkFieldsForSave (src/lib/marketing/form-fields.ts) caps every field's text
  "src/actions/forms.ts:saveForm",
  // the name goes through saveCampaign, which caps it
  "src/actions/marketing.ts:sendMassMail",
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".ts") ? [path] : [];
  });
}

/** Each exported async function: its name, its parameter list, and its body (to the next top-level export). */
function actionsOf(source: string): { name: string; params: string; body: string }[] {
  const out: { name: string; params: string; body: string }[] = [];
  const re = /^export async function (\w+)\s*(\([\s\S]*?\))\s*(?::[^{]*)?\{/gm;
  const starts: { name: string; params: string; at: number }[] = [];
  for (let m = re.exec(source); m; m = re.exec(source)) starts.push({ name: m[1]!, params: m[2]!, at: m.index });
  starts.forEach((s, i) => out.push({ name: s.name, params: s.params, body: source.slice(s.at, starts[i + 1]?.at ?? source.length) }));
  return out;
}

const offenders: string[] = [];
let checked = 0;
for (const file of files(ROOT)) {
  const source = readFileSync(file, "utf8");
  if (!/^["']use server["']/m.test(source)) continue;
  for (const action of actionsOf(source)) {
    if (!WRITES.test(action.body)) continue;
    checked += 1;
    const id = `${relative(join(__dirname, ".."), file).split("\\").join("/")}:${action.name}`;
    if (REVIEWED.has(id)) continue;
    // Only ids, numbers and flags: nothing typed is stored from them as text.
    if (ONLY_IDS.test(action.params.replace(/\s+/g, " "))) continue;
    if (!BOUNDED.test(action.body)) offenders.push(id);
  }
}

console.log(`Checked ${checked} actions that save something.`);
if (offenders.length) {
  console.log(`\n${offenders.length} take typed input and bound none of it:\n${offenders.map((o) => `  ${o}`).join("\n")}`);
  process.exit(1);
}
console.log("Every one bounds its input.");
