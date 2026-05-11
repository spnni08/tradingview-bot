// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - PRODUCTION WORKER
// Signal Processing · Snapshots · Telegram · Backtesting
// ═══════════════════════════════════════════════════════════════

function hashPassword(password) {
  return btoa(password);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID",
  "Access-Control-Allow-Credentials": "true"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

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
// AI ANALYSIS
// ═══════════════════════════════════════════════════════════════

async function analyzeSignalWithAI(env, signal) {
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
  return analyzeWithRules(signal);
}

function analyzeWithRules(signal) {
  const dir = (signal.direction || signal.side || signal.signal || '').toUpperCase();
  const isLong  = dir === 'LONG';
  const isShort = dir === 'SHORT';

  let score = 50;

  // ── RSI ─────────────────────────────────────────────────────
  const rsi = parseFloat(signal.rsi ?? 50);
  if (isLong) {
    if      (rsi < 30) score += 18;  // very oversold
    else if (rsi < 40) score += 10;
    else if (rsi < 50) score += 4;
    else if (rsi > 70) score -= 18;  // overbought → bad long
    else if (rsi > 60) score -= 6;
  } else if (isShort) {
    if      (rsi > 70) score += 18;  // very overbought
    else if (rsi > 60) score += 10;
    else if (rsi > 50) score += 4;
    else if (rsi < 30) score -= 18;  // oversold → bad short
    else if (rsi < 40) score -= 6;
  }

  // ── EMA trend alignment ──────────────────────────────────────
  const ema50  = parseFloat(signal.ema50  ?? 0);
  const ema200 = parseFloat(signal.ema200 ?? 0);
  if (ema50 && ema200) {
    const bullish = ema50 > ema200;
    if (isLong  && bullish)  score += 12;
    if (isShort && !bullish) score += 12;
    if (isLong  && !bullish) score -= 12;
    if (isShort && bullish)  score -= 12;
  }

  // ── Trend label ──────────────────────────────────────────────
  const trend = (signal.trend || '').toUpperCase();
  if (trend === 'BULLISH' || trend === 'UP') {
    score += isLong ? 10 : -10;
  } else if (trend === 'BEARISH' || trend === 'DOWN') {
    score += isShort ? 10 : -10;
  }

  // ── Wave bias ────────────────────────────────────────────────
  const waveBias = (signal.wave_bias || '').toUpperCase();
  if (waveBias === 'LONG')  score += isLong  ? 10 : -5;
  if (waveBias === 'SHORT') score += isShort ? 10 : -5;

  // ── Timeframe ────────────────────────────────────────────────
  const tf = String(signal.timeframe || '').replace('m','').replace('h','H');
  if (['60','240','1H','4H'].includes(tf))  score += 8;
  else if (['15','30'].includes(tf))         score += 4;

  // ── Confidence from signal source ────────────────────────────
  const confidence = parseFloat(signal.confidence ?? 0);
  if      (confidence >= 80) score += 10;
  else if (confidence >= 60) score += 5;

  // ── Support / Resistance proximity ──────────────────────────
  const price      = parseFloat(signal.price ?? 0);
  const support    = parseFloat(signal.support ?? 0);
  const resistance = parseFloat(signal.resistance ?? 0);
  if (price && support && isLong && price > support) {
    const pct = (price - support) / price;
    if (pct < 0.02) score += 8;  // within 2% of support
  }
  if (price && resistance && isShort && price < resistance) {
    const pct = (resistance - price) / price;
    if (pct < 0.02) score += 8;
  }

  // ── Clamp ─────────────────────────────────────────────────
  score = Math.max(0, Math.min(100, Math.round(score)));

  // ── Recommendation ──────────────────────────────────────────
  let recommendation, risk;
  if (score >= 70) {
    recommendation = dir || 'RECOMMENDED';
    risk = score >= 82 ? 'LOW' : 'MEDIUM';
  } else if (score >= 55) {
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
  if (trend)     reasons.push(`Trend: ${trend}`);
  if (waveBias)  reasons.push(`Bias: ${waveBias}`);
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

  } catch (error) {
    console.error('❌ ensureTables error:', error.message);
  }
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
  signal.direction = direction; // normalize for analyzeWithRules

  console.log('📊 Processing signal:', signal.symbol, direction, '| action:', action, '| rsi:', signal.rsi);

  await ensureTables(env);

  const analysis = await analyzeSignalWithAI(env, signal);
  const signalId = `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  await env.DB.prepare(`
    INSERT INTO signals (
      id, symbol, timeframe, price, direction, action, trigger,
      rsi, ema50, ema200, trend, support, resistance, wave_bias,
      ai_recommendation, ai_direction, ai_score, ai_risk, ai_confidence,
      ai_entry, ai_tp, ai_sl, ai_reason,
      rule_score, rule_reason, created_at, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    Date.now(),
    'OPEN'
  ).run();

  await createPracticeTrade(env, signalId, { ...signal, direction }, analysis);

  // Send Telegram: always for test signals, otherwise score >= 55
  const shouldNotify = signal.test === true || analysis.score >= 55;
  if (shouldNotify) {
    const debugPrefix = (analysis.score < 70 || signal.test)
      ? `🧪 <b>[${signal.test ? 'TEST' : 'DEBUG'}]</b>\n` : '';
    const telegramMessage = debugPrefix + formatSignalForTelegram({
      ...signal,
      direction,
      ai_score: analysis.score,
      ai_entry: analysis.entry,
      ai_tp:    analysis.tp,
      ai_sl:    analysis.sl,
      ai_reason: analysis.reason
    });
    await sendTelegramMessage(env, telegramMessage);
  }

  console.log('✅ Signal processed:', signalId, '| Score:', analysis.score, '| Rec:', analysis.recommendation);
  return { status: 'ok', signalId, analysis };
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

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, username, role, must_change_password, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(sessionId, user.id, user.username, user.role, user.must_change_password, now, expiresAt).run();

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
      mustChangePassword: user.must_change_password === 1
    },
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      mustChangePassword: user.must_change_password === 1
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
      const snap = await getSnapshot(env, signal.symbol, '5m');
      if (!snap?.price) continue;

      const price = snap.price;
      const isLong = signal.direction === 'LONG';
      let outcome = null;

      if (isLong) {
        if (price >= signal.ai_tp) outcome = 'WIN';
        else if (price <= signal.ai_sl) outcome = 'LOSS';
      } else {
        if (price <= signal.ai_tp) outcome = 'WIN';
        else if (price >= signal.ai_sl) outcome = 'LOSS';
      }

      if (outcome) {
        await env.DB.prepare(
          `UPDATE signals SET outcome = ?, exit_price = ?, updated_at = ? WHERE id = ?`
        ).bind(outcome, price, Date.now(), signal.id).run();

        const emoji = outcome === 'WIN' ? '✅' : '❌';
        await sendTelegramMessage(env,
          `${emoji} <b>Trade geschlossen</b>\n\n` +
          `${signal.direction === 'LONG' ? '🟢' : '🔴'} ${signal.symbol} ${signal.direction}\n` +
          `📊 Ergebnis: <b>${outcome}</b>\n` +
          `💰 Exit: $${price.toFixed(2)}\n` +
          `📈 Entry war: $${signal.ai_entry?.toFixed(2) || '?'}`
        );
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

      if (request.method === "PATCH" && url.pathname.startsWith("/signals/")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const signalId = url.pathname.replace("/signals/", "");
        const { outcome, exitPrice } = await request.json();

        const allowed = ['WIN', 'LOSS', 'BE', 'OPEN', 'IGNORED'];
        if (outcome && !allowed.includes(outcome)) return jsonResponse({ error: "Ungültiges outcome" }, 400);

        const sets = [], binds = [];
        if (outcome)              { sets.push("outcome = ?");    binds.push(outcome); }
        if (exitPrice !== undefined) { sets.push("exit_price = ?"); binds.push(exitPrice); }
        sets.push("updated_at = ?"); binds.push(Date.now());
        binds.push(signalId);

        await env.DB.prepare(`UPDATE signals SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
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

        const { username, email, password, role } = await request.json();
        if (!username || !email || !password) return jsonResponse({ error: "Fehlende Felder: username, email, password" }, 400);

        const existing = await env.DB.prepare(`SELECT id FROM users WHERE username = ? OR email = ?`)
          .bind(username, email).first();
        if (existing) return jsonResponse({ error: "Benutzername oder E-Mail bereits vergeben" }, 409);

        const id = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO users (id, username, email, password_hash, role, must_change_password, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).bind(id, username, email, hashPassword(password), role || 'user', now, now).run();
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

        return jsonResponse({ success: true, results });
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
            return jsonResponse(await saveSnapshot(env, payload));
          }

          const direction = normalizeDirection(payload);
          const action    = normalizeAction(payload);

          if (!direction) {
            console.log('⏭️ Signal skipped — no recognisable direction in payload:', JSON.stringify(payload).substring(0, 300));
            return jsonResponse({ status: 'skipped', reason: 'no_actionable_direction', direction, action });
          }

          return jsonResponse(await processSignal(env, payload));

        } catch (processingErr) {
          console.error('❌ Webhook processing error:', processingErr.message);
          console.error('Stack:', processingErr.stack);
          return jsonResponse({
            error: 'Processing failed',
            message: processingErr.message,
            stack: processingErr.stack,
            eventType,
            symbol: payload?.symbol
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
