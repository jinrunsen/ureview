CREATE TABLE managed_rule_sessions (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    rule_id uuid,
    rule_version integer CHECK (rule_version > 0),
    working_copy jsonb CHECK (working_copy IS NULL OR jsonb_typeof(working_copy)='object'),
    turns jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(turns)='array'),
    checkpoint jsonb,
    generation_id uuid,
    generation_started_at timestamptz,
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(team_id,id),
    CHECK ((rule_id IS NULL) = (rule_version IS NULL)),
    CHECK ((generation_id IS NULL) = (generation_started_at IS NULL)),
    FOREIGN KEY(team_id,rule_id) REFERENCES managed_rules(team_id,id),
    FOREIGN KEY(team_id,created_by) REFERENCES team_members(team_id,user_id),
    FOREIGN KEY(team_id,updated_by) REFERENCES team_members(team_id,user_id)
);
CREATE INDEX managed_rule_sessions_team_updated ON managed_rule_sessions(team_id,updated_at DESC,id);
CREATE INDEX managed_rule_sessions_rule ON managed_rule_sessions(team_id,rule_id);
ALTER TABLE managed_rule_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_rule_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_rule_sessions_team ON managed_rule_sessions
    USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
