-- A statutory filing marked done, so its reminder stops (src/lib/compliance/deadlines.ts).

-- CreateTable
CREATE TABLE "compliance_filings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filedOn" DATE NOT NULL,
    "filedById" TEXT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_filings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compliance_filings_key_key" ON "compliance_filings"("key");
