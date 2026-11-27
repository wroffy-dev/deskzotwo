import type { ReactNode } from "react";
import { BadgeCheck, CircleAlert, CircleX, Mail, Phone, ShieldAlert } from "lucide-react";
import type { VerifyDesign } from "@/lib/verifiable/design";
import { inkOn } from "@/lib/id-cards/design";
import { formatCalendarDay } from "@/lib/time/zone";
import { STANDING_WORDS, type VerifiableStanding } from "@/lib/verifiable/rules";

/**
 * The public certificate pages' look (owner, 7 Nov 2026): the same frame for the search, a document's own check page and the settings'
 * live preview, so what's previewed is what's published. Draws only what it's handed, and runs in both server and browser.
 */

const STANDING: Record<VerifiableStanding, { band: string; icon: typeof BadgeCheck }> = {
  VALID: { band: "bg-success", icon: BadgeCheck },
  EXPIRED: { band: "bg-warning", icon: CircleAlert },
  WITHDRAWN: { band: "bg-danger", icon: CircleX },
};

function Logo({ design, className }: { design: VerifyDesign; className: string }) {
  if (!design.logo) return <span className={`${className} font-semibold`}>{design.issuer}</span>;
  // A data address from the workspace's own branding.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={design.logo} alt={design.issuer} className={`${className} max-h-10 max-w-40 object-contain`} />;
}

