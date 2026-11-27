import { ArrowRight } from "lucide-react";
import type { ContactOptionsProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { SiteIcon } from "@/components/site/icons";
import { Section, SectionHeading, SiteAnchor } from "@/components/site/ui";

/**
 * The ways to talk to us, side by side (owner, 15 Nov 2026: "contact whatever is required") — book a demo, talk to
 * sales, move from another system — each a card that is one link, so the whole card is the target on a phone.
 */
export function ContactOptionsBlock({ props, ctx }: { props: ContactOptionsProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const items = props.items.map((item) => ({ ...item, to: resolveAction(item.action, ctx) })).filter((i) => i.title);
  if (!items.length) return null;
  return (
    <Section id={anchorId(props.anchor)} tone="sunken">
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} align="center" />
      <ul className={`mx-auto mt-10 grid max-w-5xl gap-4 ${items.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        {items.map((item, i) => (
          <li key={i} className="min-w-0">
            <SiteAnchor
              href={item.to.href}
              className="group flex h-full flex-col rounded-2xl border border-line bg-surface p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md"
            >
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-subtle text-brand" aria-hidden="true">
                <SiteIcon name={item.icon ?? "mail"} className="h-5 w-5" />
              </span>
              <span className="mt-4 text-base font-semibold text-text">{t(item.title)}</span>
              {item.body && <span className="mt-1.5 flex-1 text-sm leading-6 text-muted">{t(item.body)}</span>}
              <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand">
                {item.to.label}
                <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" />
              </span>
            </SiteAnchor>
          </li>
        ))}
      </ul>
    </Section>
  );
}
