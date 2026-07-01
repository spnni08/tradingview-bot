// Tests für die separaten Webhook-Endpunkte pro Strategie
// (/webhook/baseline, /webhook/sr-volume, /webhook/forex, /webhook/orderflow).
//
// Diese Endpunkte teilen sich die komplette Handler-Logik (Auth, JSON-Parsing,
// Event-Routing) über handleWebhookRequest() — nur `forcedStrategy` (aus der
// URL) unterscheidet sich. Abgedeckt:
//   1. Auth-Check greift identisch auf allen drei aktiven Endpunkten
//      (falsches Secret → 401, keine Persistenz)
//   2. URL-Strategie gewinnt IMMER über ein abweichendes `strategy`-Feld im
//      Payload (der eigentliche Sicherheitsgewinn der separaten Pfade)
//   3. Fehlendes `strategy`-Feld im Payload wird durch die URL ersetzt
//   4. Korrektes Routing bis zu processSignal (signals/signal_candidates-Zeile
//      trägt den strategy_key des Endpunkts)
//   5. /webhook/orderflow ist ein deaktivierter Stub (501), berührt die DB nicht
//   6. Der bestehende generische /webhook-Pfad bleibt unverändert (Payload-Feld
//      entscheidet weiterhin, wenn kein forcedStrategy übergeben wird)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleWebhookRequest } from '../worker.js';
import worker from '../worker.js';
import { makeEnv, installDeterminism, NON_SESSION_UTC } from './helpers/fakeEnv.js';
import { signalFixtures } from './fixtures/signals.js';

const SECRET = 'test-webhook-secret-123';

// Einfache jsonResponse-Attrappe (spiegelt die request-scoped Version in
// worker.js: JSON-Body + Status, CORS/Security-Header sind für die Tests
// irrelevant).
const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// ctx-Attrappe: sammelt alle waitUntil()-Promises, damit der Test die
// asynchrone Verarbeitung (processSignal, logWebhookRequest) abwarten kann,
// bevor er die DB-Seiteneffekte prüft.
function makeCtx() {
  const pending = [];
  return {
    ctx: { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } },
    async flush() { await Promise.all(pending); },
  };
}

