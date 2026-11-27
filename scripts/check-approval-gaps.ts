/**
 * check:approval-gaps — an approval rule with nobody left to sign off (owner, 9 Nov 2026 — src/lib/documents/approval-gaps.ts).
 *
 *   1. The rule by cases: a manager-approved rule is never stuck; named or role-held approvers keep it going.
 *   2. On the database, with a rule of its own on debit notes (removed in a finally): a named approver keeps it going;
 *      switching them off says it leaves the rule with nobody, the settings list and the rule's gaps say so; somebody
 *      in a named role keeps it going again; and the notifications skip approvers who have left.
 *
 *   npm run check:approval-gaps
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { ruleHasApprover } from "../src/lib/documents/approval-gaps";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

let actorId = "";
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const u = async () => ({ id: actorId, name: "Probe" });
    return { requireUser: u, currentUser: u, getCurrentUser: u, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

async function main() {
  console.log("\n— 1. The rule —\n");
  ok("the submitter's manager approves: never stuck", ruleHasApprover({ managerApproves: true, namedActive: 0, roleHoldersActive: 0 }));
  ok("a named approver still here keeps it going", ruleHasApprover({ managerApproves: false, namedActive: 1, roleHoldersActive: 0 }));
  ok("somebody holding a named role keeps it going", ruleHasApprover({ managerApproves: false, namedActive: 0, roleHoldersActive: 3 }));
  ok("nobody named, no role holder, no manager: stuck", !ruleHasApprover({ managerApproves: false, namedActive: 0, roleHoldersActive: 0 }));

  console.log("\n— 2. On the database —\n");
  const { db } = await import("../src/lib/db");
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
  actorId = admin.id;
  const person = await db.user.findFirst({ where: { active: true, isSuperAdmin: false, kind: "MEMBER", role: { notIn: ["ADMIN"] } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, role: true } });
  if (!person) return ok("somebody to name as an approver", false);
  const before = await db.documentApprovalPolicy.findUnique({ where: { docType: "DEBIT_NOTE" }, select: { docType: true } });
  if (before) return ok("debit notes have no rule of their own yet, to try one on", false, "a DEBIT_NOTE rule exists; left alone");
  const gapsLib = await import("../src/lib/documents/approval-gaps");
  const approvals = await import("../src/actions/document-approval");
  const users = await import("../src/actions/user");
  try {
    await db.documentApprovalPolicy.create({ data: { docType: "DEBIT_NOTE", enabled: true, approverRoles: [], managerApproves: false, approvers: { connect: [{ id: person.id }] } } });
    ok("a named approver who's here: not a gap", !(await gapsLib.approvalGaps()).some((g) => g.docType === "DEBIT_NOTE"));
    ok("  switching them off would leave it with nobody", (await gapsLib.gapsIfSwitchedOff(person.id)).some((g) => g.docType === "DEBIT_NOTE"));

    const off = await users.setUserActive(person.id, false);
    ok("switched off, the result says which rule now has nobody", off.ok && off.data.approvalGaps.some((w) => /debit note/i.test(w)), off);
    ok("  the rule's gaps list it", (await gapsLib.approvalGaps()).some((g) => g.docType === "DEBIT_NOTE"));
    const listed = await approvals.listApprovalPolicies();
    ok("  and the settings screen's row says so", listed.ok && !!listed.data.find((p) => p.docType === "DEBIT_NOTE")?.noApprover);

    await db.documentApprovalPolicy.update({ where: { docType: "DEBIT_NOTE" }, data: { approverRoles: [person.role] } });
    const holders = await db.user.count({ where: { role: person.role, active: true, isSuperAdmin: false, kind: "MEMBER" } });
    ok("somebody else in a named role keeps it going", (await gapsLib.approvalGaps()).some((g) => g.docType === "DEBIT_NOTE") === (holders === 0));
    await db.documentApprovalPolicy.update({ where: { docType: "DEBIT_NOTE" }, data: { approverRoles: [], managerApproves: true } });
    ok("  as does the submitter's manager approving", !(await gapsLib.approvalGaps()).some((g) => g.docType === "DEBIT_NOTE"));
    ok("switching somebody on says nothing about gaps", ((await users.setUserActive(person.id, true)) as { ok: boolean; data?: { approvalGaps: string[] } }).data?.approvalGaps.length === 0);
  } finally {
    await db.documentApprovalPolicy.deleteMany({ where: { docType: "DEBIT_NOTE" } });
    await db.user.update({ where: { id: person.id }, data: { active: true } });
  }

  const source = readFileSync("src/actions/document-approval.ts", "utf8");
  ok("the notifications go only to named approvers still working here", /where: \{ id: \{ in: policy\.approverUserIds \}, active: true \}/.test(source));
  ok("the document shows the warning", readFileSync("src/components/documents/document-detail.tsx", "utf8").includes("approval?.noApprover"));
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
