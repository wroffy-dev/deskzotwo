-- Deskzo AI drafts leads too (src/lib/copilot/tools.ts, propose_lead).
ALTER TYPE "CopilotProposalKind" ADD VALUE IF NOT EXISTS 'LEAD';
