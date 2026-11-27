-- Licence keys and files on a subscription, and what of them the customer's portal shows (owner, 29 Oct 2026 —
-- src/lib/custom-fields/secure.ts). A secret's value is kept encrypted on the record; a file in custom_field_files.
ALTER TYPE "CustomFieldType" ADD VALUE 'SECRET';
ALTER TYPE "CustomFieldType" ADD VALUE 'FILE';

-- Empty is no: nullable, so it stays out of an insert until it is set.
ALTER TABLE "custom_field_definitions" ADD COLUMN "showInPortal" BOOLEAN;

CREATE TABLE "custom_field_files" (
    "id" TEXT NOT NULL,
    "entity" "CustomFieldEntity" NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_files_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "custom_field_files_entity_fieldKey_idx" ON "custom_field_files"("entity", "fieldKey");

CREATE TABLE "custom_field_reveals" (
    "id" TEXT NOT NULL,
    "entity" "CustomFieldEntity" NOT NULL,
    "recordId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "byUserId" TEXT,
    "byPortalLogin" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "custom_field_reveals_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "custom_field_reveals_entity_recordId_idx" ON "custom_field_reveals"("entity", "recordId");
