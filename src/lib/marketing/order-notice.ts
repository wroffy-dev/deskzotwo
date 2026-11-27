import type { ConsentStatus, Prisma } from "@prisma/client";
import { notMigratedYet } from "@/lib/not-migrated";
import { db } from "@/lib/db";
import { domainAndParents, domainCovers } from "@/lib/mail-block-rules";
import { STILL_THERE } from "@/lib/contacts/left";
import { unconfirmedAmong } from "@/lib/contacts/unconfirmed";
import { toPlain } from "@/lib/serialize";
import { canSend, type RecipientState } from "@/lib/marketing/suppression";
import { render } from "@/lib/marketing/merge";
import { renewalGroup } from "@/lib/subscriptions/proration";
import { getTicketSlaStatus } from "@/lib/tickets";
import { daysOverdue } from "@/lib/receivables";
import {
  marketingSettings,
  mergeValuesFor,
  newToken,
  sendQueued,
  subscriptionMergeValues,
} from "@/lib/marketing/pipeline";
import { NOTICES, NOTICE_MESSAGE_CLASS, daysLeftPhrase, noticeHeldBack, type NoticeKind } from "@/lib/marketing/customer-notices";
import { formatCurrency } from "@/lib/utils";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatOrderId } from "@/lib/order-id";
import { computeOrderFinancials } from "@/lib/orders/financials";
import { fillSubscriptions, markSubscriptions, sameDayValues, subscriptionsTable, type SameDaySubscription } from "@/lib/subscriptions/same-day";
import { countsAsOptOut } from "@/lib/marketing/topics";
import { composeEmail, escapeHtml } from "@/lib/marketing/html";
import { autoTemplateFor } from "@/lib/marketing/auto-notice-template";
import { expandWidgets } from "@/lib/marketing/email-widgets";
import { contactMasker, maskContactRows } from "@/lib/contacts/masking";
import { contactRedactor } from "@/lib/contacts/redaction";
import type { ActionResult } from "@/actions/company";

/**
 * Telling a customer something about an order they already have, by hand.
 *
 * Server-only rather than a `"use server"` module, for the usual two reasons: every export in one
 * of those is a client-callable endpoint, and the session check belongs in the action that wraps
 * this rather than buried in the middle of it. It also means a script can exercise the real code.
 *
 * Two things this gets right that are easy to get wrong:
 *
 *   · **On a reseller's order the notice goes to the reseller.** The renewals list shows the end
 *     customer's name because the seats are theirs, but the relationship — and the renewal —
 *     belongs to the reseller. Mailing the end customer would go round our own partner, and they
 *     are hard do-not-contact anyway.
 *   · It is **transactional**. A notice that a service you pay for is about to lapse is not an
 *     offer, so an unsubscribe from marketing does not silence it — while a bounce, a complaint or
 *     a reseller-managed company still does.
 */
/** The subscription, its co-terminating addons, and everything the merge fields need. */
async function loadSubscription(companyProductId: string) {
  const product = await db.companyProduct.findUnique({
    where: { id: companyProductId },
    include: {
      item: { select: { name: true } },
      company: {
        select: {
          id: true,
          name: true,
          managedByResellerId: true,
          owner: { select: { name: true, email: true } },
        },
      },
      endCustomer: { select: { id: true, name: true } },
      addons: {
        where: { orderStatus: { not: "CANCELLED" } },
        select: { id: true, quantity: true, unitPrice: true, fullTermUnitPrice: true, startDate: true },
      },
    },
  });
  if (!product) return null;

  const group = renewalGroup([
    {
      id: product.id,
      quantity: product.quantity,
      unitPrice: product.unitPrice ? Number(product.unitPrice) : null,
      fullTermUnitPrice: product.fullTermUnitPrice ? Number(product.fullTermUnitPrice) : null,
      startDate: product.startDate,
      isAddon: false,
    },
    ...product.addons.map((a) => ({
      id: a.id,
      quantity: a.quantity,
      unitPrice: a.unitPrice ? Number(a.unitPrice) : null,
      fullTermUnitPrice: a.fullTermUnitPrice ? Number(a.fullTermUnitPrice) : null,
      startDate: a.startDate,
      isAddon: true,
    })),
  ]);

  return { product, group };
}

