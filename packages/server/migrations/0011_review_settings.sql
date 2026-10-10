CREATE TABLE review_settings (
    team_id uuid PRIMARY KEY DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
    excluded_directories jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(excluded_directories)='array' AND jsonb_array_length(excluded_directories)<=100),
    version integer NOT NULL DEFAULT 1 CHECK (version>0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE review_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY team_isolation ON review_settings
    USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);

ALTER TABLE reviews
    ADD COLUMN excluded_directories jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(excluded_directories)='array'),
    ADD COLUMN excluded_file_count integer NOT NULL DEFAULT 0 CHECK (excluded_file_count>=0);
