ALTER TABLE auth_users ALTER COLUMN password_hash DROP NOT NULL;
CREATE TABLE service_sso (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  configuration jsonb NOT NULL DEFAULT '{}',
  client_secret bytea,
  version integer NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES auth_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO service_sso DEFAULT VALUES;
CREATE TABLE auth_sso_bindings (
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider,subject),
  UNIQUE (user_id,provider)
);
CREATE TABLE auth_sso_attempts (
  state_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  nonce text,
  return_path text NOT NULL,
  binding_hash text NOT NULL,
  configuration_version integer NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_sso_attempts_expiry ON auth_sso_attempts(expires_at);
