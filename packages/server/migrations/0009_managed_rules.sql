CREATE TABLE managed_rules (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
    body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 12000),
    good_example text NOT NULL CHECK (length(good_example) <= 12000),
    bad_example text NOT NULL CHECK (length(bad_example) <= 12000),
    category text NOT NULL CHECK (category IN ('security','correctness','quality','reliability','performance','testability','compliance','accessibility','observability','architecture')),
    severity text NOT NULL CHECK (severity IN ('error','warning','recommendation')),
    scope text NOT NULL CHECK (scope IN ('global','repositories')),
    status text NOT NULL CHECK (status IN ('draft','active')),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    UNIQUE(team_id,id),
    FOREIGN KEY(team_id,created_by) REFERENCES team_members(team_id,user_id),
    FOREIGN KEY(team_id,updated_by) REFERENCES team_members(team_id,user_id)
);
CREATE INDEX managed_rules_team_status ON managed_rules(team_id,status);
CREATE TABLE managed_rule_repositories (
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    rule_id uuid NOT NULL,
    repository_id uuid NOT NULL,
    paths jsonb NOT NULL CHECK (jsonb_typeof(paths)='array'),
    PRIMARY KEY(team_id,rule_id,repository_id),
    FOREIGN KEY(team_id,rule_id) REFERENCES managed_rules(team_id,id) ON DELETE CASCADE,
    FOREIGN KEY(team_id,repository_id) REFERENCES repositories(team_id,id)
);
ALTER TABLE managed_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_rules_team ON managed_rules
    USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
ALTER TABLE managed_rule_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE managed_rule_repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY managed_rule_repositories_team ON managed_rule_repositories
    USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
