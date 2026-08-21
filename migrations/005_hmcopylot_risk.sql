ALTER TABLE terminal_controls
  ADD COLUMN risk_percent numeric NOT NULL DEFAULT 10 CHECK (risk_percent > 0 AND risk_percent <= 100),
  ADD COLUMN trailing_distance_points integer NOT NULL DEFAULT 0 CHECK (trailing_distance_points >= 0),
  ADD COLUMN applied_at timestamptz;

ALTER TABLE provisioning_jobs DROP CONSTRAINT provisioning_jobs_action_check;
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_action_check
  CHECK (action IN ('provision','start','stop','restart','repair','rotate-token','apply-risk'));
