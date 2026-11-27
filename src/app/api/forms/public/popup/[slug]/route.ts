import { NextResponse } from "next/server";
import { restoreInProgressFor } from "@/lib/backup/maintenance";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { TenantHostMismatch, TenantNotFound, TenantNotResolved, currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import { db } from "@/lib/db";
import { allowsLink } from "@/lib/forms/categories";
import { formWebsite } from "@/lib/forms/website";

export const dynamic = "force-dynamic";

const answer = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "access-control-allow-origin": "*", "cache-control": "no-store", "x-content-type-options": "nosniff" } });

/**
 * What a form's pop-up script needs (owner, 1 Nov 2026 — src/lib/forms/website-rules.ts): whether it's on, when to show,
 * where, and the form's page to show in its frame. Public — it says nothing the form's own page doesn't — and the same
 * "off" for a form that's closed, switched off, or not there at all.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const tenant = await currentTenant();
    if (tenant.status !== "ACTIVE" || restoreInProgressFor(tenant)) return answer({ on: false });
  } catch (err) {
    if (err instanceof TenantHostMismatch || err instanceof TenantNotFound || err instanceof TenantNotResolved) return answer({ on: false }, 404);
    throw err;
  }
  if (!(await moduleAvailableForTenant("forms"))) return answer({ on: false });
  const { slug } = await params;
  const form = await db.inboundForm.findUnique({ where: { slug: String(slug ?? "").slice(0, 120) }, select: { id: true, name: true, headline: true, active: true, fillMode: true, closesAt: true } });
  if (!form || !form.active || !allowsLink(form.fillMode) || (form.closesAt && form.closesAt < new Date())) return answer({ on: false });
  const { popup } = await formWebsite(form.id);
  if (!popup.on) return answer({ on: false });
  const origin = await tenantOrigin();
  return answer({ ...popup, title: form.headline ?? form.name, url: `${origin}/forms/${encodeURIComponent(slug)}?embed=1` });
}
