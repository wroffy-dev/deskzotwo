-- "Research & plan" new leads by itself (owner, 18 Nov 2026 — src/lib/research/auto-plan.ts).
CREATE TABLE "auto_plan_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "perDay" INTEGER NOT NULL DEFAULT 25,
    "onSince" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_plan_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "auto_plan_runs" (
    "leadId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "chargedToId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_plan_runs_pkey" PRIMARY KEY ("leadId")
);

CREATE INDEX "auto_plan_runs_at_idx" ON "auto_plan_runs"("at");

ALTER TABLE "auto_plan_runs" ADD CONSTRAINT "auto_plan_runs_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
