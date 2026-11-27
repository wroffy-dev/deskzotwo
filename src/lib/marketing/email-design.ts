import { z } from "zod";

/**
 * The email builder's designs (owner, 1 Nov 2026: a drag-and-drop template creator, "easy to use, Elementor type").
 *
 * A design is the page's settings and a list of blocks — a logo, a heading, text, a picture, a button, a banner, a
 * details panel, a checklist, columns, social links, a sign-off, a divider, a gap, or HTML of one's own. Each block is
 * drawn here as email-safe HTML: tables for layout, every style inline, no web fonts, nothing that runs — the pieces
 * the template library was made of, so a design reads the same in Outlook as in Gmail.
 *
 * Plain data and string building, used in three places alike: the builder's canvas (each block drawn in the browser),
 * the template library (its templates are designs), and the server, which draws the whole email when a design is
 * saved and keeps the design beside it (src/actions/email-builder.ts). Text is written in as typed — `{{fields}}`
 * kept for the merge (src/lib/marketing/merge.ts) — and the server cleans the finished HTML as any uploaded template.
 */

export type BuilderBrand = {
  /** The company's name, for a logo block when there is no logo. */
  name: string;
  /** A hex colour, #rrggbb. */
  color: string;
  /** An image the email can carry: a data URL or a hosted address; null for none. */
  logo: string | null;
  email: string | null;
  phone: string | null;
};

