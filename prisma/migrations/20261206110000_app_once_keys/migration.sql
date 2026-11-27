-- A create from the phone app happening once, when what was done offline is sent again (owner, 6 Nov 2026).
CREATE TABLE "app_once_keys" (
    "key" TEXT NOT NULL,
    "recordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_once_keys_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "app_once_keys_createdAt_idx" ON "app_once_keys"("createdAt");
