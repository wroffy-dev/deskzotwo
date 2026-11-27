"use server";

import { revalidatePath } from "next/cache";
import { plainError } from "@/lib/plain-error";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { emitPaymentReceived } from "@/lib/automate/emit-records";
import { syncInvoiceStatus } from "@/lib/receivables/sync";
import { reverseAllocationExchange, reverseGroupTransfer, reversePaymentPosting } from "@/lib/ledger/journal";
import { bookingRate, takenFromPayment } from "@/lib/ledger/posting";
import { baseCurrency, basePrefix, isBaseCurrency } from "@/lib/currency";
import { bankCurrencyRefusal } from "@/lib/finance/bank-currency";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { bookOnFirstPayment } from "@/lib/orders/handoff";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { accessLevel, mayAccess, mayAddTo, orderAccess, paymentAccess, throughAccount } from "@/lib/authz/access";
import { receivablesOutstanding } from "@/lib/finance/dashboard";
import { toPlain } from "@/lib/serialize";
import { UNPAGED_LIST_CEILING, pageOf } from "@/lib/pagination";
import { hasEffectivePermission, viewerHas } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { postPaymentToLedger } from "@/lib/ledger/journal";
import { computeOrderFinancials } from "@/lib/orders/financials";
import { loadBalanceSummary } from "@/lib/receivables/balance-summary";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";
import { workspaceClock } from "@/lib/time/workspace";
import { settlePromisesFor } from "@/lib/collections/promises";
import { defaultBranchIdFor } from "@/lib/branches/identity";
import {
  recordPaymentSchema,
  allocatePaymentSchema,
} from "@/lib/validation/payment";
import type { ActionResult } from "@/actions/company";
import { claimRequest } from "@/lib/request-once";
import { orderSearchTerms } from "@/lib/orders/search";
import { lockSettlement, SettlementRefused } from "@/lib/finance/settlement-lock";
import { tallyLockRefusal } from "@/lib/tally/server";

const orderItemSelect = {
  id: true,
  name: true,
  sku: true,
  unit: true,
  sellingPrice: true,
  taxRatePercent: true,
} as const;

// The order arithmetic lives in src/lib/orders/financials.ts — one copy, which Collections reads too.

/**
 * Whether the caller may see one company's money at all.
 *
 * The per-company reads below are handed a company id, so an account-scope *filter* would be very
 * nearly a no-op — the caller has already named the company, and the only question left is yes or
 * no. They ask it here and refuse with an empty result, because these are server actions a browser
 * can call directly and a company id is not a secret.
 */
async function canSeeCompanyMoney(userId: string, companyId: string) {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { ownerUserId: true, relationshipType: true },
  });
  if (!company) return false;
  return canSeeCompany(userId, company);
}

/**
 * Whether money may be put on this order: one this person may open, by the Orders record level (owner, 3 Nov 2026 —
 * "Phase 2 permission fixes", audit M-6 follow-up). Recording a payment onto an order and allocating one to it checked
 * the payment and the account, never the order — so a role whose Orders level is narrower than its Companies level
 * could pay down, and book on first payment, an order its own order page answers as not found, by id.
 *
 * View, not edit: the order picker these come from lists the orders this person may see (`listCompanyOrdersForPayment`,
 * on view since Phase 1), and the two must agree — every order it offers is taken and every one it hides is refused.
 * The money is the payment's, which is already asked at edit (`payments.record`, the payment's own level, the account);
 * the order is what it settles, as accounts settle orders they don't run. Module-private: a "use server" export is an
 * endpoint.
 */
async function orderOpenToPay(userId: string, orderId: string): Promise<boolean> {
  return mayAccess(userId, "orders", "view", orderId);
}

/** Why money can't go onto an order owing `balance`, or null when `amount` fits (SEC-12). Module-private. */
function orderCeilingRefusal(amount: number, balance: number): string | null {
  if (amount <= balance + 0.001) return null;
  return balance <= 0
    ? "That order is already fully paid. Record the payment on account instead."
    : `Only ${balance.toFixed(2)} is still outstanding on that order. Record the excess on account, as a separate payment.`;
}

/** The order with what `computeOrderFinancials` needs, read in a settlement's transaction (SEC-12). */
async function orderMoneyIn(tx: Prisma.TransactionClient, orderId: string) {
  return tx.companyProduct.findUnique({
    where: { id: orderId },
    select: { quantity: true, unitPrice: true, orderStatus: true, item: { select: orderItemSelect }, allocations: { select: { amount: true } } },
  });
}

