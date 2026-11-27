import { ProductIcon } from "@/components/brand/product-icon";
import type { HeroProps, SiteRenderContext } from "@/components/site/blocks/types";
import { MediaView } from "@/components/site/blocks/media";
import { HeroPreviewTabs } from "@/components/site/blocks/hero-preview-tabs";
import { ProductPreview } from "@/components/site/previews";
import { fill, resolveAction } from "@/components/site/links";
import { Reveal, RotatingWords } from "@/components/site/motion";
import { Container, PillLink, SiteAnchor } from "@/components/site/ui";
import { productByKey } from "@/lib/products";
import { cn } from "@/lib/utils";

/**
 * The top of the home page: the page's h1, what the product is, the ways on, and a look at it. On a product's own page —
 * its trial button starts a trial of that product — the product's icon heads it.
 *
 * Dark, with slowly drifting light behind it (owner, 18 Nov 2026 — the new home page, after a look the owner liked): a
 * large heading whose last word can take turns (`rotatingWords`), pill buttons, and the product in a browser window
 * whose screens take turns (HeroPreviewTabs). Dark in both of the site's themes.
 */
export function HeroBlock({ props, ctx }: { props: HeroProps; ctx: SiteRenderContext }) {
  const primary = props.primary ? resolveAction(props.primary, ctx) : null;
  const secondary = props.secondary ? resolveAction(props.secondary, ctx) : null;
  const tertiary = props.tertiary ? resolveAction(props.tertiary, ctx) : null;
  const tabs = (props.previewTabs ?? []).filter((tab) => tab.label);
  const note = fill(ctx.signupOpen ? props.note : props.noteInviteOnly, ctx);
  const eyebrow = fill(props.eyebrow, ctx);
  const words = (props.rotatingWords ?? []).map((w) => fill(w, ctx).trim()).filter(Boolean);
  const product = props.primary?.kind === "signup" ? productByKey(props.primary.product) : null;
  const shows = tabs.length >= 2 || !!props.media;
  return (
    <section className="site-night relative isolate overflow-hidden">
      <div aria-hidden="true" className="site-aurora">
        <i />
        <i />
        <i />
      </div>
      <div aria-hidden="true" className="site-grid" />
      <Container className={cn("relative pt-16 sm:pt-24", shows ? "pb-16 sm:pb-20" : "pb-20 sm:pb-28")}>
        <div className="mx-auto max-w-5xl text-center">
          {product && <ProductIcon product={product.key} className={cn("mx-auto block h-20 w-20 sm:h-24 sm:w-24", eyebrow && "mb-5")} />}
          {eyebrow && (
            <Reveal>
              <p className="inline-flex max-w-full items-center gap-2.5 rounded-full border border-white/15 bg-white/[0.06] py-1.5 pr-4 text-xs font-medium text-white/85 backdrop-blur sm:text-sm">
                <span aria-hidden="true" className="ml-2.5 h-2 w-2 shrink-0 rounded-full bg-[#c6f432] shadow-[0_0_0_4px_rgb(198_244_50/0.18)]" />
                <span className="truncate">{eyebrow}</span>
              </p>
            </Reveal>
          )}
          <Reveal delay={80}>
            <h1 className="mt-7 text-[2.75rem] font-semibold leading-[1.02] tracking-[-0.04em] text-white text-balance sm:text-6xl lg:text-7xl xl:text-[5.5rem]">
              {fill(props.heading, ctx)}
              {words.length >= 2 && (
                <>
                  <br className="hidden sm:block" /> <RotatingWords words={words} className="text-[#8fb0ff]" />
                </>
              )}
            </h1>
          </Reveal>
          {props.subheading && (
            <Reveal delay={160}>
              <p className="mx-auto mt-7 max-w-3xl text-base leading-7 text-white/70 text-pretty sm:text-xl sm:leading-8">{fill(props.subheading, ctx)}</p>
            </Reveal>
          )}
          {(primary || secondary || tertiary) && (
            <Reveal delay={240}>
              <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                {primary && <PillLink href={primary.href} label={primary.label} tone="light" />}
                {secondary && <PillLink href={secondary.href} label={secondary.label} tone="glass" />}
                {tertiary && (
                  <SiteAnchor href={tertiary.href} className="px-3 py-2 text-[15px] font-medium text-white/75 underline-offset-4 transition-colors hover:text-white hover:underline">
                    {tertiary.label}
                  </SiteAnchor>
                )}
              </div>
            </Reveal>
          )}
          {note && <p className="mt-5 text-sm text-white/55">{note}</p>}
        </div>
        {tabs.length >= 2 ? (
          <Reveal delay={320} className="mx-auto mt-14 max-w-6xl sm:mt-20">
            <HeroPreviewTabs
              tabs={tabs.map((tab) => ({
                label: fill(tab.label, ctx),
                screen: <ProductPreview kind={tab.preview} className="shadow-[0_-30px_120px_-20px_rgb(2_73_254/0.55)]" />,
              }))}
            />
          </Reveal>
        ) : (
          props.media && (
            <Reveal delay={320} className="mx-auto mt-14 max-w-6xl sm:mt-20">
              <MediaView media={props.media} className="shadow-[0_-30px_120px_-20px_rgb(2_73_254/0.55)]" />
            </Reveal>
          )
        )}
      </Container>
    </section>
  );
}
