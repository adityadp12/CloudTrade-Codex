CREATE TABLE provisioning_job_logs (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES provisioning_jobs(id) ON DELETE CASCADE,
  stage text NOT NULL,
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info','success','warning','error')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provisioning_job_logs_job_id_idx ON provisioning_job_logs(job_id, id);