function Accreditations({ design }: { design: VerifyDesign }) {
  if (design.accreditations.length === 0) return null;
  return (
    <div>
      <p className="text-xs text-subtle">Accredited by</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        {design.accreditations.map((a) =>
          a.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={a.name} src={a.logo} alt={a.name} title={a.name} className="max-h-10 max-w-24 object-contain" />
          ) : (
            <span key={a.name} className="rounded-base border border-line px-2 py-1 text-xs text-muted">
              {a.name}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

/** How to reach the issuer, and where to report a fake: to the issuer themselves, never to Deskzo. */
function Contact({ design }: { design: VerifyDesign }) {
  if (!design.contactEmail && !design.contactPhone) return null;
  const subject = encodeURIComponent("A certificate that looks wrong");
  return (
    <div className="space-y-1.5 text-sm">
      {design.contactEmail && (
        <a href={`mailto:${design.contactEmail}`} className="flex items-center gap-2 text-text hover:underline">
          <Mail className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" /> <span className="break-all">{design.contactEmail}</span>
        </a>
      )}
      {design.contactPhone && (
        <a href={`tel:${design.contactPhone.replace(/\s+/g, "")}`} className="flex items-center gap-2 text-text hover:underline">
          <Phone className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" /> {design.contactPhone}
        </a>
      )}
      {design.contactEmail && (
        <a href={`mailto:${design.contactEmail}?subject=${subject}`} className="flex items-center gap-2 text-muted hover:underline">
          <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" /> Report a fake certificate
        </a>
      )}
    </div>
  );
}

const Footer = () => <p className="text-center text-xs text-subtle">Powered by Deskzo</p>;

export function VerifyFrame({ design, children, heading }: { design: VerifyDesign; children: ReactNode; /** In place of the workspace's heading. */ heading?: string }) {
  const title = heading ?? design.heading;
  if (design.template === "SIMPLE") {
    return (
      <div className="mx-auto w-full max-w-xl space-y-5">
        <div className="text-center">
          <div className="flex justify-center text-text">
            <Logo design={design} className="text-lg" />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-text">{title}</h1>
          <p className="mt-1 text-sm text-muted">{design.intro}</p>
        </div>
        <div className="space-y-4">{children}</div>
        {(design.accreditations.length > 0 || design.contactEmail || design.contactPhone) && (
          <div className="flex flex-wrap justify-between gap-4 border-t border-line pt-4">
            <Contact design={design} />
            <Accreditations design={design} />
          </div>
        )}
        <Footer />
      </div>
    );
  }
  if (design.template === "PORTAL") {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-5">
        <div className="flex items-center justify-between gap-3 border-b border-line pb-3 text-text">
          <Logo design={design} className="text-base" />
          {!design.logo ? null : <span className="text-sm text-muted">{design.issuer}</span>}
        </div>
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_16rem]">
          <div className="min-w-0 space-y-4">
            <div>
              <h1 className="text-xl font-semibold text-text">{title}</h1>
              <p className="mt-1 text-sm text-muted">{design.intro}</p>
            </div>
            {children}
          </div>
          <aside className="h-fit space-y-4 rounded-2xl border border-line bg-surface p-4">
            <p className="text-sm font-medium text-text">Need help?</p>
            <Contact design={design} />
            <Accreditations design={design} />
          </aside>
        </div>
        <Footer />
      </div>
    );
  }
  const ink = inkOn(design.accent);
  return (
    <div className="mx-auto w-full max-w-2xl space-y-5">
      <div className="overflow-hidden rounded-2xl border border-line shadow-sm">
        <div className="px-6 py-6" style={{ backgroundColor: design.accent, color: ink }}>
          <Logo design={design} className="text-base" />
          <h1 className="mt-4 text-xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm opacity-90">{design.intro}</p>
        </div>
        <div className="space-y-4 bg-surface p-5">{children}</div>
      </div>
      {(design.accreditations.length > 0 || design.contactEmail || design.contactPhone) && (
        <div className="grid gap-5 rounded-2xl border border-line bg-surface p-5 sm:grid-cols-2">
          <Accreditations design={design} />
          <Contact design={design} />
        </div>
      )}
      <Footer />
    </div>
  );
}

/** The search box. A plain form, so it works without JavaScript; `disabled` in the settings' preview. */
export function VerifySearchForm({ design, query, placeholder, disabled = false }: { design: VerifyDesign; query?: string; placeholder: string; disabled?: boolean }) {
  return (
    <form action="/verify" method="get" className={`flex gap-2 ${design.template === "SIMPLE" ? "mx-auto max-w-md" : ""}`}>
      <input
        name="q"
        defaultValue={query}
        aria-label="What to search for"
        placeholder={placeholder}
        maxLength={120}
        required
        disabled={disabled}
        className="h-10 min-w-0 flex-1 rounded-base border border-line-strong bg-surface px-3 text-sm text-text outline-none focus:border-brand"
      />
      <button type={disabled ? "button" : "submit"} className="h-10 shrink-0 rounded-base px-4 text-sm font-medium" style={{ backgroundColor: design.accent, color: inkOn(design.accent) }}>
        Check
      </button>
    </form>
  );
}

export type VerifyFacts = {
  standing: VerifiableStanding;
  docType: string;
  number: string;
  title: string;
  holderName: string;
  scope: string | null;
  issuedOn: Date | string;
  expiresOn: Date | string | null;
  withdrawnOn: string | null;
  /** The workspace's own fields it marked for the public, in their order. */
  extra?: { label: string; text: string }[];
};

/** A document's whole answer. The colour says its standing, never the workspace's accent, so green always means valid. */
export function VerifyResult({ facts, issuer, checkedAt }: { facts: VerifyFacts; issuer: string; checkedAt?: string }) {
  const look = STANDING[facts.standing];
  const Icon = look.icon;
  const rows: [string, string][] = [
    ["Issued to", facts.holderName],
    ["For", facts.title],
    ["Number", facts.number],
    ["Issued on", formatCalendarDay(facts.issuedOn)],
  ];
  if (facts.expiresOn) rows.push([facts.standing === "EXPIRED" ? "Expired on" : "Valid until", formatCalendarDay(facts.expiresOn)]);
  if (facts.withdrawnOn) rows.push(["Withdrawn on", facts.withdrawnOn]);
  if (facts.scope) rows.push(["Scope", facts.scope]);
  for (const f of facts.extra ?? []) rows.push([f.label, f.text]);
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      <div className={`${look.band} px-5 py-4 text-white`}>
        <div className="flex items-center gap-2 text-base font-semibold">
          <Icon className="h-5 w-5" aria-hidden="true" />
          {STANDING_WORDS[facts.standing]}
        </div>
        <p className="mt-0.5 text-sm opacity-90">
          {facts.docType} issued by {issuer}
        </p>
      </div>
      <dl className="divide-y divide-line px-5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-4 py-2.5 text-sm">
            <dt className="w-28 shrink-0 text-muted">{label}</dt>
            <dd className="min-w-0 whitespace-pre-line break-words font-medium text-text">{value}</dd>
          </div>
        ))}
      </dl>
      {checkedAt && <p className="border-t border-line px-5 py-3 text-xs text-subtle">Checked {checkedAt}. Compare these details with the document in front of you.</p>}
    </div>
  );
}
