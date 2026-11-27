import { notFound } from "next/navigation";
import { can } from "@/lib/authz/resolve";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { countBrokenPhones } from "@/lib/leads/phone-repair";
import { currentUser } from "@/lib/session";
import { Badge } from "@/components/ui/card";
import { PhoneRepair } from "@/components/leads/phone-repair";

export const metadata = { title: "Shortened phone numbers" };

/**
 * Settings › Data & continuity › Shortened phone numbers (owner, 30 Oct 2026 — src/lib/leads/phone-repair.ts): the
 * phones Excel turned into 9.20E+11, put back from the file they came from. The super admin's alone, as the
 * duplicate-leads tool beside it is; for anyone else the page isn't there.
 */
export default async function PhoneRepairPage() {
  const user = await currentUser();
  if (!user || !(await can(user.id, "settings.manage")) || !(await actingAsSuperAdmin(user.id))) notFound();
  const broken = await countBrokenPhones();
  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-text">Shortened phone numbers</h1>
          <Badge tone="brand">Super Admin only</Badge>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          A file saved from Excel as CSV writes a long number like 919876543210 as 9.20E+11, and the digits after the
          first three are lost. Upload the file the leads came from — exported again from the old system and not opened in
          Excel — and each lead&apos;s phone is put back, matched by its Old system ID, then by email.
        </p>
      </div>
      <PhoneRepair broken={broken} />
    </div>
  );
}
