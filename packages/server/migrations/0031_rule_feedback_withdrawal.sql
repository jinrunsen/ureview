ALTER TABLE rule_proposals DROP CONSTRAINT rule_proposals_status_check;
ALTER TABLE rule_proposals ADD CONSTRAINT rule_proposals_status_check CHECK(status IN ('pending','accepted','rejected','withdrawn'));

DO $$ DECLARE tenant uuid; previous_team text := current_setting('app.team_id',true); BEGIN
  FOR tenant IN SELECT id FROM teams LOOP
    PERFORM set_config('app.team_id',tenant::text,true);
    DELETE FROM rule_proposal_feedback feedback USING rule_proposals proposal
      WHERE proposal.id=feedback.proposal_id AND proposal.source='feedback' AND proposal.status='pending'
      AND NOT EXISTS(
        SELECT 1 FROM review_findings finding JOIN finding_disposition_events event
          ON event.finding_id=finding.id AND event.version=finding.disposition_version
        WHERE finding.id=feedback.finding_id AND finding.status='Dismissed'
          AND finding.disposition_version=feedback.disposition_version AND event.reason_category=proposal.reason_category
      );
    UPDATE rule_proposals proposal SET status='withdrawn'
      WHERE proposal.source='feedback' AND proposal.status='pending'
      AND NOT EXISTS(SELECT 1 FROM rule_proposal_feedback feedback WHERE feedback.proposal_id=proposal.id);
  END LOOP;
  PERFORM set_config('app.team_id',coalesce(previous_team,''),true);
END $$;
