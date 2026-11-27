-- What each workspace's people do, counted nightly from its own logs (owner, 23 Nov 2026 — the console's Adoption tab).
-- Counts only: people are numbered, never named (src/lib/platform/adoption.ts).
CREATE TABLE "tenant_activity_days" (
    "tenantId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "activeUsers" INTEGER NOT NULL,
    "signIns" INTEGER NOT NULL,
    "activeMinutes" INTEGER NOT NULL,
    "changes" INTEGER NOT NULL,
    "areas" JSONB NOT NULL,
    "modulesOn" TEXT[],
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_activity_days_pkey" PRIMARY KEY ("tenantId","day")
);

CREATE TABLE "tenant_person_activity" (
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "lastSignInAt" TIMESTAMP(3),
    "lastActiveOn" DATE,
    "daysActive30" INTEGER NOT NULL,
    "minutes30" INTEGER NOT NULL,
    "changes30" INTEGER NOT NULL,
    "areas30" JSONB NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_person_activity_pkey" PRIMARY KEY ("tenantId","number")
);

ALTER TABLE "tenant_activity_days" ADD CONSTRAINT "tenant_activity_days_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenant_person_activity" ADD CONSTRAINT "tenant_person_activity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
