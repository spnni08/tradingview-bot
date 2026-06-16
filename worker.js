// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - PRODUCTION WORKER
// Signal Processing · Snapshots · Telegram · Backtesting
// ═══════════════════════════════════════════════════════════════

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

function getSignalQuality(score) {
  if (score == null || isNaN(score)) return 'UNBEKANNT';
  if (score >= 90) return 'PREMIUM';
  if (score >= 75) return 'GUT';
  if (score >= 60) return 'OKAY';
  if (score >= 45) return 'SCHWACH';
  return 'SKIP';
}

function safePct(target, base) {
  if (!target || !base || base === 0) return null;
  return parseFloat(((Math.abs(target - base) / Math.abs(base)) * 100).toFixed(2));
}

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

function formatSignalForTelegram(signal) {
  const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
  const sc    = signal.ai_score || 0;
  const scoreEmoji = sc >= 90 ? '⭐⭐⭐' : sc >= 75 ? '⭐⭐' : '⭐';
  const quality = signal.signal_quality || getSignalQuality(sc);
  const rrVal   = signal.risk_reward;
  const rrStr   = rrVal ? `1:${rrVal.toFixed(1)}` : 'N/A';
  const fmt     = (v) => v != null && !isNaN(v) ? `$${parseFloat(v).toFixed(2)}` : 'unbekannt';

  const biasLine = signal.daily_bias
    ? `\n📐 Tagesbias: ${escapeHtml(signal.daily_bias)}${signal.bias_match ? ` · ${escapeHtml(signal.bias_match)}` : ''}` : '';

  const matched = tryParseJSON(signal.matched_rules) || [];
  const failed  = tryParseJSON(signal.failed_rules)  || [];
  const matchedStr = matched.slice(0, 3).map(r => `✅ ${escapeHtml(r)}`).join('\n') || '–';
  const failedStr  = failed.slice(0, 3).map(r => `❌ ${escapeHtml(r)}`).join('\n')  || '–';

  const vpLine = (signal.vp_zone && signal.vp_zone !== 'none' && signal.vp_score > 0)
    ? `\n📊 Volume Profile: Bounce an <b>${signal.vp_zone}</b> (+${signal.vp_score} Score)` : '';

  const disclaimer = '\n\n⚠️ <i>Hinweis: Keine Finanzberatung. Signale dienen nur zu Analyse- und Backtesting-Zwecken. Trading birgt Risiko. Keine Garantie für Gewinne.</i>';

  return `${emoji} <b>${signal.symbol}</b> ${signal.direction}

${scoreEmoji} Score: <b>${sc}/100</b> · ${quality}
💰 Entry: ${fmt(signal.ai_entry ?? signal.price)}
🎯 TP: ${fmt(signal.ai_tp)}
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
  const dir = signal.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const fmt = (v) => v != null && !isNaN(v) ? `$${parseFloat(v).toFixed(4)}` : '–';
  const rrVal = signal.risk_reward;
  const rrStr = rrVal ? `1:${rrVal.toFixed(1)}` : 'N/A';
  const stars = sc >= 90 ? '⭐⭐⭐' : '⭐⭐';

  return `🚨🔥 <b>PRIORITY SIGNAL</b> 🔥🚨
━━━━━━━━━━━━━━━━━━━━━
${stars} Score: <b>${sc}/100</b> · ${getSignalQuality(sc)}
<b>${signal.symbol}</b> · ${dir}
━━━━━━━━━━━━━━━━━━━━━
💰 Entry: <b>${fmt(signal.ai_entry ?? signal.price)}</b>
🎯 TP:    <b>${fmt(signal.ai_tp)}</b>
🛑 SL:    <b>${fmt(signal.ai_sl)}</b>
⚖️ R:R:   <b>${rrStr}</b>
━━━━━━━━━━━━━━━━━━━━━
📋 ${escapeHtml(signal.ai_reason) || ''}

⚠️ <i>Keine Finanzberatung. Eigenverantwortlich prüfen.</i>`.trim();
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

async function analyzeSignalWithAI(env, signal, strategyConfig = null, abortSignal = null) {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('⚠️ No AI API key, using rule-based analysis');
    return analyzeWithRules(signal);
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
      return analyzeWithRules(signal, strategyConfig);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) {
      console.error('❌ Anthropic API returned empty content block');
      return analyzeWithRules(signal, strategyConfig);
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('AI analysis error:', error);
  }
  return analyzeWithRules(signal, strategyConfig);
}

function analyzeWithRules(signal, strategyConfig = null) {
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

  // ── TP / SL (v2.0: TP1 = 1.5R, TP2 = 3R) ────────────────────
  const entry   = price || 0;
  // SL: 1% distance; TP: 1.5x SL distance (TP1 target)
  const slDist  = entry * 0.01;
  const tp      = isLong  ? entry + slDist * 1.5 : entry - slDist * 1.5;
  const sl      = isLong  ? entry - slDist       : entry + slDist;
  const tp2     = isLong  ? entry + slDist * 3   : entry - slDist * 3;

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
    ];
    for (const [col, type] of signalIndicatorCols) {
      try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); }
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

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS alert_dedup (
        dedup_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )
    `).run();

    _tablesReady = true;
  } catch (error) {
    console.error('❌ ensureTables error:', error.message);
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
    await checkPracticeTrades(env, data.symbol, data.price);
  }

  console.log('✅ Snapshot saved:', symbol);
  return { ok: true, type: 'SNAPSHOT', message: 'Snapshot saved', symbol };
}

// ═══════════════════════════════════════════════════════════════
// PRACTICE TRADES
// ═══════════════════════════════════════════════════════════════

async function createPracticeTrade(env, signalId, signal, analysis) {
  try {
    const direction = signal.direction;
    if (!direction || direction === 'NONE') return null;

    const entryPrice = analysis.entry || signal.price || 0;
    const takeProfit = analysis.tp || 0;
    const stopLoss   = analysis.sl || 0;

    if (!entryPrice || !takeProfit || !stopLoss) {
      console.log('⚠️ Practice trade skipped: missing entry/tp/sl');
      return null;
    }

    await env.DB.prepare(`
      INSERT INTO practice_trades (
        signal_id, symbol, timeframe, direction,
        entry_price, take_profit, stop_loss, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `).bind(
      signalId,
      signal.symbol || 'UNKNOWN',
      String(signal.timeframe || '5'),
      direction,
      entryPrice,
      takeProfit,
      stopLoss,
      new Date().toISOString()
    ).run();

    console.log('📝 Practice trade created for signal:', signalId);
  } catch (error) {
    console.error('❌ createPracticeTrade error:', error.message);
  }
}

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

async function checkPracticeTrades(env, symbol, currentPrice) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
    ).first();
    if (!tableCheck) return;

    const openTrades = await env.DB.prepare(
      `SELECT * FROM practice_trades WHERE symbol = ? AND status = 'OPEN'`
    ).bind(symbol).all();

    for (const trade of (openTrades.results || [])) {
      let newStatus = null;

      if (trade.direction === 'LONG') {
        if (currentPrice >= trade.take_profit) newStatus = 'WIN';
        else if (currentPrice <= trade.stop_loss) newStatus = 'LOSS';
      } else if (trade.direction === 'SHORT') {
        if (currentPrice <= trade.take_profit) newStatus = 'WIN';
        else if (currentPrice >= trade.stop_loss) newStatus = 'LOSS';
      }

      if (newStatus) {
        const resultPct = trade.direction === 'LONG'
          ? ((currentPrice - trade.entry_price) / trade.entry_price) * 100
          : ((trade.entry_price - currentPrice) / trade.entry_price) * 100;

        await closeTrade(env, {
          practiceTradeId: trade.id,
          outcome: newStatus,
          exitPrice: currentPrice,
          pnlPct: parseFloat(resultPct.toFixed(2)),
          outcomeSource: 'auto'
        });

        console.log(`📊 Practice trade #${trade.id} closed: ${newStatus} (${resultPct.toFixed(2)}%)`);
      }
    }
  } catch (error) {
    console.error('❌ checkPracticeTrades error:', error.message);
  }
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

// winRate = wins / (wins+losses) * 100, OPEN/etc never in denominator.
function computeWinRate(wins, losses) {
  const closed = (wins || 0) + (losses || 0);
  return closed > 0 ? parseFloat(((wins || 0) / closed * 100).toFixed(1)) : 0;
}

// expectancy = (winRate/100 * avgWinPct) - (lossRate/100 * |avgLossPct|)
function computeExpectancy(wins, losses, avgWinPct, avgLossPct) {
  const winRate = computeWinRate(wins, losses);
  const lossRate = 100 - winRate;
  const expectancy = (winRate / 100) * (avgWinPct || 0) - (lossRate / 100) * Math.abs(avgLossPct || 0);
  return parseFloat(expectancy.toFixed(2));
}

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

