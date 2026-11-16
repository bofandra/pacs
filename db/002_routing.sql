-- P1 routing: one idempotent delivery job per SOP Instance UID and destination AE.
-- At-least-once transport semantics: never claim exactly-once remote C-STORE.
CREATE TABLE IF NOT EXISTS routing_rules (
  id BIGSERIAL PRIMARY KEY,
  destination_aet VARCHAR(16) NOT NULL REFERENCES ae_nodes(aet),
  modality VARCHAR(16),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT routing_modality_format CHECK (modality IS NULL OR modality ~ '^[A-Z0-9_]{1,16}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_routing_rules_destination_modality
  ON routing_rules(destination_aet, COALESCE(modality, '*'));

CREATE TABLE IF NOT EXISTS delivery_jobs (
  id BIGSERIAL PRIMARY KEY,
  instance_uid TEXT NOT NULL REFERENCES instances(instance_uid),
  destination_aet VARCHAR(16) NOT NULL REFERENCES ae_nodes(aet),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','succeeded','dead_letter')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INT NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  error_code VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  UNIQUE(instance_uid, destination_aet)
);
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_work
  ON delivery_jobs(next_attempt_at, id) WHERE status IN ('queued','sending');
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_destination
  ON delivery_jobs(destination_aet, status);
