import { requireAccessViewer } from "@/lib/access-control/guard";
import { notFound } from "next/navigation";
import { simulatorView } from "@/actions/access-control-tools";
import { AcPage } from "@/components/access-control/ui";
import { Simulator } from "@/components/access-control/tools/simulator";

export const metadata = { title: "Permission Simulator" };

/**
 * Settings › Access Control › Permission Simulator: what one person (or a role on its own) gets in a
 * module, and why — before they ask.
 *
 * The whole simulation is in the address (`user` or `role`, `module`, and `q` for the question open),
 * so one can be linked. The server answers every question the module offers with the real resolvers;
 * nothing is written, revealed or counted against anybody's daily limit.
 */
export default async function SimulatorPage({ searchParams }: { searchParams: Promise<{ user?: string; role?: string; module?: string; q?: string }> }) {
  await requireAccessViewer();
  const sp = await searchParams;
  const view = await simulatorView({ user: sp.user, role: sp.role, module: sp.module });
  if (!view) notFound();

  return (
    <AcPage crumb="Permission Simulator" title="Permission Preview / Simulator" description="Pick a person and a module. See exactly what they get, and why, before they ask.">
      <Simulator key={`${view.subject.kind}:${view.subject.id}:${view.module.key}`} view={view} initialTry={typeof sp.q === "string" ? sp.q : null} />
    </AcPage>
  );
}
