-- Notification emails as templates the workspace's admins edit (16 Nov 2026), under Settings › Email notifications:
-- each kind's own subject and body, and the greeting, sign-off and footer every one goes in. New tables only, so a
-- workspace not migrated yet simply sends Deskzo's wording (src/lib/notifications/email-settings.ts).
CREATE TABLE "notification_email_wordings" (
    "type" "NotificationType" NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_email_wordings_pkey" PRIMARY KEY ("type")
);

CREATE TABLE "notification_email_layout" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "greeting" TEXT,
    "signOff" TEXT,
    "footer" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_email_layout_pkey" PRIMARY KEY ("id")
);
