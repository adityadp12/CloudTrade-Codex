ALTER TABLE terminal_controls
  ADD COLUMN lot_size numeric(10,2) NOT NULL DEFAULT 0.01
  CHECK (lot_size >= 0.01 AND lot_size <= 100);
