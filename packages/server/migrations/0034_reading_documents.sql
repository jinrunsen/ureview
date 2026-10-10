CREATE TABLE reading_documents (
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    id uuid NOT NULL,
    review_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
    failure_reason text,
    content jsonb CHECK (content IS NULL OR jsonb_typeof(content)='object'),
    metrics jsonb CHECK (metrics IS NULL OR jsonb_typeof(metrics)='object'),
    submissions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(submissions)='array'),
    read_files jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(read_files)='array'),
    model jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz,
    completed_at timestamptz,
    PRIMARY KEY (team_id,id),
    FOREIGN KEY (team_id,review_id) REFERENCES reviews(team_id,id) ON DELETE CASCADE,
    CHECK ((status='completed') = (content IS NOT NULL))
);
CREATE INDEX reading_documents_review ON reading_documents(team_id,review_id,created_at);
CREATE INDEX reading_documents_queued ON reading_documents(created_at) WHERE status='queued';
ALTER TABLE reading_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reading_documents USING(team_id=nullif(current_setting('app.team_id',true),'')::uuid) WITH CHECK(team_id=nullif(current_setting('app.team_id',true),'')::uuid);
