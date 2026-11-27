-- The sunset rule (owner, 1 Nov 2026 — src/lib/marketing/policy.ts): one row of workspace-wide marketing rules.
CREATE TABLE "marketing_policies" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "sunsetDays" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_policies_pkey" PRIMARY KEY ("id")
);
