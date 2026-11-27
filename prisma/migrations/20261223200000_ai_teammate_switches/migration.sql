-- An AI teammate switched on or off in this workspace (owner, 23 Nov 2026 — Settings › AI teammates). No row: on.

-- CreateTable
CREATE TABLE "ai_teammate_switches" (
    "key" TEXT NOT NULL,
    "on" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_teammate_switches_pkey" PRIMARY KEY ("key")
);
