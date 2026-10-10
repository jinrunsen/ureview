ALTER TABLE service_model_keys
  ADD COLUMN generator_model text,
  ADD COLUMN generator_base_url text,
  ADD COLUMN grader_model text,
  ADD COLUMN grader_base_url text;
