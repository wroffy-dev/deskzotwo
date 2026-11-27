-- "Create leads" as its own permission (owner, 1 Nov 2026). Opening a lead came with "View leads" until today,
-- so every stored view setting is copied onto the new key: a role or a person who could view leads can create
-- them, and one denied viewing is denied creating. The built-in defaults already match (src/lib/permissions.ts),
-- and an admin holds every key unless denied. Nobody gains or loses anything on the day.

INSERT INTO "role_permissions" ("role", "permission", "allowed", "updatedAt")
SELECT "role", 'leads.create', "allowed", CURRENT_TIMESTAMP
FROM "role_permissions"
WHERE "permission" = 'leads.view'
ON CONFLICT ("role", "permission") DO NOTHING;

INSERT INTO "user_permissions" ("userId", "permission", "allowed", "reason", "grantedById", "expiresAt", "createdAt", "updatedAt")
SELECT "userId", 'leads.create', "allowed",
       COALESCE("reason", 'Copied from View leads when Create leads became its own permission'),
       "grantedById", "expiresAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "user_permissions"
WHERE "permission" = 'leads.view'
ON CONFLICT ("userId", "permission") DO NOTHING;