/**
 * Who we could send this to, and what would happen to each of them.
 *
 * The verdict is worked out *before* anybody presses send, so the dialog can show "this one will
 * bounce" rather than reporting it afterwards.
 *
 * `viewerId`, who is looking: each contact's name, address and number as their contacts policy shows a contact in a list
 * (owner, 5 Nov 2026 — Phase 3 masking fixes; src/lib/contacts/masking.ts) — the dialog's list. The verdicts are worked
 * out on the real values first, and a send asks again without a viewer and goes to the real address, by contact id.
 */
export async function resolveNoticeRecipients(companyProductId: string, kind: NoticeKind = "RENEWAL", viewerId?: string) {
  const notice = NOTICES[kind];
  const loaded = await loadSubscription(companyProductId);
  if (!loaded) return null;
  const { product, group } = loaded;

  // Whoever we bill is whoever we write to. On a reseller's order that is the reseller, even though
  // the list shows the end customer's name.
  const recipientCompanyId = product.companyId;
  const [contacts, settings, templates] = await Promise.all([
    db.contact.findMany({
      where: { companyId: recipientCompanyId, ...STILL_THERE },
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        designation: true,
        isPrimary: true,
        emailStatus: true,
        emailCheckedValue: true,
      },
    }),
    marketingSettings(),
    db.marketingTemplate.findMany({
      where: { active: true, channel: "EMAIL", topic: notice.topic },
      orderBy: { name: "asc" },
      select: { id: true, name: true, format: true },
    }),
  ]);

  const addresses = contacts.map((c) => c.email?.trim().toLowerCase()).filter((e): e is string => !!e);
  // A domain blocked covers its subdomains (src/lib/mail-block-rules.ts): ask for the parents too.
  const domains = [...new Set(addresses.flatMap((a) => domainAndParents(a.split("@")[1] ?? "")))];
  const now = new Date();

  // A renewal reminder is a reminder: somebody who unticked renewal reminders, or unsubscribed from
  // everything, isn't sent one (owner, 18 Oct 2026). A confirmation of what they bought always goes.
  const optOuts = kind === "RENEWAL";
  const [suppressions, feedback, invoices, tickets, clock, consents] = await Promise.all([
    db.suppression.findMany({
      where: {
        OR: [
          { scope: "EMAIL", value: { in: addresses } },
          { scope: "CONTACT", value: { in: contacts.map((c) => c.id) } },
          { scope: "COMPANY", value: recipientCompanyId },
          { scope: "DOMAIN", value: { in: domains } },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      select: { scope: true, value: true, reason: true },
    }),
    db.feedbackRequest.count({
      where: { companyId: recipientCompanyId, response: { rating: { lte: 3 }, acknowledgedAt: null } },
    }),
    db.tradeDocument.findMany({
      where: {
        companyId: recipientCompanyId,
        docType: "INVOICE",
        status: { in: ["ISSUED", "PARTIALLY_PAID", "ACCEPTED"] },
        dueDate: { lt: now },
      },
      select: { dueDate: true, issueDate: true },
    }),
    db.ticket.findMany({
      where: { companyId: recipientCompanyId, status: { notIn: ["RESOLVED", "CLOSED"] } },
      select: { priority: true, status: true, createdAt: true },
    }),
    workspaceClock(),
    optOuts
      ? db.contactConsent.findMany({ where: { contactId: { in: contacts.map((c) => c.id) }, channel: "EMAIL", topic: notice.topic }, select: { contactId: true, status: true, source: true, withdrawnAt: true } })
      : Promise.resolve([] as { contactId: string; status: ConsentStatus; source: string; withdrawnAt: Date | null }[]),
  ]);
  // Only a turning-off counts (src/lib/marketing/topics.ts): a reminder needs no opt-in.
  const consentBy = new Map(consents.filter(countsAsOptOut).map((c) => [c.contactId, c.status]));
  // R2-14: who a website form added and staff haven't confirmed — badged in the dialog, left out of what goes by itself.
  const unconfirmed = await unconfirmedAmong(contacts.map((c) => c.id));

  const overdue = invoices.reduce((worst, i) => Math.max(worst, daysOverdue(i.dueDate, i.issueDate, now)), 0);
  const breached = tickets.filter((t) => getTicketSlaStatus(t.priority, t.status, t.createdAt, clock, now).key === "overdue").length;

  const rows = contacts.map((contact) => {
    const address = contact.email?.trim().toLowerCase() ?? null;
    const domain = address?.split("@")[1] ?? null;
    const state: RecipientState = {
      company: { managedByResellerId: product.company.managedByResellerId },
      contact: {
        email: contact.email,
        phone: contact.phone,
        emailStatus: contact.emailStatus,
        emailCheckedValue: contact.emailCheckedValue,
      },
      suppressions: suppressions
        .filter(
          (s) =>
            (s.scope === "EMAIL" && address !== null && s.value === address) ||
            (s.scope === "CONTACT" && s.value === contact.id) ||
            (s.scope === "COMPANY" && s.value === recipientCompanyId) ||
            (s.scope === "DOMAIN" && domainCovers(s.value, domain)),
        )
        .map((s) => ({ reason: s.reason })),
      // Only a reminder asks: whether they opted out of its topic.
      consent: optOuts && consentBy.has(contact.id) ? { status: consentBy.get(contact.id)! } : null,
      signals: {
        unansweredFeedback: feedback,
        daysOverdue: overdue > 0 ? overdue : null,
        breachedTickets: breached,
        sentInLastWeek: 0,
      },
    };

    const verdict = canSend(state, {
      messageClass: NOTICE_MESSAGE_CLASS,
      channel: "EMAIL",
      topic: notice.topic,
      limits: settings.limits,
      optOuts,
    });

    return {
      ...contact,
      canReceive: verdict.ok,
      blockedBecause: verdict.ok ? null : verdict.detail,
      unconfirmed: unconfirmed.has(contact.id),
    };
  });

  // R2-14: the unconfirmed after everyone else, so a sender taking the first of the list by itself takes a confirmed one.
  if (unconfirmed.size) rows.sort((a, b) => Number(a.unconfirmed) - Number(b.unconfirmed));
  // The dialog's list, as the person looking may see it; the rows' own shape either way, for the senders below.
  const listed: typeof rows = viewerId ? await maskContactRows(viewerId, "list", rows) : rows;

  return toPlain({
    kind,
    title: notice.title,
    buttonLabel: notice.buttonLabel,
    footnote: notice.footnote,
    orderStatus: product.orderStatus,
    /** A "your order is ready", or "your renewal is confirmed", that goes out too early is unrecoverable. */
    canAnnounce: noticeHeldBack(kind, product.orderStatus) === null,
    heldBack: noticeHeldBack(kind, product.orderStatus),
    subscription: {
      id: product.id,
      orderSeq: product.orderSeq,
      poNumber: product.poNumber,
      fulfilledAt: product.fulfilledAt,
      itemName: product.item.name,
      endDate: product.endDate,
      quantity: group.totalQuantity,
      renewalValue: group.renewalValue,
      addonCount: group.addonCount,
    },
    /** Who the mail actually goes to — the reseller on a reseller's order. */
    recipientCompany: { id: product.company.id, name: product.company.name },
    /** Whose seats they are, when that differs. Shown so nobody thinks the list is wrong. */
    endCustomer: product.endCustomer,
    viaReseller: product.endCustomerId !== null,
    contacts: listed,
    templates,
  });
}

/** One person's email as it would go: who to, copied to whom, the subject and the words. */
export type NoticePreview = { to: { name: string; email: string }; cc: string[]; subject: string; text: string; /** A designed template's email as it will look; null for a text one. */ html: string | null; others: number; skipped: { name: string; reason: string }[] };

/**
 * The email `queueCustomerNotice` would send the first person it can, built the same way — nothing written, nothing sent.
 *
 * Shown to whoever asks for it (`sentByUserId`, the screen's person): who it goes to, and its words wherever they quote
 * the people ticked — "Dear {{name}}", an address typed into the note — as their contacts policy shows a contact in a
 * list (owner, 5 Nov 2026 — Phase 3 masking fixes). The email itself goes out as built.
 */
export async function previewCustomerNotice(input: Omit<Parameters<typeof queueCustomerNotice>[0], "preview">): Promise<ActionResult<NoticePreview>> {
  const got: { shown: NoticePreview | null; people: NoticePerson[] } = { shown: null, people: [] };
  const run = await queueCustomerNotice({
    ...input,
    preview: (p, people) => {
      got.shown = p;
      got.people = people;
    },
  });
  if (got.shown) return { ok: true, data: input.sentByUserId ? await previewSeenBy(input.sentByUserId, got.shown, got.people) : got.shown };
  return run.ok ? { ok: false, error: "Nobody selected can be sent to." } : run;
}

type NoticePerson = { id: string; name: string; email: string | null; phone: string | null };

/** A preview as one person may see it — see `previewCustomerNotice`. Best-effort, as every redaction is (audit L-8). */
async function previewSeenBy(userId: string, preview: NoticePreview, people: NoticePerson[]): Promise<NoticePreview> {
  const m = await contactMasker(userId, "list", people.map((p) => p.id));
  if (!m.active) return preview;
  return people.reduce((shown, p) => contactRedactor(m, p.id, [["name", p.name], ["email", p.email], ["phone", p.phone]]).deep(shown), preview);
}

export async function queueCustomerNotice(input: {
  companyProductId: string;
  contactIds: string[];
  kind?: NoticeKind;
  /** Absolute, for the unsubscribe link. Passed in because a lib has no request to read. */
  origin: string;
  templateId?: string;
  /** A line from whoever is sending it, put above the standard wording. */
  note?: string;
  /** Who pressed send — kept on each message for the mail log. */
  sentByUserId?: string;
  /**
   * Copied to (owner, 3 Nov 2026): the sender, the account manager, any address typed — on the first person's email
   * only, so each copy arrives once however many people it goes to.
   */
  cc?: string[];
  /**
   * The customer's subscriptions renewing the same day, this one first, told in this one email (owner, 3 Nov 2026 —
   * src/lib/subscriptions/same-day.ts). Absent, it is about this subscription alone.
   */
  together?: SameDaySubscription[];
  /**
   * Preview (owner, 3 Nov 2026 — "mail preview option here"): handed the first person's email exactly as it would go,
   * and nothing is written or sent — with the people ticked, so a preview can be masked for who looks at it.
   */
  preview?: (shown: NoticePreview, people: NoticePerson[]) => void;
}): Promise<ActionResult<{ sent: number; failed: number; skipped: { name: string; reason: string }[]; product: { id: string; itemName: string; companyId: string; companyName: string } }>> {  if (input.contactIds.length === 0) return { ok: false, error: "Pick at least one person to send it to." };

  const loaded = await loadSubscription(input.companyProductId);
  if (!loaded) return { ok: false, error: "That subscription no longer exists." };
  const { product, group } = loaded;

  const kind = input.kind ?? "RENEWAL";
  const notice = NOTICES[kind];
  // Announcing a fulfilment before it has happened, or a renewal before it is approved, cannot be taken
  // back, so it is refused here rather than trusted to the button.
  const heldBack = noticeHeldBack(kind, product.orderStatus);
  if (heldBack) return { ok: false, error: heldBack };
  // A payment reminder: what the order comes to, what's been paid, and what's still owed — as the Payments list works
  // them out (src/lib/orders/financials.ts). Nothing owed, nothing to remind.
  let money: { orderTotal: string; amountPaid: string; balanceDue: string } | null = null;
  if (kind === "PAYMENT") {
    const order = await db.companyProduct.findUnique({
      where: { id: product.id },
      select: { quantity: true, unitPrice: true, item: { select: { sellingPrice: true, taxRatePercent: true } }, allocations: { select: { amount: true } } },
    });
    const figures = order ? computeOrderFinancials(order) : null;
    if (!figures || figures.balance <= 0) return { ok: false, error: "Nothing is owed on this order, so there's no payment to remind them of." };
    money = { orderTotal: formatCurrency(figures.total), amountPaid: formatCurrency(figures.paid), balanceDue: formatCurrency(figures.balance) };
  }
  const available = await resolveNoticeRecipients(input.companyProductId, kind);
  if (!available) return { ok: false, error: "That subscription no longer exists." };

  const chosen = available.contacts.filter((c) => input.contactIds.includes(c.id));
  if (chosen.length === 0) return { ok: false, error: "Those contacts aren't at this company." };

  // A renewal reminder going out by itself — nobody pressed send, nobody picked the wording — goes in the template chosen
  // on Settings › Renewals (owner, 13 Nov 2026 — src/lib/marketing/auto-notice-template.ts), else the built-in wording.
  const templateId = input.templateId ?? (kind === "RENEWAL" && !input.sentByUserId ? await autoTemplateFor("RENEWAL").catch(() => undefined) : undefined);
  const [settings, template] = await Promise.all([
    marketingSettings(),
    templateId
      ? db.marketingTemplate.findUnique({ where: { id: templateId }, select: { subject: true, body: true, format: true, preheader: true } })
      : Promise.resolve(null),
  ]);

  const subject = template?.subject ?? notice.subject;
  // A template designed in the email builder (owner, 3 Nov 2026 — "html templates for this, editable from builder"): its
  // HTML, the line of your own a paragraph above it, filled with the values escaped and wrapped as a campaign is
  // (buildMarketingEmail) — without tracking, as a notice never had. A text one goes as it always did.
  const designed = template?.format === "HTML";
  const ownLine = input.note?.trim() ?? "";
  const body = designed
    ? (ownLine ? `<p style="margin:0 0 16px">${escapeHtml(ownLine).replace(/\n/g, "<br>")}</p>` : "") + template.body
    : (ownLine ? `${ownLine}\n\n` : "") + (template?.body ?? notice.body);

  const origin = input.origin;
  const clock = await workspaceClock();
  const days = product.endDate
    ? Math.ceil((new Date(product.endDate).getTime() - Date.now()) / 86400000)
    : null;

  const skipped: { name: string; reason: string }[] = [];
  let queued = 0;
  // What {{subscriptions}} draws: the ones this email is about, or this one alone.
  const several = input.together && input.together.length > 1 ? input.together : null;
  const table = subscriptionsTable(
    several ?? [{ id: product.id, orderSeq: product.orderSeq, itemName: product.item.name, quantity: group.totalQuantity, renewalValue: group.renewalValue, endDate: product.endDate }],
    "TEXT",
  );

  for (const contact of chosen) {
    if (!contact.canReceive) {
      skipped.push({ name: contact.name, reason: contact.blockedBecause ?? "Can't be contacted." });
      continue;
    }
    // Security audit round two, 13 Nov 2026 (R2-14): a notice going out by itself never goes to somebody a website form
    // added to the customer until staff confirm them. A person pressing Send has seen the badge and chosen them.
    if (contact.unconfirmed && !input.sentByUserId) {
      skipped.push({ name: contact.name, reason: "Not confirmed yet — they came from the website." });
      continue;
    }

    const token = newToken();
    const values = mergeValuesFor(
      {
        contactId: contact.id,
        companyId: product.company.id,
        companyName: product.company.name,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        ownerName: product.company.owner?.name ?? null,
        ownerEmail: product.company.owner?.email ?? null,
        state: {} as RecipientState,
      },
      settings,
      {
        ...subscriptionMergeValues({
          item: product.item,
          quantity: group.totalQuantity,
          endDate: product.endDate,
          fullTermUnitPrice: product.fullTermUnitPrice,
        }),
        // The group's numbers, not the parent's — "20 seats" is the renewal, not "10 and separately 10".
        quantity: group.totalQuantity,
        renewalValue: group.renewalValue > 0 ? formatCurrency(group.renewalValue) : null,
        // The end date is a typed day kept as its midnight UTC; the fulfilment, a moment on the workspace's clock.
        expiryDate: product.endDate ? formatCalendarDay(product.endDate) : null,
        // The term a renewal confirmation names: typed days, kept as their midnight UTC.
        startDate: product.startDate ? formatCalendarDay(product.startDate) : null,
        daysLeft: days,
        daysLeftPhrase: daysLeftPhrase(days),
        orderId: formatOrderId(product.orderSeq),
        poNumber: product.poNumber,
        fulfilledDate: product.fulfilledAt ? clock.date(product.fulfilledAt) : null,
        unsubscribeUrl: `${origin}/preferences/${token}`,
        ...(money ?? {}),
        subscriptionCount: 1,
        // Several renewing that day: every name, the seats and the value added up.
        ...(several ? sameDayValues(several) : {}),
      },
    );

    const renderedSubject = render(subject, values);
    const merged = render(markSubscriptions(body), values, designed ? { escape: escapeHtml } : undefined);
    const renderedBody = merged.ok ? { ...merged, text: fillSubscriptions(merged.text, table) } : merged;
    // The designed one, composed: its HTML and the plain-text part beside it, each with its own subscriptions table.
    let composed: { html: string; text: string } | null = null;
    if (designed && merged.ok) {
      const preheader = render(template.preheader ?? "", values);
      const email = composeEmail({
        format: "HTML",
        body: expandWidgets(merged.text, "HTML", { origin, token }),
        preheader: preheader.ok ? preheader.text : "",
        footer: {
          senderName: settings.ourName,
          unsubscribeUrl: String(values.unsubscribeUrl),
          postalAddress: settings.postalAddress,
          includeUnsubscribe: !merged.used.includes("unsubscribeUrl"),
          includeAddress: !merged.used.includes("postalAddress"),
        },
        origin,
      });
      const htmlTable = subscriptionsTable(
        several ?? [{ id: product.id, orderSeq: product.orderSeq, itemName: product.item.name, quantity: group.totalQuantity, renewalValue: group.renewalValue, endDate: product.endDate }],
        "HTML",
      );
      composed = { html: fillSubscriptions(email.html, htmlTable), text: fillSubscriptions(email.text, table) };
    }
    if (!renderedSubject.ok || !renderedBody.ok) {
      const missing = [...new Set([...(renderedSubject.ok ? [] : renderedSubject.missing), ...(renderedBody.ok ? [] : renderedBody.missing)])];
      const unknown = [...new Set([...(renderedSubject.ok ? [] : renderedSubject.unknown), ...(renderedBody.ok ? [] : renderedBody.unknown)])];
      skipped.push({
        name: contact.name,
        reason: [missing.length ? `The template needs ${missing.join(", ")}.` : null, unknown.length ? `It uses ${unknown.map((u) => `{{${u}}}`).join(", ")}, which isn't a field it can fill.` : null]
          .filter(Boolean)
          .join(" "),
      });
      continue;
    }

    if (input.preview) {
      const cc = (input.cc ?? []).filter((e) => !chosen.some((c) => c.email?.toLowerCase() === e));
      input.preview({ to: { name: contact.name, email: contact.email ?? "" }, cc, subject: renderedSubject.text, text: composed?.text ?? renderedBody.text, html: composed?.html ?? null, others: chosen.filter((c) => c.canReceive).length - 1, skipped }, chosen);
      return { ok: true, data: { sent: 0, failed: 0, skipped, product: { id: product.id, itemName: product.item.name, companyId: product.company.id, companyName: product.company.name } } };
    }

    const message: Prisma.MarketingMessageUncheckedCreateInput = {
      token,
      companyId: product.company.id,
      contactId: contact.id,
      channel: "EMAIL",
      messageClass: NOTICE_MESSAGE_CLASS,
      subject: renderedSubject.text,
      body: composed?.html ?? renderedBody.text,
      ...(composed ? { textBody: composed.text } : {}),
      toEmail: contact.email,
      // For the mail log: who sent it, about which order, and which notice it was.
      sentByUserId: input.sentByUserId ?? null,
      companyProductId: product.id,
      noticeKind: kind,
      // Manual and transactional, so it goes now rather than waiting for the next send window.
      // Quiet hours exist to stop a *campaign* landing at 2am, not to delay somebody's own notice.
      scheduledFor: new Date(),
      status: "QUEUED",
    };
    // The copies go with the first email that goes, not with every person's — and never to somebody it's addressed to.
    const cc = queued === 0 ? (input.cc ?? []).filter((e) => !chosen.some((c) => c.email?.toLowerCase() === e)) : [];
    const copied = cc.length ? { ...message, ccEmails: cc } : message;
    try {
      await db.marketingMessage.create({ data: copied });
    } catch (err) {
      // A workspace not yet migrated for copies (20261203140000_notice_cc) sends it uncopied; one still waiting for
      // 20261103100000_renewal_confirmation can't name a confirmation yet, and the mail log calls it a notice.
      if (copied !== message && notMigratedYet(err)) await db.marketingMessage.create({ data: message });
      else if (kind === "RENEWED") await db.marketingMessage.create({ data: { ...message, noticeKind: null } });
      else throw err;
    }
    queued += 1;
  }

  if (queued === 0) {
    return {
      ok: false,
      error: skipped[0]?.reason ?? "Nobody selected can be sent to.",
    };
  }

  // Sent straight away rather than left for the next tick — somebody clicked a button and expects
  // it gone. Anything else that happens to be due goes with it, which is no bad thing.
  const result = await sendQueued(`manual-${Date.now().toString(36)}`);

  return {
    ok: true,
    data: {
      sent: Math.min(result.sent, queued),
      failed: result.failed,
      skipped,
      product: {
        id: product.id,
        itemName: product.item.name,
        companyId: product.company.id,
        companyName: product.company.name,
      },
    },
  };
}
