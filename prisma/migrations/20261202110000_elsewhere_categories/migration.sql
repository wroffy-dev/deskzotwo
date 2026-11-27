-- Installed elsewhere's categories become the workspace's own list (Settings › Lists, owner 2 Nov 2026). The nine
-- Deskzo came with keep their keys, so every entry keeps its category.

-- CreateTable
CREATE TABLE "elsewhere_category_options" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "elsewhere_category_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "elsewhere_category_options_key_key" ON "elsewhere_category_options"("key");

-- CreateIndex
CREATE UNIQUE INDEX "elsewhere_category_options_name_key" ON "elsewhere_category_options"("name");

INSERT INTO "elsewhere_category_options" ("id", "key", "name", "sortOrder", "updatedAt") VALUES
  ('ecat_security', 'SECURITY', 'Security', 1, CURRENT_TIMESTAMP),
  ('ecat_productivity', 'PRODUCTIVITY', 'Productivity', 2, CURRENT_TIMESTAMP),
  ('ecat_backup', 'BACKUP', 'Backup & recovery', 3, CURRENT_TIMESTAMP),
  ('ecat_cloud', 'CLOUD', 'Cloud & hosting', 4, CURRENT_TIMESTAMP),
  ('ecat_design', 'DESIGN', 'Design & engineering', 5, CURRENT_TIMESTAMP),
  ('ecat_network', 'NETWORK', 'Network & Wi-Fi', 6, CURRENT_TIMESTAMP),
  ('ecat_hardware', 'HARDWARE', 'Hardware', 7, CURRENT_TIMESTAMP),
  ('ecat_business_apps', 'BUSINESS_APPS', 'Business software', 8, CURRENT_TIMESTAMP),
  ('ecat_other', 'OTHER', 'Other', 9, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;
