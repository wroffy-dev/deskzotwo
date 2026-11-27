import type { LeadCaptureKey } from "@prisma/client";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { intakeLead, leadPayloadSchema, readFormBody } from "./intake";
import { MAX_BODY_BYTES, RATE_LIMIT_PER_MINUTE } from "./spec";
import { linkVisitorToContact } from "@/lib/inbox/activity";
import { notMigratedYet } from "@/lib/not-migrated";
import { leadCapacityError } from "@/lib/leads/limits";
import { LeadRuleRefused } from "@/lib/leads/intake-owner";
import { enquiryRef, holdEnquiry, holdsWebsiteEnquiries } from "./review";

/**
 * A website's enquiry, once its key is known (src/app/api/v1/leads, and the Elementor address beside it): the size
 * limit, the minute's limit, the body read into the lead payload, and the lead made — the same for every way in.
 * Only how the body is read differs: `read` turns the raw text and its content type into the payload's fields, or
 * answers itself.
 */
export type BodyReader = (raw: string, contentType: string) => Record<string, unknown> | NextResponse;

/** The API's own body: JSON, or a form whose names are the payload's. */
export const readApiBody: BodyReader = (raw, type) => {
  try {
    if (type.includes("application/json")) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return parsed as Record<string, unknown>;
    }
    if (type.includes("application/x-www-form-urlencoded")) {
      // A form cannot send an array or an object: products come as "SKU1,SKU2", the workspace's own
      // fields as custom_fields[tower]=B.
      return readFormBody(raw);
    }
    return NextResponse.json({ ok: false, error: "Send application/json or application/x-www-form-urlencoded." }, { status: 415 });
  } catch {
    return NextResponse.json({ ok: false, error: "The body is not valid JSON." }, { status: 400 });
  }
};