// secret === null bedeutet bewusst "kein Secret mitschicken" (fehlendes
// Secret testen) — undefined würde durch den Default-Parameter unten
// stillschweigend zu SECRET aufgelöst, deshalb der explizite null-Sentinel.
function makeRequest(path, body, { secret = SECRET, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Webhook-Secret'] = secret;
  return new Request(`https://worker.example.dev${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

async function run(path, body, { secret = SECRET, forcedStrategy } = {}) {
  const restore = installDeterminism(NON_SESSION_UTC);
  try {
    const env = { ...makeEnv(), WEBHOOK_SECRET: SECRET };
    const { ctx, flush } = makeCtx();
    const request = makeRequest(path, body, { secret });
    const url = new URL(request.url);
    const response = await handleWebhookRequest(request, env, ctx, url, jsonResponse, forcedStrategy);
    await flush();
    return { response, env, status: response.status, json: await response.clone().json().catch(() => null) };
  } finally {
    restore();
  }
}

// ── Auth-Check greift identisch auf allen aktiven Endpunkten ────────────────

for (const [label, path, forcedStrategy] of [
  ['baseline',  '/webhook/baseline',  'crypto_baseline'],
  ['sr-volume', '/webhook/sr-volume', 'crypto_sr_volume'],
  ['forex',     '/webhook/forex',     'forex_sr_fib_rsi'],
]) {
  test(`webhook/${label}: falsches Secret → 401, keine Persistenz`, async () => {
    const { status, env } = await run(path, { ...signalFixtures.crypto_baseline.trade }, {
      secret: 'wrong-secret', forcedStrategy,
    });
    assert.equal(status, 401);
    assert.equal(env.DB.insertCount('signals'), 0, 'kein signals-Insert bei fehlgeschlagener Auth');
    assert.equal(env.DB.insertCount('signal_candidates'), 0, 'kein candidate-Insert bei fehlgeschlagener Auth');
  });

  test(`webhook/${label}: fehlendes Secret → 401`, async () => {
    const { status } = await run(path, { ...signalFixtures.crypto_baseline.trade }, {
      secret: null, forcedStrategy,
    });
    assert.equal(status, 401);
  });

  test(`webhook/${label}: korrektes Secret → kein 401`, async () => {
    const { status } = await run(path, { ...signalFixtures.crypto_baseline.trade, strategy: forcedStrategy }, {
      forcedStrategy,
    });
    assert.notEqual(status, 401);
  });
}

// ── URL-Strategie gewinnt über das Payload-Feld `strategy` ──────────────────

test('webhook/baseline: URL-Strategie überschreibt abweichendes Payload-Feld (strategy=forex_sr_fib_rsi im Body)', async () => {
  const payload = { ...signalFixtures.crypto_baseline.trade, strategy: 'forex_sr_fib_rsi' };
  const { env } = await run('/webhook/baseline', payload, { forcedStrategy: 'crypto_baseline' });
  const row = env.DB.insertedRow('signals');
  assert.ok(row, 'signals-Zeile wurde angelegt');
  assert.equal(row.strategy_key, 'crypto_baseline', 'URL (baseline) gewinnt über Payload-Feld (forex)');
});

test('webhook/forex: URL-Strategie überschreibt abweichendes Payload-Feld (strategy=crypto_baseline im Body)', async () => {
  const payload = { ...signalFixtures.crypto_baseline.trade, strategy: 'crypto_baseline' };
  const { env } = await run('/webhook/forex', payload, { forcedStrategy: 'forex_sr_fib_rsi' });
  const row = env.DB.insertedRow('signals');
  assert.ok(row, 'signals-Zeile wurde angelegt (candidate_rejected persistiert ebenfalls eine REJECTED-Zeile)');
  assert.equal(row.strategy_key, 'forex_sr_fib_rsi', 'URL (forex) gewinnt über Payload-Feld (baseline)');
});

test('webhook/sr-volume: fehlendes strategy-Feld im Payload wird durch die URL ersetzt', async () => {
  const payload = { ...signalFixtures.crypto_sr_volume.trade };
  delete payload.strategy;
  assert.equal(payload.strategy, undefined, 'Testvoraussetzung: kein strategy-Feld im Payload');
  const { env } = await run('/webhook/sr-volume', payload, { forcedStrategy: 'crypto_sr_volume' });
  const row = env.DB.insertedRow('signals');
  assert.ok(row, 'signals-Zeile wurde angelegt');
  assert.equal(row.strategy_key, 'crypto_sr_volume');
});

// ── Korrektes Routing bis zu processSignal ──────────────────────────────────

test('webhook/baseline: valider Trade-Payload wird bis processSignal durchgereicht (signals-Zeile mit korrektem strategy_key)', async () => {
  const payload = { ...signalFixtures.crypto_baseline.trade };
  delete payload.strategy; // URL soll allein entscheiden
  const { env, json } = await run('/webhook/baseline', payload, { forcedStrategy: 'crypto_baseline' });
  assert.equal(json.type, 'SIGNAL_NEW');
  assert.equal(json.status, 'received');
  const row = env.DB.insertedRow('signals');
  assert.ok(row, 'signals-Zeile wurde angelegt');
  assert.equal(row.strategy_key, 'crypto_baseline');
  assert.equal(row.outcome, 'OPEN', 'starkes Mean-Reversion-Setup passiert beide Gates');
});

test('webhook/sr-volume: valider Trade-Payload öffnet über den korrekten Endpunkt', async () => {
  const payload = { ...signalFixtures.crypto_sr_volume.trade };
  delete payload.strategy;
  const { env } = await run('/webhook/sr-volume', payload, { forcedStrategy: 'crypto_sr_volume' });
  const row = env.DB.insertedRow('signals');
  assert.ok(row);
  assert.equal(row.strategy_key, 'crypto_sr_volume');
  assert.equal(row.outcome, 'OPEN');
});

// ── /webhook/orderflow: deaktivierter Stub ──────────────────────────────────

test('webhook/orderflow: liefert 501 "temporarily disabled" über den echten Router, berührt die DB nicht', async () => {
  const restore = installDeterminism(NON_SESSION_UTC);
  try {
    const env = { ...makeEnv(), WEBHOOK_SECRET: SECRET };
    const { ctx, flush } = makeCtx();
    // Über den ECHTEN Default-Export (worker.fetch) statt handleWebhookRequest,
    // weil die Route bewusst VOR handleWebhookRequest abzweigt (kein Auth-Check
    // für einen deaktivierten Stub nötig) — das prüft den tatsächlichen
    // Router-Zweig, nicht nur eine Annahme darüber.
    const request = makeRequest('/webhook/orderflow', { symbol: 'BTCUSDT', direction: 'LONG' });
    const response = await worker.fetch(request, env, ctx);
    await flush();
    assert.equal(response.status, 501);
    const body = await response.json();
    assert.match(body.error, /temporarily disabled/i);
    assert.equal(env.DB.insertCount('signals'), 0);
  } finally {
    restore();
  }
});

// ── Router-Verdrahtung: /webhook/baseline über den echten fetch()-Einstieg ──
// (die übrigen Tests rufen handleWebhookRequest() direkt auf, um Auth/Routing-
// Logik isoliert zu prüfen; dieser Test stellt sicher, dass der Router in
// worker.js den Pfad tatsächlich auf handleWebhookRequest mit der richtigen
// forcedStrategy verdrahtet, nicht nur, dass die Funktion selbst korrekt ist.)

test('webhook/baseline über den echten Router (worker.fetch): korrektes Routing + Strategy-Override', async () => {
  const restore = installDeterminism(NON_SESSION_UTC);
  try {
    const env = { ...makeEnv(), WEBHOOK_SECRET: SECRET };
    const { ctx, flush } = makeCtx();
    const payload = { ...signalFixtures.crypto_baseline.trade, strategy: 'forex_sr_fib_rsi' };
    const request = makeRequest('/webhook/baseline', payload);
    const response = await worker.fetch(request, env, ctx);
    await flush();
    assert.notEqual(response.status, 401);
    const row = env.DB.insertedRow('signals');
    assert.ok(row, 'signals-Zeile wurde über den echten Router angelegt');
    assert.equal(row.strategy_key, 'crypto_baseline', 'Router verdrahtet /webhook/baseline korrekt, URL gewinnt über Payload');
  } finally {
    restore();
  }
});

// ── Bestehender generischer /webhook-Pfad bleibt unverändert ────────────────

test('webhook (generisch): ohne forcedStrategy entscheidet weiterhin das Payload-Feld `strategy`', async () => {
  const payload = { ...signalFixtures.crypto_sr_volume.trade, strategy: 'crypto_sr_volume' };
  const { env } = await run('/webhook', payload, { forcedStrategy: undefined });
  const row = env.DB.insertedRow('signals');
  assert.ok(row);
  assert.equal(row.strategy_key, 'crypto_sr_volume', 'Payload-Feld entscheidet, wenn keine URL-Strategie gesetzt ist');
});

test('webhook (generisch): falsches Secret → 401 (identischer Auth-Pfad wie die neuen Endpunkte)', async () => {
  const { status } = await run('/webhook', { ...signalFixtures.crypto_baseline.trade }, { secret: 'wrong' });
  assert.equal(status, 401);
});
