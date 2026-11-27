import type { SiteRenderContext, StackSavingsProps } from "@/components/site/blocks/types";
import { StackSavingsView, type StackSavingsData } from "@/components/site/blocks/stack-savings-view";
import { anchorId, calendarDateLabel, fill, resolveAction, safeSrc, sourceSite } from "@/components/site/links";
import { Section, SectionHeading } from "@/components/site/ui";
import type { OfferPrice } from "@/lib/billing/checkout";
import { productByKey } from "@/lib/products";

/**
 * Kept apart from stack-savings.tsx, which reads the live prices on the server: the CMS's preview (a client component)
 * draws this one, and a file that also imports the price lookup pulls the server's tenancy code into the browser's
 * bundle, which the production build refuses.
 */

/** The section itself, with whatever prices were found — the CMS's preview passes none. */
export function StackSavingsSection({ props, ctx, suite }: { props: StackSavingsProps; ctx: SiteRenderContext; suite: OfferPrice[] }) {
  const t = (s?: string) => fill(s, ctx);
  const rupeesOf = (interval: "MONTH" | "YEAR") => {
    const p = suite.find((x) => x.interval === interval);
    return p ? p.amount / 100 : null;
  };
  const signup = resolveAction({ kind: "signup" }, ctx);
  const data: StackSavingsData = {
    heading: t(props.heading),
    eyebrow: t(props.eyebrow) || null,
    intro: t(props.intro) || null,
    anchor: anchorId(props.anchor),
    siteName: ctx.settings.siteName,
    suiteName: productByKey("one")?.name ?? `${ctx.settings.siteName} One`,
    people: props.people || 10,
    asOf: calendarDateLabel(props.asOf) ?? props.asOf,
    disclaimer: t(props.disclaimer),
    tools: (props.tools ?? []).map((tool) => ({
      name: t(tool.name),
      replaces: t(tool.replaces),
      price: tool.price,
      priceYearly: tool.priceYearly ?? null,
      per: tool.per,
      included: tool.per === "org" ? (tool.included ?? null) : null,
      extra: tool.extra ?? null,
      extraYearly: tool.extraYearly ?? null,
      basis: tool.basis ? t(tool.basis) : null,
      source: sourceSite(tool.source),
      selected: !!tool.selected,
      logoUrl: safeSrc(tool.logoUrl),
    })),
    suite: { month: rupeesOf("MONTH"), year: rupeesOf("YEAR") },
    signup: { href: signup.href, label: signup.label },
    pricingHref: "/pricing",
  };
  return (
    <Section id={data.anchor}>
      <SectionHeading eyebrow={data.eyebrow ?? undefined} heading={data.heading} intro={data.intro ?? undefined} align="center" />
      <StackSavingsView data={data} />
    </Section>
  );
}
