CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE,
  password_hash text NOT NULL, display_name text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, name text NOT NULL,
  price_monthly numeric(12,2) NOT NULL DEFAULT 0, terminal_limit integer NOT NULL CHECK (terminal_limit > 0),
  telemetry_retention_days integer NOT NULL DEFAULT 7, features jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans(id), status text NOT NULL DEFAULT 'active' CHECK (status IN ('trialing','active','past_due','canceled')),
  provider text NOT NULL DEFAULT 'manual', provider_customer_id text, provider_subscription_id text,
  current_period_end timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_one_current_per_user ON subscriptions(user_id) WHERE status IN ('trialing','active','past_due');

CREATE TABLE terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, terminal_key text NOT NULL UNIQUE, broker_company text NOT NULL, broker_server text NOT NULL,
  broker_login_masked text NOT NULL, worker_id text, install_path text,
  desired_state text NOT NULL DEFAULT 'stopped' CHECK (desired_state IN ('running','stopped')),
  runtime_state text NOT NULL DEFAULT 'draft' CHECK (runtime_state IN ('draft','queued','provisioning','running','degraded','stopped','failed')),
  provisioning_stage text, process_id integer, last_heartbeat_at timestamptz,
  last_error_code text, last_error_message text, configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terminals_user_id_idx ON terminals(user_id);
CREATE INDEX terminals_worker_state_idx ON terminals(worker_id, runtime_state);

CREATE TABLE terminal_secrets (
  terminal_id uuid PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
  encrypted_credentials text NOT NULL, key_version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telemetry_credentials (
  terminal_id uuid PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, token_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, last_used_at timestamptz
);

CREATE TABLE provisioning_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), terminal_id uuid NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('provision','start','stop','restart','repair','rotate-token')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  stage text NOT NULL DEFAULT 'QUEUED', attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3,
  locked_by text, locked_at timestamptz, started_at timestamptz, finished_at timestamptz,
  error_code text, error_message text, result jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provisioning_jobs_queue_idx ON provisioning_jobs(status, created_at);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  terminal_id uuid REFERENCES terminals(id) ON DELETE SET NULL, event_type text NOT NULL,
  ip_address inet, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (code,name,price_monthly,terminal_limit,telemetry_retention_days,features) VALUES
 ('starter','Starter',149000,1,7,'{"autoRecovery":true,"apiAccess":false}'),
 ('pro','Pro',399000,3,30,'{"autoRecovery":true,"apiAccess":true}'),
 ('business','Business',1199000,10,365,'{"autoRecovery":true,"apiAccess":true,"priorityWorker":true}')
ON CONFLICT (code) DO NOTHING;
