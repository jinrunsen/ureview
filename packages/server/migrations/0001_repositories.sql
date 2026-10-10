CREATE TABLE repositories (
    id uuid PRIMARY KEY,
    instance_url text NOT NULL,
    project_id bigint NOT NULL CHECK (project_id > 0),
    name text NOT NULL,
    path_with_namespace text NOT NULL,
    web_url text NOT NULL,
    http_url_to_repo text NOT NULL,
    credential_ciphertext bytea NOT NULL,
    connected_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (instance_url, project_id)
);
