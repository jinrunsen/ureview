CREATE TABLE reviews (
    id uuid PRIMARY KEY,
    repository_id uuid NOT NULL REFERENCES repositories(id),
    event_id text NOT NULL,
    iid bigint NOT NULL CHECK (iid > 0),
    head_sha text NOT NULL,
    title text NOT NULL,
    author text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    status_message text,
    failure_reason text,
    pull_request jsonb,
    read_files jsonb NOT NULL DEFAULT '[]',
    available_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (repository_id, event_id),
    UNIQUE (repository_id, iid, head_sha)
);

CREATE INDEX reviews_pending ON reviews (available_at, created_at) WHERE status = 'queued';

CREATE TABLE review_findings (
    id uuid PRIMARY KEY,
    review_id uuid NOT NULL REFERENCES reviews(id),
    payload jsonb NOT NULL
);

CREATE INDEX review_findings_review ON review_findings (review_id);
