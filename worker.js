// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - PRODUCTION WORKER
// Signal Processing · Snapshots · Telegram · Backtesting
// ═══════════════════════════════════════════════════════════════

function hashPassword(password) {
  return btoa(password);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID",
  "Access-Control-Allow-Credentials": "true"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

const MARKET_RADAR_CACHE_TTL_MS = 20 * 60 * 1000;
const MARKET_RADAR_MAX_EVENTS = 20;
const MARKET_RADAR_FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/' },
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

async function withTimeout(promise, ms, fallbackValue = null) {
  let timeoutId;
  const timeoutPromise = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve(fallbackValue), ms);
  });
  const result = await Promise.race([promise, timeoutPromise]);
  clearTimeout(timeoutId);
  return result;
}

function formatSignalForTelegram(signal) {
  const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
  const scoreEmoji = signal.ai_score >= 75 ? '⭐⭐⭐' : signal.ai_score >= 65 ? '⭐⭐' : '⭐';
  return `
${emoji} <b>${signal.symbol}</b> ${signal.direction}

${scoreEmoji} Score: <b>${signal.ai_score}/100</b>
📊 Timeframe: ${signal.timeframe}
💰 Entry: $${signal.ai_entry?.toFixed(2) || signal.price?.toFixed(2)}
🎯 TP: $${signal.ai_tp?.toFixed(2) || 'N/A'}
🛑 SL: $${signal.ai_sl?.toFixed(2) || 'N/A'}

${signal.ai_reason || 'Signal von TradingView'}
  `.trim();
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY SYSTEM
// ═══════════════════════════════════════════════════════════════

const DEFAULT_STRATEGY_CONFIG = {
  rules: {
    rsi:                { enabled: true, weight: 18 },
    ema:                { enabled: true, weight: 12 },
    trend:              { enabled: true, weight: 10 },
    wave_bias:          { enabled: true, weight: 10 },
    support_resistance: { enabled: true, weight: 8  },
    timeframe:          { enabled: true, weight: 8  },
    confidence:         { enabled: true, weight: 10 }
  },
  thresholds: {
    min_trade_score:    70,
    min_telegram_score: 55,
    max_risk:           'MEDIUM'
  }
};

// ═══════════════════════════════════════════════════════════════
// AI ANALYSIS
// ═══════════════════════════════════════════════════════════════

async function analyzeSignalWithAI(env, signal, strategyConfig = null) {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('⚠️ No AI API key, using rule-based analysis');
    return analyzeWithRules(signal);
  }
  try {
    const prompt = `Analyze this trading signal and provide a recommendation.

Signal:
- Symbol: ${signal.symbol}
- Direction: ${signal.direction}
- Price: ${signal.price}
- Timeframe: ${signal.timeframe}
- Trigger: ${signal.trigger}

Provide:
1. Recommendation: RECOMMENDED, WAIT, or SKIP
2. Score: 0-100
3. Risk: LOW, MEDIUM, or HIGH
4. Entry price
5. Take Profit price
6. Stop Loss price
7. Brief reason (max 100 characters)

Format as JSON:
{
  "recommendation": "...",
  "score": 0,
  "risk": "...",
  "entry": 0,
  "tp": 0,
  "sl": 0,
  "reason": "..."
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
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

    const data = await response.json();
    const text = data.content[0].text;
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

  // Extract weights from config (0 = disabled)
  const rW  = cfg.rules?.rsi?.enabled                !== false ? (cfg.rules?.rsi?.weight                ?? 18) : 0;
  const eW  = cfg.rules?.ema?.enabled                !== false ? (cfg.rules?.ema?.weight                ?? 12) : 0;
  const tW  = cfg.rules?.trend?.enabled              !== false ? (cfg.rules?.trend?.weight              ?? 10) : 0;
  const wW  = cfg.rules?.wave_bias?.enabled          !== false ? (cfg.rules?.wave_bias?.weight          ?? 10) : 0;
  const srW = cfg.rules?.support_resistance?.enabled !== false ? (cfg.rules?.support_resistance?.weight ?? 8)  : 0;
  const tfW = cfg.rules?.timeframe?.enabled          !== false ? (cfg.rules?.timeframe?.weight          ?? 8)  : 0;
  const cW  = cfg.rules?.confidence?.enabled         !== false ? (cfg.rules?.confidence?.weight         ?? 10) : 0;

  let score = 50;

  // ── RSI ──────────────────────────────────────────────────────
  const rsi = parseFloat(signal.rsi ?? 50);
  if (rW > 0) {
    if (isLong) {
      if      (rsi < 30) score += rW;
      else if (rsi < 40) score += Math.round(rW * 0.56);
      else if (rsi < 50) score += Math.round(rW * 0.22);
      else if (rsi > 70) score -= rW;
      else if (rsi > 60) score -= Math.round(rW * 0.33);
    } else if (isShort) {
      if      (rsi > 70) score += rW;
      else if (rsi > 60) score += Math.round(rW * 0.56);
      else if (rsi > 50) score += Math.round(rW * 0.22);
      else if (rsi < 30) score -= rW;
      else if (rsi < 40) score -= Math.round(rW * 0.33);
    }
  }

  // ── EMA trend alignment ──────────────────────────────────────
  const ema50  = parseFloat(signal.ema50  ?? 0);
  const ema200 = parseFloat(signal.ema200 ?? 0);
  if (eW > 0 && ema50 && ema200) {
    const bullish = ema50 > ema200;
    if (isLong  && bullish)  score += eW;
    if (isShort && !bullish) score += eW;
    if (isLong  && !bullish) score -= eW;
    if (isShort && bullish)  score -= eW;
  }

  // ── Trend label ──────────────────────────────────────────────
  const trend = (signal.trend || '').toUpperCase();
  if (tW > 0) {
    if (trend === 'BULLISH' || trend === 'UP')     score += isLong  ? tW : -tW;
    else if (trend === 'BEARISH' || trend === 'DOWN') score += isShort ? tW : -tW;
  }

  // ── Wave bias ────────────────────────────────────────────────
  const waveBias = (signal.wave_bias || '').toUpperCase();
  if (wW > 0) {
    if (waveBias === 'LONG')  score += isLong  ? wW : -Math.round(wW * 0.5);
    if (waveBias === 'SHORT') score += isShort ? wW : -Math.round(wW * 0.5);
  }

  // ── Timeframe ────────────────────────────────────────────────
  if (tfW > 0) {
    const tf = String(signal.timeframe || '').replace('m','').replace('h','H');
    if      (['60','240','1H','4H'].includes(tf)) score += tfW;
    else if (['15','30'].includes(tf))             score += Math.round(tfW * 0.5);
  }

  // ── Confidence ───────────────────────────────────────────────
  if (cW > 0) {
    const confidence = parseFloat(signal.confidence ?? 0);
    if      (confidence >= 80) score += cW;
    else if (confidence >= 60) score += Math.round(cW * 0.5);
  }

  // ── Support / Resistance proximity ───────────────────────────
  const price      = parseFloat(signal.price ?? 0);
  const support    = parseFloat(signal.support ?? 0);
  const resistance = parseFloat(signal.resistance ?? 0);
  if (srW > 0) {
    if (price && support && isLong && price > support) {
      if ((price - support) / price < 0.02) score += srW;
    }
    if (price && resistance && isShort && price < resistance) {
      if ((resistance - price) / price < 0.02) score += srW;
    }
  }

  // ── Clamp ────────────────────────────────────────────────────
  score = Math.max(0, Math.min(100, Math.round(score)));

  // ── Recommendation (uses config thresholds) ──────────────────
  const minTrade    = cfg.thresholds?.min_trade_score    ?? 70;
  const minTelegram = cfg.thresholds?.min_telegram_score ?? 55;

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

  // ── TP / SL ──────────────────────────────────────────────────
  const entry = price || 0;
  const tp    = isLong  ? entry * 1.02 : entry * 0.98;
  const sl    = isLong  ? entry * 0.99 : entry * 1.01;

  // ── Reason ───────────────────────────────────────────────────
  const reasons = [];
  if (rsi && (rsi < 35 || rsi > 65)) reasons.push(`RSI ${rsi}`);
  if (ema50 && ema200) reasons.push(`EMA ${ema50 > ema200 ? 'bullish' : 'bearish'}`);
  if (trend)    reasons.push(`Trend: ${trend}`);
  if (waveBias) reasons.push(`Bias: ${waveBias}`);
  const reason = reasons.length > 0 ? reasons.join(' · ') : 'Rule-based analysis';

  return { recommendation, score, risk, entry, tp, sl, reason, direction: dir };
}

// ═══════════════════════════════════════════════════════════════
// DB INITIALIZATION
// ═══════════════════════════════════════════════════════════════

async function ensureTables(env) {
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
        status TEXT DEFAULT 'ACTIVE'
      )
    `).run();

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
    ];
    for (const [col, type] of stratCols) {
      try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    // Migrate users table
    const userCols = [
      ['skip_password_change', 'INTEGER DEFAULT 0'],
      ['blocked',              'INTEGER DEFAULT 0'],
      ['last_seen',            'INTEGER'],
    ];
    for (const [col, type] of userCols) {
      try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

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
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (res.ok) {
      const data = await res.json();
      if (data?.price) return parseFloat(data.price);
    }
  } catch (_) {}
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

  await env.DB.prepare(`
    INSERT INTO snapshots (
      symbol, timeframe, price, rsi, ema50, ema200,
      support, resistance, trend, trend_1h, trend_4h, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    data.symbol || 'UNKNOWN',
    String(data.timeframe || '5'),
    data.price || 0,
    data.rsi ?? null,
    data.ema50 ?? null,
    data.ema200 ?? null,
    data.support ?? null,
    data.resistance ?? null,
    data.trend || null,
    data.trend_1h || null,
    data.trend_4h || null,
    new Date().toISOString()
  ).run();

  if (data.price && data.symbol) {
    await checkPracticeTrades(env, data.symbol, data.price);
  }

  console.log('✅ Snapshot saved:', data.symbol);
  return { status: 'ok', type: 'snapshot', symbol: data.symbol, price: data.price };
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

        await env.DB.prepare(`
          UPDATE practice_trades SET status = ?, exit_price = ?, result_pct = ?, closed_at = ?
          WHERE id = ?
        `).bind(newStatus, currentPrice, parseFloat(resultPct.toFixed(2)), new Date().toISOString(), trade.id).run();

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

async function getPracticeTradeStats(env) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
    ).first();
    if (!tableCheck) return { total: 0, open: 0, wins: 0, losses: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0 };

    const total   = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades`).first();
    const open    = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='OPEN'`).first();
    const wins    = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='WIN'`).first();
    const losses  = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='LOSS'`).first();
    const avgWin  = await env.DB.prepare(`SELECT AVG(result_pct) as a FROM practice_trades WHERE status='WIN'`).first();
    const avgLoss = await env.DB.prepare(`SELECT AVG(result_pct) as a FROM practice_trades WHERE status='LOSS'`).first();

    const closed  = (wins.c || 0) + (losses.c || 0);
    const winRate = closed > 0 ? ((wins.c / closed) * 100) : 0;

    return {
      total: total.c || 0,
      open: open.c || 0,
      wins: wins.c || 0,
      losses: losses.c || 0,
      winRate: parseFloat(winRate.toFixed(1)),
      avgWinPct: parseFloat((avgWin.a || 0).toFixed(2)),
      avgLossPct: parseFloat((avgLoss.a || 0).toFixed(2))
    };
  } catch (error) {
    console.error('❌ getPracticeTradeStats error:', error.message);
    return { total: 0, open: 0, wins: 0, losses: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0 };
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

  await ensureTables(env);

  // Resolve active strategy (auto-init default if none)
  let strategy = await getActiveStrategy(env);
  if (!strategy) strategy = await initDefaultStrategy(env);
  const strategyConfig = strategy?.config || null;

  const fallbackAnalysis = analyzeWithRules(signal, strategyConfig);
  const analysis = await withTimeout(
    analyzeSignalWithAI(env, signal, strategyConfig),
    AI_TIMEOUT_MS,
    fallbackAnalysis
  ) || fallbackAnalysis;
  const signalId = `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Determine Telegram notification
  const isTest       = signal.test === true || signal.is_test === 1;
  const shouldNotify = isTest || analysis.score >= 55;
  let telegramSent   = 0;
  let telegramReason = 'below_threshold';

  if (shouldNotify) {
    telegramReason = isTest ? 'test_signal' : (analysis.score >= 70 ? 'score_70' : 'score_55');
    const debugPrefix = (analysis.score < 70 || isTest)
      ? `🧪 <b>[${isTest ? 'TEST' : 'DEBUG'}]</b>\n` : '';
    const telegramMessage = debugPrefix + formatSignalForTelegram({
      ...signal,
      direction,
      ai_score:  analysis.score,
      ai_entry:  analysis.entry,
      ai_tp:     analysis.tp,
      ai_sl:     analysis.sl,
      ai_reason: analysis.reason
    });
    const sent = await withTimeout(sendTelegramMessage(env, telegramMessage), TELEGRAM_TIMEOUT_MS, false);
    if (sent) telegramSent = 1;
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
      created_at, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    Date.now(),
    'OPEN'
  ).run();

  await createPracticeTrade(env, signalId, { ...signal, direction }, analysis);

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
    const res = await fetch(feed.url, { cf: { cacheTtl: 300, cacheEverything: true } });
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
    `SELECT * FROM market_events WHERE status = 'ACTIVE' AND updated_at >= ? ORDER BY impact DESC, event_time DESC LIMIT ?`
  ).bind(now - MARKET_RADAR_CACHE_TTL_MS, MARKET_RADAR_MAX_EVENTS).all();

  if (freshCache.results?.length) {
    const events = freshCache.results.map(r => ({ ...r, affected_markets: JSON.parse(r.affected_markets || '[]') }));
    return withDebug({ status: computeRadarStatus(events), updated_at: now, summary: "BTC/Krypto-Markt mit erhöhter Event-Aktivität.", events, disclaimer: RADAR_DISCLAIMER, source: 'CACHE' });
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
      (id, created_at, updated_at, event_time, title, category, impact, affected_markets, source, source_url, summary, radar_status, raw_json, status)
      VALUES (?, COALESCE((SELECT created_at FROM market_events WHERE id = ?), ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).bind(
      event.id, event.id, now, now, event.event_time, event.title, event.category, event.impact,
      JSON.stringify(event.affected_markets), event.source, event.source_url, event.summary, status, JSON.stringify(event)
    ).run();
    debug.db_saved += 1;
  }

  const outputEvents = relevant.length ? relevant : (await env.DB.prepare(
    `SELECT * FROM market_events WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT ?`
  ).bind(MARKET_RADAR_MAX_EVENTS).all()).results.map(r => ({ ...r, affected_markets: JSON.parse(r.affected_markets || '[]') }));

  return withDebug({
    status: computeRadarStatus(outputEvents),
    updated_at: now,
    summary: outputEvents.length ? "BTC/Krypto-Markt mit erhöhter Event-Aktivität." : "Keine relevanten Markt-Events gefunden.",
    events: outputEvents,
    disclaimer: RADAR_DISCLAIMER
  });
  } catch (error) {
    console.error('❌ market-radar error:', error?.message || error);
    debug.error_message = String(error?.message || error || 'market-radar failed');
    return withDebug({
      status: 'NORMAL',
      updated_at: now,
      summary: 'Radar-Daten aktuell nicht verfügbar. Letzte Daten konnten nicht geladen werden.',
      events: [],
      disclaimer: RADAR_DISCLAIMER
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTH FUNCTIONS (D1-backed sessions)
// ═══════════════════════════════════════════════════════════════

async function login(env, username, password) {
  const user = await env.DB.prepare(
    `SELECT * FROM users WHERE username = ? OR email = ?`
  ).bind(username, username).first();

  if (!user) return { success: false, error: 'Benutzer nicht gefunden' };
  if (user.blocked) return { success: false, error: 'Konto gesperrt' };

  if (user.password_hash !== hashPassword(password)) {
    return { success: false, error: 'Falsches Passwort' };
  }

  await ensureTables(env);

  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;

  const mustChange = user.must_change_password === 1 && user.skip_password_change !== 1;

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, username, role, must_change_password, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(sessionId, user.id, user.username, user.role, mustChange ? 1 : 0, now, expiresAt).run();

  try {
    await env.DB.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`).bind(now, user.id).run();
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
  ).bind(hashPassword(newPassword), Date.now(), userId).run();
  try {
    await env.DB.prepare(`UPDATE sessions SET must_change_password = 0 WHERE user_id = ?`).bind(userId).run();
  } catch (_) {}
  return { success: true };
}

async function validateSession(env, sessionId) {
  if (!sessionId) return null;
  try {
    const session = await env.DB.prepare(
      `SELECT * FROM sessions WHERE id = ? AND expires_at > ?`
    ).bind(sessionId, Date.now()).first();

    if (!session) return null;

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
      createdAt: session.created_at
    };
  } catch (_) {
    return null;
  }
}

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
    if (!tableCheck) return { total: 0, wins: 0, losses: 0, open: 0, winRate: 0 };

    const total  = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals`).first();
    const wins   = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'WIN'`).first();
    const losses = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'LOSS'`).first();
    const open   = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'OPEN'`).first();

    const winRate = (wins.count + losses.count) > 0
      ? (wins.count / (wins.count + losses.count)) * 100
      : 0;

    return {
      total: total.count || 0,
      wins: wins.count || 0,
      losses: losses.count || 0,
      open: open.count || 0,
      winRate: parseFloat(winRate.toFixed(1))
    };
  } catch (error) {
    console.error('Error in getStats:', error);
    return { total: 0, wins: 0, losses: 0, open: 0, winRate: 0 };
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
        const now       = Date.now();

        await env.DB.prepare(`
          UPDATE signals SET
            outcome = ?, exit_price = ?, pnl_pct = ?,
            closed_at = ?, outcome_source = 'auto',
            telegram_outcome_sent = 1, updated_at = ?
          WHERE id = ?
        `).bind(outcome, exitPrice, parseFloat(pnlPct.toFixed(2)), now, now, signal.id).run();

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

// ═══════════════════════════════════════════════════════════════
// MAIN WORKER
// ═══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {

      // ── AUTH ────────────────────────────────────────────────

      if (request.method === "POST" && url.pathname === "/auth/login") {
        const { username, password } = await request.json();
        const result = await login(env, username, password);
        return jsonResponse(result, result.success ? 200 : 401);
      }

      if (request.method === "POST" && url.pathname === "/auth/logout") {
        return jsonResponse(await logout(env, request.headers.get("X-Session-ID")));
      }

      if (request.method === "POST" && url.pathname === "/auth/change-password") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const { newPassword } = await request.json();
        return jsonResponse(await changePassword(env, session.userId, newPassword));
      }

      // ── DASHBOARD LIVE DATA ─────────────────────────────────

      if (request.method === "GET" && url.pathname === "/dashboard/live") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const [stats, latestSignals, bestSignal, marketBias, todayPnL] = await Promise.all([
          getStats(env), getHistory(env, 10), getBestSignal(env), getMarketBias(env), getTodayPnL(env)
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
          user: { username: session.username, role: session.role }
        });
      }

      if (request.method === "GET" && url.pathname === "/market-radar") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getMarketRadar(env, session));
      }

      // ── DATA ─────────────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/stats") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getStats(env));
      }

      if (request.method === "GET" && url.pathname === "/history") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const limit = parseInt(url.searchParams.get("limit") || "50");
        return jsonResponse(await getHistory(env, limit));
      }

      if (request.method === "GET" && url.pathname === "/analytics") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
            FROM signals GROUP BY timeframe ORDER BY total DESC
          `).all();

          const dirRows = await env.DB.prepare(`
            SELECT direction,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
            FROM signals WHERE direction IN ('LONG','SHORT')
            GROUP BY direction
          `).all();

          const symbolRows = await env.DB.prepare(`
            SELECT symbol,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
            FROM signals GROUP BY symbol ORDER BY total DESC LIMIT 10
          `).all();

          const calcWR = r => (r.wins + r.losses) > 0 ? parseFloat(((r.wins / (r.wins + r.losses)) * 100).toFixed(1)) : 0;

          return jsonResponse({
            timeframes: (tfRows.results || []).map(r => ({ ...r, winRate: calcWR(r) })),
            directions: (dirRows.results || []).map(r => ({ ...r, winRate: calcWR(r) })),
            symbols:    (symbolRows.results || []).map(r => ({ ...r, winRate: calcWR(r) }))
          });
        } catch (e) {
          return jsonResponse({ timeframes: [], directions: [], symbols: [] });
        }
      }

      // ── SIGNALS PATCH ────────────────────────────────────────

      if (request.method === "PATCH" && url.pathname.startsWith("/signals/") && !url.pathname.includes("/loss-reason")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.replace("/signals/", "");
        await env.DB.prepare(`DELETE FROM signals WHERE id = ?`).bind(signalId).run();
        await env.DB.prepare(`DELETE FROM signal_loss_reasons WHERE signal_id = ?`).bind(signalId).run();
        return jsonResponse({ success: true });
      }

      // ── PRACTICE TRADES ─────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/practice-trades") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getPracticeTradeStats(env));
      }

      // ── CHECKLIST ───────────────────────────────────────────

      if (request.method === "POST" && url.pathname === "/checklist") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        return jsonResponse(await saveChecklist(env, body, session.username));
      }

      if (request.method === "GET" && url.pathname === "/checklist") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        return jsonResponse(await getChecklist(env, date, session.username));
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/checklist/")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const entryId = url.pathname.slice("/checklist/".length);
        await env.DB.prepare(`DELETE FROM checklists WHERE id = ? AND user = ?`)
          .bind(entryId, session.username).run();
        return jsonResponse({ success: true });
      }

      // ── ADMIN ───────────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/users") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getUsers(env));
      }

      if (request.method === "POST" && url.pathname === "/admin/create-user") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        `).bind(id, username, email, hashPassword(password), role || 'user', skipPasswordChange ? 1 : 0, now, now).run();
        return jsonResponse({ success: true, id });
      }

      if (request.method === "POST" && url.pathname === "/admin/block-user") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { userId } = await request.json();
        try { await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run(); } catch (_) {}
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname === "/admin/change-password") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { userId, newPassword } = await request.json();
        return jsonResponse(await changePassword(env, userId, newPassword));
      }

      if (request.method === "GET" && url.pathname === "/test-telegram") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const testMessage = `🧪 <b>WAVESCOUT Test</b>\n\nTelegram ist korrekt konfiguriert!\n⏰ ${new Date().toLocaleString('de-DE')}`;
        const success = await sendTelegramMessage(env, testMessage);
        return jsonResponse({ success, message: success ? 'Telegram-Nachricht gesendet!' : 'Fehler beim Senden' });
      }

      // Send custom Telegram message
      if (request.method === "POST" && url.pathname === "/admin/telegram/send") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { message } = await request.json();
        if (!message?.trim()) return jsonResponse({ error: 'message erforderlich' }, 400);
        const success = await sendTelegramMessage(env, message.trim());
        return jsonResponse({ success, message: success ? 'Gesendet!' : 'Fehler beim Senden' });
      }

      // System status overview
      if (request.method === "GET" && url.pathname === "/admin/status") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
          anthropic: !!env.ANTHROPIC_API_KEY,
          webhook: !!env.WEBHOOK_SECRET,
          tables: tableCounts,
          version: '3.4.0',
          time: new Date().toISOString()
        });
      }

      // Test Anthropic AI connection
      if (request.method === "POST" && url.pathname === "/admin/test-ai") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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

      // Webhook tester — inject test SNAPSHOT or SIGNAL
      if (request.method === "POST" && url.pathname === "/admin/test-webhook") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { type } = await request.json();
        try {
          if (type === 'SNAPSHOT') {
            const result = await saveSnapshot(env, {
              symbol: 'BTCUSDT', event_type: 'SNAPSHOT', timeframe: '5',
              price: 80000, rsi: 55, ema50: 79800, ema200: 78000,
              support: 79000, resistance: 81000,
              trend: 'bullish', trend_1h: 'GREEN', trend_4h: 'GREEN'
            });
            return jsonResponse({ ok: true, type: 'SNAPSHOT', result });
          } else {
            const result = await processSignal(env, {
              symbol: 'BTCUSDT', event_type: 'SIGNAL', timeframe: '5',
              price: 80000, direction: 'LONG', trigger: 'ADMIN_TEST',
              rsi: 55, ema50: 79800, ema200: 78000, action: 'BUY'
            });
            return jsonResponse({ ok: true, type: 'SIGNAL', result });
          }
        } catch (e) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      }

      // DB cleanup — remove old snapshots & expired sessions
      if (request.method === "POST" && url.pathname === "/admin/db-cleanup") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { deleteTestSignals } = await request.json();
        await ensureTables(env);
        await setSetting(env, 'mode', 'live');
        await setSetting(env, 'live_started_at', String(Date.now()));

        let deletedSignals = 0;
        if (deleteTestSignals) {
          const info = await env.DB.prepare(`DELETE FROM signals WHERE is_test = 1`).run();
          deletedSignals = info.meta?.changes ?? 0;
          await env.DB.prepare(`DELETE FROM practice_trades WHERE signal_id IN (SELECT id FROM signals WHERE is_test = 1)`).run();
        }
        return jsonResponse({ success: true, mode: 'live', liveStartedAt: Date.now(), deletedSignals });
      }

      if (request.method === "GET" && url.pathname === "/admin/settings") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const stratId = url.pathname.slice("/strategies/".length);
        const existing = await env.DB.prepare(`SELECT * FROM strategies WHERE id = ?`).bind(stratId).first();
        if (!existing) return jsonResponse({ error: "Nicht gefunden" }, 404);
        if (existing.is_default || existing.protected) return jsonResponse({ error: "Standardstrategie kann nicht gelöscht werden" }, 403);
        await env.DB.prepare(`DELETE FROM strategies WHERE id = ?`).bind(stratId).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname.endsWith("/activate") && url.pathname.startsWith("/strategies/")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const stratId = url.pathname.replace("/activate", "").slice("/strategies/".length);
        await env.DB.prepare(`UPDATE strategies SET active = 0`).run();
        await env.DB.prepare(`UPDATE strategies SET active = 1, updated_at = ? WHERE id = ?`).bind(Date.now(), stratId).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname === "/strategies/reset-to-default") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        await env.DB.prepare(`UPDATE strategies SET active = 0`).run();
        await env.DB.prepare(`UPDATE strategies SET active = 1, updated_at = ? WHERE is_default = 1`).bind(Date.now()).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "GET" && url.pathname === "/strategies/compare") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
            winRate: (r.wins + r.losses) > 0 ? parseFloat(((r.wins / (r.wins + r.losses)) * 100).toFixed(1)) : 0,
            avg_score: r.avg_score ? parseFloat(r.avg_score.toFixed(1)) : 0
          })));
        } catch (e) { return jsonResponse([]); }
      }

      if (request.method === "POST" && url.pathname === "/strategies/ab-backtest") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
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
            winRate: closed > 0 ? parseFloat(((wins / closed) * 100).toFixed(1)) : 0,
            avgScore: total > 0 ? parseFloat((totalScore / total).toFixed(1)) : 0
          });
        }
        return jsonResponse({ results, signalCount: (signals.results || []).length });
      }

      if (request.method === "GET" && url.pathname === "/strategies/suggestions") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const suggestions = [];
          const lowScoreLosses = await env.DB.prepare(`SELECT COUNT(*) as c FROM signals WHERE outcome='LOSS' AND ai_score < 70`).first();
          const lowScoreWins   = await env.DB.prepare(`SELECT COUNT(*) as c FROM signals WHERE outcome='WIN'  AND ai_score < 70`).first();
          if ((lowScoreLosses?.c || 0) > (lowScoreWins?.c || 0) && (lowScoreLosses?.c || 0) > 2) {
            suggestions.push({ type: 'score_threshold', priority: 'high', title: 'Min. Score erhöhen', message: `${lowScoreLosses.c} Losses hatten Score < 70. Erwäge min_trade_score auf 75+ zu erhöhen.`, action: 'Schwellenwert anpassen' });
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
            const wr = (sym.wins + sym.losses) > 0 ? (sym.wins / (sym.wins + sym.losses)) * 100 : 0;
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
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
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.slice("/signals/".length, -"/loss-reasons".length);
        try {
          const rows = await env.DB.prepare(`SELECT * FROM signal_loss_reasons WHERE signal_id = ? ORDER BY created_at DESC`).bind(signalId).all();
          return jsonResponse(rows.results || []);
        } catch (_) { return jsonResponse([]); }
      }

      // ── WEBHOOK (TradingView) ────────────────────────────────

      if (request.method === "POST" && url.pathname === "/webhook") {
        const secret = url.searchParams.get("secret");
        if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
          console.warn('⛔ Webhook: wrong or missing secret');
          return jsonResponse({ error: "Unauthorized" }, 401);
        }

        let rawBody = '';
        let payload = null;

        try {
          rawBody = await request.text();
          console.log('📥 Webhook raw body:', rawBody.substring(0, 1000));
        } catch (readErr) {
          console.error('❌ Failed to read request body:', readErr.message);
          return jsonResponse({ error: 'Failed to read body', message: readErr.message }, 400);
        }

        try {
          payload = JSON.parse(rawBody);
          console.log('📦 Parsed payload:', JSON.stringify(payload).substring(0, 500));
        } catch (parseErr) {
          console.error('❌ JSON parse error:', parseErr.message, '| raw:', rawBody.substring(0, 200));
          return jsonResponse({
            error: 'Invalid JSON',
            message: parseErr.message,
            rawBodyPreview: rawBody.substring(0, 200)
          }, 400);
        }

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
          console.error('❌ Webhook processing error:', processingErr?.message || processingErr);
          return jsonResponse({
            success: true,
            type: eventType,
            message: 'Accepted with processing error (logged)'
          });
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

      return new Response("WAVESCOUT v3.4 Production ✅", { headers: CORS_HEADERS });

    } catch (error) {
      console.error('❌ Unhandled worker error:', error.message);
      console.error('Stack:', error.stack);
      return jsonResponse({ error: "Internal Server Error", message: error.message, stack: error.stack }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    console.log('⏰ Cron triggered:', event.cron);
    await evaluateOpenTrades(env);

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
      await sendDailySummary(env);
    }
  }
};