export async function recordPayment(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("payments");
  if (!(await hasEffectivePermission(user.id, "payments.record"))) {
    return {
      ok: false,
      error: "You don't have permission to record payments.",
    };
  }
  const parsed = recordPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const {
    companyId,
    amount,
    paidOn,
    method,
    reference,
    notes,
    allocateToOrderId,
  } = parsed.data;

  // A payment is recorded against an account this person reaches, like every other payment write: the
  // permission says they may record payments, not whose.
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company || !(await mayAddTo(user.id, "payments", company))) {
    return { ok: false, error: "Company not found." };
  }

  let order = null;
  if (allocateToOrderId) {
    order = await db.companyProduct.findUnique({
      where: { id: allocateToOrderId },
      include: { item: { select: orderItemSelect }, allocations: { select: { amount: true } } },
    });
    // Only an order this person may open (`orderOpenToPay`) — out of reach answers as a made-up id does.
    if (!order || order.companyId !== companyId || !(await orderOpenToPay(user.id, order.id))) {
      return {
        ok: false,
        error: "That order does not belong to the selected company.",
      };
    }
    // Its payments were moved on account when it was cancelled; new money doesn't land on it either.
    if (order.orderStatus === "CANCELLED") {
      return { ok: false, error: "That order is cancelled — record the payment on account instead." };
    }
    // Security audit, 11 Nov 2026 (SEC-12): money recorded onto an order has the order's ceiling, as an
    // allocation to it already had (`allocatePayment`) and as Record payment on an invoice has. It had none,
    // so one payment could pay an order many times over. More than it owes is not an advance here — an
    // advance is a payment on account, which this form records when no order is picked.
    const refusal = orderCeilingRefusal(amount, computeOrderFinancials(order).balance);
    if (refusal) return { ok: false, error: refusal };
  }

  // Into a named bank account where one is given (owner, 20 Nov 2026 — a bank statement line recorded, src/lib/bank-match);
  // a foreign-currency account takes its own currency only, and this payment is in rupees.
  const bankAccountId = parsed.data.bankAccountId || null;
  const bankRefusal = await bankCurrencyRefusal(bankAccountId, baseCurrency());
  if (bankRefusal) return { ok: false, error: bankRefusal };

  // An order payment names no document, so it is the recorder's branch (spec §5.7) — resolved before
  // the transaction, since the head office fallback uses its own connection.
  const branchId = await defaultBranchIdFor(user.id);

  // The same request again — a double click, a retry — is the payment it already made (src/lib/request-once.ts).
  const claim = await claimRequest(input, "payment", user.id);
  if (claim.kind === "repeat") return { ok: true, data: { id: claim.recordId } };
  if (claim.kind === "busy") return { ok: false, error: claim.error };

  const payment = await db.$transaction(async (tx) => {
    // Security audit, 11 Nov 2026 (SEC-12): the order is locked and its balance read again here, so two
    // payments recorded onto it at once can't both fit under the ceiling checked above.
    if (order) {
      await lockSettlement(tx, { orders: [order.id] });
      const now = await orderMoneyIn(tx, order.id);
      if (!now || now.orderStatus === "CANCELLED") throw new SettlementRefused("That order is cancelled — record the payment on account instead.");
      const refusal = orderCeilingRefusal(amount, computeOrderFinancials(now).balance);
      if (refusal) throw new SettlementRefused(refusal);
    }
    const created = await tx.payment.create({
      data: {
        companyId,
        branchId,
        amount,
        paidOn: new Date(paidOn),
        method,
        reference: reference || null,
        notes: notes || null,
        bankAccountId,
        recordedByUserId: user.id,
        ...(order
          ? {
              allocations: {
                create: [
                  {
                    companyProductId: order.id,
                    amount,
                    allocatedByUserId: user.id,
                  },
                ],
              },
            }
          : {}),
      },
    });
    await postPaymentToLedger(tx, created.id, user.id);
    // An in-hand order counts as booked from its first payment (O-D2).
    if (order) await bookOnFirstPayment(tx, { id: order.id }, new Date());
    await emitPaymentReceived(tx, created.id, user.id);
    return created;
  }).catch(async (err: unknown) => {
    await claim.release();
    if (err instanceof SettlementRefused) return err;
    throw err;
  });
  if (payment instanceof SettlementRefused) return { ok: false, error: payment.message };
  await claim.done(payment.id);
  // A promise to pay this order, kept by this money (src/lib/collections/promises.ts). Never fails the payment.
  if (order) await settlePromisesFor({ orderIds: [order.id] });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "Payment",
    entityId: payment.id,
    entityLabel: `Payment of ${basePrefix()}${amount} — ${company.name}`,
  });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/payments");
  return { ok: true, data: { id: payment.id } };
}

