import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { digestSecret } from "@/lib/crypto";
import type { BodyReader } from "./receive";

/**
 * The Elementor address (owner, 27 Oct 2026): a website on WordPress with an Elementor form pastes one URL into the
 * form's Webhook action, and each enquiry is a lead — no code, no plugin.
 *
 *   · **The key is in the address**, since Elementor's webhook sends no header: the key ID and a token made from it
 *     with the workspace's own digest key. The token is kept nowhere and can't be turned back into the key's secret,
 *     so the Basic secret never sits in a URL; revoking the key ends the address too.
 *   · **Fields by what they are, not their names.** Elementor sends each field under its label ("Your Name",
 *     "Mobile Number"), or — with Advanced data on — with its ID, label and type. Each is read by its type, then
 *     its ID or label: an email field is the email, a tel field the phone, "Full name" or "First"+"Last" the name.
 *     Anything else the form asked is kept in the message as "Label: value", so nothing the visitor wrote is lost.
 *   · **A field with no label** comes as "No Label <its ID>" (owner, 9 Nov 2026: a form's "No Label name" left the lead
 *     named after its email). That's Elementor's placeholder, not a label: the field is read by its ID alone.
 */

const PATH = "/api/v1/leads/elementor";
const tokenOf = async (keyId: string, secretDigest: string) => (await digestSecret(`elementor:${keyId}:${secretDigest}`)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);

/** The address a key's Elementor form posts to, after the workspace's own host. */
export async function elementorPath(key: { keyId: string; secretDigest: string }): Promise<string> {
  return `${PATH}/${key.keyId}.${await tokenOf(key.keyId, key.secretDigest)}`;
}

/** The key ID an address names, or null when it isn't one. */
export function elementorKeyId(segment: string): string | null {
  const m = /^(lck_[0-9a-f]{20})\.([A-Za-z0-9_-]{32})$/.exec(segment);
  return m ? m[1]! : null;
}

/** Whether an address's token is the one this key makes — in constant time. */
export async function elementorTokenMatches(segment: string, key: { keyId: string; secretDigest: string }): Promise<boolean> {
  const given = Buffer.from(segment.split(".")[1] ?? "");
  const wanted = Buffer.from(await tokenOf(key.keyId, key.secretDigest));
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

type Field = { id: string; label: string; type: string; value: string };

/** What Elementor adds of its own in the simple format — not the visitor's words. */
const META = new Set(["date", "time", "page url", "user agent", "remote ip", "powered by", "form id", "form name"]);
const words = (s: string) => s.toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
/** Elementor's title for a field left without a label, and the field ID it carries. */
const NO_LABEL = /^no label\s+(.+)$/i;

/** Elementor's webhook body as fields, either format; and its page address when it sent one. */
export function elementorFields(raw: string): { fields: Field[]; pageUrl: string } {
  const params = new URLSearchParams(raw);
  const advanced = new Map<string, Partial<Field>>();
  const flat: Field[] = [];
  let pageUrl = "";
  for (const [name, value] of params) {
    const field = /^fields\[([^\]]+)\]\[(id|title|type|value)\]$/.exec(name);
    if (field) {
      const f = advanced.get(field[1]!) ?? { id: field[1]! };
      if (field[2] === "title") f.label = value;
      else if (field[2] === "type") f.type = value;
      else if (field[2] === "value") f.value = value;
      advanced.set(field[1]!, f);
      continue;
    }
    if (/^meta\[page_url\]\[value\]$/.test(name) || words(name) === "page url") {
      pageUrl = value;
      continue;
    }
    if (/^(form|meta)\[/.test(name) || META.has(words(name))) continue;
    const unlabeled = NO_LABEL.exec(name.trim());
    flat.push(unlabeled ? { id: unlabeled[1]!.trim(), label: "", type: "", value } : { id: name, label: name, type: "", value });
  }
  const fields = advanced.size ? [...advanced.values()].map((f) => ({ id: f.id ?? "", label: f.label && NO_LABEL.test(f.label.trim()) ? "" : (f.label ?? f.id ?? ""), type: f.type ?? "", value: f.value ?? "" })) : flat;
  return { fields: fields.filter((f) => f.value.trim()), pageUrl };
}

/** Which lead field one of the form's fields is, by its type, then its ID or label. */
function roleOf(f: Field): string | null {
  const t = f.type.toLowerCase();
  if (t === "email") return "email";
  if (t === "tel") return "phone";
  for (const text of [words(f.id), words(f.label)]) {
    if (/^utm (source|medium|campaign)$/.test(text)) return text.replace(" ", "_");
    if (/e ?mail/.test(text)) return "email";
    if (/phone|mobile|whatsapp|contact (no|number)|^tel/.test(text)) return "phone";
    if (/^first ?name$|^fname$/.test(text)) return "first";
    if (/^(last ?name|surname|lname)$/.test(text)) return "last";
    if (/company|organi[sz]ation|business name|firm/.test(text)) return "company";
    if (/designation|job ?title|position/.test(text)) return "designation";
    if (/^(your |full |contact )?name$/.test(text)) return "name";
    if (/pin ?code|zip|postal/.test(text)) return "pincode";
    if (/^city|town/.test(text)) return "city";
    if (/^state/.test(text)) return "state";
    if (/^country/.test(text)) return "country";
    if (/message|comment|enquiry|inquiry|requirement|query|details|description|how can we help/.test(text)) return "message";
  }
  return t === "textarea" ? "message" : null;
}

/** Elementor's webhook body as the lead payload's fields. */
export const readElementorBody: BodyReader = (raw, type) => {
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data") && type) {
    return NextResponse.json({ ok: false, error: "Elementor's webhook sends a form; this address reads nothing else." }, { status: 415 });
  }
  const { fields, pageUrl } = elementorFields(raw);
  const got: Record<string, string> = {};
  const rest: string[] = [];
  for (const f of fields) {
    const role = roleOf(f);
    if (role && !got[role]) got[role] = f.value.trim();
    else rest.push(`${f.label || f.id}: ${f.value.trim()}`);
  }
  const name = got.name || [got.first, got.last].filter(Boolean).join(" ") || got.email || got.phone || "Website enquiry";
  const message = [got.message, ...rest].filter(Boolean).join("\n");
  const body: Record<string, unknown> = { name, source: "WEBSITE" };
  for (const k of ["email", "phone", "company", "designation", "city", "state", "pincode", "country", "utm_source", "utm_medium", "utm_campaign"]) if (got[k]) body[k] = got[k];
  if (message) body.message = message;
  if (/^https?:\/\//i.test(pageUrl)) body.page_url = pageUrl;
  return body;
};
