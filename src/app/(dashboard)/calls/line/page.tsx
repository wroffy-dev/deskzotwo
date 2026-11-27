import { isModuleEnabled } from "@/actions/module";
import { businessLineReport, callsLastRead } from "@/actions/telephony";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { BusinessLine } from "@/components/calls/business-line";

export const metadata = { title: "Business line" };

/**
 * Calls › Business line (owner, 26 Oct 2026 — src/lib/telephony): every call on the business's CallerDesk numbers
 * in a period — answered, missed and called back, by hour, by number and by person, and the numbers that aren't
 * anyone on file. Within the viewer's own reach (src/actions/telephony.ts). The last seven days unless a period
 * is given.
 */
export default async function BusinessLinePage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  if (!(await isModuleEnabled("calls"))) return <ModuleDisabledNotice moduleKey="calls" />;
  const params = await searchParams;
  const [report, lastRead] = await Promise.all([businessLineReport({ from: params.from, to: params.to }), callsLastRead()]);
  if (!report) return <ModuleDisabledNotice moduleKey="calls" />;
  return <BusinessLine report={report} lastRead={lastRead?.at ?? null} />;
}
