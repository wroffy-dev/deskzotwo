import { safeHex } from "@/lib/id-cards/design";

/**
 * How a workspace's public certificate pages look (owner, 7 Nov 2026): three templates, its own logo and colour, its words. Pure and
 * safe in the browser, so the settings' preview and the pages themselves read the same answer.
 */

export const VERIFY_TEMPLATES = ["TRUST", "SIMPLE", "PORTAL"] as const;
export type VerifyTemplate = (typeof VERIFY_TEMPLATES)[number];

export const VERIFY_TEMPLATE_WORDS: Record<VerifyTemplate, { name: string; about: string }> = {
  TRUST: { name: "Trust", about: "A banner in your colour, with your accreditations. For certification bodies." },
  SIMPLE: { name: "Simple", about: "A centred search box, and nothing else." },
  PORTAL: { name: "Portal", about: "Search beside a help panel. For trainers and labs." },
};

export type Accreditation = { name: string; logo: string | null };

export const ACCREDITATIONS_MAX = 4;
/** About 150 KB of image, as base64. */
export const LOGO_MAX_CHARS = 200_000;
/** Pictures that can't carry a script: no SVG. */
const IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export const safeLogo = (value: unknown): string | null => (typeof value === "string" && value.length <= LOGO_MAX_CHARS && IMAGE.test(value) ? value : null);

export function readAccreditations(raw: unknown): Accreditation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((a) => {
      const name = typeof a?.name === "string" ? a.name.trim().slice(0, 60) : "";
      return name ? [{ name, logo: safeLogo(a?.logo) }] : [];
    })
    .slice(0, ACCREDITATIONS_MAX);
}

export const readTemplate = (value: unknown): VerifyTemplate => (VERIFY_TEMPLATES.includes(value as VerifyTemplate) ? (value as VerifyTemplate) : "TRUST");

/** What the pages draw from: the workspace's choices over its branding. */
export type VerifyDesign = {
  template: VerifyTemplate;
  issuer: string;
  logo: string | null;
  /** A colour, checked: this reaches a style attribute. */
  accent: string;
  heading: string;
  intro: string;
  contactEmail: string | null;
  contactPhone: string | null;
  accreditations: Accreditation[];
};

const DEFAULT_ACCENT = "#0249FE";

export function verifyDesign(input: {
  template?: unknown;
  heading?: string | null;
  intro?: string | null;
  accent?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  accreditations?: unknown;
  issuer: string;
  brandLogo?: string | null;
  brandColor?: string | null;
}): VerifyDesign {
  return {
    template: readTemplate(input.template),
    issuer: input.issuer,
    logo: input.brandLogo ?? null,
    accent: safeHex(input.accent) ?? safeHex(input.brandColor) ?? DEFAULT_ACCENT,
    heading: input.heading?.trim() || "Certificate verification",
    intro: input.intro?.trim() || `Check a document issued by ${input.issuer}.`,
    contactEmail: input.contactEmail?.trim() || null,
    contactPhone: input.contactPhone?.trim() || null,
    accreditations: readAccreditations(input.accreditations),
  };
}
