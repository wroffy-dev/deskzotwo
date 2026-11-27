import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { aiFilesRefused, aiTurn, AiRefusal } from "@/lib/ai/gateway";
import { workspaceClock } from "@/lib/time/workspace";
import { baseCurrency, formatMoney } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { teammateWork } from "@/lib/ai/teammate-work";
import { RECEIPT_STEPS } from "@/lib/ai/teammate-steps";
import { ALLOWED_RECEIPT_TYPES, MAX_RECEIPT_BYTES, formatExpenseId } from "@/lib/expenses";
import type { InputFile } from "@/lib/copilot/types";
import { workspacePack } from "@/lib/country-pack";
import { PROPOSE_RECEIPT, readReceiptSystem, checkReceipt, proposedReceiptSchema, receiptFill, type ReadReceipt, type ReceiptCheck, type ReceiptFill } from "@/lib/bill-reader/receipt";

/**
 * Arjun reading an expense receipt (owner, 20 Nov 2026 — the rules are ./receipt.ts). The receipt the person attached
 * to the claim — the same data URL the claim saves, so no larger than a claim's receipt may be (MAX_RECEIPT_BYTES; the
 * form shrinks a photo first) — goes to Deskzo AI (feature `receipts.read`), charged to them and seen working as Arjun.
 * What he read comes back as the claim's fields filled in, with anything worth a second look. Nothing is kept.
 */

export class ReceiptReadRefusal extends Error {}

export type ReceiptReading = { read: ReadReceipt; checks: ReceiptCheck[]; fill: ReceiptFill };

const PDF_MAX_PAGES = 3;

/** The data URL's kind and bytes, or null when it isn't one. */
function parseDataUrl(dataUrl: string): { type: string; base64: string; bytes: number } | null {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/i.exec(dataUrl.trim());
  if (!m) return null;
  const base64 = m[2]!;
  return { type: m[1]!.toLowerCase(), base64, bytes: Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0) };
}

async function pdfPages(base64: string): Promise<number | null> {
  try {
    const { getDocumentProxy } = await import("unpdf");
    return (await getDocumentProxy(new Uint8Array(Buffer.from(base64, "base64")), { verbosity: 0 })).numPages;
  } catch {
    return null;
  }
}

/** A claim of theirs already for the same amount on the same day — the same receipt claimed twice, perhaps. */
async function sameClaimOf(userId: string, r: ReadReceipt, exceptId: string | null): Promise<string | null> {
  if (!r.date || r.total === undefined) return null;
  const same = await db.expense.findFirst({
    where: { userId, spentOn: new Date(`${r.date}T00:00:00Z`), amount: new Prisma.Decimal(r.total), status: { not: "REJECTED" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { expenseSeq: true },
  });
  return same ? `You've claimed ${formatMoney(r.total)} for ${formatCalendarDay(r.date)} already (${formatExpenseId(same.expenseSeq)}) — make sure this isn't the same receipt.` : null;
}

/** Reads one receipt for this person. Throws ReceiptReadRefusal with words. */
export async function readReceipt(userId: string, input: { name: string; dataUrl: string; expenseId?: string | null }): Promise<ReceiptReading> {
  const file = parseDataUrl(String(input.dataUrl ?? ""));
  if (!file || !ALLOWED_RECEIPT_TYPES.includes(file.type)) throw new ReceiptReadRefusal("Attach a PNG, JPEG, WebP or PDF receipt first.");
  if (file.bytes > MAX_RECEIPT_BYTES) throw new ReceiptReadRefusal("That receipt is over 512KB — use a smaller file.");
  if (file.type === "application/pdf") {
    const pages = await pdfPages(file.base64);
    if (pages === null) throw new ReceiptReadRefusal("That PDF couldn't be opened — it may be damaged or locked.");
    if (pages > PDF_MAX_PAGES) throw new ReceiptReadRefusal(`That PDF has ${pages} pages — a receipt is a page or two.`);
  }
  const refused = await aiFilesRefused("receipts.read");
  if (refused) throw new ReceiptReadRefusal(refused);
  const name = (input.name || "receipt").replace(/[^\w .()-]+/g, "_").slice(0, 120);
  const read = await teammateWork(
    { teammate: "arjun", userId, kind: "receipts.read", subject: null, label: name, href: "/expenses", steps: RECEIPT_STEPS },
    async (work) => {
      let outcome;
      try {
        outcome = await aiTurn({
          userId,
          feature: "receipts.read",
          system: readReceiptSystem({ india: workspacePack().india, name: workspacePack().tax.name }),
          history: [{ role: "user", text: "Read this receipt.", files: [{ name, mediaType: file.type as InputFile["mediaType"], data: file.base64 }] }],
          tools: [PROPOSE_RECEIPT],
        });
      } catch (err) {
        if (err instanceof AiRefusal) throw new ReceiptReadRefusal(err.message);
        throw err;
      }
      await work.step(1);
      const call = outcome.toolCalls.find((c) => c.name === PROPOSE_RECEIPT.name);
      const parsed = call ? proposedReceiptSchema.safeParse(call.input) : null;
      if (!parsed?.success) throw new ReceiptReadRefusal("Arjun couldn't make the receipt out — try a clearer photo, or type it in.");
      if (parsed.data.merchant) await work.about(parsed.data.merchant);
      return parsed.data;
    },
    (r) => (r.notAReceipt ? "That wasn't a receipt" : r.total !== undefined ? `Read ${formatMoney(r.total)} — your claim is filled in` : "Read — check the amount"),
  );
  const clock = await workspaceClock();
  const checks = checkReceipt(read, { today: clock.today(), baseCurrency: baseCurrency(), sameClaim: await sameClaimOf(userId, read, input.expenseId ?? null), tax: { india: workspacePack().india, name: workspacePack().tax.name } });
  return { read, checks, fill: receiptFill(read, baseCurrency()) };
}
