ALTER TABLE reviews ADD COLUMN files jsonb NOT NULL DEFAULT '[]';
ALTER TABLE reviews ADD COLUMN overview jsonb;
