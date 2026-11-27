-- The Customer inbox's fourth detail (owner, 25 Oct 2026): the company a customer is from, asked by the form
-- before a chat or by the bot, and the name a lead from the conversation goes on. Read by name (NOT_YET_EVERYWHERE).

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "customerCompany" TEXT;
