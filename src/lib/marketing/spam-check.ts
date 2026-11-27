/**
 * Before an email goes out, what a spam filter or a busy reader would hold against it (owner, 1 Nov 2026 — the gaps
 * against Mailchimp, Brevo, Zoho Campaigns). Pure and client-safe: the subject and the HTML in, a verdict and each
 * finding out — the words filters punish, shouting, too many images for the words, a link shortener, no unsubscribe,
 * a size Gmail clips. A guide, not a promise: no filter publishes its rules.
 */

export type SpamFinding = { level: "high" | "medium" | "low"; message: string };
export type SpamVerdict = { rating: "good" | "fair" | "poor"; findings: SpamFinding[] };

/** Phrases filters have long scored against, in English and the Hinglish salespeople reach for. */
const TRIGGERS = [
  "100% free", "act now", "apply now", "as seen on", "buy now", "cash bonus", "click here", "congratulations", "double your",
  "earn money", "extra income", "free gift", "free money", "guaranteed", "limited time only", "lowest price", "make money",
  "no catch", "no cost", "no obligation", "once in a lifetime", "order now", "risk-free", "risk free", "special promotion",
  "this is not spam", "urgent", "winner", "you have been selected", "you won", "dear friend", "100% satisfied", "best price guaranteed",
];

const SHORTENERS = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rb\.gy|shorturl\.at)\//i;

/** The words of an HTML email, without tags, styles or scripts. */
export function visibleText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The hidden preview line Deskzo puts first in a composed email — what the inbox shows after the subject. */
export function preheaderOf(html: string): string | null {
  const m = html.match(/<div style="display:none;max-height:0[^"]*">([^<]*)<\/div>/i);
  return m?.[1]?.trim() || null;
}

/** The line an inbox shows after the subject: the preview text, else the email's first words. */
export function inboxSnippet(html: string, length = 110): string {
  const text = preheaderOf(html) ?? visibleText(html);
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

export function checkSpam(input: { subject: string | null; html: string; preheader?: string | null }): SpamVerdict {
  const findings: SpamFinding[] = [];
  const preheader = input.preheader === undefined ? preheaderOf(input.html) : input.preheader;
  const subject = (input.subject ?? "").trim();
  const text = visibleText(input.html);
  const words = text.split(/\s+/).filter(Boolean).length;
  const lower = `${subject} ${text}`.toLowerCase();

  // ── The subject ─────────────────────────────────────────────────────────────────────────
  if (!subject) findings.push({ level: "high", message: "There's no subject line." });
  else {
    if (subject.length > 70) findings.push({ level: "low", message: `The subject is ${subject.length} characters — phones show about 40. Put the point first.` });
    const letters = subject.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 8 && letters === letters.toUpperCase()) findings.push({ level: "high", message: "The subject is in capitals — it reads as shouting, and filters agree." });
    if (/!{2,}/.test(subject) || (subject.match(/!/g) ?? []).length >= 3) findings.push({ level: "medium", message: "Several exclamation marks in the subject." });
    if (/\$\$|₹₹|%\s*off.*!/i.test(subject)) findings.push({ level: "medium", message: "Money signs or a discount shouted in the subject." });
  }

  // ── The words ───────────────────────────────────────────────────────────────────────────
  const hits = TRIGGERS.filter((t) => lower.includes(t));
  if (hits.length >= 3) findings.push({ level: "high", message: `Phrases filters punish: ${hits.slice(0, 5).map((h) => `“${h}”`).join(", ")}.` });
  else if (hits.length) findings.push({ level: "medium", message: `A phrase filters punish: ${hits.map((h) => `“${h}”`).join(", ")}.` });
  const shouted = (text.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w) => !/^(HTTPS?|GST|GSTIN|PAN|CRM|ERP|INR|USD|AMC|IST|PDF|FAQ|ASAP)$/.test(w));
  if (shouted.length >= 6) findings.push({ level: "medium", message: `${shouted.length} words in capitals in the body.` });

  // ── Images and links ────────────────────────────────────────────────────────────────────
  const images = (input.html.match(/<img\b/gi) ?? []).length;
  const noAlt = (input.html.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) ?? []).length;
  if (images > 0 && words < 50) findings.push({ level: "high", message: `${images} image${images === 1 ? "" : "s"} and only ${words} words — an email that's mostly pictures looks like spam, and says nothing while images are off.` });
  else if (images > 0 && words / images < 25) findings.push({ level: "medium", message: "A lot of images for the words around them." });
  if (noAlt > 0) findings.push({ level: "low", message: `${noAlt} image${noAlt === 1 ? " has" : "s have"} no alt text — what readers see while images are off.` });
  const links = [...input.html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
  if (links.some((l) => SHORTENERS.test(l))) findings.push({ level: "high", message: "A link shortener (bit.ly and the like) — spammers hide behind them, so filters distrust them. Link to the page itself." });
  if (links.length > 25) findings.push({ level: "low", message: `${links.length} links — more than most readers want to choose between.` });
  if (!/unsubscribe/i.test(input.html) && !/\{\{\s*unsubscribeUrl/i.test(input.html)) findings.push({ level: "high", message: "No unsubscribe link — every marketing email needs one, and Gmail and Yahoo refuse bulk mail without it." });

  // ── Size ────────────────────────────────────────────────────────────────────────────────
  const kb = Math.round(new TextEncoder().encode(input.html).length / 1024);
  if (kb > 100) findings.push({ level: "medium", message: `${kb} KB of HTML — Gmail cuts emails over about 100 KB, and hides the rest (the footer and unsubscribe link with it).` });
  if (words > 0 && words < 20 && images === 0) findings.push({ level: "low", message: "Very few words — say a little more about why they're getting it." });
  if (!preheader?.trim()) findings.push({ level: "low", message: "No preview text: the inbox shows the email's first words instead — often “View in browser”." });

  const high = findings.filter((f) => f.level === "high").length;
  const medium = findings.filter((f) => f.level === "medium").length;
  return { rating: high > 0 || medium >= 3 ? "poor" : medium > 0 ? "fair" : "good", findings };
}

/** Where a recipient's mail lives, from their address — for the report by mailbox provider. */
export function mailboxProvider(email: string | null | undefined): "Gmail" | "Outlook" | "Yahoo" | "Apple" | "Rediffmail" | "Company mail" {
  const domain = email?.split("@")[1]?.toLowerCase() ?? "";
  if (/^(gmail\.com|googlemail\.com)$/.test(domain)) return "Gmail";
  if (/^(outlook\.|hotmail\.|live\.|msn\.com)/.test(domain)) return "Outlook";
  if (/^(yahoo\.|ymail\.com|rocketmail\.com)/.test(domain)) return "Yahoo";
  if (/^(icloud\.com|me\.com|mac\.com)$/.test(domain)) return "Apple";
  if (/^rediffmail\.com$/.test(domain)) return "Rediffmail";
  return "Company mail";
}
