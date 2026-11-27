-- Field masking's master switch (owner, 30 Oct 2026): one row, "global"; no row is on, so nothing changes until a
-- super admin switches it off.
CREATE TABLE "field_masking_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_masking_settings_pkey" PRIMARY KEY ("id")
);
