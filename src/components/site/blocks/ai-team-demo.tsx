import type { AiTeamDemoProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill } from "@/components/site/links";
import { Section, SectionHeading } from "@/components/site/ui";
import { AiTeamDemoView } from "@/components/site/blocks/ai-team-demo-view";

/**
 * "Watch your AI team at work" (owner, 22–23 Nov 2026): the words around it are the page's; the six teammates at work on
 * Deskzo's own screens with a sample company are ai-team-demo-view.tsx — a replay, with no AI and no server behind it.
 */
export function AiTeamDemoBlock({ props, ctx }: { props: AiTeamDemoProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <AiTeamDemoView note={t(props.note)} />
    </Section>
  );
}
