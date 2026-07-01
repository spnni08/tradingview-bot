// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - PRODUCTION WORKER
// Signal Processing · Snapshots · Telegram · Backtesting
// ═══════════════════════════════════════════════════════════════
//
// Cloudflare-Worker-Entrypoint (default export `fetch` + Cron-Handler).
// Enthält: Signal-Pipeline (analyzeWithRules, processSignal), die vier
// Strategie-Logiken, Score-Optimizer, Auth/Sessions, HTTP-Router und Cron-Jobs.
//
// Abhängigkeitsrichtung (azyklisch):
//   worker.js → src/render/pages.js → src/stats.js   (HTML-Rendering)
//   worker.js → src/stats.js                          (computeWinRate/Expectancy)
// Reine, seiteneffektfreie Bausteine liegen in src/ und werden hier re-exportiert.
//
// Annahmen: läuft in der Workers-Runtime (globale fetch/crypto/Date); D1 unter
// env.DB; Secrets/Tokens über env.* (Telegram/Anthropic/Cloudflare).
// Tests: test/analyzeWithRules.snapshot.test.js, test/processSignal.test.js
// und die übrigen test/*.test.js (137 Tests, node:test).

// ── Ausgelagerte Module (Schritt 3 Modularisierung) ──────────────────
import { computeWinRate, computeExpectancy } from './src/stats.js';
import {
  CSS_STYLES, _htmlPage, _renderLoginPage, _renderChangePwPage, _renderDashboardContent, _renderPlaceholderPage, _renderJournalTable, _renderJournalContent, _renderNewsList, _renderNewsContent, _renderBTTabBar, _getBTTabContent, _renderBacktestContent, _renderStatistikenContent, _renderSettingsNav, _renderSettingsSection, _renderSettingsPage
} from './src/render/pages.js';

// Dummy hash used to normalize timing when a login user is not found (M4).
const _DUMMY_HASH = 'pbkdf2:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc  = new TextEncoder();
  const km   = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, km, 256);
  const b64  = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
  return `pbkdf2:${b64(salt.buffer)}:${b64(bits)}`;
}

// Verifies a password against both PBKDF2 (new) and Base64 (legacy) hashes.
// Returns [match: boolean, needsUpgrade: boolean].
async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('pbkdf2:')) {
    return [stored === btoa(password), true];
  }
  const [, saltB64, hashB64] = stored.split(':');
  const salt = Uint8Array.from(atob(saltB64), c => c.charCodeAt(0));
  const enc  = new TextEncoder();
  const km   = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, km, 256);
  const b64  = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
  return [b64(bits) === hashB64, false];
}

// CORS is computed per-request inside the fetch handler to support
// env.ALLOWED_ORIGIN and Access-Control-Allow-Credentials.
// A static fallback is kept for the rare case jsonResponse is called
// before the per-request CORS headers are in scope.
const CORS_HEADERS_DEFAULT = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID, X-Webhook-Secret",
};

function buildCorsHeaders(request, env) {
  const allowed = env?.ALLOWED_ORIGIN;
  const origin  = request?.headers?.get('Origin') || '';

  // When ALLOWED_ORIGIN is configured, only that origin gets credentials.
  if (allowed) {
    if (origin === allowed) {
      return {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID, X-Webhook-Secret",
        "Access-Control-Allow-Credentials": "true",
        "Vary": "Origin",
      };
    }
    return CORS_HEADERS_DEFAULT;
  }

  // No ALLOWED_ORIGIN set: reflect the request origin so that
  // credentials: 'include' works from any origin. Browser spec forbids
  // combining credentials with the wildcard '*'. Set ALLOWED_ORIGIN to
  // restrict this to your Pages domain.
  if (origin) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID, X-Webhook-Secret",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin",
    };
  }

  return CORS_HEADERS_DEFAULT;
}

// Fallback — overridden by a local shadow inside fetch().
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS_DEFAULT }
  });
}

// Extract session cookie value from a Cookie header string.
function getSessionCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)wavescout_session=([^;]+)/);
  return match ? match[1] : null;
}

// Build a Set-Cookie string for the session token.
function sessionCookieHeader(sessionId, maxAgeSeconds = 86400) {
  return `wavescout_session=${sessionId}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAgeSeconds}`;
}

// Build a Set-Cookie string that clears the session cookie.
function clearSessionCookieHeader() {
  return 'wavescout_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0';
}

const MARKET_RADAR_CACHE_TTL_MS = 20 * 60 * 1000;
const MARKET_RADAR_MAX_EVENTS = 20;
const MARKET_RADAR_FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/feed/' },
  { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/' },
  { name: 'Google News - Bitcoin', url: 'https://news.google.com/rss/search?q=Bitcoin+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - BTC', url: 'https://news.google.com/rss/search?q=BTC+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Crypto Regulation', url: 'https://news.google.com/rss/search?q=crypto+regulation+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Bitcoin ETF', url: 'https://news.google.com/rss/search?q=Bitcoin+ETF+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - SEC Crypto', url: 'https://news.google.com/rss/search?q=SEC+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Stablecoin', url: 'https://news.google.com/rss/search?q=stablecoin+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Crypto Hack', url: 'https://news.google.com/rss/search?q=crypto+hack+exploit+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Binance', url: 'https://news.google.com/rss/search?q=Binance+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Bybit', url: 'https://news.google.com/rss/search?q=Bybit+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - MEXC', url: 'https://news.google.com/rss/search?q=MEXC+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - BloFin', url: 'https://news.google.com/rss/search?q=BloFin+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Fed CPI Bitcoin', url: 'https://news.google.com/rss/search?q=Fed+CPI+Bitcoin+when:7d&hl=en-US&gl=US&ceid=US:en' }
];

const RADAR_DISCLAIMER = "Nur Marktübersicht. Keine Finanzberatung. Keine Garantie für Gewinne.";
const AI_TIMEOUT_MS = 8000;
const TELEGRAM_TIMEOUT_MS = 5000;

// ═══════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════

async function sendTelegramMessage(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log('⚠️ Telegram not configured');
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
    const result = await response.json();
    console.log('📱 Telegram sent:', result.ok);
    return result.ok;
  } catch (error) {
    console.error('❌ Telegram error:', error);
    return false;
  }
}

// Sends to a dedicated alert bot/chat if configured (TELEGRAM_ALERT_BOT_TOKEN +
// TELEGRAM_ALERT_CHAT_ID), otherwise falls back to the regular bot/chat.
async function sendAlertMessage(env, message) {
  const token  = env.TELEGRAM_ALERT_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_ALERT_CHAT_ID   || env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
    const result = await res.json();
    console.log('🚨 Alert sent:', result.ok);
    return result.ok;
  } catch (error) {
    console.error('❌ Alert error:', error);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// NTFY.SH
// ═══════════════════════════════════════════════════════════════

// Sends an urgent ntfy.sh push notification for top-tier signals (score ≥ 95).
// Requires NTFY_TOPIC env secret. Runs in addition to Telegram.
async function sendNtfyAlert(env, symbol, timeframe, score) {
  const topic = env.NTFY_TOPIC;
  if (!topic) {
    console.log('⚠️ ntfy not configured (NTFY_TOPIC missing)');
    return false;
  }
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: {
        'Title':    `🚨 WAVESCOUT ${score}/100`,
        'Priority': 'urgent',
        'Tags':     'rotating_light,chart_with_upwards_trend',
        'Content-Type': 'text/plain',
      },
      body: `${symbol} | ${timeframe} | Score: ${score}`,
    });
    console.log('🔔 ntfy sent:', res.status);
    return res.ok;
  } catch (error) {
    console.error('❌ ntfy error:', error);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// WEB PUSH (RFC 8291 / RFC 8292 VAPID)
// Requires Worker secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
// Subscriptions stored in D1: push_subscriptions table
// ═══════════════════════════════════════════════════════════════

const _b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const _frm64u = str => {
  const b64 = (str + '===').replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
};

async function _hkdfExtract(salt, ikm) {
  const k = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, ikm));
}
async function _hkdfExpand(prk, info, len) {
  const k = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const b = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  const t = new Uint8Array(b.length + 1); t.set(b); t[b.length] = 1;
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, t)).slice(0, len);
}

async function _vapidJWT(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const sub = env.VAPID_SUBJECT || 'mailto:admin@wavescout.dev';
  const exp = Math.floor(Date.now() / 1000) + 43200;
  const enc = new TextEncoder();
  const hdr = _b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const pay = _b64u(enc.encode(JSON.stringify({ aud, exp, sub })));
  const unsigned = `${hdr}.${pay}`;
  const privKey = await crypto.subtle.importKey(
    'pkcs8', _frm64u(env.VAPID_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, enc.encode(unsigned));
  return `${unsigned}.${_b64u(sig)}`;
}

async function _encryptPushPayload(plaintext, subscription) {
  const clientPubBytes = _frm64u(subscription.keys.p256dh);
  const authSecret     = _frm64u(subscription.keys.auth);
  const clientPub = await crypto.subtle.importKey('raw', clientPubBytes, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const serverKP  = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPubBytes = new Uint8Array(await crypto.subtle.exportKey('raw', serverKP.publicKey));
  const sharedSecret   = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPub }, serverKP.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const prkKey = await _hkdfExtract(authSecret, sharedSecret);
  const keyInfoPfx = new TextEncoder().encode('WebPush: info\x00');
  const keyInfo = new Uint8Array(keyInfoPfx.length + clientPubBytes.length + serverPubBytes.length);
  keyInfo.set(keyInfoPfx); keyInfo.set(clientPubBytes, keyInfoPfx.length); keyInfo.set(serverPubBytes, keyInfoPfx.length + clientPubBytes.length);
  const ikm  = await _hkdfExpand(prkKey, keyInfo, 32);
  const prk  = await _hkdfExtract(salt, ikm);
  const cek  = await _hkdfExpand(prk, 'Content-Encoding: aes128gcm\x00', 16);
  const nonce = await _hkdfExpand(prk, 'Content-Encoding: nonce\x00', 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const content = new TextEncoder().encode(plaintext);
  const padded  = new Uint8Array(content.length + 1); padded.set(content); padded[content.length] = 2;
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded));

  const body = new Uint8Array(16 + 4 + 1 + 65 + encrypted.length);
  let off = 0;
  body.set(salt); off += 16;
  new DataView(body.buffer).setUint32(off, 4096); off += 4;
  body[off++] = 65;
  body.set(serverPubBytes, off); off += 65;
  body.set(encrypted, off);
  return body;
}

async function sendWebPush(env, subscription, title, body, url = '/') {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return false;
  try {
    const payload   = JSON.stringify({ title, body, url });
    const encrypted = await _encryptPushPayload(payload, subscription);
    const jwt       = await _vapidJWT(env, subscription.endpoint);
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':     'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Authorization':    `vapid t=${jwt},k=${env.VAPID_PUBLIC_KEY}`,
        'TTL':              '86400',
      },
      body: encrypted,
    });
    if (res.status === 410 || res.status === 404) return 'expired';
    console.log('🔔 Web Push sent:', res.status);
    return res.ok;
  } catch (err) {
    console.error('❌ Web Push error:', err.message);
    return false;
  }
}

async function sendWebPushToAll(env, title, body, url = '/') {
  if (!env.VAPID_PRIVATE_KEY) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY, user_id TEXT, endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER
      )
    `).run();
    const { results } = await env.DB.prepare('SELECT * FROM push_subscriptions').all();
    if (!results?.length) return;
    const expired = [];
    await Promise.all((results).map(async row => {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      const r = await sendWebPush(env, sub, title, body, url);
      if (r === 'expired') expired.push(row.id);
    }));
    if (expired.length) {
      await Promise.all(expired.map(id =>
        env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id).run()
      ));
    }
  } catch (err) {
    console.error('❌ sendWebPushToAll error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// FIELD ENCRYPTION (AES-256-GCM via env.ENCRYPTION_KEY secret)
// Set ENCRYPTION_KEY to a random 32-char string in Cloudflare Secrets.
// Without it, sensitive fields are stored as-is with a warning.
// ═══════════════════════════════════════════════════════════════

async function _getAesKey(env) {
  if (!env.ENCRYPTION_KEY) return null;
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ENCRYPTION_KEY), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('wavescout-aes-v1'), iterations: 10_000 },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encryptField(env, plaintext) {
  if (!plaintext) return plaintext;
  const key = await _getAesKey(env);
  if (!key) { console.warn('⚠️ ENCRYPTION_KEY not set — storing sensitive field unencrypted'); return plaintext; }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
  return `aes:${b64(iv.buffer)}:${b64(ct)}`;
}

async function decryptField(env, stored) {
  if (!stored || !stored.startsWith('aes:')) return stored;
  const key = await _getAesKey(env);
  if (!key) { console.warn('⚠️ ENCRYPTION_KEY not set — cannot decrypt stored field'); return ''; }
  try {
    const [, ivB64, ctB64] = stored.split(':');
    const iv = Uint8Array.from(atob(ivB64), c => c.charCodeAt(0));
    const ct = Uint8Array.from(atob(ctB64), c => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch (e) {
    console.error('❌ decryptField failed:', e.message);
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════
// EXCHANGE API (Autotrade)
// ═══════════════════════════════════════════════════════════════

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacBase64(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function calcOrderQty(tradeAmountUsdt, entryPrice) {
  if (!entryPrice || !Number.isFinite(entryPrice) || entryPrice <= 0) return 0;
  const qty = tradeAmountUsdt / entryPrice;
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  // Round to reasonable precision based on price level
  if (entryPrice >= 10000) return parseFloat(qty.toFixed(3));
  if (entryPrice >= 100)   return parseFloat(qty.toFixed(2));
  if (entryPrice >= 1)     return parseFloat(qty.toFixed(1));
  return parseFloat(qty.toFixed(0));
}

async function placeBybitOrder(cfg, { symbol, direction, qty, tp, sl }) {
  const base = cfg.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
  const timestamp = String(Date.now());
  const recv = '5000';
  const bodyObj = {
    category: 'linear',
    symbol,
    side: direction === 'LONG' ? 'Buy' : 'Sell',
    orderType: 'Market',
    qty: String(qty),
    timeInForce: 'IOC',
    positionIdx: 0,
    ...(tp ? { takeProfit: String(tp), tpTriggerBy: 'LastPrice' } : {}),
    ...(sl ? { stopLoss:   String(sl), slTriggerBy: 'LastPrice' } : {}),
  };
  const body = JSON.stringify(bodyObj);
  const sign = await hmacHex(cfg.apiSecret, timestamp + cfg.apiKey + recv + body);
  const res = await fetch(`${base}/v5/order/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': cfg.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': sign,
      'X-BAPI-RECV-WINDOW': recv,
    },
    body,
  });
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Bybit ${data.retCode}: ${data.retMsg}`);
  return { orderId: data.result?.orderId, raw: data.result };
}

async function placeBlofInOrder(cfg, { symbol, direction, qty, tp, sl }) {
  // BloFin uses demo-trading URL for paper/testnet mode
  const base = cfg.testnet
    ? 'https://demo-trading-openapi.blofin.com'
    : 'https://openapi.blofin.com';
  const path = '/api/v1/trade/order';
  const timestamp = String(Date.now());
  // BloFin symbol format: BTC-USDT-SWAP
  const instId = symbol.replace(/([A-Z]+)(USDT)$/, '$1-$2-SWAP');
  const bodyObj = {
    instId,
    marginMode: 'cross',
    side: direction === 'LONG' ? 'buy' : 'sell',
    orderType: 'market',
    size: String(qty),
    ...(tp ? { tpTriggerPx: String(tp), tpOrdPx: '-1' } : {}),
    ...(sl ? { slTriggerPx: String(sl), slOrdPx: '-1' } : {}),
  };
  const body = JSON.stringify(bodyObj);
  const sign = await hmacBase64(cfg.apiSecret, timestamp + 'POST' + path + body);
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ACCESS-KEY': cfg.apiKey,
      'ACCESS-SIGN': sign,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': cfg.passphrase || '',
    },
    body,
  });
  const data = await res.json();
  if (data.code !== '0') throw new Error(`BloFin ${data.code}: ${data.msg}`);
  return { orderId: data.data?.[0]?.ordId, raw: data.data?.[0] };
}

// Returns the autotrade config with sensitive fields decrypted.
async function loadAutotradeConfig(env) {
  const raw = await getSetting(env, 'autotrade_config', null);
  if (!raw) return null;
  const cfg = JSON.parse(raw);
  cfg.apiKey     = await decryptField(env, cfg.apiKey);
  cfg.apiSecret  = await decryptField(env, cfg.apiSecret);
  cfg.passphrase = await decryptField(env, cfg.passphrase);
  return cfg;
}

async function placeExchangeOrder(env, { symbol, direction, entry, tp, sl }) {
  const cfg = await loadAutotradeConfig(env);
  if (!cfg) return { ok: false, error: 'Autotrade nicht konfiguriert' };
  if (!cfg.enabled) return { ok: false, error: 'Autotrade deaktiviert' };
  const amount = parseFloat(cfg.tradeAmount) || 10;
  const qty = calcOrderQty(amount, entry);
  if (qty <= 0) return { ok: false, error: 'Menge zu klein' };
  const params = { symbol, direction, qty, tp, sl };
  if (cfg.broker === 'bybit')  return { ok: true, ...(await placeBybitOrder(cfg, params))  };
  if (cfg.broker === 'blofin') return { ok: true, ...(await placeBlofInOrder(cfg, params)) };
  return { ok: false, error: `Broker nicht unterstützt: ${cfg.broker}` };
}

async function withTimeout(promise, ms, fallbackValue = null) {
  let timeoutId;
  const timeoutPromise = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve(fallbackValue), ms);
  });
  const result = await Promise.race([promise, timeoutPromise]);
  clearTimeout(timeoutId);
  return result;
}

// ─── Signal helper functions ─────────────────────────────────

function tryParseJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (_) { return null; }
}

/**
 * Maps a numeric signal score (0–100) to a qualitative label.
 * @param {number} score - Signal score.
 * @returns {string} One of PREMIUM / GUT / OKAY / SCHWACH / SKIP / UNBEKANNT.
 */
function getSignalQuality(score) {
  if (score == null || isNaN(score)) return 'UNBEKANNT';
  if (score >= 90) return 'PREMIUM';
  if (score >= 75) return 'GUT';
  if (score >= 60) return 'OKAY';
  if (score >= 45) return 'SCHWACH';
  return 'SKIP';
}

/**
 * Absolute percentage distance between two prices (always ≥ 0), rounded to 2dp.
 * @param {number} target - Target price (e.g. TP or SL).
 * @param {number} base - Reference price (e.g. entry).
 * @returns {number|null} Percent distance, or null for missing/zero inputs.
 */
function safePct(target, base) {
  if (!target || !base || base === 0) return null;
  return parseFloat(((Math.abs(target - base) / Math.abs(base)) * 100).toFixed(2));
}

/**
 * Reward-to-risk ratio for a trade. Works for LONG and SHORT.
 * @param {number} entry - Entry price.
 * @param {number} tp - Take-profit price.
 * @param {number} sl - Stop-loss price.
 * @param {boolean} isLong - true for LONG, false for SHORT.
 * @returns {number|null} reward/risk rounded to 2dp, or null if inputs invalid or risk ≤ 0.
 */
function calcRR(entry, tp, sl, isLong) {
  const e = parseFloat(entry);
  const t = parseFloat(tp);
  const s = parseFloat(sl);
  if (!isFinite(e) || !isFinite(t) || !isFinite(s)) return null;
  const reward = isLong ? t - e : e - t;
  const risk   = isLong ? e - s : s - e;
  if (risk <= 0) return null;
  return parseFloat((reward / risk).toFixed(2));
}

// ─── Telegram formatting ──────────────────────────────────────

function escapeHtml(text) {
  if (text == null) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Kurzes, menschenlesbares Strategie-Label für Telegram (z. B. "Krypto-1
// (RSI+EMA200)"). Greift auf STRATEGIES[key].display zu, fällt auf .label bzw.
// den rohen Key zurück. Gibt null zurück, wenn keine Strategie bekannt ist
// (→ Aufrufer blendet die Zeile dann aus). STRATEGIES ist ein später im Modul
// deklariertes const; da diese Funktion erst zur Laufzeit aufgerufen wird, ist
// der Zugriff unkritisch.
function strategyDisplayLabel(strategyKey) {
  const key = String(strategyKey || '').trim();
  if (!key) return null;
  const def = (typeof STRATEGIES !== 'undefined') ? STRATEGIES[key] : null;
  return (def && (def.display || def.label)) || key;
}

// Kompakte, nach Betrag sortierte Score-Komponenten-Zeile aus dem
// score_breakdown-Objekt (z. B. "RSI +18 · EMA +15 · Trend +10"). Akzeptiert
// sowohl ein Objekt als auch einen JSON-String und ignoriert Nullbeiträge.
// Liefert '' wenn nichts Verwertbares vorliegt → Aufrufer blendet die Zeile aus.
function formatScoreComponents(breakdown, max = 4) {
  const obj = (breakdown && typeof breakdown === 'object') ? breakdown : tryParseJSON(breakdown);
  if (!obj || typeof obj !== 'object') return '';
  const LABELS = {
    rsi: 'RSI', ema: 'EMA', trend: 'Trend', wave_bias: 'Bias',
    timeframe: 'TF', confidence: 'Conf', support_resistance: 'S&R',
    session_filter: 'Session', vp: 'VP',
  };
  const parts = Object.entries(obj)
    .map(([k, v]) => [k, Number(v)])
    .filter(([, v]) => Number.isFinite(v) && v !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, max)
    .map(([k, v]) => `${LABELS[k] || k} ${v >= 0 ? '+' : ''}${v}`);
  return parts.join(' · ');
}

function formatSignalForTelegram(signal) {
  const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
  const sc    = signal.ai_score || 0;
  const scoreEmoji = sc >= 90 ? '⭐⭐⭐' : sc >= 75 ? '⭐⭐' : '⭐';
  const quality = signal.signal_quality || getSignalQuality(sc);
  const rrVal   = signal.risk_reward;
  const rrStr   = rrVal ? `1:${rrVal.toFixed(1)}` : 'N/A';
  const fmt     = (v) => v != null && !isNaN(v) ? `$${parseFloat(v).toFixed(2)}` : 'unbekannt';

  // Optionale Zusatz-Infos (alle mit Fallback → Zeile entfällt, wenn leer).
  const tfStr     = signal.timeframe ? ` · ${escapeHtml(String(signal.timeframe))}` : '';
  const stratLbl  = strategyDisplayLabel(signal.strategy_key);
  const stratLine = stratLbl ? `\n🧭 Strategie: <b>${escapeHtml(stratLbl)}</b>` : '';
  const reversalLine = String(signal.signal_class || '').toUpperCase() === 'REVERSAL'
    ? `\n⚠️ <b>Reversal-Signal</b>` : '';

  // TP1 (Teilgewinn → Breakeven) optional; TP2 ist das bestehende finale ai_tp.
  const tp1Line  = (signal.ai_tp1 != null && !isNaN(signal.ai_tp1))
    ? `\n🎯 TP1: ${fmt(signal.ai_tp1)} <i>(Teilgewinn → Breakeven)</i>` : '';
  const tp2Label = tp1Line ? 'TP2' : 'TP';

  const comps    = formatScoreComponents(signal.score_breakdown);
  const compLine = comps ? `\n📊 Komponenten: ${comps}` : '';

  const biasLine = signal.daily_bias
    ? `\n📐 Tagesbias: ${escapeHtml(signal.daily_bias)}${signal.bias_match ? ` · ${escapeHtml(signal.bias_match)}` : ''}` : '';

  const matched = tryParseJSON(signal.matched_rules) || [];
  const failed  = tryParseJSON(signal.failed_rules)  || [];
  const matchedStr = matched.slice(0, 3).map(r => `✅ ${escapeHtml(r)}`).join('\n') || '–';
  const failedStr  = failed.slice(0, 3).map(r => `❌ ${escapeHtml(r)}`).join('\n')  || '–';

  const vpLine = (signal.vp_zone && signal.vp_zone !== 'none' && signal.vp_score > 0)
    ? `\n📊 Volume Profile: Bounce an <b>${signal.vp_zone}</b> (+${signal.vp_score} Score)` : '';

  const disclaimer = '\n\n⚠️ <i>Hinweis: Keine Finanzberatung. Signale dienen nur zu Analyse- und Backtesting-Zwecken. Trading birgt Risiko. Keine Garantie für Gewinne.</i>';

  return `${emoji} <b>${escapeHtml(signal.symbol)}</b> ${signal.direction}${tfStr}${stratLine}${reversalLine}

${scoreEmoji} Score: <b>${sc}/100</b> · ${quality}${compLine}
💰 Entry: ${fmt(signal.ai_entry ?? signal.price)}${tp1Line}
🎯 ${tp2Label}: ${fmt(signal.ai_tp)}
🛑 SL: ${fmt(signal.ai_sl)}
⚖️ R:R: ${rrStr}${biasLine}${vpLine}

✅ <b>Erfüllt:</b>
${matchedStr}

❌ <b>Fehlt / Warnung:</b>
${failedStr}

📋 ${escapeHtml(signal.ai_reason) || 'Signal von TradingView'}${disclaimer}`.trim();
}

function formatPriorityAlert(signal) {
  const sc  = signal.ai_score || 0;
  const dir = signal.direction === 'LONG' ? '🟢' : '🔴';
  const dirTxt = signal.direction === 'LONG' ? 'LONG' : 'SHORT';
  const fmt = (v) => v != null && !isNaN(v) ? `$${parseFloat(v).toFixed(4)}` : '–';
  const rrVal = signal.risk_reward;
  const rrStr = rrVal ? `1:${rrVal.toFixed(1)}` : 'N/A';
  const stars = sc >= 90 ? '⭐⭐⭐' : '⭐⭐';

  // Optionale Zusatz-Infos (alle mit Fallback → Zeile entfällt, wenn leer).
  const tfStr     = signal.timeframe ? ` · ${escapeHtml(String(signal.timeframe))}` : '';
  const stratLbl  = strategyDisplayLabel(signal.strategy_key);
  const stratLine = stratLbl ? `\n🧭 <b>${escapeHtml(stratLbl)}</b>` : '';
  const reversalLine = String(signal.signal_class || '').toUpperCase() === 'REVERSAL'
    ? `\n⚠️ <b>Reversal-Signal</b>` : '';

  // TP1 (Teilgewinn → Breakeven) optional; TP2 ist das bestehende finale ai_tp.
  const tp1Line  = (signal.ai_tp1 != null && !isNaN(signal.ai_tp1))
    ? `\n🎯 TP1:   <b>${fmt(signal.ai_tp1)}</b> <i>(Teilgewinn → Breakeven)</i>` : '';
  const tp2Label = tp1Line ? 'TP2' : 'TP';

  const comps    = formatScoreComponents(signal.score_breakdown);
  const compLine = comps ? `\n📊 ${comps}` : '';

  const ts = `\n🕒 ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  return `🚨🔥 <b>PRIORITY SIGNAL</b> 🔥🚨
━━━━━━━━━━━━━━━━━━━━━
${stars} Score: <b>${sc}/100</b> · ${getSignalQuality(sc)}
${dir} <b>${escapeHtml(signal.symbol)}</b> · ${dirTxt}${tfStr}${stratLine}${reversalLine}
━━━━━━━━━━━━━━━━━━━━━
💰 Entry: <b>${fmt(signal.ai_entry ?? signal.price)}</b>${tp1Line}
🎯 ${tp2Label}:   <b>${fmt(signal.ai_tp)}</b>
🛑 SL:    <b>${fmt(signal.ai_sl)}</b>
⚖️ R:R:   <b>${rrStr}</b>${compLine}
━━━━━━━━━━━━━━━━━━━━━
📋 ${escapeHtml(signal.ai_reason) || ''}${ts}

⚠️ <i>Keine Finanzberatung. Eigenverantwortlich prüfen.</i>`.trim();
}

// ═══════════════════════════════════════════════════════════════
// EXIT MANAGEMENT — Teil-Take-Profit (TP1) + Breakeven + TP2
// ═══════════════════════════════════════════════════════════════
//
// Ersetzt die alte 3h-Zwangsschließung. Statt einen knapp am TP gescheiterten
// Trade nach 3h pauschal zu schließen, wird ein Teil der Position früh (TP1)
// realisiert und der SL der Restposition auf ~Breakeven nachgezogen — so kann
// ein Trade, der TP1 erreicht hat, nicht mehr in den vollen Verlust drehen.
//
// Alle Werte sind hier zentral konfigurierbar (kein Hardcoding in der Logik):
//   TP2 (finales Ziel) ist das bestehende Take-Profit (analysis.tp, 1.5R).
//   TP1 liegt bei TP1_DISTANCE_FRAC der Strecke Entry→TP2.
const EXIT_CONFIG = {
  SL_DISTANCE_PCT:    1.00, // SL-Distanz in % vom Entry (= 1R-Referenz)
  TP2_R_MULTIPLE:     1.50, // finales TP2 = TP2_R_MULTIPLE × R
  TP1_DISTANCE_FRAC:  0.60, // TP1-Trigger = Entry + 0.60 × (TP2 − Entry)
  TP1_CLOSE_FRAC:     0.50, // Anteil der Position, der bei TP1 geschlossen wird
  BREAKEVEN_OFFSET_R: 0.10, // nach TP1: SL = Entry + 0.10R (R = |Entry − Original-SL|), leicht im Plus
};

// Leitet den TP1-Triggerpreis aus Entry und finalem TP2 ab.
// Funktioniert für LONG und SHORT, da TP2 immer auf der Gewinnseite liegt.
function deriveTp1(entry, tp2, cfg = EXIT_CONFIG) {
  if (!Number.isFinite(entry) || !Number.isFinite(tp2)) return null;
  return entry + cfg.TP1_DISTANCE_FRAC * (tp2 - entry);
}

// Prozentuale Kursbewegung Entry→exit in Trade-Richtung (LONG positiv bei Anstieg).
function exitMovePct(entry, exit, isLong) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === 0) return 0;
  return isLong ? ((exit - entry) / entry) * 100 : ((entry - exit) / entry) * 100;
}

/**
 * Reine, seiteneffektfreie Exit-Entscheidung für das TP1/Breakeven/TP2-Modell.
 * Wird von beiden Evaluatoren benutzt (practice_trades-Tick & signals-Cron) und
 * ist damit die zentrale, unit-getestete Stelle der Exit-Logik.
 *
 * @param {Object}  pos
 * @param {boolean} pos.isLong       LONG (true) oder SHORT (false)
 * @param {number}  pos.entry        Einstiegspreis
 * @param {number}  pos.tp2          finales Take-Profit (= bestehendes tp, 1.5R)
 * @param {number}  pos.sl           ORIGINAL-Stop-Loss (1R) — dient als R-Referenz
 * @param {number}  [pos.tp1]        TP1-Trigger (wird aus entry/tp2 abgeleitet, falls nicht gesetzt)
 * @param {boolean} [pos.tp1Hit]     ob TP1 bereits gefüllt wurde
 * @param {number}  [pos.currentSl]  aktiver SL (nach TP1 = Breakeven); Default abgeleitet
 * @param {number}  price            aktueller Marktpreis
 * @param {Object}  [cfg]            EXIT_CONFIG (injizierbar für Tests)
 * @returns {{action:'NONE'|'TP1_PARTIAL'|'TP2_FINAL'|'SL_FINAL', ...}}
 *   TP1_PARTIAL → { newSl, realizedPct, tp1Price }  (Trade bleibt OPEN, SL → Breakeven)
 *   TP2_FINAL   → { outcome:'WIN', exitPrice, finalPct }
 *   SL_FINAL    → { outcome:'WIN'|'LOSS', exitPrice, finalPct }
 */
function evaluateExit(pos, price, cfg = EXIT_CONFIG) {
  const { isLong, entry, tp2, sl } = pos || {};
  if (typeof isLong !== 'boolean' || ![entry, tp2, sl, price].every(Number.isFinite)) {
    return { action: 'NONE' };
  }
  const slDist = Math.abs(entry - sl);
  if (slDist === 0) return { action: 'NONE' };

  const tp1    = Number.isFinite(pos.tp1) ? pos.tp1 : deriveTp1(entry, tp2, cfg);
  const tp1Hit = pos.tp1Hit === true;
  const beSl   = isLong ? entry + cfg.BREAKEVEN_OFFSET_R * slDist
                        : entry - cfg.BREAKEVEN_OFFSET_R * slDist;
  // Aktiver SL: expliziter currentSl, sonst nach TP1 Breakeven, davor Original.
  const activeSl = Number.isFinite(pos.currentSl) ? pos.currentSl : (tp1Hit ? beSl : sl);

  const closeFrac = cfg.TP1_CLOSE_FRAC;
  const tp1Pct    = exitMovePct(entry, tp1, isLong);
  // Geblendetes Gesamtergebnis: TP1-Teil (closeFrac) + Restposition (1−closeFrac) bis exit.
  // Nutzt das feste TP1-Level, daher korrekt auch wenn TP1 im selben Tick mit erreicht wird.
  const blended = (exit) => closeFrac * tp1Pct + (1 - closeFrac) * exitMovePct(entry, exit, isLong);

  const slHit  = isLong ? price <= activeSl : price >= activeSl;
  const tp2Hit = isLong ? price >= tp2      : price <= tp2;
  const tp1Trg = isLong ? price >= tp1      : price <= tp1;

  // Reihenfolge: SL-Schutz zuerst, dann TP2 (final), dann TP1 (Teilschließung).
  if (slHit) {
    if (tp1Hit) {
      // SL nach TP1 = Breakeven(+Offset): Restposition ~neutral, gesamt durch TP1 im Plus.
      const finalPct = blended(activeSl);
      return { action: 'SL_FINAL', outcome: finalPct >= 0 ? 'WIN' : 'LOSS', exitPrice: activeSl, finalPct };
    }
    // SL vor TP1 = voller Verlust am Original-SL.
    return { action: 'SL_FINAL', outcome: 'LOSS', exitPrice: activeSl, finalPct: exitMovePct(entry, activeSl, isLong) };
  }

  if (tp2Hit) {
    return { action: 'TP2_FINAL', outcome: 'WIN', exitPrice: tp2, finalPct: blended(tp2) };
  }

  if (!tp1Hit && tp1Trg) {
    return { action: 'TP1_PARTIAL', newSl: beSl, realizedPct: closeFrac * tp1Pct, tp1Price: tp1 };
  }

  return { action: 'NONE' };
}

// ═══════════════════════════════════════════════════════════════
// ASSET CLASS DETECTION (crypto | forex)
// ═══════════════════════════════════════════════════════════════
//
// Erkennt anhand des Symbol-Strings die Asset-Klasse. Entscheidungsreihenfolge
// (Krypto-Bezug schlägt Forex; Metalle zählen als Forex):
//   1. Stablecoin-Quote (USDT/USDC/…) ODER bekannte Krypto-Basis (BTC/ETH/…)
//      → 'crypto'  (erfasst auch BTCUSD/ETHUSD über die Krypto-Basis)
//   2. Edelmetall (XAU/XAG/XPT/XPD) gegen Fiat        → 'forex' (Metalle)
//   3. 6-stelliges Paar aus zwei Fiat-Codes           → 'forex'
//   4. sonst / unbekannt                              → 'crypto' (Default, Bot ist krypto-primär)
const FIAT_CODES    = ['USD','EUR','GBP','JPY','CHF','AUD','NZD','CAD','SEK','NOK','SGD','HKD','PLN','ZAR','MXN','TRY','CNH'];
const METAL_CODES   = ['XAU','XAG','XPT','XPD'];
const STABLE_QUOTES = ['USDT','USDC','BUSD','DAI','TUSD','FDUSD'];
const CRYPTO_ASSETS = ['BTC','XBT','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','MATIC','DOT','LINK','LTC','TRX','SHIB','ATOM'];

