// csv.js — RFC-4180-tauglicher CSV-Parser/-Serializer (ohne Dependencies).

/** Parsed CSV-Text → Array von Objekten (erste Zeile = Header). */
export function parseCsv(text) {
  if (typeof text !== 'string') throw new Error('CSV-Parse-Fehler: Input ist kein String');
  const s = text.replace(/^﻿/, ''); // BOM
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (inQuotes) throw new Error('CSV-Parse-Fehler: nicht geschlossenes Anführungszeichen');
  if (!rows.length) return [];

  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map((r, idx) => {
    if (r.length !== header.length && !(r.length === 1 && r[0] === '')) {
      throw new Error(`CSV-Parse-Fehler: Zeile ${idx + 2} hat ${r.length} Felder, erwartet ${header.length}`);
    }
    const obj = {};
    header.forEach((h, j) => { obj[h] = r[j] ?? ''; });
    return obj;
  });
}

const escapeField = v => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};

/** Array von Objekten → CSV-Text. */
export function toCsv(rows, columns) {
  if (!rows.length) return '';
  const cols = columns || Object.keys(rows[0]);
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map(c => escapeField(r[c])).join(','));
  return lines.join('\n') + '\n';
}

const NUM_FIELDS = ['ai_score', 'rsi', 'ema50', 'ema200', 'price', 'ai_entry', 'ai_tp', 'ai_sl', 'exit_price', 'pnl_pct', 'entry_price', 'take_profit', 'stop_loss'];

/** Mapped eine geparste CSV-Zeile auf ein Trade-Objekt mit korrekten Typen. */
export function normalizeTradeRow(row) {
  const t = { ...row };
  for (const f of NUM_FIELDS) {
    if (f in t) {
      const n = parseFloat(t[f]);
      t[f] = Number.isFinite(n) ? n : null;
    }
  }
  t.symbol = String(t.symbol || '').toUpperCase();
  t.direction = String(t.direction || '').toUpperCase();
  t.outcome = String(t.outcome || '').toUpperCase();
  t.created_at_readable = t.created_at_readable || t.created_at || '';
  return t;
}

/** Parsed eine Trades-CSV (WAVESCOUT-Export) → validierte Trade-Objekte. */
export function parseTradesCsv(text) {
  const rows = parseCsv(text);
  const required = ['symbol', 'direction', 'outcome'];
  const errors = [];
  const trades = [];
  rows.forEach((row, i) => {
    const missing = required.filter(f => !String(row[f] || '').trim());
    if (missing.length) { errors.push(`Zeile ${i + 2}: fehlende Pflichtfelder ${missing.join(', ')}`); return; }
    trades.push(normalizeTradeRow(row));
  });
  return { trades, errors };
}
