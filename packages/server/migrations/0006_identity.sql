CREATE TABLE teams (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO teams (id,name) VALUES ('00000000-0000-4000-8000-000000000001','默认团队');

CREATE TABLE auth_users (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email=lower(email)),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_members (
    team_id uuid NOT NULL REFERENCES teams(id),
    user_id uuid NOT NULL REFERENCES auth_users(id),
    role text NOT NULL CHECK (role IN ('admin','member')),
    PRIMARY KEY (team_id,user_id)
);
CREATE TABLE auth_sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth_users(id),
    team_id uuid NOT NULL REFERENCES teams(id),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (team_id,user_id) REFERENCES team_members(team_id,user_id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_expiration ON auth_sessions (expires_at);
CREATE TABLE auth_attempts (
    key_hash text PRIMARY KEY,
    attempts integer NOT NULL,
    window_start timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE repositories ADD COLUMN team_id uuid NOT NULL DEFAULT
    coalesce(nullif(current_setting('app.team_id',true),''),'00000000-0000-4000-8000-000000000001')::uuid REFERENCES teams(id);
ALTER TABLE repositories DROP CONSTRAINT repositories_instance_url_project_id_key;
ALTER TABLE repositories ADD UNIQUE (team_id,instance_url,project_id), ADD UNIQUE (team_id,id);

ALTER TABLE reviews ADD COLUMN team_id uuid NOT NULL DEFAULT
    coalesce(nullif(current_setting('app.team_id',true),''),'00000000-0000-4000-8000-000000000001')::uuid REFERENCES teams(id);
ALTER TABLE reviews ADD UNIQUE (team_id,id), ADD FOREIGN KEY (team_id,repository_id) REFERENCES repositories(team_id,id);
ALTER TABLE review_findings ADD COLUMN team_id uuid NOT NULL DEFAULT
    coalesce(nullif(current_setting('app.team_id',true),''),'00000000-0000-4000-8000-000000000001')::uuid REFERENCES teams(id);
ALTER TABLE review_findings ADD UNIQUE (team_id,id), ADD FOREIGN KEY (team_id,review_id) REFERENCES reviews(team_id,id);
ALTER TABLE review_deliveries ADD COLUMN team_id uuid NOT NULL DEFAULT
    coalesce(nullif(current_setting('app.team_id',true),''),'00000000-0000-4000-8000-000000000001')::uuid REFERENCES teams(id);
ALTER TABLE review_deliveries ADD FOREIGN KEY (team_id,repository_id) REFERENCES repositories(team_id,id),
    ADD FOREIGN KEY (team_id,review_id) REFERENCES reviews(team_id,id);

ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories FORCE ROW LEVEL SECURITY;
CREATE POLICY team_isolation ON repositories USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY team_isolation ON reviews USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
ALTER TABLE review_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_findings FORCE ROW LEVEL SECURITY;
CREATE POLICY team_isolation ON review_findings USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
ALTER TABLE review_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY team_isolation ON review_deliveries USING (team_id=nullif(current_setting('app.team_id',true),'')::uuid)
    WITH CHECK (team_id=nullif(current_setting('app.team_id',true),'')::uuid);
