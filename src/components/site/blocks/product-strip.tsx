import { ArrowRight, ArrowUpRight } from "lucide-react";
import { ProductIcon } from "@/components/brand/product-icon";
import type { ProductStripProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { Reveal } from "@/components/site/motion";
import { Section, SectionHeading, SiteAnchor } from "@/components/site/ui";
import { PRODUCT_FAMILY, PRODUCTS, type Product } from "@/lib/products";

/**
 * Every product as a strip of icons (owner, 24 Oct 2026: "a product strip with the icons to the home
 * page"): each product's 3D icon, its name and its line, linking to its page, on a shelf seven across —
 * four on a tablet, three on a phone, the last row centred. Pure, so the CMS's preview draws it as the
 * site does.
 *
 * As cards (owner, 18 Nov 2026 — the new home page): the suite a large dark card with a slowly turning ring of colour,
 * every other product a card that lifts under the pointer — icon, name, line and an arrow.
 */

/**
 * The products in the website's order — the Product menu's (scripts/site-content/_catalog.ts
 * PRODUCT_MENU_ORDER): the suite, then what sells and serves, runs the business and looks after its
 * people. A product not listed here follows the rest, by its group, so a new one is never left out.
 */
const ORDER: readonly Product["key"][] = ["one", "crm", "pipeline", "desk", "campaigns", "cards", "signatures", "subscriptions", "books", "inventory", "projects", "analytics", "people", "vault"];
const GROUP_ORDER: readonly Product["group"][] = ["suite", "sell", "run", "people"];

export function stripProducts(): Product[] {
  const rank = (p: Product) => {
    const i = ORDER.indexOf(p.key);
    return i >= 0 ? i : ORDER.length + GROUP_ORDER.indexOf(p.group);
  };
  return [...PRODUCTS].sort((a, b) => rank(a) - rank(b));
}

const shortName = (p: Product) => (p.group !== "suite" && p.name.startsWith(`${PRODUCT_FAMILY} `) ? p.name.slice(PRODUCT_FAMILY.length + 1) : p.name);

export function ProductStripBlock({ props, ctx }: { props: ProductStripProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const action = props.action ? resolveAction(props.action, ctx) : null;
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <ul className="mt-12 grid grid-cols-2 gap-3 sm:mt-16 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
        {stripProducts().map((product, i) =>
          product.group === "suite" ? (
            <Reveal as="li" key={product.key} className="col-span-2 md:row-span-2">
              <SiteAnchor
                href={product.path}
                className="site-night group relative isolate flex h-full min-h-72 flex-col overflow-hidden rounded-[1.75rem] p-7 transition-transform duration-300 hover:-translate-y-1 sm:p-9"
              >
                <span aria-hidden="true" className="site-spin absolute -bottom-24 -right-24 -z-10 h-96 w-96 rounded-full bg-[conic-gradient(from_0deg,#0249fe,#7c3aed,#06b6d4,#0249fe)] opacity-60 blur-[34px]" />
                <ProductIcon product={product.key} className="h-16 w-16 sm:h-20 sm:w-20" />
                <span className="mt-auto pt-10 text-3xl font-semibold tracking-[-0.035em] text-white sm:text-[2.6rem]">{product.name}</span>
                <span className="mt-3 max-w-md text-base leading-7 text-white/70">{product.tagline}</span>
                <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-white">
                  Explore {product.name}
                  <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1" />
                </span>
              </SiteAnchor>
            </Reveal>
          ) : (
            <Reveal as="li" key={product.key} delay={(i % 4) * 60}>
              <SiteAnchor
                href={product.path}
                className="group relative flex h-full flex-col rounded-[1.4rem] border border-line bg-surface p-5 transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-1.5 hover:border-line-strong hover:shadow-[0_30px_60px_-30px_rgb(15_23_42/0.35)] sm:p-6"
              >
                <ArrowUpRight aria-hidden="true" className="absolute right-5 top-5 h-4 w-4 text-subtle transition-[transform,color] duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-text" />
                <ProductIcon product={product.key} className="h-12 w-12 transition-transform duration-300 ease-out group-hover:-translate-y-1 sm:h-14 sm:w-14" />
                <span className="mt-5 text-base font-semibold tracking-tight text-text transition-colors group-hover:text-brand sm:text-lg">
                  {/* Two across on a phone: the name without the family's ("CRM"). */}
                  <span className="sm:hidden">{shortName(product)}</span>
                  <span className="hidden sm:inline">{product.name}</span>
                </span>
                <span className="mt-1.5 line-clamp-3 text-[13px] leading-5 text-muted sm:text-sm">{product.tagline}</span>
              </SiteAnchor>
            </Reveal>
          ),
        )}
      </ul>
      {action && (
        <p className="mt-8 text-center">
          <SiteAnchor href={action.href} className="group inline-flex items-center gap-1.5 text-sm font-semibold text-brand">
            {action.label}
            <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
          </SiteAnchor>
        </p>
      )}
    </Section>
  );
}
