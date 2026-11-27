import type { SiteRenderContext, TrustStripProps } from "@/components/site/blocks/types";
import { fill } from "@/components/site/links";
import { SiteIcon } from "@/components/site/icons";

/**
 * A row of short reasons to trust the product (owner, 15 Nov 2026) — "a database of its own", "GST e-invoicing" — each
 * with an icon. Only facts the product can stand behind: they are read as claims.
 *
 * It scrolls by on its own, slowly, and stops under the pointer (owner, 18 Nov 2026 — the new home page). The list is
 * there twice so the loop has no seam; the second copy is hidden from screen readers. With less motion asked for, it
 * stands still and wraps.
 */
export function TrustStripBlock({ props, ctx }: { props: TrustStripProps; ctx: SiteRenderContext }) {
  const items = props.items.filter((i) => i.text);
  if (!items.length) return null;
  const row = (hidden: boolean) =>
    items.map((item, i) => (
      <li key={`${hidden ? "b" : "a"}${i}`} aria-hidden={hidden || undefined} className="flex shrink-0 items-center gap-2.5 pr-12 text-[15px] font-semibold tracking-tight text-muted sm:pr-16">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand" aria-hidden="true">
          <SiteIcon name={item.icon ?? "check"} className="h-3.5 w-3.5" />
        </span>
        {fill(item.text, ctx)}
      </li>
    ));
  return (
    <section aria-label="Why teams trust it" className="overflow-hidden border-b border-line bg-surface py-6 [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
      <ul className="site-marquee motion-reduce:w-auto motion-reduce:flex-wrap motion-reduce:justify-center motion-reduce:gap-y-3 motion-reduce:px-6">
        {row(false)}
        {row(true)}
      </ul>
    </section>
  );
}
