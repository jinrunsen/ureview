DROP TABLE review_settings;

CREATE TABLE repository_review_settings (
    repository_id uuid PRIMARY KEY,
    team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    excluded_directories jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(excluded_directories)='array' AND jsonb_array_length(excluded_directories)<=100),
    version integer NOT NULL DEFAULT 1 CHECK (version>0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (team_id,repository_id) REFERENCES repositories(team_id,id) ON DELETE CASCADE
);
ALTER TABLE repository_review_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE repository_review_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY team_isolation ON repository_review_settings
    USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
