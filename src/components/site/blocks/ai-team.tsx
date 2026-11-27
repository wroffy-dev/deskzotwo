import { ArrowRight } from "lucide-react";
import { TeammateFace } from "@/components/ai/teammate-face";
import type { AiTeamProps, SiteRenderContext } from "@/components/site/blocks/types";
import { anchorId, fill, resolveAction } from "@/components/site/links";
import { Reveal } from "@/components/site/motion";
import { Section, SectionHeading, SiteAnchor } from "@/components/site/ui";
import { TEAMMATES, TEAMMATE_KEYS, type Teammate, type TeammateKey } from "@/lib/ai/teammates";
import { DEFAULT_TEAMMATE_PHOTOS } from "@/lib/ai/teammate-default-photos";

/**
 * The AI teammates as characters (owner, 19 Nov 2026 — "lets show our agents on front end like dream team"): each
 * one's photo (owner, 23 Nov 2026 — the same as the app's built-in ones, src/lib/ai/teammate-default-photos.ts), name, role and job, read from src/lib/ai/teammates.ts, so a teammate added there is on the page
 * without an edit; only the words around them are the page's. After them, a dark band for Deskzo AI itself — the
 * chat that brings them in — with the block's one link. Pure, so the CMS's preview draws it as the site does.
 */

type Member = Omit<Teammate, "name" | "photo">;

/** The named teammates, in the lib's order, with the team itself ("deskzo") kept for the band. */
export function teamAgents(): Member[] {
  return TEAMMATE_KEYS.filter((k) => k !== "deskzo").map((k) => TEAMMATES[k]);
}

/** Their role's colour, darkened enough to read on the card. */
const roleInk = (colour: string) => `color-mix(in srgb, ${colour} 58%, var(--color-text))`;

/** A teammate's photo on the site — the built-in one; inline, so the CMS's preview shows it on any host. */
export const sitePhoto = (key: TeammateKey): string | null => (key === "deskzo" ? null : DEFAULT_TEAMMATE_PHOTOS[key]);

function BigFace({ t }: { t: Member }) {
  const photo = sitePhoto(t.key);
  return (
    <span className="relative inline-flex">
      {photo ? (
        // eslint-disable-next-line @next/next/no-img-element -- an inline data: picture, the same everywhere the site is drawn.
        <img
          src={photo}
          alt={`${t.defaultName}, AI ${t.role.toLowerCase()}`}
          width={92}
          height={92}
          className="h-[92px] w-[92px] rounded-full object-cover shadow-[0_18px_36px_-18px_rgb(15_23_42/0.45)] transition-transform duration-300 ease-out group-hover:scale-[1.06]"
          style={{ boxShadow: `0 0 0 3px ${t.colour}, 0 18px 36px -18px rgb(15 23 42 / 0.45)` }}
        />
      ) : (
      <svg
        viewBox="0 0 40 40"
        width={92}
        height={92}
        role="img"
        aria-label={`${t.defaultName}, AI ${t.role.toLowerCase()}`}
        className="overflow-hidden rounded-full shadow-[0_18px_36px_-18px_rgb(15_23_42/0.45)] transition-transform duration-300 ease-out group-hover:scale-[1.06]"
      >
        <circle cx="20" cy="20" r="20" fill={t.colour} />
        <TeammateFace look={t.look} />
      </svg>
      )}
      {/* The AI mark every teammate carries (src/lib/ai/teammates.ts) — nobody mistakes one for a person. */}
      <span aria-hidden="true" className="absolute -bottom-1 -right-1.5 rounded-full border-2 border-surface bg-text px-1.5 text-[10px] font-bold leading-4 tracking-wide text-surface">
        AI
      </span>
    </span>
  );
}

export function AiTeamBlock({ props, ctx }: { props: AiTeamProps; ctx: SiteRenderContext }) {
  const t = (s?: string) => fill(s, ctx);
  const action = props.action ? resolveAction(props.action, ctx) : null;
  const note = t(props.note);
  const lead = TEAMMATES.deskzo;
  // "Your AI team" said mid-line: only the first letter comes down, so "AI" keeps its capitals.
  const leadRole = lead.role.charAt(0).toLowerCase() + lead.role.slice(1);
  return (
    <Section id={anchorId(props.anchor)}>
      <SectionHeading eyebrow={t(props.eyebrow)} heading={t(props.heading)} intro={t(props.intro)} />
      <ul className="mt-12 grid grid-cols-1 gap-3 sm:mt-16 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
        {teamAgents().map((m, i) => (
          <Reveal as="li" key={m.key} delay={i * 70}>
            <div className="group relative flex h-full flex-col overflow-hidden rounded-[1.4rem] border border-line bg-surface text-center transition-[transform,box-shadow,border-color] duration-300 hover:-translate-y-1.5 hover:border-line-strong hover:shadow-[0_30px_60px_-30px_rgb(15_23_42/0.35)]">
              <div className="flex justify-center pb-5 pt-9" style={{ background: `linear-gradient(180deg, ${m.colour}2e, transparent)` }}>
                <BigFace t={m} />
              </div>
              <div className="flex flex-1 flex-col px-5 pb-7 sm:px-6">
                <p className="text-[12px] font-semibold uppercase tracking-[0.1em]" style={{ color: roleInk(m.colour) }}>
                  {m.role}
                </p>
                <p className="mt-1 text-xl font-semibold tracking-tight text-text">{m.defaultName}</p>
                <p className="mt-2 text-sm leading-6 text-muted">{m.job}</p>
                <p className="mt-auto pt-5 text-xs text-subtle">{m.where}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </ul>
      {/* Deskzo AI itself: the chat that answers and brings the right teammate in. */}
      <Reveal className="mt-3 sm:mt-4">
        <div className="site-night relative isolate flex flex-col gap-6 overflow-hidden rounded-[1.75rem] p-7 sm:flex-row sm:items-center sm:gap-8 sm:p-9">
          <span aria-hidden="true" className="site-spin absolute -right-24 -top-24 -z-10 h-80 w-80 rounded-full bg-[conic-gradient(from_0deg,#0249fe,#7c3aed,#06b6d4,#0249fe)] opacity-50 blur-[34px]" />
          <span className="relative inline-flex shrink-0">
            <svg viewBox="0 0 40 40" width={64} height={64} role="img" aria-label={`${lead.defaultName} — ${leadRole}`} className="overflow-hidden rounded-full">
              <circle cx="20" cy="20" r="20" fill={lead.colour} />
              <TeammateFace look={lead.look} />
            </svg>
            <span aria-hidden="true" className="absolute -bottom-1 -right-1.5 rounded-full border-2 border-white/20 bg-white px-1.5 text-[10px] font-bold leading-4 tracking-wide text-slate-900">
              AI
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xl font-semibold tracking-tight text-white sm:text-2xl">
              {lead.defaultName} <span className="font-normal text-white/60">· {leadRole}</span>
            </p>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-white/70 sm:text-base sm:leading-7">{lead.job}</p>
            {note && <p className="mt-3 text-xs text-white/55 sm:text-[13px]">{note}</p>}
          </div>
          {action && (
            <p className="shrink-0">
              <SiteAnchor href={action.href} className="group/cta inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-slate-900 transition-transform duration-200 hover:scale-[1.03]">
                {action.label}
                <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform duration-200 group-hover/cta:translate-x-0.5" />
              </SiteAnchor>
            </p>
          )}
        </div>
      </Reveal>
    </Section>
  );
}
