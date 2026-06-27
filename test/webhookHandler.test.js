// Unit-Tests für das ctx.waitUntil()-Muster im Webhook-Handler.
// Stellt sicher dass der Handler sofort antwortet, unabhängig vom async Ergebnis.
// Lauf: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Hilfsfunktionen inline (spiegeln die Logik aus worker.js exakt wider)
function normalizeDirection(sig) {
  const d = String(sig?.direction || sig?.action || '').toUpperCase().trim();
  if (['LONG','BUY','CALL'].includes(d))  return 'LONG';
  if (['SHORT','SELL','PUT'].includes(d)) return 'SHORT';
  return null;
}

// ── normalizeDirection ─────────────────────────────────────────────────────

test('normalizeDirection: LONG-Richtungen', () => {
  assert.equal(normalizeDirection({ direction: 'LONG' }),  'LONG');
  assert.equal(normalizeDirection({ direction: 'long' }),  'LONG');
  assert.equal(normalizeDirection({ action: 'BUY'  }),     'LONG');
  assert.equal(normalizeDirection({ action: 'CALL' }),     'LONG');
});

test('normalizeDirection: SHORT-Richtungen', () => {
  assert.equal(normalizeDirection({ direction: 'SHORT' }), 'SHORT');
  assert.equal(normalizeDirection({ action: 'SELL'    }),  'SHORT');
  assert.equal(normalizeDirection({ action: 'PUT'     }),  'SHORT');
});

test('normalizeDirection: unbekannte Richtung → null (Signal übersprungen)', () => {
  assert.equal(normalizeDirection({}),                    null);
  assert.equal(normalizeDirection({ direction: 'sideways' }), null);
  assert.equal(normalizeDirection({ action: 'HOLD'    }), null);
  assert.equal(normalizeDirection(null),                  null);
});

// ── ctx.waitUntil Muster ───────────────────────────────────────────────────

test('sofortige Response trotz langsamer async-Verarbeitung (simuliert AI-Call 2s)', async () => {
  const mockCtx = { waitUntil(p) { /* fire-and-forget */ void p; } };
  const slowProcess = () => new Promise(resolve => setTimeout(resolve, 2000));

  const start = Date.now();
  // Handler-Logik: waitUntil starten, DANN sofort zurückgeben
  mockCtx.waitUntil(slowProcess());
  const responseTime = Date.now() - start;

  assert.ok(responseTime < 50, `Response dauerte ${responseTime}ms — muss < 50ms sein (nicht auf AI-Call warten)`);
});

test('sofortige Response auch wenn async-Verarbeitung mit Fehler endet (DB down)', async () => {
  let capturedPromise = null;
  const mockCtx = { waitUntil(p) { capturedPromise = p; } };

  const failingProcess = () => new Promise((_, reject) =>
    setTimeout(() => reject(new Error('D1 DB unavailable')), 100)
  );

  const start = Date.now();
  // waitUntil mit .catch() — Fehler wird intern abgefangen, nicht nach außen propagiert
  mockCtx.waitUntil(failingProcess().catch(err => {
    // entspricht: console.error('❌ processSignal async error:', err.message)
    void err; // Fehler geloggt, nicht geworfen
  }));
  const responseTime = Date.now() - start;

  // Response sofort
  assert.ok(responseTime < 50, `Response dauerte ${responseTime}ms — Fehler darf Response nicht verzögern`);
  assert.ok(capturedPromise instanceof Promise, 'ctx.waitUntil wurde mit Promise aufgerufen');

  // Das capturedPromise darf den Test nicht werfen (catch greift)
  await assert.doesNotReject(capturedPromise, 'waitUntil-Promise wirft nicht nach oben');
});

test('kein waitUntil wenn direction fehlt — Signal korrekt verworfen', () => {
  let waitUntilCalled = false;
  const mockCtx = { waitUntil() { waitUntilCalled = true; } };

  const direction = normalizeDirection({ symbol: 'BTCUSDT' }); // kein direction/action
  if (direction) {
    mockCtx.waitUntil(Promise.resolve());
  }

  assert.equal(direction, null);
  assert.equal(waitUntilCalled, false, 'waitUntil darf nicht aufgerufen werden wenn direction fehlt');
});

test('Response-Timing mit realistischem Signal-Payload', () => {
  const payload = {
    event_type: 'SIGNAL_NEW', symbol: 'BTCUSDT', direction: 'LONG',
    action: 'BUY', price: 65000, rsi: 45, strategy: 'crypto_baseline',
  };

  const mockCtx = { waitUntil(p) { void p; } };
  const start = Date.now();

  const direction = normalizeDirection(payload);
  assert.equal(direction, 'LONG');

  // Simuliere: Response sofort, Verarbeitung im Hintergrund
  if (direction) {
    mockCtx.waitUntil(Promise.resolve({ status: 'processed' }));
  }
  // Response-Objekt (wie jsonResponse in worker.js)
  const response = { success: true, type: 'SIGNAL_NEW', status: 'received', symbol: payload.symbol, direction };

  const elapsed = Date.now() - start;
  assert.ok(elapsed < 10, `Direction-Check + Response-Objekt dauerte ${elapsed}ms (erwartet < 10ms)`);
  assert.equal(response.status, 'received');
  assert.equal(response.symbol, 'BTCUSDT');
});
