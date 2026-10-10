ALTER TABLE reviews ADD COLUMN failure_code text
    CHECK (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9_]{0,80}$');
DO $$ DECLARE tenant uuid; previous_team text := current_setting('app.team_id',true); BEGIN
  FOR tenant IN SELECT id FROM teams LOOP
    PERFORM set_config('app.team_id',tenant::text,true);
    UPDATE reviews SET failure_code='operation_failed' WHERE status='failed';
  END LOOP;
  PERFORM set_config('app.team_id',coalesce(previous_team,''),true);
END $$;
CREATE INDEX reviews_health_completed ON reviews(completed_at) WHERE status IN ('completed','failed');

CREATE TABLE service_model_health (
    phase text PRIMARY KEY CHECK (phase IN ('generator','grader')),
    last_success_at timestamptz,
    last_failure_at timestamptz,
    last_failure_code text CHECK (last_failure_code IN ('invalid_config','authentication_failed','model_not_found',
        'rate_limited','timeout','security_plugin_required','protocol_error','connection_failed')),
    CHECK ((last_failure_at IS NULL) = (last_failure_code IS NULL))
);
