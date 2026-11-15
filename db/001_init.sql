CREATE TABLE IF NOT EXISTS studies (
  study_uid TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL DEFAULT '',
  patient_name TEXT NOT NULL DEFAULT '',
  accession_number TEXT NOT NULL DEFAULT '',
  study_date TEXT NOT NULL DEFAULT '',
  study_description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_studies_patient_id ON studies(patient_id);
CREATE INDEX IF NOT EXISTS idx_studies_accession ON studies(accession_number);
CREATE INDEX IF NOT EXISTS idx_studies_date ON studies(study_date);

CREATE TABLE IF NOT EXISTS series (
  series_uid TEXT PRIMARY KEY,
  study_uid TEXT NOT NULL REFERENCES studies(study_uid),
  modality TEXT NOT NULL DEFAULT '',
  series_number TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_series_study ON series(study_uid);

CREATE TABLE IF NOT EXISTS instances (
  instance_uid TEXT PRIMARY KEY,
  series_uid TEXT NOT NULL REFERENCES series(series_uid),
  study_uid TEXT NOT NULL REFERENCES studies(study_uid),
  sop_class_uid TEXT NOT NULL,
  transfer_syntax_uid TEXT NOT NULL DEFAULT '',
  sha256 CHAR(64) NOT NULL,
  size_bytes BIGINT NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_instances_study ON instances(study_uid);
CREATE INDEX IF NOT EXISTS idx_instances_series ON instances(series_uid);

CREATE TABLE IF NOT EXISTS ae_nodes (
  aet VARCHAR(16) PRIMARY KEY,
  host TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  reference_uid TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
