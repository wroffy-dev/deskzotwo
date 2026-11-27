import { notFound } from "next/navigation";
import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { copilotConfig } from "@/lib/copilot/settings";
import { documentWriteKey } from "@/lib/documents/write-permission";
import { workspacePack } from "@/lib/country-pack";
import { readingView } from "@/lib/bill-reader/server";
import { BillReader } from "@/components/documents/bill-reader";
import { mailBillsFor } from "@/lib/mail-reading/arjun";
import { MailBills } from "@/components/documents/mail-bills";

export const metadata = { title: "Read a bill" };
export const dynamic = "force-dynamic";

/**
 * Purchase › Bills › Read a bill (owner, 20 Nov 2026 — src/lib/bill-reader): Arjun reads the vendor's file into a draft
 * bill. For somebody who may create bills and use Deskzo AI; a refused page is a 404, as everywhere. `?reading=` brings
 * back one they read before.
 */
export default async function ReadBillPage({ searchParams }: { searchParams: Promise<{ reading?: string }> }) {
  if (!(await isModuleEnabled("purchase_documents"))) return <ModuleDisabledNotice moduleKey="purchase_documents" />;
  const user = await requireModuleUser("purchase_documents");
  if (!(await can(user.id, documentWriteKey("BILL", "create")))) notFound();
  // India's GST bills only, for now (src/lib/bill-reader/rules.ts): elsewhere the page isn't there, as its button isn't.
  if (!workspacePack().india) notFound();
  const [ai, mayUse] = await Promise.all([copilotConfig(), can(user.id, "copilot.use")]);
  const { reading } = await searchParams;
  const initial = reading ? await readingView(String(reading), user.id) : null;
  // Vendor bills that came by email to this person's mailbox, where an admin lets Arjun read it (src/lib/mail-reading/arjun.ts).
  const byEmail = ai.enabled && mayUse && !reading ? await mailBillsFor(user.id) : [];
  return (
    <div className="space-y-4">
      <div>
        <Link href="/purchase/bills" className="text-sm text-muted hover:text-text">
          ← Vendor bills
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Read a bill</h1>
        <p className="mt-1 text-sm text-muted">
          Upload the vendor&apos;s bill — their PDF, or a photo — and Arjun fills in a draft bill from it, with the GST and totals checked. You check the draft
          against the bill and save it; nothing reaches your books before you do. Each bill uses a Deskzo AI credit or two.
        </p>
      </div>
      {!ai.enabled || !mayUse ? (
        <p className="rounded-base border border-line bg-surface-sunken px-4 py-6 text-center text-sm text-muted">
          {!ai.enabled ? "Deskzo AI is switched off for this workspace — an admin can switch it on in Settings › Deskzo AI." : "Reading bills uses Deskzo AI, which takes the “Use Deskzo AI” permission."}
        </p>
      ) : (
        <>
          {byEmail.length > 0 && <MailBills bills={byEmail} />}
          <BillReader initial={initial} />
        </>
      )}
    </div>
  );
}