export async function allocatePayment(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("payments");
  if (!(await hasEffectivePermission(user.id, "payments.record"))) {
    return {
      ok: false,
      error: "You don't have permission to allocate payments.",
    };
  }
  const parsed = allocatePaymentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { paymentId, companyProductId, amount } = parsed.data;

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: { allocations: true },
  });
  if (!payment || !(await mayAccess(user.id, "payments", "edit", paymentId))) {
    return { ok: false, error: "Payment not found." };
  }
  // An order is priced in rupees. A receipt taken in a foreign invoice's currency (and freed again
  // when its allocation was removed) would be set against it dollar for rupee.
  if (!isBaseCurrency(payment.currency)) {
    return {
      ok: false,
      error: `This payment is in ${payment.currency}; an order is in rupees. Apply it to a ${payment.currency} invoice instead.`,
    };
  }

  const order = await db.companyProduct.findUnique({
    where: { id: companyProductId },
    include: {
      item: { select: orderItemSelect },
      allocations: { select: { amount: true } },
    },
  });
  // Only an order this person may open (`orderOpenToPay`) — out of reach answers as a made-up id does.
  if (!order || order.companyId !== payment.companyId || !(await orderOpenToPay(user.id, order.id))) {
    return {
      ok: false,
      error: "That order does not belong to this payment's company.",
    };
  }
  if (order.orderStatus === "CANCELLED") {
    return { ok: false, error: "That order is cancelled — apply the money to another order, or refund it." };
  }

  // What each earlier allocation took out of this payment — an allocation across currencies records
  // the rupees separately from the figure it settled (`takenFromPayment`).
  const alreadyAllocated = payment.allocations.reduce(
    (sum, a) => sum + takenFromPayment(a),
    0,
  );
  const remaining =
    Math.round((Number(payment.amount) - alreadyAllocated) * 100) / 100;
  if (amount > remaining) {
    return {
      ok: false,
      error: `Only ${remaining.toFixed(2)} is unallocated on this payment.`,
    };
  }

  // The order has a ceiling of its own. Without this an allocation is only checked against the
  // payment, so a large payment can be dumped onto a small order — which reads back as an order
  // that's been paid many times over and a customer whose outstanding balance has gone negative.
  const orderBalance = computeOrderFinancials(order).balance;
  if (amount > orderBalance) {
    return {
      ok: false,
      error:
        orderBalance <= 0
          ? "That order is already fully paid."
          : `Only ${orderBalance.toFixed(2)} is still outstanding on that order.`,
    };
  }

  const allocation = await db.$transaction(async (tx) => {
    // Security audit, 11 Nov 2026 (SEC-12): the payment and the order are locked and both balances read again
    // here — the checks above were before the transaction, so two allocations at once could each spend the
    // whole of the payment, or each fill the whole of the order.
    await lockSettlement(tx, { payments: [paymentId], orders: [companyProductId] });
    const [paymentNow, orderNow] = await Promise.all([
      tx.payment.findUnique({ where: { id: paymentId }, select: { amount: true, allocations: { select: { amount: true, paymentAmount: true } } } }),
      orderMoneyIn(tx, companyProductId),
    ]);
    if (!paymentNow) throw new SettlementRefused("Payment not found.");
    if (!orderNow || orderNow.orderStatus === "CANCELLED") throw new SettlementRefused("That order is cancelled — apply the money to another order, or refund it.");
    const left = Math.round((Number(paymentNow.amount) - paymentNow.allocations.reduce((sum, a) => sum + takenFromPayment(a), 0)) * 100) / 100;
    if (amount > left) throw new SettlementRefused(`Only ${left.toFixed(2)} is unallocated on this payment.`);
    const balanceNow = computeOrderFinancials(orderNow).balance;
    if (amount > balanceNow) {
      throw new SettlementRefused(balanceNow <= 0 ? "That order is already fully paid." : `Only ${balanceNow.toFixed(2)} is still outstanding on that order.`);
    }
    const row = await tx.paymentAllocation.create({
      data: { paymentId, companyProductId, amount, allocatedByUserId: user.id },
    });
    // An in-hand order counts as booked from its first payment (O-D2).
    await bookOnFirstPayment(tx, { id: companyProductId }, new Date());
    return row;
  }).catch((err: unknown) => {
    if (err instanceof SettlementRefused) return err;
    throw err;
  });
  if (allocation instanceof SettlementRefused) return { ok: false, error: allocation.message };
  await settlePromisesFor({ orderIds: [companyProductId] });

  revalidatePath(`/companies/${payment.companyId}`);
  revalidatePath("/payments");
  return { ok: true, data: { id: allocation.id } };
}

