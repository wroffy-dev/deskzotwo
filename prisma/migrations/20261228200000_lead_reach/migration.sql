-- Whether leads "as the account" also reach the leads a role's people own and made (owner, 26 Nov 2026 — src/lib/authz/access.ts
-- `leadsFollowing`). No row is both on: what every workspace has had since 45719fff and 457d1c26.
CREATE TABLE "role_lead_reach" (
    "role" TEXT NOT NULL,
    "owned" BOOLEAN NOT NULL DEFAULT true,
    "made" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_lead_reach_pkey" PRIMARY KEY ("role")
);

-- One person's own answer over their role's; a null column follows the role.
CREATE TABLE "user_lead_reach" (
    "userId" TEXT NOT NULL,
    "owned" BOOLEAN,
    "made" BOOLEAN,
    "reason" TEXT,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_lead_reach_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "role_lead_reach" ADD CONSTRAINT "role_lead_reach_role_fkey" FOREIGN KEY ("role") REFERENCES "roles"("key") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_lead_reach" ADD CONSTRAINT "user_lead_reach_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_lead_reach" ADD CONSTRAINT "user_lead_reach_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
