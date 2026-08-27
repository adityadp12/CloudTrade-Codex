INSERT INTO plans (
  code,
  name,
  price_monthly,
  terminal_limit,
  telemetry_retention_days,
  features,
  active
) VALUES
  ('starter', 'Starter', 149000, 1, 7, '{"autoRecovery":true,"apiAccess":false}', true),
  ('pro', 'Pro', 399000, 3, 30, '{"autoRecovery":true,"apiAccess":true}', true),
  ('business', 'Business', 1199000, 10, 365, '{"autoRecovery":true,"apiAccess":true,"priorityWorker":true}', true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  price_monthly = EXCLUDED.price_monthly,
  terminal_limit = EXCLUDED.terminal_limit,
  telemetry_retention_days = EXCLUDED.telemetry_retention_days,
  features = EXCLUDED.features,
  active = EXCLUDED.active;
