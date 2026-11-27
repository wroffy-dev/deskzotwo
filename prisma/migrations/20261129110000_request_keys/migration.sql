-- One record per request (owner, 29 Oct 2026 — src/lib/request-once.ts): a payment, document or expense saved
-- twice — a double click, a retry after an answer that never came, the form sent from two tabs — is the one it
-- already made. The key is claimed before the write, so of two sends at once only one makes it.
CREATE TABLE "request_keys" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_keys_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "request_keys_createdAt_idx" ON "request_keys"("createdAt");
