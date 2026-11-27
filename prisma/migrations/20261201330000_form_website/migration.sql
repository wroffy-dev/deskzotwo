-- A form's pop-up on the business's website and its landing page (owner, 1 Nov 2026 — src/lib/forms/website.ts).
CREATE TABLE "form_websites" (
    "formId" TEXT NOT NULL,
    "popup" JSONB,
    "landing" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "form_websites_pkey" PRIMARY KEY ("formId")
);
ALTER TABLE "form_websites" ADD CONSTRAINT "form_websites_formId_fkey" FOREIGN KEY ("formId") REFERENCES "marketing_forms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
