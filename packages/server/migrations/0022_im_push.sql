CREATE TABLE notification_endpoints (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
  name text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('wecom','feishu','dingtalk','webhook')),
  endpoint_ciphertext bytea NOT NULL,
  secret_ciphertext bytea,
  legacy boolean NOT NULL DEFAULT false,
  next_send_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(team_id,id)
);
CREATE UNIQUE INDEX notification_endpoints_legacy ON notification_endpoints(team_id) WHERE legacy;
ALTER TABLE notification_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_endpoints
  USING (team_id = nullif(current_setting('app.team_id',true),'')::uuid)
  WITH CHECK (team_id = nullif(current_setting('app.team_id',true),'')::uuid);

ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_team_id_comment_id_key;
ALTER TABLE notification_deliveries ALTER COLUMN comment_id DROP NOT NULL;
ALTER TABLE notification_deliveries ADD COLUMN endpoint_id uuid;
ALTER TABLE notification_deliveries ADD COLUMN review_id uuid;
ALTER TABLE notification_deliveries ADD COLUMN batch_index integer NOT NULL DEFAULT 0;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_endpoint_fk
  FOREIGN KEY(team_id,endpoint_id) REFERENCES notification_endpoints(team_id,id) ON DELETE CASCADE;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_review_fk
  FOREIGN KEY(team_id,review_id) REFERENCES reviews(team_id,id);
CREATE UNIQUE INDEX notification_deliveries_comment ON notification_deliveries(team_id,endpoint_id,comment_id,batch_index) WHERE comment_id IS NOT NULL;
CREATE UNIQUE INDEX notification_deliveries_review ON notification_deliveries(team_id,endpoint_id,review_id,batch_index) WHERE comment_id IS NULL;
