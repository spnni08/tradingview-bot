// Test-Harness für processSignal-E2E-Tests (node:test).
//
// processSignal(env, signal) hat starke Seiteneffekte (D1-Writes, fetch zu
// Telegram/ntfy/WebPush/Anthropic). Diese Helfer kapseln:
//   1. makeFakeDB / makeEnv  — eine in-memory D1-Attrappe (prepare/bind/run/
//      first/all), die INSERTs mitschneidet und SELECTs deterministisch
//      beantwortet. Ohne API-Tokens no-oppen alle Notification-Helfer in
//      worker.js von selbst (sie prüfen env.* und brechen früh ab).
//   2. installDeterminism — friert Date (für den zeitabhängigen session_filter
//      und die Forex-Session), Math.random und fetch ein, damit Score, IDs und
//      Timestamps reproduzierbar sind und KEIN echter Netzwerk-Call passiert.
//
// Es wird KEINE Produktionslogik verändert — nur Umgebung gemockt.

import { DEFAULT_STRATEGY_CONFIG } from '../../worker.js';

// UTC-Zeitpunkte mit definierter Stunde (für session_filter / Forex-Session).
// 03:00 UTC liegt außerhalb aller bevorzugten Sessions, 08:30 UTC innerhalb
// des Forex-London-Open-Fensters (08:00–09:00 UTC).
export const NON_SESSION_UTC   = Date.UTC(2025, 0, 15, 3, 0, 0);
export const FOREX_SESSION_UTC  = Date.UTC(2025, 0, 15, 8, 30, 0);

// Strategie-Config mit deaktiviertem session_filter → analyzeWithRules wird
// zeitunabhängig und damit exakt reproduzierbar (Gewicht 0 statt ±5 je nach
// aktueller Uhrzeit). Alle übrigen Gewichte = v2.0-Defaults.
export function sessionDisabledConfig() {
  const cfg = structuredClone(DEFAULT_STRATEGY_CONFIG);
  cfg.rules.session_filter.enabled = false;
  return cfg;
}

// Findet die Klammergruppe, die auf `fromIndex` folgt (erste `(` ab dort),
// und gibt ihren Inhalt bis zur PASSENDEN schließenden Klammer zurück
// (Tiefenzählung statt gieriger/nicht-gieriger Regex — robust gegen Text
// NACH der Gruppe wie `ON CONFLICT(id) DO UPDATE SET …`).
function extractParenGroup(sql, fromIndex) {
  const openIdx = sql.indexOf('(', fromIndex);
  if (openIdx === -1) return null;
  let depth = 0;
  for (let i = openIdx; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(openIdx + 1, i);
    }
  }
  return null;
}

