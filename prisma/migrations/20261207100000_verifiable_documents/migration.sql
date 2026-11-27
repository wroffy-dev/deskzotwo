-- Verifiable documents (owner, 7 Nov 2026 — src/lib/verifiable): a certificate, licence, warranty or letter a workspace issues,
-- with a QR code and a public page that says whether it still stands. New table only.

-- CreateTable
CREATE TABLE "verifiable_documents" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "scope" TEXT,
    "companyId" TEXT,
    "issuedOn" DATE NOT NULL,
    "expiresOn" DATE,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnReason" TEXT,
    "withdrawnById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verifiable_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "verifiable_documents_token_key" ON "verifiable_documents"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verifiable_documents_number_key" ON "verifiable_documents"("number");

-- CreateIndex
CREATE INDEX "verifiable_documents_companyId_idx" ON "verifiable_documents"("companyId");

-- CreateIndex
CREATE INDEX "verifiable_documents_expiresOn_idx" ON "verifiable_documents"("expiresOn");

-- AddForeignKey
ALTER TABLE "verifiable_documents" ADD CONSTRAINT "verifiable_documents_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
