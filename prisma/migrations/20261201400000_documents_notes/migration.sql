-- "Raise credit and debit notes" as its own permission (owner, 2 Nov 2026). Notes came with "Raise and issue sales
-- documents", which sales holds; now they are accounts'. The built-in Accounts and Management roles hold it by
-- default (src/lib/permissions.ts) and an admin holds every key unless denied. A stored "Raise and issue" grant is
-- copied onto it only where the same role or person also records payments — an accounts role built by hand keeps
-- its notes, a sales role built by hand loses them. Every stored denial of "Raise and issue" is copied as a denial.

INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT rp."role", 'documents.notes', rp."allowed", CURRENT_TIMESTAMP
FROM "role_permissions" rp
WHERE rp."permission" = 'documents.issue'
  AND (rp."allowed" = false
       OR EXISTS (SELECT 1 FROM "role_permissions" x WHERE x."role" = rp."role" AND x."permission" = 'payments.record' AND x."allowed"))
ON CONFLICT ("role", "permission") DO NOTHING;

INSERT INTO "user_permissions" ("userId", "permission", "allowed", "reason", "grantedById", "expiresAt", "createdAt", "updatedAt")
SELECT up."userId", 'documents.notes', up."allowed",
       COALESCE(up."reason", 'Copied from Raise and issue sales documents when credit and debit notes became their own permission'),
       up."grantedById", up."expiresAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "user_permissions" up
WHERE up."permission" = 'documents.issue'
  AND (up."allowed" = false
       OR EXISTS (SELECT 1 FROM "user_permissions" x WHERE x."userId" = up."userId" AND x."permission" = 'payments.record' AND x."allowed"))
ON CONFLICT ("userId", "permission") DO NOTHING;