// Symbol auf reine A–Z0–9 normalisieren (Trenner wie '/', '-', ':' entfernen).
function normalizeSymbol(symbol) {
  return String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Liefert 'crypto' | 'forex'. Niemals throw; unbekannt → 'crypto'.
function detectAssetClass(symbol) {
  const s = normalizeSymbol(symbol);
  if (!s) return 'crypto';

  // 1. Edelmetalle gegen Fiat → Forex/Metalle (XAUUSD, XAGUSD, XPTUSD).
  //    Bewusst VOR der Krypto-Prüfung: 'XPTUSD' = 'XP'+'TUSD' würde sonst
  //    fälschlich auf den TUSD-Stablecoin-Suffix matchen.
  for (const m of METAL_CODES) {
    if (s.startsWith(m) && FIAT_CODES.includes(s.slice(m.length))) return 'forex';
  }

  // 2. Eindeutiger Krypto-Bezug (Stablecoin-Quote oder Krypto-Basis).
  if (STABLE_QUOTES.some(q => s.endsWith(q))) return 'crypto';
  if (CRYPTO_ASSETS.some(a => s.startsWith(a))) return 'crypto';

  // 3. Reines 6-stelliges Fiat-Paar (EURUSD, GBPJPY).
  if (s.length === 6 && FIAT_CODES.includes(s.slice(0, 3)) && FIAT_CODES.includes(s.slice(3))) {
    return 'forex';
  }

  // 4. Default.
  return 'crypto';
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY REGISTRY — 4 parallele Strategien (3 Krypto, 1 Forex)
// ═══════════════════════════════════════════════════════════════
//
// Jede Strategie ist ein eigenes Pine-Script, das an dieselbe /webhook-URL
// postet und sich über das `strategy`-Feld im Payload identifiziert. Die
// ENTRY-Logik liegt in Pine; der Worker routet, gated (Session/Score), wendet
// die GEMEINSAME Exit-Logik (TP1→Breakeven→TP2) an und trackt pro Strategie.
//
// `exit` überschreibt EXIT_CONFIG je Strategie (TP1/TP2/SL-% pro Strategie
// konfigurierbar, kein Hardcoding). Fehlt das strategy-Feld im Payload, fällt
// der Worker rückwärtskompatibel auf 'crypto_baseline' zurück.
const STRATEGIES = {
  // 1. Kontrollgruppe: bestehende RSI + EMA200-Logik, Score-Optimizer-Gewichte.
  crypto_baseline: {
    label:        'Crypto Baseline (Kontrollgruppe)',
    display:      'Krypto-1 (RSI+EMA200)', // kurzes, menschenlesbares Label für Telegram
    assetClass:   'crypto',
    // Zwei Gates: scoreCandidate (Gate 1, Schwelle 60, PR #134) siebt breit
    // vor; scoreMeanReversionBaseline (Gate 2, Schwelle 75) filtert daraus die
    // starken Setups. Der frühere Final-Gate `analyzeWithRules.score ≥ 75` war
    // strukturell kaputt (PR #136 hatte ihn deshalb entfernt statt repariert):
    // analyzeWithRules ist ein TRENDFOLGE-Scorer und liest price/ema50/ema200/
    // trend/confidence — Felder, die das deployte v2-Pine für crypto_baseline
    // nicht sendet (es sendet stattdessen direction/entry/rsi/emaDistPct/
    // nearSup/nearRes/rsiDeadZone). scoreMeanReversionBaseline liest den
    // tatsächlichen Feldsatz und bewertet Mean-Reversion-Qualität (Details
    // s. dort) und ist das VOLLSTÄNDIGE, deterministische Gate 2 — Claude läuft
    // für baseline NICHT (siehe processSignal: analyzeSignalWithAI() prompted
    // dieselben Trendfolge-Felder wie analyzeWithRules, ein API-Call brächte
    // dort keinen Erkenntnisgewinn). analyzeWithRules bleibt nur für entry/tp/sl
    // und Telemetrie (matched/failed_rules, score_breakdown) im Einsatz.
    useScoreGate: true,
    minScore:     75,
    sessionGate:  false,
    exit:         {},     // EXIT_CONFIG-Defaults (1% SL, 1.5R TP2)
  },
  // 2. Level über Volume Profile (VAL/VAH/POC) + EMA200-Trendfilter.
  crypto_sr_volume: {
    label:        'Crypto S&R Volume Profile',
    display:      'Krypto-2 (S&R+VP)',
    assetClass:   'crypto',
    useScoreGate: false,  // Entry kommt aus Pine; Score nur Telemetrie
    minScore:     0,
    sessionGate:  false,
    emaFilter:    true,
    exit:         {},
  },
  // 3. Range-Breakout mit Volumen-Bestätigung (> volMult × Ø-Vol) + EMA-Filter.
  crypto_orderflow_breakout: {
    label:        'Crypto Orderflow Breakout',
    display:      'Krypto-3 (Order Flow/Breakout)',
    assetClass:   'crypto',
    useScoreGate: false,
    minScore:     0,
    sessionGate:  false,
    rangeN:       20,     // Range über letzte N Kerzen (in Pine berechnet/gesendet)
    volMult:      1.5,    // Ausbruchskerze braucht Volumen > volMult × Ø-Volumen
    emaFilter:    true,   // Ausbrüche gegen EMA200-Trend verwerfen (default an)
    exit:         {},
  },
  // 4. Forex: große S&R/VP-Zonen + Fib-Feinzone + RSI-Trendbestätigung.
  //    HART session-gated (London-Open / London-NY-Overlap).
  forex_sr_fib_rsi: {
    label:        'Forex S&R + Fib + RSI',
    display:      'Forex (S&R/VP+Fib+RSI)',
    assetClass:   'forex',
    useScoreGate: false,
    minScore:     0,
    sessionGate:  true,
    exit:         { SL_DISTANCE_PCT: 0.30 }, // Forex: engere SL-Distanz (konfigurierbar)
  },
};

// ═══════════════════════════════════════════════════════════════
// CANDIDATE SCORING — per-Strategie, konfigurierbare Gewichte
// ═══════════════════════════════════════════════════════════════
//
// Jedes Pine-Signal wird ZUERST hier bewertet (Score 0-100) bevor
// ein echter Trade/Signal-Eintrag angelegt wird. Wird der Schwellenwert
// (threshold) nicht erreicht, landet das Signal nur in signal_candidates
// (Datenbasis für spätere Kalibrierung), aber nicht in signals.
//
// Gewichte und Schwellenwerte sind konfigurierbar über:
//   settings-Key "candidate_scoring_overrides" (JSON-Map, pro strategyKey).
// Fehlt der Key, greifen CANDIDATE_SCORING_DEFAULTS.
//
// KALIBRIERUNG (kein Bug-Fix): threshold für ALLE vier Strategien von 60 auf
// 70 angehoben. Hintergrund: Gate 1 (Candidate-Score) soll breit vorfiltern,
// aber "breit" bei 60 ließ zu viele schwache Setups bis zu Gate 2 (Mean-
// Reversion-Scorer bei crypto_baseline) bzw. direkt zum Trade (Pine-
// getrustete Strategien, useScoreGate=false) durch. Score 60-69 hat sich als
// nicht aussagekräftig genug erwiesen, um überhaupt zu Gate 2 vorzudringen.
// Gilt einheitlich für alle Strategien — kein strategie-spezifisches Tuning
// in diesem Schritt (siehe test/candidateScoring.test.js für die Vorher/
// Nachher-Auswirkung auf die 10 bekannten Live-Payloads).

const CANDIDATE_SCORING_DEFAULTS = {
  crypto_baseline: {
    threshold: 70,
    base: 50,
    weights: {
      // EMA-Distanz zum EMA200 (historisch: 0.5-1.3 % performte am besten)
      ema_dist_sweet_spot:      20,  // 0.5–1.3 %
      ema_dist_acceptable:       8,  // 1.3–2.5 % (noch ok, aber extended)
      ema_dist_too_close:      -12,  // < 0.5 % (zu nah, kein Puffer)
      ema_dist_too_far:         -8,  // > 2.5 % (zu überstreckt)
      // RSI Dead-Zone 55–65 (LONG) / 35–45 (SHORT): schlechte historische WR
      rsi_dead_zone_penalty:   -15,
      // S/R-Kontext
      near_sup_long:            12,  // LONG + Support in Nähe → günstig
      near_res_short:           12,  // SHORT + Resistance in Nähe → günstig
      near_res_long_penalty:    -8,  // LONG + Resistance über Preis → Gegenwind
      near_sup_short_penalty:   -8,  // SHORT + Support unter Preis → Gegenwind
    },
  },
  crypto_sr_volume: {
    threshold: 70,
    base: 40,
    weights: {
      reclaim:              25,  // echter Level-Reclaim (nicht nur Touch)
      breakdown:            25,  // echter Breakdown
      rsi_was_oversold:     10,  // RSI war überverkauft (LONG)
      rsi_was_overbought:   10,  // RSI war überkauft (SHORT)
      rsi_rising:            8,  // RSI steigt (LONG-Bestätigung)
      rsi_falling:           8,  // RSI fällt (SHORT-Bestätigung)
      trend_ok:             10,  // EMA200-Trend passt zur Richtung
    },
  },
  crypto_orderflow_breakout: {
    threshold: 70,
    base: 35,
    weights: {
      breakout_above_range:  30,  // echter Range-Breakout nach oben
      breakout_below_range:  30,  // echter Range-Breakdown nach unten
      vol_ratio_high:        20,  // volRatio >= 2.0 (starke Bestätigung)
      vol_ratio_medium:      10,  // volRatio 1.5–2.0
      vol_ratio_low_penalty: -5,  // volRatio < 1.5 (reiner Vol-Spike ohne Breakout)
      trend_ok:              10,  // EMA200-Trendfilter passt
    },
  },
  forex_sr_fib_rsi: {
    threshold: 70,
    base: 35,
    weights: {
      reclaim_val:      30,  // echter VAL-Reclaim (LONG)
      breakdown_vah:    30,  // echter VAH-Breakdown (SHORT)
      dist_very_close:  15,  // Abstand zu VAL/VAH < 0.1 % (hohe Präzision)
      dist_close:        5,  // Abstand 0.1–0.3 %
    },
  },
};

// Leitet die Score-relevanten Feature-Felder aus dem ROHEN Pine-alert()-Payload
// ab. Hintergrund (Bug aus PR #120): scoreCandidate() erwartete vorberechnete
// Felder (emaDistPct, reclaim, breakoutAboveRange, volRatio, reclaimVAL,
// distToVAL …), die KEIN Pine-Script jemals sendet — die Scripts liefern nur
// Rohbausteine (close, ema200, range_high/low, candle_volume/avg_volume,
// vah/val, support/resistance) PLUS das `trigger`-Feld. Dadurch blieb jedes
// Bonus-Feld leer → Score = base (35-50) < 60 → 100 % REJECTED.
//
// Diese Funktion mappt die Rohfelder auf die Score-Features. Wichtig: der
// `trigger` ist Ground-Truth — der Alert feuert NUR, wenn die Pine-Entry-
// Bedingung (Reclaim / Breakdown / Breakout) erfüllt ist. Bereits explizit
// gesetzte Felder werden NIE überschrieben (Rückwärtskompatibilität / Tests).
function normalizeSignalForScoring(strategyKey, signal) {
  if (!signal || typeof signal !== 'object') return signal;
  const s = { ...signal };
  const dir     = String(s.direction || '').toUpperCase();
  const trigger = String(s.trigger || s.setup_type || '').toUpperCase();
  const trend   = String(s.trend || '').toUpperCase();
  const price   = parseFloat(s.price ?? s.close ?? NaN);
  const ema50   = parseFloat(s.ema50 ?? NaN);
  const ema200  = parseFloat(s.ema200 ?? NaN);

  // Trend-Bestätigung: explizites Pine-`trend`-Feld ODER EMA50/EMA200-Lage.
  const trendOkDerived =
    (dir === 'LONG'  && (trend === 'BULLISH' || (ema50 > ema200))) ||
    (dir === 'SHORT' && (trend === 'BEARISH' || (ema50 < ema200)));

  if (strategyKey === 'crypto_baseline') {
    // emaDistPct aus close & ema200 ableiten (Pine sendet beide, aber kein Pct).
    if (s.emaDistPct == null && s.ema_dist_pct == null &&
        Number.isFinite(price) && Number.isFinite(ema200) && ema200 !== 0) {
      s.emaDistPct = Math.abs(price - ema200) / ema200 * 100;
    }
  }

  else if (strategyKey === 'crypto_sr_volume') {
    const zone = String(s.vp_zone || '').toUpperCase();
    const isVah = trigger.includes('VAH') || zone === 'VAH';  // SHORT-Bounce
    const isVal = trigger.includes('VAL') || zone === 'VAL';  // LONG-Bounce
    if (s.reclaim == null)
      s.reclaim = dir === 'LONG'  && (isVal || !isVah);
    if (s.breakdown == null)
      s.breakdown = dir === 'SHORT' && (isVah || !isVal);
    if (s.trendOk == null && s.trend_ok == null) s.trendOk = trendOkDerived;
    // RSI-Kontext: Snapshot-Proxy (Payload enthält keine RSI-Historie).
    const rsi = parseFloat(s.rsi ?? NaN);
    if (s.rsiWasOversold == null && s.rsi_was_oversold == null &&
        dir === 'LONG' && Number.isFinite(rsi))
      s.rsiWasOversold = rsi <= 42;
    if (s.rsiWasOverbought == null && s.rsi_was_overbought == null &&
        dir === 'SHORT' && Number.isFinite(rsi))
      s.rsiWasOverbought = rsi >= 58;
  }

  else if (strategyKey === 'crypto_orderflow_breakout') {
    const rangeHigh = parseFloat(s.range_high ?? s.rangeHigh ?? NaN);
    const rangeLow  = parseFloat(s.range_low  ?? s.rangeLow  ?? NaN);
    const candleVol = parseFloat(s.candle_volume ?? s.candleVolume ?? NaN);
    const avgVol    = parseFloat(s.avg_volume    ?? s.avgVolume    ?? NaN);
    if (s.breakoutAboveRange == null && s.breakout_above_range == null)
      s.breakoutAboveRange = trigger.includes('UP') ||
        (Number.isFinite(price) && Number.isFinite(rangeHigh) && price >= rangeHigh) ||
        (dir === 'LONG' && trigger.includes('BREAK'));
    if (s.breakoutBelowRange == null && s.breakout_below_range == null)
      s.breakoutBelowRange = trigger.includes('DOWN') ||
        (Number.isFinite(price) && Number.isFinite(rangeLow) && price <= rangeLow) ||
        (dir === 'SHORT' && trigger.includes('BREAK'));
    // volRatio aus candle_volume / avg_volume ableiten (Pine sendet beide).
    if (s.volRatio == null && s.vol_ratio == null &&
        Number.isFinite(candleVol) && Number.isFinite(avgVol) && avgVol > 0)
      s.volRatio = candleVol / avgVol;
    if (s.trendOk == null && s.trend_ok == null) s.trendOk = trendOkDerived;
  }

  else if (strategyKey === 'forex_sr_fib_rsi') {
    const support    = parseFloat(s.support    ?? NaN);
    const resistance = parseFloat(s.resistance ?? NaN);
    // trigger = FIB_SR_RSI_LONG / FIB_SR_RSI_SHORT → LONG=Support-Reclaim,
    // SHORT=Resistance-Breakdown.
    if (s.reclaimVAL == null && s.reclaim_val == null)
      s.reclaimVAL = dir === 'LONG'  && (trigger.includes('LONG')  || !trigger.includes('SHORT'));
    if (s.breakdownVAH == null && s.breakdown_vah == null)
      s.breakdownVAH = dir === 'SHORT' && (trigger.includes('SHORT') || !trigger.includes('LONG'));
    // RAW Preisdifferenz ableiten (nicht Prozent!) — wavescout_forex.pine
    // sendet distToVAL/distToVAH ebenfalls als rohe Differenz (`close - fxVAL`
    // bzw. `fxVAH - close`). scoreCandidate normalisiert einheitlich auf
    // Prozent von `price`; würde hier bereits eine Prozentzahl abgelegt, würde
    // sie dort ein zweites Mal normalisiert (falsches Ergebnis).
    if (s.distToVAL == null && s.dist_to_val == null &&
        dir === 'LONG' && Number.isFinite(price) && Number.isFinite(support))
      s.distToVAL = price - support;
    if (s.distToVAH == null && s.dist_to_vah == null &&
        dir === 'SHORT' && Number.isFinite(price) && Number.isFinite(resistance))
      s.distToVAH = resistance - price;
  }

  return s;
}

// Robust boolean-Parser für Payload-Felder. Pine/Webhook liefert Flags als
// STRINGS ("true"/"false") oder Zahlen (1/0). `!!"false"` wäre fälschlich true
// und `"true" == 1` ist false — beides würde die Score-Flags verfälschen.
function parseBool(v) {
  return v === true || v === 1 || v === '1' ||
         (typeof v === 'string' && v.trim().toLowerCase() === 'true');
}

// Berechnet den Kandidaten-Score (0-100) für eine gegebene Strategie.
// customWeights überschreibt einzelne Einträge aus CANDIDATE_SCORING_DEFAULTS.
// Gibt { score, details, threshold } zurück (pure Funktion, kein DB-Zugriff).
function scoreCandidate(strategyKey, signal, customWeights = null) {
  const defaults = CANDIDATE_SCORING_DEFAULTS[strategyKey];
  if (!defaults) return { score: 50, details: {}, threshold: 60 };

  // Rohen Pine-Payload auf Score-Features mappen (siehe normalizeSignalForScoring).
  signal = normalizeSignalForScoring(strategyKey, signal);

  const w   = customWeights ? { ...defaults.weights, ...customWeights } : defaults.weights;
  const thr = (customWeights?._threshold ?? defaults.threshold);
  const dir = String(signal.direction || '').toUpperCase();

  let score    = defaults.base;
  const details = {};

  // ── crypto_baseline ─────────────────────────────────────────
  if (strategyKey === 'crypto_baseline') {
    // emaDistPct ist VORZEICHENBEHAFTET, wenn Pine ihn direkt sendet (− = Preis
    // unter EMA200). Die Sweet-Spot-Bänder bewerten die DISTANZ (Magnitude) —
    // das Vorzeichen ist Trend-Richtung, nicht Abstand. `Math.abs`, weil das
    // alte `> 0` jedes Below-EMA-Signal komplett verwarf → Score-Deckel.
    const emaDistPct = Math.abs(parseFloat(signal.emaDistPct ?? signal.ema_dist_pct ?? 0));
    if (emaDistPct > 0) {
      if (emaDistPct >= 0.5 && emaDistPct <= 1.3) {
        score += w.ema_dist_sweet_spot;
        details.ema_dist = w.ema_dist_sweet_spot;
      } else if (emaDistPct > 1.3 && emaDistPct <= 2.5) {
        score += w.ema_dist_acceptable;
        details.ema_dist = w.ema_dist_acceptable;
      } else if (emaDistPct < 0.5) {
        score += w.ema_dist_too_close;
        details.ema_dist = w.ema_dist_too_close;
      } else {
        score += w.ema_dist_too_far;
        details.ema_dist = w.ema_dist_too_far;
      }
    }

    // RSI dead-zone: explizites Flag (Pine sendet "true"/"false" ODER 1) ODER aus
    // dem RSI-Bereich hergeleitet. parseBool, weil String-"true" mit `== 1` nie
    // greifen würde (und "false" sonst als truthy zählte).
    const rsi = parseFloat(signal.rsi ?? 50);
    const inDeadZone = parseBool(signal.rsiDeadZone) || parseBool(signal.rsi_dead_zone) ||
      (dir === 'LONG'  && rsi >= 55 && rsi <= 65) ||
      (dir === 'SHORT' && rsi >= 35 && rsi <= 45);
    if (inDeadZone) {
      score += w.rsi_dead_zone_penalty;
      details.rsi_dead_zone = w.rsi_dead_zone_penalty;
    }

    // nearSup/nearRes kommen als String "true"/"false" → parseBool statt !!(…),
    // weil !!"false" === true wäre (jedes Signal bekäme sonst konstant beide
    // Boni/Mali → der S/R-Faktor diskriminiert NICHT mehr).
    const nearSup = parseBool(signal.nearSup ?? signal.near_sup);
    const nearRes = parseBool(signal.nearRes ?? signal.near_res);
    if (dir === 'LONG') {
      if (nearSup) { score += w.near_sup_long;         details.near_sup = w.near_sup_long; }
      if (nearRes) { score += w.near_res_long_penalty; details.near_res = w.near_res_long_penalty; }
    } else if (dir === 'SHORT') {
      if (nearRes) { score += w.near_res_short;          details.near_res = w.near_res_short; }
      if (nearSup) { score += w.near_sup_short_penalty;  details.near_sup = w.near_sup_short_penalty; }
    }
  }

  // ── crypto_sr_volume ─────────────────────────────────────────
  else if (strategyKey === 'crypto_sr_volume') {
    // Das deployte wavescout_sr_volume.pine sendet reclaim/breakdown/
    // rsiWasOversold/rsiWasOverbought/rsiRising/rsiFalling/trendOk als
    // STRINGS ("true"/"false", via str.tostring()) — wie rsiDeadZone/nearSup
    // bei crypto_baseline vor PR #134. `!!("false")` ist fälschlich true und
    // ein Klartext-Truthy-Check (`signal.trendOk || …`) ist es ebenso → jedes
    // Signal bekam bisher IMMER reclaim/breakdown/trendOk = true, unabhängig
    // vom tatsächlichen Wert. parseBool (PR #134) behebt das identisch.
    const reclaim          = parseBool(signal.reclaim);
    const breakdown        = parseBool(signal.breakdown);
    const rsiWasOversold   = parseBool(signal.rsiWasOversold   ?? signal.rsi_was_oversold);
    const rsiWasOverbought = parseBool(signal.rsiWasOverbought ?? signal.rsi_was_overbought);
    const rsiRising        = parseBool(signal.rsiRising        ?? signal.rsi_rising);
    const rsiFalling       = parseBool(signal.rsiFalling       ?? signal.rsi_falling);
    const trendOk          = parseBool(signal.trendOk          ?? signal.trend_ok);

    if (reclaim)   { score += w.reclaim;   details.reclaim   = w.reclaim; }
    if (breakdown) { score += w.breakdown; details.breakdown = w.breakdown; }
    if (rsiWasOversold)   { score += w.rsi_was_oversold;   details.rsi_was_oversold   = w.rsi_was_oversold; }
    if (rsiWasOverbought) { score += w.rsi_was_overbought; details.rsi_was_overbought = w.rsi_was_overbought; }
    if (rsiRising)  { score += w.rsi_rising;  details.rsi_rising  = w.rsi_rising; }
    if (rsiFalling) { score += w.rsi_falling; details.rsi_falling = w.rsi_falling; }
    if (trendOk)    { score += w.trend_ok;    details.trend_ok    = w.trend_ok; }
  }

  // ── crypto_orderflow_breakout ─────────────────────────────────
  else if (strategyKey === 'crypto_orderflow_breakout') {
    const breakoutAbove = !!(signal.breakoutAboveRange || signal.breakout_above_range);
    const breakoutBelow = !!(signal.breakoutBelowRange || signal.breakout_below_range);
    if (breakoutAbove) { score += w.breakout_above_range; details.breakout_above_range = w.breakout_above_range; }
    if (breakoutBelow) { score += w.breakout_below_range; details.breakout_below_range = w.breakout_below_range; }

    const volRatio = parseFloat(signal.volRatio ?? signal.vol_ratio ?? 0);
    if (volRatio >= 2.0) {
      score += w.vol_ratio_high;   details.vol_ratio = w.vol_ratio_high;
    } else if (volRatio >= 1.5) {
      score += w.vol_ratio_medium; details.vol_ratio = w.vol_ratio_medium;
    } else if (volRatio > 0) {
      score += w.vol_ratio_low_penalty; details.vol_ratio = w.vol_ratio_low_penalty;
    }

    if (signal.trendOk || signal.trend_ok) { score += w.trend_ok; details.trend_ok = w.trend_ok; }
  }

  // ── forex_sr_fib_rsi ─────────────────────────────────────────
  else if (strategyKey === 'forex_sr_fib_rsi') {
    // Das deployte wavescout_forex.pine sendet reclaimVAL/breakdownVAH
    // ebenfalls als STRINGS ("true"/"false") — derselbe Bug wie oben bei
    // crypto_sr_volume: `signal.reclaimVAL || …` ist für den String "false"
    // truthy. parseBool behebt das.
    const reclaimVAL   = parseBool(signal.reclaimVAL   ?? signal.reclaim_val);
    const breakdownVAH = parseBool(signal.breakdownVAH ?? signal.breakdown_vah);
    if (reclaimVAL)   { score += w.reclaim_val;   details.reclaim_val   = w.reclaim_val; }
    if (breakdownVAH) { score += w.breakdown_vah; details.breakdown_vah = w.breakdown_vah; }

    // Abstand zu VAL (LONG) oder VAH (SHORT). wavescout_forex.pine sendet
    // distToVAL/distToVAH als ROHE Preisdifferenz (`close - fxVAL` bzw.
    // `fxVAH - close`, kann negativ sein) — NICHT als Prozent, obwohl der
    // Feldname (parallel zu emaDistPct) das nahelegt und die Schwellen unten
    // (0.1/0.3) als Prozent gedacht sind. Für ein Paar wie EUR/USD (~1.08)
    // ist jede reale Preisdifferenz (z.B. 0.0005) automatisch < 0.1 → der
    // dist_very_close-Bonus hätte praktisch IMMER gefeuert, unabhängig von
    // der tatsächlichen Nähe zum Level. Auf Prozent von `price` normalisieren
    // (Math.abs — das Vorzeichen sagt nur "über/unter Level", nichts über die
    // Nähe), analog zur emaDistPct-Behandlung bei crypto_baseline. Ohne
    // gültigen Preis (z.B. direkte scoreCandidate-Aufrufe ohne price/entry)
    // bleibt dist bei 999 → kein Bonus, kein Crash.
    const forexPrice = parseFloat(signal.price ?? signal.entry ?? NaN);
    const rawDist = dir === 'LONG'
      ? parseFloat(signal.distToVAL ?? signal.dist_to_val ?? NaN)
      : parseFloat(signal.distToVAH ?? signal.dist_to_vah ?? NaN);
    const dist = (Number.isFinite(rawDist) && Number.isFinite(forexPrice) && forexPrice > 0)
      ? Math.abs(rawDist) / forexPrice * 100
      : 999;
    if (dist < 0.1) {
      score += w.dist_very_close; details.dist_to_level = w.dist_very_close;
    } else if (dist < 0.3) {
      score += w.dist_close;      details.dist_to_level = w.dist_close;
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, details, threshold: thr };
}

// ═══════════════════════════════════════════════════════════════
// MEAN-REVERSION SCORER (crypto_baseline Gate 2, Schwelle 75)
// ═══════════════════════════════════════════════════════════════
//
// scoreCandidate() (Gate 1, ≥60) ist ein breiter Filter, der grobe Kandidaten
// aussiebt. Dieser Scorer ist Gate 2 (≥75) und soll aus den Gate-1-Kandidaten
// die tatsächlich starken Setups herausfiltern. Er ersetzt analyzeWithRules als
// Final-Gate für crypto_baseline: analyzeWithRules ist ein TRENDFOLGE-Scorer
// (liest price/ema50/ema200/trend/confidence — Felder, die das deployte v2-
// Pine für crypto_baseline NICHT sendet; 6 von 8 Regeln fanden „keine Daten",
// der Score klappte strukturell bei ~60 und erreichte 75 nie — PR #136 hatte
// das Gate deshalb ganz entfernt statt es zu reparieren). Diese Funktion nutzt
// stattdessen die tatsächlich gesendeten Felder (rsi, emaDistPct, nearSup,
// nearRes, rsiDeadZone) und bewertet MEAN-REVERSION-Qualität — das Gegenteil
// von Trendfolge: ein starkes Setup ist vom EMA überdehnt (nicht knapp dran),
// RSI im Extrembereich (nicht im mittleren Trend-Bereich) und idealerweise an
// einem S/R-Level, das den Bounce stützt.
//
// Gewichtung (Base 40, validiert gegen die 10 realen Payloads aus PR #134,
// siehe test/meanReversionScoring.test.js):
//   - RSI-Extremität (bis zu +25): das stärkste Mean-Reversion-Signal — je
//     extremer der RSI in Setup-Richtung, desto wahrscheinlicher der Bounce.
//     RSI 30-70 (Normalbereich) trägt bewusst nichts bei.
//   - EMA-Distanz (bis zu +22, |emaDistPct|): Überdehnung ist HIER gut (das
//     Gegenteil von Trendfolge, wo Nähe zum EMA gut ist) — Richtung des
//     Vorzeichens ist irrelevant, nur die Magnitude zählt (Math.abs). Die
//     Top-Stufe wurde von einem anfänglichen +20 auf +22 angehoben: mit +20
//     landeten die drei stärksten realen Setups (RSI 30-39, EMA-Dist >1.3%,
//     klares nearSup) exakt auf der 75-Schwelle (40 base + 20 ema + 15 sr =
//     75) — ein Gate, das auf der Kante balanciert, ist fragil gegenüber
//     Rundungs-/Payload-Rauschen. +22 gibt den drei stärksten realen Setups
//     2 Punkte Luft (Score 77), ohne die klar schwächeren Setups (die alle
//     ≥8 Punkte unter der Schwelle bleiben) in Reichweite zu bringen.
//   - S/R-Nähe (+15 bei eindeutiger Setup-Seite, +10 wenn beide Flags gesetzt): ein
//     eindeutiges Level bestätigt das Setup stärker als ein ambivalentes
//     Signal (Preis irgendwo im mittleren Bereich zwischen beiden Levels).
//   - RSI-Dead-Zone (−15): RSI 55-65 (LONG) bzw. 45-35 (SHORT) ist per
//     Definition KEIN Extremum — explizit kein Mean-Reversion-Setup, auch
//     wenn andere Faktoren (EMA-Distanz, S/R) günstig aussehen.
//
// Gibt einen numerischen Score (0-100) zurück, kein Detail-Objekt — die
// Aufrufstelle (processSignal) vergleicht ihn direkt gegen minScore (75).
function scoreMeanReversionBaseline(signal) {
  const dir     = String(signal.direction || '').toUpperCase();
  const isLong  = dir === 'LONG';
  const isShort = dir === 'SHORT';

  const rsi      = parseFloat(signal.rsi ?? 50);
  const emaDist  = Math.abs(parseFloat(signal.emaDistPct ?? signal.ema_dist_pct ?? 0));
  const nearSup  = parseBool(signal.nearSup ?? signal.near_sup);
  const nearRes  = parseBool(signal.nearRes ?? signal.near_res);
  const deadZone = parseBool(signal.rsiDeadZone ?? signal.rsi_dead_zone);

  let score = 40;

  // RSI-Extremität: nur außerhalb des Normalbereichs (30-70) relevant.
  if (isLong) {
    if      (rsi < 25) score += 25;
    else if (rsi < 28) score += 18;
    else if (rsi < 30) score += 10;
  } else if (isShort) {
    if      (rsi > 75) score += 25;
    else if (rsi > 72) score += 18;
    else if (rsi > 70) score += 10;
  }

  // EMA-Distanz: Betrag zählt, Vorzeichen ist Trend-Richtung, nicht Abstand.
  if      (emaDist >= 1.0) score += 22;
  else if (emaDist >= 0.5) score += 12;
  else if (emaDist >= 0.1) score += 5;

  // S/R-Nähe: eindeutiges Level > ambivalentes Signal (beide Flags gesetzt).
  if (nearSup && nearRes)          score += 10;
  else if (isLong  && nearSup)     score += 15;
  else if (isShort && nearRes)     score += 15;

  // RSI-Dead-Zone: kein Extremum, kein Mean-Reversion-Setup.
  if (deadZone) score -= 15;

  return Math.max(0, Math.min(100, Math.round(score)));
}

// Lädt optionale Gewichts-Overrides aus der settings-Tabelle.
// Format: { "crypto_baseline": { "ema_dist_sweet_spot": 25, "_threshold": 65 }, ... }
async function loadCandidateScoringConfig(env, strategyKey) {
  try {
    const raw = await getSetting(env, 'candidate_scoring_overrides', null);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map?.[strategyKey] ?? null;
  } catch (_) {
    return null;
  }
}

// Speichert einen Signal-Kandidaten (immer, unabhängig vom Score-Ergebnis).
async function saveSignalCandidate(env, { signal, strategyKey, strategyId, candidateScore, threshold, scoreDetails, passedThreshold, signalId }) {
  try {
    const id = `cand_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare(`
      INSERT INTO signal_candidates (
        id, received_at, strategy_key, strategy_id,
        symbol, timeframe, direction, price, rsi,
        ema_dist_pct, near_sup, near_res, rsi_dead_zone,
        reclaim, breakdown, rsi_was_oversold, rsi_was_overbought,
        rsi_rising, rsi_falling, trend_ok, poc,
        breakout_above_range, breakout_below_range, vol_ratio,
        reclaim_val, breakdown_vah, dist_to_val, dist_to_vah,
        candidate_score, score_threshold, score_details,
        passed_threshold, signal_id, raw_payload
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?
      )
    `).bind(
      id, Date.now(), strategyKey, strategyId || null,
      signal.symbol || null, String(signal.timeframe || ''), signal.direction || null,
      signal.price ?? signal.close ?? null,
      signal.rsi ?? null,
      // crypto_baseline
      signal.emaDistPct ?? signal.ema_dist_pct ?? null,
      signal.nearSup ?? signal.near_sup ?? null,
      signal.nearRes ?? signal.near_res ?? null,
      signal.rsiDeadZone ?? signal.rsi_dead_zone ?? null,
      // crypto_sr_volume
      signal.reclaim   != null ? (signal.reclaim   ? 1 : 0) : null,
      signal.breakdown != null ? (signal.breakdown ? 1 : 0) : null,
      signal.rsiWasOversold   ?? signal.rsi_was_oversold   ?? null,
      signal.rsiWasOverbought ?? signal.rsi_was_overbought ?? null,
      signal.rsiRising  ?? signal.rsi_rising  ?? null,
      signal.rsiFalling ?? signal.rsi_falling ?? null,
      signal.trendOk    ?? signal.trend_ok    ?? null,
      signal.poc        ?? null,
      // crypto_orderflow_breakout
      signal.breakoutAboveRange ?? signal.breakout_above_range ?? null,
      signal.breakoutBelowRange ?? signal.breakout_below_range ?? null,
      signal.volRatio   ?? signal.vol_ratio   ?? null,
      // forex_sr_fib_rsi
      signal.reclaimVAL   ?? signal.reclaim_val   ?? null,
      signal.breakdownVAH ?? signal.breakdown_vah ?? null,
      signal.distToVAL    ?? signal.dist_to_val   ?? null,
      signal.distToVAH    ?? signal.dist_to_vah   ?? null,
      // scoring
      candidateScore,
      threshold,
      JSON.stringify(scoreDetails || {}),
      passedThreshold ? 1 : 0,
      signalId || null,
      JSON.stringify(signal).substring(0, 2000)
    ).run();
    return id;
  } catch (e) {
    console.error('❌ saveSignalCandidate failed:', e.message);
    return null;
  }
}

// Forex-Handelsfenster (HART gated). Vorgabe in MEZ (CET = UTC+1), intern UTC:
//   London-Open 09–10 MEZ → 08–09 UTC · London/NY-Overlap 14–17 MEZ → 13–16 UTC.
// NB: ohne Sommerzeit gerechnet — bei Bedarf hier anpassen.
const FOREX_SESSIONS_UTC = [
  { name: 'London-Open',       startMin:  8 * 60, endMin:  9 * 60 },
  { name: 'London/NY-Overlap', startMin: 13 * 60, endMin: 16 * 60 },
];

// True, wenn `date` in einem der Forex-Handelsfenster liegt.
function isWithinForexSession(date = new Date(), sessions = FOREX_SESSIONS_UTC) {
  const t = date.getUTCHours() * 60 + date.getUTCMinutes();
  return sessions.some(s => t >= s.startMin && t < s.endMin);
}

// Wählt den Strategie-Key für ein Signal (rückwärtskompatibel: default baseline).
function resolveStrategyKey(signal) {
  const raw = String(signal?.strategy || signal?.strategy_key || '').trim().toLowerCase();
  return STRATEGIES[raw] ? raw : 'crypto_baseline';
}

// Merged Exit-Config für eine Strategie (EXIT_CONFIG + per-Strategie-Overrides).
function exitConfigForStrategy(strategyKey) {
  const def = STRATEGIES[strategyKey];
  return { ...EXIT_CONFIG, ...(def?.exit || {}) };
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY SYSTEM
// ═══════════════════════════════════════════════════════════════

// Top-Down Daytrading Strategie v2.0
// Setup A (Pullback) · Setup B (Continuation-Breakout)
// Fokus: BTC/USDT · ETH/USDT · (opt. SOL/USDT) | Entry 5–15min | Bias auf 4H
const DEFAULT_STRATEGY_CONFIG = {
  version: 'v2.0',
  rules: {
    rsi:                { enabled: true, weight: 18 }, // Setup A: oversold/bought; Setup B: trend-range (45-65)
    ema:                { enabled: true, weight: 15 }, // EMA50/200 alignment + EMA200 distance (min 1%)
    trend:              { enabled: true, weight: 10 },
    wave_bias:          { enabled: true, weight: 8  },
    support_resistance: { enabled: true, weight: 10 }, // "Preis in Key-Zone" ist Pflicht in v2.0
    timeframe:          { enabled: true, weight: 7  }, // 5min/15min bevorzugt (Entry-Timeframes)
    confidence:         { enabled: true, weight: 7  },
    session_filter:     { enabled: true, weight: 5  }, // London 07-10 UTC / US-Open 13:30-16 UTC
  },
  thresholds: {
    min_trade_score:    75,
    min_telegram_score: 75,
    max_risk:           'MEDIUM',
    min_rr:             1.5,      // TP1 mind. 1:1.5R laut Strategie
    risk_per_trade_pct: 1.0,      // 1% Risiko pro Trade
    daily_stop_loss_r:  2,        // -2R Daily Stop
    daily_win_stop_r:   3,        // +3R Daily Win-Stop
    max_trades_per_day: 3,
  }
};

// ═══════════════════════════════════════════════════════════════
// AI ANALYSIS
// ═══════════════════════════════════════════════════════════════

// Guard: ensure prompt is a non-empty string before sending to the API.
// Returns the trimmed prompt, or throws with a clear log message.
function requireNonEmptyPrompt(prompt, context = 'AI call') {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    const msg = `❌ [${context}] Blocked: prompt is empty or non-string. Falling back to rule-based analysis.`;
    console.error(msg);
    throw new Error(msg);
  }
  return prompt.trim();
}

// `ruleFallback` überschreibt den internen Fallback (analyzeWithRules), falls
// der Aufrufer einen besseren/deterministischen Ersatz hat. Wichtig für
// crypto_baseline: analyzeWithRules ist für den v2-Payload strukturell blind
// (siehe scoreMeanReversionBaseline oben) — OHNE ruleFallback würde jeder
// Claude-Fehler (Timeout, Rate-Limit, kein API-Key) Gate 2 still auf genau
// den kaputten Trendfolge-Score zurückfallen lassen, den dieser Scorer
// ersetzen soll. processSignal übergibt dafür fallbackAnalysis.
async function analyzeSignalWithAI(env, signal, strategyConfig = null, abortSignal = null, ruleFallback = null) {
  const fallback = () => ruleFallback || analyzeWithRules(signal, strategyConfig);
  if (!env.ANTHROPIC_API_KEY) {
    console.log('⚠️ No AI API key, using rule-based analysis');
    return fallback();
  }
  try {
    const setupType   = String(signal.setup_type || signal.trigger || '').toUpperCase();
    const isSetupB    = setupType.includes('CONTINUATION') || setupType.includes('BREAKOUT') || setupType.includes('SETUP_B');
    const setupLabel  = isSetupB ? 'Setup B – Continuation-Breakout' : 'Setup A – Pullback-Trade';
    const ema200Dist  = signal.price && signal.ema200
      ? ((Math.abs(signal.price - signal.ema200) / signal.ema200) * 100).toFixed(2)
      : 'n/a';
    const priceVsEma200 = signal.price && signal.ema200
      ? (signal.price > signal.ema200 ? 'ABOVE' : 'BELOW')
      : 'n/a';

    const rawPrompt = `Du analysierst ein Trading-Signal nach der Top-Down Daytrading Strategie v2.0.

Strategie-Kontext:
- Setup: ${setupLabel}
- Fokus: BTC/USDT, ETH/USDT (optional SOL/USDT)
- Entry-Timeframes: 5min / 15min | Bias auf 4H
- Bias gilt nur wenn: EMA50/200 Alignment UND Preis klar über/unter EMA200 (min. 1% Abstand)
- Preis direkt am EMA200 (<0.5% Abstand) = Ausschluss
- Setup A (Pullback): RSI überverkauft/überkauft = gut; in Key-Zone; Struktur dreht; Bestätigungs-Pattern
- Setup B (Continuation): Starker 4H-Trend; RSI im Trend-Bereich (45-65 für Long); Konsolidierung bricht in Trendrichtung
- TP gestaffelt: TP1 bei 1:1.5R (50% schließen + SL auf BE), TP2 bei 1:3R
- Bevorzugte Sessions: London (07-10 UTC), US-Open (13:30-16 UTC)
- Ausschluss: Seitwärtsmarkt, R/R < 1:1.5, RSI extrem (>75 / <25), Major News innerhalb 15min

Signal-Daten:
- Symbol: ${signal.symbol || 'UNKNOWN'}
- Richtung: ${signal.direction || 'UNKNOWN'}
- Preis: ${signal.price ?? 0}
- Timeframe: ${signal.timeframe || 'UNKNOWN'}
- Trigger: ${signal.trigger || 'WEBHOOK'}
- RSI: ${signal.rsi ?? 'n/a'}
- EMA50: ${signal.ema50 ?? 'n/a'}
- EMA200: ${signal.ema200 ?? 'n/a'} (Preis ist ${priceVsEma200} dem EMA200, Abstand: ${ema200Dist}%)
- Trend: ${signal.trend || 'n/a'}
- Wave Bias: ${signal.wave_bias || 'n/a'}
- Support: ${signal.support ?? 'n/a'}
- Resistance: ${signal.resistance ?? 'n/a'}
- Konfidenz: ${signal.confidence ?? 'n/a'}%
${await (async () => {
  try {
    const rows = await env.DB.prepare(
      `SELECT title, impact, category FROM market_events WHERE status = 'ACTIVE' AND impact IN ('HIGH','MEDIUM') AND updated_at >= ? ORDER BY impact ASC, updated_at DESC LIMIT 4`
    ).bind(Date.now() - 4 * 60 * 60 * 1000).all();
    if (!rows.results?.length) return '';
    return '\nAktuelle Marktnews (letzte 4h):\n' +
      rows.results.map(n => `- [${n.impact}] ${n.title}`).join('\n') +
      '\nBerücksichtige diese News: HIGH-Impact erhöht das Risiko erheblich und sollte den Score senken.';
  } catch { return ''; }
})()}
Bewerte das Signal nach v2.0 Kriterien. Antworte NUR als JSON:
{
  "recommendation": "RECOMMENDED|WAIT|SKIP",
  "score": 0,
  "risk": "LOW|MEDIUM|HIGH",
  "entry": 0,
  "tp": 0,
  "tp2": 0,
  "sl": 0,
  "reason": "Max 100 Zeichen. Setup-Typ + Hauptgrund."
}`;

    const prompt = requireNonEmptyPrompt(rawPrompt, 'analyzeSignalWithAI');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: abortSignal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`❌ Anthropic API error ${response.status}:`, errBody);
      return fallback();
    }

    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) {
      console.error('❌ Anthropic API returned empty content block');
      return fallback();
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('AI analysis error:', error);
  }
  return fallback();
}

/**
 * Pure rule-based scoring of a signal (no env/DB/IO). Computes the weighted
 * rule score and derives recommendation, risk tier and entry/TP/SL levels.
 * Behaviour is locked by the snapshot tests in test/analyzeWithRules.snapshot.test.js.
 * @param {object} signal - Raw signal payload (direction, rsi, ema50/200, trend, …).
 * @param {object|null} [strategyConfig] - Rule weights/thresholds; defaults to DEFAULT_STRATEGY_CONFIG.
 * @param {object} [exitCfg=EXIT_CONFIG] - Exit config (SL %, TP2 R-multiple) per strategy.
 * @returns {object} { recommendation, score, risk, entry, tp, sl, reason, score_breakdown, … }.
 */
function analyzeWithRules(signal, strategyConfig = null, exitCfg = EXIT_CONFIG) {
  const cfg     = strategyConfig || DEFAULT_STRATEGY_CONFIG;
  const dir     = (signal.direction || signal.side || signal.signal || '').toUpperCase();
  const isLong  = dir === 'LONG';
  const isShort = dir === 'SHORT';

  // Detect setup type: Setup A (Pullback) vs Setup B (Continuation-Breakout)
  const setupType = String(signal.setup_type || signal.trigger || '').toUpperCase();
  const isSetupB  = setupType.includes('CONTINUATION') || setupType.includes('BREAKOUT') || setupType.includes('SETUP_B');

  const rW    = cfg.rules?.rsi?.enabled                !== false ? (cfg.rules?.rsi?.weight                ?? 18) : 0;
  const eW    = cfg.rules?.ema?.enabled                !== false ? (cfg.rules?.ema?.weight                ?? 15) : 0;
  const tW    = cfg.rules?.trend?.enabled              !== false ? (cfg.rules?.trend?.weight              ?? 10) : 0;
  const wW    = cfg.rules?.wave_bias?.enabled          !== false ? (cfg.rules?.wave_bias?.weight          ?? 8)  : 0;
  const srW   = cfg.rules?.support_resistance?.enabled !== false ? (cfg.rules?.support_resistance?.weight ?? 10) : 0;
  const sfW   = cfg.rules?.session_filter?.enabled     !== false ? (cfg.rules?.session_filter?.weight     ?? 5)  : 0;
  const tfW   = cfg.rules?.timeframe?.enabled         !== false ? (cfg.rules?.timeframe?.weight          ?? 7)  : 0;
  const cW    = cfg.rules?.confidence?.enabled        !== false ? (cfg.rules?.confidence?.weight         ?? 7)  : 0;

  const matched_rules  = [];
  const failed_rules   = [];
  const unknown_rules  = [];
  const score_breakdown = {};

  // ── RSI (v2.0: Setup A = Pullback, Setup B = Continuation) ────
  // RSI thresholds are configurable via strategy params
  const rsiParams         = cfg.rules?.rsi?.params || {};
  const rsiLower          = rsiParams.lowerBound          ?? 30; // oversold threshold (Setup A LONG)
  const rsiUpper          = rsiParams.upperBound          ?? 70; // overbought threshold (Setup A SHORT)
  const rsiLongMin        = rsiParams.longPreferredAbove  ?? 40; // LONG partial score above this
  const rsiShortMax       = rsiParams.shortPreferredBelow ?? 60; // SHORT partial score below this
  const rsi = signal.rsi != null ? parseFloat(signal.rsi) : null;

  // Start lower when there's no indicator data — prevents empty signals from
  // hitting the Telegram threshold solely via the session-filter bonus.
  const hasIndicatorData = rsi != null
    || (parseFloat(signal.ema50 ?? 0) && parseFloat(signal.ema200 ?? 0))
    || !!(signal.trend || '').trim()
    || !!(signal.wave_bias || '').trim();
  let score = hasIndicatorData ? 50 : 30;
  if (rW > 0) {
    if (rsi == null) {
      unknown_rules.push('RSI (keine Daten)');
      score_breakdown.rsi = 0;
    } else {
      let rsiDelta = 0;
      // Extreme RSI (>75 or <25) always signals reversal risk — not configurable
      if (rsi > 75) {
        if (isLong)  { rsiDelta = -rW; failed_rules.push(`RSI extrem überkauft (${rsi.toFixed(0)}) – Reversal-Risiko, kein LONG`); }
        if (isShort && !isSetupB) { rsiDelta = Math.round(rW * 0.5); matched_rules.push(`RSI extrem überkauft (${rsi.toFixed(0)}) – Setup A SHORT`); }
        if (isShort && isSetupB)  { rsiDelta = -Math.round(rW * 0.5); failed_rules.push(`RSI extrem überkauft (${rsi.toFixed(0)}) – kein Continuation`); }
      } else if (rsi < 25) {
        if (isShort) { rsiDelta = -rW; failed_rules.push(`RSI extrem überverkauft (${rsi.toFixed(0)}) – Reversal-Risiko, kein SHORT`); }
        if (isLong && !isSetupB)  { rsiDelta = Math.round(rW * 0.5); matched_rules.push(`RSI extrem überverkauft (${rsi.toFixed(0)}) – Setup A LONG`); }
        if (isLong && isSetupB)   { rsiDelta = -Math.round(rW * 0.5); failed_rules.push(`RSI extrem überverkauft (${rsi.toFixed(0)}) – kein Continuation`); }
      } else if (isSetupB) {
        // Setup B: RSI in trend range = desired
        const longB_lo = rsiLongMin + 5, longB_hi = rsiUpper - 5;
        const shortB_lo = rsiLower + 5, shortB_hi = rsiShortMax - 5;
        if (isLong) {
          if      (rsi >= longB_lo && rsi <= longB_hi) { rsiDelta = rW;                    matched_rules.push(`RSI ${rsi.toFixed(0)} im Trend-Bereich (${longB_lo}-${longB_hi}) – Setup B LONG`); }
          else if (rsi >= rsiLongMin && rsi < longB_lo){ rsiDelta = Math.round(rW * 0.4);  matched_rules.push(`RSI ${rsi.toFixed(0)} – leicht unter Trend-Bereich`); }
          else if (rsi > longB_hi && rsi <= 75)        { rsiDelta = Math.round(rW * 0.4);  matched_rules.push(`RSI ${rsi.toFixed(0)} – Stärke passt zu Setup B LONG`); }
          else                                         { rsiDelta = -Math.round(rW * 0.3); failed_rules.push(`RSI ${rsi.toFixed(0)} – außerhalb Setup B Bereich`); }
        } else if (isShort) {
          if      (rsi >= shortB_lo && rsi <= shortB_hi){ rsiDelta = rW;                    matched_rules.push(`RSI ${rsi.toFixed(0)} im Trend-Bereich (${shortB_lo}-${shortB_hi}) – Setup B SHORT`); }
          else if (rsi > shortB_hi && rsi <= rsiShortMax){ rsiDelta = Math.round(rW * 0.4); matched_rules.push(`RSI ${rsi.toFixed(0)} – leicht über Trend-Bereich`); }
          else if (rsi >= 25 && rsi < shortB_lo)       { rsiDelta = Math.round(rW * 0.4);  matched_rules.push(`RSI ${rsi.toFixed(0)} – Schwäche passt zu Setup B SHORT`); }
          else                                         { rsiDelta = -Math.round(rW * 0.3); failed_rules.push(`RSI ${rsi.toFixed(0)} – außerhalb Setup B Bereich`); }
        }
      } else {
        // Setup A (Pullback): oversold/overbought logic using configurable thresholds
        if (isLong) {
          if      (rsi < rsiLower)    { rsiDelta = rW;                        matched_rules.push(`RSI überverkauft (${rsi.toFixed(0)}) – Pullback günstig für LONG`); }
          else if (rsi < rsiLongMin)  { rsiDelta = Math.round(rW * 0.56);    matched_rules.push(`RSI niedrig (${rsi.toFixed(0)}) – passt zu Setup A LONG`); }
          else if (rsi < 50)          { rsiDelta = Math.round(rW * 0.22);    matched_rules.push(`RSI neutral-niedrig (${rsi.toFixed(0)})`); }
          else if (rsi > rsiUpper)    { rsiDelta = -rW;                       failed_rules.push(`RSI überkauft (${rsi.toFixed(0)}) – kein Pullback-Entry`); }
          else if (rsi > rsiShortMax) { rsiDelta = -Math.round(rW * 0.33);   failed_rules.push(`RSI hoch (${rsi.toFixed(0)}) – Vorsicht bei LONG`); }
          else                        {                                        matched_rules.push(`RSI neutral (${rsi.toFixed(0)})`); }
        } else if (isShort) {
          if      (rsi > rsiUpper)    { rsiDelta = rW;                        matched_rules.push(`RSI überkauft (${rsi.toFixed(0)}) – Pullback günstig für SHORT`); }
          else if (rsi > rsiShortMax) { rsiDelta = Math.round(rW * 0.56);    matched_rules.push(`RSI hoch (${rsi.toFixed(0)}) – passt zu Setup A SHORT`); }
          else if (rsi > 50)          { rsiDelta = Math.round(rW * 0.22);    matched_rules.push(`RSI neutral-hoch (${rsi.toFixed(0)})`); }
          else if (rsi < rsiLower)    { rsiDelta = -rW;                       failed_rules.push(`RSI überverkauft (${rsi.toFixed(0)}) – kein Pullback-Entry`); }
          else if (rsi < rsiLongMin)  { rsiDelta = -Math.round(rW * 0.33);   failed_rules.push(`RSI niedrig (${rsi.toFixed(0)}) – Vorsicht bei SHORT`); }
          else                        {                                        matched_rules.push(`RSI neutral (${rsi.toFixed(0)})`); }
        }
      }
      score += rsiDelta;
      score_breakdown.rsi = rsiDelta;
    }
  }

  // ── EMA v2.0: alignment + EMA200 distance (≥1% required) ─────
  // Bias gilt nur wenn: EMA50/200 Alignment UND Preis klar über/unter EMA200 (>1%)
  // Preis direkt am EMA200 (<0.5%) → Ausschlusskriterium
  const ema50  = parseFloat(signal.ema50  ?? 0);
  const ema200 = parseFloat(signal.ema200 ?? 0);
  const priceForEma = parseFloat(signal.price ?? 0);
  if (eW > 0) {
    if (!ema50 || !ema200) {
      unknown_rules.push('EMA 50/200 (keine Daten)');
      score_breakdown.ema = 0;
    } else {
      const bullish       = ema50 > ema200;
      const ema200Dist    = priceForEma && ema200 ? Math.abs(priceForEma - ema200) / ema200 : 0;
      const aboveEma200   = priceForEma > ema200;
      let emaDelta = 0;

      // EMA200 distance check (v2.0: min 1% Abstand, <0.5% = Ausschluss)
      if (priceForEma && ema200Dist < 0.005) {
        // Price within 0.5% of EMA200 → exclusion criterion
        emaDelta = -Math.round(eW * 0.8);
        failed_rules.push(`Preis zu nah an EMA 200 (${(ema200Dist*100).toFixed(2)}%) – Ausschluss v2.0`);
      } else {
        // EMA50/200 alignment
        if (isLong  && bullish)  {
          const distBonus = ema200Dist > 0.03 ? eW : ema200Dist > 0.01 ? Math.round(eW * 0.7) : Math.round(eW * 0.4);
          emaDelta = distBonus;
          matched_rules.push(`EMA bullish (EMA50>EMA200, Dist ${(ema200Dist*100).toFixed(1)}%) – LONG`);
        } else if (isShort && !bullish) {
          const distBonus = ema200Dist > 0.03 ? eW : ema200Dist > 0.01 ? Math.round(eW * 0.7) : Math.round(eW * 0.4);
          emaDelta = distBonus;
          matched_rules.push(`EMA bearish (EMA50<EMA200, Dist ${(ema200Dist*100).toFixed(1)}%) – SHORT`);
        } else if (isLong  && !bullish) {
          emaDelta = -eW;
          failed_rules.push('EMA bearish – Trend gegen LONG, kein Bias');
        } else if (isShort && bullish)  {
          emaDelta = -eW;
          failed_rules.push('EMA bullish – Trend gegen SHORT, kein Bias');
        }
        // Additional EMA200 position check
        if (isLong && !aboveEma200 && priceForEma) {
          emaDelta -= Math.round(eW * 0.4);
          failed_rules.push('Preis unter EMA 200 – kein Long-Bias nach v2.0');
        } else if (isShort && aboveEma200 && priceForEma) {
          emaDelta -= Math.round(eW * 0.4);
          failed_rules.push('Preis über EMA 200 – kein Short-Bias nach v2.0');
        }
      }
      score += emaDelta;
      score_breakdown.ema = emaDelta;
    }
  }

  // ── Trend label ──────────────────────────────────────────────
  const trend = (signal.trend || '').toUpperCase();
  if (tW > 0) {
    if (!trend) {
      unknown_rules.push('Trend-Label (keine Daten)');
      score_breakdown.trend = 0;
    } else {
      let tDelta = 0;
      if (trend === 'BULLISH' || trend === 'UP') {
        tDelta = isLong ? tW : -tW;
        if (isLong)  matched_rules.push('Trend BULLISH – passt zu LONG');
        else         failed_rules.push('Trend BULLISH – gegen SHORT');
      } else if (trend === 'BEARISH' || trend === 'DOWN') {
        tDelta = isShort ? tW : -tW;
        if (isShort) matched_rules.push('Trend BEARISH – passt zu SHORT');
        else         failed_rules.push('Trend BEARISH – gegen LONG');
      } else {
        unknown_rules.push(`Trend unklar (${trend})`);
      }
      score += tDelta;
      score_breakdown.trend = tDelta;
    }
  }

  // ── Wave bias ────────────────────────────────────────────────
  const waveBias = (signal.wave_bias || '').toUpperCase();
  if (wW > 0) {
    if (!waveBias) {
      unknown_rules.push('Wave Bias (keine Daten)');
      score_breakdown.wave_bias = 0;
    } else {
      let wDelta = 0;
      if (waveBias === 'LONG') {
        wDelta = isLong ? wW : -Math.round(wW * 0.5);
        if (isLong)  matched_rules.push('Wave Bias LONG – passt zu LONG');
        else         failed_rules.push('Wave Bias LONG – gegen SHORT');
      } else if (waveBias === 'SHORT') {
        wDelta = isShort ? wW : -Math.round(wW * 0.5);
        if (isShort) matched_rules.push('Wave Bias SHORT – passt zu SHORT');
        else         failed_rules.push('Wave Bias SHORT – gegen LONG');
      }
      score += wDelta;
      score_breakdown.wave_bias = wDelta;
    }
  }

  // ── Timeframe (v2.0: 5min/15min = Entry-TF, volle Wertung) ───
  if (tfW > 0) {
    const tf = String(signal.timeframe || '').replace('m','').replace('h','H');
    let tfDelta = 0;
    if      (['5','15'].includes(tf))             { tfDelta = tfW;                    matched_rules.push(`Timeframe ${tf}min – Entry-Timeframe v2.0`); }
    else if (['1','3'].includes(tf))              { tfDelta = Math.round(tfW * 0.6);  matched_rules.push(`Timeframe ${tf}min – kurz, aber gültig`); }
    else if (['30','60','1H'].includes(tf))       { tfDelta = Math.round(tfW * 0.3);  matched_rules.push(`Timeframe ${tf} – höherer TF, Entry bevorzugt auf 5/15min`); }
    else if (['240','4H'].includes(tf))           { tfDelta = Math.round(tfW * 0.2);  matched_rules.push(`Timeframe ${tf} – Bias-TF, kein Entry-TF`); }
    else if (tf)                                  {                                    failed_rules.push(`Timeframe ${tf} – unbekannt`); }
    else                                          { unknown_rules.push('Timeframe (keine Daten)'); }
    score += tfDelta;
    score_breakdown.timeframe = tfDelta;
  }

  // ── Confidence ───────────────────────────────────────────────
  if (cW > 0) {
    const confidence = parseFloat(signal.confidence ?? -1);
    if (confidence < 0) {
      unknown_rules.push('Konfidenz (keine Daten)');
      score_breakdown.confidence = 0;
    } else {
      let cDelta = 0;
      if      (confidence >= 80) { cDelta = cW;                    matched_rules.push(`Konfidenz ${confidence}% – hoch`); }
      else if (confidence >= 60) { cDelta = Math.round(cW * 0.5); matched_rules.push(`Konfidenz ${confidence}% – mittel`); }
      else                       {                                  failed_rules.push(`Konfidenz ${confidence}% – niedrig`); }
      score += cDelta;
      score_breakdown.confidence = cDelta;
    }
  }

  // ── Support / Resistance proximity ───────────────────────────
  const price      = parseFloat(signal.price ?? 0);
  const support    = parseFloat(signal.support ?? 0);
  const resistance = parseFloat(signal.resistance ?? 0);
  if (srW > 0) {
    let srDelta = 0;
    if (!price) {
      unknown_rules.push('Support/Resistance (kein Preis)');
      score_breakdown.support_resistance = 0;
    } else if (!support && !resistance) {
      unknown_rules.push('Support/Resistance (keine Zonen)');
      score_breakdown.support_resistance = 0;
    } else {
      if (price && support && isLong && price > support) {
        if ((price - support) / price < 0.02) { srDelta = srW; matched_rules.push('Preis nah an Support – günstig für LONG'); }
        else { failed_rules.push('Preis zu weit von Support entfernt'); }
      } else if (price && resistance && isShort && price < resistance) {
        if ((resistance - price) / price < 0.02) { srDelta = srW; matched_rules.push('Preis nah an Resistance – günstig für SHORT'); }
        else { failed_rules.push('Preis zu weit von Resistance entfernt'); }
      } else {
        failed_rules.push('Preis nicht in Key-Zone');
      }
      score += srDelta;
      score_breakdown.support_resistance = srDelta;
    }
  }

  // ── Session filter (v2.0: London 07-10 UTC, US-Open 13:30-16 UTC) ──
  if (sfW > 0) {
    const utcHour = new Date().getUTCHours();
    const utcMin  = new Date().getUTCMinutes();
    const utcTime = utcHour * 60 + utcMin;
    const inLondon  = utcTime >= 7*60     && utcTime <= 10*60;
    const inUSOpen  = utcTime >= 13*60+30 && utcTime <= 16*60;
    if (inLondon) {
      score += sfW;
      score_breakdown.session_filter = sfW;
      matched_rules.push('London-Open Session (07-10 UTC) – bevorzugte Zeit');
    } else if (inUSOpen) {
      score += sfW;
      score_breakdown.session_filter = sfW;
      matched_rules.push('US-Open Session (13:30-16 UTC) – bevorzugte Zeit');
    } else {
      score_breakdown.session_filter = 0;
      unknown_rules.push('Außerhalb bevorzugter Sessions (London/US-Open)');
    }
  }

  // ── Clamp ────────────────────────────────────────────────────
  score = Math.max(0, Math.min(100, Math.round(score)));

  // ── Recommendation ───────────────────────────────────────────
  const minTrade    = cfg.thresholds?.min_trade_score    ?? 75;
  const minTelegram = cfg.thresholds?.min_telegram_score ?? 75;

  let recommendation, risk;
  if (score >= minTrade) {
    recommendation = dir || 'RECOMMENDED';
    risk = score >= minTrade + 12 ? 'LOW' : 'MEDIUM';
  } else if (score >= minTelegram) {
    recommendation = 'WAIT';
    risk = 'MEDIUM';
  } else {
    recommendation = 'SKIP';
    risk = 'HIGH';
  }

  // ── TP / SL (gemeinsame Exit-Logik; SL-% und TP2-R pro Strategie via exitCfg) ──
  // tp = finales TP2 (= TP2_R_MULTIPLE × R). tp1 wird im Exit aus entry/tp abgeleitet.
  const entry   = price || 0;
  const slDist  = entry * ((exitCfg?.SL_DISTANCE_PCT ?? 1.0) / 100); // 1R-Distanz
  const tpR     = exitCfg?.TP2_R_MULTIPLE ?? 1.5;
  const tp      = isLong  ? entry + slDist * tpR : entry - slDist * tpR;
  const sl      = isLong  ? entry - slDist       : entry + slDist;
  const tp2     = isLong  ? entry + slDist * 3   : entry - slDist * 3; // vestigiales 3R-Feld (Telemetrie)

  // ── Reason ───────────────────────────────────────────────────
  const reasons = [];
  const setupLabel = isSetupB ? 'Setup B (Continuation)' : 'Setup A (Pullback)';
  reasons.push(setupLabel);
  if (rsi != null && (rsi < 35 || rsi > 65)) reasons.push(`RSI ${rsi.toFixed(0)}`);
  if (ema50 && ema200) reasons.push(`EMA ${ema50 > ema200 ? 'bullish' : 'bearish'}`);
  if (trend)    reasons.push(`Trend: ${trend}`);
  if (waveBias) reasons.push(`Bias: ${waveBias}`);
  const reason = reasons.join(' · ');

  // ── R:R & quality ────────────────────────────────────────────
  const risk_reward        = calcRR(entry, tp, sl, isLong);
  const planned_profit_pct = safePct(tp, entry);
  const planned_risk_pct   = safePct(sl, entry);
  const signal_quality     = getSignalQuality(score);

  return {
    recommendation, score, risk, entry, tp, sl, tp2, reason, direction: dir,
    matched_rules, failed_rules, unknown_rules, score_breakdown,
    risk_reward, planned_profit_pct, planned_risk_pct, signal_quality,
    setup_type: isSetupB ? 'SETUP_B' : 'SETUP_A',
  };
}

// ═══════════════════════════════════════════════════════════════
// DB INITIALIZATION
// ═══════════════════════════════════════════════════════════════

// Module-level flag: run the full CREATE/ALTER sequence only once per Worker
// instance to avoid hammering D1 with ~70 statements on every request.
let _tablesReady = false;

async function ensureTables(env) {
  if (_tablesReady) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        symbol TEXT,
        timeframe TEXT,
        price REAL,
        direction TEXT,
        trigger TEXT,
        ai_recommendation TEXT,
        ai_score INTEGER,
        ai_risk TEXT,
        ai_entry REAL,
        ai_tp REAL,
        ai_sl REAL,
        ai_reason TEXT,
        rule_score INTEGER,
        rule_reason TEXT,
        exit_price REAL,
        outcome TEXT DEFAULT 'OPEN',
        created_at INTEGER,
        updated_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        timeframe TEXT,
        price REAL,
        rsi REAL,
        ema50 REAL,
        ema200 REAL,
        support REAL,
        resistance REAL,
        trend TEXT,
        trend_1h TEXT,
        trend_4h TEXT,
        created_at TEXT
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS practice_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT,
        symbol TEXT,
        timeframe TEXT,
        direction TEXT,
        entry_price REAL,
        take_profit REAL,
        stop_loss REAL,
        status TEXT DEFAULT 'OPEN',
        exit_price REAL,
        result_pct REAL,
        created_at TEXT,
        closed_at TEXT
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS checklists (
        id TEXT PRIMARY KEY,
        date TEXT,
        user TEXT,
        type TEXT,
        data TEXT,
        created_at INTEGER,
        updated_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        email TEXT,
        password_hash TEXT,
        role TEXT DEFAULT 'user',
        must_change_password INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT DEFAULT 'v1.0',
        active INTEGER DEFAULT 0,
        is_default INTEGER DEFAULT 0,
        protected INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        config_json TEXT
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS signal_loss_reasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT NOT NULL,
        strategy_id TEXT,
        reason TEXT NOT NULL,
        note TEXT,
        created_at INTEGER,
        created_by TEXT
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS live_trades (
        id TEXT PRIMARY KEY,
        signal_id TEXT,
        exchange TEXT,
        order_id TEXT,
        symbol TEXT,
        direction TEXT,
        entry_price REAL,
        tp_price REAL,
        sl_price REAL,
        quantity REAL,
        trade_amount_usdt REAL,
        leverage INTEGER DEFAULT 1,
        status TEXT DEFAULT 'OPEN',
        exit_price REAL,
        pnl_usdt REAL,
        pnl_pct REAL,
        is_testnet INTEGER DEFAULT 0,
        error_message TEXT,
        opened_at INTEGER,
        closed_at INTEGER,
        created_at INTEGER,
        updated_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS market_events (
        id TEXT PRIMARY KEY,
        created_at INTEGER,
        updated_at INTEGER,
        event_time INTEGER,
        title TEXT,
        category TEXT,
        impact TEXT,
        affected_markets TEXT,
        source TEXT,
        source_url TEXT,
        summary TEXT,
        radar_status TEXT,
        raw_json TEXT,
        long_text TEXT,
        affected_symbols TEXT,
        affected_scope TEXT,
        status TEXT DEFAULT 'ACTIVE'
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS morning_routines (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT 'BTCUSDT',
        bias TEXT,
        chart_opened INTEGER DEFAULT 0,
        ema200_checked INTEGER DEFAULT 0,
        ema_direction TEXT,
        key_zones_marked INTEGER DEFAULT 0,
        zone_notes TEXT,
        bias_reason TEXT,
        completed_at INTEGER,
        created_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS pre_trade_checklists (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        signal_id TEXT,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT 'BTCUSDT',
        bias_match INTEGER DEFAULT 0,
        in_key_zone INTEGER DEFAULT 0,
        structure_confirmed INTEGER DEFAULT 0,
        no_chop INTEGER DEFAULT 0,
        trend_candle INTEGER DEFAULT 0,
        break_confirmed INTEGER DEFAULT 0,
        rsi_ok INTEGER DEFAULT 0,
        rsi_not_extreme INTEGER DEFAULT 0,
        sl_logical INTEGER DEFAULT 0,
        rr_ok INTEGER DEFAULT 0,
        can_explain INTEGER DEFAULT 0,
        clear_minded INTEGER DEFAULT 0,
        no_fomo INTEGER DEFAULT 0,
        notes TEXT,
        created_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS trade_reviews (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        signal_id TEXT,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT 'BTCUSDT',
        instrument TEXT,
        direction TEXT,
        entry REAL,
        stop_loss REAL,
        take_profit REAL,
        exit_price REAL,
        outcome TEXT,
        realized_rr REAL,
        bias_clear INTEGER DEFAULT 0,
        bias_direction TEXT,
        in_key_zone INTEGER DEFAULT 0,
        structure_hl_lh INTEGER DEFAULT 0,
        trend_candle_clean INTEGER DEFAULT 0,
        break_confirmed INTEGER DEFAULT 0,
        rsi_ok INTEGER DEFAULT 0,
        sl_logical INTEGER DEFAULT 0,
        rr_acceptable INTEGER DEFAULT 0,
        what_went_well TEXT,
        what_went_wrong TEXT,
        discipline TEXT,
        mood_before TEXT,
        no_fomo INTEGER DEFAULT 0,
        sl_not_moved INTEGER DEFAULT 0,
        tp_not_closed_early INTEGER DEFAULT 0,
        no_revenge INTEGER DEFAULT 0,
        lesson TEXT,
        would_take_again INTEGER DEFAULT 0,
        followed_plan INTEGER DEFAULT 0,
        waited_confirmation INTEGER DEFAULT 0,
        felt_confident INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      )
    `).run();

    // Migrate journal tables — add symbol column (safe, duplicate-protected)
    for (const tbl of ['morning_routines', 'pre_trade_checklists', 'trade_reviews']) {
      try { await env.DB.prepare(`ALTER TABLE ${tbl} ADD COLUMN symbol TEXT NOT NULL DEFAULT 'BTCUSDT'`).run(); } catch (_) {}
    }

    // Migrate signals table
    const stratCols = [
      ['strategy_id',           'TEXT'],
      ['strategy_name',         'TEXT'],
      ['strategy_version',      'TEXT'],
      ['is_test',               'INTEGER DEFAULT 0'],
      ['telegram_sent',         'INTEGER DEFAULT 0'],
      ['telegram_reason',       'TEXT'],
      ['source',                'TEXT'],
      ['pnl_pct',               'REAL'],
      ['closed_at',             'INTEGER'],
      ['outcome_source',        'TEXT'],
      ['telegram_outcome_sent', 'INTEGER DEFAULT 0'],
      ['admin_note',            'TEXT'],
      ['manual_reason',         'TEXT'],
      ['updated_at',            'INTEGER'],
      ['exit_price',            'REAL'],
    ];
    for (const [col, type] of stratCols) {
      try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    // Migrate signals table — technical indicator + scoring columns
    const signalIndicatorCols = [
      ['action',               'TEXT'],
      ['rsi',                  'REAL'],
      ['ema50',                'REAL'],
      ['ema200',               'REAL'],
      ['trend',                'TEXT'],
      ['support',              'REAL'],
      ['resistance',           'REAL'],
      ['wave_bias',            'TEXT'],
      ['ai_direction',         'TEXT'],
      ['ai_confidence',        'REAL'],
      ['matched_rules',        'TEXT'],
      ['failed_rules',         'TEXT'],
      ['unknown_rules',        'TEXT'],
      ['score_breakdown',      'TEXT'],
      ['signal_quality',       'TEXT'],
      ['risk_reward',          'REAL'],
      ['planned_profit_pct',   'REAL'],
      ['planned_risk_pct',     'REAL'],
      ['trigger_reason',       'TEXT'],
      ['disclaimer_shown',     'INTEGER DEFAULT 0'],
      ['daily_bias',           'TEXT'],
      ['bias_match',           'TEXT'],
      ['before_morning_routine','INTEGER DEFAULT 0'],
      ['counts_for_strategy',  'INTEGER DEFAULT 0'],
      ['poc',                  'REAL'],
      ['vah',                  'REAL'],
      ['val',                  'REAL'],
      ['vp_zone',              'TEXT'],
      ['vp_score',             'INTEGER DEFAULT 0'],
      ['dashboard_seen',    'INTEGER DEFAULT 0'],
      ['signal_class',         'TEXT'],
      // TP1 / Breakeven / TP2 partial-exit state (ersetzt die 3h-Regel):
      ['ai_tp1',               'REAL'],               // TP1-Trigger (Teilschließung)
      ['tp1_hit',              'INTEGER DEFAULT 0'],  // wurde TP1 erreicht? (0/1)
      ['sl_current',           'REAL'],               // aktiver SL (nach TP1 = Breakeven)
      // Multi-Strategie + Asset-Class (AUFGABE 1+2):
      ['asset_class',          'TEXT'],               // 'crypto' | 'forex'
      ['strategy_key',         'TEXT'],               // Routing-Strategie (z.B. crypto_sr_volume)
      ['exit_reason',          'TEXT'],               // TP2 | SL_before_TP1 | SL_after_TP1 | MANUAL | ADMIN
    ];
    for (const [col, type] of signalIndicatorCols) {
      try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    // Migrate practice_trades table — TP1/Breakeven/TP2 partial-exit columns.
    // Diese Tabelle hatte bisher KEINE ALTER-Migrationen (nur CREATE IF NOT
    // EXISTS); ohne diesen Block bekämen bestehende DBs die Spalten nicht.
    // Bestehende OPEN-Trades erhalten hier NULL/0 und werden mit on-the-fly
    // abgeleitetem TP1 evaluiert — laufen also weiter und gewinnen den
    // Breakeven-Schutz, ohne dass etwas manuell migriert werden muss.
    const practiceTradeCols = [
      ['tp1_price',    'REAL'],               // TP1-Trigger
      ['tp1_hit',      'INTEGER DEFAULT 0'],  // wurde TP1 erreicht? (0/1)
      ['sl_price',     'REAL'],               // aktiver SL (nach TP1 = Breakeven)
      ['realized_pct', 'REAL'],               // bei TP1 gesicherter Teilgewinn (Telemetrie)
    ];
    for (const [col, type] of practiceTradeCols) {
      try { await env.DB.prepare(`ALTER TABLE practice_trades ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    // Migrate users table
    const userCols = [
      ['skip_password_change', 'INTEGER DEFAULT 0'],
      ['blocked',              'INTEGER DEFAULT 0'],
      ['last_seen',            'INTEGER'],
      ['login_failures',       'INTEGER DEFAULT 0'],
      ['locked_until',         'INTEGER DEFAULT 0'],
    ];
    for (const [col, type] of userCols) {
      try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    // Migrate snapshots table (compat with unique symbol snapshots)
    const snapshotCols = [
      ['timeframe',  'TEXT'],
      ['price',      'REAL'],
      ['rsi',        'REAL'],
      ['ema50',      'REAL'],
      ['ema200',     'REAL'],
      ['support',    'REAL'],
      ['resistance', 'REAL'],
      ['trend',      'TEXT'],
      ['trend_1h',   'TEXT'],
      ['trend_4h',   'TEXT'],
      ['direction',  'TEXT'],
      ['trigger',    'TEXT'],
      ['strength',   'TEXT'],
      ['timestamp',  'TEXT'],
      ['raw_signal', 'TEXT'],
      ['created_at', 'TEXT'],
      ['updated_at', 'TEXT'],
    ];
    for (const [col, type] of snapshotCols) {
      try { await env.DB.prepare(`ALTER TABLE snapshots ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    // AUFGABE 4: Audit-Log für Startkapital-Resets (wer/wann/alt/neu).
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS capital_reset_log (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        username TEXT,
        old_value REAL,
        new_value REAL,
        created_at INTEGER NOT NULL
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS alert_dedup (
        dedup_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS webhook_log (
        id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        event_type TEXT,
        symbol TEXT,
        raw_payload TEXT,
        status TEXT NOT NULL,
        error_msg TEXT,
        response_ms INTEGER
      )
    `).run();

    // signal_candidates: alle eingehenden Kandidaten (inkl. abgelehnter)
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS signal_candidates (
        id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        strategy_key TEXT NOT NULL,
        strategy_id TEXT,
        symbol TEXT,
        timeframe TEXT,
        direction TEXT,
        price REAL,
        rsi REAL,
        ema_dist_pct REAL,
        near_sup INTEGER,
        near_res INTEGER,
        rsi_dead_zone INTEGER,
        reclaim INTEGER,
        breakdown INTEGER,
        rsi_was_oversold INTEGER,
        rsi_was_overbought INTEGER,
        rsi_rising INTEGER,
        rsi_falling INTEGER,
        trend_ok INTEGER,
        poc REAL,
        breakout_above_range INTEGER,
        breakout_below_range INTEGER,
        vol_ratio REAL,
        reclaim_val INTEGER,
        breakdown_vah INTEGER,
        dist_to_val REAL,
        dist_to_vah REAL,
        candidate_score INTEGER,
        score_threshold INTEGER,
        score_details TEXT,
        passed_threshold INTEGER NOT NULL DEFAULT 0,
        signal_id TEXT,
        raw_payload TEXT
      )
    `).run();

    _tablesReady = true;
  } catch (error) {
    console.error('❌ ensureTables error:', error.message);
  }
}

// ─── Webhook-Log ─────────────────────────────────────────────
async function logWebhookRequest(env, { receivedAt, eventType, symbol, rawPayload, status, errorMsg, responseMs }) {
  try {
    const id = `whl_${receivedAt}_${Math.random().toString(36).slice(2, 8)}`;
    await env.DB.prepare(`
      INSERT INTO webhook_log (id, received_at, event_type, symbol, raw_payload, status, error_msg, response_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, receivedAt,
      eventType || null,
      symbol || null,
      rawPayload ? rawPayload.substring(0, 2000) : null,
      status,
      errorMsg || null,
      responseMs || null
    ).run();
    // Keep last 500 entries — delete oldest beyond that
    await env.DB.prepare(`
      DELETE FROM webhook_log WHERE id NOT IN (
        SELECT id FROM webhook_log ORDER BY received_at DESC LIMIT 500
      )
    `).run();
  } catch (e) {
    console.error('webhook_log write failed:', e.message);
  }
}

// ─── Strategy helpers ────────────────────────────────────────

async function getActiveStrategy(env) {
  try {
    const strategy = await env.DB.prepare(
      `SELECT * FROM strategies WHERE active = 1 ORDER BY updated_at DESC LIMIT 1`
    ).first();
    if (!strategy) return null;
    return { ...strategy, config: strategy.config_json ? JSON.parse(strategy.config_json) : DEFAULT_STRATEGY_CONFIG };
  } catch (_) { return null; }
}

async function initDefaultStrategy(env) {
  try {
    const id = 'strategy_default';
    const existing = await env.DB.prepare(`SELECT id FROM strategies WHERE id = ?`).bind(id).first();
    if (existing) {
      await env.DB.prepare(`UPDATE strategies SET active = 1 WHERE id = ?`).bind(id).run();
      return { id, name: 'WAVESCOUT Standard', version: 'v1.0', config: DEFAULT_STRATEGY_CONFIG };
    }
    await env.DB.prepare(`
      INSERT INTO strategies (id, name, version, active, is_default, protected, created_at, updated_at, config_json)
      VALUES (?, 'WAVESCOUT Standard', 'v1.0', 1, 1, 1, ?, ?, ?)
    `).bind(id, Date.now(), Date.now(), JSON.stringify(DEFAULT_STRATEGY_CONFIG)).run();
    return { id, name: 'WAVESCOUT Standard', version: 'v1.0', config: DEFAULT_STRATEGY_CONFIG };
  } catch (e) {
    console.error('initDefaultStrategy error:', e.message);
    return null;
  }
}

// ─── Settings helpers ─────────────────────────────────────────

async function getSetting(env, key, defaultValue = null) {
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first();
    return row ? row.value : defaultValue;
  } catch (_) { return defaultValue; }
}

async function setSetting(env, key, value) {
  try {
    await env.DB.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(key, String(value), Date.now()).run();
  } catch (_) {}
}

// ─── AUFGABE 4: Einstiegskapital (Startkapital) ──────────────────────
// Startkapital wird in der settings-Tabelle gehalten (Key 'starting_capital'),
// Fallback = env.STARTING_CAPITAL, dann 10000. So ist es zur Laufzeit änderbar
// (Cloudflare-Env-Vars sind im Worker read-only). Reset ist admin-only + geloggt.
async function getStartingCapital(env) {
  try {
    const fromDb = await getSetting(env, 'starting_capital', null);
    const val = parseFloat(fromDb ?? env.STARTING_CAPITAL ?? '10000');
    return Number.isFinite(val) && val >= 0 ? val : 10000;
  } catch (_) {
    return parseFloat(env.STARTING_CAPITAL || '10000') || 10000;
  }
}

// Reine, testbare Reset-Logik mit Rollen-Guard. `session` = validierte Session
// ({ role, username, user_id }). Nicht-Admins werden VOR jeglichem DB-Zugriff
// abgelehnt. Liefert { ok, status, error?, oldValue?, newValue? }.
async function resetStartingCapital({ env, session, newValue }) {
  if (!session)                 return { ok: false, status: 401, error: 'Unauthorized' };
  if (session.role !== 'admin') return { ok: false, status: 403, error: 'Forbidden — admin role required' };

  const value = parseFloat(newValue);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, status: 400, error: 'newValue muss eine Zahl ≥ 0 sein' };
  }

  const oldValue = await getStartingCapital(env);
  await setSetting(env, 'starting_capital', String(value));

  // Audit-Log: wer / wann / alter Wert / neuer Wert.
  try {
    await env.DB.prepare(`
      INSERT INTO capital_reset_log (id, user_id, username, old_value, new_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      `capreset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      session.user_id || session.id || null,
      session.username || null,
      oldValue,
      value,
      Date.now()
    ).run();
  } catch (e) {
    console.error('❌ capital_reset_log insert failed:', e.message);
  }

  console.log(`💰 Startkapital zurückgesetzt: ${oldValue} → ${value} (by ${session.username || 'admin'})`);
  return { ok: true, status: 200, oldValue, newValue: value };
}

// ─── AUFGABE 1: Strategie-Status (aktiv/pausiert) ────────────────────
// Pausierte Strategien (Liste von strategy_keys) liegen in settings
// ('strategy_paused' → JSON-Array). Pausiert = es werden KEINE neuen Trades
// mehr eröffnet; bestehende offene Trades bleiben unberührt. Kein Schema-
// Migration nötig (settings-Tabelle existiert bereits).
async function getPausedStrategies(env) {
  try {
    const arr = JSON.parse(await getSetting(env, 'strategy_paused', '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

async function isStrategyPaused(env, key) {
  return (await getPausedStrategies(env)).includes(key);
}

// Status-Map { key: 'active' | 'paused' } über alle registrierten Strategien.
async function getStrategyStatuses(env) {
  const paused = await getPausedStrategies(env);
  const out = {};
  for (const key of Object.keys(STRATEGIES)) out[key] = paused.includes(key) ? 'paused' : 'active';
  return out;
}

// Reine, testbare Toggle-Logik mit Rollen-Guard (analog resetStartingCapital).
// Nicht-Admins werden VOR jeglichem DB-Zugriff abgelehnt.
async function setStrategyStatus({ env, session, strategy, paused }) {
  if (!session)                 return { ok: false, status: 401, error: 'Unauthorized' };
  if (session.role !== 'admin') return { ok: false, status: 403, error: 'Forbidden — admin role required' };
  if (!STRATEGIES[strategy])    return { ok: false, status: 400, error: `Unbekannte Strategie: ${strategy}` };

  const cur = new Set(await getPausedStrategies(env));
  if (paused) cur.add(strategy); else cur.delete(strategy);
  await setSetting(env, 'strategy_paused', JSON.stringify([...cur]));

  console.log(`🔀 Strategie ${strategy} → ${paused ? 'PAUSIERT' : 'AKTIV'} (by ${session.username || 'admin'})`);
  return { ok: true, status: 200, strategy, paused: !!paused, status_label: paused ? 'paused' : 'active' };
}

// ─── Live price (Binance public API, snapshot fallback) ───────

async function getLivePrice(env, symbol) {
  // 1. Try Binance
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (res.ok) {
      const data = await res.json();
      if (data?.price) return parseFloat(data.price);
    }
  } catch (_) {}

  // 2. Fallback: Bybit (covers NAS100USDT, XAUTUSDT, RIVERUSDT etc. not listed on Binance)
  try {
    const res = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
    if (res.ok) {
      const data = await res.json();
      const price = data?.result?.list?.[0]?.lastPrice;
      if (price) return parseFloat(price);
    }
  } catch (_) {}

  // 3. Last resort: latest snapshot price
  const snap = await getSnapshot(env, symbol, '5m');
  return snap?.price || null;
}

// ─── Duration formatter ───────────────────────────────────────

function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ═══════════════════════════════════════════════════════════════
// SNAPSHOT HANDLING
// ═══════════════════════════════════════════════════════════════

async function saveSnapshot(env, data) {
  console.log('📸 Saving snapshot:', data.symbol, data.timeframe, 'price:', data.price);

  await ensureTables(env);
  const nowIso = new Date().toISOString();
  const symbol = data.symbol || 'UNKNOWN';
  const tf     = String(data.timeframe || '5');
  const rawSignal = JSON.stringify(data);

  // Use UPDATE first, INSERT only if no existing row for this symbol+timeframe.
  // D1 has no UNIQUE constraint on snapshots(symbol) so ON CONFLICT would fail.
  const existing = await env.DB.prepare(
    `SELECT id FROM snapshots WHERE symbol = ? AND timeframe = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(symbol, tf).first();

  if (existing) {
    await env.DB.prepare(`
      UPDATE snapshots SET
        price = ?, rsi = ?, ema50 = ?, ema200 = ?,
        support = ?, resistance = ?, trend = ?, trend_1h = ?, trend_4h = ?,
        direction = ?, trigger = ?, strength = ?, timestamp = ?,
        raw_signal = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      data.price || 0, data.rsi ?? null, data.ema50 ?? null, data.ema200 ?? null,
      data.support ?? null, data.resistance ?? null, data.trend || null,
      data.trend_1h || null, data.trend_4h || null,
      data.direction || null, data.trigger || null, data.strength || null,
      data.timestamp || nowIso, rawSignal, nowIso,
      existing.id
    ).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO snapshots (
        symbol, timeframe, price, rsi, ema50, ema200,
        support, resistance, trend, trend_1h, trend_4h,
        direction, trigger, strength, timestamp, raw_signal, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      symbol, tf,
      data.price || 0, data.rsi ?? null, data.ema50 ?? null, data.ema200 ?? null,
      data.support ?? null, data.resistance ?? null, data.trend || null,
      data.trend_1h || null, data.trend_4h || null,
      data.direction || null, data.trigger || null, data.strength || null,
      data.timestamp || nowIso, rawSignal, nowIso, nowIso
    ).run();
  }

  if (data.price && data.symbol) {
    await checkOpenSignalsForSymbol(env, data.symbol, data.price);
  }

  console.log('✅ Snapshot saved:', symbol);
  return { ok: true, type: 'SNAPSHOT', message: 'Snapshot saved', symbol };
}

// ═══════════════════════════════════════════════════════════════
// PRACTICE TRADES (ARCHIV — read-only)
// ═══════════════════════════════════════════════════════════════
// AUFGABE 3: Es werden KEINE neuen practice_trades mehr erzeugt (kein separater
// Demo-Pfad). Die Tabelle bleibt als read-only Archiv für die Historie erhalten
// und wird nur noch über getPracticeTrades / getPracticeTradeStats gelesen.
// createPracticeTrade und der per-Tick-Evaluator checkPracticeTrades wurden
// entfernt — einziger Live-Pfad ist jetzt `signals`
// (applySignalExit / checkOpenSignalsForSymbol).

// ═══════════════════════════════════════════════════════════════
// TRADE CLOSE — single writer for trade outcomes
// ═══════════════════════════════════════════════════════════════
// signals and practice_trades are two outcome tables for the same logical
// trade (practice_trades.signal_id -> signals.id). Each used to be closed
// independently by whichever resolver (price-tick check, cron, TP/SL eval)
// got there first, so the two tables could disagree on WIN/LOSS for the
// same trade. closeTrade() is the only place that writes a close to either
// table for the automated resolvers below — it closes whichever row
// triggered it AND, if still OPEN, the linked counterpart, in one atomic
// D1 batch, so they can never drift apart again.
// Manual admin/trader PATCH endpoints intentionally bypass this (they
// support OPEN/IGNORED re-opens and explicit overrides that aren't "close"
// semantics), so they keep their own direct UPDATEs.
async function closeTrade(env, {
  signalId = null,
  practiceTradeId = null,
  outcome,
  exitPrice,
  pnlPct,
  outcomeSource = 'auto',
  telegramOutcomeSent = null, // null = leave column untouched
  exitReason = null,          // 'TP2' | 'SL_before_TP1' | 'SL_after_TP1' | 'MANUAL' | 'ADMIN'
} = {}) {
  if (!signalId && !practiceTradeId) return { closedSignal: false, closedPracticeTrade: false };

  let resolvedSignalId = signalId;
  let resolvedPracticeTradeId = practiceTradeId;

  if (!resolvedSignalId && practiceTradeId) {
    const pt = await env.DB.prepare(`SELECT signal_id FROM practice_trades WHERE id = ?`).bind(practiceTradeId).first();
    if (pt?.signal_id) resolvedSignalId = pt.signal_id;
  }
  if (!resolvedPracticeTradeId && resolvedSignalId) {
    const pt = await env.DB.prepare(`SELECT id FROM practice_trades WHERE signal_id = ? AND status = 'OPEN'`).bind(resolvedSignalId).first();
    if (pt) resolvedPracticeTradeId = pt.id;
  }

  const nowMs  = Date.now();
  const nowIso = new Date().toISOString();
  const stmts  = [];
  let signalIdx = -1, practiceTradeIdx = -1;

  if (resolvedSignalId) {
    const sets  = ['outcome = ?', 'exit_price = ?', 'pnl_pct = ?', 'closed_at = ?', 'outcome_source = ?', 'updated_at = ?'];
    const binds = [outcome, exitPrice, pnlPct, nowMs, outcomeSource, nowMs];
    if (telegramOutcomeSent !== null) { sets.push('telegram_outcome_sent = ?'); binds.push(telegramOutcomeSent); }
    if (exitReason !== null)          { sets.push('exit_reason = ?');           binds.push(exitReason); }
    binds.push(resolvedSignalId);
    signalIdx = stmts.length;
    stmts.push(env.DB.prepare(`UPDATE signals SET ${sets.join(', ')} WHERE id = ? AND outcome = 'OPEN'`).bind(...binds));
  }
  if (resolvedPracticeTradeId) {
    practiceTradeIdx = stmts.length;
    stmts.push(env.DB.prepare(`
      UPDATE practice_trades SET status = ?, exit_price = ?, result_pct = ?, closed_at = ?
      WHERE id = ? AND status = 'OPEN'
    `).bind(outcome, exitPrice, pnlPct, nowIso, resolvedPracticeTradeId));
  }

  if (!stmts.length) return { closedSignal: false, closedPracticeTrade: false };

  // .meta.changes (not "was an ID resolved") tells us whether the OPEN-guarded
  // UPDATE actually won the row — a concurrent closer may have already flipped
  // it, in which case this call's batch write is a silent no-op.
  const results = await env.DB.batch(stmts);
  return {
    closedSignal:        signalIdx        >= 0 && (results[signalIdx]?.meta?.changes ?? 0) > 0,
    closedPracticeTrade: practiceTradeIdx >= 0 && (results[practiceTradeIdx]?.meta?.changes ?? 0) > 0,
  };
}

// ── TP1 PARTIAL — single writer for the breakeven transition ──────────
// Spiegelt das closeTrade-Pattern: markiert tp1_hit und zieht den SL in BEIDEN
// Outcome-Tabellen (signals + practice_trades) atomar auf Breakeven nach, damit
// sie nicht auseinanderlaufen. Der COALESCE(tp1_hit,0)=0-Guard macht den Übergang
// idempotent — nur der erste Aufruf "gewinnt" (→ Exactly-once-Notifikation).
// Es wird NICHT geschlossen (Trade bleibt OPEN); der Restposition läuft auf TP2.
async function applyTp1Partial(env, {
  signalId = null,
  practiceTradeId = null,
  newSl,
  realizedPct,
} = {}) {
  if (!signalId && !practiceTradeId) return { appliedSignal: false, appliedPracticeTrade: false };

  let resolvedSignalId = signalId;
  let resolvedPracticeTradeId = practiceTradeId;
  if (!resolvedSignalId && practiceTradeId) {
    const pt = await env.DB.prepare(`SELECT signal_id FROM practice_trades WHERE id = ?`).bind(practiceTradeId).first();
    if (pt?.signal_id) resolvedSignalId = pt.signal_id;
  }
  if (!resolvedPracticeTradeId && resolvedSignalId) {
    const pt = await env.DB.prepare(`SELECT id FROM practice_trades WHERE signal_id = ? AND status = 'OPEN'`).bind(resolvedSignalId).first();
    if (pt) resolvedPracticeTradeId = pt.id;
  }

  const stmts = [];
  let signalIdx = -1, ptIdx = -1;
  if (resolvedSignalId) {
    signalIdx = stmts.length;
    stmts.push(env.DB.prepare(
      `UPDATE signals SET tp1_hit = 1, sl_current = ?, updated_at = ?
       WHERE id = ? AND outcome = 'OPEN' AND COALESCE(tp1_hit, 0) = 0`
    ).bind(newSl, Date.now(), resolvedSignalId));
  }
  if (resolvedPracticeTradeId) {
    ptIdx = stmts.length;
    stmts.push(env.DB.prepare(
      `UPDATE practice_trades SET tp1_hit = 1, sl_price = ?, realized_pct = ?
       WHERE id = ? AND status = 'OPEN' AND COALESCE(tp1_hit, 0) = 0`
    ).bind(newSl, realizedPct, resolvedPracticeTradeId));
  }
  if (!stmts.length) return { appliedSignal: false, appliedPracticeTrade: false };

  const results = await env.DB.batch(stmts);
  return {
    appliedSignal:        signalIdx >= 0 && (results[signalIdx]?.meta?.changes ?? 0) > 0,
    appliedPracticeTrade: ptIdx     >= 0 && (results[ptIdx]?.meta?.changes ?? 0) > 0,
  };
}

// Kurze Telegram-Notiz beim TP1-Treffer (50% realisiert, SL → Breakeven).
async function notifyTp1(env, { symbol, direction, entry, tp1, newSl, realizedPct }) {
  try {
    await sendTelegramMessage(env,
      `🎯 <b>TP1 HIT — ${symbol} ${direction}</b>\n\n` +
      `50% der Position realisiert · Rest läuft auf TP2\n` +
      `Entry: $${Number(entry).toFixed(2)} · TP1: $${Number(tp1).toFixed(2)}\n` +
      `SL → Breakeven: $${Number(newSl).toFixed(2)}\n` +
      `Gesichert: <b>+${Number(realizedPct).toFixed(2)}%</b>`
    );
  } catch (_) {}
}

async function getPracticeTrades(env, { symbol, timeframe, direction, status, limit = 100 } = {}) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
    ).first();
    if (!tableCheck) return [];

    let query = 'SELECT * FROM practice_trades WHERE 1=1';
    const params = [];

    if (symbol    && symbol    !== 'all') { query += ' AND symbol = ?';    params.push(symbol); }
    if (timeframe && timeframe !== 'all') { query += ' AND timeframe = ?'; params.push(timeframe); }
    if (direction && direction !== 'all') { query += ' AND direction = ?'; params.push(direction); }
    if (status    && status    !== 'all') { query += ' AND status = ?';    params.push(status); }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = await env.DB.prepare(query).bind(...params).all();
    return rows.results || [];
  } catch (error) {
    console.error('❌ getPracticeTrades error:', error.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// STATS HELPERS
// ═══════════════════════════════════════════════════════════════

// ── computeWinRate/computeExpectancy ausgelagert nach src/stats.js (Imports oben). ──

async function getPracticeTradeStats(env) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
    ).first();
    if (!tableCheck) return { total: 0, open: 0, wins: 0, losses: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0, expectancy: 0 };

    const total   = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades`).first();
    const open    = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='OPEN'`).first();
    const wins    = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='WIN'`).first();
    const losses  = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='LOSS'`).first();
    const avgWin  = await env.DB.prepare(`SELECT AVG(result_pct) as a FROM practice_trades WHERE status='WIN'`).first();
    const avgLoss = await env.DB.prepare(`SELECT AVG(result_pct) as a FROM practice_trades WHERE status='LOSS'`).first();

    const winRate    = computeWinRate(wins.c, losses.c);
    const avgWinPct  = parseFloat((avgWin.a || 0).toFixed(2));
    const avgLossPct = parseFloat((avgLoss.a || 0).toFixed(2));
    const expectancy = computeExpectancy(wins.c, losses.c, avgWinPct, avgLossPct);

    return {
      total: total.c || 0,
      open: open.c || 0,
      wins: wins.c || 0,
      losses: losses.c || 0,
      winRate,
      avgWinPct,
      avgLossPct,
      expectancy
    };
  } catch (error) {
    console.error('❌ getPracticeTradeStats error:', error.message);
    return { total: 0, open: 0, wins: 0, losses: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0, expectancy: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL PROCESSING
// ═══════════════════════════════════════════════════════════════

function normalizeDirection(payload) {
  const candidates = [payload.direction, payload.side, payload.signal, payload.action, payload.trigger];
  for (const c of candidates) {
    const v = String(c || '').toUpperCase();
    if (v === 'LONG' || v === 'BUY')   return 'LONG';
    if (v === 'SHORT' || v === 'SELL') return 'SHORT';
  }
  return null;
}

function normalizeAction(payload) {
  const raw = String(payload.action || payload.trigger || '').toUpperCase();
  if (raw === 'BUY'  || raw === 'LONG')  return 'BUY';
  if (raw === 'SELL' || raw === 'SHORT') return 'SELL';
  return raw || null;
}

/**
 * End-to-end processing of one incoming TradingView/webhook signal: candidate
 * gating, rule + VP scoring, optional Claude analysis, notifications and
 * persistence into the `signals` table. Has side effects (D1, fetch); the
 * happy/edge paths are covered by test/processSignal.test.js.
 * @param {object} env - Worker env bindings (DB, secrets, …).
 * @param {object} signal - Raw webhook payload.
 * @returns {Promise<object>} { status, signalId, analysis } on success, or
 *   { status: 'candidate_rejected', … } when the candidate gate is not met.
 */
async function processSignal(env, signal) {
  const direction = normalizeDirection(signal);
  const action    = normalizeAction(signal);
  signal.direction = direction;

  // Das deployte Pine v2 sendet den Einstiegspreis als `entry` (String), NICHT
  // als `price`/`close`. Ohne diese Abbildung berechnet analyzeWithRules
  // entry/tp/sl = 0 (price ?? 0) und in der DB landet price 0 — d.h. jeder
  // geöffnete Baseline-Trade hätte Null-Levels. `entry` → `price` mappen, wenn
  // kein expliziter Preis vorliegt (überschreibt vorhandene Werte nie).
  if (signal.price == null && signal.close == null && signal.entry != null) {
    const entryNum = parseFloat(signal.entry);
    if (Number.isFinite(entryNum) && entryNum > 0) signal.price = entryNum;
  }

  console.log('📊 Processing signal:', signal.symbol, direction, '| action:', action, '| rsi:', signal.rsi);

  // For low-value assets (price < $10), TradingView sometimes rounds to 2 dp
  // (e.g. TRX: 0.36 instead of 0.3621). Fetch a precise live price so that
  // the TP/SL levels are calculated from an accurate entry.
  if (signal.price && signal.price < 10 && parseFloat(signal.price.toFixed(2)) === signal.price) {
    const livePrice = await getLivePrice(env, signal.symbol);
    if (livePrice && Math.abs(livePrice - signal.price) / signal.price < 0.05) {
      console.log(`🔬 Price precision fix: ${signal.symbol} ${signal.price} → ${livePrice}`);
      signal.price = livePrice;
    }
  }

  await ensureTables(env);

  // Auto-register signal symbol so it appears in the journal sidebar
  try {
    const raw = await getSetting(env, 'journal_symbols', '[]');
    const syms = JSON.parse(raw);
    if (!syms.includes(signal.symbol)) {
      syms.push(signal.symbol);
      await setSetting(env, 'journal_symbols', JSON.stringify(syms));
    }
  } catch (_) {}

  // Resolve active strategy (auto-init default if none)
  let strategy = await getActiveStrategy(env);
  if (!strategy) strategy = await initDefaultStrategy(env);
  const strategyConfig = strategy?.config || null;

  // ── Multi-Strategie-Routing (AUFGABE 2) ──────────────────────────────
  // Strategie kommt aus dem `strategy`-Feld im Webhook-Payload (EIN Webhook,
  // mehrere Pine-Scripts). Fehlt es → 'crypto_baseline' (rückwärtskompatibel).
  const strategyKey   = resolveStrategyKey(signal);
  const stratDef      = STRATEGIES[strategyKey];
  const assetClass    = detectAssetClass(signal.symbol);
  const exitCfg       = exitConfigForStrategy(strategyKey);

  // ── GUARD: kein validierbarer Entry-Preis → Signal ablehnen ──────────
  // Live-Incident: SOLUSDT/SUIUSDT wurden mit price/ai_entry/ai_tp/ai_sl = NULL
  // eröffnet (alte Logik vor PR #139) — ein Trade ohne Entry/TP/SL-Levels ist
  // gefährlicher als gar kein Trade (kaputte PnL-Berechnung beim Exit-Check,
  // Fallback-Werte wie pnl_pct=-1). Nach der entry→price-Abbildung oben MUSS
  // ein positiver, endlicher Preis vorliegen — sonst sofort REJECTED, bevor
  // Kandidaten-Score/Claude/Telegram überhaupt anlaufen. `0` zählt explizit
  // als ungültig (nicht nur `null`), analog zur Anforderung.
  const entryPriceCandidate = parseFloat(signal.price ?? signal.close ?? NaN);
  if (!Number.isFinite(entryPriceCandidate) || entryPriceCandidate <= 0) {
    console.log(`❌ ${strategyKey} ${signal.symbol}: kein validierbarer Entry-Preis (price/close/entry fehlen oder ungültig) → REJECTED`);
    try {
      const rejectedId = `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await env.DB.prepare(`
        INSERT INTO signals (id, symbol, timeframe, direction, price, ai_score,
          telegram_reason, strategy_key, asset_class, created_at, outcome, is_test, source, trigger_reason)
        VALUES (?, ?, ?, ?, ?, ?, 'missing_entry_price', ?, ?, ?, 'REJECTED', 0, 'WEBHOOK', ?)
      `).bind(
        rejectedId,
        signal.symbol || 'UNKNOWN',
        String(signal.timeframe || ''),
        direction || null,
        0,
        0,
        strategyKey,
        assetClass,
        Date.now(),
        signal.trigger || 'WEBHOOK'
      ).run();
    } catch (dbErr) {
      console.error('❌ REJECTED (missing_entry_price) INSERT fehlgeschlagen:', dbErr.message);
    }
    return { status: 'missing_entry_price', strategyKey, assetClass };
  }

  // Forex-Strategien HART nur in den Handelsfenstern (London-Open / NY-Overlap):
  // außerhalb keine handelbaren Signale generieren.
  const sessionClosed = !!stratDef.sessionGate && assetClass === 'forex' && !isWithinForexSession();
  if (sessionClosed) {
    console.log(`⏭️ ${strategyKey} ${signal.symbol}: außerhalb Forex-Session → kein handelbares Signal`);
  }
  // AUFGABE 1: Pausierte Strategien verarbeiten keine neuen Trades (offene bleiben).
  const strategyPaused = await isStrategyPaused(env, strategyKey);
  if (strategyPaused) {
    console.log(`⏸️ ${strategyKey} ${signal.symbol}: Strategie pausiert → kein neuer Trade`);
  }

  // ── Kandidaten-Score (pro Strategie) ────────────────────────────────
  // JEDES eingehende Signal wird als Kandidat bewertet und in signal_candidates
  // gespeichert. Nur wenn der Score den Schwellenwert überschreitet, läuft die
  // volle Verarbeitungs-Pipeline (analyzeWithRules / Claude / Trade-Insert).
  const candidateScoringOverrides = await loadCandidateScoringConfig(env, strategyKey);
  // Rohen Pine-Payload einmalig auf Score-Features mappen — sowohl fürs Scoring
  // als auch für die Persistenz in signal_candidates (abgeleitete Felder werden
  // so für spätere Kalibrierung mitgespeichert).
  const scoringSignal = normalizeSignalForScoring(strategyKey, signal);
  const { score: candidateScore, details: candidateScoreDetails, threshold: candidateThreshold } =
    scoreCandidate(strategyKey, scoringSignal, candidateScoringOverrides);
  const passedCandidateGate = candidateScore >= candidateThreshold;
  console.log(`📊 Candidate score [${strategyKey}]: ${candidateScore}/${candidateThreshold} → ${passedCandidateGate ? 'PASS' : 'REJECT'}`);

  if (!passedCandidateGate) {
    console.log(`❌ Candidate rejected [${strategyKey}]: ${signal.symbol} score=${candidateScore}/${candidateThreshold} → candidate_score_too_low`);
    // Abgelehnter Kandidat: in signal_candidates speichern (Detaildaten)
    await saveSignalCandidate(env, {
      signal: scoringSignal, strategyKey, strategyId: strategy?.id,
      candidateScore, threshold: candidateThreshold,
      scoreDetails: candidateScoreDetails,
      passedThreshold: false, signalId: null,
    });
    // Auch in signals-Tabelle eintragen (outcome='REJECTED') damit kein Signal
    // lautlos verschwindet — jedes eingehende Signal muss im Dashboard sichtbar sein.
    try {
      const rejectedId = `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      await env.DB.prepare(`
        INSERT INTO signals (id, symbol, timeframe, direction, price, ai_score,
          telegram_reason, strategy_key, asset_class, created_at, outcome, is_test, source, trigger_reason)
        VALUES (?, ?, ?, ?, ?, ?, 'candidate_score_too_low', ?, ?, ?, 'REJECTED', 0, 'WEBHOOK', ?)
      `).bind(
        rejectedId,
        signal.symbol || 'UNKNOWN',
        String(signal.timeframe || ''),
        direction || null,
        signal.price ?? signal.close ?? 0,
        candidateScore,
        strategyKey,
        assetClass,
        Date.now(),
        signal.trigger || 'WEBHOOK'
      ).run();
    } catch (dbErr) {
      console.error('❌ REJECTED signal INSERT fehlgeschlagen:', dbErr.message);
    }
    return { status: 'candidate_rejected', candidateScore, candidateThreshold, strategyKey };
  }

  // ── Score-Optimizer-Scope ────────────────────────────────────────────
  // Der Score-Optimizer (Regel-Score + Claude + Score-Schwellen) ist NUR für
  // crypto_baseline kalibriert. Die übrigen Strategien (crypto_sr_volume,
  // crypto_orderflow_breakout, forex_sr_fib_rsi) liefern aus Pine bereits eine
  // harte Ja/Nein-Entscheidung → sie durchlaufen ohne Score-Filter (kein
  // Claude-Call, Telegram direkt bei handelbarem Signal). Genau diese Strategien
  // sind die mit useScoreGate=false — Single Source of Truth, kein Hardcoding.
  const scoreOptimized = stratDef.useScoreGate;

  const ruleAnalysis = analyzeWithRules(signal, strategyConfig, exitCfg);

  // crypto_baseline: ruleAnalysis bleibt im Einsatz für entry/tp/sl (rein aus
  // price/direction/exitCfg — unabhängig von den Trendfolge-Feldern, die das
  // v2-Pine nicht sendet) und für Telemetrie (matched/failed_rules,
  // score_breakdown). Sein SCORE wird für baseline durch den dedizierten
  // Mean-Reversion-Scorer ersetzt (siehe scoreMeanReversionBaseline oben) —
  // recommendation/risk werden aus demselben Score neu abgeleitet, damit sie
  // nicht mit dem (verworfenen) Trendfolge-Score inkonsistent bleiben.
  const baselineMeanReversionScore = strategyKey === 'crypto_baseline'
    ? scoreMeanReversionBaseline(scoringSignal)
    : null;
  const fallbackAnalysis = baselineMeanReversionScore == null
    ? ruleAnalysis
    : {
        ...ruleAnalysis,
        score: baselineMeanReversionScore,
        recommendation: baselineMeanReversionScore >= (stratDef.minScore ?? 75) ? (direction || 'RECOMMENDED') : 'SKIP',
        risk: baselineMeanReversionScore >= (stratDef.minScore ?? 75) + 12 ? 'LOW'
            : baselineMeanReversionScore >= (stratDef.minScore ?? 75)      ? 'MEDIUM' : 'HIGH',
      };

  // VP-Felder aus Payload parsen (defensiv — Pine sendet diese ab v3.6)
  const vpScore = Math.max(0, Math.min(25, parseInt(signal.vp_score, 10) || 0));
  const vpZone  = ['VAL', 'VAH', 'POC'].includes(String(signal.vp_zone || '')) ? signal.vp_zone : 'none';
  const vpPoc   = parseFloat(signal.poc) || null;
  const vpVah   = parseFloat(signal.vah) || null;
  const vpVal   = parseFloat(signal.val) || null;

  // VP-Score ist in Pine rein additiv (0 wenn Zone für die Richtung ungünstig
  // ist, nie negativ). Ein LONG in der VAH-Zone (Resistance direkt über dem
  // Preis) bzw. ein SHORT in der VAL-Zone (Support direkt unter dem Preis)
  // ist aber kein neutraler Fall, sondern ein Gegenwind-Signal — dafür gibt es
  // hier einen moderaten Abzug (Größenordnung unterhalb des max. Bonus von 25).
  const vpAdverseZone   = (direction === 'LONG' && vpZone === 'VAH') || (direction === 'SHORT' && vpZone === 'VAL');
  const vpPenalty       = vpAdverseZone ? -8 : 0;
  const vpScoreAdjusted = vpScore + vpPenalty;

  // Score-Gate: (rule_score + vp_score) entscheidet ob Claude aufgerufen wird.
  // VP-Konfluenz senkt die Schwelle von 55 auf 50 (bessere Signalqualität erwartet).
  // fallbackAnalysis.score ist für baseline bereits der Mean-Reversion-Score
  // (für alle anderen Strategien identisch zu ruleAnalysis.score).
  const preAiScore  = fallbackAnalysis.score + vpScoreAdjusted;
  const aiThreshold = vpZone !== 'none' ? 50 : 55;

  // Use AbortController so the Anthropic fetch is actually cancelled when the
  // timeout fires, not just orphaned in the background (M2).
  const aiAbort = new AbortController();
  const aiTimer = setTimeout(() => aiAbort.abort(), AI_TIMEOUT_MS);
  let analysis;
  try {
    // Claude läuft NIE für crypto_baseline: analyzeSignalWithAI() prompted
    // Claude mit denselben Trendfolge-Feldern wie analyzeWithRules (price/
    // ema50/ema200/trend/confidence) — Felder, die das deployte v2-Pine
    // (wavescout_baseline.pine) für baseline gar nicht sendet. Ein Claude-Call
    // dort würde nur Kosten/Latenz verursachen, ohne dass Claude mehr Signal
    // hätte als "n/a". scoreMeanReversionBaseline (siehe oben) ist das
    // vollständige, deterministische Gate 2 für baseline; analyzeWithRules
    // bleibt nur für entry/tp/sl + Telemetrie im Einsatz (siehe fallbackAnalysis
    // oben). Die Pine-getrusteten Strategien (useScoreGate=false) riefen
    // Claude ohnehin nie auf.
    if (scoreOptimized && strategyKey !== 'crypto_baseline' && preAiScore >= aiThreshold) {
      analysis = await analyzeSignalWithAI(env, signal, strategyConfig, aiAbort.signal, fallbackAnalysis) || fallbackAnalysis;
    } else {
      if (strategyKey === 'crypto_baseline') console.log(`⏭️ ${strategyKey}: Mean-Reversion-Score ${fallbackAnalysis.score} → Claude komplett übersprungen (Gate 2 ist deterministisch)`);
      else if (!scoreOptimized)              console.log(`⏭️ ${strategyKey}: Pine-gefiltert → Score-Optimizer/Claude übersprungen`);
      else                                   console.log(`⏭️ Score-Gate: ${preAiScore} < ${aiThreshold} → Claude-Call übersprungen`);
      analysis = fallbackAnalysis;
    }
  } catch (aiErr) {
    if (aiErr.name !== 'AbortError') console.error('AI analysis error:', aiErr.message);
    analysis = fallbackAnalysis;
  } finally {
    clearTimeout(aiTimer);
  }

  // Apply score penalty when HIGH-impact market events are active in the last 2h.
  // This mirrors the strategy rule "Ausschluss: Major News innerhalb 15min" but
  // also softens signals during sustained high-risk periods.
  let newsWarning = null;
  try {
    const highNews = await env.DB.prepare(
      `SELECT COUNT(*) as c, GROUP_CONCAT(title, ' | ') as titles FROM market_events WHERE status = 'ACTIVE' AND impact = 'HIGH' AND updated_at >= ?`
    ).bind(Date.now() - 2 * 60 * 60 * 1000).first();
    if (highNews?.c > 0) {
      const before = analysis.score;
      analysis.score = Math.max(0, analysis.score - 20);
      newsWarning = `${highNews.c} HIGH-Impact News aktiv`;
      console.log(`📰 News penalty: ${before} → ${analysis.score} (${newsWarning})`);
      // Inject into failed_rules so it shows in the Telegram message
      if (!Array.isArray(ruleAnalysis.failed_rules)) ruleAnalysis.failed_rules = [];
      ruleAnalysis.failed_rules.unshift(`⚠️ ${newsWarning}`);
    }
  } catch (_) {}

  // VP-Score on top addieren/abziehen (nach News-Penalty, damit Penalty nicht
  // durch VP überkompensiert wird). Kann jetzt auch negativ sein (vpAdverseZone).
  if (vpScoreAdjusted !== 0) {
    const before = analysis.score;
    analysis.score = Math.max(0, Math.min(100, analysis.score + vpScoreAdjusted));
    console.log(`📊 VP adjust: ${before} → ${analysis.score} (${vpScoreAdjusted >= 0 ? '+' : ''}${vpScoreAdjusted}, zone: ${vpZone})`);
  }

  const signalId = `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Compute derived fields from ruleAnalysis (always deterministic)
  const matchedRulesJSON   = JSON.stringify(ruleAnalysis.matched_rules  || []);
  const failedRulesJSON    = JSON.stringify(ruleAnalysis.failed_rules   || []);
  const unknownRulesJSON   = JSON.stringify(ruleAnalysis.unknown_rules  || []);
  const scoreBreakdownJSON = JSON.stringify(ruleAnalysis.score_breakdown || {});
  const signalQuality      = getSignalQuality(analysis.score);
  const riskReward         = calcRR(analysis.entry, analysis.tp, analysis.sl, direction === 'LONG');
  const plannedProfitPct   = safePct(analysis.tp, analysis.entry);
  const plannedRiskPct     = safePct(analysis.sl, analysis.entry);
  const triggerReason      = signal.trigger || signal.action || 'WEBHOOK';

  // Determine Telegram notification.
  // Score-Optimizer-Notify-Filter (Telegram erst ab Score ≥80) gilt NUR für die
  // score-optimierte Strategie (crypto_baseline). Dort sind Signale mit 75–79
  // zwar handelbar (practice/Dashboard-Bell ≥70), lösen aber bewusst KEINEN
  // Telegram-Alert aus. Die Pine-gefilterten Strategien benachrichtigen direkt,
  // sobald das Signal handelbar ist (nicht pausiert / innerhalb Session) — ohne
  // zusätzliches Score-Gate: analysis.score kommt aus dem auf crypto_baseline
  // kalibrierten Trendfolge-Scorer (analyzeWithRules) und ist für Pine-Strategien
  // nicht aussagekräftig (candidateScore/Gate 1 ≥70 + Pine-Entry-Logik filtern
  // hier bereits die Qualität).
  const isTest       = signal.test === true || signal.is_test === 1;
  let   shouldNotify = isTest || (scoreOptimized
    ? analysis.score >= 80
    : (!sessionClosed && !strategyPaused));
  let telegramSent   = 0;
  let telegramReason = 'below_threshold';

  // Atomic dedup: INSERT OR IGNORE into alert_dedup using a 15-min window key.
  // Because INSERT is atomic in SQLite/D1, only the first concurrent request
  // succeeds — all others (including TradingView retries / queued duplicates)
  // get changes=0 and are suppressed. This replaces the old SELECT-before-INSERT
  // which had a race window that caused ~4x duplicate alerts.
  if (shouldNotify && !isTest) {
    try {
      const windowKey = Math.floor(Date.now() / (15 * 60 * 1000));
      const dedupKey  = `${signal.symbol}|${signal.timeframe || ''}|${windowKey}`;
      const ins = await env.DB.prepare(
        `INSERT OR IGNORE INTO alert_dedup (dedup_key, created_at) VALUES (?, ?)`
      ).bind(dedupKey, Date.now()).run();
      if (ins.meta?.changes === 0) {
        console.log(`🔕 Dedup: ${signal.symbol} ${signal.timeframe} already alerted in this 15-min window`);
        shouldNotify = false;
        telegramReason = 'cooldown_15min';
      }
      // Prune entries older than 2h to keep table lean
      await env.DB.prepare(
        `DELETE FROM alert_dedup WHERE created_at < ?`
      ).bind(Date.now() - 2 * 60 * 60 * 1000).run();
    } catch (_) {}
  }

  if (shouldNotify) {
    // Echtes Signal → Priority-Alert. Erreichbar für crypto_baseline nur ab
    // Score ≥80 (shouldNotify), für die Pine-gefilterten Strategien sobald das
    // Signal handelbar ist. Der else-Zweig ist damit ausschließlich für Tests.
    if (!isTest) {
      telegramReason = scoreOptimized ? 'score_80_priority' : 'pine_signal';
      const alertMsg = formatPriorityAlert({
        ...signal,
        direction,
        ai_score:        analysis.score,
        ai_entry:        analysis.entry,
        ai_tp:           analysis.tp,
        ai_sl:           analysis.sl,
        ai_reason:       analysis.reason,
        risk_reward:     riskReward,
        // Erweiterte Signal-Details (alle optional, mit Fallback in der Format-Fn):
        ai_tp1:          deriveTp1(analysis.entry, analysis.tp), // TP1-Trigger (Teilgewinn)
        strategy_key:    strategyKey,                            // → "Krypto-1 (RSI+EMA200)" etc.
        signal_class:    signal.signal_class || null,            // REVERSAL → Warnhinweis
        score_breakdown: ruleAnalysis.score_breakdown,           // Score-Komponenten
      });
      const sent = await withTimeout(sendAlertMessage(env, alertMsg), TELEGRAM_TIMEOUT_MS, false);
      if (sent) telegramSent = 1;
    } else {
      // Test-Signal (jeder Score): reguläre Nachricht mit Debug-Präfix.
      telegramReason = 'test_signal';
      const debugPrefix = `🧪 <b>[TEST]</b>\n`;
      const telegramMessage = debugPrefix + formatSignalForTelegram({
        ...signal,
        direction,
        ai_score:        analysis.score,
        ai_entry:        analysis.entry,
        ai_tp:           analysis.tp,
        ai_sl:           analysis.sl,
        ai_reason:       analysis.reason,
        signal_quality:  signalQuality,
        risk_reward:     riskReward,
        matched_rules:   matchedRulesJSON,
        failed_rules:    failedRulesJSON,
        vp_zone:         vpZone,
        vp_score:        vpScore,
        // Erweiterte Signal-Details (alle optional, mit Fallback in der Format-Fn):
        ai_tp1:          deriveTp1(analysis.entry, analysis.tp), // TP1-Trigger (Teilgewinn)
        strategy_key:    strategyKey,                            // → "Krypto-1 (RSI+EMA200)" etc.
        signal_class:    signal.signal_class || null,            // REVERSAL → Warnhinweis
        score_breakdown: ruleAnalysis.score_breakdown,           // Score-Komponenten
      });
      const sent = await withTimeout(sendTelegramMessage(env, telegramMessage), TELEGRAM_TIMEOUT_MS, false);
      if (sent) telegramSent = 1;
    }
    // ntfy.sh push for top-tier signals (score ≥ 95), runs in addition to Telegram
    if (!isTest && analysis.score >= 95) {
      await withTimeout(sendNtfyAlert(env, signal.symbol, signal.timeframe || '', analysis.score), 5000, false);
    }
    // Web Push an alle Geräte: für jedes echte benachrichtigte Signal (baseline
    // erreicht den Block nur ab ≥80, die Pine-Strategien sobald handelbar).
    if (!isTest) {
      const dir = direction === 'LONG' ? '▲' : '▼';
      sendWebPushToAll(env,
        `${dir} ${signal.symbol} · Score ${analysis.score}`,
        `Entry $${(analysis.entry||0).toFixed(2)} · TP $${(analysis.tp||0).toFixed(2)} · SL $${(analysis.sl||0).toFixed(2)}`,
        '/'
      ).catch(() => {});
    }
  }

  // Per-Strategie-Gate: baseline gated über Score (≥ minScore), die anderen
  // vertrauen dem Pine-Entry (useScoreGate=false). Forex außerhalb der Session
  // (sessionClosed) wird nie OPEN.
  const passesGate = !sessionClosed && !strategyPaused &&
    (stratDef.useScoreGate ? analysis.score >= (stratDef.minScore ?? 75) : true);

  let dbInsertResult;
  try {
    dbInsertResult = await env.DB.prepare(`
    INSERT INTO signals (
      id, symbol, timeframe, price, direction, action, trigger,
      rsi, ema50, ema200, trend, support, resistance, wave_bias,
      ai_recommendation, ai_direction, ai_score, ai_risk, ai_confidence,
      ai_entry, ai_tp, ai_sl, ai_reason,
      rule_score, rule_reason,
      strategy_id, strategy_name, strategy_version,
      is_test, source, telegram_sent, telegram_reason,
      matched_rules, failed_rules, unknown_rules, score_breakdown,
      signal_quality, risk_reward, planned_profit_pct, planned_risk_pct,
      trigger_reason, disclaimer_shown,
      poc, vah, val, vp_zone, vp_score, signal_class,
      created_at, outcome,
      ai_tp1, tp1_hit, sl_current,
      asset_class, strategy_key
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    signalId,
    signal.symbol  || 'UNKNOWN',
    String(signal.timeframe || '5'),
    signal.price   || signal.close || 0,
    direction,
    action,
    signal.trigger || 'WEBHOOK',
    signal.rsi        ?? null,
    signal.ema50      ?? null,
    signal.ema200     ?? null,
    signal.trend      || null,
    signal.support    ?? null,
    signal.resistance ?? null,
    signal.wave_bias  || null,
    analysis.recommendation,
    analysis.direction || direction,
    analysis.score,
    analysis.risk,
    signal.confidence ?? null,
    analysis.entry,
    analysis.tp,
    analysis.sl,
    analysis.reason,
    analysis.score,
    analysis.reason,
    strategy?.id      || null,
    strategy?.name    || 'WAVESCOUT Standard',
    strategy?.version || 'v1.0',
    isTest ? 1 : 0,
    signal.source || 'WEBHOOK',
    telegramSent,
    telegramReason,
    matchedRulesJSON,
    failedRulesJSON,
    unknownRulesJSON,
    scoreBreakdownJSON,
    signalQuality,
    riskReward,
    plannedProfitPct,
    plannedRiskPct,
    triggerReason,
    1,
    vpPoc,
    vpVah,
    vpVal,
    vpZone,
    vpScore,
    signal.signal_class || null,
    Date.now(),
    passesGate ? 'OPEN' : 'SKIPPED',
    deriveTp1(analysis.entry, analysis.tp), // ai_tp1  (TP1-Trigger)
    0,                                      // tp1_hit (noch nicht erreicht)
    analysis.sl,                            // sl_current (startet auf Original-SL)
    assetClass,                             // asset_class ('crypto' | 'forex')
    strategyKey                             // strategy_key (Routing-Strategie)
  ).run();
  } catch (dbErr) {
    console.error('❌ Signal INSERT fehlgeschlagen — Signal nicht gespeichert:', dbErr.message, 'signalId:', signalId);
    throw new Error(`Signal-Persistierung fehlgeschlagen: ${dbErr.message}`);
  }

  // AUFGABE 3: Kein paralleler Übungstrade-Pfad mehr. Die `signals`-Zeile oben
  // IST der Live-Pfad (Outcome/PnL/Exit). createPracticeTrade entfällt, damit
  // signals und practice_trades nicht mehr divergieren können.

  // Autotrade: place real exchange order if configured and score meets threshold
  try {
    const atCfg = await loadAutotradeConfig(env);
    if (atCfg) {
      const minScore = Math.max(75, atCfg.minScore || 75);
      if (atCfg.enabled && !isTest && !strategyPaused && analysis.score >= minScore && analysis.entry) {
        const amount = parseFloat(atCfg.tradeAmount) || 10;
        const qty    = calcOrderQty(amount, analysis.entry);
        let orderId = null, errMsg = null, status = 'OPEN';
        try {
          const result = await placeExchangeOrder(env, {
            symbol: signal.symbol, direction,
            entry: analysis.entry, tp: analysis.tp, sl: analysis.sl,
          });
          if (result.ok) orderId = result.orderId;
          else { errMsg = result.error; status = 'ERROR'; }
        } catch (e) {
          errMsg = e.message; status = 'ERROR';
        }
        const ltId = `lt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        await env.DB.prepare(`
          INSERT INTO live_trades (id, signal_id, exchange, order_id, symbol, direction, entry_price, tp_price, sl_price, quantity, trade_amount_usdt, status, is_testnet, error_message, opened_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          ltId, signalId, atCfg.broker, orderId,
          signal.symbol, direction, analysis.entry, analysis.tp, analysis.sl,
          qty, amount, status, atCfg.testnet ? 1 : 0, errMsg,
          Date.now(), Date.now(), Date.now()
        ).run();
        if (errMsg) {
          console.error('❌ Autotrade failed:', errMsg);
          await withTimeout(sendTelegramMessage(env,
            `⚠️ <b>Autotrade Fehler</b>\n${signal.symbol} ${direction}\nFehler: ${errMsg}`
          ), TELEGRAM_TIMEOUT_MS, false);
        } else {
          console.log('✅ Autotrade order placed:', orderId, signal.symbol, direction);
        }
      }
    }
  } catch (atErr) {
    console.error('❌ Autotrade setup error:', atErr.message);
  }

  // Kandidaten-Eintrag mit signal_id verknüpfen (Kandidat hat den Gate passiert)
  await saveSignalCandidate(env, {
    signal: scoringSignal, strategyKey, strategyId: strategy?.id,
    candidateScore, threshold: candidateThreshold,
    scoreDetails: candidateScoreDetails,
    passedThreshold: true, signalId,
  });

  console.log('✅ Signal processed:', signalId, '| Score:', analysis.score, '| Rec:', analysis.recommendation, '| Telegram:', telegramSent ? telegramReason : 'no');
  return { status: 'ok', signalId, analysis };
}

async function handlePriceUpdate(env, payload) {
  try {
    const symbol = payload.symbol;
    const price = parseFloat(payload.price ?? payload.close ?? 0);
    if (!symbol || !price) return { success: true, type: 'PRICE_UPDATE', message: 'Price update accepted (no symbol/price)' };
    await ensureTables(env);
    await checkOpenSignalsForSymbol(env, symbol, price);
    return { success: true, type: 'PRICE_UPDATE', message: 'Price update processed', symbol, price };
  } catch (error) {
    console.error('❌ PRICE_UPDATE error:', error?.message || error);
    return { success: true, type: 'PRICE_UPDATE', message: 'Price update accepted (processing failed)' };
  }
}

function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function mapEventCategory(text = '') {
  const t = text.toLowerCase();
  if (/(etf|blackrock|fidelity|approval|denial)/.test(t) && /bitcoin|btc|crypto/.test(t)) return 'BTC_ETF';
  if (/(sec|mica|regulation|lawsuit|ban|compliance)/.test(t) && /bitcoin|btc/.test(t)) return 'BTC_REGULATION';
  if (/(mining|miner|halving|hashrate)/.test(t)) return 'BTC_MINING_HALVING';
  if (/(whale|wallet|on-chain transfer|reserve)/.test(t) && /btc|bitcoin/.test(t)) return 'BTC_WHALE';
  if (/(fed|cpi|inflation|nfp|fomc|rate decision|interest rate)/.test(t)) return 'MACRO';
  if (/(binance|bybit|mexc|blofin|exchange)/.test(t)) return 'EXCHANGE_NEWS';
  if (/(stablecoin|usdt|usdc|depeg)/.test(t)) return 'STABLECOIN';
  if (/(hack|exploit|breach|drain|outage)/.test(t)) return 'SECURITY_INCIDENT';
  if (/(liquidation|volatility|dominance)/.test(t)) return 'MARKET_STRUCTURE';
  return 'CRYPTO_GENERAL';
}

function mapImpact(text = '') {
  const t = text.toLowerCase();
  if (/(hack|exploit|sec lawsuit|lawsuit|etf approval|etf denied|etf denial|rate decision|cpi surprise|depeg|exchange outage)/.test(t)) return 'HIGH';
  if (/(etf flow|regulation|liquidation|fed|cpi|nfp|political|election|sec)/.test(t)) return 'MEDIUM';
  return 'LOW';
}

function mapAffectedMarkets(text = '') {
  const t = text.toLowerCase();
  const out = new Set();
  if (/(btc|bitcoin|etf|mining|halving)/.test(t)) out.add('BTC');
  if (/(eth|ethereum)/.test(t)) out.add('ETH');
  if (/(altcoin|alts|sol|xrp|ada)/.test(t)) out.add('ALTCOINS');
  if (/(fed|cpi|nfp|liquidation|market|exchange|stablecoin|sec|regulation)/.test(t)) out.add('TOTAL_MARKET');
  if (out.size === 0) out.add('BTC');
  return Array.from(out);
}

function computeRadarStatus(events = []) {
  const highCount = events.filter(e => e.impact === 'HIGH').length;
  const mediumCount = events.filter(e => e.impact === 'MEDIUM').length;
  if (highCount >= 1) return 'RISK_OFF';
  if (mediumCount >= 2) return 'CAUTION';
  return 'NORMAL';
}

async function fetchRssItems(feed) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      res = await fetch(feed.url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WaveScout/1.0; +https://wavescout.dev)',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*',
          'Cache-Control': 'no-cache'
        }
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/g)].slice(0, 10);
    return items.map(m => {
      const chunk = m[0];
      const title = decodeXml((chunk.match(/<title>([\s\S]*?)<\/title>/i) || [,''])[1]).trim();
      const link = decodeXml((chunk.match(/<link>([\s\S]*?)<\/link>/i) || [,''])[1]).trim();
      const description = decodeXml((chunk.match(/<description>([\s\S]*?)<\/description>/i) || [,''])[1]).replace(/<[^>]*>/g, ' ').trim();
      const pubDate = (chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [,''])[1];
      const eventTime = Date.parse(pubDate || '') || Date.now();
      return { title, link, description, eventTime, sourceFeed: feed.name };
    });
  } catch (_) {
    return [];
  }
}

function safeIdPart(input = '') {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

async function getMarketRadar(env, session = null) {
  await ensureTables(env);
  const now = Date.now();
  const debug = {
    feeds_total: MARKET_RADAR_FEEDS.length,
    feeds_success: 0,
    feeds_failed: 0,
    items_loaded: 0,
    items_relevant: 0,
    db_saved: 0,
    error_message: null
  };
  const isAdmin = session?.role === 'admin';
  const withDebug = (payload) => isAdmin ? { ...payload, debug } : payload;

  try {
  const freshCache = await env.DB.prepare(
    `SELECT * FROM market_events WHERE status = 'ACTIVE' AND updated_at >= ? ORDER BY CASE WHEN impact='HIGH' THEN 1 WHEN impact='MEDIUM' THEN 2 ELSE 3 END ASC, event_time DESC LIMIT ?`
  ).bind(now - MARKET_RADAR_CACHE_TTL_MS, MARKET_RADAR_MAX_EVENTS).all();

  if (freshCache.results?.length) {
    const events = freshCache.results.map(r => ({ ...r, affected_markets: JSON.parse(r.affected_markets || '[]') }));
    return withDebug({ success: true, source: 'cache', errors: [], status: computeRadarStatus(events), updated_at: now, updatedAt: new Date(now).toISOString(), summary: "BTC/Krypto-Markt mit erhöhter Event-Aktivität.", events, disclaimer: RADAR_DISCLAIMER });
  }

  const feedArrays = await Promise.all(MARKET_RADAR_FEEDS.map(async (feed) => {
    const items = await fetchRssItems(feed);
    if (items.length > 0) debug.feeds_success += 1;
    else debug.feeds_failed += 1;
    return items;
  }));
  const rssResults = feedArrays.flat();
  debug.items_loaded = rssResults.length;
  const relevant = rssResults
    .filter(item => /bitcoin|btc|crypto|etf|sec|stablecoin|binance|bybit|mexc|blofin|fed|cpi|nfp|liquidation|hack|regulation/i.test(`${item.title} ${item.description}`))
    .slice(0, MARKET_RADAR_MAX_EVENTS)
    .map(item => {
      const text = `${item.title} ${item.description}`;
      return {
        id: `mradar_${item.eventTime}_${safeIdPart(item.title)}`,
        event_time: item.eventTime,
        title: item.title,
        category: mapEventCategory(text),
        impact: mapImpact(text),
        affected_markets: mapAffectedMarkets(text),
        source: 'RSS',
        source_url: item.link,
        summary: item.description.slice(0, 180) || 'Relevantes Krypto-Markt-Event.',
      };
    });
  debug.items_relevant = relevant.length;

  const status = computeRadarStatus(relevant);
  for (const event of relevant) {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO market_events
      (id, created_at, updated_at, event_time, title, category, impact, affected_markets, source, source_url, summary, radar_status, raw_json, long_text, affected_symbols, affected_scope, status)
      VALUES (?, COALESCE((SELECT created_at FROM market_events WHERE id = ?), ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).bind(
      event.id, event.id, now, now, event.event_time, event.title, event.category, event.impact,
      JSON.stringify(event.affected_markets), event.source, event.source_url, event.summary, status, JSON.stringify(event),
      event.long_text || '', event.affected_symbols || '[]', event.affected_scope || 'GLOBAL'
    ).run();
    debug.db_saved += 1;
  }

  let outputEvents;
  if (relevant.length > 0) {
    outputEvents = relevant;
    // Mark ALL existing events as refreshed so 20-min cache works on subsequent requests
    await env.DB.prepare(`UPDATE market_events SET updated_at = ? WHERE status = 'ACTIVE'`).bind(now).run();
  } else {
    const fb = await env.DB.prepare(
      `SELECT * FROM market_events WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT ?`
    ).bind(MARKET_RADAR_MAX_EVENTS).all();
    outputEvents = (fb.results || []).map(r => ({ ...r, affected_markets: JSON.parse(r.affected_markets || '[]') }));
    // Update updated_at so we don't hammer RSS feeds on the next request within 20 min
    if (outputEvents.length > 0) {
      await env.DB.prepare(`UPDATE market_events SET updated_at = ? WHERE status = 'ACTIVE'`).bind(now).run();
    }
  }

  return withDebug({
    success: true,
    source: 'rss',
    errors: [],
    status: computeRadarStatus(outputEvents),
    updated_at: now,
    updatedAt: new Date(now).toISOString(),
    summary: outputEvents.length ? "BTC/Krypto-Markt mit erhöhter Event-Aktivität." : "Keine relevanten Markt-Events gefunden.",
    events: outputEvents,
    disclaimer: RADAR_DISCLAIMER
  });
  } catch (error) {
    console.error('❌ market-radar error:', error?.message || error);
    debug.error_message = String(error?.message || error || 'market-radar failed');
    let fallbackEvents = [];
    try {
      const fb = await env.DB.prepare(
        `SELECT * FROM market_events WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT ?`
      ).bind(MARKET_RADAR_MAX_EVENTS).all();
      fallbackEvents = (fb.results || []).map(r => ({ ...r, affected_markets: JSON.parse(r.affected_markets || '[]') }));
    } catch (_) {}
    return withDebug({
      success: true,
      source: 'cache',
      errors: [debug.error_message],
      status: computeRadarStatus(fallbackEvents),
      updated_at: now,
      updatedAt: new Date(now).toISOString(),
      summary: fallbackEvents.length ? 'Krypto-Markt Events (zwischengespeichert).' : 'Radar-Daten aktuell nicht verfügbar.',
      events: fallbackEvents,
      disclaimer: RADAR_DISCLAIMER
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTH FUNCTIONS (D1-backed sessions)
// ═══════════════════════════════════════════════════════════════

const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCKOUT_MS   = 15 * 60 * 1000; // 15 minutes

async function login(env, username, password) {
  const user = await env.DB.prepare(
    `SELECT id, username, email, role, password_hash, must_change_password, skip_password_change, blocked, login_failures, locked_until FROM users WHERE username = ? OR email = ?`
  ).bind(username, username).first();

  // Always run verifyPassword to normalise timing — prevents username enumeration.
  const storedHash = user ? user.password_hash : _DUMMY_HASH;
  const [match, needsUpgrade] = await verifyPassword(password, storedHash);

  // Check brute-force lockout before processing the match result so that
  // (a) a locked account is always rejected, even with a correct password, and
  // (b) we don't extend the lockout counter for attempts against an already-locked account.
  if (user && user.locked_until && user.locked_until > Date.now()) {
    const remainMin = Math.ceil((user.locked_until - Date.now()) / 60000);
    return { success: false, error: `Konto vorübergehend gesperrt. Bitte in ${remainMin} Minute(n) erneut versuchen.` };
  }

  if (!user || !match) {
    if (user) {
      // Increment failure counter and lock account after threshold.
      const failures  = (user.login_failures || 0) + 1;
      const lockedUntil = failures >= LOGIN_MAX_FAILURES ? Date.now() + LOGIN_LOCKOUT_MS : (user.locked_until || 0);
      try {
        await env.DB.prepare(`UPDATE users SET login_failures = ?, locked_until = ?, updated_at = ? WHERE id = ?`)
          .bind(failures, lockedUntil, Date.now(), user.id).run();
      } catch (_) {}
    }
    return { success: false, error: 'Ungültige Zugangsdaten' };
  }
  if (user.blocked) return { success: false, error: 'Konto gesperrt' };

  await ensureTables(env);

  // Transparently upgrade legacy Base64 hash to PBKDF2.
  if (needsUpgrade) {
    try {
      await env.DB.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`)
        .bind(await hashPassword(password), Date.now(), user.id).run();
    } catch (_) {}
  }

  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;

  const mustChange = user.must_change_password === 1 && user.skip_password_change !== 1;

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, username, role, must_change_password, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(sessionId, user.id, user.username, user.role, mustChange ? 1 : 0, now, expiresAt).run();

  try {
    // Reset failure counter on successful login.
    await env.DB.prepare(`UPDATE users SET last_seen = ?, login_failures = 0, locked_until = 0 WHERE id = ?`)
      .bind(now, user.id).run();
  } catch (_) {}

  return {
    success: true,
    session: {
      id: sessionId,
      userId: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: mustChange
    },
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      mustChangePassword: mustChange
    }
  };
}

async function changePassword(env, userId, newPassword) {
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`
  ).bind(await hashPassword(newPassword), Date.now(), userId).run();
  try {
    await env.DB.prepare(`UPDATE sessions SET must_change_password = 0 WHERE user_id = ?`).bind(userId).run();
  } catch (_) {}
  return { success: true };
}

// Accepts a session ID from: (1) HttpOnly cookie, (2) X-Session-ID header.
// Call as validateSession(env, request) to enable cookie support.
async function validateSession(env, requestOrId) {
  let sessionId;
  if (requestOrId && typeof requestOrId === 'object' && requestOrId.headers) {
    sessionId = getSessionCookie(requestOrId.headers.get('Cookie'))
             || requestOrId.headers.get('X-Session-ID');
  } else {
    sessionId = requestOrId;
  }
  if (!sessionId) return null;
  try {
    // Join users to get blocked status so blocked accounts are rejected here
    // (see `if (session.blocked) return null` below) — no valid session, no access.
    const session = await env.DB.prepare(
      `SELECT s.id, s.user_id, s.username, s.role, s.must_change_password, s.expires_at, s.created_at, u.blocked
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`
    ).bind(sessionId, Date.now()).first();

    if (!session) return null;

    // Reject sessions belonging to blocked users even if the session is still valid.
    if (session.blocked) return null;

    try {
      await env.DB.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`)
        .bind(Date.now(), session.user_id).run();
    } catch (_) {}

    return {
      id: session.id,
      userId: session.user_id,
      username: session.username,
      role: session.role,
      mustChangePassword: session.must_change_password === 1,
      createdAt: session.created_at,
      blocked: false,
    };
  } catch (_) {
    return null;
  }
}

function isAdmin(session) { return session?.role === 'admin'; }
function isTraderOrAdmin(session) { return session?.role === 'admin' || session?.role === 'trader'; }

async function logout(env, sessionId) {
  try {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
  } catch (_) {}
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// DATA FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function getStats(env) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='signals'`
    ).first();
    if (!tableCheck) return { total: 0, wins: 0, losses: 0, open: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0, expectancy: 0 };

    const total    = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals`).first();
    const wins     = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'WIN'`).first();
    const losses   = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'LOSS'`).first();
    const open     = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'OPEN'`).first();
    const skipped  = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'SKIPPED'`).first();
    const rejected = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'REJECTED'`).first();
    const avgWin   = await env.DB.prepare(`SELECT AVG(pnl_pct) as a FROM signals WHERE outcome = 'WIN'`).first();
    const avgLoss  = await env.DB.prepare(`SELECT AVG(pnl_pct) as a FROM signals WHERE outcome = 'LOSS'`).first();

    const winRate    = computeWinRate(wins.count, losses.count);
    const avgWinPct  = parseFloat((avgWin.a || 0).toFixed(2));
    const avgLossPct = parseFloat((avgLoss.a || 0).toFixed(2));
    const expectancy = computeExpectancy(wins.count, losses.count, avgWinPct, avgLossPct);

    return {
      total: total.count || 0,
      wins: wins.count || 0,
      losses: losses.count || 0,
      open: open.count || 0,
      skipped: skipped.count || 0,
      rejected: rejected.count || 0,
      winRate,
      avgWinPct,
      avgLossPct,
      expectancy
    };
  } catch (error) {
    console.error('Error in getStats:', error);
    // `error` wird NUR im Fehlerfall gesetzt (Happy-Path-Rückgabe unverändert) —
    // erlaubt Aufrufern wie sendDailySummary, einen DB-Ausfall zu erkennen,
    // ohne dass die bestehenden Dashboard-Aufrufer das Feld beachten müssen.
    return { total: 0, wins: 0, losses: 0, open: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0, expectancy: 0, error: error.message };
  }
}

// Per-signal_class breakdown (NORMAL/STRONG/REVERSAL/...). Groups by whatever
// values are present so future classes (e.g. REVERSAL from Pine v3.7) show up
// automatically without code changes here.
async function getStatsBySignalClass(env) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='signals'`
    ).first();
    if (!tableCheck) return [];

    const rows = await env.DB.prepare(`
      SELECT
        COALESCE(signal_class, 'UNKNOWN') as signal_class,
        COUNT(*) as total,
        SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
        AVG(CASE WHEN outcome='WIN' THEN pnl_pct ELSE NULL END) as avgWinPct,
        AVG(CASE WHEN outcome='LOSS' THEN pnl_pct ELSE NULL END) as avgLossPct
      FROM signals
      GROUP BY COALESCE(signal_class, 'UNKNOWN')
      ORDER BY total DESC
    `).all();

    return (rows.results || []).map(r => {
      const avgWinPct  = parseFloat((r.avgWinPct || 0).toFixed(2));
      const avgLossPct = parseFloat((r.avgLossPct || 0).toFixed(2));
      return {
        signal_class: r.signal_class,
        total: r.total || 0,
        wins: r.wins || 0,
        losses: r.losses || 0,
        winRate: computeWinRate(r.wins, r.losses),
        avgWinPct,
        avgLossPct,
        expectancy: computeExpectancy(r.wins, r.losses, avgWinPct, avgLossPct)
      };
    });
  } catch (error) {
    console.error('Error in getStatsBySignalClass:', error);
    return [];
  }
}

async function getHistory(env, limit = 50) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='signals'`
    ).first();
    if (!tableCheck) return [];

    const rows = await env.DB.prepare(
      `SELECT * FROM signals ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();
    return (rows.results || []).map(withStrategyDisplay);
  } catch (error) {
    console.error('Error in getHistory:', error);
    return [];
  }
}

// Reichert eine signals-Zeile um `strategy_display` an (z.B. "Krypto-2 (S&R+VP)")
// — Single Source of Truth bleibt STRATEGIES/strategyDisplayLabel, damit das
// Dashboard nicht seine eigene Kopie der Strategie-Labels pflegen muss.
function withStrategyDisplay(row) {
  if (!row) return row;
  return { ...row, strategy_display: strategyDisplayLabel(row.strategy_key) };
}

async function getSnapshot(env, symbol, timeframe = '5m') {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'`
    ).first();
    if (!tableCheck) return null;

    const row = await env.DB.prepare(`
      SELECT * FROM snapshots WHERE symbol = ? AND timeframe = ?
      ORDER BY created_at DESC LIMIT 1
    `).bind(symbol, timeframe).first();
    return row;
  } catch (error) {
    console.error('Error in getSnapshot:', error);
    return null;
  }
}