export async function deleteAllocation(
  id: string,
): Promise<ActionResult<null>> {
  const user = await requireModuleUser("payments");
  // The payment Delete row is the one switch (src/lib/authz/access.ts); which payments, it says below.
  if ((await accessLevel(user.id, "payments", "delete")) === "NONE") {
    return {
      ok: false,
      error: "You don't have permission to delete allocations.",
    };
  }
  const allocation = await db.paymentAllocation.findUnique({
    where: { id },
    include: { payment: { select: { companyId: true } }, document: { select: { companyId: true } } },
  });
  // Taking an allocation off changes the payment it came from.
  if (!allocation || !(await mayAccess(user.id, "payments", "edit", allocation.paymentId))) {
    return { ok: false, error: "Allocation not found." };
  }
  // Gone to Tally: locked (src/lib/tally — decision 4).
  const tallyLocked = await tallyLockRefusal("PAYMENT", [allocation.paymentId]);
  if (tallyLocked) return { ok: false, error: tallyLocked };

  /**
   * An allocation to an invoice or a bill is more than a row. Setting a foreign receipt against a
   * document raised at another rate booked an exchange difference, and the document's status is a
   * cache of its allocations — so removing one used to leave the gain in the P&L and the invoice
   * reading PAID. The difference is reversed in the same transaction as the row goes; the payment's
   * own entry stays, because the money was still received — it is simply on account again.
   */
  await db.$transaction(async (tx) => {
    await reverseAllocationExchange(tx, id, user.id);
    // Set against another group company's invoice: the transfer between their accounts goes back too.
    await reverseGroupTransfer(tx, id, user.id);
    await tx.paymentAllocation.delete({ where: { id } });
  });
  if (allocation.documentId) await syncInvoiceStatus(allocation.documentId);

  revalidatePath(`/companies/${allocation.payment.companyId}`);
  if (allocation.document && allocation.document.companyId !== allocation.payment.companyId) revalidatePath(`/companies/${allocation.document.companyId}`);
  revalidatePath("/payments");
  if (allocation.documentId) {
    revalidatePath(`/documents/${allocation.documentId}`);
    revalidatePath("/receivables");
    revalidatePath("/payables");
  }
  return { ok: true, data: null };
}

/**
 * Deletes one payment the way the books need it deleted. Three things, and once only the first.
 *
 * The row went, and its ledger entries stayed posted with a dangling `paymentId` — bank overstated,
 * receivables understated, for good — while the invoice it had settled kept its PAID status and
 * quietly stopped being chased. A deletion that leaves the books wrong and the customer unchased is
 * worse than a refusal. So: every live entry of the payment's is reversed (the receipt, its cheque
 * clearing, the exchange difference on each allocation — `reversePaymentPosting`), in the same
 * transaction as the row goes; then each document it settled has its status derived again.
 *
 * Module-private: a "use server" file publishes only what it exports.
 */
async function removePayment(id: string, userId: string, allocations: { documentId: string | null }[]) {
  await db.$transaction(async (tx) => {
    await reversePaymentPosting(tx, id, userId);
    await tx.payment.delete({ where: { id } });
  });

  const documentIds = [...new Set(allocations.map((a) => a.documentId).filter((x): x is string => !!x))];
  for (const documentId of documentIds) {
    await syncInvoiceStatus(documentId);
  }
  return documentIds;
}

export async function deletePayment(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("payments");
  // The payment Delete row is the one switch (src/lib/authz/access.ts); which payments, it says below.
  if ((await accessLevel(user.id, "payments", "delete")) === "NONE") {
    return {
      ok: false,
      error: "You don't have permission to delete payments.",
    };
  }
  // Gone to Tally: locked (src/lib/tally — decision 4).
  const tallyLocked = await tallyLockRefusal("PAYMENT", [id]);
  if (tallyLocked) return { ok: false, error: tallyLocked };
  const payment = await db.payment.findUnique({
    where: { id },
    select: {
      companyId: true,
      amount: true,
      currency: true,
      paymentSeq: true,
      // The invoices this payment was settling. Their status is a cache of their allocations, so
      // removing the allocations without re-deriving it leaves an unpaid invoice reading PAID —
      // which drops it out of the ageing report and off every chase list in the app.
      allocations: { select: { documentId: true } },
    },
  });
  if (!payment || !(await mayAccess(user.id, "payments", "delete", id))) {
    return { ok: false, error: "Payment not found." };
  }

  await removePayment(id, user.id, payment.allocations);

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Payment",
    entityId: id,
    entityLabel: `Deleted payment #${payment.paymentSeq} of ${isBaseCurrency(payment.currency) ? "" : `${payment.currency} `}${payment.amount}`,
  });

  revalidatePath(`/companies/${payment.companyId}`);
  revalidatePath("/payments");
  revalidatePath("/receivables");
  revalidatePath("/payables");
  return { ok: true, data: null };
}

export type PaymentStatusFilter = "unpaid" | "partial" | "paid";

/**
 * The home screen's Outstanding balance (owner, 13 Nov 2026): what customers still owe on issued invoices and debit
 * notes — each one's balance after payments, credit notes and what was paid before Deskzo, in rupees at its own rate —
 * for the accounts this person can see. The same arithmetic as Accounting's receivables (`receivablesOutstanding`),
 * held to the viewer's accounts as the tile always was.
 *
 * It used to add up orders: every order ever punched, cancelled, rejected and the old system's included, at its order
 * value, less only what had been allocated to the order itself. Money here is collected against invoices, so nearly
 * every order read as wholly unpaid — ₹179 crore across 15,453 orders on Wroffy's workspace.
 */
