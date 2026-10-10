ALTER TABLE auth_users ADD COLUMN service_role text NOT NULL DEFAULT 'user' CHECK (service_role IN ('user','service_admin'));
UPDATE auth_users SET service_role='service_admin' WHERE id=(SELECT u.id FROM auth_users u JOIN team_members m ON m.user_id=u.id WHERE m.role='admin' ORDER BY u.created_at,u.id LIMIT 1);

CREATE TABLE service_model_keys (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generator bytea,
  grader bytea,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_by uuid REFERENCES auth_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO service_model_keys(singleton) VALUES (true);
