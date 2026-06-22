// Unit-Tests für den Strategie-Toggle (aktiv/pausiert) — AUFGABE 1/2.
// Lauf: node --test test/
//
// Wie beim Kapital-Reset greift der Rollen-Guard VOR jeglichem DB-Zugriff,
// daher braucht der Ablehnungs-Pfad kein DB-Mock. Für die Persistenz nutzen
// wir ein minimales In-Memory-Mock der settings-Tabelle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setStrategyStatus, getStrategyStatuses, STRATEGIES } from '../worker.js';

function mockEnv() {
  const settings = {};
  const env = {
    DB: {
      prepare(sql) {
        return {
          _sql: sql, _args: [],
          bind(...a) { this._args = a; return this; },
          async first() {
            if (/FROM settings/.test(this._sql)) {
              const k = this._args[0];
              return k in settings ? { value: settings[k] } : null;
            }
            return null;
          },
          async run() {
            if (/INSERT INTO settings/.test(this._sql)) {
              const [k, v] = this._args; settings[k] = v;
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  return { env, settings };
}

const adminSession = { role: 'admin', username: 'alice' };

test('Nicht-Admin wird abgelehnt (403), keine Persistenz', async () => {
  const { env, settings } = mockEnv();
  const res = await setStrategyStatus({ env, session: { role: 'trader' }, strategy: 'crypto_sr_volume', paused: true });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(Object.keys(settings).length, 0);
});

test('Fehlende Session → 401', async () => {
  const { env } = mockEnv();
  const res = await setStrategyStatus({ env, session: null, strategy: 'crypto_sr_volume', paused: true });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

test('Unbekannte Strategie → 400', async () => {
  const { env, settings } = mockEnv();
  const res = await setStrategyStatus({ env, session: adminSession, strategy: 'does_not_exist', paused: true });
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(Object.keys(settings).length, 0);
});

test('Admin pausiert eine Strategie → persistiert, status_label=paused', async () => {
  const { env, settings } = mockEnv();
  const res = await setStrategyStatus({ env, session: adminSession, strategy: 'crypto_sr_volume', paused: true });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.status_label, 'paused');
  assert.deepEqual(JSON.parse(settings.strategy_paused), ['crypto_sr_volume']);

  const statuses = await getStrategyStatuses(env);
  assert.equal(statuses.crypto_sr_volume, 'paused');
  assert.equal(statuses.crypto_baseline, 'active'); // andere unberührt
});

test('Admin reaktiviert → aus der Pausen-Liste entfernt', async () => {
  const { env, settings } = mockEnv();
  await setStrategyStatus({ env, session: adminSession, strategy: 'forex_sr_fib_rsi', paused: true });
  const res = await setStrategyStatus({ env, session: adminSession, strategy: 'forex_sr_fib_rsi', paused: false });
  assert.equal(res.ok, true);
  assert.equal(res.status_label, 'active');
  assert.deepEqual(JSON.parse(settings.strategy_paused), []);
  const statuses = await getStrategyStatuses(env);
  assert.equal(statuses.forex_sr_fib_rsi, 'active');
});

test('Pausieren ist idempotent (kein doppelter Eintrag)', async () => {
  const { env, settings } = mockEnv();
  await setStrategyStatus({ env, session: adminSession, strategy: 'crypto_orderflow_breakout', paused: true });
  await setStrategyStatus({ env, session: adminSession, strategy: 'crypto_orderflow_breakout', paused: true });
  assert.deepEqual(JSON.parse(settings.strategy_paused), ['crypto_orderflow_breakout']);
});

test('getStrategyStatuses listet alle registrierten Strategien (Default aktiv)', async () => {
  const { env } = mockEnv();
  const statuses = await getStrategyStatuses(env);
  assert.deepEqual(Object.keys(statuses).sort(), Object.keys(STRATEGIES).sort());
  for (const k of Object.keys(STRATEGIES)) assert.equal(statuses[k], 'active');
});
