CREATE TABLE terminal_telemetry_latest (
  terminal_id uuid PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  connected boolean NOT NULL DEFAULT false,
  symbol text,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terminal_telemetry_received_idx ON terminal_telemetry_latest(received_at DESC);
