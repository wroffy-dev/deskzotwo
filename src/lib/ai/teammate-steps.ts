/**
 * The steps of each AI teammate's job, in words (src/lib/ai/teammate-work.ts) — each a real stage of the code that does
 * it, in order. Pure, so a card can show a job's steps before its first report comes back.
 */

/** Ved's Research & plan — `makePlan`, src/lib/research/plan-server.ts. */
export const PLAN_STEPS = ["Reading the record", "Checking public sources — website, GST, news", "Writing the plan", "Saving it"];

/** The same outside India, where there is no GST register to read (src/lib/research/gather.ts). */
export const PLAN_STEPS_ABROAD = ["Reading the record", "Checking public sources — website, news", "Writing the plan", "Saving it"];

export const planSteps = (india: boolean) => (india ? PLAN_STEPS : PLAN_STEPS_ABROAD);

/** Ved's research brief — `writeCompanyBrief`, src/actions/research.ts. */
export const BRIEF_STEPS = ["Reading what was found", "Writing the brief"];

/** Mira's workflow draft — `draftWithAI`, src/lib/automate/ai/draft.ts, then saved by src/actions/automate.ts. */
export const WORKFLOW_STEPS = ["Reading what Automate can do here", "Drafting the workflow", "Checking it, and fixing what's off", "Saving it as a draft"];

/** Arjun reading bank lines the rules couldn't place — `askAboutMoneyIn`, src/lib/bank-match/server.ts. */
export const BANK_MATCH_STEPS = ["Reading the narrations", "Finding the customers and invoices", "Leaving them for you to confirm"];

/** Arjun reading an expense receipt — `readReceipt`, src/lib/bill-reader/receipt-server.ts. */
export const RECEIPT_STEPS = ["Reading the receipt", "Filling in your claim"];

/** Arjun reading a vendor's bill — `readBill`, src/lib/bill-reader/server.ts. */
export const BILL_STEPS = ["Reading the vendor's file", "Making out the lines, GST and totals", "Leaving it for you to check"];

/** Priya answering somebody's HR question — `askPriya`, src/lib/hr-desk/server.ts. */
export const HR_ANSWER_STEPS = ["Reading your own records", "Checking the HR guides", "Writing the answer"];

/** Arjun's chase email — `draftChase`, src/lib/collections/chase-server.ts. */
export const CHASE_STEPS = ["Reading what's owed and what was said", "Writing the email", "Checking every amount against your books", "Leaving it for you to check"];

/** Arjun reading a customer's reply — `readChaseReplies`, src/lib/collections/chase-server.ts. */
export const REPLY_STEPS = ["Reading their reply", "Working out what they mean", "Leaving it for you to act on"];

/** Tara's check-in to a quiet customer — `draftCheckIn`, src/lib/reengage/server.ts. */
export const REENGAGE_STEPS = ["Reading what they bought and when", "Writing the check-in", "Leaving it for the account manager"];

/** Tara's follow-up draft — `runNurture`, src/lib/nurture/server.ts. */
export const NURTURE_STEPS = ["Reading the plan and what was sent", "Writing the email", "Leaving it for you to check"];
