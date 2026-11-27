import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { helpDeskViewer } from "@/components/desks/help-desk-gate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { isModuleEnabled } from "@/actions/module";
import { NewDeskRequestForm } from "@/components/desks/new-request-form";
import { LEVELS, spanWords } from "@/lib/desks/rules";
import { approverFor, assetsFor, deskQueue, liveDesks } from "@/lib/desks/server";

export const metadata = { title: "New request" };
export const dynamic = "force-dynamic";

/** A new request to one desk; its own people may raise one for a colleague (`for=colleague`). */
export default async function Page({ searchParams }: { searchParams: Promise<{ desk?: string; for?: string }> }) {
  if (!(await isModuleEnabled("desks"))) return <ModuleDisabledNotice moduleKey="desks" />;
  const gate = await helpDeskViewer();
  if ("instead" in gate) return gate.instead;
  const query = await searchParams;
  const seq = Number(query.desk);
  const desk = (await liveDesks()).find((d) => d.seq === seq);
  if (!desk) redirect("/help-desk");
  // Only whoever works at the desk reaches its list, and only they may raise one for somebody else.
  const forColleague = query.for === "colleague" && (await deskQueue(gate.viewer, desk.seq, "open")) !== null;
  const colleagues = forColleague ? await db.user.findMany({ where: { active: true, kind: "MEMBER", id: { not: gate.viewer.userId } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }) : null;
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <Link href={forColleague ? `/desks/${desk.seq}` : "/help-desk"} className="text-[13px] text-brand hover:underline">
          {forColleague ? "Back to the desk" : "Help desk"}
        </Link>
        <h1 className="mt-0.5 text-xl font-semibold text-text">{forColleague ? `Raise for a colleague: ${desk.name}` : `New request to ${desk.name}`}</h1>
      </div>
      <NewDeskRequestForm
        desk={{ id: desk.id, name: desk.name, people: desk.people, types: desk.types, promises: Object.fromEntries(LEVELS.map((l) => [l, `First reply within ${spanWords(desk.times[l].reply)}, put right within ${spanWords(desk.times[l].fix)}.`])) as Record<(typeof LEVELS)[number], string> }}
        assets={colleagues ? [] : await assetsFor(gate.viewer.userId)}
        colleagues={colleagues}
        approver={colleagues ? null : ((await approverFor(gate.viewer.userId))?.name ?? null)}
      />
    </div>
  );
}
