-- Field rules (owner, 12 Nov 2026): what an admin makes compulsory or holds to a format on a company, a contact or
-- a lead — a built-in field or one of the workspace's own. Checked whenever one is saved by a person: the forms, the
-- phone app, the API and imports (src/lib/field-rules). None to begin with, so nothing changes until an admin adds one.

CREATE TABLE "field_rules" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,
    "pattern" TEXT,
    "patternValue" TEXT,
    "when" JSONB,
    "newOnly" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "field_rules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "field_rules_entity_active_idx" ON "field_rules"("entity", "active");
