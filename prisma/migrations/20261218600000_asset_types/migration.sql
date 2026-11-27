-- Asset types each workspace manages (18 Nov 2026 — src/lib/assets/types.ts). Deskzo's eleven kinds become the starting
-- list, with fixed ids, and every asset is given the type of its kind. assets."typeId" is read by name, and listed in
-- NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts) until every workspace has it.
CREATE TABLE "asset_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "builtIn" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "asset_types_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "asset_types_name_key" ON "asset_types"("name");

ALTER TABLE "assets" ADD COLUMN "typeId" TEXT;

ALTER TABLE "assets" ADD CONSTRAINT "assets_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "asset_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "assets_typeId_idx" ON "assets"("typeId");

INSERT INTO "asset_types" ("id", "name", "kind", "builtIn", "sortOrder", "updatedAt") VALUES
    ('atype_laptop', 'Laptop', 'LAPTOP', true, 10, CURRENT_TIMESTAMP),
    ('atype_desktop', 'Desktop', 'DESKTOP', true, 20, CURRENT_TIMESTAMP),
    ('atype_server', 'Server', 'SERVER', true, 30, CURRENT_TIMESTAMP),
    ('atype_monitor', 'Monitor', 'MONITOR', true, 40, CURRENT_TIMESTAMP),
    ('atype_printer', 'Printer', 'PRINTER', true, 50, CURRENT_TIMESTAMP),
    ('atype_network', 'Network device', 'NETWORK', true, 60, CURRENT_TIMESTAMP),
    ('atype_phone', 'Phone', 'PHONE', true, 70, CURRENT_TIMESTAMP),
    ('atype_tablet', 'Tablet', 'TABLET', true, 80, CURRENT_TIMESTAMP),
    ('atype_peripheral', 'Peripheral', 'PERIPHERAL', true, 90, CURRENT_TIMESTAMP),
    ('atype_software_licence', 'Software licence', 'SOFTWARE_LICENCE', true, 100, CURRENT_TIMESTAMP),
    ('atype_other', 'Other', 'OTHER', true, 110, CURRENT_TIMESTAMP);

UPDATE "assets" SET "typeId" = 'atype_' || lower("kind"::text) WHERE "typeId" IS NULL;
