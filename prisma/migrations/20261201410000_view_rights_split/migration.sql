-- Three views as their own rights (owner, 2 Nov 2026): the Contacts directory apart from a customer's Contacts tab,
-- the Statement tab apart from payments, and a customer's Commission tab. Nobody gains or loses anything on the day:
--   · contacts.directory copies every stored View contacts answer, role and person, grants and denials;
--   · statements.view copies every stored View payments answer the same way;
--   · commissions.view is given to every role but Admin (who holds every key unless denied), since the tab
--     showed to anybody who could open the customer.
-- The built-in defaults already match (src/lib/permissions.ts).

INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT "role", 'contacts.directory', "allowed", CURRENT_TIMESTAMP
FROM "role_permissions"
WHERE "permission" = 'contacts.view'
ON CONFLICT ("role", "permission") DO NOTHING;

INSERT INTO "user_permissions" ("userId", "permission", "allowed", "reason", "grantedById", "expiresAt", "createdAt", "updatedAt")
SELECT "userId", 'contacts.directory', "allowed",
       COALESCE("reason", 'Copied from View contacts when the Contacts directory became its own permission'),
       "grantedById", "expiresAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "user_permissions"
WHERE "permission" = 'contacts.view'
ON CONFLICT ("userId", "permission") DO NOTHING;

INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT "role", 'statements.view', "allowed", CURRENT_TIMESTAMP
FROM "role_permissions"
WHERE "permission" = 'payments.view'
ON CONFLICT ("role", "permission") DO NOTHING;

INSERT INTO "user_permissions" ("userId", "permission", "allowed", "reason", "grantedById", "expiresAt", "createdAt", "updatedAt")
SELECT "userId", 'statements.view', "allowed",
       COALESCE("reason", 'Copied from View payments when statements became their own permission'),
       "grantedById", "expiresAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "user_permissions"
WHERE "permission" = 'payments.view'
ON CONFLICT ("userId", "permission") DO NOTHING;

INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT "key", 'commissions.view', true, CURRENT_TIMESTAMP
FROM "roles"
WHERE "key" <> 'ADMIN'
ON CONFLICT ("role", "permission") DO NOTHING;
