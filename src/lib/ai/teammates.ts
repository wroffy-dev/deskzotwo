/**
 * Deskzo's AI teammates (owner, 19 Nov 2026 — "i want these agents like a character and name them"): the agents Deskzo
 * already has, each given a name, a face, a colour and a one-line job, so a person sees who did what instead of a feature.
 * Each has a photo made with an AI image tool — never a real person — and every one carries an "AI" mark, so nobody
 * mistakes a teammate for a person, least of all a customer chatting with the front desk. The drawn face is kept for
 * where no photo is given (Deskzo AI itself, and a page that wasn't handed the team).
 *
 * Their names and photos are Deskzo's, set country by country in the console (owner, 23 Nov 2026 — "lets console admin
 * decided this country wise"; src/lib/ai/teammate-looks.ts); a workspace no longer renames them. The job, colour and
 * role stay. Pure and client-safe.
 */

export const TEAMMATE_KEYS = ["deskzo", "ved", "tara", "kabir", "mira", "arjun", "priya"] as const;
export type TeammateKey = (typeof TEAMMATE_KEYS)[number];

/** How a face is drawn (src/components/ai/teammate-avatar.tsx). */
export type TeammateLook = { skin: string; hair: string; style: "short" | "bun" | "curly" | "long" | "mark" };

export type Teammate = {
  key: TeammateKey;
  /** As the workspace sees them — the name Deskzo's console set for its country, else the default. */
  name: string;
  defaultName: string;
  role: string;
  /** What they do, in a line. */
  job: string;
  /** Where people meet them. */
  where: string;
  colour: string;
  look: TeammateLook;
  /** Where their photo is served (/api/teammates/<key>/photo) — null: the drawn face. */
  photo: string | null;
};

export const TEAMMATES: Record<TeammateKey, Omit<Teammate, "name" | "photo">> = {
  deskzo: {
    key: "deskzo",
    defaultName: "Deskzo AI",
    role: "Your AI team",
    job: "Answers anything about your records and work, and brings in the right teammate.",
    where: "The chat panel, from the header",
    colour: "#0249FE",
    look: { skin: "#FFFFFF", hair: "#FFFFFF", style: "mark" },
  },
  ved: {
    key: "ved",
    defaultName: "Ved",
    role: "Researcher",
    job: "Researches a company from public sources and plans how to work each lead — and picks the leads to work first each morning.",
    where: "Lead and company pages, and Today",
    colour: "#0EA5E9",
    look: { skin: "#C68B59", hair: "#1F2937", style: "short" },
  },
  tara: {
    key: "tara",
    defaultName: "Tara",
    role: "Nurture writer",
    job: "Drafts follow-up emails for a lead's owner to approve. Never sends one by herself.",
    where: "Lead pages and Approvals",
    colour: "#EC4899",
    look: { skin: "#E0A878", hair: "#3B2416", style: "long" },
  },
  kabir: {
    key: "kabir",
    defaultName: "Kabir",
    role: "Front desk",
    job: "Answers your website chat and WhatsApp from your own guides, and hands the visitor to a person when it should.",
    where: "The Customer inbox, and the chat on your website",
    colour: "#10B981",
    look: { skin: "#A86F45", hair: "#111827", style: "curly" },
  },
  mira: {
    key: "mira",
    defaultName: "Mira",
    role: "Workflow builder",
    job: "Turns what you say should happen — “when a deal is won, give accounts a task” — into an Automate workflow.",
    where: "Automate",
    colour: "#F59E0B",
    look: { skin: "#F1C27D", hair: "#4B2E1A", style: "bun" },
  },
  // The Accounts teammate: collections (owner, 19 Nov 2026 — src/lib/collections) and reading vendors' bills (20 Nov — src/lib/bill-reader).
  arjun: {
    key: "arjun",
    defaultName: "Arjun",
    role: "Accounts",
    job: "Picks who to chase for payment each day, drafts chase emails and reads the replies; reads vendors' bills and expense receipts; and works out whose money each bank line is.",
    where: "My collections, Purchase › Bills, Expenses, Banking, and Today",
    colour: "#8B5CF6",
    look: { skin: "#B98154", hair: "#1F2937", style: "short" },
  },
  // The HR desk (owner, 20 Nov 2026 — src/lib/hr-desk).
  priya: {
    key: "priya",
    defaultName: "Priya",
    role: "HR desk",
    job: "Answers your team's HR questions — leave, holidays, attendance, payslips and policies — from their own records and your HR guides, and passes the rest to HR.",
    where: "My HR",
    colour: "#14B8A6",
    look: { skin: "#D9A066", hair: "#2B1B12", style: "long" },
  },
};

export const TEAMMATE_NAME_MAX = 30;

/** A name the console gives one: letters, spaces and the few marks names have — never a link. Empty: the default. */
export function cleanTeammateName(value: unknown): string {
  return String(value ?? "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/[^\p{L}\p{M}\p{N} .'&-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEAMMATE_NAME_MAX)
    .trim();
}

export function isTeammateKey(value: unknown): value is TeammateKey {
  return typeof value === "string" && (TEAMMATE_KEYS as readonly string[]).includes(value);
}

/** A notification in a teammate's own voice: their name, a colon, what they say — how the bell knows whose face to show. */
export const noteFrom = (name: string, text: string) => `${name}: ${text}`;

export type TeammateOverride = { name?: string | null; photo?: string | null };

/** Every teammate, with the names and photos for the workspace's country laid over the defaults. A bare string is a name. */
export function teammatesWith(own: Partial<Record<TeammateKey, string | TeammateOverride>> = {}): Record<TeammateKey, Teammate> {
  const out = {} as Record<TeammateKey, Teammate>;
  for (const key of TEAMMATE_KEYS) {
    const o = own[key];
    const given = typeof o === "string" ? { name: o } : (o ?? {});
    const name = cleanTeammateName(given.name);
    out[key] = { ...TEAMMATES[key], name: name || TEAMMATES[key].defaultName, photo: given.photo && (PHOTO_PATH.test(given.photo) || isTeammatePhoto(given.photo)) ? given.photo : null };
  }
  return out;
}

/** A photo's address, as the server gives it — never anything a page could be pointed elsewhere with. */
const PHOTO_PATH = /^\/api\/teammates\/[a-z]+\/photo\?v=[a-z0-9]{1,24}$/;
export const teammatePhotoPath = (key: TeammateKey, version: string | number) => `/api/teammates/${key}/photo?v=${version}`;

/** The most a photo may weigh, as its data: URL — a 256 px square comes to well under it. */
export const TEAMMATE_PHOTO_MAX = 300_000;
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

/** A picture as kept: a JPEG, PNG or WebP data: URL within the size — anything else is no photo. */
export function isTeammatePhoto(value: unknown): value is string {
  return typeof value === "string" && value.length <= TEAMMATE_PHOTO_MAX && PHOTO.test(value);
}
