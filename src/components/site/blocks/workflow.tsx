import type { SiteRenderContext, WorkflowProps } from "@/components/site/blocks/types";
import { WorkflowSteps } from "@/components/site/blocks/workflow-steps";
import { anchorId, fill } from "@/components/site/links";
import { Reveal } from "@/components/site/motion";
import { Section, SectionHeading } from "@/components/site/ui";

/**
 * How the work flows from one record to the next (owner, 18 Nov 2026 — the new home page): Lead → Quote → Order →
 * Invoice → Payment → Books along a line, taking turns, each showing a few lines of what it makes. The words and the
 * sample figures are the CMS's; the turns are WorkflowSteps'.
 */
export function WorkflowBlock({ props, ctx }: { props: WorkflowProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const steps = props.steps
    .filter((s) => s.title && s.heading)
    .map((s) => ({ icon: s.icon, title: t(s.title), caption: t(s.caption), heading: t(s.heading), body: t(s.body), lines: (s.lines ?? []).filter((l) => l.label).map((l) => ({ label: t(l.label), value: t(l.value) })) }));
  if (steps.length < 2) return null;
  return (
    <Section id={anchorId(props.anchor)}>
      <Reveal>
        <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      </Reveal>
      <Reveal delay={120} className="mt-14 sm:mt-20">
        <WorkflowSteps steps={steps} />
      </Reveal>
    </Section>
  );
}