// Splittet eine SQL-VALUES-Tupel-Liste an Kommas AUSSERHALB von Quotes.
function splitSqlValueTokens(valuesInner) {
  const tokens = [];
  let current = '';
  let inString = false;
  for (const ch of valuesInner) {
    if (ch === "'") inString = !inString;
    if (ch === ',' && !inString) {
      tokens.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') tokens.push(current.trim());
  return tokens;
}

// Löst eine SQL-VALUES-Tupel-Liste in die tatsächlich eingefügten Werte auf:
// `?`-Tokens konsumieren das nächste bind()-Argument der Reihe nach, literale
// Tokens ('str', Zahl, NULL) werden direkt geparst.
function resolveInsertValues(valuesInner, bound) {
  let boundIdx = 0;
  return splitSqlValueTokens(valuesInner).map((token) => {
    if (token === '?') return bound[boundIdx++];
    if (/^'.*'$/.test(token)) return token.slice(1, -1);
    if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
    if (/^NULL$/i.test(token)) return null;
    return token; // Fallback: unbekanntes Token unverändert (z.B. Ausdrücke)
  });
}

// In-memory D1-Attrappe. `settings` = Map für die settings-Tabelle (getSetting),
// `activeStrategy` = Zeile für `SELECT * FROM strategies WHERE active=1`
// (null → erzwingt initDefaultStrategy-Pfad).
export function makeFakeDB({ settings = {}, activeStrategy } = {}) {
  const runs = [];
  const inserts = [];

  const strategyRow = activeStrategy === null ? null : (activeStrategy ?? {
    id: 'test_strat', name: 'Test Strategy', version: 'vTEST',
    active: 1, updated_at: 1,
    config_json: JSON.stringify(sessionDisabledConfig()),
  });

  function resolveFirst(sql, args) {
    if (/FROM\s+settings\s+WHERE\s+key/i.test(sql)) {
      const key = args[0];
      return Object.prototype.hasOwnProperty.call(settings, key)
        ? { value: settings[key] } : null;
    }
    if (/FROM\s+strategies\s+WHERE\s+active/i.test(sql)) return strategyRow;
    if (/SELECT\s+id\s+FROM\s+strategies\s+WHERE\s+id/i.test(sql)) {
      return strategyRow ? { id: strategyRow.id } : null;
    }
    if (/FROM\s+market_events/i.test(sql)) return { c: 0, titles: null };
    return null;
  }

  const db = {
    prepare(sql) {
      let bound = [];
      const stmt = {
        bind(...a) { bound = a; return stmt; },
        async run() {
          runs.push({ sql, args: bound });
          const m = sql.match(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([\s\S]*?)\)\s*(?:VALUES|SELECT)/i);
          if (m) {
            const columns = m[2].split(',').map((s) => s.trim()).filter(Boolean);
            // Manche INSERTs (z.B. der REJECTED-Pfad in worker.js) mischen
            // Literale ('REJECTED', 0, 'WEBHOOK', …) MIT `?`-Platzhaltern in
            // der VALUES-Klausel. Eine naive 1:1-Zippung von Spalten- und
            // bind()-Argument-Indizes wäre dann falsch verschoben (Spalte N
            // bekäme bind-Argument N statt des tatsächlich an Position N
            // stehenden Werts). Die VALUES-Klausel wird deshalb per Klammer-
            // Tiefenzählung extrahiert (robust gegen ON CONFLICT(...)-Anhänge
            // wie bei trade_reviews) und geparst — `?`-Tokens konsumieren
            // bind()-Argumente der Reihe nach, Literale werden direkt
            // aufgelöst — nur dann stimmt insertedRow() mit dem überein, was
            // D1 real einfügen würde.
            const isValuesForm = /VALUES\s*$/i.test(m[0]);
            const valuesInner  = isValuesForm ? extractParenGroup(sql, sql.indexOf(m[0]) + m[0].length) : null;
            const values = valuesInner != null ? resolveInsertValues(valuesInner, bound) : bound;
            inserts.push({ table: m[1], columns, values });
          }
          return { success: true, meta: { changes: 1 } };
        },
        async first() { runs.push({ sql, args: bound }); return resolveFirst(sql, bound); },
        async all()  { runs.push({ sql, args: bound }); return { results: [] }; },
      };
      return stmt;
    },
  };

  db._runs = runs;
  db._inserts = inserts;
  // Zuletzt eingefügte Zeile einer Tabelle als Spalte→Wert-Objekt (Spalten aus
  // dem INSERT-SQL geparst, Werte aus bind()).
  db.insertedRow = (table) => {
    const row = [...inserts].reverse().find((i) => i.table === table);
    if (!row) return null;
    const obj = {};
    row.columns.forEach((c, i) => { obj[c] = row.values[i]; });
    return obj;
  };
  db.insertCount = (table) => inserts.filter((i) => i.table === table).length;
  return db;
}

// Mock-env OHNE Tokens → Telegram/ntfy/WebPush/Anthropic no-oppen automatisch.
export function makeEnv(opts = {}) {
  return { DB: makeFakeDB(opts) };
}

// Friert Date / Math.random / fetch ein. Gibt eine restore()-Funktion zurück.
export function installDeterminism(fixedMs = NON_SESSION_UTC) {
  const RealDate = globalThis.Date;
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedMs);
      else super(...args);
    }
    static now() { return fixedMs; }
  }
  globalThis.Date = MockDate;

  const realRandom = Math.random;
  Math.random = () => 0.123456789;

  const realFetch = globalThis.fetch;
  // Hermetisch: jeder versehentliche Netzwerk-Call schlägt benigne fehl.
  globalThis.fetch = async () => ({
    ok: false, status: 599,
    json: async () => ({ ok: false }),
    text: async () => '',
  });

  return () => {
    globalThis.Date = RealDate;
    Math.random = realRandom;
    globalThis.fetch = realFetch;
  };
}
