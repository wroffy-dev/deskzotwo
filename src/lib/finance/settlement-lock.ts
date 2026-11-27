import type { db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * Security audit, 11 Nov 2026 (SEC-12): settling money was read-then-write. An invoice's balance, a payment's
 * unapplied amount and an order's balance were read before the transaction that wrote the allocation, so two
 * payments recorded at once against the same invoice (or one payment applied twice at once) each saw the full
 * balance and both went through — an invoice paid twice over, a payment spent twice.
 *
 * Every write that settles something now takes a transaction-scoped advisory lock on each record whose balance
 * it is about to rely on, then reads that balance again inside the transaction. The locks are taken in one
 * order (sorted by key), whoever the caller is, so two settlements that touch the same invoice and payment
 * from opposite ends wait for each other rather than deadlock. They are released when the transaction ends.
 */
export async function lockSettlement(
  tx: Tx,
  on: { documents?: (string | null | undefined)[]; payments?: (string | null | undefined)[]; orders?: (string | null | undefined)[] },
): Promise<void> {
  const keys = new Set<string>();
  for (const id of on.documents ?? []) if (id) keys.add(`deskzo:settle:doc:${id}`);
  for (const id of on.payments ?? []) if (id) keys.add(`deskzo:settle:pay:${id}`);
  for (const id of on.orders ?? []) if (id) keys.add(`deskzo:settle:order:${id}`);
  for (const key of [...keys].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }
}

/**
 * Thrown inside a settlement's transaction when the balance read again under the lock no longer allows it —
 * somebody else settled it in the meantime. The action catches it and returns the message as its refusal.
 */
export class SettlementRefused extends Error {}
