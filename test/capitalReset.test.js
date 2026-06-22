// Unit-Tests für das Zurücksetzen des Einstiegskapitals (AUFGABE 4).
// Lauf: node --test test/
//
// Kern-Anforderung: Nicht-Admins dürfen die Funktion NICHT ausführen. Der
// Rollen-Guard greift VOR jeglichem DB-Zugriff, daher braucht der
// Ablehnungs-Pfad kein DB-Mock. Für den Happy-Path gibt es ein minimales
// In-Memory-Mock von env.DB, das settings-Upsert und das Audit-Log abbildet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resetStartingCapital } from '../worker.js';

// Minimales env.DB-Mock: deckt getSetting (SELECT), setSetting (INSERT…ON CONFLICT)
// und das INSERT in capital_reset_log ab.
function mockEnv(initialEnv = { STARTING_CAPITAL: '10000' }) {
  const settings = {};
  const log = [];
  const env = {
    ...initialEnv,
    DB: {
      prepare(sql) {
        return {
          _sql: sql,
          _args: [],
          bind(...args) { this._args = args; return this; },
          async first() {
            if (/FROM settings/.test(this._sql)) {
              const key = this._args[0];
              return key in settings ? { value: settings[key] } : null;
            }
            return null;
          },
          async run() {
            if (/INSERT INTO settings/.test(this._sql)) {
              const [key, value] = this._args;
              settings[key] = value;
            } else if (/capital_reset_log/.test(this._sql)) {
              log.push(this._args);
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  return { env, settings, log };
}

test('Nicht-Admin wird abgelehnt (403) und ändert NICHTS', async () => {
  const { env, settings, log } = mockEnv();
  const res = await resetStartingCapital({ env, session: { role: 'user', username: 'bob' }, newValue: 5000 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  // Kein DB-Write erfolgt.
  assert.equal(Object.keys(settings).length, 0);
  assert.equal(log.length, 0);
});

test('Fehlende Session wird abgelehnt (401)', async () => {
  const { env } = mockEnv();
  const res = await resetStartingCapital({ env, session: null, newValue: 5000 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

test('Admin mit ungültigem Wert → 400 (keine Änderung)', async () => {
  const { env, settings } = mockEnv();
  for (const bad of [NaN, -100, 'abc', undefined]) {
    const res = await resetStartingCapital({ env, session: { role: 'admin' }, newValue: bad });
    assert.equal(res.ok, false);
    assert.equal(res.status, 400);
  }
  assert.equal(Object.keys(settings).length, 0);
});

test('Admin setzt neuen Wert → 200, persistiert + geloggt (alt/neu)', async () => {
  const { env, settings, log } = mockEnv({ STARTING_CAPITAL: '10000' });
  const res = await resetStartingCapital({
    env,
    session: { role: 'admin', username: 'alice', user_id: 'u1' },
    newValue: 5000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.oldValue, 10000); // Fallback aus env.STARTING_CAPITAL
  assert.equal(res.newValue, 5000);

  // In settings persistiert.
  assert.equal(settings.starting_capital, '5000');

  // Genau ein Audit-Log-Eintrag mit alt=10000, neu=5000, username.
  assert.equal(log.length, 1);
  const [, userId, username, oldValue, newValue] = log[0];
  assert.equal(userId, 'u1');
  assert.equal(username, 'alice');
  assert.equal(oldValue, 10000);
  assert.equal(newValue, 5000);
});

test('Zweiter Reset liest den zuvor gesetzten Wert als oldValue', async () => {
  const { env } = mockEnv({ STARTING_CAPITAL: '10000' });
  await resetStartingCapital({ env, session: { role: 'admin', username: 'a' }, newValue: 8000 });
  const res = await resetStartingCapital({ env, session: { role: 'admin', username: 'a' }, newValue: 12000 });
  assert.equal(res.oldValue, 8000); // jetzt aus settings, nicht mehr env
  assert.equal(res.newValue, 12000);
});
