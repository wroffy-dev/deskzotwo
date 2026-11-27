-- Website activity: a chat somebody on the team started for a visitor on the site now (owner, 7 Nov 2026).
ALTER TABLE "web_visitors" ADD COLUMN "inviteConversationId" TEXT, ADD COLUMN "inviteAt" TIMESTAMP(3);
