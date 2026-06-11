-- schema.sql — D1-Schema des WAVESCOUT Score Optimizers.
-- Wird von storage.js automatisch ausgeführt (CREATE TABLE IF NOT EXISTS);
-- diese Datei dient für manuelles Setup via:
--   wrangler d1 execute wavescout_db --file=schema.sql

CREATE TABLE IF NOT EXISTS optimizer_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT,
  direction TEXT,
  timeframe TEXT,
  outcome TEXT,                -- WIN | LOSS
  ai_score INTEGER,
  signal_quality TEXT,
  rsi REAL,
  ema50 REAL,
  ema200 REAL,
  trend TEXT,
  wave_bias TEXT,
  price REAL,
  ai_entry REAL,
  ai_tp REAL,
  ai_sl REAL,
  exit_price REAL,
  pnl_pct REAL,
  created_at_readable TEXT,    -- "YYYY-MM-DD HH:MM:SS" (UTC)
  matched_rules TEXT,          -- JSON-Array oder pipe-separiert
  failed_rules TEXT,
  imported_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_opt_trades_sym ON optimizer_trades(symbol, direction, outcome);

CREATE TABLE IF NOT EXISTS optimizer_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id TEXT,                 -- ID im Quellsystem (z. B. practice_trades.id)
  symbol TEXT,
  direction TEXT,
  timeframe TEXT,
  entry_price REAL,
  take_profit REAL,
  stop_loss REAL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS optimizer_calibrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER,
  payload TEXT                 -- komplettes Kalibrierungs-Ergebnis (JSON)
);

CREATE TABLE IF NOT EXISTS optimizer_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER,
  symbol TEXT,
  direction TEXT,
  score INTEGER,
  recommendation TEXT,         -- GO | CAUTION | NO-GO
  payload TEXT
);
