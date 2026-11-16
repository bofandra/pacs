-- P1 Modality Worklist (MWL): one Requested Procedure + one Scheduled Procedure Step
-- per RIS order. Never infer patient identity from PatientID without its issuer.
-- Schedule is stored in the site-local DICOM DA/TM representations to prevent
-- accidental UTC conversion before returning a modality worklist.
CREATE TABLE IF NOT EXISTS ris_worklist_orders (
  id BIGSERIAL PRIMARY KEY,
  source_system VARCHAR(48) NOT NULL,
  external_order_id VARCHAR(96) NOT NULL,
  accession_issuer VARCHAR(48) NOT NULL,
  accession_number VARCHAR(16) NOT NULL,
  patient_id VARCHAR(64) NOT NULL,
  issuer_of_patient_id VARCHAR(64) NOT NULL,
  patient_name VARCHAR(192) NOT NULL,
  patient_birth_date CHAR(8),
  patient_sex VARCHAR(1),
  study_instance_uid VARCHAR(64) NOT NULL,
  requested_procedure_id VARCHAR(64) NOT NULL,
  requested_procedure_description VARCHAR(128) NOT NULL,
  scheduled_procedure_step_id VARCHAR(64) NOT NULL,
  scheduled_procedure_step_description VARCHAR(128) NOT NULL,
  scheduled_station_aet VARCHAR(16) NOT NULL REFERENCES ae_nodes(aet),
  modality VARCHAR(8) NOT NULL,
  scheduled_start_date CHAR(8) NOT NULL,
  scheduled_start_time CHAR(6) NOT NULL,
  schedule_timezone VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','on_hold','completed','cancelled')),
  payload_sha256 CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(source_system,external_order_id),
  UNIQUE(accession_issuer,accession_number),
  UNIQUE(scheduled_station_aet,scheduled_procedure_step_id),
  CONSTRAINT worklist_uid CHECK (study_instance_uid ~ '^[0-9]+(\.[0-9]+)+$'),
  CONSTRAINT worklist_aet CHECK (scheduled_station_aet ~ '^[A-Z0-9_-]{1,16}$'),
  CONSTRAINT worklist_date CHECK (scheduled_start_date ~ '^[0-9]{8}$'),
  CONSTRAINT worklist_time CHECK (scheduled_start_time ~ '^[0-9]{6}$')
);
CREATE INDEX IF NOT EXISTS idx_worklist_active_station
  ON ris_worklist_orders(scheduled_station_aet,scheduled_start_date,scheduled_start_time)
  WHERE status='scheduled';
CREATE INDEX IF NOT EXISTS idx_worklist_patient_issuer
  ON ris_worklist_orders(issuer_of_patient_id,patient_id);
CREATE INDEX IF NOT EXISTS idx_worklist_accession
  ON ris_worklist_orders(accession_issuer,accession_number);
