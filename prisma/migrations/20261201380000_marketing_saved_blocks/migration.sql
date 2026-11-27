-- Blocks saved in the email builder to reuse in any email (owner, 1 Nov 2026).
CREATE TABLE "marketing_saved_blocks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "blocks" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_saved_blocks_pkey" PRIMARY KEY ("id")
);
