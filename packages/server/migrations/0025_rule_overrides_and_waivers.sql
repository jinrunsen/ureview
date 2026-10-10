ALTER TABLE managed_rules ADD COLUMN overrides jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(overrides)='array');
DO $$ DECLARE tenant uuid; previous_team text := current_setting('app.team_id',true); BEGIN
  FOR tenant IN SELECT id FROM teams LOOP
    PERFORM set_config('app.team_id',tenant::text,true);
UPDATE managed_rule_sessions SET working_copy='{"overrides":[]}'::jsonb || working_copy WHERE working_copy IS NOT NULL;
    UPDATE rule_catalog SET payload='{"overrides":[]}'::jsonb || payload WHERE payload->>'kind' IS DISTINCT FROM 'lint';
  END LOOP;
  PERFORM set_config('app.team_id',coalesce(previous_team,''),true);
END $$;


CREATE TABLE managed_rule_waivers (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    rule_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
    created_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_by uuid,
    revoked_at timestamptz,
    CHECK ((revoked_by IS NULL) = (revoked_at IS NULL)),
    FOREIGN KEY(team_id,rule_id) REFERENCES managed_rules(team_id,id) ON DELETE CASCADE,
    FOREIGN KEY(team_id,repository_id) REFERENCES repositories(team_id,id),
    FOREIGN KEY(team_id,created_by) REFERENCES team_members(team_id,user_id),
    FOREIGN KEY(team_id,revoked_by) REFERENCES team_members(team_id,user_id)
);
CREATE UNIQUE INDEX managed_rule_waivers_active ON managed_rule_waivers(team_id,rule_id,repository_id) WHERE revoked_at IS NULL;
ALTER TABLE managed_rule_waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_rule_waivers FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_rule_waivers_team ON managed_rule_waivers
    USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