export async function receiveLead(request: Request, key: LeadCaptureKey, read: BodyReader): Promise<NextResponse> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: `The body is over ${MAX_BODY_BYTES / 1024} KB.` }, { status: 413 });
  }

  /**
   * The minute's limit, counted atomically (owner, 12 Nov 2026 — Phase 4 lead limits, audit M-17 and H.6.6): every
   * request that gets this far is counted on the key in one `UPDATE … RETURNING`, as an API key's calls are
   * (`countCall`, src/lib/api/handler.ts) — so sixty sent at once can't all read "59" and all pass, and a request that
   * fails, is held for review, or is a duplicate counts as much as one that made a lead. The records made in the
   * minute are still counted below too; they only ever stop a key sooner.
   */
  if ((await countSubmission(key.id)) > RATE_LIMIT_PER_MINUTE) return tooMany();
  const since = new Date(Date.now() - 60_000);
  /**
   * Without leads in the plan (owner, 14 Oct 2026) an enquiry makes only a company and contact, which
   * don't record the key — so the contacts its issuer was credited with stand in. A key with no issuer
   * is counted against every contact made in the minute, which only ever stops it sooner.
   */
  const recent = (await moduleAvailableForTenant("leads"))
    ? (await db.lead.count({ where: { captureKeyId: key.id, createdAt: { gt: since } } })) + (await db.websiteEnquiry.count({ where: { captureKeyId: key.id, receivedAt: { gt: since } } }).catch(() => 0))
    : await db.contact.count({ where: { createdAt: { gt: since }, ...(key.createdById ? { createdByUserId: key.createdById } : {}) } });
  if (recent >= RATE_LIMIT_PER_MINUTE) return tooMany();

  // Read as text first, so the size limit holds even when Content-Length was missing or wrong.
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: `The body is over ${MAX_BODY_BYTES / 1024} KB.` }, { status: 413 });
  }

  const body = read(raw, (request.headers.get("content-type") ?? "").toLowerCase());
  if (body instanceof NextResponse) return body;

  const payload = leadPayloadSchema.safeParse(body);
  if (!payload.success) {
    const fields: Record<string, string> = {};
    for (const issue of payload.error.issues) fields[String(issue.path[0] ?? "body")] ??= issue.message;
    return NextResponse.json({ ok: false, error: payload.error.issues[0]?.message ?? "Invalid request", fields }, { status: 400 });
  }

  // Counted for the settings page; not part of the decision above, which counts leads created.
  await db.leadCaptureKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(), useCount: { increment: 1 } } });

  // Held for review, where the admin chose it (src/lib/lead-capture/review.ts): nothing is made until somebody accepts it.
  if (await holdsWebsiteEnquiries()) {
    try {
      const held = await holdEnquiry(key, payload.data);
      return NextResponse.json(
        { ok: true, held: true, enquiry: { reference: enquiryRef(held.seq) }, duplicate: held.again, message: "Received. We'll be in touch." },
        { status: held.again ? 200 : 202 },
      );
    } catch (error) {
      console.error("holding a website enquiry failed", error);
      return NextResponse.json({ ok: false, error: "The enquiry could not be saved. Please try again." }, { status: 500 });
    }
  }

  try {
    const started = new Date();
    const result = await intakeLead(key, payload.data);
    // Website activity: this browser's visits are this person's from here on (owner, 6 Nov 2026).
    if (payload.data.visitor_id) {
      const contactId =
        result.status === "contact"
          ? result.contactId
          : result.status === "created" || result.status === "duplicate"
            ? (await db.lead.findUnique({ where: { id: result.leadId }, select: { contactId: true } }))?.contactId
            : null;
      // Security audit round three, 14 Nov 2026 (low): typing an existing customer's email into a form tied this browser
      // to them. Only a contact this submission made, or one still unconfirmed (src/lib/contacts/unconfirmed.ts), is
      // linked; a contact already on file is somebody the visitor only claims to be.
      const linkable = contactId ? await mayLinkVisitor(contactId, started) : false;
      if (linkable) await linkVisitorToContact(payload.data.visitor_id, contactId, "form").catch((err) => console.error("visitor link failed", err instanceof Error ? err.message : ""));
    }
    if (result.status === "reseller") {
      return NextResponse.json(
        { ok: true, routed: "reseller", message: "Received. This company is looked after by one of our partners; the enquiry has been passed to them." },
        { status: 202 },
      );
    }
    if (result.status === "contact") {
      return NextResponse.json(
        { ok: true, routed: "contact", message: "Received. The company and contact were saved; no lead was created.", not_saved: result.notSaved },
        { status: 202 },
      );
    }
    if (result.status === "duplicate") {
      return NextResponse.json({ ok: true, lead: { id: result.leadId, reference: result.reference }, duplicate: true }, { status: 200 });
    }
    // `not_saved` always, empty or not, so a website's code can read it without checking it is there.
    return NextResponse.json(
      { ok: true, lead: { id: result.leadId, reference: result.reference }, duplicate: false, assigned: result.assigned, not_saved: result.notSaved },
      { status: 201 },
    );
  } catch (error) {
    /**
     * Lead limits (owner, 12 Nov 2026 — Phase 4, audit H.6.5): a lead whose owner is full is still made, with nobody —
     * so the only refusals are the plan's cap, a 429 like the minute's, and an assignment rule that refuses a lead
     * when its people are all full, a 422. Nothing was made for either; the website may send it again later.
     */
    const full = leadCapacityError(error);
    if (full) return NextResponse.json({ ok: false, error: full.scope === "workspace" ? full.message : "Nobody is free to take this lead just now. Try again later." }, { status: 429 });
    if (error instanceof LeadRuleRefused) {
      return NextResponse.json({ ok: false, error: "Nobody is free to take this lead just now, and this workspace's assignment rules refuse a lead rather than leave it with nobody. Try again later." }, { status: 422 });
    }
    console.error("lead capture failed", error);
    return NextResponse.json({ ok: false, error: "The lead could not be saved. Please try again." }, { status: 500 });
  }
}

/** A contact made by the submission that began at `since`, or one not yet confirmed by staff — never one already known. */
async function mayLinkVisitor(contactId: string, since: Date): Promise<boolean> {
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { createdAt: true } });
  if (!contact) return false;
  // A few seconds' grace: the row's time is the database's clock, `since` this server's.
  if (contact.createdAt.getTime() >= since.getTime() - 5_000) return true;
  try {
    return (await db.contact.count({ where: { id: contactId, unconfirmedFrom: { not: null } } })) > 0;
  } catch (err) {
    // A workspace without the column yet has no unconfirmed contacts.
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

function tooMany(): NextResponse {
  return NextResponse.json(
    { ok: false, error: `More than ${RATE_LIMIT_PER_MINUTE} leads a minute from this key. Try again shortly.` },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}

/**
 * This request counted on its key: the window's count after it. A window opens with the first request and lasts a
 * minute. 0 where the workspace hasn't the columns yet (20261213100000_lead_intake_guards) — the records' count stands.
 */
export async function countSubmission(keyId: string): Promise<number> {
  try {
    const rows = await db.$queryRaw<{ n: number }[]>`
      UPDATE "lead_capture_keys" SET
        "rateWindowCount" = CASE WHEN "rateWindowStart" > (now() - interval '60 seconds') THEN "rateWindowCount" + 1 ELSE 1 END,
        "rateWindowStart" = CASE WHEN "rateWindowStart" > (now() - interval '60 seconds') THEN "rateWindowStart" ELSE now() END
      WHERE "id" = ${keyId}
      RETURNING "rateWindowCount"::int AS n`;
    return Number(rows[0]?.n ?? 0);
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}
