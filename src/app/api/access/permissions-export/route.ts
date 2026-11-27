import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { PERMISSIONS, permissionGroup } from "@/lib/permissions";
import { describeSource, isHeld, resolveUserPermissions } from "@/lib/authz/resolve";
import { getPermissionMatrix } from "@/actions/permission";
import { listPermissionExceptions } from "@/actions/access";
import { recordAudit } from "@/lib/audit";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Every permission as assigned, in one workbook (owner, 2 Nov 2026: "can all assigned permissions be exported? — by
 * super admin only"). Four sheets:
 *
 *   People       — everyone, their role and status, how many permissions they hold, how many exceptions they have.
 *   Who has what — one row per person and permission they hold, and how they came by it (the resolver's own words,
 *                  src/lib/authz/resolve.ts — the same reading `can()` makes, not the matrix's defaults); a personal
 *                  deny listed too, as not held.
 *   Roles        — the permission matrix: each permission against each role.
 *   Exceptions   — every grant or deny made for one person, with who made it, why and until when.
 *
 * The super admin only — anybody else, even with permissions.view, is told there's no such page. Under /api, so
 * outside the proxy's gate; `currentUser` applies it instead. Recorded in the audit log.
 */

export const dynamic = "force-dynamic";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function heading(sheet: ExcelJS.Worksheet) {
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
}

export async function GET() {
  const user = await currentUser();
  if (!user) return new NextResponse("Not found", { status: 404 });
  const viewer = await db.user.findUnique({ where: { id: user.id }, select: { isSuperAdmin: true, active: true } });
  if (!viewer?.isSuperAdmin || !viewer.active) return new NextResponse("Not found", { status: 404 });

  const [people, matrix, exceptions, clock] = await Promise.all([
    db.user.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: { id: true, name: true, email: true, role: true, active: true, isSuperAdmin: true, userSeq: true, department: { select: { name: true } } },
    }),
    getPermissionMatrix(),
    listPermissionExceptions({ scope: "all", limit: 100_000 }),
    workspaceClock(),
  ]);
  const exceptionsOf = new Map<string, number>();
  for (const e of exceptions.rows) exceptionsOf.set(e.userId, (exceptionsOf.get(e.userId) ?? 0) + 1);

  const book = new ExcelJS.Workbook();
  book.creator = "Deskzo";
  book.created = new Date();

  const summary = book.addWorksheet("People");
  summary.columns = [
    { header: "Name", width: 26 },
    { header: "Email", width: 32 },
    { header: "Role", width: 16 },
    { header: "Team", width: 20 },
    { header: "Status", width: 12 },
    { header: "Super admin", width: 12 },
    { header: "Permissions held", width: 16 },
    { header: "Exceptions", width: 12 },
  ];
  const detail = book.addWorksheet("Who has what");
  detail.columns = [
    { header: "Name", width: 26 },
    { header: "Email", width: 32 },
    { header: "Role", width: 16 },
    { header: "Area", width: 20 },
    { header: "Permission", width: 40 },
    { header: "Key", width: 30 },
    { header: "Held", width: 8 },
    { header: "How", width: 70 },
  ];

  for (const p of people) {
    // One resolution per person — memoised for the request, the same call the access drawer makes.
    const resolved = await resolveUserPermissions(p.id);
    let held = 0;
    for (const def of PERMISSIONS) {
      const source = resolved.sources.get(def.key) ?? { via: "none" as const };
      const has = isHeld(source);
      if (has) held += 1;
      // What they hold, and what was taken from them personally — not the hundreds of keys simply not theirs.
      const personalDeny = source.via === "userGrant" && !source.allowed;
      if (has || personalDeny) detail.addRow([p.name, p.email, p.role, permissionGroup(def), def.label, def.key, has ? "Yes" : "No", describeSource(source, clock)]);
    }
    summary.addRow([p.name, p.email, p.role, p.department?.name ?? "", p.active ? "Active" : "Switched off", p.isSuperAdmin ? "Yes" : "", held, exceptionsOf.get(p.id) ?? 0]);
  }
  heading(summary);
  heading(detail);

  const roleNames = matrix.length ? Object.keys(matrix[0]!.roles) : [];
  const roles = book.addWorksheet("Roles");
  roles.columns = [{ header: "Area", width: 20 }, { header: "Permission", width: 40 }, { header: "Key", width: 30 }, ...roleNames.map((r) => ({ header: r, width: 12 }))];
  for (const row of matrix) roles.addRow([row.group, row.label, row.key, ...roleNames.map((r) => ((row.roles as Record<string, boolean>)[r] ? "Yes" : ""))]);
  heading(roles);

  const extra = book.addWorksheet("Exceptions");
  extra.columns = [
    { header: "Name", width: 26 },
    { header: "Email", width: 32 },
    { header: "Role", width: 16 },
    { header: "Permission", width: 40 },
    { header: "Key", width: 30 },
    { header: "Granted or denied", width: 18 },
    { header: "Reason", width: 40 },
    { header: "By", width: 22 },
    { header: "On", width: 14 },
    { header: "Until", width: 14 },
    { header: "Lapsed", width: 10 },
  ];
  for (const e of exceptions.rows) {
    extra.addRow([
      e.userName,
      e.userEmail,
      e.userRole,
      e.label,
      e.permission,
      e.allowed ? "Granted" : "Denied",
      e.reason ?? "",
      e.grantedByName ?? "",
      clock.date(e.grantedOn),
      // The end is stored as the midnight after the last day; the day named is that last day.
      e.expiresAt ? clock.date(new Date(e.expiresAt.getTime() - 1)) : "No end",
      e.expired ? "Yes" : "",
    ]);
  }
  heading(extra);

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Permission", entityId: "all", entityLabel: `Exported every assigned permission — ${people.length} people, ${exceptions.rows.length} exceptions` });

  const buf = await book.xlsx.writeBuffer();
  const stamp = clock.today();
  return new NextResponse(new Uint8Array(buf as ArrayBuffer), {
    headers: { "content-type": XLSX, "content-disposition": `attachment; filename="permissions-${stamp}.xlsx"`, "cache-control": "private, no-store" },
  });
}
