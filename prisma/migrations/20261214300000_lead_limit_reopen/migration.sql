-- Security audit round three, 14 Nov 2026 (low, "reopening a closed lead skips the open-leads limit"). SQL only — no
-- schema change.
--
-- The backstop from 20261213090000_lead_limits checked a write only when it gave a lead a new owner: its trigger fired
-- on UPDATE OF "ownerUserId" alone, and the function returned at once when the owner was unchanged. A won, lost or
-- disqualified lead moved back to an open stage became an open lead on its owner with no check at all. Now the trigger
-- also fires on a change of "status", and a closed → open change for the same owner is checked against that owner's
-- open-leads limit (only that one: reopening isn't an assignment, so the day's count doesn't apply). Everything else
-- is as it was; the app checks first (claimLeadCapacity in src/actions/lead.ts updateLeadStatus).

CREATE OR REPLACE FUNCTION check_lead_limit() RETURNS trigger AS $$
DECLARE
  v_limited boolean;
  v_open integer;
  v_day integer;
  v_zone text;
  v_from timestamp;
  v_count integer;
  v_kind text;
  v_max integer;
  v_mode text;
  v_reopen boolean := false;
BEGIN
  IF NEW."ownerUserId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."ownerUserId" IS NOT DISTINCT FROM OLD."ownerUserId" THEN
    -- The same owner: only a closed lead opened again is checked, and only against the open-leads limit.
    IF OLD."status" IN ('WON', 'LOST', 'DISQUALIFIED') AND NEW."status" NOT IN ('WON', 'LOST', 'DISQUALIFIED') THEN
      v_reopen := true;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  -- Their own row, unexpired, over their role's; neither is no limit.
  SELECT "limited", "maxOpen", "maxPerDay" INTO v_limited, v_open, v_day
    FROM "user_lead_limits"
    WHERE "userId" = NEW."ownerUserId" AND ("expiresAt" IS NULL OR "expiresAt" > (now() AT TIME ZONE 'UTC'));
  IF FOUND THEN
    IF NOT v_limited THEN
      RETURN NEW;
    END IF;
  ELSE
    SELECT r."maxOpen", r."maxPerDay" INTO v_open, v_day
      FROM "users" u JOIN "role_lead_limits" r ON r."role" = u."role"
      WHERE u."id" = NEW."ownerUserId";
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;
  IF v_reopen THEN
    v_day := NULL;
  END IF;
  IF v_open IS NULL AND v_day IS NULL THEN
    RETURN NEW;
  END IF;
  -- The super admin has no limit.
  IF EXISTS (SELECT 1 FROM "users" WHERE "id" = NEW."ownerUserId" AND "isSuperAdmin") THEN
    RETURN NEW;
  END IF;

  IF v_open IS NOT NULL AND NEW."status" NOT IN ('WON', 'LOST', 'DISQUALIFIED') THEN
    SELECT count(*) INTO v_count FROM "leads"
      WHERE "ownerUserId" = NEW."ownerUserId" AND "status" NOT IN ('WON', 'LOST', 'DISQUALIFIED') AND "id" <> NEW."id";
    IF v_count + 1 > v_open THEN
      v_kind := 'open';
      v_max := v_open;
    END IF;
  END IF;

  IF v_kind IS NULL AND v_day IS NOT NULL THEN
    SELECT "timeZone" INTO v_zone FROM "lead_limit_settings" WHERE "id" = 'global';
    v_zone := COALESCE(v_zone, 'Asia/Kolkata');
    v_from := (date_trunc('day', now() AT TIME ZONE v_zone) AT TIME ZONE v_zone) AT TIME ZONE 'UTC';
    SELECT count(*) INTO v_count FROM "lead_assignments"
      WHERE "userId" = NEW."ownerUserId" AND "assignedAt" >= v_from;
    IF v_count + 1 > v_day THEN
      v_kind := 'perDay';
      v_max := v_day;
    END IF;
  END IF;

  IF v_kind IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "limitTrigger" INTO v_mode FROM "lead_limit_settings" WHERE "id" = 'global';
  IF v_mode = 'enforce' THEN
    RAISE EXCEPTION 'lead_limit_exceeded:%:%:%:%', v_kind, NEW."ownerUserId", v_count, v_max
      USING ERRCODE = 'DZL01', HINT = 'A lead limit set in Deskzo (src/lib/leads/limits.ts).';
  END IF;
  INSERT INTO "lead_limit_warnings" ("leadId", "userId", "limitKind", "maxAllowed", "counted", "path")
    VALUES (NEW."id", NEW."ownerUserId", v_kind, v_max, v_count,
            COALESCE(NULLIF(current_setting('deskzo.lead_path', true), ''), NULLIF(current_setting('application_name', true), '')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fired by a change of status too, so a lead reopened by any path (the board, Automate, an import, a script) is seen.
DROP TRIGGER IF EXISTS leads_check_limit ON "leads";
CREATE TRIGGER leads_check_limit
  BEFORE INSERT OR UPDATE OF "ownerUserId", "status" ON "leads"
  FOR EACH ROW EXECUTE FUNCTION check_lead_limit();
