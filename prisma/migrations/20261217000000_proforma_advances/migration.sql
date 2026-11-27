-- Advances received against a proforma invoice (owner, 17 Nov 2026): which proforma an on-account payment was for, so
-- the tax invoice raised from it — or from the orders punched from it — takes the advance when it is issued.
CREATE TABLE "proforma_advances" (
    "paymentId" TEXT NOT NULL,
    "proformaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proforma_advances_pkey" PRIMARY KEY ("paymentId")
);

CREATE INDEX "proforma_advances_proformaId_idx" ON "proforma_advances"("proformaId");

