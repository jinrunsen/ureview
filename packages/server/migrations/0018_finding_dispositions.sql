ALTER TABLE review_findings
  ADD COLUMN status text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Resolved','Dismissed','Ignored','Outdated')),
  ADD COLUMN disposition_version integer NOT NULL DEFAULT 0 CHECK (disposition_version >= 0);

DO $$ DECLARE tenant uuid; previous_team text := current_setting('app.team_id',true); BEGIN
  FOR tenant IN SELECT id FROM teams LOOP
    PERFORM set_config('app.team_id',tenant::text,true);
    UPDATE review_findings SET status=payload->>'status'
      WHERE payload->>'status' IN ('Pending','Resolved','Dismissed','Ignored','Outdated');
    UPDATE review_findings SET payload=jsonb_set(payload,'{fingerprint}',
      to_jsonb(encode(sha256(convert_to(payload->>'code','UTF8')),'hex')))
      WHERE jsonb_typeof(payload->'code')='string';
  END LOOP;
  PERFORM set_config('app.team_id',coalesce(previous_team,''),true);
END $$;

CREATE TABLE finding_disposition_events (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
  review_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  actor_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  previous_status text NOT NULL CHECK (previous_status IN ('Pending','Resolved','Dismissed','Ignored','Outdated')),
  status text NOT NULL CHECK (status IN ('Pending','Resolved','Dismissed')),
  reason_category text CHECK (reason_category IN ('false_positive','rule_not_applicable','rule_incorrect','not_worth_fixing','other')),
  explanation text CHECK (length(explanation) BETWEEN 1 AND 4000),
  version integer NOT NULL CHECK (version > 0),
  UNIQUE(team_id,finding_id,version),
  FOREIGN KEY(team_id,review_id,finding_id) REFERENCES review_findings(team_id,review_id,id),
  FOREIGN KEY(team_id,actor_id) REFERENCES team_members(team_id,user_id),
  CHECK ((status='Dismissed' AND reason_category IS NOT NULL AND (reason_category<>'other' OR explanation IS NOT NULL))
    OR (status<>'Dismissed' AND reason_category IS NULL AND explanation IS NULL))
);
ALTER TABLE finding_disposition_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_disposition_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finding_disposition_events
  USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
  WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
