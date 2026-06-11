// storage.js — Persistenz: Cloudflare D1 (REST-API oder Worker-Binding)
// mit Fallback auf In-Memory. Alle Stores implementieren dasselbe Interface:
//   init(), insertTrades(rows), getTrades(), replacePositions(rows),
//   getPositions(), saveCalibration(obj), getCalibration(), logEvaluation(e)

const TRADE_COLS = ['symbol', 'direction', 'timeframe', 'outcome', 'ai_score', 'signal_quality', 'rsi', 'ema50', 'ema200', 'trend', 'wave_bias', 'price', 'ai_entry', 'ai_tp', 'ai_sl', 'exit_price', 'pnl_pct', 'created_at_readable', 'matched_rules', 'failed_rules'];

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS optimizer_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT, direction TEXT, timeframe TEXT, outcome TEXT,
    ai_score INTEGER, signal_quality TEXT,
    rsi REAL, ema50 REAL, ema200 REAL, trend TEXT, wave_bias TEXT,
    price REAL, ai_entry REAL, ai_tp REAL, ai_sl REAL, exit_price REAL, pnl_pct REAL,
    created_at_readable TEXT, matched_rules TEXT, failed_rules TEXT,
    imported_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_opt_trades_sym ON optimizer_trades(symbol, direction, outcome)`,
  `CREATE TABLE IF NOT EXISTS optimizer_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ext_id TEXT, symbol TEXT, direction TEXT, timeframe TEXT,
    entry_price REAL, take_profit REAL, stop_loss REAL, created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS optimizer_calibrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER, payload TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS optimizer_evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER,
    symbol TEXT, direction TEXT, score INTEGER, recommendation TEXT, payload TEXT
  )`,
];

// ── In-Memory (Fallback) ───────────────────────────────────────
export class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.trades = [];
    this.positions = [];
    this.calibrations = [];
    this.evaluations = [];
  }
  async init() {}
  async insertTrades(rows) { this.trades.push(...rows); return rows.length; }
  async clearTrades() { this.trades = []; }
  async getTrades() { return this.trades; }
  async replacePositions(rows) { this.positions = [...rows]; return rows.length; }
  async getPositions() { return this.positions; }
  async saveCalibration(obj) { this.calibrations.push({ created_at: Date.now(), payload: obj }); }
  async getCalibration() { return this.calibrations.at(-1)?.payload ?? null; }
  async logEvaluation(e) { this.evaluations.push({ created_at: Date.now(), ...e }); }
  async getEvaluations(sinceMs = 0) { return this.evaluations.filter(e => e.created_at >= sinceMs); }
  toJSON() { return { trades: this.trades, positions: this.positions, calibrations: this.calibrations, evaluations: this.evaluations }; }
  static fromJSON(j) {
    const s = new MemoryStore();
    Object.assign(s, { trades: j.trades || [], positions: j.positions || [], calibrations: j.calibrations || [], evaluations: j.evaluations || [] });
    return s;
  }
}

// ── D1 (gemeinsame SQL-Logik für REST + Binding) ───────────────
class D1BaseStore {
  async query(_sql, _params) { throw new Error('not implemented'); }

  async init() {
    for (const sql of SCHEMA_STATEMENTS) await this.query(sql, []);
  }
  async insertTrades(rows) {
    const placeholders = TRADE_COLS.map(() => '?').join(',');
    for (const r of rows) {
      await this.query(
        `INSERT INTO optimizer_trades (${TRADE_COLS.join(',')}, imported_at) VALUES (${placeholders}, ?)`,
        [...TRADE_COLS.map(c => r[c] ?? null), Date.now()]
      );
    }
    return rows.length;
  }
  async clearTrades() { await this.query('DELETE FROM optimizer_trades', []); }
  async getTrades() { return this.query('SELECT * FROM optimizer_trades ORDER BY created_at_readable ASC', []); }
  async replacePositions(rows) {
    await this.query('DELETE FROM optimizer_positions', []);
    for (const p of rows) {
      await this.query(
        'INSERT INTO optimizer_positions (ext_id, symbol, direction, timeframe, entry_price, take_profit, stop_loss, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [p.id ?? p.ext_id ?? null, p.symbol, p.direction, p.timeframe ?? null, p.entry_price ?? null, p.take_profit ?? null, p.stop_loss ?? null, p.created_at ?? null]
      );
    }
    return rows.length;
  }
  async getPositions() { return this.query('SELECT * FROM optimizer_positions ORDER BY created_at DESC', []); }
  async saveCalibration(obj) {
    await this.query('INSERT INTO optimizer_calibrations (created_at, payload) VALUES (?,?)', [Date.now(), JSON.stringify(obj)]);
  }
  async getCalibration() {
    const rows = await this.query('SELECT payload FROM optimizer_calibrations ORDER BY id DESC LIMIT 1', []);
    return rows[0] ? JSON.parse(rows[0].payload) : null;
  }
  async logEvaluation(e) {
    await this.query(
      'INSERT INTO optimizer_evaluations (created_at, symbol, direction, score, recommendation, payload) VALUES (?,?,?,?,?,?)',
      [Date.now(), e.symbol ?? null, e.direction ?? null, e.score ?? null, e.recommendation ?? null, JSON.stringify(e)]
    );
  }
  async getEvaluations(sinceMs = 0) {
    const rows = await this.query('SELECT * FROM optimizer_evaluations WHERE created_at >= ? ORDER BY id DESC LIMIT 500', [sinceMs]);
    return rows.map(r => ({ ...JSON.parse(r.payload || '{}'), created_at: r.created_at }));
  }
}

/** D1 über Cloudflare REST-API (lokaler Express-Modus). */
export class D1HttpStore extends D1BaseStore {
  constructor({ accountId, apiToken, databaseId, fetchImpl = fetch }) {
    super();
    this.kind = 'd1-http';
    this.url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
    this.apiToken = apiToken;
    this.fetch = fetchImpl;
  }
  async query(sql, params = []) {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      throw new Error(`D1-Verbindungsfehler (${res.status}): ${JSON.stringify(json.errors || json)}`);
    }
    return json.result?.[0]?.results ?? [];
  }
}

/** D1 über Worker-Binding (Cloudflare-Worker-Modus). */
export class D1BindingStore extends D1BaseStore {
  constructor(db) { super(); this.kind = 'd1-binding'; this.db = db; }
  async query(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const res = params.length ? await stmt.bind(...params).all() : await stmt.all();
    return res.results ?? [];
  }
}

/**
 * Wählt den Store: D1 via REST, wenn Credentials gesetzt sind,
 * sonst In-Memory-Fallback (mit Warnung).
 */
export async function createStore(env = {}) {
  const { CF_ACCOUNT_ID, CF_API_TOKEN, CF_D1_DATABASE_ID } = env;
  if (CF_ACCOUNT_ID && CF_API_TOKEN && CF_D1_DATABASE_ID) {
    const store = new D1HttpStore({ accountId: CF_ACCOUNT_ID, apiToken: CF_API_TOKEN, databaseId: CF_D1_DATABASE_ID });
    try {
      await store.init();
      return store;
    } catch (err) {
      console.warn(`⚠️  D1 nicht erreichbar (${err.message}) – Fallback auf In-Memory-Store`);
    }
  }
  return new MemoryStore();
}
