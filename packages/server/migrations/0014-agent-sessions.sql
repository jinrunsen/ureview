CREATE TABLE agent_sessions (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    dsh_session_id text NOT NULL CHECK (length(dsh_session_id) BETWEEN 1 AND 512),
    kind text NOT NULL CHECK (kind IN ('review_generator','review_grader','rule_generation')),
    review_id uuid,
    rule_session_id uuid,
    model text NOT NULL,
    provider text NOT NULL,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
    last_seq integer NOT NULL DEFAULT -1 CHECK (last_seq >= -1),
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (team_id,id),
    CHECK ((kind IN ('review_generator','review_grader') AND review_id IS NOT NULL AND rule_session_id IS NULL)
        OR (kind='rule_generation' AND rule_session_id IS NOT NULL AND review_id IS NULL)),
    CHECK ((status='running') = (completed_at IS NULL)),
    FOREIGN KEY (team_id,review_id) REFERENCES reviews(team_id,id),
    FOREIGN KEY (team_id,rule_session_id) REFERENCES managed_rule_sessions(team_id,id)
);
CREATE INDEX agent_sessions_team_updated ON agent_sessions(team_id,updated_at DESC,id);
CREATE INDEX agent_sessions_review ON agent_sessions(team_id,review_id,created_at);
CREATE INDEX agent_sessions_rule ON agent_sessions(team_id,rule_session_id,created_at);

CREATE TABLE agent_session_events (
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    session_id uuid NOT NULL,
    seq integer NOT NULL CHECK (seq >= 0),
    event jsonb NOT NULL CHECK (jsonb_typeof(event)='object'),
    PRIMARY KEY (team_id,session_id,seq),
    FOREIGN KEY (team_id,session_id) REFERENCES agent_sessions(team_id,id)
);

ALTER TABLE agent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_sessions_team ON agent_sessions
    USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
ALTER TABLE agent_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_events FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_session_events_team ON agent_session_events
    USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