async function getTodayPnL(env) {
  try {
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const todayTrades = await env.DB.prepare(`
      SELECT ai_entry, exit_price, outcome, direction FROM signals
      WHERE created_at >= ? AND outcome IN ('WIN', 'LOSS')
    `).bind(todayStart).all();

    let pnl = 0;
    (todayTrades.results || []).forEach(trade => {
      if (!trade.exit_price || !trade.ai_entry) return;
      const diff = trade.exit_price - trade.ai_entry;
      pnl += trade.direction === 'LONG' ? diff : -diff;
    });
    return pnl;
  } catch (error) {
    console.error('Error in getTodayPnL:', error);
    return 0;
  }
}

async function getTotalPnL(env) {
  try {
    const trades = await env.DB.prepare(`
      SELECT ai_entry, exit_price, outcome, direction FROM signals
      WHERE outcome IN ('WIN', 'LOSS') AND exit_price IS NOT NULL AND ai_entry IS NOT NULL
    `).all();
    let pnl = 0;
    (trades.results || []).forEach(trade => {
      const diff = trade.exit_price - trade.ai_entry;
      pnl += trade.direction === 'LONG' ? diff : -diff;
    });
    return pnl;
  } catch (_) { return 0; }
}

async function getEquityHistory(env) {
  try {
    const startCap = await getStartingCapital(env);
    const trades = await env.DB.prepare(`
      SELECT ai_entry, exit_price, direction, created_at FROM signals
      WHERE outcome IN ('WIN', 'LOSS') AND exit_price IS NOT NULL AND ai_entry IS NOT NULL
      ORDER BY created_at ASC LIMIT 200
    `).all();
    let equity = startCap;
    const points = [{ equity: startCap }];
    for (const t of (trades.results || [])) {
      const diff = t.exit_price - t.ai_entry;
      equity += t.direction === 'LONG' ? diff : -diff;
      points.push({ date: t.created_at, equity: parseFloat(equity.toFixed(2)) });
    }
    return points;
  } catch (_) { return []; }
}

