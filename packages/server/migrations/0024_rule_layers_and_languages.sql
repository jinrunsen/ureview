ALTER TABLE managed_rules
    ADD COLUMN layer text NOT NULL DEFAULT 'team' CHECK (layer IN ('principle','general','language','team')),
    ADD COLUMN languages jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(languages)='array');

DO $$ DECLARE tenant uuid; previous_team text := current_setting('app.team_id',true); BEGIN
  FOR tenant IN SELECT id FROM teams LOOP
    PERFORM set_config('app.team_id',tenant::text,true);
UPDATE managed_rule_sessions SET working_copy='{"layer":"team","languages":[]}'::jsonb || working_copy
    WHERE working_copy IS NOT NULL;
UPDATE managed_rule_sessions SET turns=(SELECT coalesce(jsonb_agg(
    CASE WHEN turn ? 'draft' THEN jsonb_set(turn,'{draft}','{"layer":"team","languages":[]}'::jsonb || (turn->'draft')) ELSE turn END
    ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(turns) WITH ORDINALITY AS entries(turn,position));

    UPDATE rule_catalog SET payload='{"layer":"team","languages":[]}'::jsonb || payload
      WHERE payload->>'kind' IS DISTINCT FROM 'lint';
  END LOOP;
  PERFORM set_config('app.team_id',coalesce(previous_team,''),true);
END $$;
