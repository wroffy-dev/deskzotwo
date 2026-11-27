-- A customer's subscriptions and renewals as their own permissions, apart from the Orders module (owner, 26 Nov 2026:
-- "separate permission for renewal and orders and subscription"). Nobody gains or loses anything on the day: each copies
-- every stored View orders answer, role and person, grants and denials. The built-in defaults already match
-- (src/lib/permissions.ts).

INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT "role", 'subscriptions.view', "allowed", CURRENT_TIMESTAMP
FROM "role_permissions"
WHERE "permission" = 'orders.view'
ON CONFLICT ("role", "permission") DO NOTHING;

INSERT INTO "user_permissions" ("userId", "permission", "allowed", "reason", "grantedById", "expiresAt", "createdAt", "updatedAt")
SELECT "userId", 'subscriptions.view', "allowed",
       COALESCE("reason", 'Copied from View orders when subscriptions became their own permission'),
       "grantedById", "expiresAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "user_permissions"
WHERE "permission" = 'orders.view'
ON CONFLICT ("userId", "permission") DO NOTHING;

INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT "role", 'renewals.view', "allowed", CURRENT_TIMESTAMP
FROM "role_permissions"
WHERE "permission" = 'orders.view'
ON CONFLICT ("role", "permission") DO NOTHING;

INSERT INTO "user_permissions" ("userId", "permission", "allowed", "reason", "grantedById", "expiresAt", "createdAt", "updatedAt")
SELECT "userId", 'renewals.view', "allowed",
       COALESCE("reason", 'Copied from View orders when renewals became their own permission'),
       "grantedById", "expiresAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "user_permissions"
WHERE "permission" = 'orders.view'
ON CONFLICT ("userId", "permission") DO NOTHING;
