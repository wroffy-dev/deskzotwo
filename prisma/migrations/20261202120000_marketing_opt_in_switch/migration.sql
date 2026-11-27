-- Marketing without a recorded opt-in (owner, 2 Nov 2026: "lets remove optin conditions"): asking for one becomes a
-- switch, off by default. An opt-out still holds a person back whatever it says.
ALTER TABLE "marketing_policies" ADD COLUMN "requireOptIn" BOOLEAN NOT NULL DEFAULT false;
