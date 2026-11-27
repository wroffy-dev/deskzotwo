-- A reseller's own link to ask for a quotation, and what they ask for (owner, 26 Nov 2026 — src/lib/quote-requests).
CREATE TABLE "quote_request_links" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "quote_request_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quote_requests" (
    "id" TEXT NOT NULL,
    "requestSeq" SERIAL NOT NULL,
    "linkId" TEXT NOT NULL,
    "resellerId" TEXT NOT NULL,
    "contactId" TEXT,
    "endCustomerName" TEXT NOT NULL,
    "endCustomerCountry" TEXT,
    "dealReference" TEXT,
    "neededBy" DATE,
    "deliveryLocation" TEXT,
    "budget" TEXT,
    "notes" TEXT,
    "fileName" TEXT,
    "fileMime" TEXT,
    "fileSize" INTEGER,
    "fileDataUrl" TEXT,
    "assignedToUserId" TEXT,
    "declinedAt" TIMESTAMP(3),
    "declinedById" TEXT,
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quote_request_lines" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "brand" TEXT,
    "notes" TEXT,

    CONSTRAINT "quote_request_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quote_request_links_tokenHash_key" ON "quote_request_links"("tokenHash");
CREATE INDEX "quote_request_links_resellerId_idx" ON "quote_request_links"("resellerId");
CREATE UNIQUE INDEX "quote_requests_requestSeq_key" ON "quote_requests"("requestSeq");
CREATE INDEX "quote_requests_resellerId_createdAt_idx" ON "quote_requests"("resellerId", "createdAt");
CREATE INDEX "quote_request_lines_requestId_idx" ON "quote_request_lines"("requestId");

ALTER TABLE "quote_request_lines" ADD CONSTRAINT "quote_request_lines_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "quote_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