async function getBestSignal(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM signals WHERE outcome = 'OPEN' ORDER BY ai_score DESC LIMIT 1`
    ).first();
    return withStrategyDisplay(row);
  } catch (error) {
    console.error('Error in getBestSignal:', error);
    return null;
  }
}

async function getMarketBias(env) {
  try {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
    const bias = [];

    for (const symbol of symbols) {
      const snap = await getSnapshot(env, symbol, '5m');
      if (snap) {
        let trend = 'neutral', change = 0;
        if (snap.ema50 && snap.ema200) {
          if (snap.price > snap.ema200 && snap.ema50 > snap.ema200) {
            trend = 'bullish';
            change = ((snap.price - snap.ema200) / snap.ema200) * 100;
          } else if (snap.price < snap.ema200 && snap.ema50 < snap.ema200) {
            trend = 'bearish';
            change = ((snap.price - snap.ema200) / snap.ema200) * 100;
          }
        }
        bias.push({ symbol, price: snap.price, trend, change: parseFloat(change.toFixed(2)), rsi: snap.rsi });
      }
    }
    return bias;
  } catch (error) {
    console.error('Error in getMarketBias:', error);
    return [];
  }
}

async function saveChecklist(env, data, username) {
  const { date, type, checklistData, id: customId } = data;
  const id = customId || `${date}_${type}_${username}_${Date.now()}`;
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO checklists (id, date, user, type, data, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).bind(id, date, username, type, JSON.stringify(checklistData), now, now).run();

  return { success: true, id };
}

async function getChecklist(env, date, username) {
  const rows = await env.DB.prepare(`
    SELECT * FROM checklists WHERE date = ? AND user = ? ORDER BY created_at DESC
  `).bind(date, username).all();
  return rows.results || [];
}

async function getUsers(env) {
  try {
    const users = await env.DB.prepare(`
      SELECT id, username, email, role, must_change_password, blocked, last_seen, created_at, updated_at
      FROM users ORDER BY created_at DESC
    `).all();
    return users.results || [];
  } catch (_) {
    const users = await env.DB.prepare(`
      SELECT id, username, email, role, must_change_password, created_at, updated_at
      FROM users ORDER BY created_at DESC
    `).all();
    return users.results || [];
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTO-EVALUATION (cron)
// ═══════════════════════════════════════════════════════════════

// ── Per-Signal-Exit (zentrale Stelle für TP1/Breakeven/TP2 auf `signals`) ──
// Nutzt die per-Strategie Exit-Config (TP1/TP2/SL-% pro Strategie). Wird vom
// per-Tick-Pfad (checkOpenSignalsForSymbol) UND vom Cron (evaluateOpenTrades)
// aufgerufen → einziger Live-Pfad, keine practice_trades-Divergenz mehr.
async function applySignalExit(env, signal, price) {
  if (!price || !Number.isFinite(price)) return { status: 'no_price' };
  const isLong = signal.direction === 'LONG';
  if (!isLong && signal.direction !== 'SHORT') return { status: 'skip' };

  // Per-Strategie Exit-Config (Legacy/ohne strategy_key → crypto_baseline).
  const cfg       = exitConfigForStrategy(signal.strategy_key || resolveStrategyKey(signal));
  const entry     = signal.ai_entry || price;
  const tp2       = signal.ai_tp;                                                      // finales Ziel
  const slOrig    = signal.ai_sl;                                                      // Original-SL
  const tp1       = Number.isFinite(signal.ai_tp1)     ? signal.ai_tp1     : deriveTp1(entry, tp2, cfg);
  const currentSl = Number.isFinite(signal.sl_current) ? signal.sl_current : slOrig;
  const tp1Hit    = signal.tp1_hit === 1;

  const decision = evaluateExit({ isLong, entry, tp2, sl: slOrig, tp1, currentSl, tp1Hit }, price, cfg);

  if (decision.action === 'TP1_PARTIAL') {
    const applied = await applyTp1Partial(env, {
      signalId: signal.id,
      newSl: decision.newSl,
      realizedPct: parseFloat(decision.realizedPct.toFixed(2)),
    });
    if (applied.appliedSignal || applied.appliedPracticeTrade) {
      await notifyTp1(env, {
        symbol: signal.symbol, direction: signal.direction,
        entry, tp1: decision.tp1Price, newSl: decision.newSl, realizedPct: decision.realizedPct,
      });
    }
    return { status: 'tp1', signalId: signal.id };
  }

  if (decision.action === 'TP2_FINAL' || decision.action === 'SL_FINAL') {
    const exitPrice = decision.exitPrice;
    const pnlPct    = decision.finalPct;
    const duration  = formatDuration(Date.now() - (signal.created_at || Date.now()));

    const exitReason = decision.action === 'TP2_FINAL'
      ? 'TP2'
      : (tp1Hit ? 'SL_after_TP1' : 'SL_before_TP1');
    const closeResult = await closeTrade(env, {
      signalId: signal.id,
      outcome: decision.outcome,
      exitPrice,
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      outcomeSource: 'auto',
      telegramOutcomeSent: 1,
      exitReason,
    });

    // Skip the notification if a concurrent path already closed this signal first.
    if (closeResult.closedSignal) {
      const viaTp2    = decision.action === 'TP2_FINAL';
      const isWin     = decision.outcome === 'WIN';
      const hitEmoji  = isWin ? '🎯' : '🛑';
      const hitLabel  = viaTp2 ? 'TP2 HIT' : (isWin ? 'BREAKEVEN+ (SL nach TP1)' : 'SL HIT');
      const pnlSign   = pnlPct >= 0 ? '+' : '';

      await sendTelegramMessage(env,
        `${hitEmoji} <b>${hitLabel} — ${signal.symbol} ${signal.direction}</b>\n` +
        `Ergebnis: <b>${decision.outcome}</b>\n\n` +
        `Entry: $${Number(entry).toFixed(2)} · Exit: $${Number(exitPrice).toFixed(2)}\n` +
        `PnL: <b>${pnlSign}${pnlPct.toFixed(2)}%</b> · Dauer: ${duration}`
      );
      console.log(`📊 Signal ${signal.id} closed: ${decision.outcome} | PnL: ${pnlPct.toFixed(2)}% | ${decision.action}`);
    }
    return { status: 'closed', outcome: decision.outcome, signalId: signal.id };
  }

  return { status: 'open', signalId: signal.id };
}

// Per-Tick-Evaluator (ersetzt das alte checkPracticeTrades): wertet die OPEN
// `signals` eines Symbols mit dem bereits bekannten Snapshot-Preis aus.
async function checkOpenSignalsForSymbol(env, symbol, currentPrice) {
  try {
    const open = await env.DB.prepare(`
      SELECT * FROM signals
      WHERE outcome = 'OPEN' AND symbol = ? AND ai_tp IS NOT NULL AND ai_sl IS NOT NULL
    `).bind(symbol).all();
    for (const signal of (open.results || [])) {
      try {
        await applySignalExit(env, signal, currentPrice);
      } catch (sigErr) {
        console.error(`❌ checkOpenSignalsForSymbol: Signal ${signal.id} (${signal.symbol}) übersprungen:`, sigErr.message);
      }
    }
  } catch (err) {
    console.error('❌ checkOpenSignalsForSymbol error:', err.message);
  }
}

// Cron-Backstop: alle OPEN `signals` mit Live-Preis re-evaluieren.
async function evaluateOpenTrades(env) {
  try {
    const open = await env.DB.prepare(`
      SELECT * FROM signals WHERE outcome = 'OPEN' AND ai_tp IS NOT NULL AND ai_sl IS NOT NULL
      ORDER BY created_at ASC
    `).all();
    const rows = open.results || [];
    // Fall A: ein einzelner kaputter Trade soll den Lauf NICHT abbrechen →
    // pro Iteration weiter best-effort, Fehler aber sammeln statt verschlucken.
    const failures = [];
    for (const signal of rows) {
      try {
        const price = await getLivePrice(env, signal.symbol);
        if (!price) continue;
        await applySignalExit(env, signal, price);
      } catch (sigErr) {
        console.error(`❌ evaluateOpenTrades: Signal ${signal.id} (${signal.symbol}) übersprungen:`, sigErr.message);
        failures.push(`${signal.symbol || signal.id}: ${sigErr.message}`);
      }
    }
    console.log('✅ evaluateOpenTrades done');
    // Nach der Schleife: falls Einzelfehler auftraten, EINMAL zusammengefasst
    // melden (kein Spam pro Trade). Wird vom scheduled()-Catch zu Telegram.
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${rows.length} offene Trades fehlgeschlagen (z.B. ${failures[0]})`
      );
    }
  } catch (err) {
    // Fall B: bisher wurde hier nur geloggt → der äußere Cron-Catch/Alert blieb
    // unerreichbar. Jetzt loggen UND durchreichen, damit scheduled() alarmiert.
    console.error('evaluateOpenTrades error:', err);
    throw err;
  }
}

