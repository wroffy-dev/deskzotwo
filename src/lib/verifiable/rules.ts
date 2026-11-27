/**
 * Verifiable documents (owner, 7 Nov 2026 — src/actions/verifiable.ts): what a document's standing is. Pure, so the staff list
 * and the public page can't disagree. Withdrawn wins over everything: a withdrawn certificate that has also expired is withdrawn.
 */

/** A number as a search compares it: "abc-12 3" and "ABC123" are the same certificate. */
export const numberKeyOf = (number: string) => number.toUpperCase().replace(/[^A-Z0-9]/g, "");

export type VerifiableStanding = "VALID" | "EXPIRED" | "WITHDRAWN";

export const STANDING_WORDS: Record<VerifiableStanding, string> = { VALID: "Valid", EXPIRED: "Expired", WITHDRAWN: "Withdrawn" };

export const DOCUMENT_TYPES = ["Certificate", "Training certificate", "Licence", "Warranty", "Test report", "Authorisation letter", "Experience letter"] as const;

/** `today` and `expiresOn` as typed days, held at UTC midnight: a document is good all of its last day. */
export function standingOf(doc: { expiresOn: Date | null; withdrawnAt: Date | null }, today: Date): VerifiableStanding {
  if (doc.withdrawnAt) return "WITHDRAWN";
  return doc.expiresOn && doc.expiresOn.getTime() < today.getTime() ? "EXPIRED" : "VALID";
}

/**
 * What the public may read. Named field by field, so nothing added to the table later reaches an outsider by accident: no
 * customer record, no reason for a withdrawal, nobody's name who works here.
 */
export function publicFacts<T extends { docType: string; number: string; title: string; holderName: string; scope: string | null; issuedOn: Date; expiresOn: Date | null; withdrawnAt: Date | null }>(doc: T, today: Date) {
  return {
    standing: standingOf(doc, today),
    docType: doc.docType,
    number: doc.number,
    title: doc.title,
    holderName: doc.holderName,
    scope: doc.scope,
    issuedOn: doc.issuedOn,
    expiresOn: doc.expiresOn,
    withdrawnOn: doc.withdrawnAt,
  };
}
