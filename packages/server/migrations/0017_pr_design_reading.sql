ALTER TABLE reviews
    ADD COLUMN reading_status text CHECK (reading_status IN ('running','completed','failed')),
    ADD COLUMN reading_failure_reason text,
    ADD COLUMN reading jsonb CHECK (reading IS NULL OR jsonb_typeof(reading)='object'),
    ADD COLUMN reading_submissions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reading_submissions)='array'),
    ADD COLUMN requirement_sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(requirement_sources)='array'),
    ADD CONSTRAINT reviews_reading_completion CHECK ((reading_status='completed') IS NOT TRUE OR reading IS NOT NULL);

ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_kind_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_kind_check
    CHECK (kind IN ('review_reading','review_generator','review_grader','rule_generation'));
ALTER TABLE agent_sessions DROP CONSTRAINT agent_sessions_check;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_sessions_check
    CHECK ((kind IN ('review_reading','review_generator','review_grader') AND review_id IS NOT NULL AND rule_session_id IS NULL)
        OR (kind='rule_generation' AND rule_session_id IS NOT NULL AND review_id IS NULL));
