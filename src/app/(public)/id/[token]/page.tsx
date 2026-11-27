import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BadgeCheck, CircleX } from "lucide-react";
import { getBranding } from "@/actions/branding";
import { getOrganisation } from "@/lib/organisation";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { idCardCheck, userOfIdCardToken } from "@/lib/id-cards/cards";
import { workspaceClock } from "@/lib/time/workspace";

export const metadata: Metadata = { title: "ID card check", robots: { index: false, follow: false } };

/**
 * What an employee ID card's QR code opens (owner, 31 Oct 2026 — src/lib/id-cards), for anybody — a guard at a gate, a
 * client at reception: whose card it is and whether it is still good. A card whose holder has left says so, with their
 * name only; an address that isn't a card is a 404.
 */
export default async function IdCardCheckPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await moduleAvailableForTenant("hr"))) notFound();
  const userId = await userOfIdCardToken(token);
  const check = userId ? await idCardCheck(userId) : null;
  if (!check) notFound();
  const [branding, org, clock] = await Promise.all([getBranding(), getOrganisation(), workspaceClock()]);
  const company = org.tradeName?.trim() || org.legalName.trim() || branding.appName;

  return (
    <div className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <div className={check.valid ? "bg-success px-5 py-4 text-white" : "bg-danger px-5 py-4 text-white"}>
        <div className="flex items-center gap-2 text-base font-semibold">
          {check.valid ? <BadgeCheck className="h-5 w-5" aria-hidden="true" /> : <CircleX className="h-5 w-5" aria-hidden="true" />}
          {check.valid ? "Valid ID card" : "This card is no longer valid"}
        </div>
        <p className="mt-0.5 text-sm opacity-90">{check.valid ? `Works at ${company}` : `No longer works at ${company}`}</p>
      </div>
      <div className="flex items-center gap-4 px-5 py-5">
        {check.photoDataUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={check.photoDataUrl} alt="" className="h-20 w-16 shrink-0 rounded-lg object-cover" />
        )}
        <div className="min-w-0">
          <div className="text-lg font-semibold text-text">{check.name}</div>
          {check.designation && <div className="text-sm text-muted">{check.designation}</div>}
          {check.employeeCode && <div className="mt-1 font-mono text-xs text-subtle">{check.employeeCode}</div>}
        </div>
      </div>
      <p className="border-t border-line px-5 py-3 text-xs text-subtle">Checked {clock.dateTime(new Date())}</p>
    </div>
  );
}
