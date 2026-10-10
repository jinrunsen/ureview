CREATE TABLE rule_catalog (
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id', true), '')::uuid REFERENCES teams(id),
    repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    rule_id text NOT NULL,
    payload jsonb NOT NULL,
    synced_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, repository_id, rule_id),
    FOREIGN KEY (team_id, repository_id) REFERENCES repositories(team_id, id)
);

CREATE TABLE rule_sync_state (
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id', true), '')::uuid REFERENCES teams(id),
    repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    synced_at timestamptz,
    sync_error text,
    warnings jsonb NOT NULL DEFAULT '[]',
    mined_at timestamptz,
    mining_error text,
    mining_summary jsonb,
    PRIMARY KEY (team_id, repository_id),
    FOREIGN KEY (team_id, repository_id) REFERENCES repositories(team_id, id)
);

CREATE TABLE rule_candidates (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id', true), '')::uuid REFERENCES teams(id),
    repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    candidate_key text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (team_id, repository_id, candidate_key),
    FOREIGN KEY (team_id, repository_id) REFERENCES repositories(team_id, id)
);

ALTER TABLE rule_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY rule_catalog_team ON rule_catalog USING (team_id = nullif(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = nullif(current_setting('app.team_id', true), '')::uuid);
ALTER TABLE rule_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_sync_state FORCE ROW LEVEL SECURITY;
CREATE POLICY rule_sync_state_team ON rule_sync_state USING (team_id = nullif(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = nullif(current_setting('app.team_id', true), '')::uuid);
ALTER TABLE rule_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY rule_candidates_team ON rule_candidates USING (team_id = nullif(current_setting('app.team_id', true), '')::uuid) WITH CHECK (team_id = nullif(current_setting('app.team_id', true), '')::uuid);
