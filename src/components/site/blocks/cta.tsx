import type { CtaProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { ButtonLink, Container, PillLink } from "@/components/site/ui";
import { Reveal } from "@/components/site/motion";

/**
 * A call to action: a band, or a quieter panel. The band is dark with the hero's drifting light and pill buttons
 * (owner, 18 Nov 2026 — the new home page), in both of the site's themes.
 */
export function CtaBlock({ props, ctx }: { props: CtaProps; ctx: SiteRenderContext }) {
  const primary = props.primary ? resolveAction(props.primary, ctx) : null;
  const secondary = props.secondary ? resolveAction(props.secondary, ctx) : null;
  const heading = fill(props.heading, ctx);
  const body = fill(props.body, ctx);

  if (props.variant === "band") {
    return (
      <section id={anchorId(props.anchor)} className="scroll-mt-20 py-16 sm:py-24">
        <Container>
          <Reveal>
            <div className="site-night relative isolate overflow-hidden rounded-[2.5rem] px-6 py-20 text-center sm:px-12 sm:py-28">
              <div aria-hidden="true" className="site-aurora opacity-60">
                <i />
                <i />
                <i />
              </div>
              <div className="relative mx-auto max-w-4xl">
                <h2 className="text-4xl font-semibold leading-[1.02] tracking-[-0.04em] text-white text-balance sm:text-6xl lg:text-7xl">{heading}</h2>
                {body && <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-white/70 sm:text-xl">{body}</p>}
                {(primary || secondary) && (
                  <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
                    {primary && <PillLink href={primary.href} label={primary.label} tone="light" />}
                    {secondary && <PillLink href={secondary.href} label={secondary.label} tone="glass" />}
                  </div>
                )}
              </div>
            </div>
          </Reveal>
        </Container>
      </section>
    );
  }

  return (
    <section id={anchorId(props.anchor)} className="scroll-mt-20 py-12 sm:py-16">
      <Container>
        <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-8 shadow-sm sm:p-12">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(50%_120%_at_100%_0%,color-mix(in_srgb,var(--brand)_12%,transparent),transparent_70%)]" />
          <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="text-2xl font-semibold tracking-tight text-text text-balance sm:text-3xl">{heading}</h2>
              {body && <p className="mt-3 text-base leading-7 text-muted">{body}</p>}
            </div>
            {(primary || secondary) && (
              <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
                {primary && <ButtonLink href={primary.href} label={primary.label} size="lg" arrow />}
                {secondary && <ButtonLink href={secondary.href} label={secondary.label} tone="secondary" size="lg" />}
              </div>
            )}
          </div>
        </div>
      </Container>
    </section>
  );
}
