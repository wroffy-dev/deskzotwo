-- Double opt-in (owner, 1 Nov 2026 — src/lib/marketing/double-opt-in.ts): the confirmation sent for a form's pending consent.
CREATE TABLE "marketing_consent_confirmations" (
    "consentId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "sentTo" TEXT NOT NULL,
    "sends" INTEGER NOT NULL DEFAULT 1,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "marketing_consent_confirmations_pkey" PRIMARY KEY ("consentId")
);
