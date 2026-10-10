ALTER TABLE auth_users
  ADD COLUMN im_mobile text,
  ADD COLUMN feishu_open_id text,
  ADD COLUMN feishu_user_id text,
  ADD CONSTRAINT auth_users_feishu_identity CHECK (feishu_open_id IS NULL OR feishu_user_id IS NULL);

CREATE TABLE auth_gitlab_identities (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  instance_url text NOT NULL,
  username text NOT NULL CHECK (length(username) BETWEEN 1 AND 255),
  PRIMARY KEY (user_id, instance_url)
);
CREATE UNIQUE INDEX auth_gitlab_username_unique ON auth_gitlab_identities(instance_url, lower(username));
