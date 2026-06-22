// Unit-Tests für die Asset-Class-Erkennung (AUFGABE 1). Lauf: node --test test/
//
// Regel (Krypto-Basis schlägt Forex, Metalle = Forex, unbekannt = Krypto):
//   1. Stablecoin-Quote (USDT/…) ODER Krypto-Basis (BTC/ETH/…) → 'crypto'
//   2. Edelmetall vs. Fiat (XAUUSD)                            → 'forex'
//   3. 6-stelliges Fiat-Paar (EURUSD)                          → 'forex'
//   4. sonst / unbekannt                                       → 'crypto'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectAssetClass, normalizeSymbol } from '../worker.js';

test('Krypto: Stablecoin-Quotes → crypto', () => {
  for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BTCUSDC', 'ETHBUSD']) {
    assert.equal(detectAssetClass(s), 'crypto', s);
  }
});

test('Krypto: Krypto-Basis gegen USD (sieht aus wie Forex) → crypto', () => {
  // Grenzfall: 6-stellig wie ein Forex-Paar, aber Krypto-Basis ⇒ crypto.
  for (const s of ['BTCUSD', 'ETHUSD', 'ADAUSD', 'XBTUSD']) {
    assert.equal(detectAssetClass(s), 'crypto', s);
  }
});

test('Forex: reine Fiat-Paare → forex', () => {
  for (const s of ['EURUSD', 'GBPUSD', 'USDJPY', 'GBPJPY', 'USDCHF', 'AUDNZD', 'EURGBP']) {
    assert.equal(detectAssetClass(s), 'forex', s);
  }
});

test('Forex: Edelmetalle gegen Fiat → forex', () => {
  for (const s of ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XAUEUR']) {
    assert.equal(detectAssetClass(s), 'forex', s);
  }
});

test('Trennzeichen werden ignoriert (BTC/USDT, EUR-USD, EUR:USD)', () => {
  assert.equal(detectAssetClass('BTC/USDT'), 'crypto');
  assert.equal(detectAssetClass('BTC-USDT'), 'crypto');
  assert.equal(detectAssetClass('EUR/USD'),  'forex');
  assert.equal(detectAssetClass('EUR-USD'),  'forex');
  assert.equal(detectAssetClass('EUR:USD'),  'forex');
});

test('Case-insensitiv (Kleinschreibung)', () => {
  assert.equal(detectAssetClass('btcusdt'), 'crypto');
  assert.equal(detectAssetClass('eurusd'),  'forex');
  assert.equal(detectAssetClass('xauusd'),  'forex');
});

test('Unbekannt / leer → Krypto-Default', () => {
  for (const s of ['', null, undefined, 'FOOBAR', 'AAPL', 'TSLA', 'EURFOO']) {
    assert.equal(detectAssetClass(s), 'crypto', String(s));
  }
});

test('normalizeSymbol entfernt Trenner und uppercased', () => {
  assert.equal(normalizeSymbol('btc-usdt'), 'BTCUSDT');
  assert.equal(normalizeSymbol('EUR/USD'),  'EURUSD');
  assert.equal(normalizeSymbol(' eur:usd '), 'EURUSD');
  assert.equal(normalizeSymbol(null), '');
});
