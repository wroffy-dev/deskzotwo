import type { SiteRenderContext, StackSavingsProps } from "@/components/site/blocks/types";
import { StackSavingsSection } from "@/components/site/blocks/stack-savings-section";
import type { OfferPrice } from "@/lib/billing/checkout";
import { publicOffer } from "@/lib/platform/public-offer";

/**
 * What separate tools cost beside Deskzo One — a comparison page's calculator (owner, 26 Oct 2026; the view is
 * stack-savings-view.tsx). The other tools' prices are the page's, each with its source; Deskzo One's is the live
 * plan's for India — the other prices are India's, in rupees — read when the page is served. Without it (no
 * price set yet, the control plane out of reach, or the CMS's preview) the card points to the pricing page.
 */
export async function StackSavingsBlock({ props, ctx }: { props: StackSavingsProps; ctx: SiteRenderContext }) {
  let suite: OfferPrice[] = [];
  try {
    const offer = await publicOffer("IN");
    const one = offer.plans.find((p) => p.kind === "EDITION" && p.key === "deskzo-one") ?? offer.plans.find((p) => p.kind === "EDITION" && p.productKey === "one");
    suite = (one?.prices ?? []).filter((p) => p.currency === "INR" && p.perSeat);
  } catch (err) {
    console.warn(`[site] prices unavailable: ${err instanceof Error ? err.name : "error"}`);
  }
  return <StackSavingsSection props={props} ctx={ctx} suite={suite} />;
}

export { StackSavingsSection };
