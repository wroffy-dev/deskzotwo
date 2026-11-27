-- Employee ID cards (owner, 31 Oct 2026): how the workspace's cards look. One row, "global".
CREATE TABLE "id_card_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "accentColor" TEXT,
    "showDepartment" BOOLEAN NOT NULL DEFAULT true,
    "showBloodGroup" BOOLEAN NOT NULL DEFAULT true,
    "showEmergencyContact" BOOLEAN NOT NULL DEFAULT true,
    "showJoinedOn" BOOLEAN NOT NULL DEFAULT false,
    "showWorkPhone" BOOLEAN NOT NULL DEFAULT false,
    "showEmail" BOOLEAN NOT NULL DEFAULT false,
    "showSignature" BOOLEAN NOT NULL DEFAULT true,
    "backNote" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "id_card_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "id_card_settings_one_row" CHECK ("id" = 'global')
);