async function processSignal(env, signal) {
  const direction = normalizeDirection(signal);
  const action    = normalizeAction(signal);
  signal.direction = direction;

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

  const ruleAnalysis     = analyzeWithRules(signal, strategyConfig);
  const fallbackAnalysis = ruleAnalysis;

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
  const preAiScore  = ruleAnalysis.score + vpScoreAdjusted;
  const aiThreshold = vpZone !== 'none' ? 50 : 55;

  // Use AbortController so the Anthropic fetch is actually cancelled when the
  // timeout fires, not just orphaned in the background (M2).
  const aiAbort = new AbortController();
  const aiTimer = setTimeout(() => aiAbort.abort(), AI_TIMEOUT_MS);
  let analysis;
  try {
    if (preAiScore >= aiThreshold) {
      analysis = await analyzeSignalWithAI(env, signal, strategyConfig, aiAbort.signal) || fallbackAnalysis;
    } else {
      console.log(`⏭️ Score-Gate: ${preAiScore} < ${aiThreshold} → Claude-Call übersprungen`);
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

  // Determine Telegram notification
  const isTest       = signal.test === true || signal.is_test === 1;
  let   shouldNotify = isTest || analysis.score >= 80;
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
    // Score >= 80 → nur Priority-Alert (kein zusätzliches reguläres Signal).
    // Score 75–79 → reguläre Nachricht.
    if (!isTest && analysis.score >= 80) {
      telegramReason = 'score_80_priority';
      const alertMsg = formatPriorityAlert({
        ...signal,
        direction,
        ai_score:    analysis.score,
        ai_entry:    analysis.entry,
        ai_tp:       analysis.tp,
        ai_sl:       analysis.sl,
        ai_reason:   analysis.reason,
        risk_reward: riskReward,
      });
      const sent = await withTimeout(sendAlertMessage(env, alertMsg), TELEGRAM_TIMEOUT_MS, false);
      if (sent) telegramSent = 1;
    } else {
      telegramReason = isTest ? 'test_signal' : 'score_75';
      const debugPrefix = isTest ? `🧪 <b>[TEST]</b>\n` : '';
      const telegramMessage = debugPrefix + formatSignalForTelegram({
        ...signal,
        direction,
        ai_score:       analysis.score,
        ai_entry:       analysis.entry,
        ai_tp:          analysis.tp,
        ai_sl:          analysis.sl,
        ai_reason:      analysis.reason,
        signal_quality: signalQuality,
        risk_reward:    riskReward,
        matched_rules:  matchedRulesJSON,
        failed_rules:   failedRulesJSON,
        vp_zone:        vpZone,
        vp_score:       vpScore,
      });
      const sent = await withTimeout(sendTelegramMessage(env, telegramMessage), TELEGRAM_TIMEOUT_MS, false);
      if (sent) telegramSent = 1;
    }
    // ntfy.sh push for top-tier signals (score ≥ 95), runs in addition to Telegram
    if (!isTest && analysis.score >= 95) {
      await withTimeout(sendNtfyAlert(env, signal.symbol, signal.timeframe || '', analysis.score), 5000, false);
    }
    // Web Push to all subscribed browsers/devices (score ≥ 80)
    if (!isTest && analysis.score >= 80) {
      const dir = direction === 'LONG' ? '▲' : '▼';
      sendWebPushToAll(env,
        `${dir} ${signal.symbol} · Score ${analysis.score}`,
        `Entry $${(analysis.entry||0).toFixed(2)} · TP $${(analysis.tp||0).toFixed(2)} · SL $${(analysis.sl||0).toFixed(2)}`,
        '/'
      ).catch(() => {});
    }
  }

  await env.DB.prepare(`
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
      created_at, outcome
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?
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
    analysis.score >= 75 ? 'OPEN' : 'SKIPPED'
  ).run();

  // Only open a practice trade for signals that meet the quality threshold
  if (analysis.score >= 75) {
    await createPracticeTrade(env, signalId, { ...signal, direction }, analysis);
  }

  // Autotrade: place real exchange order if configured and score meets threshold
  try {
    const atCfg = await loadAutotradeConfig(env);
    if (atCfg) {
      const minScore = Math.max(75, atCfg.minScore || 75);
      if (atCfg.enabled && !isTest && analysis.score >= minScore && analysis.entry) {
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

  console.log('✅ Signal processed:', signalId, '| Score:', analysis.score, '| Rec:', analysis.recommendation, '| Telegram:', telegramSent ? telegramReason : 'no');
  return { status: 'ok', signalId, analysis };
}

async function handlePriceUpdate(env, payload) {
  try {
    const symbol = payload.symbol;
    const price = parseFloat(payload.price ?? payload.close ?? 0);
    if (!symbol || !price) return { success: true, type: 'PRICE_UPDATE', message: 'Price update accepted (no symbol/price)' };
    await ensureTables(env);
    await checkPracticeTrades(env, symbol, price);
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
    // Join users to get blocked status so canViewDashboard is enforced correctly.
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
function canViewDashboard(session) { return session && !session.blocked; } // admin/trader/viewer/extern all can view

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

    const total   = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals`).first();
    const wins    = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'WIN'`).first();
    const losses  = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'LOSS'`).first();
    const open    = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'OPEN'`).first();
    const avgWin  = await env.DB.prepare(`SELECT AVG(pnl_pct) as a FROM signals WHERE outcome = 'WIN'`).first();
    const avgLoss = await env.DB.prepare(`SELECT AVG(pnl_pct) as a FROM signals WHERE outcome = 'LOSS'`).first();

    const winRate    = computeWinRate(wins.count, losses.count);
    const avgWinPct  = parseFloat((avgWin.a || 0).toFixed(2));
    const avgLossPct = parseFloat((avgLoss.a || 0).toFixed(2));
    const expectancy = computeExpectancy(wins.count, losses.count, avgWinPct, avgLossPct);

    return {
      total: total.count || 0,
      wins: wins.count || 0,
      losses: losses.count || 0,
      open: open.count || 0,
      winRate,
      avgWinPct,
      avgLossPct,
      expectancy
    };
  } catch (error) {
    console.error('Error in getStats:', error);
    return { total: 0, wins: 0, losses: 0, open: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0, expectancy: 0 };
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
    return rows.results || [];
  } catch (error) {
    console.error('Error in getHistory:', error);
    return [];
  }
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
    const startCap = parseFloat(env.STARTING_CAPITAL || '10000');
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
    return await env.DB.prepare(
      `SELECT * FROM signals WHERE outcome = 'OPEN' ORDER BY ai_score DESC LIMIT 1`
    ).first();
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
// ═══════════════════════════════════════════════════════════════
// 3H PROFIT-CLOSE (cron every 3h)
// Offene Trades die ≥ 3h alt sind: wenn im Profit → schließen;
// wenn nicht → offen lassen und beim nächsten 3h-Check erneut prüfen.
// ═══════════════════════════════════════════════════════════════

async function check3hProfitClose(env) {
  const THREE_H_MS  = 3 * 60 * 60 * 1000;
  const cutoff      = Date.now() - THREE_H_MS;
  const results     = [];

  try {
    const open = await env.DB.prepare(`
      SELECT * FROM signals
      WHERE outcome = 'OPEN' AND created_at <= ?
      ORDER BY created_at ASC
    `).bind(cutoff).all();

    console.log(`⏳ 3h profit-check: ${(open.results || []).length} offene Trades ≥ 3h`);

    for (const signal of (open.results || [])) {
      const currentPrice = await getLivePrice(env, signal.symbol);
      if (!currentPrice) {
        results.push({ id: signal.id, status: 'no_price' });
        continue;
      }

      const isLong    = signal.direction === 'LONG';
      const entryPrice = parseFloat(signal.ai_entry || signal.price || 0);
      if (!entryPrice) { results.push({ id: signal.id, status: 'no_entry' }); continue; }

      const inProfit  = isLong ? currentPrice > entryPrice : currentPrice < entryPrice;

      if (inProfit) {
        const pnlPct  = isLong
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - currentPrice) / entryPrice) * 100;
        const now     = Date.now();
        const duration = formatDuration(now - (signal.created_at || now));

        const closeResult = await closeTrade(env, {
          signalId: signal.id,
          outcome: 'WIN',
          exitPrice: currentPrice,
          pnlPct: parseFloat(pnlPct.toFixed(2)),
          outcomeSource: '3H_PROFIT_CLOSE'
        });

        // Skip the notification if a concurrent path already closed this signal —
        // otherwise we'd report this invocation's (possibly stale) price/PnL
        // even though different values were the ones actually persisted.
        if (closeResult.closedSignal) {
          await sendTelegramMessage(env,
            `⏱️ <b>3H-PROFIT-CLOSE — ${signal.symbol} ${signal.direction}</b>\n\n` +
            `✅ Im Profit nach ${duration} geschlossen\n` +
            `Entry: $${entryPrice.toFixed(2)} · Exit: $${currentPrice.toFixed(2)}\n` +
            `PnL: <b>+${pnlPct.toFixed(2)}%</b>\n\n` +
            `<i>Automatisch geschlossen nach 3h-Profit-Check</i>`
          );
          console.log(`✅ 3h-Profit-Close: ${signal.id} | ${signal.symbol} | +${pnlPct.toFixed(2)}%`);
        }
        results.push({ id: signal.id, status: 'closed_profit', pnlPct: pnlPct.toFixed(2), symbol: signal.symbol });
      } else {
        results.push({ id: signal.id, status: 'open_no_profit', symbol: signal.symbol });
        console.log(`⏳ 3h-Check: ${signal.id} | ${signal.symbol} – noch nicht im Profit, weiter offen`);
      }
    }

    // Also check practice trades ≥ 3h
    const openPT = await env.DB.prepare(`
      SELECT * FROM practice_trades
      WHERE status = 'OPEN' AND created_at <= ?
    `).bind(new Date(cutoff).toISOString()).all();

    for (const pt of (openPT.results || [])) {
      const currentPrice = await getLivePrice(env, pt.symbol);
      if (!currentPrice) continue;
      const isLong   = pt.direction === 'LONG';
      const inProfit = isLong ? currentPrice > pt.entry_price : currentPrice < pt.entry_price;
      if (inProfit) {
        const resultPct = isLong
          ? ((currentPrice - pt.entry_price) / pt.entry_price) * 100
          : ((pt.entry_price - currentPrice) / pt.entry_price) * 100;
        await closeTrade(env, {
          practiceTradeId: pt.id,
          outcome: 'WIN',
          exitPrice: currentPrice,
          pnlPct: parseFloat(resultPct.toFixed(2)),
          outcomeSource: '3H_PROFIT_CLOSE'
        });
      }
    }
  } catch (err) {
    console.error('❌ check3hProfitClose error:', err.message);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// AUTO-EVALUATION (cron)
// ═══════════════════════════════════════════════════════════════

async function evaluateOpenTrades(env) {
  try {
    const open = await env.DB.prepare(`
      SELECT * FROM signals WHERE outcome = 'OPEN' AND ai_tp IS NOT NULL AND ai_sl IS NOT NULL
      ORDER BY created_at ASC
    `).all();

    for (const signal of (open.results || [])) {
      const price = await getLivePrice(env, signal.symbol);
      if (!price) continue;

      const isLong = signal.direction === 'LONG';
      let outcome = null;
      let hitLevel = null;

      if (isLong) {
        if (price >= signal.ai_tp) { outcome = 'WIN';  hitLevel = signal.ai_tp; }
        else if (price <= signal.ai_sl) { outcome = 'LOSS'; hitLevel = signal.ai_sl; }
      } else {
        if (price <= signal.ai_tp) { outcome = 'WIN';  hitLevel = signal.ai_tp; }
        else if (price >= signal.ai_sl) { outcome = 'LOSS'; hitLevel = signal.ai_sl; }
      }

      if (outcome) {
        const exitPrice = hitLevel || price;
        const entry     = signal.ai_entry || price;
        const pnlPct    = isLong
          ? ((exitPrice - entry) / entry) * 100
          : ((entry - exitPrice) / entry) * 100;
        const duration  = formatDuration(Date.now() - (signal.created_at || Date.now()));

        const closeResult = await closeTrade(env, {
          signalId: signal.id,
          outcome,
          exitPrice,
          pnlPct: parseFloat(pnlPct.toFixed(2)),
          outcomeSource: 'auto',
          telegramOutcomeSent: 1
        });

        // Skip the notification if a concurrent path (e.g. check3hProfitClose
        // or checkOpenSignals) already closed this signal first.
        if (closeResult.closedSignal) {
          const isWin     = outcome === 'WIN';
          const hitEmoji  = isWin ? '🎯' : '🛑';
          const hitLabel  = isWin ? 'TP HIT' : 'SL HIT';
          const pnlSign   = pnlPct >= 0 ? '+' : '';
          const tpLine    = isWin
            ? `TP: $${signal.ai_tp?.toFixed(2)}`
            : `SL: $${signal.ai_sl?.toFixed(2)}`;

          await sendTelegramMessage(env,
            `${hitEmoji} <b>${hitLabel} — ${signal.symbol} ${signal.direction}</b>\n` +
            `Ergebnis: <b>${outcome}</b>\n\n` +
            `Entry: $${entry.toFixed(2)} · ${tpLine} · Exit: $${exitPrice.toFixed(2)}\n` +
            `PnL: <b>${pnlSign}${pnlPct.toFixed(2)}%</b> · Dauer: ${duration}`
          );
          console.log(`📊 Signal ${signal.id} closed: ${outcome} | PnL: ${pnlPct.toFixed(2)}% | ${duration}`);
        }
      }
    }
    console.log('✅ evaluateOpenTrades done');
  } catch (err) {
    console.error('evaluateOpenTrades error:', err);
  }
}

async function sendDailySummary(env) {
  try {
    const stats = await getStats(env);
    const history = await getHistory(env, 5);
    const recentList = history.length > 0
      ? history.map(s => `• ${s.symbol} ${s.direction} · Score ${s.ai_score} · ${s.outcome}`).join('\n')
      : 'Keine aktuellen Trades';

    await sendTelegramMessage(env,
      `📊 <b>WAVESCOUT Tagesbericht</b>\n\n` +
      `📈 Statistiken:\n• Total: ${stats.total} Trades\n• Wins: ${stats.wins} | Losses: ${stats.losses} | Offen: ${stats.open}\n• Win-Rate: ${stats.winRate}%\n\n` +
      `🕐 Letzte Signale:\n${recentList}\n\n⏰ ${new Date().toLocaleString('de-DE')}`
    );
  } catch (err) {
    console.error('sendDailySummary error:', err);
  }
}

function evaluateOutcomeForSignal(signal, price) {
  if (!price || !Number.isFinite(price)) return { outcome: 'NO_PRICE', hitLevel: null };
  if (signal.ai_tp == null || signal.ai_sl == null) return { outcome: 'OPEN', hitLevel: null };
  const isLong = signal.direction === 'LONG';
  if (isLong) {
    if (price >= signal.ai_tp) return { outcome: 'WIN', hitLevel: signal.ai_tp };
    if (price <= signal.ai_sl) return { outcome: 'LOSS', hitLevel: signal.ai_sl };
  } else {
    if (price <= signal.ai_tp) return { outcome: 'WIN', hitLevel: signal.ai_tp };
    if (price >= signal.ai_sl) return { outcome: 'LOSS', hitLevel: signal.ai_sl };
  }
  return { outcome: 'OPEN', hitLevel: null };
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
    const { outcome, hitLevel } = evaluateOutcomeForSignal(signal, price);
    const item = {
      id: signal.id, symbol: signal.symbol, direction: signal.direction,
      entry: signal.ai_entry, tp: signal.ai_tp, sl: signal.ai_sl, price
    };
    if (!price || !Number.isFinite(price)) {
      item.status  = 'no_price';
      item.outcome = null;
      item.message = `Kein Preis für ${signal.symbol}`;
    } else if (outcome === 'WIN' || outcome === 'LOSS') {
      const entry = signal.ai_entry || price;
      const exitPrice = hitLevel || price;
      const pnlPct = signal.direction === 'LONG'
        ? ((exitPrice - entry) / entry) * 100
        : ((entry - exitPrice) / entry) * 100;
      await closeTrade(env, {
        signalId: signal.id,
        outcome,
        exitPrice,
        pnlPct: parseFloat(pnlPct.toFixed(2)),
        outcomeSource: 'auto'
      });
      item.status  = 'closed';
      item.outcome = outcome;
      item.message = `${outcome} — Preis ${price} hat ${outcome === 'WIN' ? 'TP' : 'SL'} erreicht`;
    } else {
      item.status  = 'open';
      item.outcome = 'OPEN';
      item.message = 'Weiter offen';
    }
    checked.push(item);
  }
  return checked;
}

// ═══════════════════════════════════════════════════════════════
// HTMX MPA — HTML SHELL & PAGE RENDERING
// ═══════════════════════════════════════════════════════════════

const CSS_STYLES = `/* ═══════════════════════════════════════════════════════════════
   WAVESCOUT v3.5 — DESIGN SYSTEM
   ═══════════════════════════════════════════════════════════ */
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg-0:#0A0E1A;--bg-1:#111827;--bg-2:#151B2B;--bg-3:#1E2840;--bg-4:#2A3450;
  --gradient-body:linear-gradient(160deg,#0A0E1A 0%,#111827 100%);
  --gradient-card-hero:linear-gradient(135deg,#1E293B 0%,#0F172A 100%);
  --gradient-sidebar:linear-gradient(180deg,#111827 0%,#0A0E1A 100%);
  --text-primary:#F1F5F9;--text-secondary:#94A3B8;--text-tertiary:#64748B;--text-quaternary:#4A5568;
  --border:#1F2937;--border-hover:rgba(255,255,255,0.14);--border-focus:rgba(59,130,246,0.6);
  --blue-500:#3B82F6;--blue-600:#2563EB;--blue-400:#60A5FA;--accent:#3B82F6;
  --win:#10b981;--loss:#f04f4f;--wait:#f59e0b;
  --bg-success:rgba(16,185,129,0.09);--bg-error:rgba(240,79,79,0.09);--bg-warning:rgba(245,158,11,0.09);
  --shadow-sm:0 1px 3px rgba(0,0,0,0.4),0 1px 2px rgba(0,0,0,0.2);
  --shadow-md:0 4px 12px rgba(0,0,0,0.4),0 2px 4px rgba(0,0,0,0.2);
  --shadow-lg:0 12px 32px rgba(0,0,0,0.5),0 4px 8px rgba(0,0,0,0.3);
  --font-main:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  --font-mono:'JetBrains Mono','Courier New',monospace;
  --gap:16px;--gap-lg:24px;--radius:12px;--radius-sm:8px;--radius-lg:16px;
  --sidebar-w:220px;--sidebar-w-collapsed:56px;
}
[data-theme="light"]{
  --bg-0:#F8FAFC;--bg-1:#EFF6FF;--bg-2:#FFFFFF;--bg-3:#EFF6FF;--bg-4:#DBEAFE;
  --gradient-body:linear-gradient(160deg,#F8FAFC 0%,#EFF6FF 100%);
  --gradient-card-hero:linear-gradient(135deg,#FFFFFF 0%,#EFF6FF 100%);
  --gradient-sidebar:linear-gradient(180deg,#EFF6FF 0%,#F8FAFC 100%);
  --text-primary:#0F172A;--text-secondary:#64748B;--text-tertiary:#94A3B8;--text-quaternary:#CBD5E1;
  --border:#E2E8F0;--border-hover:rgba(0,0,0,0.14);--border-focus:rgba(59,130,246,0.5);
  --blue-500:#2563EB;--blue-600:#1D4ED8;--blue-400:#3B82F6;--accent:#2563EB;
  --shadow-sm:0 1px 3px rgba(0,0,0,0.08),0 1px 2px rgba(0,0,0,0.05);
  --shadow-md:0 4px 12px rgba(0,0,0,0.08),0 2px 4px rgba(0,0,0,0.04);
  --shadow-lg:0 12px 32px rgba(0,0,0,0.10),0 4px 8px rgba(0,0,0,0.06);
  --bg-success:rgba(16,185,129,0.07);--bg-error:rgba(240,79,79,0.07);--bg-warning:rgba(245,158,11,0.07);
}
[data-theme="light"] .card{box-shadow:var(--shadow-sm)}
[data-theme="light"] .stat{box-shadow:var(--shadow-sm)}
[data-theme="light"] .score-ring::before{background:#ffffff}
[data-theme="light"] .tbl thead{background:var(--bg-2)}
html{font-size:16px;scroll-behavior:smooth}
body{font-family:var(--font-main);background:var(--gradient-body);background-attachment:fixed;color:var(--text-primary);line-height:1.5;-webkit-font-smoothing:antialiased;min-height:100vh}
h1,h2,h3,h4,h5,h6{font-weight:600;line-height:1.2}
h1{font-size:1.875rem}h2{font-size:1.375rem}h3{font-size:1rem}h4{font-size:0.9375rem}
a{color:var(--blue-400);text-decoration:none}
a:hover{text-decoration:underline}
.content{flex:1;padding:var(--gap-lg);max-width:1600px;width:100%;margin:0 auto}
.page-header{margin-bottom:22px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.page-header h2{font-size:1.2rem;font-weight:700;margin-bottom:4px;letter-spacing:-0.01em}
.page-header .subtitle{font-size:12.5px;color:var(--text-tertiary)}
.subtitle{font-size:12px;color:var(--text-tertiary);margin-top:3px}
.card{background:var(--bg-1);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:var(--gap);box-shadow:var(--shadow-sm);transition:box-shadow 0.2s}
.card:hover{box-shadow:var(--shadow-md)}
.card-head{padding:15px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;background:var(--bg-1)}
.card-head h3{flex:1;font-size:14px;font-weight:600;letter-spacing:0.01em}
.card-head .ico{opacity:0.45;flex-shrink:0}
.card-head .actions{display:flex;gap:6px;align-items:center}
.card-body{padding:20px}
.grid{display:grid;gap:var(--gap);margin-bottom:var(--gap)}
.grid-2{grid-template-columns:repeat(2,1fr)}
.grid-3{grid-template-columns:repeat(3,1fr)}
.grid-4{grid-template-columns:repeat(4,1fr)}
@media(max-width:1100px){.grid-4{grid-template-columns:repeat(2,1fr)}}
@media(max-width:700px){.grid,.grid-2,.grid-3,.grid-4{grid-template-columns:1fr}.content{padding:16px 14px}}
.stat{background:var(--bg-1);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;display:flex;flex-direction:column;gap:6px;box-shadow:var(--shadow-sm);transition:box-shadow 0.2s,transform 0.2s;cursor:default}
.stat:hover{box-shadow:var(--shadow-md);transform:translateY(-1px)}
.stat .label{font-size:11px;color:var(--text-quaternary);font-weight:600;text-transform:uppercase;letter-spacing:0.07em}
.stat .value{font-size:28px;font-weight:700;font-family:var(--font-mono);line-height:1.1;letter-spacing:-0.02em}
.stat .sub{font-size:12px}.stat .sub.muted{color:var(--text-tertiary)}.stat .sub.win{color:var(--win)}.stat .sub.loss{color:var(--loss)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:8px 16px;border-radius:var(--radius-sm);font-size:13px;font-weight:600;cursor:pointer;transition:all 0.13s;font-family:var(--font-main);white-space:nowrap;background:var(--bg-3);color:var(--text-secondary);border:1px solid var(--border);letter-spacing:0.01em}
.btn:hover{background:var(--bg-4);color:var(--text-primary);border-color:var(--border-hover)}
.btn:active{transform:scale(0.97)}
.btn:disabled{opacity:0.4;cursor:not-allowed;transform:none}
.btn-primary{background:var(--blue-500);color:white;border-color:transparent;box-shadow:0 2px 8px rgba(59,130,246,0.3)}
.btn-primary:hover{background:var(--blue-600);border-color:transparent;box-shadow:0 4px 12px rgba(59,130,246,0.4)}
.btn-ghost{background:transparent;color:var(--text-tertiary);border:none}
.btn-ghost:hover{background:var(--bg-3);color:var(--text-primary);border:none}
.btn-danger{background:rgba(240,79,79,0.1);color:var(--loss);border:1px solid rgba(240,79,79,0.2)}
.btn-danger:hover{background:rgba(240,79,79,0.18);border-color:rgba(240,79,79,0.45);color:var(--loss)}
.btn-sm{padding:5px 11px;font-size:12px}
.badge{display:inline-flex;align-items:center;padding:3px 8px;border-radius:5px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em}
.badge-tag{background:var(--bg-3);color:var(--text-quaternary);border:1px solid var(--border)}
.badge-long{background:rgba(16,185,129,0.12);color:var(--win)}
.badge-short{background:rgba(240,79,79,0.12);color:var(--loss)}
.badge-win{background:rgba(16,185,129,0.12);color:var(--win)}
.badge-loss{background:rgba(240,79,79,0.12);color:var(--loss)}
.badge-wait{background:rgba(245,158,11,0.12);color:var(--wait)}
.badge-bullish{background:rgba(16,185,129,0.12);color:var(--win)}
.badge-bearish{background:rgba(240,79,79,0.12);color:var(--loss)}
.badge-neutral{background:var(--bg-3);color:var(--text-tertiary)}
.input,input[type="text"],input[type="email"],input[type="password"],input[type="number"],input[type="date"],select,textarea{width:100%;padding:9px 13px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13.5px;font-family:var(--font-main);transition:border-color 0.15s,box-shadow 0.15s;outline:none}
.input:focus,input:focus,select:focus,textarea:focus{border-color:var(--blue-500);background:var(--bg-1);box-shadow:0 0 0 3px rgba(59,130,246,0.12)}
label{font-size:13px;font-weight:500;color:var(--text-secondary)}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl thead{background:var(--bg-0)}
.tbl th{padding:10px 16px;text-align:left;font-weight:600;font-size:11px;color:var(--text-quaternary);text-transform:uppercase;letter-spacing:0.07em;border-bottom:1px solid var(--border);white-space:nowrap}
.tbl td{padding:12px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
.tbl tbody tr:last-child td{border-bottom:none}
.tbl tbody tr{transition:background 0.1s}
.tbl tbody tr:hover{background:rgba(255,255,255,0.025)}
[data-theme="light"] .tbl tbody tr:hover{background:rgba(0,0,0,0.025)}
.mono{font-family:var(--font-mono)}.muted{color:var(--text-tertiary)}.win{color:var(--win)}.loss{color:var(--loss)}
.spinner-lg,.spinner-sm{border:2.5px solid var(--bg-4);border-top-color:var(--blue-500);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0}
.spinner-lg{width:44px;height:44px}.spinner-sm{width:15px;height:15px;border-width:2px}
@keyframes spin{to{transform:rotate(360deg)}}
.page-enter{animation:fadeUp 0.28s ease-out}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.asset-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;background:var(--bg-3);border:1px solid var(--border);border-radius:6px;font-size:12.5px;font-weight:600;font-family:var(--font-mono);white-space:nowrap}
.asset-icon{width:18px;height:18px;border-radius:50%;background:linear-gradient(135deg,var(--blue-500),#6366f1);display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:white;font-weight:700;flex-shrink:0}
.score-ring{width:96px;height:96px;border-radius:50%;background:conic-gradient(var(--score-color,var(--blue-500)) calc(var(--pct) * 1%),var(--bg-3) calc(var(--pct) * 1%));display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;transition:filter 0.3s}
.score-ring.score-high{filter:drop-shadow(0 0 10px rgba(16,185,129,0.35))}
.score-ring.score-med{filter:drop-shadow(0 0 8px rgba(245,158,11,0.3))}
.score-ring.score-low{filter:drop-shadow(0 0 8px rgba(240,79,79,0.25))}
.score-ring::before{content:'';position:absolute;width:76px;height:76px;border-radius:50%;background:var(--bg-1)}
.score-text{font-size:26px;font-weight:700;font-family:var(--font-mono);position:relative;z-index:1;letter-spacing:-0.02em}
.score-sub{font-size:9px;color:var(--text-quaternary);position:relative;z-index:1;font-weight:700;letter-spacing:0.12em;text-transform:uppercase}
.signal-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}
.signal-meta .cell{display:flex;flex-direction:column;gap:3px}
.signal-meta .l{font-size:10px;color:var(--text-quaternary);text-transform:uppercase;letter-spacing:0.07em;font-weight:600}
.signal-meta .v{font-size:15px;font-weight:700}
.bias-row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--border);transition:background 0.1s}
.bias-row:last-child{border-bottom:none}
.best-signal-card{background:var(--gradient-card-hero);border-color:rgba(59,130,246,0.2)}
.best-signal-card .card-head{background:transparent;border-bottom-color:rgba(59,130,246,0.15)}
.best-signal-card .card-body{padding:22px}
.best-signal-grid{display:grid;grid-template-columns:1fr auto;gap:24px}
.portfolio-card{background:var(--gradient-card-hero);border-color:rgba(59,130,246,0.15)}
.portfolio-card .card-head{background:transparent;border-bottom-color:rgba(59,130,246,0.1)}
.user-avatar-sm{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,var(--blue-500),#6366f1);display:flex;align-items:center;justify-content:center;color:white;font-size:11px;font-weight:700;flex-shrink:0}
.status-pill{display:flex;align-items:center;gap:6px;padding:4px 10px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:20px;font-size:10.5px;font-weight:700;color:var(--win);white-space:nowrap;letter-spacing:0.04em}
.status-dot{width:6px;height:6px;border-radius:50%;background:var(--win);flex-shrink:0}
.status-pulse{animation:pulse 2.8s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.45;transform:scale(0.75)}}
.sidebar{position:fixed;top:0;left:0;height:100vh;width:var(--sidebar-w);background:var(--gradient-sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;z-index:100;transition:width 0.2s ease;overflow:hidden}
.sidebar.collapsed{width:var(--sidebar-w-collapsed)}
.sidebar.collapsed .sidebar-brand-name,.sidebar.collapsed .link-label,.sidebar.collapsed .sidebar-user-info{display:none}
.sidebar-brand{display:flex;align-items:center;gap:10px;padding:0 14px;height:54px;border-bottom:1px solid var(--border);flex-shrink:0}
.sidebar-brand-name{font-weight:700;font-size:13px;letter-spacing:0.12em;color:var(--text-primary);white-space:nowrap;overflow:hidden}
.sidebar-toggle{margin-left:auto;background:none;border:none;cursor:pointer;color:var(--text-tertiary);padding:4px;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:color 0.15s,background 0.15s}
.sidebar-toggle:hover{color:var(--text-primary);background:var(--bg-3)}
.sidebar-nav{flex:1;padding:12px 8px;display:flex;flex-direction:column;gap:2px;overflow-y:auto;overflow-x:hidden}
.sidebar-link{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;border:none;background:none;cursor:pointer;font-size:13px;font-weight:500;color:var(--text-secondary);font-family:var(--font-main);text-decoration:none;transition:background 0.12s,color 0.12s;white-space:nowrap;overflow:hidden;width:100%}
.sidebar-link:hover{background:var(--bg-2);color:var(--text-primary);text-decoration:none}
.sidebar-link.active{background:rgba(59,130,246,0.12);color:var(--blue-400)}
.sidebar-link .link-label{white-space:nowrap;overflow:hidden}
.sidebar-sep{height:1px;background:var(--border);margin:8px 8px;flex-shrink:0}
.sidebar-bottom{padding:8px;border-top:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:2px}
.sidebar-user-btn{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;border:none;background:none;cursor:pointer;width:100%;font-family:var(--font-main);transition:background 0.12s;overflow:hidden}
.sidebar-user-btn:hover{background:var(--bg-2)}
.sidebar-user-info{text-align:left;overflow:hidden}
.sidebar-user-name{font-size:12px;font-weight:600;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sidebar-user-role{font-size:10px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.06em}
.app-with-sidebar{display:flex;min-height:100vh}
.app-main{flex:1;margin-left:var(--sidebar-w);transition:margin-left 0.2s ease;min-height:100vh}
.app-main.sidebar-collapsed{margin-left:var(--sidebar-w-collapsed)}
.sidebar-status{display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:10px;font-weight:700;letter-spacing:0.08em;color:var(--win)}
@media(max-width:768px){.best-signal-grid{grid-template-columns:1fr}.signal-meta{grid-template-columns:1fr 1fr}}
`;

function _svgIcon(name, size = 16) {
  const paths = {
    home:     '<path d="M3 12 12 4l9 8"/><path d="M5 10v10h14V10"/>',
    chart:    '<path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-7"/>',
    book:     '<path d="M4 4a2 2 0 0 1 2-2h13v18H6a2 2 0 0 0-2 2V4z"/><path d="M4 4v16a2 2 0 0 0 2 2"/>',
    bell:     '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
    stats:    '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="14" width="3" height="4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.7l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.7-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.7.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.7 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.7.3h.1a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.7-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.7v.1a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    logout:   '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    bolt:     '<path d="m13 2-9 12h7l-1 8 9-12h-7z"/>',
    target:   '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    cpu:      '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
    chevron:  '<path d="m6 9 6 6 6-6"/>',
    moon:     '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    signal:   '<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4 12 14l-4-4-6 6"/>',
    clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    users:    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    key:      '<circle cx="7.5" cy="15.5" r="5.5"/><path d="M21 2 10.94 12.06M21 2h-4.5M21 2v4.5M16.5 7.5l-2 2"/>',
  };
  const d = paths[name] || '<circle cx="12" cy="12" r="10"/>';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

function _esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _fmtNum(n, d = 2) {
  if (n == null || isNaN(Number(n))) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function _fmtPct(n) {
  if (n == null || isNaN(Number(n))) return '—';
  return `${Number(n).toFixed(1)}%`;
}

function _fmtDate(ts) {
  if (!ts) return '—';
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const _FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

function _renderSidebar(activePage, user) {
  const nav = [
    { id: 'dashboard',   label: 'Dashboard',  icon: 'home',     path: '/dashboard' },
    { id: 'backtesting', label: 'Backtesting', icon: 'chart',    path: '/backtesting' },
    { id: 'journal',     label: 'Journal',     icon: 'book',     path: '/journal' },
    { id: 'news',        label: 'News',        icon: 'bell',     path: '/news' },
    { id: 'statistiken', label: 'Statistiken', icon: 'stats',    path: '/analytics' },
  ];
  const initials = _esc((user?.username || '?').charAt(0).toUpperCase());
  const username = _esc(user?.username || '');
  const role     = _esc(user?.role || 'user');
  return `
<nav class="sidebar" id="sidebar">
  <div class="sidebar-brand">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--blue-400)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0 4 3 2 0"/>
    </svg>
    <span class="sidebar-brand-name">WAVESCOUT</span>
    <button class="sidebar-toggle" onclick="toggleSidebar()" title="Sidebar ein/ausblenden">${_svgIcon('chevron', 13)}</button>
  </div>
  <div class="sidebar-nav">
    ${nav.map(n => `
    <a href="${n.path}" class="sidebar-link${activePage === n.id ? ' active' : ''}"
       hx-get="${n.path}" hx-target="#content" hx-push-url="true" hx-swap="innerHTML">
      ${_svgIcon(n.icon, 15)}<span class="link-label">${n.label}</span>
    </a>`).join('')}
  </div>
  <div class="sidebar-sep"></div>
  <div class="sidebar-bottom">
    <a href="/settings" class="sidebar-link${activePage === 'einstellungen' ? ' active' : ''}"
       hx-get="/settings" hx-target="#content" hx-push-url="true" hx-swap="innerHTML">
      ${_svgIcon('settings', 15)}<span class="link-label">Einstellungen</span>
    </a>
    <div class="sidebar-user-btn">
      <div class="user-avatar-sm">${initials}</div>
      <div class="sidebar-user-info">
        <div class="sidebar-user-name">${username}</div>
        <div class="sidebar-user-role">${role}</div>
      </div>
    </div>
    <a href="/logout" class="sidebar-link">${_svgIcon('logout', 15)}<span class="link-label">Abmelden</span></a>
  </div>
</nav>`;
}

function _htmlPage({ title = 'WAVESCOUT', content, activePage, user }) {
  return `<!DOCTYPE html>
<html lang="de" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${_esc(title)} — WAVESCOUT</title>
  ${_FONT_LINK}
  <link rel="stylesheet" href="/styles.css">
  <script src="https://unpkg.com/htmx.org@2.0.4" defer><\/script>
</head>
<body>
  <div class="app-with-sidebar">
    ${_renderSidebar(activePage, user)}
    <main class="app-main" id="content">${content}</main>
  </div>
  <script>
    (function(){
      const t = localStorage.getItem('wavescout_theme') || 'dark';
      document.documentElement.setAttribute('data-theme', t);
    })();
    function toggleSidebar() {
      const s = document.getElementById('sidebar');
      const m = document.getElementById('content');
      s.classList.toggle('collapsed');
      if (m) m.classList.toggle('sidebar-collapsed');
      localStorage.setItem('wavescout_sidebar', s.classList.contains('collapsed') ? '1' : '0');
    }
    document.addEventListener('htmx:afterSettle', function() {
      const path = window.location.pathname;
      document.querySelectorAll('.sidebar-link[href]').forEach(el => {
        el.classList.toggle('active', el.getAttribute('href') === path);
      });
    });
    window.addEventListener('DOMContentLoaded', function() {
      if (localStorage.getItem('wavescout_sidebar') === '1') toggleSidebar();
    });
  <\/script>
</body>
</html>`;
}

function _renderLoginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WAVESCOUT — Login</title>
  ${_FONT_LINK}
  <style>
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    :root{--bg-0:#060F1F;--bg-1:#0A1628;--border:rgba(148,175,230,0.14);--text-primary:#E8EEFB;--text-secondary:#94A8CC;--text-tertiary:#5E739B;--blue-500:#3B82F6;--blue-600:#2563EB;--font-main:'Geist',-apple-system,sans-serif}
    body{background:linear-gradient(rgba(6,15,31,0.82),rgba(6,15,31,0.82)),#060F1F;color:var(--text-primary);font-family:var(--font-main);min-height:100vh;display:flex;align-items:center;justify-content:center}
    .login-container{width:100%;max-width:420px;padding:20px}
    .login-card{background:rgba(8,18,34,0.62);backdrop-filter:blur(14px);border:1px solid rgba(135,163,218,0.28);border-radius:16px;padding:40px;box-shadow:0 20px 54px rgba(2,8,20,0.58)}
    .logo{text-align:center;margin-bottom:32px}
    .logo-icon{width:48px;height:48px;background:linear-gradient(135deg,var(--blue-500),var(--blue-600));border-radius:12px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px}
    .logo-text{font-size:24px;font-weight:700;letter-spacing:-0.02em}
    .logo-sub{font-size:12px;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.1em;margin-top:4px}
    .form-group{margin-bottom:20px}
    .form-group label{display:block;font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:8px}
    .input{width:100%;background:rgba(4,11,25,0.72);border:1px solid rgba(124,152,205,0.24);border-radius:8px;padding:12px 14px;font-size:14px;color:var(--text-primary);font-family:var(--font-main);transition:all 0.2s;outline:none}
    .input:focus{border-color:var(--blue-500);box-shadow:0 0 0 3px rgba(59,130,246,0.1)}
    .btn{width:100%;background:linear-gradient(180deg,var(--blue-500),var(--blue-600));border:1px solid var(--blue-500);border-radius:8px;padding:12px;font-size:14px;font-weight:600;color:white;cursor:pointer;transition:all 0.2s;font-family:var(--font-main)}
    .btn:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(59,130,246,0.4)}
    .error-msg{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;font-size:13px;color:#FCA5A5;margin-bottom:20px}
    .info-text{font-size:12px;color:var(--text-tertiary);text-align:center;margin-top:24px;padding-top:24px;border-top:1px solid var(--border)}
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-card">
      <div class="logo">
        <div class="logo-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4">
            <path d="M2 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0 4 3 2 0"/>
          </svg>
        </div>
        <div class="logo-text">WAVESCOUT</div>
        <div class="logo-sub">Trading Intel</div>
      </div>
      ${error ? `<div class="error-msg">${_esc(error)}</div>` : ''}
      <form method="POST" action="/login">
        <div class="form-group">
          <label for="username">Benutzername</label>
          <input type="text" class="input" id="username" name="username" placeholder="Benutzername" required autocomplete="username">
        </div>
        <div class="form-group">
          <label for="password">Passwort</label>
          <input type="password" class="input" id="password" name="password" placeholder="Dein Passwort" required autocomplete="current-password">
        </div>
        <button type="submit" class="btn">Anmelden</button>
      </form>
      <div class="info-text">Bei Problemen wende dich an einen Administrator.</div>
    </div>
  </div>
</body>
</html>`;
}

function _renderChangePwPage(error = '') {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WAVESCOUT — Passwort ändern</title>
  ${_FONT_LINK}
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{background:#060F1F;color:#E8EEFB;font-family:'Geist',-apple-system,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{background:rgba(8,18,34,0.7);border:1px solid rgba(148,175,230,0.2);border-radius:16px;padding:40px;max-width:420px;width:calc(100% - 40px)}
    h2{font-size:20px;margin-bottom:8px}
    p{font-size:13px;color:#94A8CC;margin-bottom:24px}
    label{display:block;font-size:13px;font-weight:600;color:#94A8CC;margin-bottom:8px}
    input{width:100%;background:rgba(4,11,25,0.72);border:1px solid rgba(124,152,205,0.24);border-radius:8px;padding:12px 14px;font-size:14px;color:#E8EEFB;font-family:inherit;outline:none;margin-bottom:20px}
    input:focus{border-color:#3B82F6}
    button{width:100%;background:linear-gradient(180deg,#3B82F6,#2563EB);border:none;border-radius:8px;padding:12px;font-size:14px;font-weight:600;color:white;cursor:pointer;font-family:inherit}
    .error-msg{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:12px;font-size:13px;color:#FCA5A5;margin-bottom:20px}
  </style>
</head>
<body>
  <div class="card">
    <h2>Passwort ändern</h2>
    <p>Bitte setze ein neues Passwort für dein Konto.</p>
    ${error ? `<div class="error-msg">${_esc(error)}</div>` : ''}
    <form method="POST" action="/change-password">
      <label for="newPassword">Neues Passwort</label>
      <input type="password" id="newPassword" name="newPassword" placeholder="Mindestens 8 Zeichen" required autocomplete="new-password">
      <button type="submit">Passwort speichern</button>
    </form>
  </div>
</body>
</html>`;
}

function _renderDashboardContent(data) {
  const { stats: s = {}, bestSignal, latestSignals, marketBias } = data;
  const pnlColor = v => (v >= 0 ? 'color:var(--win)' : 'color:var(--loss)');
  const pnlSign  = v => (v >= 0 ? '+' : '');

  const statCards = `
<div class="grid grid-4">
  <div class="stat">
    <div class="label">Portfolio</div>
    <div class="value" style="font-size:22px">${_fmtNum(s.equity)} USDT</div>
    <div class="sub muted">Start: ${_fmtNum(s.startingCapital)} USDT</div>
  </div>
  <div class="stat">
    <div class="label">Gesamt P&amp;L</div>
    <div class="value" style="font-size:22px;${pnlColor(s.totalPnL)}">${pnlSign(s.totalPnL)}${_fmtNum(s.totalPnL)} USDT</div>
    <div class="sub muted">Heute: <span style="${pnlColor(s.todayPnL)}">${pnlSign(s.todayPnL)}${_fmtNum(s.todayPnL)}</span></div>
  </div>
  <div class="stat">
    <div class="label">Win-Rate</div>
    <div class="value" style="font-size:22px">${_fmtPct(s.winRate)}</div>
    <div class="sub muted">${s.wins || 0}W / ${s.losses || 0}L (${s.totalTrades || 0} Total)</div>
  </div>
  <div class="stat">
    <div class="label">Offene Trades</div>
    <div class="value" style="font-size:22px">${s.open || 0}</div>
    <div class="sub muted">Aktive Positionen</div>
  </div>
</div>`;

  let bestSignalHtml = '';
  if (bestSignal) {
    const score = bestSignal.ai_score || 0;
    const pct   = Math.min(100, score);
    const scoreClass = score >= 80 ? 'score-high' : score >= 65 ? 'score-med' : 'score-low';
    const scoreColor = score >= 80 ? 'var(--win)' : score >= 65 ? 'var(--wait)' : 'var(--loss)';
    const dirClass   = bestSignal.direction === 'LONG' ? 'badge-long' : 'badge-short';
    bestSignalHtml = `
<div class="card best-signal-card">
  <div class="card-head">
    <span class="ico">${_svgIcon('bolt', 14)}</span>
    <h3>Bestes offenes Signal</h3>
    <span class="badge ${dirClass}">${_esc(bestSignal.direction || '')}</span>
  </div>
  <div class="card-body">
    <div class="best-signal-grid">
      <div>
        <div style="font-size:24px;font-weight:700;font-family:var(--font-mono);margin-bottom:8px">${_esc(bestSignal.symbol || '')}</div>
        <div class="signal-meta">
          <div class="cell"><div class="l">Einstieg</div><div class="v">${_fmtNum(bestSignal.entry_price, 4)}</div></div>
          <div class="cell"><div class="l">Take Profit</div><div class="v" style="color:var(--win)">${_fmtNum(bestSignal.tp_price, 4)}</div></div>
          <div class="cell"><div class="l">Stop Loss</div><div class="v" style="color:var(--loss)">${_fmtNum(bestSignal.sl_price, 4)}</div></div>
        </div>
        <div style="margin-top:10px;font-size:11px;color:var(--text-quaternary)">${_fmtDate(bestSignal.created_at)}${bestSignal.telegram_sent ? ' <span class="badge badge-win" style="font-size:10px;margin-left:6px">📱 Telegram</span>' : ''}</div>
        ${bestSignal.ai_reason ? `<div style="margin-top:14px;padding:10px 12px;background:var(--bg-0);border-radius:8px;font-size:13px;line-height:1.6;border-left:3px solid var(--blue-500)"><div style="font-size:11px;color:var(--blue-400);margin-bottom:4px;font-weight:600">${_svgIcon('cpu', 11)} KI-Analyse</div>${_esc(bestSignal.ai_reason)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;justify-content:center">
        <div class="score-ring ${scoreClass}" style="--pct:${pct};--score-color:${scoreColor}">
          <div class="score-text">${score}</div>
          <div class="score-sub">SCORE</div>
        </div>
      </div>
    </div>
  </div>
</div>`;
  } else {
    bestSignalHtml = `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine offenen Signale</div></div>`;
  }

  let biasHtml = '';
  if (marketBias && marketBias.length > 0) {
    biasHtml = `
<div class="card">
  <div class="card-head"><span class="ico">${_svgIcon('chart', 14)}</span><h3>Markt-Bias</h3></div>
  <div class="card-body" style="padding:0">
    ${marketBias.map(b => {
      const tc  = b.trend === 'bullish' ? 'badge-bullish' : b.trend === 'bearish' ? 'badge-bearish' : 'badge-neutral';
      const cc  = b.change >= 0 ? 'var(--win)' : 'var(--loss)';
      return `<div class="bias-row" style="padding:11px 20px">
        <div class="asset-chip"><div class="asset-icon">${_esc((b.symbol || '?').charAt(0))}</div>${_esc(b.symbol || '')}</div>
        <div style="flex:1;font-size:13px;font-family:var(--font-mono);font-weight:600">${_fmtNum(b.price, 2)}</div>
        <div style="font-size:13px;font-weight:600;color:${cc}">${b.change >= 0 ? '+' : ''}${_fmtNum(b.change, 2)}%</div>
        <span class="badge ${tc}">${_esc(b.trend || 'neutral')}</span>
        ${b.rsi != null ? `<div style="font-size:11px;color:var(--text-quaternary)">RSI ${_fmtNum(b.rsi, 1)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>
</div>`;
  }

  let signalsHtml = '';
  if (latestSignals && latestSignals.length > 0) {
    signalsHtml = `
<div class="card">
  <div class="card-head"><span class="ico">${_svgIcon('chart', 14)}</span><h3>Letzte Signale</h3></div>
  <div style="overflow-x:auto">
    <table class="tbl">
      <thead><tr>
        <th>Symbol</th><th>Richtung</th><th>Score</th>
        <th>Einstieg</th><th>TP</th><th>SL</th>
        <th>Ergebnis</th><th>Zeit</th>
      </tr></thead>
      <tbody>
        ${latestSignals.map(sig => {
          const dc = sig.direction === 'LONG' ? 'badge-long' : 'badge-short';
          const oc = sig.outcome === 'WIN' ? 'win' : sig.outcome === 'LOSS' ? 'loss' : 'muted';
          return `<tr>
            <td style="font-family:var(--font-mono);font-weight:600">${_esc(sig.symbol || '')}</td>
            <td><span class="badge ${dc}">${_esc(sig.direction || '')}</span></td>
            <td class="mono">${sig.ai_score || '—'}</td>
            <td class="mono">${_fmtNum(sig.entry_price, 4)}</td>
            <td class="mono" style="color:var(--win)">${_fmtNum(sig.tp_price, 4)}</td>
            <td class="mono" style="color:var(--loss)">${_fmtNum(sig.sl_price, 4)}</td>
            <td class="${oc}">${_esc(sig.outcome || 'OPEN')}</td>
            <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(sig.created_at)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
</div>`;
  }

  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Dashboard</h2>
    <div class="subtitle">Live Portfolio &amp; Signale — WAVESCOUT v3.5</div>
  </div>
  ${statCards}
  <div class="grid grid-2" style="margin-bottom:0">
    <div>${bestSignalHtml}${biasHtml}</div>
    <div>${signalsHtml}</div>
  </div>
</div>`;
}

function _renderPlaceholderPage(pageName) {
  const labels = { backtesting: 'Backtesting', statistiken: 'Statistiken', einstellungen: 'Einstellungen' };
  const label = labels[pageName] || pageName;
  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>${_esc(label)}</h2>
    <div class="subtitle">HTMX-Migration in Arbeit</div>
  </div>
  <div class="card">
    <div class="card-body" style="text-align:center;padding:60px;color:var(--text-tertiary)">
      <div style="font-size:32px;margin-bottom:16px">🔨</div>
      <div style="font-weight:600;font-size:15px;margin-bottom:8px">In Bearbeitung</div>
      <div style="font-size:13px">Diese Seite wird in der nächsten Migrationsphase umgesetzt.</div>
    </div>
  </div>
</div>`;
}

// ── Journal helpers ─────────────────────────────────────────────

function _renderJournalTable(signals, outcome) {
  if (!signals || signals.length === 0) {
    return `<div id="journal-table" style="text-align:center;padding:40px;color:var(--text-tertiary);font-size:13px">Keine Trades für diesen Filter</div>`;
  }
  const rows = signals.map(s => {
    const dirClass = s.direction === 'LONG' ? 'badge-long' : 'badge-short';
    const oc       = s.outcome === 'WIN' ? 'win' : s.outcome === 'LOSS' ? 'loss' : s.outcome === 'BE' ? '' : 'muted';
    const pnl      = s.exit_price && s.entry_price
      ? (s.direction === 'LONG'
          ? ((s.exit_price - s.entry_price) / s.entry_price * 100)
          : ((s.entry_price - s.exit_price) / s.entry_price * 100))
      : null;
    const pnlStr   = pnl != null ? `<span style="${pnl >= 0 ? 'color:var(--win)' : 'color:var(--loss)'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%</span>` : '—';
    return `<tr>
      <td style="font-family:var(--font-mono);font-weight:600">${_esc(s.symbol || '')}</td>
      <td><span class="badge ${dirClass}">${_esc(s.direction || '')}</span></td>
      <td class="mono">${s.ai_score || '—'}</td>
      <td class="mono">${_fmtNum(s.entry_price, 4)}</td>
      <td class="mono" style="color:var(--win)">${_fmtNum(s.tp_price, 4)}</td>
      <td class="mono" style="color:var(--loss)">${_fmtNum(s.sl_price, 4)}</td>
      <td>${pnlStr}</td>
      <td class="${oc}" style="font-weight:600">${_esc(s.outcome || 'OPEN')}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(s.created_at)}</td>
    </tr>`;
  }).join('');
  return `<div id="journal-table" style="overflow-x:auto">
    <table class="tbl">
      <thead><tr>
        <th>Symbol</th><th>Richtung</th><th>Score</th>
        <th>Einstieg</th><th>TP</th><th>SL</th>
        <th>P&amp;L %</th><th>Ergebnis</th><th>Zeit</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function _renderJournalContent({ history, practiceData, outcome }) {
  const outcomes = ['all', 'OPEN', 'WIN', 'LOSS', 'BE'];
  const outcomeLabels = { all: 'Alle', OPEN: 'Offen', WIN: 'Win', LOSS: 'Loss', BE: 'Break Even' };
  const filterBar = outcomes.map(o => {
    const active = o === outcome;
    const bg = active ? (o === 'WIN' ? 'rgba(16,185,129,0.15)' : o === 'LOSS' ? 'rgba(240,79,79,0.15)' : 'rgba(59,130,246,0.15)') : 'var(--bg-3)';
    const color = active ? (o === 'WIN' ? 'var(--win)' : o === 'LOSS' ? 'var(--loss)' : o === 'OPEN' ? 'var(--blue-400)' : 'var(--text-primary)') : 'var(--text-secondary)';
    return `<button
      hx-get="/journal?outcome=${o}"
      hx-target="#journal-table"
      hx-swap="outerHTML"
      style="padding:6px 14px;border-radius:20px;border:1px solid var(--border);cursor:pointer;font-size:12px;font-weight:600;font-family:var(--font-main);background:${bg};color:${color};transition:all .12s">
      ${outcomeLabels[o]}
    </button>`;
  }).join('');

  // Practice trade stats
  const pt = practiceData || [];
  const ptOpen   = pt.filter(t => t.status === 'OPEN').length;
  const ptWins   = pt.filter(t => t.status === 'WIN').length;
  const ptLosses = pt.filter(t => t.status === 'LOSS').length;
  const ptClosed = ptWins + ptLosses;
  const ptWR     = ptClosed > 0 ? (ptWins / ptClosed * 100).toFixed(1) : '—';

  const ptRows = pt.slice(0, 20).map(t => {
    const dc = t.direction === 'LONG' ? 'badge-long' : 'badge-short';
    const sc = t.status === 'WIN' ? 'win' : t.status === 'LOSS' ? 'loss' : 'muted';
    const rp = t.result_pct != null ? `<span style="${t.result_pct >= 0 ? 'color:var(--win)' : 'color:var(--loss)'}">${t.result_pct >= 0 ? '+' : ''}${Number(t.result_pct).toFixed(2)}%</span>` : '—';
    return `<tr>
      <td class="mono" style="font-weight:600">${_esc(t.symbol || '')}</td>
      <td><span class="badge ${dc}">${_esc(t.direction || '')}</span></td>
      <td class="mono">${_fmtNum(t.entry_price, 4)}</td>
      <td class="mono">${t.exit_price ? _fmtNum(t.exit_price, 4) : '—'}</td>
      <td>${rp}</td>
      <td class="${sc}" style="font-weight:600">${_esc(t.status || 'OPEN')}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(t.created_at)}</td>
    </tr>`;
  }).join('');

  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Journal</h2>
    <div class="subtitle">Trade-Historie &amp; Practice Trades — ${history.length} Signale</div>
  </div>

  <div class="card" style="margin-bottom:var(--gap)">
    <div class="card-head">
      <span class="ico">${_svgIcon('chart', 14)}</span>
      <h3>Signal-Historie</h3>
      <div class="actions" style="gap:4px">${filterBar}</div>
    </div>
    ${_renderJournalTable(history, outcome)}
  </div>

  <div class="card">
    <div class="card-head">
      <span class="ico">${_svgIcon('target', 14)}</span>
      <h3>Practice Trades</h3>
      <div style="display:flex;gap:12px;font-size:12px;color:var(--text-tertiary)">
        <span>${ptOpen} offen</span>
        <span style="color:var(--win)">${ptWins}W</span>
        <span style="color:var(--loss)">${ptLosses}L</span>
        <span>WR ${ptWR}%</span>
      </div>
    </div>
    ${pt.length === 0
      ? `<div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px;font-size:13px">Keine Practice Trades vorhanden</div>`
      : `<div style="overflow-x:auto"><table class="tbl">
          <thead><tr><th>Symbol</th><th>Richtung</th><th>Einstieg</th><th>Ausstieg</th><th>P&amp;L %</th><th>Status</th><th>Zeit</th></tr></thead>
          <tbody>${ptRows}</tbody>
        </table></div>`}
  </div>
</div>`;
}

// ── News helpers ────────────────────────────────────────────────

const _NEWS_SCOPE_LABELS = {
  MACRO: 'Makro', REGULATION: 'Regulierung', EXCHANGE: 'Exchange',
  COIN_SPECIFIC: 'Coin', GLOBAL: 'Global',
};
const _NEWS_SCOPE_COLORS = {
  MACRO: 'var(--wait)', REGULATION: '#a78bfa', EXCHANGE: 'var(--blue-400)',
  COIN_SPECIFIC: 'var(--win)', GLOBAL: 'var(--text-secondary)',
};
const _NEWS_IMPACT_COLORS = { HIGH: 'var(--loss)', MEDIUM: 'var(--wait)', LOW: 'var(--text-tertiary)' };

function _applyNewsFilter(events, filter) {
  if (!filter || filter === 'all') return events;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (filter === 'today')  return events.filter(e => e.event_time && e.event_time >= today.getTime());
  if (filter === 'HIGH')   return events.filter(e => e.impact === 'HIGH');
  if (filter === 'MACRO')  return events.filter(e => e.affected_scope === 'MACRO');
  if (filter === 'REGULATION') return events.filter(e => e.affected_scope === 'REGULATION');
  if (filter === 'EXCHANGE')   return events.filter(e => e.affected_scope === 'EXCHANGE');
  // Symbol filters
  return events.filter(e => {
    try { return (JSON.parse(e.affected_symbols || '[]')).includes(filter + 'USDT') || e.title?.includes(filter); }
    catch { return e.title?.includes(filter); }
  });
}

function _renderNewsList(events, filter) {
  const filtered = _applyNewsFilter(events, filter);
  if (!filtered.length) {
    return `<div id="news-list" style="text-align:center;padding:40px;color:var(--text-tertiary);font-size:13px">Keine News für diesen Filter</div>`;
  }
  const cards = filtered.map(e => {
    const impactColor = _NEWS_IMPACT_COLORS[e.impact] || _NEWS_IMPACT_COLORS.LOW;
    const scopeLabel  = _NEWS_SCOPE_LABELS[e.affected_scope] || 'Global';
    const scopeColor  = _NEWS_SCOPE_COLORS[e.affected_scope] || 'var(--text-secondary)';
    const dateStr     = e.event_time ? _fmtDate(e.event_time) : '—';
    const href        = e.source_url ? ` href="${_esc(e.source_url)}" target="_blank" rel="noopener"` : '';
    return `<a${href} style="display:block;text-decoration:none;color:inherit">
      <div class="card" style="margin-bottom:10px;transition:box-shadow .15s${e.impact === 'HIGH' ? ';border-left:3px solid var(--loss)' : ''}">
        <div class="card-body" style="padding:16px 20px">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;align-items:center">
            ${e.impact ? `<span style="font-size:11px;font-weight:700;padding:2px 7px;border-radius:5px;background:var(--bg-0);border:1px solid ${impactColor};color:${impactColor}">${_esc(e.impact)}</span>` : ''}
            <span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:5px;background:var(--bg-0);border:1px solid var(--border);color:${scopeColor}">${_esc(scopeLabel)}</span>
            ${e.category ? `<span class="badge badge-tag">${_esc(e.category)}</span>` : ''}
          </div>
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:6px;line-height:1.4">${_esc(e.title || '')}</div>
          ${e.summary ? `<div style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:8px">${_esc(e.summary)}</div>` : ''}
          <div style="display:flex;gap:16px;font-size:11px;color:var(--text-quaternary)">
            ${e.source ? `<span>📡 ${_esc(e.source)}</span>` : ''}
            <span>🕒 ${dateStr}</span>
            ${e.source_url ? `<span style="color:var(--blue-400)">↗ Artikel lesen</span>` : ''}
          </div>
        </div>
      </div>
    </a>`;
  }).join('');
  return `<div id="news-list">${cards}</div>`;
}

function _renderNewsContent({ events, filter }) {
  const filters = [
    { id: 'all',         label: 'Alle' },
    { id: 'HIGH',        label: 'High Impact' },
    { id: 'MACRO',       label: 'Makro' },
    { id: 'REGULATION',  label: 'Regulierung' },
    { id: 'EXCHANGE',    label: 'Exchanges' },
    { id: 'BTC',         label: 'BTC' },
    { id: 'ETH',         label: 'ETH' },
    { id: 'SOL',         label: 'SOL' },
    { id: 'today',       label: 'Heute' },
  ];
  const filterBar = filters.map(f => {
    const active = f.id === filter;
    return `<button
      hx-get="/news?filter=${f.id}"
      hx-target="#news-list"
      hx-swap="outerHTML"
      style="padding:5px 13px;border-radius:20px;border:1px solid var(--border);cursor:pointer;font-size:12px;font-weight:600;font-family:var(--font-main);background:${active ? 'rgba(59,130,246,0.15)' : 'var(--bg-3)'};color:${active ? 'var(--blue-400)' : 'var(--text-secondary)'};transition:all .12s">
      ${f.label}
    </button>`;
  }).join('');

  const highCount = events.filter(e => e.impact === 'HIGH').length;
  const statusBadge = highCount > 0
    ? `<span style="font-size:12px;font-weight:600;color:var(--loss);padding:3px 10px;background:rgba(240,79,79,0.1);border:1px solid rgba(240,79,79,0.25);border-radius:20px">${highCount} High Impact</span>`
    : `<span class="status-pill"><span class="status-dot status-pulse"></span>Kein High Impact</span>`;

  return `
<div class="content page-enter">
  <div class="page-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
    <div>
      <h2>News &amp; Market Radar</h2>
      <div class="subtitle">${events.length} Events geladen</div>
    </div>
    ${statusBadge}
  </div>

  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:var(--gap);padding:4px 0">
    ${filterBar}
  </div>

  ${_renderNewsList(events, filter)}
</div>`;
}

// ── Backtesting helpers ─────────────────────────────────────────

function _renderBTTabBar(activeTab, isTrader) {
  const tabs = [
    { id: 'practice',      label: 'Übungstrades'        },
    { id: 'history',       label: 'Signal-Historie'      },
    ...(isTrader ? [
      { id: 'strategy',    label: 'Strategie-Labor'      },
      { id: 'compare',     label: 'Strategie-Vergleich'  },
      { id: 'regelanalyse',label: 'Regel-Analyse'        },
    ] : []),
    { id: 'loss',          label: 'Loss-Analyse'         },
    { id: 'biasstats',     label: 'Bias-Statistiken'     },
    { id: 'suggestions',   label: 'Vorschläge'           },
  ];
  const btns = tabs.map(t => {
    const active = t.id === activeTab;
    return `<button
      hx-get="/backtesting?tab=${t.id}"
      hx-target="#bt-section"
      hx-swap="innerHTML"
      hx-push-url="true"
      style="background:none;border:none;padding:10px 18px;cursor:pointer;font-size:14px;
             font-weight:${active ? 600 : 400};font-family:var(--font-main);white-space:nowrap;
             color:${active ? 'var(--blue-500)' : 'var(--text-secondary)'};
             border-bottom:2px solid ${active ? 'var(--blue-500)' : 'transparent'};
             margin-bottom:-1px;transition:all .15s"
      id="bt-tab-${t.id}">${t.label}</button>`;
  }).join('');
  return `<div style="overflow-x:auto;margin-bottom:20px;padding-bottom:1px">
  <div style="display:flex;gap:2px;border-bottom:1px solid var(--border);min-width:max-content">${btns}</div>
</div>`;
}

function _renderBTPracticeTab(practiceTrades, practiceStats) {
  const ps = practiceStats || {};
  const statRow = `
<div class="grid grid-4" style="margin-bottom:var(--gap)">
  <div class="stat"><div class="label">Gesamt</div><div class="value" style="font-size:22px">${ps.total || 0}</div></div>
  <div class="stat"><div class="label">Offen</div><div class="value" style="font-size:22px">${ps.open || 0}</div></div>
  <div class="stat"><div class="label">Win-Rate</div><div class="value" style="font-size:22px">${_fmtPct(ps.winRate)}</div><div class="sub muted">${ps.wins || 0}W / ${ps.losses || 0}L</div></div>
  <div class="stat"><div class="label">Ø Win %</div><div class="value" style="font-size:22px;color:var(--win)">+${_fmtNum(ps.avgWinPct)}</div><div class="sub loss">Loss Ø −${_fmtNum(Math.abs(ps.avgLossPct || 0))}</div></div>
</div>`;
  const pts = practiceTrades || [];
  if (!pts.length) return statRow + `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Practice Trades vorhanden</div></div>`;
  const rows = pts.map(t => {
    const dc = t.direction === 'LONG' ? 'badge-long' : 'badge-short';
    const sc = t.status === 'WIN' ? 'win' : t.status === 'LOSS' ? 'loss' : 'muted';
    const rp = t.result_pct != null ? `<span style="${t.result_pct >= 0 ? 'color:var(--win)' : 'color:var(--loss)'}">${t.result_pct >= 0 ? '+' : ''}${Number(t.result_pct).toFixed(2)}%</span>` : '—';
    return `<tr>
      <td class="mono" style="font-weight:600">${_esc(t.symbol||'')}</td>
      <td><span class="badge ${dc}">${_esc(t.direction||'')}</span></td>
      <td class="mono">${_fmtNum(t.entry_price,4)}</td>
      <td class="mono" style="color:var(--win)">${_fmtNum(t.tp_price,4)}</td>
      <td class="mono" style="color:var(--loss)">${_fmtNum(t.sl_price,4)}</td>
      <td class="mono">${t.exit_price ? _fmtNum(t.exit_price,4) : '—'}</td>
      <td>${rp}</td>
      <td class="${sc}" style="font-weight:600">${_esc(t.status||'OPEN')}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(t.created_at)}</td>
    </tr>`;
  }).join('');
  return statRow + `<div class="card"><div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Symbol</th><th>Richtung</th><th>Einstieg</th><th>TP</th><th>SL</th><th>Ausstieg</th><th>P&L%</th><th>Status</th><th>Zeit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function _renderBTHistoryTab(history, stats) {
  const s = stats || {};
  const statRow = `
<div class="grid grid-4" style="margin-bottom:var(--gap)">
  <div class="stat"><div class="label">Trades Total</div><div class="value" style="font-size:22px">${s.total||0}</div></div>
  <div class="stat"><div class="label">Win-Rate</div><div class="value" style="font-size:22px">${_fmtPct(s.winRate)}</div><div class="sub muted">${s.wins||0}W / ${s.losses||0}L</div></div>
  <div class="stat"><div class="label">Break Even</div><div class="value" style="font-size:22px">${s.be||0}</div></div>
  <div class="stat"><div class="label">Offen</div><div class="value" style="font-size:22px">${s.open||0}</div></div>
</div>`;
  const hist = history || [];
  if (!hist.length) return statRow + `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Signale vorhanden</div></div>`;
  const rows = hist.map(sig => {
    const dc = sig.direction === 'LONG' ? 'badge-long' : 'badge-short';
    const oc = sig.outcome === 'WIN' ? 'win' : sig.outcome === 'LOSS' ? 'loss' : 'muted';
    const pnl = sig.exit_price && sig.entry_price
      ? (sig.direction === 'LONG' ? (sig.exit_price - sig.entry_price) / sig.entry_price * 100 : (sig.entry_price - sig.exit_price) / sig.entry_price * 100)
      : null;
    const pnlHtml = pnl != null ? `<span style="${pnl>=0?'color:var(--win)':'color:var(--loss)'}">${pnl>=0?'+':''}${pnl.toFixed(2)}%</span>` : '—';
    return `<tr>
      <td class="mono" style="font-weight:600">${_esc(sig.symbol||'')}</td>
      <td><span class="badge ${dc}">${_esc(sig.direction||'')}</span></td>
      <td class="mono">${sig.ai_score||'—'}</td>
      <td class="mono">${_fmtNum(sig.entry_price,4)}</td>
      <td class="mono" style="color:var(--win)">${_fmtNum(sig.tp_price,4)}</td>
      <td class="mono" style="color:var(--loss)">${_fmtNum(sig.sl_price,4)}</td>
      <td>${pnlHtml}</td>
      <td class="${oc}" style="font-weight:600">${_esc(sig.outcome||'OPEN')}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(sig.created_at)}</td>
    </tr>`;
  }).join('');
  return statRow + `<div class="card"><div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Symbol</th><th>Richtung</th><th>Score</th><th>Einstieg</th><th>TP</th><th>SL</th><th>P&L%</th><th>Ergebnis</th><th>Zeit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function _renderBTStrategyTab(strategies) {
  const strats = strategies || [];
  if (!strats.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Strategien vorhanden</div></div>`;
  const cards = strats.map(s => {
    const cfg = s.config || {};
    const isActive = !!s.active;
    const isProtected = !!s.protected;
    return `<div class="card" style="margin-bottom:10px;${isActive ? 'border-left:3px solid var(--blue-500)' : ''}">
      <div class="card-body" style="padding:16px 20px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          <div style="flex:1">
            <div style="font-weight:700;font-size:15px">${_esc(s.name||'')}</div>
            <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px">v${_esc(s.version||'1.0')} · ID: ${_esc(s.id||'').slice(-8)}</div>
          </div>
          ${isActive ? '<span class="badge badge-win">AKTIV</span>' : ''}
          ${isProtected ? '<span class="badge badge-tag">Standard</span>' : ''}
          ${!isActive ? `<button onclick="activateStrategy('${_esc(s.id)}',this)" style="padding:6px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg-3);color:var(--text-secondary);cursor:pointer;font-size:12px;font-weight:600;font-family:var(--font-main)">Aktivieren</button>` : ''}
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text-tertiary)">
          ${cfg.min_trade_score != null ? `<span>Min Score: <b style="color:var(--text-primary)">${cfg.min_trade_score}</b></span>` : ''}
          ${cfg.min_telegram_score != null ? `<span>Telegram: <b style="color:var(--text-primary)">${cfg.min_telegram_score}</b></span>` : ''}
          ${cfg.tp_pct != null ? `<span>TP: <b style="color:var(--win)">${cfg.tp_pct}%</b></span>` : ''}
          ${cfg.sl_pct != null ? `<span>SL: <b style="color:var(--loss)">${cfg.sl_pct}%</b></span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  return `<div>${cards}</div>
  <script>
  function activateStrategy(id, btn) {
    if (!confirm('Strategie aktivieren?')) return;
    btn.disabled = true; btn.textContent = '...';
    fetch('/strategies/' + id + '/activate', { method:'POST', credentials:'include' })
      .then(r => r.json())
      .then(d => { if (d.success) location.reload(); else { btn.disabled=false; btn.textContent='Aktivieren'; alert(d.error||'Fehler'); } })
      .catch(() => { btn.disabled=false; btn.textContent='Aktivieren'; });
  }
  <\/script>`;
}

function _renderBTCompareTab(strategies, history) {
  const hist = history || [];
  const strats = strategies || [];
  if (!strats.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Strategien zum Vergleichen</div></div>`;
  const withSignals = strats.map(s => {
    const sigs = hist.filter(h => h.strategy_id === s.id || (!h.strategy_id && s.is_default));
    const closed = sigs.filter(h => h.outcome === 'WIN' || h.outcome === 'LOSS');
    const wins = sigs.filter(h => h.outcome === 'WIN').length;
    const wr = closed.length > 0 ? computeWinRate(wins, closed.length - wins).toFixed(1) : '—';
    const scores = sigs.map(h => h.ai_score).filter(Boolean);
    const avgScore = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) : '—';
    return { ...s, totalSigs: sigs.length, closedSigs: closed.length, wins, winRate: wr, avgScore };
  });
  const rows = withSignals.map(s => `<tr>
    <td style="font-weight:600">${_esc(s.name||'')} ${s.active ? '<span class="badge badge-win" style="margin-left:4px">Aktiv</span>' : ''}</td>
    <td class="mono">${s.totalSigs}</td>
    <td class="mono">${s.closedSigs}</td>
    <td class="mono">${s.wins}</td>
    <td class="mono" style="font-weight:700;${parseFloat(s.winRate)>=50?'color:var(--win)':s.winRate!=='—'?'color:var(--loss)':''}">${s.winRate !== '—' ? s.winRate+'%' : '—'}</td>
    <td class="mono">${s.avgScore}</td>
  </tr>`).join('');
  return `<div class="card"><div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Strategie</th><th>Signale</th><th>Closed</th><th>Wins</th><th>Win-Rate</th><th>Ø Score</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div></div>`;
}

function _renderBTRegelTab(history) {
  const hist = history || [];
  if (!hist.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Daten</div></div>`;
  const closed = hist.filter(h => h.outcome === 'WIN' || h.outcome === 'LOSS');
  // Group by symbol
  const bySym = {};
  closed.forEach(h => {
    const s = h.symbol || 'Unknown';
    if (!bySym[s]) bySym[s] = { symbol: s, wins: 0, losses: 0 };
    if (h.outcome === 'WIN') bySym[s].wins++;
    else bySym[s].losses++;
  });
  const symRows = Object.values(bySym)
    .sort((a,b) => (b.wins+b.losses) - (a.wins+a.losses))
    .slice(0, 20)
    .map(r => {
      const total = r.wins + r.losses;
      const wr = computeWinRate(r.wins, r.losses);
      const pct = wr.toFixed(1);
      const barColor = wr >= 60 ? 'var(--win)' : wr >= 40 ? 'var(--wait)' : 'var(--loss)';
      return `<tr>
        <td class="mono" style="font-weight:600">${_esc(r.symbol)}</td>
        <td class="mono">${total}</td>
        <td class="mono win">${r.wins}</td>
        <td class="mono loss">${r.losses}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px">
            <div style="flex:1;height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${Math.min(100,wr)}%;background:${barColor};border-radius:3px"></div>
            </div>
            <span style="font-size:12px;font-weight:700;color:${barColor};width:42px;text-align:right">${pct}%</span>
          </div>
        </td>
      </tr>`;
    }).join('');

  // By direction
  const long = closed.filter(h => h.direction === 'LONG');
  const short = closed.filter(h => h.direction === 'SHORT');
  const longWR = long.length ? (long.filter(h=>h.outcome==='WIN').length/long.length*100).toFixed(1) : '—';
  const shortWR = short.length ? (short.filter(h=>h.outcome==='WIN').length/short.length*100).toFixed(1) : '—';
  return `
<div class="grid grid-2" style="margin-bottom:var(--gap)">
  <div class="card">
    <div class="card-head"><h3>LONG-Trades</h3><span class="badge badge-long">LONG</span></div>
    <div class="card-body" style="padding:20px;text-align:center">
      <div style="font-size:32px;font-weight:700;font-family:var(--font-mono);color:var(--win)">${longWR}%</div>
      <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${long.length} Trades</div>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><h3>SHORT-Trades</h3><span class="badge badge-short">SHORT</span></div>
    <div class="card-body" style="padding:20px;text-align:center">
      <div style="font-size:32px;font-weight:700;font-family:var(--font-mono);color:var(--loss)">${shortWR}%</div>
      <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px">${short.length} Trades</div>
    </div>
  </div>
</div>
<div class="card">
  <div class="card-head"><span class="ico">${_svgIcon('stats',14)}</span><h3>Win-Rate nach Symbol</h3></div>
  <div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Symbol</th><th>Trades</th><th>Win</th><th>Loss</th><th>Win-Rate</th></tr></thead>
    <tbody>${symRows}</tbody>
  </table></div>
</div>`;
}

function _renderBTLossTab(history) {
  const hist = history || [];
  const losses = hist.filter(h => h.outcome === 'LOSS');
  if (!losses.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Loss-Trades vorhanden</div></div>`;
  const scoreGroups = { '<60': [], '60-69': [], '70-79': [], '80+': [] };
  losses.forEach(l => {
    const sc = l.ai_score || 0;
    if (sc < 60) scoreGroups['<60'].push(l);
    else if (sc < 70) scoreGroups['60-69'].push(l);
    else if (sc < 80) scoreGroups['70-79'].push(l);
    else scoreGroups['80+'].push(l);
  });
  const groupCards = Object.entries(scoreGroups).map(([range, items]) => {
    if (!items.length) return '';
    return `<div class="stat"><div class="label">Score ${range}</div><div class="value" style="font-size:22px;color:var(--loss)">${items.length}</div><div class="sub muted">Losses</div></div>`;
  }).join('');
  const rows = losses.slice(0, 50).map(l => {
    const dc = l.direction === 'LONG' ? 'badge-long' : 'badge-short';
    return `<tr>
      <td class="mono" style="font-weight:600">${_esc(l.symbol||'')}</td>
      <td><span class="badge ${dc}">${_esc(l.direction||'')}</span></td>
      <td class="mono">${l.ai_score||'—'}</td>
      <td class="mono">${_fmtNum(l.entry_price,4)}</td>
      <td class="mono" style="color:var(--loss)">${_fmtNum(l.sl_price,4)}</td>
      <td style="font-size:11px;color:var(--text-tertiary)">${_fmtDate(l.created_at)}</td>
    </tr>`;
  }).join('');
  return `
<div class="grid grid-4" style="margin-bottom:var(--gap)">${groupCards}</div>
<div class="card">
  <div class="card-head"><span class="ico">${_svgIcon('chart',14)}</span><h3>Loss-Trades (letzte 50)</h3></div>
  <div style="overflow-x:auto"><table class="tbl">
    <thead><tr><th>Symbol</th><th>Richtung</th><th>Score</th><th>Einstieg</th><th>SL</th><th>Zeit</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>`;
}

function _renderBTBiasTab(biasData) {
  const b = biasData || {};
  const card = (title, data, color) => {
    const d = data || {};
    return `<div class="stat">
      <div class="label">${title}</div>
      <div class="value" style="font-size:22px;color:${color || 'var(--text-primary)'}">${_fmtPct(d.winRate)}</div>
      <div class="sub muted">${d.wins||0}W / ${d.losses||0}L (${d.total||0})</div>
    </div>`;
  };
  return `
<div class="grid grid-3" style="margin-bottom:var(--gap)">
  ${card('Offizielle Trades', b.official, 'var(--blue-400)')}
  ${card('Alle Trades', b.all, 'var(--text-primary)')}
  ${card('Vor Morgenroutine', b.beforeRoutine, 'var(--wait)')}
</div>
<div class="card">
  <div class="card-body">
    <p style="font-size:13px;color:var(--text-tertiary);line-height:1.6">
      Bias-Statistiken zeigen, wie gut Trades mit dem Tages-Bias übereinstimmen.
      <b>Offizielle Trades</b> sind jene, die als <code>counts_for_strategy=1</code> markiert sind.
      <b>Vor Morgenroutine</b> sind Signale die vor der täglichen Analyse eingegangen sind.
    </p>
  </div>
</div>`;
}

function _renderBTSuggestionsTab(suggestions) {
  const suggs = suggestions || [];
  if (!suggs.length) return `<div class="card"><div class="card-body" style="text-align:center;color:var(--text-tertiary);padding:40px">Keine Vorschläge verfügbar</div></div>`;
  const priorityColor = p => p === 'high' ? 'var(--loss)' : p === 'medium' ? 'var(--wait)' : 'var(--text-tertiary)';
  const priorityBg    = p => p === 'high' ? 'rgba(240,79,79,0.08)' : p === 'medium' ? 'rgba(245,158,11,0.08)' : 'var(--bg-2)';
  const cards = suggs.map(s => `
  <div style="border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;margin-bottom:10px;background:${priorityBg(s.priority)};${s.priority==='high'?'border-left:3px solid var(--loss)':''}">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <div style="font-weight:700;font-size:14px;flex:1">${_esc(s.title||'')}</div>
      <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:var(--bg-0);color:${priorityColor(s.priority)};text-transform:uppercase;letter-spacing:.06em">${_esc(s.priority||'')}</span>
    </div>
    <div style="font-size:13px;color:var(--text-secondary);line-height:1.5">${_esc(s.message||'')}</div>
    ${s.action ? `<div style="margin-top:8px;font-size:12px;font-weight:600;color:var(--blue-400)">→ ${_esc(s.action)}</div>` : ''}
  </div>`).join('');
  return `<div>${cards}</div>`;
}

function _getBTTabContent(tab, data) {
  if (tab === 'practice')     return _renderBTPracticeTab(data.practiceTrades, data.practiceStats);
  if (tab === 'history')      return _renderBTHistoryTab(data.history, data.stats);
  if (tab === 'strategy')     return _renderBTStrategyTab(data.strategies);
  if (tab === 'compare')      return _renderBTCompareTab(data.strategies, data.history);
  if (tab === 'regelanalyse') return _renderBTRegelTab(data.history);
  if (tab === 'loss')         return _renderBTLossTab(data.history);
  if (tab === 'biasstats')    return _renderBTBiasTab(data.biasData);
  if (tab === 'suggestions')  return _renderBTSuggestionsTab(data.suggestions);
  return _renderBTPracticeTab(data.practiceTrades, data.practiceStats);
}

function _renderBacktestContent(tab, data, session) {
  const isTrader  = session?.role === 'admin' || session?.role === 'trader';
  const tabBar    = _renderBTTabBar(tab, isTrader);
  const tabContent = _getBTTabContent(tab, data);
  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Backtesting &amp; Strategie-Labor</h2>
    <div class="subtitle">Practice Trades · Strategie-Versionen · Loss-Analyse · Vorschläge</div>
  </div>
  <div id="bt-section">
    ${tabBar}
    <div id="backtest-content">${tabContent}</div>
  </div>
</div>`;
}

// ─── Phase 4: Statistiken ───────────────────────────────────────

function _fmtDuration(ms) {
  if (!ms || ms === 0) return 'N/A';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function _renderPnLChart(history) {
  const closed = history
    .filter(t => (t.outcome === 'WIN' || t.outcome === 'LOSS') && t.ai_entry && t.exit_price)
    .sort((a, b) => a.created_at - b.created_at);
  if (closed.length < 2) return '';
  let cum = 0;
  const points = closed.map(t => {
    const diff = t.exit_price - t.ai_entry;
    cum += t.direction === 'LONG' ? diff : -diff;
    return cum;
  });
  const W = 100, H = 60;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;
  const toY = v => H - ((v - min) / range) * H;
  const toX = i => (i / (points.length - 1)) * W;
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p).toFixed(1)}`).join(' ');
  const zero  = toY(0);
  const fill  = `${pathD} L ${toX(points.length - 1).toFixed(1)} ${zero} L 0 ${zero} Z`;
  const last  = points[points.length - 1];
  const color = last >= 0 ? 'var(--win)' : 'var(--loss)';
  const badge = `<span class="badge ${last >= 0 ? 'badge-win' : 'badge-loss'}">${last >= 0 ? '+' : ''}$${_fmtNum(last)}</span>`;
  return `
<div class="card">
  <div class="card-head">
    ${_svgIcon('chart', 16)}<h3>Kumulativer PnL (Dollar)</h3>
    <div class="actions">${badge}</div>
  </div>
  <div class="card-body" style="padding:12px 20px 16px">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:90px" preserveAspectRatio="none">
      <defs>
        <linearGradient id="statPnlGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      ${zero > 0 && zero < H ? `<line x1="0" y1="${zero.toFixed(1)}" x2="${W}" y2="${zero.toFixed(1)}" stroke="var(--border)" stroke-width="0.5"/>` : ''}
      <path d="${fill}" fill="url(#statPnlGrad)"/>
      <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.2"/>
    </svg>
  </div>
</div>`;
}

function _renderStatistikenContent({ stats, history, analytics, breakdown }) {
  const totalClosed = stats.wins + stats.losses;
  const winRate = computeWinRate(stats.wins, stats.losses);

  // Score distribution
  const sg = { '90–100': 0, '75–89': 0, '60–74': 0, '<60': 0 };
  history.forEach(t => {
    const s = t.ai_score || 0;
    if (s >= 90) sg['90–100']++;
    else if (s >= 75) sg['75–89']++;
    else if (s >= 60) sg['60–74']++;
    else sg['<60']++;
  });
  const scoreBars = Object.entries(sg).map(([lbl, cnt]) => {
    const pct = history.length > 0 ? (cnt / history.length * 100) : 0;
    return `
<div style="margin-bottom:14px">
  <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px">
    <span style="color:var(--text-secondary)">Score ${lbl}</span>
    <span class="mono" style="color:var(--text-primary)">${cnt} (${pct.toFixed(0)}%)</span>
  </div>
  <div style="height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden">
    <div style="height:100%;width:${pct.toFixed(1)}%;background:var(--blue-500);border-radius:3px"></div>
  </div>
</div>`;
  }).join('');

  // Direction breakdown rows
  const dirRows = (breakdown.directions || []).map(d => {
    const closed = d.wins + d.losses;
    const pct = computeWinRate(d.wins, d.losses);
    const cls = d.direction === 'LONG' ? 'badge-long' : 'badge-short';
    return `
<div style="margin-bottom:20px">
  <div style="display:flex;justify-content:space-between;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px">
      <span class="badge ${cls}">${_esc(d.direction)}</span>
      <span style="font-size:13px;color:var(--text-tertiary)">${d.total} Trades</span>
    </div>
    <div class="mono" style="font-size:13px;font-weight:600;color:${d.winRate >= 50 ? 'var(--win)' : 'var(--loss)'}">${d.winRate}%</div>
  </div>
  <div style="display:flex;gap:6px;margin-bottom:6px">
    <span style="font-size:12px;color:var(--win)">${d.wins}W</span>
    <span style="font-size:12px;color:var(--text-tertiary)">·</span>
    <span style="font-size:12px;color:var(--loss)">${d.losses}L</span>
    <span style="font-size:12px;color:var(--text-tertiary)">·</span>
    <span style="font-size:12px;color:var(--text-tertiary)">${d.total - closed} offen</span>
  </div>
  <div style="height:8px;background:var(--bg-3);border-radius:4px;overflow:hidden;display:flex">
    ${closed > 0 ? `<div style="height:100%;width:${pct.toFixed(1)}%;background:var(--win)"></div><div style="height:100%;width:${(100 - pct).toFixed(1)}%;background:var(--loss);opacity:0.6"></div>` : ''}
  </div>
</div>`;
  }).join('') || `<p style="color:var(--text-tertiary);text-align:center;padding:20px 0">Noch keine Daten</p>`;

  // Timeframe table rows
  const tfRows = (breakdown.timeframes || []).map(tf =>
    `<tr>
      <td class="mono">${_esc(String(tf.timeframe))}m</td>
      <td class="mono">${tf.total}</td>
      <td class="mono win">${tf.wins}</td>
      <td class="mono loss">${tf.losses}</td>
      <td class="mono" style="color:${tf.winRate >= 50 ? 'var(--win)' : 'var(--loss)'}">${tf.winRate}%</td>
    </tr>`
  ).join('');

  const tfSection = tfRows
    ? `<table class="tbl"><thead><tr><th>TF</th><th>Trades</th><th>W</th><th>L</th><th>Win-%</th></tr></thead><tbody>${tfRows}</tbody></table>`
    : `<div class="card-body" style="padding:40px;text-align:center"><p style="color:var(--text-tertiary)">Noch keine Trade-Daten</p></div>`;

  // Symbol table rows
  const symRows = (breakdown.symbols || []).slice(0, 8).map(s =>
    `<tr>
      <td class="mono" style="font-weight:600">${_esc(s.symbol)}</td>
      <td class="mono">${s.total}</td>
      <td class="mono win">${s.wins}</td>
      <td class="mono loss">${s.losses}</td>
      <td class="mono" style="color:${s.winRate >= 50 ? 'var(--win)' : 'var(--loss)'}">${s.winRate}%</td>
    </tr>`
  ).join('');

  const symSection = symRows
    ? `<table class="tbl"><thead><tr><th>Symbol</th><th>Trades</th><th>W</th><th>L</th><th>Win-%</th></tr></thead><tbody>${symRows}</tbody></table>`
    : `<div class="card-body" style="padding:40px;text-align:center"><p style="color:var(--text-tertiary)">Noch keine Trade-Daten</p></div>`;

  // Signal-class breakdown rows (NORMAL/STRONG/REVERSAL/...)
  const scRows = (breakdown.signalClasses || []).map(sc =>
    `<tr>
      <td class="mono" style="font-weight:600">${_esc(sc.signal_class)}</td>
      <td class="mono">${sc.total}</td>
      <td class="mono win">${sc.wins}</td>
      <td class="mono loss">${sc.losses}</td>
      <td class="mono" style="color:${sc.winRate >= 50 ? 'var(--win)' : 'var(--loss)'}">${sc.winRate}%</td>
      <td class="mono" style="color:${sc.expectancy >= 0 ? 'var(--win)' : 'var(--loss)'}">${sc.expectancy.toFixed(2)}%</td>
    </tr>`
  ).join('');

  const scSection = scRows
    ? `<table class="tbl"><thead><tr><th>Klasse</th><th>Trades</th><th>W</th><th>L</th><th>Win-%</th><th>Expectancy</th></tr></thead><tbody>${scRows}</tbody></table>`
    : `<div class="card-body" style="padding:40px;text-align:center"><p style="color:var(--text-tertiary)">Noch keine Trade-Daten</p></div>`;

  // Recent trades table
  const recentRows = history.slice(0, 10).map(t => {
    const oc = t.outcome === 'WIN' ? 'win' : t.outcome === 'LOSS' ? 'loss' : 'muted';
    const dc = t.direction === 'LONG' ? 'badge-long' : 'badge-short';
    return `<tr>
      <td class="mono muted" style="font-size:11px">${_fmtDate(t.created_at)}</td>
      <td class="mono" style="font-weight:600">${_esc(t.symbol || '')}</td>
      <td><span class="badge ${dc}">${_esc(t.direction || '')}</span></td>
      <td class="mono muted">${_esc(String(t.timeframe || ''))}m</td>
      <td class="mono">${t.ai_score || 0}/100</td>
      <td><span class="mono ${oc}" style="font-size:12px;font-weight:600">${_esc(t.outcome || '')}</span></td>
    </tr>`;
  }).join('');

  const convRate = (analytics.totalSignals || stats.total) > 0
    ? ((totalClosed / (analytics.totalSignals || stats.total)) * 100).toFixed(1)
    : '0.0';

  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Statistiken &amp; Analytics</h2>
    <div class="subtitle">${stats.total} Total Signale · ${totalClosed} abgeschlossen · ${stats.open} offen</div>
  </div>

  <div class="grid grid-4" style="margin-bottom:var(--gap)">
    <div class="stat"><div class="label">Abgeschlossen</div><div class="value" style="font-size:22px">${totalClosed}</div><div class="sub muted">${stats.total} Total Signale</div></div>
    <div class="stat"><div class="label">Expectancy <span class="muted" style="font-weight:400">(primär)</span></div><div class="value" style="font-size:22px;color:${(stats.expectancy || 0) >= 0 ? 'var(--win)' : 'var(--loss)'}">${(stats.expectancy || 0).toFixed(2)}%</div><div class="sub muted">Win-Rate ${winRate.toFixed(1)}% (sekundär)</div></div>
    <div class="stat"><div class="label">Gewonnen</div><div class="value" style="font-size:22px;color:var(--win)">${stats.wins}</div><div class="sub win">Profitable Trades</div></div>
    <div class="stat"><div class="label">Verloren</div><div class="value" style="font-size:22px;color:var(--loss)">${stats.losses}</div><div class="sub loss">Unprofitable Trades</div></div>
  </div>

  ${_renderPnLChart(history)}

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head">${_svgIcon('signal', 16)}<h3>Long vs. Short</h3></div>
      <div class="card-body">${dirRows}</div>
    </div>
    <div class="card">
      <div class="card-head">${_svgIcon('clock', 16)}<h3>Performance nach Timeframe</h3></div>
      ${tfSection}
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head">${_svgIcon('target', 16)}<h3>Performance nach Symbol</h3>
        <div class="actions"><span class="badge badge-tag">Top ${Math.min((breakdown.symbols || []).length, 8)}</span></div>
      </div>
      ${symSection}
    </div>
    <div class="card">
      <div class="card-head">${_svgIcon('chart', 16)}<h3>Score-Verteilung</h3></div>
      <div class="card-body">${scoreBars}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('signal', 16)}<h3>Performance nach Signal-Klasse</h3></div>
    ${scSection}
  </div>

  <div class="grid grid-3" style="margin-bottom:var(--gap)">
    <div class="stat"><div class="label">Avg. Hold Time</div><div class="value" style="font-size:22px">${_fmtDuration(analytics.avgHoldTimeMs)}</div><div class="sub muted">Ø Trade-Dauer</div></div>
    <div class="stat"><div class="label">Total Signale</div><div class="value" style="font-size:22px">${analytics.totalSignals || stats.total}</div><div class="sub muted">Alle empfangenen Webhooks</div></div>
    <div class="stat"><div class="label">Conversion Rate</div><div class="value" style="font-size:22px">${convRate}%</div><div class="sub muted">Signale → abgeschl. Trades</div></div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('signal', 16)}<h3>Letzte 10 Trades</h3></div>
    ${recentRows
      ? `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Zeit</th><th>Symbol</th><th>Richtung</th><th>TF</th><th>Score</th><th>Ergebnis</th></tr></thead><tbody>${recentRows}</tbody></table></div>`
      : `<div class="card-body" style="padding:40px;text-align:center"><p style="color:var(--text-tertiary)">Noch keine Trades</p></div>`
    }
  </div>
</div>`;
}

// ─── Phase 5: Einstellungen + Admin ─────────────────────────────

const _WEBHOOK_DISPLAY_URL = 'https://tradingview-bot.spnn08.workers.dev/webhook';

function _renderSettingsNav(activeSection, isAdmin) {
  const secs = [
    { id: 'account',       label: 'Account',           icon: 'users'    },
    { id: 'design',        label: 'Design',             icon: 'moon'     },
    { id: 'trading',       label: 'Trading',            icon: 'chart'    },
    { id: 'notifications', label: 'Benachrichtigungen', icon: 'bell'     },
    { id: 'broker',        label: 'Broker / API',       icon: 'cpu'      },
    ...(isAdmin ? [
      { id: 'admin',  label: 'Admin',  icon: 'bolt',     admin: true },
      { id: 'system', label: 'System', icon: 'settings', admin: true },
    ] : []),
  ];
  const items = secs.map((s, i) => {
    const active = s.id === activeSection;
    const divider = s.admin && i > 0 && !secs[i - 1].admin
      ? '<div style="height:1px;background:var(--border);margin:8px 0 6px"></div>' : '';
    return `${divider}<button
      hx-get="/settings?section=${s.id}"
      hx-target="#settings-section"
      hx-swap="innerHTML"
      hx-push-url="true"
      style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;border:none;
             background:${active ? 'rgba(59,130,246,.1)' : 'transparent'};
             color:${active ? 'var(--blue-500)' : 'var(--text-secondary)'};
             font-size:13px;font-weight:${active ? 600 : 400};cursor:pointer;
             font-family:var(--font-main);transition:all .15s;text-align:left;width:100%">
      ${_svgIcon(s.icon, 15)}
      <span style="flex:1">${_esc(s.label)}</span>
      ${s.admin ? '<span style="font-size:9px;padding:2px 5px;background:rgba(59,130,246,.15);color:var(--blue-500);border-radius:4px;font-weight:700">ADMIN</span>' : ''}
    </button>`;
  }).join('');
  return `<div style="display:flex;flex-direction:column;gap:2px;position:sticky;top:20px">${items}</div>`;
}

function _renderSettingsAccount(user) {
  return `<div class="card">
  <div class="card-head">${_svgIcon('users', 16)}<h3>Account</h3></div>
  <div class="card-body">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);letter-spacing:.08em;margin-bottom:4px">BENUTZERNAME</div>
        <div style="font-size:14px;font-weight:600">${_esc(user.username || '–')}</div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);letter-spacing:.08em;margin-bottom:4px">ROLLE</div>
        <span class="badge badge-tag" style="font-size:12px">${_esc(user.role || '–')}</span>
      </div>
      ${user.email ? `<div style="grid-column:1/-1">
        <div style="font-size:11px;font-weight:700;color:var(--text-tertiary);letter-spacing:.08em;margin-bottom:4px">E-MAIL</div>
        <div style="font-size:13px;color:var(--text-secondary)">${_esc(user.email)}</div>
      </div>` : ''}
    </div>
    <a href="/change-password" style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);font-size:13px;font-weight:500;color:var(--text-primary);text-decoration:none;transition:border-color .15s">
      ${_svgIcon('key', 13)} Passwort ändern
    </a>
  </div>
</div>`;
}

function _renderSettingsDesign() {
  return `<div class="card">
  <div class="card-head">${_svgIcon('moon', 16)}<h3>Design</h3></div>
  <div class="card-body">
    <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
      <input type="checkbox" id="theme-toggle" onchange="(function(el){const next=el.checked;document.documentElement.setAttribute('data-theme',next?'light':'dark');localStorage.setItem('theme',next?'light':'dark')})(this)">
      <div>
        <div style="font-size:13px;font-weight:500">Light Mode</div>
        <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">Helles Theme aktivieren (auch über Sidebar-Toggle änderbar)</div>
      </div>
    </label>
  </div>
</div>
<script>(function(){const t=localStorage.getItem('theme');const cb=document.getElementById('theme-toggle');if(cb)cb.checked=t==='light'})();</script>`;
}

function _renderSettingsTrading() {
  const sliders = [
    { id: 'riskPerTrade',  label: 'Risiko pro Trade',          suffix: '%', min: 0.5, max: 5,  step: 0.5, def: 2, parse: 'parseFloat' },
    { id: 'minScore',      label: 'Minimaler Score',           suffix: '',  min: 75,  max: 90, step: 5,   def: 75, parse: 'parseInt'   },
    { id: 'maxOpenTrades', label: 'Max. gleichzeitige Trades', suffix: '',  min: 1,   max: 10, step: 1,   def: 3,  parse: 'parseInt'   },
  ];
  const sliderHtml = sliders.map(s =>
    `<div style="margin-bottom:20px">
      <label style="display:block;margin-bottom:6px;font-size:13px;font-weight:500">
        ${s.label}: <span style="color:var(--blue-500)" id="${s.id}Label">${s.def}${s.suffix}</span>
      </label>
      <input type="range" id="${s.id}" min="${s.min}" max="${s.max}" step="${s.step}" value="${s.def}" style="width:100%;max-width:360px"
        oninput="document.getElementById('${s.id}Label').textContent=this.value+'${s.suffix}'${s.id === 'minScore' ? ";document.getElementById('scoreLabel').textContent=this.value" : ''}">
    </div>`
  ).join('');
  const checks = [
    ['useStopLoss', 'Stop-Loss immer setzen', true],
    ['useTakeProfit', 'Take-Profit immer setzen', true],
    ['trailingStop', 'Trailing Stop verwenden', false],
  ];
  const checkHtml = checks.map(([id, label, def]) =>
    `<label style="display:flex;align-items:center;gap:8px;font-size:13px">
      <input type="checkbox" id="${id}"${def ? ' checked' : ''}> ${label}
    </label>`
  ).join('');
  return `<div class="card">
  <div class="card-head">${_svgIcon('chart', 16)}<h3>Trading</h3></div>
  <div class="card-body">
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;margin-bottom:20px">
      <input type="checkbox" id="autoTrade">
      Auto-Trading aktivieren (Score ≥ <span id="scoreLabel">65</span>)
    </label>
    ${sliderHtml}
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">${checkHtml}</div>
    <div style="display:flex;gap:12px;align-items:center">
      <button onclick="saveTradingSettings()" style="padding:8px 16px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-main)">Speichern</button>
      <span id="tradingSaved" style="display:none;color:var(--win);font-size:12px">Gespeichert ✓</span>
    </div>
  </div>
</div>
<script>
(function(){
  try{const s=JSON.parse(localStorage.getItem('wavescout_settings')||'{}');
  if(s.autoTrade!=null)document.getElementById('autoTrade').checked=s.autoTrade;
  const setSlider=(id,v,suf)=>{if(v==null)return;document.getElementById(id).value=v;document.getElementById(id+'Label').textContent=v+(suf||'')};
  setSlider('riskPerTrade',s.riskPerTrade,'%');setSlider('minScore',s.minScore,'');setSlider('maxOpenTrades',s.maxOpenTrades,'');
  if(s.minScore){document.getElementById('scoreLabel').textContent=s.minScore;}
  ['useStopLoss','useTakeProfit','trailingStop'].forEach(k=>{if(s[k]!=null)document.getElementById(k).checked=s[k]});
  }catch(_){}
})();
function saveTradingSettings(){
  try{const s=JSON.parse(localStorage.getItem('wavescout_settings')||'{}');
  s.autoTrade=document.getElementById('autoTrade').checked;
  s.riskPerTrade=parseFloat(document.getElementById('riskPerTrade').value);
  s.minScore=parseInt(document.getElementById('minScore').value);
  s.maxOpenTrades=parseInt(document.getElementById('maxOpenTrades').value);
  ['useStopLoss','useTakeProfit','trailingStop'].forEach(k=>s[k]=document.getElementById(k).checked);
  localStorage.setItem('wavescout_settings',JSON.stringify(s));
  const el=document.getElementById('tradingSaved');el.style.display='inline';setTimeout(()=>el.style.display='none',2500);
  }catch(_){}
}
</script>`;
}

function _renderSettingsNotifications() {
  return `<div class="card">
  <div class="card-head">${_svgIcon('bell', 16)}<h3>Benachrichtigungen</h3></div>
  <div class="card-body">
    <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="notifBrowser" checked> Browser-Benachrichtigungen</label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="notifTelegram" checked> Telegram-Benachrichtigungen</label>
    </div>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px">
      <button onclick="saveNotifSettings()" style="padding:8px 16px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-main)">Speichern</button>
      <span id="notifSaved" style="display:none;color:var(--win);font-size:12px">Gespeichert &#10003;</span>
    </div>
    <div style="border-top:1px solid var(--border);padding-top:16px">
      <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:10px">NTFY.SH TEST</div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">Sendet einen Test-Push via ntfy.sh (Score&nbsp;97, BTCUSDT). Benoetigt das Secret <code>NTFY_TOPIC</code>.</div>
      <div style="display:flex;gap:10px;align-items:center">
        <button id="ntfy-test-btn" onclick="(async()=>{const btn=document.getElementById('ntfy-test-btn');const res=document.getElementById('ntfy-test-result');btn.disabled=true;btn.textContent='Sende...';try{const r=await fetch('/admin/test-ntfy',{credentials:'include'});const d=await r.json();res.textContent=d.success?'ntfy OK ✓':(d.message||'Fehler');res.style.color=d.success?'var(--win)':'var(--loss)';}catch(e){res.textContent=e.message;res.style.color='var(--loss)';}finally{btn.disabled=false;btn.textContent='ntfy Test senden';}})()"
          style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">ntfy Test senden</button>
        <span id="ntfy-test-result" style="font-size:13px"></span>
      </div>
    </div>
  </div>
</div>
<script>
(function(){try{const s=JSON.parse(localStorage.getItem('wavescout_settings')||'{}');
if(s.notifications!=null)document.getElementById('notifBrowser').checked=s.notifications;
if(s.telegramEnabled!=null)document.getElementById('notifTelegram').checked=s.telegramEnabled;
}catch(_){}})();
function saveNotifSettings(){try{const s=JSON.parse(localStorage.getItem('wavescout_settings')||'{}');
s.notifications=document.getElementById('notifBrowser').checked;
s.telegramEnabled=document.getElementById('notifTelegram').checked;
localStorage.setItem('wavescout_settings',JSON.stringify(s));
const el=document.getElementById('notifSaved');el.style.display='inline';setTimeout(()=>el.style.display='none',2500);
}catch(_){}}
</script>`;
}

function _renderSettingsBroker() {
  const wh = _WEBHOOK_DISPLAY_URL;
  return `<div style="display:flex;flex-direction:column;gap:16px">
  <div class="card">
    <div class="card-head">${_svgIcon('signal', 16)}<h3>TradingView Webhook</h3>
      <div class="actions"><span class="badge badge-win">LIVE</span></div>
    </div>
    <div class="card-body">
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">
        Diese URL in TradingView unter <strong>Alerts → Webhook URL</strong> eintragen.
      </p>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
        <div style="flex:1;padding:10px 14px;background:var(--bg-0);border:1px solid var(--border);border-radius:8px;font-family:var(--font-mono);font-size:13px;color:var(--text-secondary);word-break:break-all">${_esc(wh)}</div>
        <button id="copy-wh-btn" onclick="navigator.clipboard.writeText('${wh}').then(()=>{this.textContent='Kopiert ✓';setTimeout(()=>this.textContent='Kopieren',2000)})"
          style="flex-shrink:0;padding:8px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">Kopieren</button>
      </div>
      <div style="padding:10px 14px;background:rgba(245,158,11,.06);border-radius:8px;border:1px solid rgba(245,158,11,.3);font-size:12px;color:var(--text-secondary)">
        <strong>Beispiel-Payload (SIGNAL):</strong>
        <pre style="margin:6px 0 0;font-family:var(--font-mono);font-size:11px;color:var(--text-tertiary);white-space:pre-wrap">{"symbol":"BTCUSDT","event_type":"SIGNAL","timeframe":"5","price":{{close}},"direction":"LONG","trigger":"EMA_CROSS","action":"BUY"}</pre>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('chart', 16)}<h3>Autotrade Konfiguration</h3>
      <div class="actions" id="at-badge"><span class="badge badge-tag">INAKTIV</span></div>
    </div>
    <div id="at-loading" class="card-body" style="text-align:center;padding:20px;font-size:13px;color:var(--text-tertiary)">Lade Konfiguration…</div>
    <div id="at-form" class="card-body" style="display:none">
      <label style="display:flex;align-items:center;gap:10px;margin-bottom:20px;cursor:pointer">
        <input type="checkbox" id="at-enabled">
        <div><div style="font-weight:600;font-size:13px">Autotrade aktivieren</div>
          <div style="font-size:12px;color:var(--text-tertiary)">Bei qualifizierten Signalen automatisch echte Orders platzieren</div></div>
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
        <div><label style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-tertiary);letter-spacing:.05em">BETRAG PRO TRADE (USDT)</label>
          <input type="number" id="at-amount" min="1" step="1" value="10" class="input" style="width:100%"></div>
        <div><label style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-tertiary);letter-spacing:.05em">MIN. SCORE</label>
          <input type="number" id="at-minscore" min="55" max="100" step="5" value="75" class="input" style="width:100%"></div>
      </div>
      <div style="margin-bottom:14px">
        <label style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-tertiary);letter-spacing:.05em">API KEY</label>
        <input type="text" id="at-apikey" class="input" style="width:100%" autocomplete="off" placeholder="Broker API Key">
      </div>
      <div style="margin-bottom:14px">
        <label style="display:block;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--text-tertiary);letter-spacing:.05em">API SECRET</label>
        <input type="password" id="at-secret" class="input" style="width:100%" placeholder="Leer lassen um bestehenden Key zu behalten" autocomplete="new-password">
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:16px">
        <input type="checkbox" id="at-testnet" checked onchange="updateAtWarning()">
        <span>Testnet / Demo-Modus <span id="at-testnet-lbl" style="font-size:12px;color:var(--win);font-weight:600">(kein echtes Geld)</span></span>
      </label>
      <div id="at-live-warn" style="display:none;padding:10px 14px;background:rgba(240,68,68,.08);border-radius:8px;border:1px solid rgba(240,68,68,.3);font-size:12px;color:var(--loss);margin-bottom:14px;font-weight:600">
        ⚠️ LIVE-MODUS aktiv — echte Orders werden platziert!
      </div>
      <div style="padding:10px 14px;background:rgba(245,158,11,.06);border-radius:8px;border:1px solid rgba(245,158,11,.3);font-size:12px;color:var(--text-secondary);margin-bottom:16px;line-height:1.6">
        API-Keys werden verschlüsselt auf dem Server gespeichert. Nur Trading-Rechte vergeben — <strong>kein Withdrawal-Recht</strong>.
      </div>
      <div id="at-err" style="display:none;padding:8px 14px;background:rgba(240,68,68,.08);border-radius:8px;font-size:12px;color:var(--loss);margin-bottom:12px"></div>
      <button id="at-save" onclick="saveAtConfig()" style="padding:10px 20px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-main)">
        Auf Server speichern
      </button>
    </div>
  </div>
</div>
<script>
function updateAtWarning(){
  const t=document.getElementById('at-testnet')?.checked,e=document.getElementById('at-enabled')?.checked;
  const lbl=document.getElementById('at-testnet-lbl'),warn=document.getElementById('at-live-warn');
  if(lbl){lbl.textContent=t?'(kein echtes Geld)':'(LIVE — echtes Geld!)';lbl.style.color=t?'var(--win)':'var(--loss)';}
  if(warn)warn.style.display=(!t&&e)?'block':'none';
}
(function(){
  fetch('/broker-config',{credentials:'include'}).then(r=>r.ok?r.json():null).then(d=>{
    document.getElementById('at-loading').style.display='none';
    document.getElementById('at-form').style.display='block';
    if(d?.configured){
      document.getElementById('at-enabled').checked=d.enabled||false;
      document.getElementById('at-amount').value=d.tradeAmount||10;
      document.getElementById('at-minscore').value=d.minScore||75;
      document.getElementById('at-testnet').checked=d.testnet!==false;
      if(d.apiKeyMasked)document.getElementById('at-apikey').placeholder=d.apiKeyMasked;
      const b=document.getElementById('at-badge');
      if(b)b.innerHTML=d.enabled?'<span class="badge badge-win">AKTIV</span>':'<span class="badge badge-tag">INAKTIV</span>';
    }
    updateAtWarning();
  }).catch(()=>{document.getElementById('at-loading').style.display='none';document.getElementById('at-form').style.display='block';});
  document.getElementById('at-enabled')?.addEventListener('change',updateAtWarning);
})();
async function saveAtConfig(){
  const btn=document.getElementById('at-save'),errEl=document.getElementById('at-err');
  btn.disabled=true;btn.textContent='Speichern…';errEl.style.display='none';
  try{
    const r=await fetch('/broker-config',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({enabled:document.getElementById('at-enabled').checked,tradeAmount:parseFloat(document.getElementById('at-amount').value)||10,
        minScore:parseInt(document.getElementById('at-minscore').value)||75,apiKey:document.getElementById('at-apikey').value,
        apiSecret:document.getElementById('at-secret').value,passphrase:'',testnet:document.getElementById('at-testnet').checked,broker:'bybit'})});
    if(r.ok){
      document.getElementById('at-secret').value='';
      btn.textContent='Gespeichert ✓';setTimeout(()=>btn.textContent='Auf Server speichern',2500);
      const b=document.getElementById('at-badge');if(b)b.innerHTML=document.getElementById('at-enabled').checked?'<span class="badge badge-win">AKTIV</span>':'<span class="badge badge-tag">INAKTIV</span>';
    }else{const e=await r.json().catch(()=>({}));errEl.textContent=e.error||'Fehler';errEl.style.display='block';btn.textContent='Auf Server speichern';}
  }catch(e){errEl.textContent='Netzwerkfehler';errEl.style.display='block';btn.textContent='Auf Server speichern';}
  btn.disabled=false;
}
</script>`;
}

function _renderSettingsSystem() {
  return `<div style="display:flex;flex-direction:column;gap:16px">
  <div class="card">
    <div class="card-head">${_svgIcon('settings', 16)}<h3>System Info</h3></div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${[['Worker Runtime','Cloudflare Workers'],['Datenbank','Cloudflare D1 (SQLite)'],['Frontend','Cloudflare Pages'],['Framework','HTMX 2.0.4']].map(([k,v]) =>
          `<div><div style="font-size:11px;font-weight:700;color:var(--text-tertiary);letter-spacing:.08em;margin-bottom:3px">${k.toUpperCase()}</div>
          <div style="font-size:13px;color:var(--text-secondary)">${v}</div></div>`).join('')}
      </div>
    </div>
  </div>
  <div class="card">
    <div class="card-head">${_svgIcon('bolt', 16)}<h3>Cloudflare Dashboard</h3></div>
    <div class="card-body">
      <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">Logs, Metrics, Bindings und Cron-Trigger im Cloudflare Dashboard verwalten.</p>
      <a href="https://dash.cloudflare.com" target="_blank" rel="noopener noreferrer"
         style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);font-size:13px;color:var(--text-primary);text-decoration:none">
        ${_svgIcon('signal', 13)} Cloudflare Dashboard öffnen
      </a>
    </div>
  </div>
</div>`;
}

function _renderSettingsAdmin({ users = [], sessions = [], systemStatus = {} }) {
  const st = systemStatus;
  const dotColor = ok => ok ? 'var(--win)' : 'var(--loss)';
  const dotGlow  = ok => ok ? ';box-shadow:0 0 5px var(--win)' : '';
  const statusText = ok => ok ? 'OK' : 'Nicht konfiguriert';

  const serviceRows = [
    ['Datenbank (D1)', st.db], ['Telegram Bot', st.telegram],
    ['ntfy.sh', st.ntfy], ['Anthropic AI', st.anthropic], ['Webhook Secret', st.webhook],
  ].map(([label, ok]) => `<div style="display:flex;justify-content:space-between;align-items:center">
    <span style="font-size:13px;color:var(--text-secondary)">${label}</span>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="width:8px;height:8px;border-radius:50%;background:${dotColor(ok)}${dotGlow(ok)}"></div>
      <span style="font-size:12px;color:${dotColor(ok)};font-weight:600">${statusText(ok)}</span>
    </div>
  </div>`).join('');

  const tableCountRows = Object.entries(st.tables || {}).map(([t, c]) =>
    `<div style="display:flex;justify-content:space-between;align-items:center">
      <span style="font-size:12px;color:var(--text-tertiary);font-family:var(--font-mono)">${t}</span>
      <span style="font-size:13px;font-weight:600;color:${c === null ? 'var(--loss)' : 'var(--text-primary)'}">${c === null ? '✗' : c.toLocaleString()}</span>
    </div>`
  ).join('');

  const sessionRows = sessions.map(s => `<tr>
    <td style="font-weight:600">${_esc(s.username || '')}</td>
    <td><span class="badge ${s.role === 'admin' ? 'badge-win' : 'badge-wait'}">${_esc(s.role || '')}</span></td>
    <td class="mono muted" style="font-size:11px">${_fmtDate(s.created_at)}</td>
    <td class="mono muted" style="font-size:11px">${_fmtDate(s.expires_at)}</td>
  </tr>`).join('');

  const now = Date.now();
  const userRows = users.map(u => {
    const online = u.last_seen && u.last_seen > now - 5 * 60 * 1000;
    return `<tr style="${u.blocked ? 'opacity:.55' : ''}">
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="width:7px;height:7px;border-radius:50%;background:${online ? 'var(--win)' : 'var(--text-quaternary)'}"></div>
          <span style="font-size:11px;color:var(--text-tertiary)">${online ? 'ONLINE' : 'OFFLINE'}</span>
        </div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:28px;height:28px;border-radius:50%;background:${u.blocked ? 'var(--text-quaternary)' : 'var(--blue-500)'};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;flex-shrink:0">
            ${_esc((u.username || 'U').charAt(0).toUpperCase())}
          </div>
          <div>
            <div style="font-weight:600">${_esc(u.username || '')}</div>
            ${u.email ? `<div style="font-size:11px;color:var(--text-tertiary)">${_esc(u.email)}</div>` : ''}
          </div>
          ${u.blocked ? '<span class="badge badge-loss" style="font-size:10px">GESPERRT</span>' : ''}
        </div>
      </td>
      <td>
        <select onchange="changeRole('${u.id}',this.value)" class="input" style="font-size:12px;padding:3px 6px;width:auto;min-width:100px">
          ${['admin','trader','viewer','extern'].map(r => `<option value="${r}"${u.role===r?' selected':''}>${r.toUpperCase()}</option>`).join('')}
        </select>
      </td>
      <td class="mono muted" style="font-size:11px">${u.last_seen ? _fmtDate(u.last_seen) : '–'}</td>
      <td>
        <div style="display:flex;gap:4px">
          <button title="Passwort ändern" onclick="showChangePwModal('${u.id}','${_esc(u.username || '')}')"
            style="padding:4px 8px;border-radius:6px;background:var(--bg-2);border:1px solid var(--border);cursor:pointer;font-size:12px">${_svgIcon('key', 13)}</button>
          <button title="${u.blocked ? 'Entsperren' : 'Sperren'}" onclick="toggleBlock('${u.id}',${!u.blocked})"
            style="padding:4px 8px;border-radius:6px;background:var(--bg-2);border:1px solid var(--border);cursor:pointer;font-size:12px;color:${u.blocked ? 'var(--win)' : 'var(--loss)'}">
            ${u.blocked ? '✓' : '✗'}
          </button>
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<div style="display:flex;flex-direction:column;gap:16px">

  <div class="card">
    <div class="card-head">${_svgIcon('signal', 16)}<h3>System Status</h3>
      <div class="actions"><span class="badge badge-tag">${_esc(st.version || '–')}</span></div>
    </div>
    <div class="card-body">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div>
          <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:12px">SERVICES</div>
          <div style="display:flex;flex-direction:column;gap:10px">${serviceRows}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:12px">DATENBANK — ZEILEN</div>
          <div style="display:flex;flex-direction:column;gap:8px">${tableCountRows}</div>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('bell', 16)}<h3>Telegram Integration</h3>
      <div class="actions">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:8px;height:8px;border-radius:50%;background:${dotColor(st.telegram)}${dotGlow(st.telegram)}"></div>
          <span style="font-size:12px;color:${dotColor(st.telegram)};font-weight:600">${statusText(st.telegram)}</span>
        </div>
      </div>
    </div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:10px">SCHNELLTEST</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button onclick="adminAction('/test-telegram','GET','tg-result',d=>d.success?'Telegram OK ✓':(d.message||'Fehler'),d=>d.success)"
            style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">🔔 Verbindung testen</button>
          <button onclick="sendTgSignal()"
            style="padding:7px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">📊 Test-Signal Alert</button>
        </div>
        <div id="tg-result" style="margin-top:8px"></div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:16px">
        <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:8px">EIGENE NACHRICHT</div>
        <textarea id="tg-msg" class="input" rows="3" style="width:100%;font-family:var(--font-mono);font-size:13px;resize:vertical" placeholder="Nachricht (HTML: &lt;b&gt; &lt;i&gt; &lt;code&gt;)"></textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button onclick="sendTgCustom()" style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">📤 Senden</button>
        </div>
        <div id="tg-send-result" style="margin-top:8px"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('bell', 16)}<h3>ntfy.sh Integration</h3>
      <div class="actions">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:8px;height:8px;border-radius:50%;background:${dotColor(st.ntfy)}${dotGlow(st.ntfy)}"></div>
          <span style="font-size:12px;color:${dotColor(st.ntfy)};font-weight:600">${st.ntfy ? 'OK' : 'Nicht konfiguriert'}</span>
        </div>
      </div>
    </div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
      <div style="font-size:13px;color:var(--text-secondary)">Sendet Push-Benachrichtigungen für Signale mit Score ≥ 95 via <b>ntfy.sh</b>.<br>Setzt das Worker-Secret <code>NTFY_TOPIC</code> voraus.</div>
      <div>
        <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:10px">SCHNELLTEST</div>
        <button onclick="adminAction('/admin/test-ntfy','GET','ntfy-result',d=>d.success?'ntfy OK ✓':(d.message||'Fehler'),d=>d.success)"
          style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">🔔 ntfy Test senden</button>
        <div id="ntfy-result" style="margin-top:8px"></div>
      </div>
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <div class="card-head">${_svgIcon('cpu', 16)}<h3>Anthropic AI</h3>
        <div class="actions">
          <div style="display:flex;align-items:center;gap:8px">
            <div style="width:8px;height:8px;border-radius:50%;background:${dotColor(st.anthropic)}${dotGlow(st.anthropic)}"></div>
            <span style="font-size:12px;color:${dotColor(st.anthropic)};font-weight:600">${statusText(st.anthropic)}</span>
          </div>
        </div>
      </div>
      <div class="card-body">
        <button onclick="adminAction('/admin/test-ai','POST','ai-result',d=>d.ok?'AI OK · '+d.latencyMs+'ms · '+d.model:(d.error||'Fehler'),d=>d.ok)"
          style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">🤖 API testen</button>
        <div id="ai-result" style="margin-top:8px"></div>
      </div>
    </div>
    <div class="card">
      <div class="card-head">${_svgIcon('target', 16)}<h3>Trade Check</h3></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
        <button onclick="adminAction('/admin/check-open-trades','POST','check-result',d=>d.success?'Geprüft: '+d.checked+' · Geschlossen: '+(d.closed||0):(d.error||'Fehler'),d=>d.success)"
          style="padding:7px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">Alle offenen Trades prüfen</button>
        <button onclick="adminAction('/admin/eod-check','POST','check-result',d=>d.success?'EOD: '+d.checked+' geprüft, '+(d.closed||0)+' geschlossen':(d.error||'Fehler'),d=>d.success)"
          style="padding:7px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">EOD-Check ausführen</button>
        <div id="check-result" style="margin-top:4px"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('settings', 16)}<h3>Datenbank Wartung</h3></div>
    <div class="card-body" style="display:flex;flex-direction:column;gap:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:8px">SCHEMA MIGRATION</div>
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">Erstellt fehlende Tabellen und fügt neue Spalten hinzu. Sicher jederzeit ausführbar.</p>
          <button onclick="runSetupDB()" style="padding:7px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">🔧 Setup DB ausführen</button>
          <div id="setup-result" style="margin-top:8px;font-size:12px;font-family:var(--font-mono);color:var(--text-secondary)"></div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:8px">BEREINIGUNG</div>
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">Löscht alte Snapshots, abgelaufene Sessions und alte Practice Trades.</p>
          <button onclick="if(confirm('DB bereinigen?'))adminAction('/admin/db-cleanup','POST','cleanup-result',d=>(d.results||[]).join('\\n')||'OK',d=>d.success)"
            style="padding:7px 14px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--loss);font-size:13px;cursor:pointer;font-family:var(--font-main)">🗑 DB bereinigen</button>
          <div id="cleanup-result" style="margin-top:8px;font-size:12px;font-family:var(--font-mono);color:var(--text-secondary)"></div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);padding-top:16px">
        <div style="font-size:11px;color:var(--text-tertiary);font-weight:700;letter-spacing:.08em;margin-bottom:10px">SIGNALE LÖSCHEN</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${['test','wait','skipped','practice'].map(t =>
            `<button onclick="if(confirm('${t}-Signale löschen?'))deleteSignals('${t}')"
              style="padding:7px 12px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-secondary);font-size:12px;cursor:pointer;font-family:var(--font-main)">
              ${t === 'test' ? '🧪 Test' : t === 'wait' ? '⏳ WAIT' : t === 'skipped' ? '⏭ SKIPPED' : '📝 Practice'} löschen
            </button>`
          ).join('')}
        </div>
        <div id="delete-result" style="margin-top:8px;font-size:12px;color:var(--text-secondary)"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('users', 16)}<h3>Aktive Sessions</h3>
      <div class="actions"><span class="badge badge-tag">${sessions.length} aktiv</span></div>
    </div>
    ${sessionRows
      ? `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>User</th><th>Rolle</th><th>Angemeldet</th><th>Läuft ab</th></tr></thead><tbody>${sessionRows}</tbody></table></div>`
      : `<div class="card-body" style="text-align:center;padding:30px;color:var(--text-tertiary);font-size:13px">Keine aktiven Sessions</div>`
    }
  </div>

  <div class="card">
    <div class="card-head">${_svgIcon('users', 16)}<h3>Benutzer-Verwaltung</h3>
      <div class="actions">
        <button onclick="showCreateUserModal()"
          style="padding:6px 14px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-main)">
          + Neuer User
        </button>
      </div>
    </div>
    ${userRows
      ? `<div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Status</th><th>Benutzer</th><th>Rolle</th><th>Zuletzt gesehen</th><th>Aktionen</th></tr></thead><tbody>${userRows}</tbody></table></div>`
      : `<div class="card-body" style="text-align:center;padding:40px;color:var(--text-tertiary);font-size:13px">Keine Benutzer</div>`
    }
  </div>

  <!-- Modal overlay -->
  <div id="modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;align-items:center;justify-content:center" onclick="closeModal()">
    <div id="modal-box" style="background:var(--bg-1);border-radius:14px;padding:28px;max-width:440px;width:90%;border:1px solid var(--border)" onclick="event.stopPropagation()">
      <div id="modal-html"></div>
    </div>
  </div>
  <div id="admin-toast" style="display:none;position:fixed;top:64px;right:20px;z-index:9999;padding:12px 18px;border-radius:10px;font-size:13px;font-weight:500;box-shadow:0 4px 16px rgba(0,0,0,.25)"></div>

</div>
<script>
function adminToast(msg,type='ok'){
  const el=document.getElementById('admin-toast');if(!el)return;
  el.textContent=(type==='ok'?'✅ ':'❌ ')+msg;
  el.style.display='block';el.style.background=type==='ok'?'var(--bg-success)':'var(--bg-error)';
  el.style.border='1px solid '+(type==='ok'?'rgba(16,185,129,.4)':'rgba(239,68,68,.4)');
  el.style.color=type==='ok'?'var(--win)':'var(--loss)';
  setTimeout(()=>el.style.display='none',3000);
}
function showResultBox(elId,text,ok){
  const el=document.getElementById(elId);if(!el)return;
  el.style.marginTop='10px';el.style.padding='10px 14px';el.style.borderRadius='8px';el.style.whiteSpace='pre-wrap';
  el.style.background=ok?'var(--bg-success)':'var(--bg-error)';
  el.style.border='1px solid '+(ok?'rgba(16,185,129,.3)':'rgba(239,68,68,.3)');
  el.style.fontSize='12px';el.style.fontFamily='var(--font-mono)';
  el.style.color=ok?'var(--win)':'var(--loss)';el.textContent=text;
}
async function adminAction(path,method,resultId,textFn,okFn){
  try{const r=await fetch(path,{credentials:'include',method});const d=await r.json();showResultBox(resultId,textFn(d),okFn(d));}
  catch(e){showResultBox(resultId,e.message,false);}
}
async function sendTgSignal(){
  try{const r=await fetch('/admin/telegram/send',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({message:'🟢 <b>BTCUSDT</b> LONG\n\n⭐⭐⭐ Score: <b>82/100</b>\n📡 Test-Signal aus Admin-Panel'})});
  const d=await r.json();showResultBox('tg-result',d.success?'Test-Signal gesendet ✓':(d.error||'Fehler'),d.success);
  }catch(e){showResultBox('tg-result',e.message,false);}
}
async function sendTgCustom(){
  const msg=document.getElementById('tg-msg')?.value?.trim();if(!msg)return;
  try{const r=await fetch('/admin/telegram/send',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:msg})});
  const d=await r.json();showResultBox('tg-send-result',d.success?'Nachricht gesendet ✓':(d.error||'Fehler'),d.success);
  }catch(e){showResultBox('tg-send-result',e.message,false);}
}
async function runSetupDB(){
  try{const r=await fetch('/admin/setup-db',{credentials:'include',method:'POST'});const d=await r.json();
  document.getElementById('setup-result').textContent=(d.results||[d.error||'OK']).join('\\n');
  adminToast(d.success?'Setup erfolgreich':'Fehler',d.success?'ok':'err');
  }catch(e){document.getElementById('setup-result').textContent=e.message;}
}
async function deleteSignals(type){
  try{const r=await fetch('/admin/delete-signals',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type})});
  const d=await r.json();document.getElementById('delete-result').textContent=d.success?(d.deleted??'')+' gelöscht':(d.error||'Fehler');
  if(d.success)adminToast('Gelöscht');
  }catch(e){document.getElementById('delete-result').textContent=e.message;}
}
async function changeRole(userId,role){
  try{const r=await fetch('/admin/users/'+userId+'/role',{credentials:'include',method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({role})});
  const d=await r.json();adminToast(d.success?'Rolle geändert auf '+role:(d.error||'Fehler'),d.success?'ok':'err');
  }catch(e){adminToast(e.message,'err');}
}
async function toggleBlock(userId,block){
  if(!confirm(block?'User sperren?':'User entsperren?'))return;
  try{const r=await fetch('/admin/block-user',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,blocked:block})});
  const d=await r.json();
  if(d.success){adminToast(block?'User gesperrt':'User entsperrt');htmx.ajax('GET','/settings?section=admin',{target:'#settings-section',swap:'innerHTML'});}
  else adminToast(d.error||'Fehler','err');
  }catch(e){adminToast(e.message,'err');}
}
function closeModal(){document.getElementById('modal-overlay').style.display='none';}
function openModal(html){document.getElementById('modal-html').innerHTML=html;document.getElementById('modal-overlay').style.display='flex';}
function showChangePwModal(userId,username){
  openModal(\`<h2 style="margin-bottom:6px">Passwort ändern</h2>
    <p style="color:var(--text-tertiary);font-size:13px;margin-bottom:20px">Für: <strong>\${username}</strong></p>
    <div style="margin-bottom:20px"><label style="display:block;margin-bottom:6px;font-size:13px">Neues Passwort</label>
    <input type="password" id="new-pw" class="input" style="width:100%" placeholder="Mindestens 8 Zeichen" autofocus></div>
    <div style="display:flex;gap:10px">
      <button onclick="doChangePw('\${userId}')" style="flex:1;padding:8px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">Ändern</button>
      <button onclick="closeModal()" style="padding:8px 16px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">Abbrechen</button>
    </div>\`);
}
async function doChangePw(userId){
  const pw=document.getElementById('new-pw')?.value;
  if(!pw||pw.length<8){alert('Mindestens 8 Zeichen');return;}
  try{const r=await fetch('/admin/change-password',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,newPassword:pw})});
  const d=await r.json();if(d.success){closeModal();adminToast('Passwort geändert');}else adminToast(d.error||'Fehler','err');
  }catch(e){adminToast(e.message,'err');}
}
function showCreateUserModal(){
  openModal(\`<h2 style="margin-bottom:20px">Neuen User anlegen</h2>
    <div id="cu-err" style="display:none;padding:10px;border-radius:8px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);font-size:13px;color:var(--loss);margin-bottom:14px"></div>
    <div style="margin-bottom:14px"><label style="display:block;margin-bottom:6px;font-size:13px">Benutzername</label>
      <input type="text" id="cu-username" class="input" style="width:100%" placeholder="z.B. peter" autofocus></div>
    <div style="margin-bottom:14px"><label style="display:block;margin-bottom:6px;font-size:13px">Email</label>
      <input type="email" id="cu-email" class="input" style="width:100%" placeholder="peter@example.com"></div>
    <div style="margin-bottom:14px"><label style="display:block;margin-bottom:6px;font-size:13px">Passwort</label>
      <input type="password" id="cu-pw" class="input" style="width:100%" placeholder="Mindestens 8 Zeichen"></div>
    <div style="margin-bottom:20px"><label style="display:block;margin-bottom:6px;font-size:13px">Rolle</label>
      <select id="cu-role" class="input" style="width:100%">
        <option value="viewer">VIEWER</option><option value="trader">TRADER</option><option value="admin">ADMIN</option>
      </select></div>
    <div style="display:flex;gap:10px">
      <button onclick="doCreateUser()" style="flex:1;padding:8px;border-radius:8px;background:var(--blue-500);border:none;color:#fff;font-size:13px;cursor:pointer;font-family:var(--font-main)">Erstellen</button>
      <button onclick="closeModal()" style="padding:8px 16px;border-radius:8px;background:var(--bg-2);border:1px solid var(--border);color:var(--text-primary);font-size:13px;cursor:pointer;font-family:var(--font-main)">Abbrechen</button>
    </div>\`);
}
async function doCreateUser(){
  const u=document.getElementById('cu-username')?.value?.trim();
  const e=document.getElementById('cu-email')?.value?.trim();
  const p=document.getElementById('cu-pw')?.value;
  const role=document.getElementById('cu-role')?.value;
  const errEl=document.getElementById('cu-err');
  if(!u||!e||!p){errEl.textContent='Bitte alle Felder ausfüllen';errEl.style.display='block';return;}
  if(p.length<8){errEl.textContent='Passwort muss mindestens 8 Zeichen haben';errEl.style.display='block';return;}
  errEl.style.display='none';
  try{const r=await fetch('/admin/create-user',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,email:e,password:p,role})});
  const d=await r.json();
  if(d.success||d.id){closeModal();adminToast('User erstellt');htmx.ajax('GET','/settings?section=admin',{target:'#settings-section',swap:'innerHTML'});}
  else{errEl.textContent=d.error||'Fehler';errEl.style.display='block';}
  }catch(ex){errEl.textContent=ex.message;errEl.style.display='block';}
}
</script>`;
}

function _renderSettingsSection(section, data, session) {
  const isAdmin = session?.role === 'admin';
  switch (section) {
    case 'account':       return _renderSettingsAccount(session);
    case 'design':        return _renderSettingsDesign();
    case 'trading':       return _renderSettingsTrading();
    case 'notifications': return _renderSettingsNotifications();
    case 'broker':        return _renderSettingsBroker();
    case 'admin':         return isAdmin ? _renderSettingsAdmin(data) : _renderSettingsAccount(session);
    case 'system':        return isAdmin ? _renderSettingsSystem() : _renderSettingsAccount(session);
    default:              return _renderSettingsAccount(session);
  }
}

function _renderSettingsPage(section, data, session) {
  const isAdmin = session?.role === 'admin';
  const nav = _renderSettingsNav(section, isAdmin);
  const sectionHtml = _renderSettingsSection(section, data, session);
  return `
<div class="content page-enter">
  <div class="page-header">
    <h2>Einstellungen</h2>
    <div class="subtitle">Konfiguration &amp; Verwaltung</div>
  </div>
  <div id="settings-section" style="display:grid;grid-template-columns:220px 1fr;gap:20px;align-items:start">
    ${nav}
    <div id="settings-content">${sectionHtml}</div>
  </div>
</div>`;
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
          const startingCapital = parseFloat(env.STARTING_CAPITAL || '10000');
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

        const startingCapital = parseFloat(env.STARTING_CAPITAL || '10000');
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
            open: stats.open
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
             WHERE ai_score >= 70 AND outcome != 'SKIPPED'
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

      if (request.method === "POST" && url.pathname === "/practice-trades/manual") {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const { signalId } = await request.json();
        if (!signalId) return jsonResponse({ error: "signalId erforderlich" }, 400);

        const signal = await env.DB.prepare(`SELECT * FROM signals WHERE id = ?`).bind(signalId).first();
        if (!signal) return jsonResponse({ error: "Signal nicht gefunden" }, 404);

        const MAX_AGE_MS = 2 * 60 * 60 * 1000;
        const signalAge = Date.now() - new Date(signal.created_at).getTime();
        if (signalAge > MAX_AGE_MS) {
          const ageH = Math.floor(signalAge / 3600000);
          const ageM = Math.floor((signalAge % 3600000) / 60000);
          return jsonResponse({ error: `Signal ist ${ageH}h ${ageM}m alt — zu alt für Demo-Trade (max. 2h)` }, 400);
        }

        if (!signal.ai_entry || !signal.ai_tp || !signal.ai_sl) {
          return jsonResponse({ error: "Signal hat keine Entry/TP/SL Daten" }, 400);
        }

        const existingTrade = await env.DB.prepare(`SELECT id FROM practice_trades WHERE signal_id = ?`).bind(signalId).first();
        if (existingTrade) {
          return jsonResponse({ error: "Demo-Trade für dieses Signal existiert bereits", tradeId: existingTrade.id }, 409);
        }

        await env.DB.prepare(`
          INSERT INTO practice_trades (
            signal_id, symbol, timeframe, direction,
            entry_price, take_profit, stop_loss, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
        `).bind(
          signalId,
          signal.symbol || 'UNKNOWN',
          String(signal.timeframe || '5'),
          signal.direction,
          signal.ai_entry,
          signal.ai_tp,
          signal.ai_sl,
          new Date().toISOString()
        ).run();

        return jsonResponse({ success: true, message: `Demo-Trade für ${signal.symbol} ${signal.direction} erstellt` });
      }

      if (request.method === "PATCH" && url.pathname.startsWith("/practice-trades/")) {
        const session = await validateSession(env, request);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const tradeId = url.pathname.replace("/practice-trades/", "");
        const { status, exitPrice } = await request.json();
        const allowed = ['WIN', 'LOSS', 'BE', 'OPEN', 'IGNORED'];
        if (!status || !allowed.includes(status)) return jsonResponse({ error: "Ungültiger status" }, 400);
        const now = new Date().toISOString();
        await env.DB.prepare(`
          UPDATE practice_trades
          SET status = ?, exit_price = COALESCE(?, exit_price), closed_at = CASE WHEN ? IN ('WIN','LOSS','BE','IGNORED') THEN ? ELSE closed_at END
          WHERE id = ?
        `).bind(status, exitPrice ?? null, status, now, tradeId).run();
        return jsonResponse({ success: true, id: tradeId, status });
      }

      // ── PRACTICE TRADES ─────────────────────────────────────

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

      // ── 3H PROFIT-CLOSE (manual trigger) ────────────────────────
      if (request.method === "POST" && url.pathname === "/admin/check-3h-profit") {
        const session = await validateSession(env, request);
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const results  = await check3hProfitClose(env);
          const closed   = results.filter(r => r.status === 'closed_profit').length;
          const open     = results.filter(r => r.status === 'open_no_profit').length;
          const noPrice  = results.filter(r => r.status === 'no_price').length;
          return jsonResponse({ success: true, checked: results.length, closed_profit: closed, still_open: open, no_price: noPrice, results });
        } catch (e) {
          return jsonResponse({ success: false, error: e.message }, 500);
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

      if (request.method === "POST" && url.pathname === "/webhook") {
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
          return jsonResponse({ error: 'Failed to read body' }, 400);
        }

        try {
          payload = JSON.parse(rawBody);
          console.log('📦 Parsed payload:', JSON.stringify(payload).substring(0, 500));
        } catch (parseErr) {
          console.error('❌ JSON parse error:', parseErr.message);
          return jsonResponse({ error: 'Invalid JSON' }, 400);
        }

        // Validate secret now that body is available.
        if (env.WEBHOOK_SECRET) {
          const effectiveSecret = request.headers.get('X-Webhook-Secret')
                               || payload.secret
                               || urlSecret;
          if (effectiveSecret !== env.WEBHOOK_SECRET) {
            console.warn('⛔ Webhook: wrong or missing secret');
            return jsonResponse({ error: "Unauthorized" }, 401);
          }
        }
        // Remove secret from payload so it is not persisted to the database.
        if (payload.secret !== undefined) delete payload.secret;

        const eventType = (payload.event_type || 'SIGNAL').toUpperCase();
        console.log('🎯 event_type:', eventType, '| symbol:', payload.symbol, '| action:', payload.action);

        try {
          if (eventType === 'SNAPSHOT') {
            ctx.waitUntil(
              saveSnapshot(env, payload).catch(err => console.error('❌ SNAPSHOT async save failed:', err?.message || err))
            );
            return jsonResponse({ success: true, type: 'SNAPSHOT', message: 'Snapshot accepted' });
          }

          if (eventType === 'PRICE_UPDATE') {
            ctx.waitUntil(
              handlePriceUpdate(env, payload).catch(err => console.error('❌ PRICE_UPDATE async failed:', err?.message || err))
            );
            return jsonResponse({ success: true, type: 'PRICE_UPDATE', message: 'Price update accepted' });
          }

          if (eventType === 'SIGNAL_NEW' || eventType === 'SIGNAL') {
            const direction = normalizeDirection(payload);
            const action    = normalizeAction(payload);
            if (!direction) {
              console.log('⏭️ SIGNAL_NEW skipped — no recognisable direction:', JSON.stringify(payload).substring(0, 300));
              return jsonResponse({ success: true, type: 'SIGNAL_NEW', status: 'skipped', reason: 'no_actionable_direction', direction, action });
            }
            return jsonResponse(await processSignal(env, payload));
          }

          return jsonResponse({ success: true, type: eventType, message: 'Unsupported event_type accepted' });
        } catch (processingErr) {
          const errMsg = processingErr?.message || String(processingErr);
          console.error('❌ Webhook processing error:', errMsg, processingErr?.stack);
          return jsonResponse({
            success: false,
            type: eventType,
            error: errMsg,
            message: 'Processing failed — signal NOT saved. Check Worker logs.'
          }, 500);
        }
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

    // Every 3h: close open trades that are in profit
    if (event.cron === "0 */3 * * *") {
      try {
        await check3hProfitClose(env);
      } catch (err) {
        console.error('❌ Cron 3h profit-close error:', err.message);
        ctx.waitUntil(sendTelegramMessage(env, `⚠️ Cron-Fehler (3h): ${err.message}`).catch(() => {}));
      }
    }

    // Every 4h: evaluate TP/SL hits + profit-close for 4h window
    if (event.cron === "0 */4 * * *") {
      try {
        await check3hProfitClose(env);
        await evaluateOpenTrades(env);
      } catch (err) {
        console.error('❌ Cron 4h evaluation error:', err.message);
        ctx.waitUntil(sendTelegramMessage(env, `⚠️ Cron-Fehler (4h): ${err.message}`).catch(() => {}));
      }
    }

    // Re-evaluate open practice trades with latest snapshot prices
    try {
      const tableCheck = await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
      ).first();
      if (tableCheck) {
        const openTrades = await env.DB.prepare(
          `SELECT DISTINCT symbol FROM practice_trades WHERE status='OPEN'`
        ).all();
        for (const row of (openTrades.results || [])) {
          const snap = await getSnapshot(env, row.symbol, '5m');
          if (snap?.price) await checkPracticeTrades(env, row.symbol, snap.price);
        }
      }
    } catch (err) {
      console.error('❌ Practice trades cron error:', err.message);
    }

    if (event.cron === "0 7 * * *") {
      try {
        await sendDailySummary(env);
      } catch (err) {
        console.error('❌ Daily summary cron error:', err.message);
      }
    }

    // Refresh news cache in the background on every cron run so the News
    // page always shows fresh data even when no user is visiting.
    ctx.waitUntil(getMarketRadar(env));
  }
};