async function sendDailySummary(env) {
  try {
    const stats = await getStats(env);
    const history = await getHistory(env, 5);
    const recentList = history.length > 0
      ? history.map(s => `• ${s.symbol} ${s.direction} · Score ${s.ai_score} · ${s.outcome}`).join('\n')
      : 'Keine aktuellen Trades';

    // Bei einem Datenfehler (getStats meldet ihn via `error`) den Report TROTZDEM
    // senden — aber mit explizitem Hinweis, statt still einen leeren Bericht zu
    // verschicken. Der Fehler wird unten zusätzlich nach außen durchgereicht.
    const incomplete = stats.error
      ? `\n\n⚠️ Daten unvollständig: ${stats.error}`
      : '';

    await sendTelegramMessage(env,
      `📊 <b>WAVESCOUT Tagesbericht</b>\n\n` +
      `📈 Statistiken:\n• Total: ${stats.total} Trades\n• Wins: ${stats.wins} | Losses: ${stats.losses} | Offen: ${stats.open}\n• Win-Rate: ${stats.winRate}%\n\n` +
      `🕐 Letzte Signale:\n${recentList}${incomplete}\n\n⏰ ${new Date().toLocaleString('de-DE')}`
    );

    // Report ist raus (mit Hinweis) — Fehler trotzdem durchreichen, damit der
    // scheduled()-Catch zusätzlich alarmiert (kein stiller leerer Report mehr).
    if (stats.error) {
      throw new Error(`Tagesbericht mit unvollständigen Daten: ${stats.error}`);
    }
  } catch (err) {
    // Fall B: bisher nur geloggt → äußerer Cron-Catch/Alert unerreichbar.
    // Jetzt loggen UND durchreichen (sendDailySummary wird nur von scheduled()
    // aufgerufen, daher kein anderer Aufrufer betroffen).
    console.error('sendDailySummary error:', err);
    throw err;
  }
}