const align = z.enum(["left", "center", "right"]);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).optional();
const short = (max = 300) => z.string().max(max);
const id = z.string().regex(/^[a-z0-9_-]{1,40}$/i);
/** An address a link may go to: the web, an email, a phone, or a merge field that becomes one. */
const link = z
  .string()
  .max(1000)
  .refine((u) => u === "" || /^(https?:\/\/|mailto:|tel:|\{\{)/i.test(u.trim()), "A link starts with https://, mailto: or tel:.");
/** A picture: one hosted here, a web address, or (in the builder, before saving) a data URL. */
const picture = z
  .string()
  .max(3_000_000)
  .refine((u) => u === "" || /^(https?:\/\/|\/api\/marketing\/assets\/|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(u), "A picture is uploaded, or a web address.");

const px = (min: number, max: number) => z.number().int().min(min).max(max).optional();

/**
 * What every block may set about its own look (owner, 1 Nov 2026: "more controls"): a background of its own, and the
 * space above and below it.
 */
/** Places a block may be kept to: names with commas between, nothing that would end a merge tag. */
const places = z.string().max(300).regex(/^[^{}|]*$/, "A place's name can't have { } or |.");

/**
 * Who sees a block (owner, 1 Nov 2026: "show a block only to some people") — customers or prospects, and only in some
 * cities or states. Written into the email as dynamic content (src/lib/marketing/merge.ts), so everybody else gets the
 * email without it.
 */
const audience = z.object({ who: z.enum(["everyone", "customers", "prospects"]).default("everyone"), cities: places.default(""), states: places.default("") }).strict();

const style = { bg: color, padTop: px(0, 80), padBottom: px(0, 80), show: audience.optional() };

/** A second logo beside the company's — a maker's or partner's (owner: "our logo plus an OEM logo on the right side"). */
const partnerLogo = z.object({ src: picture, alt: short(120).default(""), width: z.number().int().min(40).max(260).default(110), link: link.default("") }).strict();

export const blockSchema = z.discriminatedUnion("type", [
  z
    .object({
      id,
      type: z.literal("logo"),
      align: align.default("left"),
      bar: z.boolean().default(true),
      /** The logo's width in pixels; 160 when not chosen. */
      size: px(60, 320),
      /** A picture to use instead of the logo in Settings › Branding. */
      src: picture.optional(),
      barColor: color,
      partner: partnerLogo.optional(),
      ...style,
    })
    .strict(),
  z.object({ id, type: z.literal("heading"), text: short(), level: z.union([z.literal(1), z.literal(2)]).default(1), align: align.default("left"), color, size: px(14, 48), ...style }).strict(),
  z.object({ id, type: z.literal("text"), html: short(20_000), align: align.default("left"), size: z.number().int().min(11).max(24).default(15), color, ...style }).strict(),
  z.object({ id, type: z.literal("image"), src: picture, alt: short(200).default(""), width: z.number().int().min(10).max(100).default(100), align: align.default("center"), link: link.default(""), radius: px(0, 40), ...style }).strict(),
  z
    .object({
      id,
      type: z.literal("button"),
      label: short(80),
      link,
      align: align.default("left"),
      color,
      textColor: color,
      full: z.boolean().default(false),
      radius: px(0, 30),
      fontSize: px(12, 22),
      shape: z.enum(["small", "medium", "large"]).optional(),
      ...style,
    })
    .strict(),
  z.object({ id, type: z.literal("banner"), eyebrow: short(80).default(""), title: short(), subtitle: short(400).default(""), align: align.default("center"), background: color, textColor: color, titleSize: px(18, 48), ...style }).strict(),
  z.object({ id, type: z.literal("details"), title: short(120).default(""), rows: z.array(z.object({ label: short(120), value: short(400) }).strict()).max(20), background: color, labelColor: color, ...style }).strict(),
  z.object({ id, type: z.literal("checklist"), title: short(120).default(""), items: z.array(short(300)).max(12), ...style }).strict(),
  z.object({ id, type: z.literal("columns"), columns: z.array(z.object({ title: short(120), text: short(600) }).strict()).min(2).max(3), ...style }).strict(),
  z.object({ id, type: z.literal("social"), align: align.default("center"), links: z.array(z.object({ label: short(40), url: link }).strict()).max(8), ...style }).strict(),
  z.object({ id, type: z.literal("signature"), closing: short(80).default("Warm regards,"), contacts: z.boolean().default(true), ...style }).strict(),
  z.object({ id, type: z.literal("divider"), color, thickness: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(1), ...style }).strict(),
  z.object({ id, type: z.literal("spacer"), height: z.number().int().min(4).max(120).default(24), ...style }).strict(),
  z.object({ id, type: z.literal("html"), html: short(50_000), ...style }).strict(),
]);

export const FONTS = {
  arial: "Arial,Helvetica,sans-serif",
  verdana: "Verdana,Geneva,sans-serif",
  trebuchet: "'Trebuchet MS',Helvetica,sans-serif",
  georgia: "Georgia,'Times New Roman',serif",
} as const;

export const designSchema = z
  .object({
    version: z.literal(1),
    settings: z
      .object({
        /** The accent: headings, buttons, panels. */
        brandColor: color,
        /** Around the email, and the email itself. */
        background: color,
        contentBackground: color,
        textColor: color,
        /** Headings, when not the brand colour; links in text. */
        headingColor: color,
        linkColor: color,
        font: z.enum(["arial", "verdana", "trebuchet", "georgia"]).default("arial"),
        /** The email's width in pixels (600 when not chosen) and its corners' rounding. */
        width: px(480, 720),
        radius: px(0, 24),
      })
      .strict(),
    blocks: z.array(blockSchema).max(80),
  })
  .strict();

export type Block = z.infer<typeof blockSchema>;
export type BlockAudience = z.infer<typeof audience>;
export type BlockType = Block["type"];
export type Design = z.infer<typeof designSchema>;
export type DesignSettings = Design["settings"];

const MUTED = "#6b7280";
const LINE = "#e5e7eb";

/** Escapes what was typed, keeping `{{fields}}` as they are for the merge. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A colour the email may use: the one given, when it is a plain hex; else the fallback. */
export function safeColor(c: string | null | undefined, fallback = "#1d4ed8"): string {
  return c && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim().toLowerCase() : fallback;
}

/** The same hue mixed with white — for soft panels. `amount` is how much white, 0–1. */
export function tint(c: string, amount: number): string {
  const n = parseInt(safeColor(c).slice(1), 16);
  const mix = (v: number) => Math.round(v + (255 - v) * amount);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => mix(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Black or white, whichever reads on this colour. */
export function onColor(c: string): string {
  const n = parseInt(safeColor(c).slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? "#111827" : "#ffffff";
}

/** The page's settings with every gap filled: the workspace's colour, white, dark text. */
export function settingsOf(design: Pick<Design, "settings">, brand: BuilderBrand) {
  const s = design.settings;
  return {
    brand: safeColor(s.brandColor, safeColor(brand.color)),
    background: safeColor(s.background, "#f3f4f6"),
    content: safeColor(s.contentBackground, "#ffffff"),
    text: safeColor(s.textColor, "#1f2937"),
    heading: safeColor(s.headingColor, safeColor(s.brandColor, safeColor(brand.color))),
    link: safeColor(s.linkColor, safeColor(s.brandColor, safeColor(brand.color))),
    font: FONTS[s.font ?? "arial"] ?? FONTS.arial,
    width: s.width ?? 600,
    radius: s.radius ?? 10,
  };
}

type Look = ReturnType<typeof settingsOf>;

const cell = (inner: string, padding = "8px 32px") => `<tr><td style="padding:${padding};">${inner}</td></tr>`;

/** A link's address, safe in an attribute: what was typed, escaped, or nothing if it isn't a link. */
function href(u: string): string {
  const t = u.trim();
  return /^(https?:\/\/|mailto:|tel:|\{\{)/i.test(t) ? esc(t) : "#";
}

const BUTTON_PADDING = { small: "8px 16px", medium: "12px 24px", large: "16px 32px" } as const;

function buttonHtml(label: string, url: string, bg: string, fg: string, font: string, full = false, alignTo = "left", shape: { radius?: number; fontSize?: number; size?: keyof typeof BUTTON_PADDING } = {}): string {
  const radius = shape.radius ?? 6;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${alignTo}" style="margin:4px ${alignTo === "center" ? "auto" : "0"};${full ? "width:100%;" : ""}"><tr><td align="center" style="background:${bg};border-radius:${radius}px;"><a href="${href(url)}" style="display:${full ? "block" : "inline-block"};padding:${BUTTON_PADDING[shape.size ?? "medium"]};font:bold ${shape.fontSize ?? 15}px/1.2 ${font};color:${fg};text-decoration:none;border-radius:${radius}px;">${esc(label)}</a></td></tr></table>`;
}

/** The address a "talk to us" button writes to: the account manager's, else the company's own. */
export function replyLink(brand: BuilderBrand, subject: string): string {
  // The subject's spaces only are encoded: its {{fields}} must stay readable to be filled in.
  return `mailto:{{ownerEmail|${brand.email ?? "hello@example.com"}}}?subject=${subject.replace(/ /g, "%20")}`;
}

/**
 * One block, as rows of the email's content table — inside a row of its own colour and spacing when it has them
 * (`bg`, `padTop`, `padBottom`), so a block's background runs edge to edge.
 */
export function blockHtml(block: Block, brand: BuilderBrand, look: Look): string {
  const rows = blockRows(block, brand, look);
  if (!block.bg && block.padTop === undefined && block.padBottom === undefined) return rows;
  return `<tr><td style="${block.bg ? `background:${safeColor(block.bg, "#ffffff")};` : ""}padding:${block.padTop ?? 0}px 0 ${block.padBottom ?? 0}px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>`;
}

/** An image for the email: its address checked, its width set for Outlook, which ignores CSS widths. */
function imageTag(src: string, alt: string, width: number, extra = ""): string {
  return `<img src="${esc(src)}" width="${width}" alt="${esc(alt)}" style="display:block;width:${width}px;max-width:100%;height:auto;border:0;${extra}">`;
}

function blockRows(block: Block, brand: BuilderBrand, look: Look): string {
  const { font, text } = look;
  const accent = look.brand;
  switch (block.type) {
    case "logo": {
      const size = block.size ?? 160;
      const src = block.src || brand.logo;
      const own = src ? imageTag(src, brand.name, size, `font:bold 20px/1.3 ${font};color:${accent};`) : `<p style="margin:0;font:bold 22px/1.3 ${font};color:${accent};">${esc(brand.name)}</p>`;
      const bar = block.bar ? `border-bottom:4px solid ${safeColor(block.barColor, accent)};` : "";
      const after = block.bar ? cell("", "8px 32px 0") : "";
      // A partner's logo beside it: ours on the left, theirs on the right, each its own size.
      if (block.partner?.src) {
        const p = block.partner;
        const theirs = imageTag(p.src, p.alt, p.width);
        const right = p.link ? `<a href="${href(p.link)}">${theirs}</a>` : theirs;
        return `<tr><td style="padding:22px 32px;${bar}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="left" valign="middle">${own}</td><td align="right" valign="middle" style="text-align:right;"><div style="display:inline-block;">${right}</div></td></tr></table></td></tr>${after}`;
      }
      const centred = block.align === "center" ? "margin:0 auto;" : block.align === "right" ? "margin:0 0 0 auto;" : "";
      const placed = src ? own.replace('style="display:block;', `style="display:block;${centred}`) : own;
      return `<tr><td align="${block.align}" style="padding:22px 32px;text-align:${block.align};${bar}">${placed}</td></tr>${after}`;
    }
    case "heading": {
      const size = block.size ?? (block.level === 1 ? 24 : 18);
      return cell(`<h${block.level} style="margin:0;font:bold ${size}px/1.3 ${font};color:${safeColor(block.color, look.heading)};text-align:${block.align};">${esc(block.text)}</h${block.level}>`);
    }
    case "text": {
      // Paragraphs and lists spaced alike in every mail client, whatever the editor wrote.
      const spaced = block.html
        .replace(/<p>/g, '<p style="margin:0 0 14px;">')
        .replace(/<(ul|ol)>/g, '<$1 style="margin:0 0 14px;padding-left:22px;">')
        .replace(/<a href=/g, `<a style="color:${look.link};" href=`);
      return cell(`<div style="font:${block.size}px/1.6 ${font};color:${safeColor(block.color, text)};text-align:${block.align};">${spaced}</div>`);
    }
    case "image": {
      if (!block.src) return cell(`<div style="padding:28px;border:1px dashed ${LINE};text-align:center;font:13px/1.4 ${font};color:${MUTED};">Choose a picture</div>`);
      const img = `<img src="${esc(block.src)}" alt="${esc(block.alt)}" width="${Math.round(((look.width - 64) / 100) * block.width)}" style="display:inline-block;width:${block.width}%;max-width:100%;height:auto;border:0;border-radius:${block.radius ?? 4}px;">`;
      return cell(`<div style="text-align:${block.align};">${block.link ? `<a href="${href(block.link)}">${img}</a>` : img}</div>`);
    }
    case "button": {
      const bg = safeColor(block.color, accent);
      return cell(buttonHtml(block.label, block.link, bg, safeColor(block.textColor, onColor(bg)), font, block.full, block.align, { radius: block.radius, fontSize: block.fontSize, size: block.shape }), "12px 32px");
    }
    case "banner": {
      const bg = safeColor(block.background, accent);
      const fg = safeColor(block.textColor, onColor(bg));
      return cell(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${bg};border-radius:8px;"><tr><td align="${block.align}" style="padding:28px 24px;">${block.eyebrow ? `<p style="margin:0 0 6px;font:bold 12px/1.4 ${font};color:${fg};opacity:.85;letter-spacing:1px;text-transform:uppercase;">${esc(block.eyebrow)}</p>` : ""}<p style="margin:0;font:bold ${block.titleSize ?? 28}px/1.25 ${font};color:${fg};">${esc(block.title)}</p>${block.subtitle ? `<p style="margin:8px 0 0;font:16px/1.5 ${font};color:${fg};">${esc(block.subtitle)}</p>` : ""}</td></tr></table>`,
        "12px 32px",
      );
    }
    case "details": {
      const rows = block.rows
        .map((r) => `<tr><td style="padding:3px 12px 3px 0;width:40%;font:14px/1.5 ${font};color:${safeColor(block.labelColor, MUTED)};vertical-align:top;">${esc(r.label)}</td><td style="padding:3px 0;font:14px/1.5 ${font};color:${text};vertical-align:top;">${esc(r.value)}</td></tr>`)
        .join("");
      return cell(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${safeColor(block.background, tint(accent, 0.93))};border:1px solid ${tint(accent, 0.8)};border-radius:8px;"><tr><td style="padding:16px 20px;">${block.title ? `<p style="margin:0 0 8px;font:bold 14px/1.4 ${font};color:${look.heading};">${esc(block.title)}</p>` : ""}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr></table>`,
        "12px 32px",
      );
    }
    case "checklist":
      return cell(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-left:4px solid ${accent};background:${tint(accent, 0.94)};padding:14px 18px;">${block.title ? `<p style="margin:0 0 8px;font:bold 15px/1.4 ${font};color:${accent};">${esc(block.title)}</p>` : ""}${block.items
          .map((i) => `<p style="margin:0 0 6px;font:15px/1.6 ${font};color:${text};">&#10003;&nbsp; ${esc(i)}</p>`)
          .join("")}</td></tr></table>`,
        "12px 32px",
      );
    case "columns": {
      const w = Math.floor(100 / block.columns.length);
      return cell(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${block.columns
          .map(
            (c) =>
              `<td valign="top" style="width:${w}%;padding:0 8px;"><p style="margin:0 0 6px;font:bold 15px/1.4 ${font};color:${accent};">${esc(c.title)}</p><p style="margin:0;font:14px/1.6 ${font};color:${text};">${esc(c.text).replace(/\n/g, "<br>")}</p></td>`,
          )
          .join("")}</tr></table>`,
        "12px 24px",
      );
    }
    case "social": {
      const links = block.links
        .filter((l) => l.label && l.url)
        .map((l) => `<a href="${href(l.url)}" style="display:inline-block;margin:0 4px 6px;padding:6px 12px;border:1px solid ${tint(accent, 0.6)};border-radius:999px;font:bold 13px/1 ${font};color:${accent};text-decoration:none;">${esc(l.label)}</a>`)
        .join("");
      return cell(`<div style="text-align:${block.align};">${links}</div>`);
    }
    case "signature": {
      const fallback = brand.name.replace(/[{}|]/g, "");
      const bits = block.contacts ? [brand.email ? `<a href="mailto:${esc(brand.email)}" style="color:${MUTED};">${esc(brand.email)}</a>` : "", brand.phone ? esc(brand.phone) : ""].filter(Boolean) : [];
      return cell(
        `<p style="margin:0;font:15px/1.6 ${font};color:${text};">${esc(block.closing)}<br><strong>{{ownerName|Team ${esc(fallback)}}}</strong><br><span style="color:${MUTED};">{{ourName}}</span></p>${bits.length ? `<p style="margin:10px 0 0;font:13px/1.6 ${font};color:${MUTED};">${bits.join(" &nbsp;&middot;&nbsp; ")}</p>` : ""}`,
        "12px 32px 28px",
      );
    }
    case "divider":
      return cell(`<div style="border-top:${block.thickness}px solid ${safeColor(block.color, LINE)};line-height:0;font-size:0;">&nbsp;</div>`, "12px 32px");
    case "spacer":
      return `<tr><td style="height:${block.height}px;line-height:${block.height}px;font-size:0;">&nbsp;</td></tr>`;
    case "html":
      return cell(block.html);
  }
}

/** A list of places as the merge reads one: trimmed, de-duplicated, comma-joined. */
const placeList = (s: string | undefined) => [...new Set((s ?? "").split(",").map((p) => p.trim()).filter(Boolean))].join(",");

/** The conditions a block's audience sets, all of which must hold — none for one everybody sees. */
export function audienceConditions(show: BlockAudience | undefined): string[] {
  if (!show) return [];
  const conditions: string[] = [];
  if (show.who === "customers") conditions.push("customer");
  if (show.who === "prospects") conditions.push("prospect");
  const cities = placeList(show.cities);
  const states = placeList(show.states);
  if (cities) conditions.push(`city=${cities}`);
  if (states) conditions.push(`state=${states}`);
  return conditions;
}

/** Who a block is kept to, in words — for the builder's canvas; null for everybody. */
export function audienceLabel(show: BlockAudience | undefined): string | null {
  if (!audienceConditions(show).length) return null;
  const who = show!.who === "customers" ? "Customers" : show!.who === "prospects" ? "Prospects" : "Anyone";
  const where = [placeList(show!.cities), placeList(show!.states)].filter(Boolean).join(" · ").replace(/,/g, ", ");
  return where ? `${who} in ${where}` : `${who} only`;
}

/** A block kept to some people: wrapped in `{{#if …}}` for each condition, nested so all must hold. */
function forAudience(block: Block, html: string): string {
  return audienceConditions(block.show).reduceRight((inner, c) => `{{#if ${c}}}\n${inner}\n{{/if}}`, html);
}

/** The whole email: the page around it, the content box, every block in order. */
export function renderDesign(design: Design, brand: BuilderBrand, title = "Email"): string {
  const look = settingsOf(design, brand);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${look.background};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${look.background};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="${look.width}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${look.width}px;background:${look.content};border:1px solid ${LINE};border-radius:${look.radius}px;font:15px/1.6 ${look.font};color:${look.text};">
${design.blocks.map((b) => forAudience(b, blockHtml(b, brand, look))).join("\n")}
${cell("", "0 0 16px")}
</table>
</td></tr></table>
</body></html>`;
}

/** Just one block, in the email's box — what the builder's canvas draws for each. */
export function renderBlockAlone(block: Block, design: Design, brand: BuilderBrand): string {
  const look = settingsOf(design, brand);
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:${look.content};}</style></head><body><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${look.content};font:15px/1.6 ${look.font};color:${look.text};">${blockHtml(block, brand, look)}</table></body></html>`;
}

// ─── Making blocks ──────────────────────────────────────────────────────────────────────────────

export const BLOCK_KINDS: { type: BlockType; label: string; hint: string }[] = [
  { type: "logo", label: "Logo", hint: "Your logo, or your name, at the top" },
  { type: "heading", label: "Heading", hint: "A title" },
  { type: "text", label: "Text", hint: "Paragraphs, bold, links, merge fields" },
  { type: "image", label: "Image", hint: "A picture, with a link if you like" },
  { type: "button", label: "Button", hint: "A link people click" },
  { type: "banner", label: "Banner", hint: "A big coloured headline" },
  { type: "details", label: "Details box", hint: "Label and value rows — a renewal's details" },
  { type: "checklist", label: "Checklist", hint: "Ticked points in a coloured box" },
  { type: "columns", label: "Columns", hint: "Two or three side by side" },
  { type: "social", label: "Social links", hint: "LinkedIn, website, WhatsApp…" },
  { type: "signature", label: "Sign-off", hint: "Regards, the account manager, contacts" },
  { type: "divider", label: "Divider", hint: "A thin line" },
  { type: "spacer", label: "Spacer", hint: "Empty space" },
  { type: "html", label: "Custom HTML", hint: "Your own HTML" },
];

/** A block in a few words — its kind and what it says — for lists of blocks. */
export function blockSummary(block: Block): string {
  const kind = BLOCK_KINDS.find((k) => k.type === block.type)?.label ?? block.type;
  const words = (s: string) => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const said =
    block.type === "heading" ? block.text
    : block.type === "text" ? words(block.html)
    : block.type === "button" ? block.label
    : block.type === "banner" ? block.title
    : block.type === "details" || block.type === "checklist" ? block.title
    : block.type === "logo" && block.partner?.src ? "with a partner's logo"
    : block.type === "image" ? block.alt
    : "";
  const short = said.length > 40 ? `${said.slice(0, 39)}…` : said;
  return short ? `${kind} — ${short}` : kind;
}

let counter = 0;
export const newBlockId = () => `b${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A new block of a kind, with words to replace. */
export function newBlock(type: BlockType): Block {
  const id = newBlockId();
  switch (type) {
    case "logo":
      return { id, type, align: "left", bar: true };
    case "heading":
      return { id, type, text: "Your heading", level: 1, align: "left" };
    case "text":
      return { id, type, html: "<p>Hi {{firstName|there}},</p><p>Write your message here.</p>", align: "left", size: 15 };
    case "image":
      return { id, type, src: "", alt: "", width: 100, align: "center", link: "" };
    case "button":
      return { id, type, label: "Find out more", link: "https://", align: "left", full: false };
    case "banner":
      return { id, type, eyebrow: "Limited-time offer", title: "Your big headline", subtitle: "A line that says more", align: "center" };
    case "details":
      return { id, type, title: "Details", rows: [{ label: "Product", value: "{{productName|Your subscription}}" }, { label: "Renews on", value: "{{expiryDate|We'll confirm}}" }] };
    case "checklist":
      return { id, type, title: "What this means for you", items: ["First point", "Second point", "Third point"] };
    case "columns":
      return { id, type, columns: [{ title: "First", text: "A line about it." }, { title: "Second", text: "A line about it." }, { title: "Third", text: "A line about it." }] };
    case "social":
      return { id, type, align: "center", links: [{ label: "Website", url: "https://" }, { label: "LinkedIn", url: "https://www.linkedin.com/company/" }] };
    case "signature":
      return { id, type, closing: "Warm regards,", contacts: true };
    case "divider":
      return { id, type, thickness: 1 };
    case "spacer":
      return { id, type, height: 24 };
    case "html":
      return { id, type, html: "<p>Your own HTML</p>" };
  }
}

/** A fresh design: logo, heading, text, button, sign-off. */
export function blankDesign(): Design {
  return {
    version: 1,
    settings: { font: "arial" },
    blocks: [newBlock("logo"), newBlock("heading"), newBlock("text"), newBlock("button"), newBlock("signature")],
  };
}

/** A design read back from storage — null when it isn't one (an older or broken value). */
export function readDesign(value: unknown): Design | null {
  const parsed = designSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
