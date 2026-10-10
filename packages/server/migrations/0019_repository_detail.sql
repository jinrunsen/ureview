ALTER TABLE repositories
    ADD COLUMN automatic_review_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN automatic_review_version integer NOT NULL DEFAULT 1 CHECK (automatic_review_version > 0),
    ADD COLUMN last_authentication_failure_at timestamptz;

CREATE TABLE repository_webhook_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    repository_id uuid NOT NULL,
    received_at timestamptz NOT NULL,
    event_type text NOT NULL,
    action text,
    iid bigint CHECK (iid > 0),
    result text NOT NULL CHECK (result IN ('queued','duplicate','ignored','failed')),
    reason text,
    review_id uuid,
    FOREIGN KEY (team_id,repository_id) REFERENCES repositories(team_id,id) ON DELETE CASCADE,
    FOREIGN KEY (team_id,review_id) REFERENCES reviews(team_id,id)
);
CREATE INDEX repository_webhook_events_recent ON repository_webhook_events(repository_id,received_at DESC,id DESC);
ALTER TABLE repository_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY team_isolation ON repository_webhook_events
    USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