async function checkOpenSignals(env, onlySignalId = null) {
  await ensureTables(env);
  const rows = await env.DB.prepare(`
    SELECT * FROM signals
    WHERE (outcome = 'OPEN' OR outcome IS NULL) AND ai_tp IS NOT NULL AND ai_sl IS NOT NULL
    ${onlySignalId ? 'AND id = ?' : ''}
    ORDER BY created_at ASC
  `).bind(...(onlySignalId ? [onlySignalId] : [])).all();

  const checked = [];
  for (const signal of (rows.results || [])) {
    const price = await getLivePrice(env, signal.symbol);
    const item = {
      id: signal.id, symbol: signal.symbol, direction: signal.direction,
      entry: signal.ai_entry, tp: signal.ai_tp, sl: signal.ai_sl, price
    };
    // AUFGABE 2 Fix: gemeinsame TP1→Breakeven→TP2-Logik (applySignalExit/evaluateExit)
    // statt einer alten binären Win/Loss-Bewertung. So schließt der manuelle
    // Admin-Check mit denselben Outcomes wie der automatische Pfad.
    const res = await applySignalExit(env, signal, price);
    if (res.status === 'no_price') {
      item.status = 'no_price'; item.outcome = null;
      item.message = `Kein Preis für ${signal.symbol}`;
    } else if (res.status === 'closed') {
      item.status = 'closed'; item.outcome = res.outcome;
      item.message = `${res.outcome} — Exit-Logik (TP2 / Breakeven / SL) ausgelöst`;
    } else if (res.status === 'tp1') {
      item.status = 'open'; item.outcome = 'OPEN';
      item.message = 'TP1 erreicht — 50% realisiert, SL auf Breakeven nachgezogen';
    } else {
      item.status = 'open'; item.outcome = 'OPEN';
      item.message = 'Weiter offen';
    }
    checked.push(item);
  }
  return checked;
}

// ── HTML-Rendering ausgelagert nach src/render/pages.js (Imports oben). ──

