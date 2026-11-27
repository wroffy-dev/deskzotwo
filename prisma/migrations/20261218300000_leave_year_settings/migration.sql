-- The leave year: April to March, or January to December (src/lib/hr/leave-year.ts).
CREATE TABLE "leave_year_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "rules" JSONB NOT NULL DEFAULT '[]',
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leave_year_settings_pkey" PRIMARY KEY ("id")
);
