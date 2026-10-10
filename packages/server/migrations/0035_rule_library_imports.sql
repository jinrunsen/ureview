CREATE TABLE rule_library_imports (
  id uuid PRIMARY KEY, uploaded_by uuid NOT NULL REFERENCES auth_users(id), created_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1, status text NOT NULL CHECK (status IN ('queued','planning','generating','ready','partial_failed','failed')), error text
);
CREATE TABLE rule_library_import_files (
  id uuid PRIMARY KEY, import_id uuid NOT NULL REFERENCES rule_library_imports(id) ON DELETE CASCADE,
  name text NOT NULL, size integer NOT NULL, sha256 text NOT NULL, content text NOT NULL, plan jsonb
);
CREATE TABLE rule_library_import_sections (
  id text NOT NULL, file_id uuid NOT NULL REFERENCES rule_library_import_files(id) ON DELETE CASCADE,
  data jsonb NOT NULL, PRIMARY KEY(file_id,id)
);
CREATE TABLE rule_library_import_sets (
  id text PRIMARY KEY, import_id uuid NOT NULL REFERENCES rule_library_imports(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES rule_library_import_files(id) ON DELETE CASCADE,
  name text NOT NULL, layer text NOT NULL, languages jsonb NOT NULL,
  published_at timestamptz, published_by uuid REFERENCES auth_users(id)
);
CREATE TABLE rule_library_import_chunks (
  id uuid PRIMARY KEY, import_id uuid NOT NULL REFERENCES rule_library_imports(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES rule_library_import_files(id) ON DELETE CASCADE,
  set_id text REFERENCES rule_library_import_sets(id) ON DELETE CASCADE,
  section_id text NOT NULL, path text NOT NULL, content text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','failed','skipped')),
  skipped jsonb NOT NULL DEFAULT '[]', error text
);
CREATE TABLE rule_library_import_entries (
  id text PRIMARY KEY, set_id text NOT NULL REFERENCES rule_library_import_sets(id) ON DELETE CASCADE,
  chunk_id uuid NOT NULL REFERENCES rule_library_import_chunks(id) ON DELETE CASCADE, data jsonb NOT NULL
);
CREATE INDEX rule_library_import_queue ON rule_library_imports(created_at) WHERE status='queued';