// ═══════════════════════════════════════════════════════════════
// WEBHOOK — gemeinsame Kernlogik für /webhook und die separaten
// Pfade pro Strategie (/webhook/baseline, /webhook/sr-volume, /webhook/forex)
// ═══════════════════════════════════════════════════════════════
//
// `/webhook` liest die Strategie aus dem Payload-Feld `strategy`
// (resolveStrategyKey). Die separaten Pfade sollen sie stattdessen aus der
// URL bekommen: bessere Sichtbarkeit in Cloudflare-Logs (der Pfad zeigt
// sofort, welche Strategie betroffen ist), Strategien einzeln pausierbar
// (TradingView-Alert für einen Pfad deaktivieren, ohne die anderen
// anzufassen) und kein Fehlrouting mehr durch ein falsches/fehlendes
// `strategy`-Feld im Payload möglich.
//
// Auth (X-Webhook-Secret/Body/Query), JSON-Parsing, Event-Type-Routing
// (SNAPSHOT/PRICE_UPDATE/SIGNAL) und Logging sind für ALLE Endpunkte
// identisch — deshalb hier EINE gemeinsame Funktion statt vier Kopien: kein
// eigener Auth-Pfad, kein separates Secret, keine Chance, dass sich die
// Endpunkte durch Copy-Paste-Drift auseinanderentwickeln.
//
// `forcedStrategy` kommt aus der URL (gesetzt vom jeweiligen Routen-Zweig
// unten) und wird NACH dem Secret-Check ins Payload geschrieben — es
// überschreibt ein eventuell vom Sender mitgeschicktes `strategy`-Feld
// explizit, statt sich auf den Payload-Wert zu verlassen. Das ist der
// eigentliche Sicherheitsgewinn der separaten Pfade: die URL entscheidet,
// nicht ein Feld im (potenziell falsch konfigurierten) Payload.
async function handleWebhookRequest(request, env, ctx, url, jsonResponse, forcedStrategy = null) {
  const webhookStart = Date.now();
  // Secret can come from three sources (checked after body parsing):
  //   1. X-Webhook-Secret header  (recommended — never logged)
  //   2. JSON body field "secret"  (acceptable)
  //   3. URL query param "secret"  (deprecated — appears in server logs)
  const urlSecret = url.searchParams.get("secret");
  if (urlSecret) console.warn('⚠️ Webhook: secret in URL is deprecated — use X-Webhook-Secret header instead');

  let rawBody = '';
  let payload = null;

  try {
    rawBody = await request.text();
  } catch (readErr) {
    console.error('❌ Failed to read request body:', readErr.message);
    ctx.waitUntil(logWebhookRequest(env, { receivedAt: webhookStart, status: 'parse_error', errorMsg: 'Failed to read body', responseMs: Date.now() - webhookStart }));
    return jsonResponse({ error: 'Failed to read body' }, 400);
  }

  try {
    payload = JSON.parse(rawBody);
    console.log('📦 Parsed payload:', JSON.stringify(payload).substring(0, 500));
  } catch (parseErr) {
    console.error('❌ JSON parse error:', parseErr.message);
    ctx.waitUntil(logWebhookRequest(env, { receivedAt: webhookStart, status: 'parse_error', rawPayload: rawBody, errorMsg: parseErr.message, responseMs: Date.now() - webhookStart }));
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  // Validate secret now that body is available.
  if (env.WEBHOOK_SECRET) {
    const effectiveSecret = request.headers.get('X-Webhook-Secret')
                         || payload.secret
                         || urlSecret;
    if (effectiveSecret !== env.WEBHOOK_SECRET) {
      console.warn('⛔ Webhook: wrong or missing secret');
      ctx.waitUntil(logWebhookRequest(env, { receivedAt: webhookStart, eventType: payload.event_type, symbol: payload.symbol, rawPayload: rawBody, status: 'auth_fail', errorMsg: 'Wrong or missing secret', responseMs: Date.now() - webhookStart }));
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
  }
  // Remove secret from payload so it is not persisted to the database.
  if (payload.secret !== undefined) delete payload.secret;

  // URL-Strategie gewinnt IMMER über ein vom Sender mitgeschicktes
  // `strategy`-Feld (siehe Kommentar oben).
  if (forcedStrategy) payload.strategy = forcedStrategy;

  const eventType = (payload.event_type || 'SIGNAL').toUpperCase();
  console.log('🎯 event_type:', eventType, '| symbol:', payload.symbol, '| action:', payload.action);

  try {
    if (eventType === 'SNAPSHOT') {
      ctx.waitUntil(
        saveSnapshot(env, payload).catch(err => console.error('❌ SNAPSHOT async save failed:', err?.message || err))
      );
      ctx.waitUntil(logWebhookRequest(env, { receivedAt: webhookStart, eventType, symbol: payload.symbol, rawPayload: JSON.stringify(payload), status: 'ok', responseMs: Date.now() - webhookStart }));
      return jsonResponse({ success: true, type: 'SNAPSHOT', message: 'Snapshot accepted' });
    }

    if (eventType === 'PRICE_UPDATE') {
      ctx.waitUntil(
        handlePriceUpdate(env, payload).catch(err => console.error('❌ PRICE_UPDATE async failed:', err?.message || err))
      );
      // PRICE_UPDATE kommt sehr häufig — nicht loggen, um DB-Rotation nicht zu überlasten
      return jsonResponse({ success: true, type: 'PRICE_UPDATE', message: 'Price update accepted' });
    }

    if (eventType === 'SIGNAL_NEW' || eventType === 'SIGNAL') {
      const direction = normalizeDirection(payload);
      const action    = normalizeAction(payload);
      if (!direction) {
        console.log('⏭️ SIGNAL_NEW skipped — no recognisable direction:', JSON.stringify(payload).substring(0, 300));
        ctx.waitUntil(logWebhookRequest(env, { receivedAt: webhookStart, eventType, symbol: payload.symbol, rawPayload: JSON.stringify(payload), status: 'skipped', errorMsg: 'no_actionable_direction', responseMs: Date.now() - webhookStart }));
        return jsonResponse({ success: true, type: 'SIGNAL_NEW', status: 'skipped', reason: 'no_actionable_direction', direction, action });
      }
      // Sofortige 200-Response — Verarbeitung läuft asynchron weiter.
      // ctx.waitUntil() garantiert, dass der Cloudflare-Isolate erst nach
      // Abschluss von processSignal beendet wird → kein Signal geht verloren.
      // (TradingView-Webhook-Timeout: ~10s; Claude-AI-Call allein kann 8s dauern.)
      const signalTs = Date.now();
      ctx.waitUntil(
        processSignal(env, payload)
          .then(result => console.log(`✅ processSignal done in ${Date.now() - signalTs}ms:`, result?.status || result?.outcome || 'ok'))
          .catch(err   => console.error('❌ processSignal async error:', err?.message || err, err?.stack))
      );
      ctx.waitUntil(logWebhookRequest(env, { receivedAt: webhookStart, eventType, symbol: payload.symbol, rawPayload: JSON.stringify(payload), status: 'ok', responseMs: Date.now() - webhookStart }));
      return jsonResponse({ success: true, type: 'SIGNAL_NEW', status: 'received', symbol: payload.symbol, direction });
    }

    ctx.waitUntil(logWebhookRequest(env, { receivedAt: webhookStart, eventType, symbol: payload.symbol, rawPayload: JSON.stringify(payload), status: 'ok', responseMs: Date.now() - webhookStart }));
    return jsonResponse({ success: true, type: eventType, message: 'Unsupported event_type accepted' });
  } catch (processingErr) {
    const errMsg = processingErr?.message || String(processingErr);
    console.error('❌ Webhook processing error:', errMsg, processingErr?.stack);
    ctx.waitUntil(logWebhookRequest(env, { receivedAt: webhookStart, eventType, symbol: payload?.symbol, rawPayload: JSON.stringify(payload), status: 'error', errorMsg: errMsg, responseMs: Date.now() - webhookStart }));
    return jsonResponse({
      success: false,
      type: eventType,
      error: errMsg,
      message: 'Processing failed — signal NOT saved. Check Worker logs.'
    }, 500);
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN WORKER
// ═══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Per-request CORS headers (M1): uses ALLOWED_ORIGIN env var when set.
    const corsHeaders = buildCorsHeaders(request, env);

    // N1: Security headers added to every response.
    const securityHeaders = {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
    };

    // Shadow the module-level jsonResponse with a request-aware version.
    const jsonResponse = (data, status = 200, extraHeaders = {}) =>
      new Response(JSON.stringify(data), {
        status,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders,
          ...securityHeaders,
          ...extraHeaders,
        },
      });

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...corsHeaders, ...securityHeaders } });
    }

    try {

      // ── HTML PAGES (HTMX MPA) ─────────────────────────────────
      const isHtmx    = request.headers.get('HX-Request') === 'true';
      const htmlHdrs  = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders };
      const redirect  = (loc, status = 302) => new Response(null, { status, headers: { Location: loc } });

      if (request.method === 'GET' && url.pathname === '/styles.css') {
        return new Response(CSS_STYLES, {
          headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }
        });
      }

      if (request.method === 'GET' && url.pathname === '/') {
        return redirect('/dashboard');
      }

      if (request.method === 'GET' && url.pathname === '/login') {
        const s = await validateSession(env, request);
        if (s) return redirect('/dashboard');
        return new Response(_renderLoginPage(), { headers: htmlHdrs });
      }

      if (request.method === 'POST' && url.pathname === '/login') {
        const ct = request.headers.get('Content-Type') || '';
        let uname = '', pw = '';
        if (ct.includes('x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
          const fd = await request.formData();
          uname = String(fd.get('username') || '');
          pw    = String(fd.get('password') || '');
        } else {
          try { const b = await request.json(); uname = b.username; pw = b.password; } catch (_) {}
        }
        const result = await login(env, uname, pw);
        if (!result.success) {
          return new Response(_renderLoginPage(result.error || 'Login fehlgeschlagen'), { headers: htmlHdrs });
        }
        const dest = result.session.mustChangePassword ? '/change-password' : '/dashboard';
        return new Response(null, {
          status: 303,
          headers: { Location: dest, 'Set-Cookie': sessionCookieHeader(result.session.id) }
        });
      }

      if (request.method === 'GET' && url.pathname === '/logout') {
        const _sid = getSessionCookie(request.headers.get('Cookie'));
        if (_sid) await logout(env, _sid).catch(() => {});
        return new Response(null, {
          status: 303,
          headers: { Location: '/login', 'Set-Cookie': clearSessionCookieHeader() }
        });
      }

      if (request.method === 'GET' && url.pathname === '/change-password') {
        return new Response(_renderChangePwPage(), { headers: htmlHdrs });
      }

      if (request.method === 'POST' && url.pathname === '/change-password') {
        const pSess = await validateSession(env, request);
        if (!pSess) return redirect('/login');
        let newPw = '';
        try { const fd = await request.formData(); newPw = String(fd.get('newPassword') || ''); } catch (_) {}
        if (!newPw || newPw.length < 8) {
          return new Response(_renderChangePwPage('Passwort muss mindestens 8 Zeichen haben.'), { headers: htmlHdrs });
        }
        await changePassword(env, pSess.userId, newPw);
        return redirect('/dashboard', 303);
      }

      const PAGE_ROUTES = {
        '/dashboard':   'dashboard',
        '/backtesting': 'backtesting',
        '/journal':     'journal',
        '/news':        'news',
        '/analytics':   'statistiken',
        '/settings':    'einstellungen',
      };
      if (request.method === 'GET' && PAGE_ROUTES[url.pathname]) {
        const pageSess = await validateSession(env, request);
        if (!pageSess) {
          if (isHtmx) return new Response('', { status: 200, headers: { 'HX-Redirect': '/login' } });
          return redirect('/login');
        }
        const activePage = PAGE_ROUTES[url.pathname];
        let content;
        const htmxTarget = request.headers.get('HX-Target') || '';
        if (url.pathname === '/dashboard') {
          const [dStats, dSignals, dBest, dBias, dTodayPnL] = await Promise.all([
            getStats(env), getHistory(env, 10), getBestSignal(env), getMarketBias(env), getTodayPnL(env)
          ]);
          const startingCapital = await getStartingCapital(env);
          const totalPnL = await getTotalPnL(env);
          const equity   = startingCapital + totalPnL;
          content = _renderDashboardContent({
            stats: {
              equity: parseFloat(equity.toFixed(2)), startingCapital,
              totalPnL: parseFloat(totalPnL.toFixed(2)),
              todayPnL: parseFloat((dTodayPnL || 0).toFixed(2)),
              winRate: dStats.winRate, totalTrades: dStats.total,
              wins: dStats.wins, losses: dStats.losses, open: dStats.open
            },
            bestSignal: dBest, latestSignals: dSignals, marketBias: dBias, user: pageSess
          });
        } else if (url.pathname === '/journal') {
          const outcome = url.searchParams.get('outcome') || 'all';
          const [jHistory, jPractice] = await Promise.all([
            getHistory(env, 200), getPracticeTrades(env)
          ]);
          const filtered = outcome === 'all' ? jHistory : jHistory.filter(s => s.outcome === outcome);
          if (isHtmx && htmxTarget === 'journal-table') {
            return new Response(_renderJournalTable(filtered, outcome), { headers: htmlHdrs });
          }
          content = _renderJournalContent({ history: filtered, practiceData: jPractice, outcome });
        } else if (url.pathname === '/news') {
          const filter = url.searchParams.get('filter') || 'all';
          const radarData = await getMarketRadar(env, pageSess);
          const events = radarData.events || [];
          if (isHtmx && htmxTarget === 'news-list') {
            return new Response(_renderNewsList(events, filter), { headers: htmlHdrs });
          }
          content = _renderNewsContent({ events, filter });
        } else if (url.pathname === '/backtesting') {
          const tab = url.searchParams.get('tab') || 'practice';
          const isTrader = pageSess.role === 'admin' || pageSess.role === 'trader';
          let data = {};
          if (tab === 'practice') {
            const [pt, ps] = await Promise.all([getPracticeTrades(env), getPracticeTradeStats(env)]);
            data = { practiceTrades: pt, practiceStats: ps };
          } else if (tab === 'history') {
            const [hist, stats] = await Promise.all([getHistory(env, 500), getStats(env)]);
            data = { history: hist, stats };
          } else if (tab === 'strategy' && isTrader) {
            await ensureTables(env);
            const rows = await env.DB.prepare(`SELECT * FROM strategies ORDER BY is_default DESC, created_at DESC`).all();
            data = { strategies: (rows.results || []).map(s => ({ ...s, config: s.config_json ? JSON.parse(s.config_json) : {} })) };
          } else if (tab === 'compare' && isTrader) {
            const [rows, hist] = await Promise.all([
              env.DB.prepare(`SELECT * FROM strategies ORDER BY is_default DESC, created_at DESC`).all(),
              getHistory(env, 500)
            ]);
            data = { strategies: rows.results || [], history: hist };
          } else if (tab === 'regelanalyse' && isTrader) {
            data = { history: await getHistory(env, 500) };
          } else if (tab === 'loss') {
            data = { history: await getHistory(env, 200) };
          } else if (tab === 'biasstats') {
            const all = await env.DB.prepare(`SELECT outcome, daily_bias, before_morning_routine, counts_for_strategy FROM signals WHERE outcome IN ('WIN','LOSS')`).all();
            const bRows = all.results || [];
            const calc = f => {
              const s = bRows.filter(f);
              const w = s.filter(r => r.outcome === 'WIN').length;
              const l = s.filter(r => r.outcome === 'LOSS').length;
              return { total: s.length, wins: w, losses: l, winRate: computeWinRate(w, l) };
            };
            data = {
              biasData: {
                official:      calc(r => r.counts_for_strategy === 1),
                all:           calc(() => true),
                beforeRoutine: calc(r => r.before_morning_routine === 1),
                noTradeDay:    calc(r => r.daily_bias === 'KEIN_TRADE')
              }
            };
          } else if (tab === 'suggestions') {
            const suggestions = [];
            const [lowScoreLosses, lowScoreWins] = await Promise.all([
              env.DB.prepare(`SELECT COUNT(*) as c FROM signals WHERE outcome='LOSS' AND ai_score < 75`).first(),
              env.DB.prepare(`SELECT COUNT(*) as c FROM signals WHERE outcome='WIN'  AND ai_score < 75`).first()
            ]);
            if ((lowScoreLosses?.c || 0) > (lowScoreWins?.c || 0) && (lowScoreLosses?.c || 0) > 2) {
              suggestions.push({ type: 'score_threshold', priority: 'high', title: 'Min. Score erhöhen', message: `${lowScoreLosses.c} Losses hatten Score < 75. Erwäge min_trade_score auf 80+ zu erhöhen.`, action: 'Schwellenwert anpassen' });
            }
            const symRows = await env.DB.prepare(`
              SELECT symbol,
                SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
                SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
              FROM signals WHERE outcome IN ('WIN','LOSS')
              GROUP BY symbol HAVING (wins+losses) >= 3
              ORDER BY (wins*1.0/(wins+losses)) ASC LIMIT 3`).all();
            for (const sym of (symRows.results || [])) {
              const wr = computeWinRate(sym.wins, sym.losses);
              if (wr < 35) suggestions.push({ type: 'symbol_filter', priority: 'medium', title: `${sym.symbol} performat schlecht`, message: `${sym.symbol}: ${wr.toFixed(0)}% Win-Rate bei ${sym.wins + sym.losses} Trades`, action: 'Symbol-Filter prüfen' });
            }
            const lrRows = await env.DB.prepare(`SELECT reason, COUNT(*) as cnt FROM signal_loss_reasons GROUP BY reason ORDER BY cnt DESC LIMIT 5`).all();
            for (const r of (lrRows.results || [])) {
              suggestions.push({ type: 'rule_weight', priority: 'low', title: `Häufiger Loss-Grund: ${r.reason}`, message: `"${r.reason}" wurde ${r.cnt}× als Verlustgrund markiert`, action: 'Regel-Gewicht anpassen' });
            }
            if (suggestions.length === 0) suggestions.push({ type: 'info', priority: 'low', title: 'Zu wenig Daten', message: 'Für aussagekräftige Vorschläge werden mehr abgeschlossene Trades benötigt.', action: null });
            data = { suggestions };
          }
          if (isHtmx && htmxTarget === 'bt-section') {
            return new Response(
              `${_renderBTTabBar(tab, isTrader)}<div id="backtest-content">${_getBTTabContent(tab, data)}</div>`,
              { headers: htmlHdrs }
            );
          }
          content = _renderBacktestContent(tab, data, pageSess);
        } else if (url.pathname === '/analytics') {
          const [aStats, aHistory, aBreakdown] = await Promise.all([
            getStats(env),
            getHistory(env, 200),
            (async () => {
              try {
                const [tfR, dirR, symR] = await Promise.all([
                  env.DB.prepare(`SELECT timeframe, COUNT(*) as total, SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses FROM signals GROUP BY timeframe ORDER BY total DESC`).all(),
                  env.DB.prepare(`SELECT direction, COUNT(*) as total, SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses FROM signals WHERE direction IN ('LONG','SHORT') GROUP BY direction`).all(),
                  env.DB.prepare(`SELECT symbol, COUNT(*) as total, SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses FROM signals GROUP BY symbol ORDER BY total DESC LIMIT 10`).all()
                ]);
                const cwr = r => computeWinRate(r.wins, r.losses);
                const signalClasses = await getStatsBySignalClass(env);
                return {
                  timeframes: (tfR.results || []).map(r => ({ ...r, winRate: cwr(r) })),
                  directions: (dirR.results || []).map(r => ({ ...r, winRate: cwr(r) })),
                  symbols:    (symR.results || []).map(r => ({ ...r, winRate: cwr(r) })),
                  signalClasses
                };
              } catch (_) { return { timeframes: [], directions: [], symbols: [], signalClasses: [] }; }
            })()
          ]);
          const closedTrades = aHistory.filter(t => t.outcome !== 'OPEN' && t.updated_at);
          const avgHoldTimeMs = closedTrades.length > 0
            ? closedTrades.reduce((s, t) => s + (t.updated_at - t.created_at), 0) / closedTrades.length
            : 0;
          const aAnalytics = { avgHoldTimeMs, totalSignals: aStats.total };
          content = _renderStatistikenContent({ stats: aStats, history: aHistory, analytics: aAnalytics, breakdown: aBreakdown });
        } else if (url.pathname === '/settings') {
          const section = url.searchParams.get('section') || 'account';
          const isAdminUser = pageSess.role === 'admin';
          let sData = {};
          if (section === 'admin' && isAdminUser) {
            const [uRows, sRows] = await Promise.all([
              env.DB.prepare(`SELECT id, username, email, role, blocked, last_seen, created_at FROM users ORDER BY created_at DESC`).all(),
              env.DB.prepare(`SELECT s.id, s.created_at, s.expires_at, u.username, u.role FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.expires_at > ? ORDER BY s.created_at DESC`).bind(Date.now()).all()
            ]);
            let dbOk = false;
            try { await env.DB.prepare('SELECT 1').first(); dbOk = true; } catch (_) {}
            const tbls = ['signals', 'snapshots', 'practice_trades', 'users', 'sessions'];
            const tblCounts = {};
            for (const t of tbls) {
              try { const r = await env.DB.prepare(`SELECT COUNT(*) as c FROM ${t}`).first(); tblCounts[t] = r?.c ?? 0; }
              catch (_) { tblCounts[t] = null; }
            }
            sData = {
              users: uRows.results || [],
              sessions: sRows.results || [],
              systemStatus: {
                db: dbOk,
                telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
                ntfy: !!env.NTFY_TOPIC,
                anthropic: !!env.ANTHROPIC_API_KEY,
                webhook: !!env.WEBHOOK_SECRET,
                tables: tblCounts,
                version: '3.5.0'
              }
            };
          }
          if (isHtmx && htmxTarget === 'settings-section') {
            const sNav = _renderSettingsNav(section, isAdminUser);
            const sContent = _renderSettingsSection(section, sData, pageSess);
            return new Response(`${sNav}<div id="settings-content">${sContent}</div>`, { headers: htmlHdrs });
          }
          content = _renderSettingsPage(section, sData, pageSess);
        } else {
          content = _renderPlaceholderPage(activePage);
        }
        const html = isHtmx
          ? content
          : _htmlPage({ title: activePage.charAt(0).toUpperCase() + activePage.slice(1), content, activePage, user: pageSess });
        return new Response(html, { headers: htmlHdrs });
      }

      // ── AUTH ────────────────────────────────────────────────

      if (request.method === "POST" && url.pathname === "/auth/login") {
        const { username, password } = await request.json();
        const result = await login(env, username, password);
        if (!result.success) return jsonResponse(result, 401);
        // Set HttpOnly cookie so the session ID is never accessible to JS.
        return jsonResponse(result, 200, {
          'Set-Cookie': sessionCookieHeader(result.session.id),
        });
      }

      if (request.method === "POST" && url.pathname === "/auth/logout") {
        const sessionId = getSessionCookie(request.headers.get('Cookie'))
                       || request.headers.get("X-Session-ID");
        await logout(env, sessionId);
        return jsonResponse({ success: true }, 200, {
          'Set-Cookie': clearSessionCookieHeader(),
        });
      }

      if (request.method === "GET" && url.pathname === "/auth/me") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse({ success: true, session, user: {
          id: session.userId, username: session.username,
          role: session.role, mustChangePassword: session.mustChangePassword,
          sessionId: session.id,
        }});
      }

      if (request.method === "POST" && url.pathname === "/auth/change-password") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const { newPassword } = await request.json();
        return jsonResponse(await changePassword(env, session.userId, newPassword));
      }

      // ── DASHBOARD LIVE DATA ─────────────────────────────────

      if (request.method === "GET" && url.pathname === "/dashboard/live") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const [stats, latestSignals, bestSignal, marketBias, todayPnL, equityHistory] = await Promise.all([
          getStats(env), getHistory(env, 10), getBestSignal(env), getMarketBias(env), getTodayPnL(env), getEquityHistory(env)
        ]);

        const startingCapital = await getStartingCapital(env);
        const totalPnL = await getTotalPnL(env);
        const equity = startingCapital + totalPnL;

        return jsonResponse({
          stats: {
            equity: parseFloat(equity.toFixed(2)),
            startingCapital,
            totalPnL: parseFloat(totalPnL.toFixed(2)),
            todayPnL: parseFloat(todayPnL.toFixed(2)),
            winRate: stats.winRate,
            totalTrades: stats.total,
            wins: stats.wins,
            losses: stats.losses,
            open: stats.open,
            skipped: stats.skipped || 0,
            rejected: stats.rejected || 0,
          },
          bestSignal: bestSignal || null,
          latestSignals,
          marketBias,
          equityHistory,
          user: { username: session.username, role: session.role }
        });
      }

      if (request.method === "GET" && url.pathname === "/market-radar") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getMarketRadar(env, session));
      }

      // ── DATA ─────────────────────────────────────────────────

      // Score-Regeln pro Strategie fürs Dashboard (Tooltip/Info-Panel): welche
      // Gewichte fließen aktuell in den Kandidaten-Score ein? Berücksichtigt
      // aktive settings-Overrides (candidate_scoring_overrides), damit das
      // Dashboard nie von den echten, live-wirksamen Gewichten abweicht.
      if (request.method === "GET" && url.pathname === "/scoring-rules") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const rules = {};
        for (const [key, defaults] of Object.entries(CANDIDATE_SCORING_DEFAULTS)) {
          const override = await loadCandidateScoringConfig(env, key);
          const weights   = override ? { ...defaults.weights, ...override } : defaults.weights;
          const threshold = override?._threshold ?? defaults.threshold;
          const stratDef  = STRATEGIES[key] || {};
          rules[key] = {
            key,
            label:        stratDef.label   || key,
            display:      stratDef.display || key,
            useScoreGate: !!stratDef.useScoreGate,
            minScore:     stratDef.minScore ?? null,
            base:         defaults.base,
            threshold,
            weights,
          };
        }
        return jsonResponse({ rules });
      }

      if (request.method === "GET" && url.pathname === "/stats") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getStats(env));
      }

      if (request.method === "GET" && url.pathname === "/history") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));
        return jsonResponse(await getHistory(env, limit));
      }

      if (request.method === "GET" && url.pathname === "/notifications") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "30"));
          const rows = await env.DB.prepare(
            `SELECT id, symbol, direction, timeframe, price, ai_score, ai_entry, ai_tp, ai_sl,
                    ai_reason, signal_quality, risk_reward, vp_zone, vp_score, created_at, dashboard_seen
             FROM signals
             WHERE ai_score >= 70 AND outcome NOT IN ('SKIPPED', 'REJECTED')
             ORDER BY created_at DESC LIMIT ?`
          ).bind(limit).all();
          const list   = rows.results || [];
          const unseen = list.filter(r => !r.dashboard_seen).length;
          return jsonResponse({ notifications: list, unseen });
        } catch (e) {
          return jsonResponse({ notifications: [], unseen: 0 });
        }
      }

      if (request.method === "POST" && url.pathname.startsWith("/notifications/") && url.pathname.endsWith("/seen")) {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const id = url.pathname.slice("/notifications/".length, -"/seen".length);
        try { await env.DB.prepare(`UPDATE signals SET dashboard_seen = 1 WHERE id = ?`).bind(id).run(); } catch (_) {}
        return jsonResponse({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/notifications/seen-all") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try { await env.DB.prepare(`UPDATE signals SET dashboard_seen = 1 WHERE ai_score >= 70 AND dashboard_seen = 0`).run(); } catch (_) {}
        return jsonResponse({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/analytics") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const stats = await getStats(env);
        const history = await getHistory(env, 200);
        const closedTrades = history.filter(t => t.outcome !== 'OPEN' && t.updated_at);
        const avgHoldTime = closedTrades.length > 0
          ? closedTrades.reduce((sum, t) => sum + (t.updated_at - t.created_at), 0) / closedTrades.length
          : 0;
        return jsonResponse({ ...stats, avgHoldTimeMs: avgHoldTime, totalSignals: stats.total });
      }

      if (request.method === "GET" && url.pathname === "/stats/breakdown") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        try {
          const tableCheck = await env.DB.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='signals'`
          ).first();
          if (!tableCheck) return jsonResponse({ timeframes: [], directions: [] });

          const tfRows = await env.DB.prepare(`
            SELECT timeframe,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
              AVG(CASE WHEN outcome='WIN' THEN pnl_pct ELSE NULL END) as avgWinPct,
              AVG(CASE WHEN outcome='LOSS' THEN pnl_pct ELSE NULL END) as avgLossPct
            FROM signals GROUP BY timeframe ORDER BY total DESC
          `).all();

          const dirRows = await env.DB.prepare(`
            SELECT direction,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
              AVG(CASE WHEN outcome='WIN' THEN pnl_pct ELSE NULL END) as avgWinPct,
              AVG(CASE WHEN outcome='LOSS' THEN pnl_pct ELSE NULL END) as avgLossPct
            FROM signals WHERE direction IN ('LONG','SHORT')
            GROUP BY direction
          `).all();

          const symbolRows = await env.DB.prepare(`
            SELECT symbol,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
              AVG(CASE WHEN outcome='WIN' THEN pnl_pct ELSE NULL END) as avgWinPct,
              AVG(CASE WHEN outcome='LOSS' THEN pnl_pct ELSE NULL END) as avgLossPct
            FROM signals GROUP BY symbol ORDER BY total DESC LIMIT 10
          `).all();

          const calcWR = r => computeWinRate(r.wins, r.losses);
          const calcExp = r => computeExpectancy(r.wins, r.losses, r.avgWinPct, r.avgLossPct);
          const signalClasses = await getStatsBySignalClass(env);

          return jsonResponse({
            timeframes: (tfRows.results || []).map(r => ({ ...r, winRate: calcWR(r), expectancy: calcExp(r) })),
            directions: (dirRows.results || []).map(r => ({ ...r, winRate: calcWR(r), expectancy: calcExp(r) })),
            symbols:    (symbolRows.results || []).map(r => ({ ...r, winRate: calcWR(r), expectancy: calcExp(r) })),
            signalClasses
          });
        } catch (e) {
          return jsonResponse({ timeframes: [], directions: [], symbols: [], signalClasses: [] });
        }
      }

      // ── SIGNALS PATCH ────────────────────────────────────────

      if (request.method === "PATCH" && url.pathname.startsWith("/signals/") && !url.pathname.includes("/loss-reason")) {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const signalId = url.pathname.replace("/signals/", "");
        const body = await request.json();
        const { outcome, exitPrice, adminNote, manualReason, closedAt, outcomeSource } = body;

        const allowed = ['WIN', 'LOSS', 'BE', 'OPEN', 'SKIPPED', 'IGNORED'];
        if (outcome && !allowed.includes(outcome)) return jsonResponse({ error: "Ungültiges outcome" }, 400);

        // For pnl_pct calc, fetch existing signal
        let pnlPct = undefined;
        const ep = exitPrice !== undefined ? parseFloat(exitPrice) : null;
        if (ep !== null) {
          try {
            const sig = await env.DB.prepare(`SELECT ai_entry, direction FROM signals WHERE id = ?`).bind(signalId).first();
            if (sig?.ai_entry) {
              pnlPct = sig.direction === 'LONG'
                ? ((ep - sig.ai_entry) / sig.ai_entry) * 100
                : ((sig.ai_entry - ep) / sig.ai_entry) * 100;
              pnlPct = parseFloat(pnlPct.toFixed(2));
            }
          } catch (_) {}
        }

        const sets = [], binds = [];
        if (outcome)                 { sets.push("outcome = ?");        binds.push(outcome); }
        if (ep !== null)             { sets.push("exit_price = ?");     binds.push(ep); }
        if (pnlPct !== undefined)    { sets.push("pnl_pct = ?");        binds.push(pnlPct); }
        if (adminNote !== undefined) { sets.push("admin_note = ?");     binds.push(adminNote); }
        if (manualReason !== undefined) { sets.push("manual_reason = ?"); binds.push(manualReason); }
        if (closedAt !== undefined)  { sets.push("closed_at = ?");      binds.push(closedAt); }
        if (outcomeSource !== undefined) { sets.push("outcome_source = ?"); binds.push(outcomeSource); }
        else if (outcome && session.role === 'admin') { sets.push("outcome_source = ?"); binds.push('manual'); }
        sets.push("updated_at = ?"); binds.push(Date.now());
        binds.push(signalId);

        await env.DB.prepare(`UPDATE signals SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
        return jsonResponse({ success: true, pnlPct });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/signals/") && !url.pathname.includes("/loss-reason")) {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.replace("/signals/", "");
        await env.DB.prepare(`DELETE FROM signals WHERE id = ?`).bind(signalId).run();
        await env.DB.prepare(`DELETE FROM signal_loss_reasons WHERE signal_id = ?`).bind(signalId).run();
        return jsonResponse({ success: true });
      }

      // AUFGABE 3: Demo-Trade-Erzeugung (POST /practice-trades/manual) und
      // -Mutation (PATCH /practice-trades/:id) wurden entfernt — es gibt keinen
      // separaten Übungs-/Demo-Pfad mehr. practice_trades ist read-only Archiv;
      // nur die GET-Endpoints unten bleiben (Historie einsehen).

      if (request.method === "GET" && url.pathname === "/practice-trades") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getPracticeTrades(env, {
          symbol:    url.searchParams.get("symbol")    || 'all',
          timeframe: url.searchParams.get("timeframe") || 'all',
          direction: url.searchParams.get("direction") || 'all',
          status:    url.searchParams.get("status")    || 'all',
          limit:     parseInt(url.searchParams.get("limit") || "100")
        }));
      }

      if (request.method === "GET" && url.pathname === "/practice-trades/stats") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getPracticeTradeStats(env));
      }

      if (request.method === "GET" && url.pathname === "/api/stats") {
        const token = request.headers.get("X-Stats-Token");
        if (!env.STATS_TOKEN || token !== env.STATS_TOKEN) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        const stats = await getPracticeTradeStats(env);
        return jsonResponse({ generatedAt: new Date().toISOString(), ...stats });
      }

      // ── CHECKLIST ───────────────────────────────────────────

      if (request.method === "POST" && url.pathname === "/checklist") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        return jsonResponse(await saveChecklist(env, body, session.username));
      }

      if (request.method === "GET" && url.pathname === "/checklist") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        return jsonResponse(await getChecklist(env, date, session.username));
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/checklist/")) {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const entryId = url.pathname.slice("/checklist/".length);
        await env.DB.prepare(`DELETE FROM checklists WHERE id = ? AND user = ?`)
          .bind(entryId, session.username).run();
        return jsonResponse({ success: true });
      }

      // ── ADMIN ───────────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/users") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getUsers(env));
      }

      if (request.method === "POST" && url.pathname === "/admin/create-user") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { username, email, password, role, skipPasswordChange } = await request.json();
        if (!username || !email || !password) return jsonResponse({ error: "Fehlende Felder: username, email, password" }, 400);

        const existing = await env.DB.prepare(`SELECT id FROM users WHERE username = ? OR email = ?`)
          .bind(username, email).first();
        if (existing) return jsonResponse({ error: "Benutzername oder E-Mail bereits vergeben" }, 409);

        const id = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO users (id, username, email, password_hash, role, must_change_password, skip_password_change, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
        `).bind(id, username, email, await hashPassword(password), role || 'user', skipPasswordChange ? 1 : 0, now, now).run();
        return jsonResponse({ success: true, id });
      }

      if (request.method === "POST" && url.pathname === "/admin/block-user") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { userId, blocked } = await request.json();
        await env.DB.prepare(`UPDATE users SET blocked = ?, updated_at = ? WHERE id = ?`)
          .bind(blocked ? 1 : 0, Date.now(), userId).run();
        if (blocked) {
          try { await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run(); } catch (_) {}
        }
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname === "/admin/logout-user") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { userId } = await request.json();
        try { await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run(); } catch (_) {}
        return jsonResponse({ success: true });
      }

      // Terminate a single specific session by ID (used by the admin sessions panel kick button).
      if (request.method === "POST" && url.pathname === "/admin/kick-session") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { sessionId: targetId } = await request.json();
        if (!targetId) return jsonResponse({ error: "sessionId erforderlich" }, 400);
        // Prevent admins from accidentally kicking their own current session via this endpoint.
        if (targetId === session.id) return jsonResponse({ error: "Eigene Session kann nicht via Kick beendet werden" }, 400);
        try { await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(targetId).run(); } catch (_) {}
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname === "/admin/change-password") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { userId, newPassword } = await request.json();
        return jsonResponse(await changePassword(env, userId, newPassword));
      }

      if (request.method === "GET" && url.pathname === "/test-telegram") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const testMessage = `🧪 <b>WAVESCOUT Test</b>\n\nTelegram ist korrekt konfiguriert!\n⏰ ${new Date().toLocaleString('de-DE')}`;
        const success = await sendTelegramMessage(env, testMessage);
        return jsonResponse({ success, message: success ? 'Telegram-Nachricht gesendet!' : 'Fehler beim Senden' });
      }

      if (request.method === "GET" && url.pathname === "/admin/test-ntfy") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        if (!env.NTFY_TOPIC) return jsonResponse({ success: false, message: 'NTFY_TOPIC nicht konfiguriert' });
        const success = await sendNtfyAlert(env, 'BTCUSDT', '15', 97);
        return jsonResponse({ success, message: success ? 'ntfy-Nachricht gesendet!' : 'Fehler beim Senden' });
      }

      if (request.method === "POST" && url.pathname === "/admin/test-push") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        await sendWebPushToAll(env, 'WAVESCOUT Test', 'Push-Benachrichtigungen funktionieren ✓', '/');
        return jsonResponse({ success: true, message: 'Test-Push gesendet!' });
      }

      // Web Push subscription management
      if (request.method === "POST" && url.pathname === "/push/subscribe") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json().catch(() => null);
        if (!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth)
          return jsonResponse({ error: "Invalid subscription" }, 400);
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS push_subscriptions (
            id TEXT PRIMARY KEY, user_id TEXT, endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER
          )
        `).run();
        const id = `ps_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        // Delete existing subscription for this endpoint first (handles re-subscribe after key rotation)
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
        await env.DB.prepare(`
          INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(id, session.userId || session.id || '', body.endpoint, body.keys.p256dh, body.keys.auth, Date.now()).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "DELETE" && url.pathname === "/push/subscribe") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json().catch(() => null);
        if (body?.endpoint) {
          await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(body.endpoint).run();
        }
        return jsonResponse({ success: true });
      }

      if (request.method === "GET" && url.pathname === "/push/vapid-public-key") {
        return jsonResponse({ key: env.VAPID_PUBLIC_KEY || null });
      }

      // Test signal — sends through real notification pipeline without DB entry
      if (request.method === "POST" && url.pathname === "/admin/test-signal") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json().catch(() => ({}));
        const score     = Math.max(1, Math.min(100, parseInt(body.score) || 97));
        const symbol    = ((body.symbol || 'BTCUSDT') + '').toUpperCase();
        const direction = ((body.direction || 'LONG') + '').toUpperCase();
        const out = { score, symbol, direction, telegram: false, ntfy: false, errors: [] };
        if (score >= 80) {
          const arrow = direction === 'LONG' ? '📈' : '📉';
          const msg = `🧪 <b>TEST-SIGNAL (Admin)</b>\n\n${arrow} <b>${symbol}</b> ${direction}\nScore: <b>${score}/100</b>\n\n<i>Manuell aus dem Admin-Panel gesendet.</i>`;
          try { out.telegram = await sendTelegramMessage(env, msg); }
          catch (e) { out.errors.push('Telegram: ' + e.message); }
        }
        if (score >= 95) {
          if (!env.NTFY_TOPIC) {
            out.errors.push('NTFY_TOPIC nicht konfiguriert');
          } else {
            try {
              const ntfyRes = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
                method: 'POST',
                headers: {
                  'Title': `🧪 TEST ${score}/100`,
                  'Priority': 'default',
                  'Tags': 'test_tube,chart_with_upwards_trend',
                  'Content-Type': 'text/plain',
                },
                body: `TEST: ${symbol} ${direction} | Score: ${score}`,
              });
              out.ntfy = ntfyRes.ok;
              if (!ntfyRes.ok) out.errors.push(`ntfy: HTTP ${ntfyRes.status}`);
            } catch (e) { out.errors.push('ntfy: ' + e.message); }
          }
        }
        return jsonResponse({ success: true, ...out });
      }

      // Send custom Telegram message
      if (request.method === "POST" && url.pathname === "/admin/telegram/send") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { message } = await request.json();
        if (!message?.trim()) return jsonResponse({ error: 'message erforderlich' }, 400);
        const success = await sendTelegramMessage(env, message.trim());
        return jsonResponse({ success, message: success ? 'Gesendet!' : 'Fehler beim Senden' });
      }

      // System status overview
      if (request.method === "GET" && url.pathname === "/admin/status") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        let dbOk = false;
        try { await env.DB.prepare('SELECT 1').first(); dbOk = true; } catch (_) {}

        const tables = ['signals', 'snapshots', 'practice_trades', 'users', 'sessions', 'checklists'];
        const tableCounts = {};
        for (const t of tables) {
          try {
            const r = await env.DB.prepare(`SELECT COUNT(*) as c FROM ${t}`).first();
            tableCounts[t] = r?.c ?? 0;
          } catch (_) { tableCounts[t] = null; }
        }

        return jsonResponse({
          db: dbOk,
          telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
          ntfy: !!env.NTFY_TOPIC,
          anthropic: !!env.ANTHROPIC_API_KEY,
          webhook: !!env.WEBHOOK_SECRET,
          tables: tableCounts,
          version: '3.4.0',
          time: new Date().toISOString()
        });
      }

      // Test Anthropic AI connection
      if (request.method === "POST" && url.pathname === "/admin/test-ai") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        if (!env.ANTHROPIC_API_KEY) {
          return jsonResponse({ ok: false, error: 'ANTHROPIC_API_KEY ist nicht gesetzt', keySet: false });
        }

        const t0 = Date.now();
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-5',
              max_tokens: 10,
              messages: [{ role: 'user', content: 'ping' }]
            })
          });
          const data = await res.json();
          const ms = Date.now() - t0;

          if (data.content) {
            return jsonResponse({
              ok: true, keySet: true,
              latencyMs: ms,
              model: data.model,
              inputTokens: data.usage?.input_tokens ?? 0,
              outputTokens: data.usage?.output_tokens ?? 0
            });
          }
          return jsonResponse({ ok: false, keySet: true, error: data.error?.message || 'Unbekannter Fehler', latencyMs: ms });
        } catch (e) {
          return jsonResponse({ ok: false, keySet: true, error: e.message, latencyMs: Date.now() - t0 });
        }
      }

      // Webhook tester — inject test SNAPSHOT or SIGNAL (fixed payloads)
      if (request.method === "POST" && url.pathname === "/admin/test-webhook") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const body = await request.json();
        const type = body.type;
        try {
          // If a full custom payload is provided (no 'type' field), process it directly.
          if (!type) {
            const event_type = (body.event_type || '').toUpperCase();
            if (event_type === 'SNAPSHOT' || event_type === 'PRICE_UPDATE') {
              const result = await saveSnapshot(env, body);
              return jsonResponse(result);
            } else {
              const result = await processSignal(env, body);
              return jsonResponse({ ok: true, type: event_type || 'SIGNAL', result });
            }
          }
          if (type === 'SNAPSHOT') {
            const result = await saveSnapshot(env, {
              symbol: 'BTCUSDT', event_type: 'SNAPSHOT', timeframe: '5',
              price: 80000, rsi: 55, ema50: 79800, ema200: 78000,
              support: 79000, resistance: 81000,
              trend: 'bullish', trend_1h: 'GREEN', trend_4h: 'GREEN'
            });
            return jsonResponse(result);
          } else {
            const result = await processSignal(env, {
              symbol: 'BTCUSDT', event_type: 'SIGNAL', timeframe: '5',
              price: 80000, direction: 'LONG', trigger: 'ADMIN_TEST',
              rsi: 55, ema50: 79800, ema200: 78000, action: 'BUY'
            });
            return jsonResponse({ ok: true, type: 'SIGNAL', result });
          }
        } catch (e) {
          console.error('❌ /admin/test-webhook failed:', e?.message || e);
          return jsonResponse({ ok: false, error: e.message || 'test-webhook failed' }, 200);
        }
      }

      if (request.method === "POST" && url.pathname === "/admin/check-open-trades") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const results = await checkOpenSignals(env);
          const closed  = results.filter(r => r.status === 'closed').length;
          const open    = results.filter(r => r.status === 'open').length;
          const noprice = results.filter(r => r.status === 'no_price').length;
          return jsonResponse({ success: true, checked: results.length, closed, open, no_price: noprice, skipped: 0, results });
        } catch (e) {
          console.error('❌ /admin/check-open-trades failed:', e?.message || e);
          return jsonResponse({ success: false, error: e.message || 'trade-check failed' }, 200);
        }
      }

      // ── AUFGABE 4: Einstiegskapital zurücksetzen (admin-only, geloggt) ──
      if (request.method === "POST" && url.pathname === "/admin/reset-capital") {
        const session = await validateSession(env, request);
        // Rollen-Guard liegt in resetStartingCapital(); hier nur Body parsen.
        let body = {};
        try { body = await request.json(); } catch (_) {}
        const result = await resetStartingCapital({ env, session, newValue: body.value ?? body.startingCapital });
        if (!result.ok) return jsonResponse({ error: result.error }, result.status);
        return jsonResponse({
          success: true,
          message: `Startkapital zurückgesetzt: ${result.oldValue} → ${result.newValue}`,
          oldValue: result.oldValue,
          newValue: result.newValue,
        });
      }

      if (request.method === "GET" && url.pathname === "/admin/capital-log") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const rows = await env.DB.prepare(`SELECT * FROM capital_reset_log ORDER BY created_at DESC LIMIT 20`).all();
          return jsonResponse({ success: true, entries: rows.results || [] });
        } catch (e) {
          return jsonResponse({ success: false, error: e.message }, 500);
        }
      }

      if (request.method === "GET" && url.pathname === "/admin/webhook-log") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const limit  = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
          const status = url.searchParams.get('status') || null; // filter: ok | error | auth_fail | skipped | parse_error
          const query  = status
            ? `SELECT * FROM webhook_log WHERE status = ? ORDER BY received_at DESC LIMIT ?`
            : `SELECT * FROM webhook_log ORDER BY received_at DESC LIMIT ?`;
          const binds  = status ? [status, limit] : [limit];
          const rows   = await env.DB.prepare(query).bind(...binds).all();
          return jsonResponse({ success: true, entries: rows.results || [], total: (rows.results || []).length });
        } catch (e) {
          return jsonResponse({ success: false, error: e.message }, 500);
        }
      }

      if (request.method === "POST" && url.pathname.startsWith("/admin/check-trade/")) {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.replace("/admin/check-trade/", "");
        if (!signalId) return jsonResponse({ error: "Missing signal ID" }, 400);
        try {
          const results = await checkOpenSignals(env, signalId);
          const r = results[0];
          if (!r) return jsonResponse({ error: "Signal nicht gefunden" }, 404);
          return jsonResponse({ success: true, status: r.status, outcome: r.outcome, direction: r.direction, entry: r.entry, price: r.price, tp: r.tp, sl: r.sl, message: r.message });
        } catch (e) {
          console.error('❌ /admin/check-trade failed:', e?.message || e);
          return jsonResponse({ success: false, error: e.message || 'trade-check failed' }, 200);
        }
      }

      if (request.method === "POST" && url.pathname === "/admin/eod-check") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const results = await checkOpenSignals(env);
          const closed = results.filter(r => r.status === 'closed').length;
          return jsonResponse({ success: true, checked: results.length, closed, results });
        } catch (e) {
          console.error('❌ /admin/eod-check failed:', e?.message || e);
          return jsonResponse({ success: false, error: e.message || 'eod-check failed' }, 200);
        }
      }

      // DB cleanup — remove old snapshots & expired sessions
      if (request.method === "POST" && url.pathname === "/admin/db-cleanup") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const results = [];

        try {
          await env.DB.prepare(`
            DELETE FROM snapshots WHERE id NOT IN (
              SELECT id FROM (
                SELECT id FROM snapshots ORDER BY created_at DESC LIMIT 500
              )
            )
          `).run();
          results.push('✅ Snapshots: auf 500 gekürzt');
        } catch (e) { results.push('❌ Snapshots: ' + e.message); }

        try {
          await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(Date.now()).run();
          results.push('✅ Abgelaufene Sessions gelöscht');
        } catch (e) { results.push('❌ Sessions: ' + e.message); }

        try {
          await env.DB.prepare(`
            DELETE FROM practice_trades WHERE status != 'OPEN' AND closed_at < datetime('now', '-90 days')
          `).run();
          results.push('✅ Alte Practice Trades (>90 Tage) bereinigt');
        } catch (e) { results.push('❌ Practice Trades: ' + e.message); }

        return jsonResponse({ ok: true, results });
      }

      // Active sessions list
      if (request.method === "GET" && url.pathname === "/admin/sessions") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        try {
          const rows = await env.DB.prepare(`
            SELECT id, username, role, created_at, expires_at FROM sessions
            WHERE expires_at > ? ORDER BY created_at DESC
          `).bind(Date.now()).all();
          return jsonResponse(rows.results || []);
        } catch (_) { return jsonResponse([]); }
      }

      if (request.method === "POST" && url.pathname === "/admin/setup-db") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        await ensureTables(env);
        const results = ['All tables: OK'];

        try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0`).run(); results.push('users.blocked: added'); }
        catch (_) { results.push('users.blocked: already exists'); }

        try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN last_seen INTEGER`).run(); results.push('users.last_seen: added'); }
        catch (_) { results.push('users.last_seen: already exists'); }

        // signals extra columns
        const signalCols = [
          ['action',         'TEXT'],
          ['rsi',            'REAL'],
          ['ema50',          'REAL'],
          ['ema200',         'REAL'],
          ['trend',          'TEXT'],
          ['support',        'REAL'],
          ['resistance',     'REAL'],
          ['wave_bias',      'TEXT'],
          ['ai_direction',   'TEXT'],
          ['ai_confidence',  'REAL'],
          ['ai_take_profit', 'REAL'],
          ['ai_stop_loss',   'REAL'],
          ['raw_signal',     'TEXT'],
          ['raw_ai',         'TEXT'],
          ['status',         'TEXT'],
          ['timestamp',      'INTEGER'],
        ];
        for (const [col, type] of signalCols) {
          try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); results.push(`signals.${col}: added`); }
          catch (_) { results.push(`signals.${col}: already exists`); }
        }

        // Strategy + Phase-2 signal columns
        const stratCols = [
          ['strategy_id',           'TEXT'],
          ['strategy_name',         'TEXT'],
          ['strategy_version',      'TEXT'],
          ['is_test',               'INTEGER DEFAULT 0'],
          ['telegram_sent',         'INTEGER DEFAULT 0'],
          ['telegram_reason',       'TEXT'],
          ['source',                'TEXT'],
          ['pnl_pct',               'REAL'],
          ['closed_at',             'INTEGER'],
          ['outcome_source',        'TEXT'],
          ['telegram_outcome_sent', 'INTEGER DEFAULT 0'],
          ['admin_note',            'TEXT'],
          ['manual_reason',         'TEXT'],
        ];
        for (const [col, type] of stratCols) {
          try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); results.push(`signals.${col}: added`); }
          catch (_) { results.push(`signals.${col}: already exists`); }
        }

        // TP1/Breakeven/TP2 partial-exit columns (ersetzt die 3h-Regel)
        const signalTp1Cols = [
          ['ai_tp1',       'REAL'],
          ['tp1_hit',      'INTEGER DEFAULT 0'],
          ['sl_current',   'REAL'],
          ['asset_class',  'TEXT'],   // AUFGABE 1: 'crypto' | 'forex'
          ['strategy_key', 'TEXT'],   // AUFGABE 2: Routing-Strategie
        ];
        for (const [col, type] of signalTp1Cols) {
          try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); results.push(`signals.${col}: added`); }
          catch (_) { results.push(`signals.${col}: already exists`); }
        }
        const practiceTp1Cols = [
          ['tp1_price',    'REAL'],
          ['tp1_hit',      'INTEGER DEFAULT 0'],
          ['sl_price',     'REAL'],
          ['realized_pct', 'REAL'],
        ];
        for (const [col, type] of practiceTp1Cols) {
          try { await env.DB.prepare(`ALTER TABLE practice_trades ADD COLUMN ${col} ${type}`).run(); results.push(`practice_trades.${col}: added`); }
          catch (_) { results.push(`practice_trades.${col}: already exists`); }
        }

        // User Phase-2 columns
        const userP2Cols = [
          ['skip_password_change', 'INTEGER DEFAULT 0'],
        ];
        for (const [col, type] of userP2Cols) {
          try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col} ${type}`).run(); results.push(`users.${col}: added`); }
          catch (_) { results.push(`users.${col}: already exists`); }
        }

        // Ensure default strategy exists
        await initDefaultStrategy(env);
        results.push('strategies: default initialised');

        return jsonResponse({ success: true, results });
      }

      // ── ADMIN DATA MANAGEMENT ───────────────────────────────

      if (request.method === "POST" && url.pathname === "/admin/delete-signals") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { type } = await request.json();
        let query = null;
        if      (type === 'test')     query = `DELETE FROM signals WHERE is_test = 1`;
        else if (type === 'wait')     query = `DELETE FROM signals WHERE ai_recommendation = 'WAIT'`;
        else if (type === 'skipped')  query = `DELETE FROM signals WHERE outcome = 'SKIPPED'`;
        else if (type === 'practice') {
          await env.DB.prepare(`DELETE FROM practice_trades`).run();
          return jsonResponse({ success: true, type: 'practice', deleted: true });
        }
        else if (type === 'all') {
          await env.DB.prepare(`DELETE FROM signals`).run();
          await env.DB.prepare(`DELETE FROM signal_loss_reasons`).run();
          await env.DB.prepare(`DELETE FROM practice_trades`).run();
          return jsonResponse({ success: true, type: 'all', deleted: true });
        }
        else return jsonResponse({ error: 'Ungültiger type (test|wait|skipped|practice|all)' }, 400);

        const info = await env.DB.prepare(query).run();
        return jsonResponse({ success: true, type, deleted: info.meta?.changes ?? 0 });
      }

      if (request.method === "POST" && url.pathname === "/admin/live-start") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { deleteTestSignals } = await request.json();
        await ensureTables(env);
        await setSetting(env, 'mode', 'live');
        await setSetting(env, 'live_started_at', String(Date.now()));

        let deletedSignals = 0;
        if (deleteTestSignals) {
          // Delete practice_trades FIRST while signal IDs still exist in the DB
          await env.DB.prepare(`DELETE FROM practice_trades WHERE signal_id IN (SELECT id FROM signals WHERE is_test = 1)`).run();
          const info = await env.DB.prepare(`DELETE FROM signals WHERE is_test = 1`).run();
          deletedSignals = info.meta?.changes ?? 0;
        }
        return jsonResponse({ success: true, mode: 'live', liveStartedAt: Date.now(), deletedSignals });
      }

      if (request.method === "GET" && url.pathname === "/admin/settings") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        await ensureTables(env);
        try {
          const rows = await env.DB.prepare(`SELECT key, value, updated_at FROM settings ORDER BY key`).all();
          const obj = {};
          for (const r of (rows.results || [])) obj[r.key] = r.value;
          return jsonResponse(obj);
        } catch (_) { return jsonResponse({}); }
      }

      if (request.method === "POST" && url.pathname === "/admin/settings") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        await ensureTables(env);
        const body = await request.json();
        for (const [key, value] of Object.entries(body)) {
          await setSetting(env, key, value);
        }
        return jsonResponse({ success: true });
      }

      // ── STRATEGIES ──────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/strategies") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        await ensureTables(env);
        const existing = await env.DB.prepare(`SELECT COUNT(*) as c FROM strategies`).first();
        if (!existing?.c) await initDefaultStrategy(env);
        const rows = await env.DB.prepare(`SELECT * FROM strategies ORDER BY is_default DESC, created_at DESC`).all();
        return jsonResponse((rows.results || []).map(s => ({
          ...s, config: s.config_json ? JSON.parse(s.config_json) : DEFAULT_STRATEGY_CONFIG
        })));
      }

      if (request.method === "POST" && url.pathname === "/strategies") {
        const session = await validateSession(env, request);
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const { name, version, config } = await request.json();
        if (!name || !config) return jsonResponse({ error: "name and config required" }, 400);
        const id = `strategy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO strategies (id, name, version, active, is_default, protected, created_at, updated_at, config_json)
          VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)
        `).bind(id, name, version || 'v1.0', now, now, JSON.stringify(config)).run();
        return jsonResponse({ success: true, id });
      }

      if (request.method === "PUT" && url.pathname.startsWith("/strategies/") && !url.pathname.endsWith("/activate") && url.pathname !== "/strategies/reset-to-default" && url.pathname !== "/strategies/compare" && url.pathname !== "/strategies/ab-backtest" && url.pathname !== "/strategies/suggestions") {
        const session = await validateSession(env, request);
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const stratId = url.pathname.slice("/strategies/".length);
        const existing = await env.DB.prepare(`SELECT * FROM strategies WHERE id = ?`).bind(stratId).first();
        if (!existing) return jsonResponse({ error: "Nicht gefunden" }, 404);
        if (existing.protected) return jsonResponse({ error: "Standardstrategie kann nicht geändert werden" }, 403);
        const { name, version, config } = await request.json();
        const sets = [], binds = [];
        if (name)   { sets.push("name = ?");        binds.push(name); }
        if (version){ sets.push("version = ?");     binds.push(version); }
        if (config) { sets.push("config_json = ?"); binds.push(JSON.stringify(config)); }
        sets.push("updated_at = ?"); binds.push(Date.now());
        binds.push(stratId);
        await env.DB.prepare(`UPDATE strategies SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/strategies/")) {
        const session = await validateSession(env, request);
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const stratId = url.pathname.slice("/strategies/".length);
        const existing = await env.DB.prepare(`SELECT * FROM strategies WHERE id = ?`).bind(stratId).first();
        if (!existing) return jsonResponse({ error: "Nicht gefunden" }, 404);
        if (existing.is_default || existing.protected) return jsonResponse({ error: "Standardstrategie kann nicht gelöscht werden" }, 403);
        await env.DB.prepare(`DELETE FROM strategies WHERE id = ?`).bind(stratId).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname.endsWith("/activate") && url.pathname.startsWith("/strategies/")) {
        const session = await validateSession(env, request);
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const stratId = url.pathname.replace("/activate", "").slice("/strategies/".length);
        await env.DB.prepare(`UPDATE strategies SET active = 0`).run();
        await env.DB.prepare(`UPDATE strategies SET active = 1, updated_at = ? WHERE id = ?`).bind(Date.now(), stratId).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname === "/strategies/reset-to-default") {
        const session = await validateSession(env, request);
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        await env.DB.prepare(`UPDATE strategies SET active = 0`).run();
        await env.DB.prepare(`UPDATE strategies SET active = 1, updated_at = ? WHERE is_default = 1`).bind(Date.now()).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "GET" && url.pathname === "/strategies/compare") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const rows = await env.DB.prepare(`
            SELECT strategy_id, strategy_name, strategy_version,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN'  THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
              SUM(CASE WHEN outcome='OPEN' THEN 1 ELSE 0 END) as open_count,
              SUM(CASE WHEN ai_recommendation='WAIT' THEN 1 ELSE 0 END) as wait_count,
              SUM(CASE WHEN ai_recommendation='SKIP' THEN 1 ELSE 0 END) as skip_count,
              AVG(ai_score) as avg_score
            FROM signals WHERE strategy_id IS NOT NULL
            GROUP BY strategy_id ORDER BY total DESC
          `).all();
          return jsonResponse((rows.results || []).map(r => ({
            ...r,
            winRate: computeWinRate(r.wins, r.losses),
            avg_score: r.avg_score ? parseFloat(r.avg_score.toFixed(1)) : 0
          })));
        } catch (e) { return jsonResponse([]); }
      }

      // ── AUFGABE 1: Per-Strategie-Übersicht (die 4 code-level Strategien) ──
      // Gruppiert `signals` nach strategy_key (Legacy/NULL → crypto_baseline)
      // und liefert Trades/Win-Rate/Ø-Win/Ø-Loss/Expectancy/letztes Signal +
      // Asset-Klasse + Status (aktiv/pausiert) je Strategie aus der Registry.
      if (request.method === "GET" && url.pathname === "/strategies/overview") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const rows = await env.DB.prepare(`
            SELECT COALESCE(NULLIF(strategy_key, ''), 'crypto_baseline') as skey,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='OPEN' THEN 1 ELSE 0 END) as open_count,
              SUM(CASE WHEN outcome='WIN'  THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
              AVG(CASE WHEN outcome='WIN'  THEN pnl_pct END) as avg_win,
              AVG(CASE WHEN outcome='LOSS' THEN pnl_pct END) as avg_loss,
              MAX(created_at) as last_signal
            FROM signals
            GROUP BY skey
          `).all();
          const byKey = {};
          for (const r of (rows.results || [])) byKey[r.skey] = r;
          const statuses = await getStrategyStatuses(env);
          const out = Object.keys(STRATEGIES).map(key => {
            const def = STRATEGIES[key];
            const r   = byKey[key] || {};
            const wins = r.wins || 0, losses = r.losses || 0;
            const avgWinPct  = r.avg_win  != null ? parseFloat(r.avg_win.toFixed(2))  : 0;
            const avgLossPct = r.avg_loss != null ? parseFloat(r.avg_loss.toFixed(2)) : 0;
            return {
              key, label: def.label, assetClass: def.assetClass, status: statuses[key],
              openTrades:   r.open_count || 0,
              closedTrades: wins + losses,
              wins, losses,
              winRate:      computeWinRate(wins, losses),
              avgWinPct, avgLossPct,
              expectancy:   computeExpectancy(wins, losses, avgWinPct, avgLossPct),
              lastSignalAt: r.last_signal || null,
            };
          });
          return jsonResponse(out);
        } catch (e) {
          console.error('❌ /strategies/overview error:', e.message);
          return jsonResponse([]);
        }
      }

      // Admin-Toggle aktiv/pausiert je Strategie (Rollen-Guard in setStrategyStatus).
      if (request.method === "POST" && url.pathname === "/admin/strategy-toggle") {
        const session = await validateSession(env, request);
        let body = {};
        try { body = await request.json(); } catch (_) {}
        const result = await setStrategyStatus({ env, session, strategy: body.strategy, paused: !!body.paused });
        if (!result.ok) return jsonResponse({ error: result.error }, result.status);
        return jsonResponse({ success: true, strategy: result.strategy, status: result.status_label });
      }

      if (request.method === "POST" && url.pathname === "/strategies/ab-backtest") {
        const session = await validateSession(env, request);
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const { strategyIds } = await request.json();
        if (!strategyIds?.length) return jsonResponse({ error: "strategyIds required" }, 400);
        const signals = await env.DB.prepare(`SELECT * FROM signals ORDER BY created_at DESC LIMIT 100`).all();
        const results = [];
        for (const stratId of strategyIds) {
          const strat = await env.DB.prepare(`SELECT * FROM strategies WHERE id = ?`).bind(stratId).first();
          if (!strat) continue;
          const config = strat.config_json ? JSON.parse(strat.config_json) : DEFAULT_STRATEGY_CONFIG;
          let wins = 0, losses = 0, waitCount = 0, skipCount = 0, totalScore = 0;
          for (const sig of (signals.results || [])) {
            const analysis = analyzeWithRules(sig, config);
            totalScore += analysis.score;
            if (analysis.recommendation === 'WAIT') waitCount++;
            else if (analysis.recommendation === 'SKIP') skipCount++;
            if (sig.outcome === 'WIN') wins++;
            else if (sig.outcome === 'LOSS') losses++;
          }
          const total = (signals.results || []).length;
          const closed = wins + losses;
          results.push({
            strategyId: stratId, strategyName: strat.name, strategyVersion: strat.version,
            total, wins, losses, waitCount, skipCount,
            winRate: computeWinRate(wins, losses),
            avgScore: total > 0 ? parseFloat((totalScore / total).toFixed(1)) : 0
          });
        }
        return jsonResponse({ results, signalCount: (signals.results || []).length });
      }

      if (request.method === "GET" && url.pathname === "/strategies/suggestions") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const suggestions = [];
          const lowScoreLosses = await env.DB.prepare(`SELECT COUNT(*) as c FROM signals WHERE outcome='LOSS' AND ai_score < 75`).first();
          const lowScoreWins   = await env.DB.prepare(`SELECT COUNT(*) as c FROM signals WHERE outcome='WIN'  AND ai_score < 75`).first();
          if ((lowScoreLosses?.c || 0) > (lowScoreWins?.c || 0) && (lowScoreLosses?.c || 0) > 2) {
            suggestions.push({ type: 'score_threshold', priority: 'high', title: 'Min. Score erhöhen', message: `${lowScoreLosses.c} Losses hatten Score < 75. Erwäge min_trade_score auf 80+ zu erhöhen.`, action: 'Schwellenwert anpassen' });
          }
          const symRows = await env.DB.prepare(`
            SELECT symbol, COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
            FROM signals WHERE outcome IN ('WIN','LOSS')
            GROUP BY symbol HAVING (wins+losses) >= 3
            ORDER BY (wins*1.0/(wins+losses)) ASC LIMIT 3
          `).all();
          for (const sym of (symRows.results || [])) {
            const wr = computeWinRate(sym.wins, sym.losses);
            if (wr < 35) suggestions.push({ type: 'symbol_filter', priority: 'medium', title: `${sym.symbol} performat schlecht`, message: `${sym.symbol}: ${wr.toFixed(0)}% Win-Rate bei ${sym.wins + sym.losses} Trades`, action: 'Symbol-Filter prüfen' });
          }
          const lrRows = await env.DB.prepare(`SELECT reason, COUNT(*) as cnt FROM signal_loss_reasons GROUP BY reason ORDER BY cnt DESC LIMIT 5`).all();
          for (const r of (lrRows.results || [])) {
            suggestions.push({ type: 'rule_weight', priority: 'low', title: `Häufiger Loss-Grund: ${r.reason}`, message: `"${r.reason}" wurde ${r.cnt}× als Verlustgrund markiert`, action: 'Regel-Gewicht anpassen' });
          }
          if (suggestions.length === 0) suggestions.push({ type: 'info', priority: 'low', title: 'Zu wenig Daten', message: 'Für aussagekräftige Vorschläge werden mehr abgeschlossene Trades benötigt.', action: null });
          return jsonResponse(suggestions);
        } catch (e) { return jsonResponse([{ type: 'error', priority: 'low', title: 'Fehler', message: e.message, action: null }]); }
      }

      // ── SIGNAL LOSS REASONS ──────────────────────────────────

      if (request.method === "POST" && url.pathname.startsWith("/signals/") && url.pathname.endsWith("/loss-reason")) {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.slice("/signals/".length, -"/loss-reason".length);
        const { reason, note, strategyId } = await request.json();
        if (!reason) return jsonResponse({ error: "reason required" }, 400);
        await ensureTables(env);
        await env.DB.prepare(`INSERT INTO signal_loss_reasons (signal_id, strategy_id, reason, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(signalId, strategyId || null, reason, note || null, Date.now(), session.username).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "GET" && url.pathname.startsWith("/signals/") && url.pathname.endsWith("/loss-reasons")) {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.slice("/signals/".length, -"/loss-reasons".length);
        try {
          const rows = await env.DB.prepare(`SELECT * FROM signal_loss_reasons WHERE signal_id = ? ORDER BY created_at DESC`).bind(signalId).all();
          return jsonResponse(rows.results || []);
        } catch (_) { return jsonResponse([]); }
      }

      // ── ADMIN: ROLE CHANGE ──────────────────────────────────

      if (request.method === "PATCH" && url.pathname.startsWith("/admin/users/") && url.pathname.endsWith("/role")) {
        const session = await validateSession(env, request);
        if (!isAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const userId = url.pathname.split("/")[3];
        const { role } = await request.json();
        const validRoles = ['admin', 'trader', 'viewer', 'extern'];
        if (!validRoles.includes(role)) return jsonResponse({ error: "Ungültige Rolle" }, 400);
        await env.DB.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`)
          .bind(role, Date.now(), userId).run();
        try {
          await env.DB.prepare(`UPDATE sessions SET role = ? WHERE user_id = ?`).bind(role, userId).run();
        } catch (_) {}
        return jsonResponse({ success: true });
      }

      // ── AUTOTRADE CONFIG ─────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/broker-config") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const cfg = await loadAutotradeConfig(env);
        if (!cfg) return jsonResponse({ configured: false });
        // Never return the full key — return a masked version only.
        const masked = cfg.apiKey
          ? cfg.apiKey.slice(0, 4) + '••••' + cfg.apiKey.slice(-4)
          : '';
        return jsonResponse({
          configured: true,
          broker: cfg.broker,
          apiKeyMasked: masked,
          testnet: cfg.testnet,
          enabled: cfg.enabled,
          tradeAmount: cfg.tradeAmount,
          minScore: cfg.minScore,
          hasPassphrase: !!cfg.passphrase,
        });
      }

      if (request.method === "POST" && url.pathname === "/broker-config") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        // Load and decrypt previous config so we can fall back to existing keys when omitted.
        const prev = (await loadAutotradeConfig(env)) || {};
        const cfg = {
          broker:      body.broker      || prev.broker      || 'bybit',
          // Encrypt sensitive fields; fall back to existing encrypted value when blank.
          apiKey:      await encryptField(env, body.apiKey      || prev.apiKey      || ''),
          apiSecret:   await encryptField(env, body.apiSecret   || prev.apiSecret   || ''),
          passphrase:  await encryptField(env, body.passphrase  || prev.passphrase  || ''),
          testnet:     body.testnet     !== undefined ? !!body.testnet : (prev.testnet ?? true),
          enabled:     body.enabled     !== undefined ? !!body.enabled : (prev.enabled ?? false),
          tradeAmount: parseFloat(body.tradeAmount) || prev.tradeAmount || 10,
          minScore:    parseInt(body.minScore)      || prev.minScore    || 75,
        };
        await setSetting(env, 'autotrade_config', JSON.stringify(cfg));
        return jsonResponse({ success: true, enabled: cfg.enabled, broker: cfg.broker });
      }

      // ── LIVE TRADES ───────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/live-trades") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        await ensureTables(env);
        const limit = Math.min(200, parseInt(url.searchParams.get("limit") || "50"));
        const rows = await env.DB.prepare(
          `SELECT * FROM live_trades ORDER BY created_at DESC LIMIT ?`
        ).bind(limit).all();
        return jsonResponse(rows.results || []);
      }

      // ── JOURNAL SYMBOLS ──────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/journal/symbols") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const raw = await getSetting(env, 'journal_symbols', '[]');
        try { return jsonResponse({ symbols: JSON.parse(raw) }); }
        catch { return jsonResponse({ symbols: [] }); }
      }

      if (request.method === "POST" && url.pathname === "/journal/symbols") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        let syms;
        if (Array.isArray(body.symbols)) {
          // Client sends authoritative full list — no DB read needed, avoids stale-read races
          syms = [...new Set(body.symbols.map(s => String(s).toUpperCase().trim()).filter(Boolean))];
        } else {
          const raw = await getSetting(env, 'journal_symbols', '[]');
          syms = (() => { try { return JSON.parse(raw); } catch { return []; } })();
          if (body.action === 'remove' && body.symbol) {
            syms = syms.filter(s => s !== body.symbol);
          } else if (body.symbol) {
            const sym = String(body.symbol).toUpperCase().trim();
            if (sym && !syms.includes(sym)) syms.push(sym);
          }
        }
        await setSetting(env, 'journal_symbols', JSON.stringify(syms));
        return jsonResponse({ symbols: syms });
      }

      // ── MORNING ROUTINE ──────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/morning-routine/status") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const rows = await env.DB.prepare(
          `SELECT symbol, completed_at FROM morning_routines WHERE user_id = ? AND date = ?`
        ).bind(session.userId, date).all();
        const done = {};
        for (const row of (rows.results || [])) {
          if (row.completed_at) done[row.symbol] = true;
        }
        return jsonResponse(done);
      }

      if (request.method === "GET" && url.pathname === "/morning-routine") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const symbol = url.searchParams.get("symbol") || 'BTCUSDT';
        const routine = await env.DB.prepare(
          `SELECT * FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? ORDER BY created_at DESC LIMIT 1`
        ).bind(session.userId, date, symbol).first();
        return jsonResponse(routine || null);
      }

      if (request.method === "POST" && url.pathname === "/morning-routine") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const date = body.date || new Date().toISOString().slice(0, 10);
        const symbol = body.symbol || 'BTCUSDT';
        // Use symbol+user+date as the natural key so each symbol gets one routine per day
        const existing = await env.DB.prepare(
          `SELECT id FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? ORDER BY created_at DESC LIMIT 1`
        ).bind(session.userId, date, symbol).first();
        const id = existing?.id || body.id || `mr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO morning_routines (id, user_id, date, symbol, bias, chart_opened, ema200_checked, ema_direction, key_zones_marked, zone_notes, bias_reason, completed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET bias = excluded.bias, chart_opened = excluded.chart_opened, ema200_checked = excluded.ema200_checked, ema_direction = excluded.ema_direction, key_zones_marked = excluded.key_zones_marked, zone_notes = excluded.zone_notes, bias_reason = excluded.bias_reason, completed_at = excluded.completed_at
        `).bind(
          id, session.userId, date, symbol, body.bias || 'KEIN_TRADE',
          (body.chart_opened ?? body.chartOpened) ? 1 : 0,
          (body.ema200_checked ?? body.ema200Checked) ? 1 : 0,
          body.ema_direction || body.emaDirection || null,
          (body.key_zones_marked ?? body.keyZonesMarked) ? 1 : 0,
          body.zone_notes || body.zoneNotes || null,
          body.bias_reason || body.biasReason || null,
          body.bias ? now : (body.completed ? now : null), now
        ).run();
        return jsonResponse({ success: true, id });
      }

      // ── MORNING BRIEFING ─────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/morning-briefing") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const since = Date.now() - 14 * 60 * 60 * 1000; // last 14 hours
          const rows = await env.DB.prepare(
            `SELECT * FROM market_events WHERE status = 'ACTIVE' AND (updated_at >= ? OR created_at >= ?) ORDER BY impact DESC, event_time DESC LIMIT 30`
          ).bind(since, since).all();
          const events = rows.results || [];
          const highImpact = events.filter(e => e.impact === 'HIGH');
          const affectedSymbols = [...new Set(
            events.flatMap(e => { try { return JSON.parse(e.affected_symbols || '[]'); } catch { return []; } })
          )];
          const marketScope = highImpact.some(e => ['MACRO','GLOBAL','REGULATION'].includes(e.affected_scope))
            ? 'GLOBAL' : affectedSymbols.length > 0 ? 'COIN_SPECIFIC' : 'GLOBAL';
          const summary = events.length === 0
            ? 'Keine relevanten Marktnews in den letzten 14 Stunden.'
            : `${events.length} Ereignisse — ${highImpact.length} HIGH Impact.${affectedSymbols.length ? ' Betroffene Coins: ' + affectedSymbols.slice(0,5).join(', ') + '.' : ''} Erhöhte Aufmerksamkeit empfohlen. Kein direkter Trade-Hinweis.`;
          return jsonResponse({
            success: true,
            date: new Date().toISOString().slice(0, 10),
            summary,
            highImpact: highImpact.slice(0, 10),
            affectedSymbols: affectedSymbols.slice(0, 10),
            marketScope,
            events: events.slice(0, 20),
            disclaimer: 'Nur Marktübersicht. Keine Finanzberatung. Jeder Trade ist eigenverantwortlich zu prüfen.'
          });
        } catch (e) {
          return jsonResponse({ success: false, error: e.message }, 500);
        }
      }

      // ── TODAY BIAS ───────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/today-bias") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = new Date().toISOString().slice(0, 10);
        const symbol = url.searchParams.get("symbol") || null;
        const query = symbol
          ? `SELECT bias, completed_at FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? AND completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`
          : `SELECT bias, completed_at FROM morning_routines WHERE user_id = ? AND date = ? AND completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
        const routine = symbol
          ? await env.DB.prepare(query).bind(session.userId, date, symbol).first()
          : await env.DB.prepare(query).bind(session.userId, date).first();
        return jsonResponse({ date, bias: routine?.bias || null, routineDone: !!routine });
      }

      // ── PRE-TRADE CHECKLIST ──────────────────────────────────

      if (request.method === "GET" && url.pathname === "/pre-trade-checklist") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const symbol = url.searchParams.get("symbol") || 'BTCUSDT';
        // Enforce order: morning routine must be completed first
        const routine = await env.DB.prepare(
          `SELECT id FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? AND completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`
        ).bind(session.userId, date, symbol).first();
        if (!routine) {
          return jsonResponse({ locked: true, reason: `Bitte zuerst die Morgenroutine für ${symbol} abschließen.` });
        }
        const rows = await env.DB.prepare(
          `SELECT * FROM pre_trade_checklists WHERE user_id = ? AND date = ? AND symbol = ? ORDER BY created_at DESC`
        ).bind(session.userId, date, symbol).all();
        return jsonResponse(rows.results || []);
      }

      if (request.method === "POST" && url.pathname === "/pre-trade-checklist") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const symbol = body.symbol || 'BTCUSDT';
        const date = body.date || new Date().toISOString().slice(0, 10);
        // Enforce order: morning routine must be completed first
        const routine = await env.DB.prepare(
          `SELECT id FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? AND completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`
        ).bind(session.userId, date, symbol).first();
        if (!routine) {
          return jsonResponse({ error: `Bitte zuerst die Morgenroutine für ${symbol} abschließen.`, locked: true }, 400);
        }
        const id = body.id || `ptc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO pre_trade_checklists (id, user_id, signal_id, date, symbol, bias_match, in_key_zone, structure_confirmed, no_chop, trend_candle, break_confirmed, rsi_ok, rsi_not_extreme, sl_logical, rr_ok, can_explain, clear_minded, no_fomo, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET bias_match=excluded.bias_match, in_key_zone=excluded.in_key_zone, structure_confirmed=excluded.structure_confirmed, no_chop=excluded.no_chop, trend_candle=excluded.trend_candle, break_confirmed=excluded.break_confirmed, rsi_ok=excluded.rsi_ok, rsi_not_extreme=excluded.rsi_not_extreme, sl_logical=excluded.sl_logical, rr_ok=excluded.rr_ok, can_explain=excluded.can_explain, clear_minded=excluded.clear_minded, no_fomo=excluded.no_fomo, notes=excluded.notes
        `).bind(
          id, session.userId, body.signal_id || body.signalId || null,
          date, symbol,
          (body.bias_match ?? body.biasMatch) ? 1 : 0,
          (body.in_key_zone ?? body.inKeyZone) ? 1 : 0,
          (body.structure_confirmed ?? body.structureConfirmed) ? 1 : 0,
          (body.no_chop ?? body.noChop) ? 1 : 0,
          (body.trend_candle ?? body.trendCandle) ? 1 : 0,
          (body.break_confirmed ?? body.breakConfirmed) ? 1 : 0,
          (body.rsi_ok ?? body.rsiOk) ? 1 : 0,
          (body.rsi_not_extreme ?? body.rsiNotExtreme) ? 1 : 0,
          (body.sl_logical ?? body.slLogical) ? 1 : 0,
          (body.rr_ok ?? body.rrOk) ? 1 : 0,
          (body.can_explain ?? body.canExplain) ? 1 : 0,
          (body.clear_minded ?? body.clearMinded) ? 1 : 0,
          (body.no_fomo ?? body.noFomo) ? 1 : 0,
          body.notes || null, now
        ).run();
        return jsonResponse({ success: true, id });
      }

      // ── TRADE REVIEW ─────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/trade-review") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const symbol = url.searchParams.get("symbol") || null;
        const rows = symbol
          ? await env.DB.prepare(`SELECT * FROM trade_reviews WHERE user_id = ? AND date = ? AND symbol = ? ORDER BY created_at DESC`).bind(session.userId, date, symbol).all()
          : await env.DB.prepare(`SELECT * FROM trade_reviews WHERE user_id = ? AND date = ? ORDER BY created_at DESC`).bind(session.userId, date).all();
        const mapped = (rows.results || []).map(r => ({
          ...r,
          entry_price:   r.entry_price  ?? r.entry,
          sl_price:      r.sl_price     ?? r.stop_loss,
          tp_price:      r.tp_price     ?? r.take_profit,
          lessons:       r.lessons      ?? r.lesson,
          trade_emotion: r.trade_emotion?? r.mood_before,
          respected_sl:  r.respected_sl ?? r.sl_not_moved,
          respected_tp:  r.respected_tp ?? r.tp_not_closed_early,
          would_retake:  r.would_retake ?? r.would_take_again,
          mistakes:      r.mistakes     ?? r.what_went_wrong,
        }));
        return jsonResponse(mapped);
      }

      if (request.method === "POST" && url.pathname === "/trade-review") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const symbol = body.symbol || body.instrument || 'BTCUSDT';
        const id = body.id || `tr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO trade_reviews (id, user_id, signal_id, date, symbol, instrument, direction, entry, stop_loss, take_profit, exit_price, outcome, realized_rr, bias_clear, bias_direction, in_key_zone, structure_hl_lh, trend_candle_clean, break_confirmed, rsi_ok, sl_logical, rr_acceptable, what_went_well, what_went_wrong, discipline, mood_before, no_fomo, sl_not_moved, tp_not_closed_early, no_revenge, lesson, would_take_again, followed_plan, waited_confirmation, felt_confident, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET instrument=excluded.instrument, direction=excluded.direction, entry=excluded.entry, stop_loss=excluded.stop_loss, take_profit=excluded.take_profit, exit_price=excluded.exit_price, outcome=excluded.outcome, realized_rr=excluded.realized_rr, what_went_wrong=excluded.what_went_wrong, mood_before=excluded.mood_before, no_fomo=excluded.no_fomo, sl_not_moved=excluded.sl_not_moved, tp_not_closed_early=excluded.tp_not_closed_early, no_revenge=excluded.no_revenge, lesson=excluded.lesson, would_take_again=excluded.would_take_again, followed_plan=excluded.followed_plan, waited_confirmation=excluded.waited_confirmation, felt_confident=excluded.felt_confident, updated_at=excluded.updated_at
        `).bind(
          id, session.userId, body.signal_id || body.signalId || null,
          body.date || new Date().toISOString().slice(0, 10),
          symbol,
          body.instrument || null, body.direction || null,
          body.entry_price ?? body.entry ?? null,
          body.sl_price    ?? body.stopLoss ?? null,
          body.tp_price    ?? body.takeProfit ?? null,
          body.exit_price  ?? body.exitPrice ?? null,
          body.outcome || null,
          body.realizedRR || null,
          0, 0, 0, 0, 0, 0, 0, 0, 0,
          null,
          body.mistakes    || body.whatWentWrong || null,
          null,
          body.trade_emotion || body.moodBefore || null,
          (body.no_fomo ?? body.noFomo) ? 1 : 0,
          (body.respected_sl ?? body.slNotMoved) ? 1 : 0,
          (body.respected_tp ?? body.tpNotClosedEarly) ? 1 : 0,
          (body.no_revenge ?? body.noRevenge) ? 1 : 0,
          body.lessons || body.lesson || null,
          (body.would_retake ?? body.wouldTakeAgain) ? 1 : 0,
          (body.followed_plan ?? body.followedPlan) ? 1 : 0,
          (body.waited_confirmation ?? body.waitedConfirmation) ? 1 : 0,
          (body.felt_confident ?? body.feltConfident) ? 1 : 0,
          now, now
        ).run();
        return jsonResponse({ success: true, id });
      }

      // ── BIAS STATS ───────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/bias-stats") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const all = await env.DB.prepare(
            `SELECT outcome, daily_bias, before_morning_routine, counts_for_strategy FROM signals WHERE outcome IN ('WIN','LOSS')`
          ).all();
          const rows = all.results || [];
          const calc = (filter) => {
            const s = rows.filter(filter);
            const w = s.filter(r => r.outcome === 'WIN').length;
            const l = s.filter(r => r.outcome === 'LOSS').length;
            return { total: s.length, wins: w, losses: l, winRate: computeWinRate(w, l) };
          };
          return jsonResponse({
            official:   calc(r => r.counts_for_strategy === 1),
            all:        calc(() => true),
            biasConform: calc(r => r.bias_match === 'conform'),
            againstBias: calc(r => r.bias_match === 'against'),
            beforeRoutine: calc(r => r.before_morning_routine === 1),
            noTradeDay:  calc(r => r.daily_bias === 'KEIN_TRADE'),
          });
        } catch (e) { return jsonResponse({ error: e.message }, 500); }
      }

      // ── WEBHOOK (TradingView) ────────────────────────────────
      // Generischer Endpunkt: Strategie kommt aus dem Payload-Feld `strategy`
      // (resolveStrategyKey). Bleibt unverändert/backward-compatible für
      // Alerts, die noch nicht auf die separaten Pfade unten umgestellt sind.

      if (request.method === "POST" && url.pathname === "/webhook") {
        return handleWebhookRequest(request, env, ctx, url, jsonResponse);
      }

      // ── Separate Webhook-Endpunkte pro Strategie ─────────────
      // Strategie kommt aus der URL statt aus dem Payload (siehe Kommentar
      // bei handleWebhookRequest). Auth/Parsing/Event-Routing sind über
      // handleWebhookRequest 1:1 identisch zu /webhook — nur forcedStrategy
      // unterscheidet sich.

      if (request.method === "POST" && url.pathname === "/webhook/baseline") {
        console.log('[webhook/baseline] received signal request');
        return handleWebhookRequest(request, env, ctx, url, jsonResponse, 'crypto_baseline');
      }

      if (request.method === "POST" && url.pathname === "/webhook/sr-volume") {
        console.log('[webhook/sr-volume] received signal request');
        return handleWebhookRequest(request, env, ctx, url, jsonResponse, 'crypto_sr_volume');
      }

      if (request.method === "POST" && url.pathname === "/webhook/forex") {
        console.log('[webhook/forex] received signal request');
        return handleWebhookRequest(request, env, ctx, url, jsonResponse, 'forex_sr_fib_rsi');
      }

      // Krypto-3 (Orderflow) ist vorerst deaktiviert. Die URL wird schon
      // reserviert (501, nicht 404 — der Pfad existiert bewusst, die
      // Strategie ist nur noch nicht scharf), damit sie später nur noch
      // aktiviert werden muss (forcedStrategy setzen), ohne nochmal am
      // Router zu arbeiten.
      if (request.method === "POST" && url.pathname === "/webhook/orderflow") {
        console.log('[webhook/orderflow] received signal request (disabled)');
        return jsonResponse({ error: 'Krypto-3 Orderflow temporarily disabled' }, 501);
      }

      // ── HEALTH CHECK ────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/health") {
        let dbStatus = 'unknown';
        try { await env.DB.prepare('SELECT 1').first(); dbStatus = 'ok'; }
        catch (e) { dbStatus = 'error: ' + e.message; }
        return jsonResponse({
          status: 'ok',
          time: new Date().toISOString(),
          version: '3.4.0-production',
          db: dbStatus
        });
      }

      return new Response("WAVESCOUT v3.4 Production ✅", { headers: corsHeaders });

    } catch (error) {
      console.error('❌ Unhandled worker error:', error.message);
      console.error('Stack:', error.stack);
      return jsonResponse({ error: "Internal Server Error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    console.log('⏰ Cron triggered:', event.cron);

    // Sicherstellen, dass die TP1/Breakeven-Spalten existieren, bevor die
    // Cron-Evaluatoren laufen (HTTP-Pfad macht das via processSignal, der
    // Cron-Pfad bisher nicht). Idempotent durch _tablesReady-Guard.
    try { await ensureTables(env); } catch (_) {}

    // Every 4h: evaluate TP1 / Breakeven / TP2 exits for open signals (backstop;
    // der schnelle Pfad ist der per-Tick-Practice-Check auf jedem Snapshot).
    if (event.cron === "0 */4 * * *") {
      try {
        await evaluateOpenTrades(env);
      } catch (err) {
        console.error('❌ Cron 4h evaluation error:', err.message);
        ctx.waitUntil(sendTelegramMessage(env, `⚠️ Cron-Fehler (4h): ${err.message}`).catch(() => {}));
      }
    }

    // Re-evaluate open signals (single live path) with latest snapshot prices
    try {
      const openSyms = await env.DB.prepare(
        `SELECT DISTINCT symbol FROM signals WHERE outcome='OPEN'`
      ).all();
      for (const row of (openSyms.results || [])) {
        const snap = await getSnapshot(env, row.symbol, '5m');
        if (snap?.price) await checkOpenSignalsForSymbol(env, row.symbol, snap.price);
      }
    } catch (err) {
      console.error('❌ Open-signals cron error:', err.message);
      // Telegram-Alert wie im 4h-Block, damit ein stiller Fehlschlag auffällt.
      // Eigenes .catch() um den Alert: schlägt Telegram fehl, wird das nur
      // geloggt und eskaliert NICHT in den Cron-Handler. console.error bleibt.
      ctx.waitUntil(
        sendTelegramMessage(env, `⚠️ Cron-Fehler (Open-Signals-Re-Eval): ${err.message}`)
          .catch((e) => console.error('⚠️ Telegram-Alert (Open-Signals) fehlgeschlagen:', e?.message))
      );
    }

    if (event.cron === "0 7 * * *") {
      try {
        await sendDailySummary(env);
      } catch (err) {
        console.error('❌ Daily summary cron error:', err.message);
        // Telegram-Alert wie im 4h-Block (eigenes .catch() → kein Eskalieren).
        ctx.waitUntil(
          sendTelegramMessage(env, `⚠️ Cron-Fehler (Daily Summary): ${err.message}`)
            .catch((e) => console.error('⚠️ Telegram-Alert (Daily Summary) fehlgeschlagen:', e?.message))
        );
      }
    }

    // Refresh news cache in the background on every cron run so the News
    // page always shows fresh data even when no user is visiting.
    ctx.waitUntil(getMarketRadar(env));
  }
};

// ─────────────────────────────────────────────────────────────────
// Test-only named exports (behaviour-neutral).
// The Cloudflare Worker runtime uses the `export default` above; these
// named exports merely expose the pure scoring helpers so they can be
// unit-tested with `node --test`. They do not change runtime logic or
// the default export.
export {
  analyzeWithRules, processSignal, calcRR, safePct, getSignalQuality, DEFAULT_STRATEGY_CONFIG,
  evaluateExit, deriveTp1, EXIT_CONFIG,
  detectAssetClass, normalizeSymbol, resolveStrategyKey, exitConfigForStrategy,
  isWithinForexSession, STRATEGIES, FOREX_SESSIONS_UTC, resetStartingCapital,
  setStrategyStatus, getStrategyStatuses, computeWinRate, computeExpectancy,
  scoreCandidate, CANDIDATE_SCORING_DEFAULTS, normalizeSignalForScoring,
  scoreMeanReversionBaseline, handleWebhookRequest,
};
