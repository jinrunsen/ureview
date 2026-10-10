ALTER TABLE managed_rules ADD COLUMN library_source jsonb;
CREATE UNIQUE INDEX managed_rules_library_entry ON managed_rules(team_id,(library_source->>'entryId')) WHERE library_source IS NOT NULL;

ALTER TABLE rule_candidates ADD CONSTRAINT rule_candidates_team_id_id UNIQUE(team_id,id);
CREATE TABLE rule_proposals (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
  source text NOT NULL CHECK(source IN ('generation','library','mining','feedback')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  managed_rule_id uuid,
  candidate_id uuid,
  rule_id text,
  repository_id uuid,
  name text NOT NULL,
  body text NOT NULL,
  reason_category text CHECK(reason_category IN ('rule_not_applicable','rule_incorrect')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  reviewer_name text,
  rejection_reason text CHECK(length(trim(rejection_reason)) BETWEEN 1 AND 4000),
  UNIQUE(team_id,id),
  FOREIGN KEY(team_id,managed_rule_id) REFERENCES managed_rules(team_id,id),
  FOREIGN KEY(team_id,candidate_id) REFERENCES rule_candidates(team_id,id),
  FOREIGN KEY(team_id,repository_id) REFERENCES repositories(team_id,id),
  FOREIGN KEY(team_id,reviewed_by) REFERENCES team_members(team_id,user_id),
  CHECK(status<>'rejected' OR rejection_reason IS NOT NULL)
);
CREATE UNIQUE INDEX rule_proposals_managed ON rule_proposals(team_id,managed_rule_id) WHERE source IN ('generation','library') AND status='pending';
CREATE UNIQUE INDEX rule_proposals_candidate ON rule_proposals(team_id,candidate_id) WHERE source='mining';
CREATE UNIQUE INDEX rule_proposals_pending_feedback ON rule_proposals(team_id,rule_id,reason_category,coalesce(repository_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE source='feedback' AND status='pending';
CREATE TABLE rule_proposal_feedback (
  team_id uuid NOT NULL DEFAULT nullif(current_setting('app.team_id',true),'')::uuid REFERENCES teams(id),
  proposal_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  review_id uuid NOT NULL,
  disposition_version integer NOT NULL,
  title text NOT NULL,
  explanation text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(team_id,proposal_id,finding_id,disposition_version),
  FOREIGN KEY(team_id,proposal_id) REFERENCES rule_proposals(team_id,id),
  FOREIGN KEY(team_id,review_id,finding_id) REFERENCES review_findings(team_id,review_id,id)
);
ALTER TABLE rule_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rule_proposals USING(team_id=nullif(current_setting('app.team_id',true),'')::uuid) WITH CHECK(team_id=nullif(current_setting('app.team_id',true),'')::uuid);
ALTER TABLE rule_proposal_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE rule_proposal_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rule_proposal_feedback USING(team_id=nullif(current_setting('app.team_id',true),'')::uuid) WITH CHECK(team_id=nullif(current_setting('app.team_id',true),'')::uuid);

DO $$ DECLARE tenant uuid; previous_team text := current_setting('app.team_id',true); BEGIN
  FOR tenant IN SELECT id FROM teams LOOP
    PERFORM set_config('app.team_id',tenant::text,true);
    INSERT INTO rule_proposals(id,source,managed_rule_id,rule_id,name,body,created_at)
      SELECT gen_random_uuid(),'generation',id,'managed:' || id::text,name,body,created_at FROM managed_rules WHERE status='draft';
    INSERT INTO rule_proposals(id,source,candidate_id,repository_id,name,body,created_at)
      SELECT gen_random_uuid(),'mining',id,repository_id,'历史挖掘候选',payload->>'body',created_at FROM rule_candidates;
  END LOOP;
  PERFORM set_config('app.team_id',coalesce(previous_team,''),true);
END $$;
