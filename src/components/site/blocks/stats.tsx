import type { SiteRenderContext, StatsProps } from "@/components/site/blocks/types";
import { anchorId, fill } from "@/components/site/links";
import { CountUp, Reveal } from "@/components/site/motion";
import { Container } from "@/components/site/ui";
import { cn } from "@/lib/utils";

/**
 * A few figures in a row. Facts about the product only — never invented customer counts or ratings.
 *
 * Large, each under a rule, counting up as they come into view (owner, 18 Nov 2026 — the new home page).
 */
export function StatsBlock({ props, ctx }: { props: StatsProps; ctx: SiteRenderContext }) {
  if (!props.items.length) return null;
  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 py-16 sm:py-24">
      <Container>
        {props.heading && <h2 className="mb-10 text-3xl font-semibold tracking-[-0.03em] text-text text-balance sm:text-5xl">{fill(props.heading, ctx)}</h2>}
        <dl className={cn("grid gap-x-6 gap-y-10", props.items.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2", props.items.length >= 4 && "lg:grid-cols-4")}>
          {props.items.map((item, i) => (
            <Reveal key={i} delay={i * 90}>
              <div className="flex flex-col-reverse gap-3 border-t-2 border-text pt-5">
                <dt className="max-w-xs text-base leading-6 text-muted">{fill(item.label, ctx)}</dt>
                <dd className="text-5xl font-semibold leading-none tracking-[-0.05em] text-text tabular-nums sm:text-6xl lg:text-7xl">
                  <CountUp value={fill(item.value, ctx)} />
                </dd>
              </div>
            </Reveal>
          ))}
        </dl>
      </Container>
    </section>
  );
}
