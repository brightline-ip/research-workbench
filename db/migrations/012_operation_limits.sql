BEGIN;
CREATE TABLE operation_requests (
  request_key UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(project_id),
  operation TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE provider_daily_usage (
  usage_day DATE PRIMARY KEY,
  calls INTEGER NOT NULL CHECK(calls>=0),
  input_bytes BIGINT NOT NULL CHECK(input_bytes>=0)
);
COMMIT;
