ALTER TABLE reviews
    DROP CONSTRAINT reviews_repository_id_iid_head_sha_key,
    DROP CONSTRAINT reviews_repository_id_event_id_key,
    ADD COLUMN round integer,
    ADD COLUMN trigger text NOT NULL DEFAULT 'automatic' CHECK (trigger IN ('automatic', 'manual')),
    ADD COLUMN viewed_at timestamptz;

WITH numbered AS (
    SELECT id, row_number() OVER (PARTITION BY repository_id, iid ORDER BY created_at, id) AS round
    FROM reviews
)
UPDATE reviews SET round=numbered.round FROM numbered WHERE reviews.id=numbered.id;

ALTER TABLE reviews ALTER COLUMN round SET NOT NULL;
ALTER TABLE reviews ADD CONSTRAINT reviews_positive_round CHECK (round > 0);
ALTER TABLE reviews ADD CONSTRAINT reviews_repository_round UNIQUE (repository_id, iid, round);
ALTER TABLE reviews ADD CONSTRAINT reviews_delivery UNIQUE (repository_id, trigger, event_id);
CREATE TABLE review_deliveries (
    repository_id uuid NOT NULL REFERENCES repositories(id),
    trigger text NOT NULL CHECK (trigger IN ('automatic', 'manual')),
    event_id text NOT NULL,
    iid bigint NOT NULL CHECK (iid > 0),
    review_id uuid REFERENCES reviews(id),
    PRIMARY KEY (repository_id, trigger, event_id)
);

INSERT INTO review_deliveries (repository_id, trigger, event_id, iid, review_id)
SELECT repository_id, trigger, event_id, iid, id FROM reviews;
