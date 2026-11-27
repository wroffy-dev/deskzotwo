import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { listWebsiteEnquiries } from "@/actions/website-enquiries";
import { EnquiryList } from "@/components/leads/website-enquiries";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { TabNav } from "@/components/ui/tab-nav";

export const metadata = { title: "Website enquiries" };

/**
 * Leads › Website enquiries (owner, 9 Nov 2026 — src/lib/lead-capture/review.ts): what websites sent, waiting for
 * somebody who assigns leads to accept onto the right company or dismiss. Refused (404) without that right.
 */
export default async function WebsiteEnquiriesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  if (!(await isModuleEnabled("leads"))) return <ModuleDisabledNotice moduleKey="leads" />;
  const tab = (await searchParams).tab === "decided" ? "decided" : "waiting";
  const data = await listWebsiteEnquiries(tab === "decided" ? "decided" : "pending");
  if (!data) notFound();
  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <Link href="/leads" className="text-xs text-brand hover:underline">Leads</Link>
        <h1 className="mt-1 text-xl font-semibold text-text">Website enquiries</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          {data.held
            ? "What your websites sent, waiting for you. Accept each onto the right company — the sender's work email suggests one — a new one named properly, or the person alone; or dismiss it. Nothing is made until then."
            : "Website enquiries become leads at once now (Settings › Lead capture API). Any still waiting from before are here."}
        </p>
      </div>
      <TabNav basePath="/leads/enquiries" activeKey={tab} tabs={[{ key: "waiting", label: "Waiting" }, { key: "decided", label: "Decided" }]} />
      <EnquiryList rows={data.rows} decided={tab === "decided"} />
    </div>
  );
}