export async function paymentsSnapshot() {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return { outstandingBalance: 0, unpaidCount: 0, partialCount: 0 };
  const owed = await receivablesOutstanding((await throughAccount(user.id, "view")) as Prisma.TradeDocumentWhereInput);
  return { outstandingBalance: owed.total, unpaidCount: owed.unpaid, partialCount: owed.partial };
}


/** The orders on the payments page: the order rule's (src/lib/authz/access.ts), narrowed by the search. */
async function ordersWithPaymentsWhere(userId: string, search?: string): Promise<Prisma.CompanyProductWhereInput> {
  return {
    /**
     * The scope and the search both narrow through `company`, so they go in as two `AND` terms
     * rather than two spreads into the same object — spreading would keep whichever `company`
     * key was written last and silently drop the other, and the one dropped would be the scope.
     */
    AND: [
      // Its rows are orders, so the order rule decides which (src/lib/authz/access.ts).
      await orderAccess(userId, "view"),
      // The order's number, customer, end customer, product or PO (owner, 1 Nov 2026).
      ...(search?.trim() ? [{ OR: orderSearchTerms(search) }] : []),
    ],
  };
}

const orderWithPaymentsInclude = {
  company: { select: { id: true, companySeq: true, name: true } },
  item: { select: orderItemSelect },
  allocations: {
    orderBy: { createdAt: "desc" },
    include: {
      allocatedBy: { select: { id: true, name: true } },
      payment: {
        select: { id: true, paidOn: true, method: true, reference: true },
      },
    },
  },
} as const satisfies Prisma.CompanyProductInclude;

