-- Cloud calling's incoming choice (owner, 30 Oct 2026): whether a customer's missed call becomes a callback.
-- On for every connection already made, as before.
ALTER TABLE "telephony_connections" ADD COLUMN "incomingCallbacks" BOOLEAN NOT NULL DEFAULT true;
