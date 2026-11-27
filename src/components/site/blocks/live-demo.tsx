import type { LiveDemoProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill } from "@/components/site/links";
import { Section, SectionHeading } from "@/components/site/ui";
import { LiveDemoView } from "@/components/site/blocks/live-demo-view";

/**
 * "See Deskzo run your business" (owner, 22 Nov 2026): the words around it are the page's; the demo is
 * live-demo-view.tsx, which opens it on its own page (deskzo.com/try/<website>).
 */
export function LiveDemoBlock({ props, ctx }: { props: LiveDemoProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <LiveDemoView placeholder={t(props.placeholder) || "acmepumps.in"} note={t(props.note)} />
    </Section>
  );
}
