import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEntitled } from "@/lib/modules-access";
import { csvFilename } from "@/lib/csv";
import { workspaceClock } from "@/lib/time/workspace";
import { listRejectsCsv } from "@/lib/marketing/list-import";

export const dynamic = "force-dynamic";

/**
 * A mailing list's left-out rows as a CSV (owner, 1 Nov 2026): not an address, repeated, an address that doesn't work,
 * one that bounced before, or a customer left out — each with why, for the uploader to fix and upload again. For
 * whoever may see the workspace's marketing.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await isModuleEntitled("marketing"))) return new NextResponse("Not found", { status: 404 });
  if (!(await can(user.id, "marketing.manage")) && !(await can(user.id, "marketing.viewAll"))) return new NextResponse("Not found", { status: 404 });
  const { id } = await params;
  const out = await listRejectsCsv(id);
  if (!out) return new NextResponse("Not found", { status: 404 });
  // A byte-order mark first, so Excel reads the names in Hindi and the rupee sign right.
  return new NextResponse(String.fromCharCode(0xfeff) + out.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(`${out.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 60) || "list"} - left out`, new Date(), await workspaceClock())}"`,
      "Cache-Control": "no-store",
    },
  });
}
