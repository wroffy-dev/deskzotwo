-- Service cycles (owner, 9 Nov 2026 — src/lib/service-cycles): a plan of repeating steps, run for a customer, its jobs
-- becoming tasks when they're near. New tables only.
CREATE TABLE "service_cycle_templates" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "months" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "service_cycle_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_cycle_templates_seq_key" ON "service_cycle_templates"("seq");

CREATE TABLE "service_cycle_steps" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstAfterMonths" INTEGER NOT NULL DEFAULT 0,
    "everyMonths" INTEGER,
    "showDaysBefore" INTEGER NOT NULL DEFAULT 14,
    "checklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "service_cycle_steps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "service_cycle_steps_templateId_idx" ON "service_cycle_steps"("templateId");
ALTER TABLE "service_cycle_steps" ADD CONSTRAINT "service_cycle_steps_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "service_cycle_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "service_cycles" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "templateId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderId" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "ownerUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "stoppedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "service_cycles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_cycles_seq_key" ON "service_cycles"("seq");
CREATE INDEX "service_cycles_companyId_idx" ON "service_cycles"("companyId");
CREATE INDEX "service_cycles_status_idx" ON "service_cycles"("status");
ALTER TABLE "service_cycles" ADD CONSTRAINT "service_cycles_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "service_cycle_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_cycles" ADD CONSTRAINT "service_cycles_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_cycles" ADD CONSTRAINT "service_cycles_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "service_jobs" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "taskId" TEXT,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "skippedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "service_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_jobs_taskId_key" ON "service_jobs"("taskId");
CREATE UNIQUE INDEX "service_jobs_cycleId_stepId_seq_key" ON "service_jobs"("cycleId", "stepId", "seq");
CREATE INDEX "service_jobs_dueDate_idx" ON "service_jobs"("dueDate");
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "service_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "service_cycle_steps"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "service_jobs" ADD CONSTRAINT "service_jobs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