export async function listOrdersWithPayments(params?: {
  search?: string;
  status?: PaymentStatusFilter;
}) {
  const user = await requireModuleAccess("payments");
  if (!(await viewerHas("payments.view"))) return [];

  const orders = await db.companyProduct.findMany({
    where: await ordersWithPaymentsWhere(user.id, params?.search),
    include: orderWithPaymentsInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  const withTotals = toPlain(
    orders.map((order) => ({ ...order, ...computeOrderFinancials(order) })),
  );

  if (!params?.status) return withTotals;
  return withTotals.filter((o) => o.status === params.status);
}

/** A company's orders with their financials, for the "select an order to allocate against" step. */
export async function listCompanyOrdersForPayment(companyId: string) {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return [];
  // What each order is worth and how much of it is still owed — the account's commercials, for a
  // company this person may not manage. No orders rather than a refusal, so the dialog that calls
  // this just has nothing to allocate against.
  if (!(await canSeeCompanyMoney(user.id, companyId))) return [];

  /**
   * The orders this person may open, and only what the dialogs show of them (owner, 2 Nov 2026 — "Phase 1 security
   * fixes", audit M-6). This returned every order on the account, each row whole — purchase price, deal price, the
   * distributor's quote — to anybody who could see the account, so a role whose Orders level is narrower than its
   * Companies level read the cost of orders its own order page answers as not found. Now the order rule decides which
   * (`orderAccess`, as the payments list beside it does), and the row is the number, the product and the money owed:
   * nothing here is the order's cost.
   */
  const orders = await db.companyProduct.findMany({
    where: { AND: [{ companyId }, await orderAccess(user.id, "view")] },
    select: {
      id: true,
      orderSeq: true,
      quantity: true,
      unitPrice: true,
      item: { select: orderItemSelect },
      allocations: { select: { amount: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return toPlain(
    orders.map((order) => ({ ...order, ...computeOrderFinancials(order) })),
  );
}

/** Every payment received, with how much of it is still unallocated — for the "Payments received" list. */
/**
 * Received only.
 *
 * A vendor payment is money going the other way, and this listed and summed the two together —
 * so what the company had *spent* was reported as part of what it had collected, on the screen
 * whose whole job is to say how much has come in.
 */
async function receivedPaymentsWhere(userId: string, search?: string): Promise<Prisma.PaymentWhereInput> {
  return {
    direction: "RECEIVED",
    /**
     * The access engine's `paymentAccess` rather than a hand-written clause: with no level set a
     * receipt reaches its account through its own `companyId` — which is set even on a lump sum
     * that has not been allocated to any order yet, and those are precisely the rows an account
     * manager is chasing.
     *
     * As an `AND` term because the search narrows through `company` too; two spreads into one
     * object would leave only the last `company` key standing.
     */
    AND: [await paymentAccess(userId, "view"), ...(search ? [{ company: { name: { contains: search, mode: "insensitive" as const } } }] : [])],
  };
}

const receivedPaymentInclude = {
  company: { select: { id: true, companySeq: true, name: true } },
  recordedBy: { select: { id: true, name: true } },
  allocations: {
    include: {
      companyProduct: {
        select: {
          id: true,
          orderSeq: true,
          item: { select: { name: true } },
        },
      },
      document: { select: { id: true, docNumber: true, currency: true } },
    },
  },
} as const satisfies Prisma.PaymentInclude;

export async function listPayments(params?: {
  search?: string;
  unallocatedOnly?: boolean;
}) {
  const user = await requireModuleAccess("payments");
  if (!(await viewerHas("payments.view"))) return [];

  const payments = await db.payment.findMany({
    where: await receivedPaymentsWhere(user.id, params?.search),
    include: receivedPaymentInclude,
    orderBy: [{ paidOn: "desc" }, { id: "desc" }],
    // Security audit, 13 Nov 2026 (SEC-29): no screen reads this unpaged list; it stops at the ceiling rather than
    // handing every payment in scope to one call.
    take: UNPAGED_LIST_CEILING,
  });

  const withRemaining = toPlain(payments).map((payment) => {
    // In the payment's own currency: an allocation across currencies (rupees on account set against a
    // USD invoice) settles dollars but takes rupees, and it is the rupees that leave this payment.
    const allocated = payment.allocations.reduce(
      (sum, a) => sum + takenFromPayment(a),
      0,
    );
    const unallocated =
      Math.round((Number(payment.amount) - allocated) * 100) / 100;
    return { ...payment, allocated, unallocated };
  });

  if (!params?.unallocatedOnly) return withRemaining;
  return withRemaining.filter((p) => p.unallocated > 0);
}

/**
 * The money side of one company's 360 view: every payment they've sent us, what each one was
 * allocated against, and what's still sitting unallocated. Until now a payment was only reachable
 * through the order it paid for, so a payment covering several orders — or none yet — was
 * effectively invisible from the customer's own page.
 */
export async function listCompanyPayments(companyId: string) {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return [];
  if (!(await canSeeCompanyMoney(user.id, companyId))) return [];

  const payments = await db.payment.findMany({
    // Received only: a vendor payment is money going the other way.
    where: { AND: [{ companyId, direction: "RECEIVED" }, await paymentAccess(user.id, "view")] },
    orderBy: { paidOn: "desc" },
    include: {
      recordedBy: { select: { id: true, name: true } },
      allocations: {
        include: {
          companyProduct: {
            select: {
              id: true,
              orderSeq: true,
              item: { select: { name: true } },
            },
          },
          document: { select: { id: true, docNumber: true, currency: true } },
        },
      },
    },
  });

  return toPlain(payments).map((payment) => {
    // In the payment's own currency, as `listPayments` counts it.
    const allocated = payment.allocations.reduce(
      (sum, a) => sum + takenFromPayment(a),
      0,
    );
    return {
      ...payment,
      allocated,
      unallocated: Math.round((Number(payment.amount) - allocated) * 100) / 100,
    };
  });
}

/** Billed / received / outstanding for one company, across every order on its account. */
export async function companyPaymentSummary(companyId: string) {
  const user = await requireModuleUser("payments");
  if (!(await viewerHas("payments.view"))) return { billed: 0, received: 0, outstanding: 0, credit: 0, unallocated: 0 };
  // Zeros rather than `null`: this is the stat row at the top of the 360 view, so the shape has to
  // survive — and for an account somebody does not manage, "nothing billed, nothing received" is
  // the same refusal the empty list beside it gives.
  if (!(await canSeeCompanyMoney(user.id, companyId))) {
    return { billed: 0, received: 0, outstanding: 0, credit: 0, unallocated: 0 };
  }

  const [orders, receipts] = await Promise.all([
    db.companyProduct.findMany({
      where: { companyId },
      select: {
        quantity: true,
        unitPrice: true,
        item: { select: { sellingPrice: true, taxRatePercent: true } },
        allocations: { select: { amount: true } },
      },
    }),
    db.payment.findMany({
      where: { AND: [{ companyId, direction: "RECEIVED" }, await paymentAccess(user.id, "view")] },
      select: { amount: true, currency: true, exchangeRate: true, allocations: { select: { amount: true, paymentAmount: true } } },
    }),
  ]);

  const billed = orders.reduce(
    (sum, order) => sum + computeOrderFinancials(order).total,
    0,
  );
  const allocated = orders.reduce(
    (sum, order) => sum + computeOrderFinancials(order).paid,
    0,
  );

  const round = (n: number) => Math.round(n * 100) / 100;
  /**
   * Received and unallocated are in rupees, like the order figures beside them: a receipt in dollars
   * at its own rate. Unallocated is what each receipt has not been set against — orders *or* invoices.
   * It was "received less what the orders took", so money applied to an invoice read as unallocated.
   */
  const receivedTotal = receipts.reduce((sum, p) => sum + round(Number(p.amount) * bookingRate(p)), 0);
  const unallocatedTotal = receipts.reduce((sum, p) => {
    const left = round(Number(p.amount) - p.allocations.reduce((t, a) => t + takenFromPayment(a), 0));
    return sum + (left > 0 ? round(left * bookingRate(p)) : 0);
  }, 0);
  const net = round(billed - allocated);

  /**
   * Billed as invoiced, owed as Receivables has it (owner, 9 Nov 2026), once the customer has invoices: receipts are set
   * against invoices now, not orders, so the orders' figure showed a customer who'd paid as owing everything billed. The
   * balance is the Customer Balance Summary's for this one customer — open invoices, less what's received and not yet
   * set against anything, with any opening balance. A customer billed only through orders keeps the orders' figure.
   */
  const invoices = await db.tradeDocument.findMany({
    where: { companyId, docType: RECEIVABLE_DOC_TYPE, status: { notIn: ["DRAFT", "CANCELLED"] } },
    select: { total: true, exchangeRate: true },
  });
  if (invoices.length > 0) {
    const asOf = (await workspaceClock()).today();
    const summary = await loadBalanceSummary("AR", asOf, { scope: { documents: { companyId }, payments: { companyId }, companies: { id: companyId } } });
    const balance = round(summary.rows.find((r) => r.id === companyId)?.balance ?? 0);
    return {
      billed: round(invoices.reduce((sum, d) => sum + round(Number(d.total) * (Number(d.exchangeRate) || 1)), 0)),
      received: round(receivedTotal),
      outstanding: Math.max(balance, 0),
      credit: Math.max(-balance, 0),
      unallocated: round(unallocatedTotal),
    };
  }

  return {
    billed: round(billed),
    received: round(receivedTotal),
    // Split rather than letting one figure go negative: money we're still owed and money sitting on
    // the account in the customer's favour are different things, and a "-₹31,710 outstanding" reads
    // as a bug even when the arithmetic is right.
    outstanding: Math.max(net, 0),
    credit: Math.max(-net, 0),
    unallocated: round(unallocatedTotal),
  };
}

/**
 * The Payments page's two lists, paginated. Orders are sliced in memory rather than in SQL because
 * their payment status is derived from the allocations after the query — the database can't filter
 * on "partially paid" without recomputing what `computeOrderFinancials` already knows.
 */
export async function listOrdersWithPaymentsPaged(params: {
  search?: string;
  status?: PaymentStatusFilter;
  page: number;
  pageSize: number;
}) {
  const user = await requireModuleAccess("payments");
  if (!(await viewerHas("payments.view"))) return { rows: [], total: 0, outstanding: 0 };

  /**
   * Every order's money, read light — its price and what has been paid against it, added up by the
   * database — for the status filter and the outstanding total; then the page's orders whole. It read
   * every order with every allocation to show fifty (the large-workspace load test, 23 Oct 2026).
   */
  const where = await ordersWithPaymentsWhere(user.id, params.search);
  const [light, paidRows] = await Promise.all([
    db.companyProduct.findMany({
      where,
      select: { id: true, quantity: true, unitPrice: true, item: { select: { sellingPrice: true, taxRatePercent: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    db.paymentAllocation.groupBy({ by: ["companyProductId"], where: { companyProduct: { is: where } }, _sum: { amount: true } }),
  ]);
  const paidOf = new Map(paidRows.map((r) => [r.companyProductId, Number(r._sum.amount ?? 0)]));
  const money = light.map((o) => ({ id: o.id, ...computeOrderFinancials({ ...o, allocations: [{ amount: paidOf.get(o.id) ?? 0 }] }) }));
  const matching = params.status ? money.filter((m) => m.status === params.status) : money;
  const outstanding = matching.reduce((sum, o) => sum + Math.max(o.balance, 0), 0);

  const page = pageOf(matching, params.page, params.pageSize);
  const ids = page.rows.map((m) => m.id);
  const orders = ids.length ? await db.companyProduct.findMany({ where: { id: { in: ids } }, include: orderWithPaymentsInclude }) : [];
  const byId = new Map(orders.map((o) => [o.id, o]));
  const rows = toPlain(ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])).map((order) => ({ ...order, ...computeOrderFinancials(order) })));
  return { rows, total: page.total, outstanding };
}

export async function listPaymentsPaged(params: {
  search?: string;
  unallocatedOnly?: boolean;
  page: number;
  pageSize: number;
}) {
  const user = await requireModuleAccess("payments");
  if (!(await viewerHas("payments.view"))) return { rows: [], total: 0, unallocated: 0 };

  /**
   * Every receipt's money, read light — its amount and what its allocations took out of it, added up by
   * the database — for the "unallocated" filter and total; then the page's receipts whole (the
   * large-workspace load test, 23 Oct 2026). What an allocation takes is its `paymentAmount` where it
   * crossed currencies, else its amount (`takenFromPayment`): summed as the two kinds.
   */
  const where = await receivedPaymentsWhere(user.id, params.search);
  const [light, crossed, same] = await Promise.all([
    db.payment.findMany({ where, select: { id: true, amount: true, currency: true, exchangeRate: true }, orderBy: [{ paidOn: "desc" }, { id: "desc" }] }),
    db.paymentAllocation.groupBy({ by: ["paymentId"], where: { payment: where, paymentAmount: { not: null } }, _sum: { paymentAmount: true } }),
    db.paymentAllocation.groupBy({ by: ["paymentId"], where: { payment: where, paymentAmount: null }, _sum: { amount: true } }),
  ]);
  const taken = new Map<string, number>();
  for (const r of crossed) taken.set(r.paymentId, (taken.get(r.paymentId) ?? 0) + Number(r._sum.paymentAmount ?? 0));
  for (const r of same) taken.set(r.paymentId, (taken.get(r.paymentId) ?? 0) + Number(r._sum.amount ?? 0));
  const money = light.map((p) => ({ id: p.id, rate: bookingRate(p), unallocated: Math.round((Number(p.amount) - (taken.get(p.id) ?? 0)) * 100) / 100 }));
  const matching = params.unallocatedOnly ? money.filter((p) => p.unallocated > 0) : money;
  // In rupees, the one currency a total can be in: a receipt in dollars counts at its own rate.
  const unallocated = matching.reduce((sum, p) => sum + Math.round(Math.max(p.unallocated, 0) * p.rate * 100) / 100, 0);

  const page = pageOf(matching, params.page, params.pageSize);
  const ids = page.rows.map((p) => p.id);
  const payments = ids.length ? await db.payment.findMany({ where: { id: { in: ids } }, include: receivedPaymentInclude }) : [];
  const byId = new Map(toPlain(payments).map((p) => [p.id, p]));
  const rows = ids.flatMap((id) => {
    const payment = byId.get(id);
    if (!payment) return [];
    // In the payment's own currency: an allocation across currencies settles dollars but takes rupees.
    const allocated = payment.allocations.reduce((sum, a) => sum + takenFromPayment(a), 0);
    return [{ ...payment, allocated, unallocated: Math.round((Number(payment.amount) - allocated) * 100) / 100 }];
  });
  return { rows, total: page.total, unallocated };
}

/**
 * Bulk delete from the Payments received list. Deleting a payment cascades its allocations, which
 * moves the orders it was paying for back to outstanding — so it's gated on the same permission as
 * deleting one at a time rather than being a lighter-weight bulk path.
 */
export async function bulkDeletePayments(
  paymentIds: string[],
): Promise<ActionResult<{ count: number }>> {
  const user = await requireModuleAccess("payments");
  // The payment Delete row is the one switch (src/lib/authz/access.ts); which payments, it says below.
  if ((await accessLevel(user.id, "payments", "delete")) === "NONE") {
    return {
      ok: false,
      error: "You don't have permission to delete payments.",
    };
  }
  if (paymentIds.length === 0)
    return { ok: false, error: "Select at least one payment." };
  // Gone to Tally: locked (src/lib/tally — decision 4).
  const tallyLocked = await tallyLockRefusal("PAYMENT", paymentIds);
  if (tallyLocked) return { ok: false, error: tallyLocked };

  /**
   * Which of the posted ids this person may actually act on, rather than all of them.
   *
   * The list they were selected from is account-scoped now, so a genuine selection is unchanged —
   * but the ids come back from the browser, and deleting a receipt off an account you are not
   * allowed to see is the same rule broken in the other direction.
   */
  const payments = await db.payment.findMany({
    where: { AND: [{ id: { in: paymentIds } }, await paymentAccess(user.id, "delete")] },
    select: { id: true, companyId: true, amount: true, currency: true, paymentSeq: true, allocations: { select: { documentId: true } } },
  });

  /**
   * One at a time, each exactly as `deletePayment` does it. This was a single `deleteMany`, which
   * removed the rows and nothing else: every entry of every payment selected stayed in the ledger
   * with its `paymentId` let go, and every invoice they had settled kept reading PAID — the bulk
   * path was the single delete's old bug, at the size of a page.
   *
   * A transaction per payment, so one that can't be reversed (the books closed to today, say) is
   * reported and leaves the others deleted, rather than failing the lot after some had gone.
   */
  let count = 0;
  const failures: string[] = [];
  for (const payment of payments) {
    try {
      await removePayment(payment.id, user.id, payment.allocations);
      count += 1;
      await recordAudit({
        userId: user.id,
        action: "DELETE",
        entityType: "Payment",
        entityId: payment.id,
        entityLabel: `Deleted payment #${payment.paymentSeq} of ${isBaseCurrency(payment.currency) ? "" : `${payment.currency} `}${payment.amount}`,
      });
    } catch (error) {
      failures.push(`#${payment.paymentSeq}: ${plainError(error, "it couldn't be deleted")}`);
    }
  }

  for (const companyId of new Set(payments.map((p) => p.companyId))) {
    revalidatePath(`/companies/${companyId}`);
  }
  revalidatePath("/payments");
  revalidatePath("/receivables");
  revalidatePath("/payables");
  if (failures.length > 0 && count === 0) {
    return { ok: false, error: `No payment was deleted. ${failures.join(" ")}` };
  }
  if (failures.length > 0) {
    return { ok: false, error: `${count} deleted; ${failures.length} could not be. ${failures.join(" ")}` };
  }
  return { ok: true, data: { count } };
}
