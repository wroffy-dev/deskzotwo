import { db } from "@/lib/db";
import { automationUserId } from "@/lib/automation-user";
import { emitTicketCreated } from "@/lib/automate/emit-tickets";

/**
 * A customer's machines in their portal (owner, 15 Nov 2026: "is the IT asset thing visible to the customer on the
 * portal? can they manage it from there?"), shown where Settings › Customer portal › "Hardware and warranties" is on.
 *
 * Two kinds, as the IT Assets tab on their page splits them: theirs, which we look after, and ours, standing at their
 * site. Retired and lost machines aren't shown. Only what the customer would know of a machine leaves this file — never
 * its cost, licence key, internal notes, custodian, supplier or the order it came on.
 *
 * They don't edit the register. From a machine they can report a problem (a ticket on it, where Tickets is in their
 * plan; else a request), tell us it moved, was replaced or isn't used any more, or ask for more warranty or AMC cover
 * — each a request the account manager is told about, to act on and close (Customer requests).
 */

export type PortalAsset = {
  id: string;
  /** "AST-00012", the label on the machine. */
  tag: string;
  name: string;
  /** Make and model, as one line. */
  model: string | null;
  serialNumber: string | null;
  /** Theirs (we look after it) or ours (at their site). */
  ours: boolean;
  /** In words: "In use", "Under repair", "On its way". */
  state: string;
  location: string | null;
  warrantyEndsOn: Date | null;
  amcEndsOn: Date | null;
};

const STATE_WORDS: Record<string, string> = {
  IN_STOCK: "With us",
  ASSIGNED: "In use",
  INSTALLED: "In use",
  IN_TRANSIT: "On its way",
  UNDER_REPAIR: "Under repair",
};

/** Theirs and ours at their site — the IT Assets tab's first two lists — retired and lost ones left out. */
export async function portalAssetsOf(companyId: string): Promise<PortalAsset[]> {
  const rows = await db.asset.findMany({
    where: {
      status: { notIn: ["RETIRED", "LOST"] },
      OR: [{ ownerCompanyId: companyId }, { siteCompanyId: companyId, ownership: { not: "CLIENT_OWNED" } }],
    },
    orderBy: [{ name: "asc" }, { assetTag: "asc" }],
    take: 500,
    select: {
      id: true,
      assetTag: true,
      name: true,
      make: true,
      model: true,
      serialNumber: true,
      ownership: true,
      ownerCompanyId: true,
      status: true,
      warrantyEndsOn: true,
      amcEndsOn: true,
      location: { select: { label: true, city: true } },
    },
  });
  return rows.map((a) => ({
    id: a.id,
    tag: a.assetTag,
    name: a.name,
    model: [a.make, a.model].filter(Boolean).join(" ") || null,
    serialNumber: a.serialNumber,
    ours: a.ownerCompanyId !== companyId,
    state: STATE_WORDS[a.status] ?? "In use",
    location: a.location ? [a.location.label, a.location.city].filter(Boolean).join(", ") : null,
    warrantyEndsOn: a.warrantyEndsOn,
    amcEndsOn: a.amcEndsOn,
  }));
}

/** The machine, if it is one the portal shows this company — the only check an asset id from the browser gets. */
export async function portalAssetOf(companyId: string, assetId: string): Promise<{ id: string; tag: string; name: string } | null> {
  if (typeof assetId !== "string" || !assetId) return null;
  const a = await db.asset.findFirst({
    where: {
      id: assetId,
      status: { notIn: ["RETIRED", "LOST"] },
      OR: [{ ownerCompanyId: companyId }, { siteCompanyId: companyId, ownership: { not: "CLIENT_OWNED" } }],
    },
    select: { id: true, assetTag: true, name: true },
  });
  return a ? { id: a.id, tag: a.assetTag, name: a.name } : null;
}

/**
 * A problem with a machine, as a support ticket on it — opened by the Automation account, as an emailed one is
 * (src/lib/support-mail/receive.ts), with the person who asked in its description.
 */
export async function openAssetTicket(input: {
  companyId: string;
  contactId: string | null;
  asset: { id: string; tag: string; name: string };
  personName: string;
  message: string;
}): Promise<{ id: string; ticketSeq: number }> {
  const opener = await automationUserId();
  return db.$transaction(async (tx) => {
    const made = await tx.ticket.create({
      data: {
        companyId: input.companyId,
        contactId: input.contactId,
        assetId: input.asset.id,
        title: `Problem with ${input.asset.name} (${input.asset.tag})`.slice(0, 200),
        description: `${input.message}\n\n— ${input.personName}, from the customer portal`,
        ticketType: "PRODUCT_SUPPORT",
        createdByUserId: opener,
      },
      select: { id: true, ticketSeq: true },
    });
    await emitTicketCreated(tx, made.id, opener, "portal");
    return made;
  });
}
