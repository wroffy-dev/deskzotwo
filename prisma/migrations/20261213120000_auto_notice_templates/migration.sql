-- The template a notice sent by itself uses (owner, 13 Nov 2026 — src/lib/marketing/auto-notice-template.ts): one row
-- per kind of notice ("RENEWAL" for the automatic renewal reminder). No row, or no template, is the built-in wording.
CREATE TABLE "auto_notice_templates" (
    "kind" TEXT NOT NULL,
    "templateId" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_notice_templates_pkey" PRIMARY KEY ("kind")
);
