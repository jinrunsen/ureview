CREATE UNIQUE INDEX findings_team_review_identity ON review_findings(team_id,review_id,id);

CREATE TABLE discussion_comments (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
  review_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  author_id uuid NOT NULL,
  request_id uuid NOT NULL,
  parent_id uuid,
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(team_id,id),
  UNIQUE(team_id,review_id,finding_id,id),
  UNIQUE(team_id,author_id,request_id),
  FOREIGN KEY(team_id,review_id,finding_id) REFERENCES review_findings(team_id,review_id,id),
  FOREIGN KEY(team_id,author_id) REFERENCES team_members(team_id,user_id),
  FOREIGN KEY(team_id,review_id,finding_id,parent_id) REFERENCES discussion_comments(team_id,review_id,finding_id,id)
);
CREATE INDEX discussion_comments_thread ON discussion_comments(team_id,review_id,finding_id,created_at,id);

CREATE TABLE discussion_notifications (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
  comment_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('mention','reply')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE(team_id,comment_id,recipient_id),
  FOREIGN KEY(team_id,comment_id) REFERENCES discussion_comments(team_id,id),
  FOREIGN KEY(team_id,recipient_id) REFERENCES team_members(team_id,user_id)
);
CREATE INDEX discussion_notifications_unread ON discussion_notifications(team_id,recipient_id) WHERE read_at IS NULL;

CREATE TABLE review_participants (
  team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
  review_id uuid NOT NULL,
  user_id uuid NOT NULL,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(team_id,review_id,user_id),
  FOREIGN KEY(team_id,review_id) REFERENCES reviews(team_id,id),
  FOREIGN KEY(team_id,user_id) REFERENCES team_members(team_id,user_id)
);

CREATE TABLE notification_settings (
  team_id uuid PRIMARY KEY DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
  endpoint text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
  comment_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','delivered','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE(team_id,comment_id),
  FOREIGN KEY(team_id,comment_id) REFERENCES discussion_comments(team_id,id)
);
CREATE INDEX notification_deliveries_pending ON notification_deliveries(team_id,available_at) WHERE status IN ('queued','sending');

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['discussion_comments','discussion_notifications','review_participants','notification_settings','notification_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (team_id = nullif(current_setting(''app.team_id'',true),'''')::uuid) WITH CHECK (team_id = nullif(current_setting(''app.team_id'',true),'''')::uuid)',table_name);
  END LOOP;
END $$;
