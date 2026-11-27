-- One switch for deleting payments (owner, 1 Nov 2026): the payment Delete scope now decides alone, and starts from the
-- "Delete payments" permission. A scope stored before today was only ever half the rule (the permission was the other
-- half), so where its holder lacked the permission it becomes None — nobody gains a delete they didn't have.
-- The permission's defaults: ACCOUNTS, MANAGEMENT, and ADMIN (who holds every key unless denied).

-- A role lacks it: denied outright, or not given and not one of the defaults.
UPDATE "role_access_levels" r
SET "level" = 'NONE', "updatedAt" = CURRENT_TIMESTAMP
WHERE r."record" = 'payments' AND r."action" = 'delete' AND r."level" <> 'NONE'
  AND NOT EXISTS (SELECT 1 FROM "role_permissions" p WHERE p."role" = r."role" AND p."permission" = 'payments.delete' AND p."allowed")
  AND (
    EXISTS (SELECT 1 FROM "role_permissions" p WHERE p."role" = r."role" AND p."permission" = 'payments.delete' AND NOT p."allowed")
    OR r."role" NOT IN ('ACCOUNTS', 'MANAGEMENT', 'ADMIN')
  );

-- A person lacks it: denied to them, or not given to them and their role lacks it.
UPDATE "user_access_levels" u
SET "level" = 'NONE', "updatedAt" = CURRENT_TIMESTAMP
FROM "users" s
WHERE s."id" = u."userId" AND u."record" = 'payments' AND u."action" = 'delete' AND u."level" <> 'NONE'
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" g
    WHERE g."userId" = u."userId" AND g."permission" = 'payments.delete' AND g."allowed" AND (g."expiresAt" IS NULL OR g."expiresAt" > CURRENT_TIMESTAMP)
  )
  AND (
    EXISTS (
      SELECT 1 FROM "user_permissions" g
      WHERE g."userId" = u."userId" AND g."permission" = 'payments.delete' AND NOT g."allowed" AND (g."expiresAt" IS NULL OR g."expiresAt" > CURRENT_TIMESTAMP)
    )
    OR (
      NOT EXISTS (SELECT 1 FROM "role_permissions" p WHERE p."role" = s."role" AND p."permission" = 'payments.delete' AND p."allowed")
      AND (
        EXISTS (SELECT 1 FROM "role_permissions" p WHERE p."role" = s."role" AND p."permission" = 'payments.delete' AND NOT p."allowed")
        OR s."role" NOT IN ('ACCOUNTS', 'MANAGEMENT', 'ADMIN')
      )
    )
  );
