ALTER TABLE reviews ADD COLUMN report_submissions jsonb NOT NULL DEFAULT '[]'
    CHECK (jsonb_typeof(report_submissions)='array');
