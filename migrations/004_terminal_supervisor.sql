CREATE TABLE terminal_telemetry_history (
  id bigserial PRIMARY KEY,
  terminal_id uuid NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terminal_telemetry_history_lookup_idx ON terminal_telemetry_history(terminal_id, received_at DESC);

CREATE TABLE terminal_trade_events (
  id bigserial PRIMARY KEY,
  terminal_id uuid NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  deal_ticket text NOT NULL,
  payload jsonb NOT NULL,
  executed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(terminal_id, deal_ticket)
);
CREATE INDEX terminal_trade_events_lookup_idx ON terminal_trade_events(terminal_id, executed_at DESC);

CREATE TABLE terminal_alerts (
  id bigserial PRIMARY KEY,
  terminal_id uuid NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
  severity text NOT NULL CHECK(severity IN ('warning','critical')),
  code text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX terminal_alerts_lookup_idx ON terminal_alerts(terminal_id, created_at DESC);

CREATE TABLE terminal_controls (
  terminal_id uuid PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
  max_loss_usd numeric NOT NULL DEFAULT 0,
  baseline_equity numeric NOT NULL DEFAULT 0,
  last_equity numeric NOT NULL DEFAULT 0,
  stop_trading boolean NOT NULL DEFAULT false,
  close_all_generation integer NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
