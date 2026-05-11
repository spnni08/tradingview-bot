// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - PRODUCTION WORKER
// Signal Processing · Snapshots · Telegram · Backtesting
// ═══════════════════════════════════════════════════════════════

function hashPassword(password) {
  return btoa(password);
}

let sessions = new Map();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID",
  "Access-Control-Allow-Credentials": "true"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// TELEGRAM FUNCTIONS
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
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
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
// AI ANALYSIS (Claude API)
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content[0].text;

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (error) {
    console.error('AI analysis error:', error);
  }

  return analyzeWithRules(signal);
}

function analyzeWithRules(signal) {
  let score = 50;
  let risk = 'MEDIUM';
  let recommendation = 'WAIT';

  if (signal.timeframe === '1H' || signal.timeframe === '4H' || signal.timeframe === '60' || signal.timeframe === '240') {
    score += 10;
  }

  if (score >= 70) {
    recommendation = 'RECOMMENDED';
    risk = 'LOW';
  } else if (score < 50) {
    recommendation = 'SKIP';
    risk = 'HIGH';
  }

  const entry = signal.price || 0;
  const tp = signal.direction === 'LONG' ? entry * 1.02 : entry * 0.98;
  const sl = signal.direction === 'LONG' ? entry * 0.99 : entry * 1.01;

  return { recommendation, score, risk, entry, tp, sl, reason: 'Rule-based analysis' };
}

// ═══════════════════════════════════════════════════════════════
// DB INITIALIZATION
// ═══════════════════════════════════════════════════════════════

async function ensureTables(env) {
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        symbol TEXT,
        timeframe TEXT,
        price REAL,
        direction TEXT,
        trigger TEXT,
        ai_recommendation TEXT,
        ai_score REAL,
        ai_risk TEXT,
        ai_entry REAL,
        ai_tp REAL,
        ai_sl REAL,
        ai_reason TEXT,
        rule_score REAL,
        rule_reason TEXT,
        created_at INTEGER,
        outcome TEXT DEFAULT 'OPEN',
        exit_price REAL,
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

  // Evaluate open practice trades with updated price
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
    const stopLoss = analysis.sl || 0;

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
          UPDATE practice_trades
          SET status = ?, exit_price = ?, result_pct = ?, closed_at = ?
          WHERE id = ?
        `).bind(
          newStatus,
          currentPrice,
          parseFloat(resultPct.toFixed(2)),
          new Date().toISOString(),
          trade.id
        ).run();

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

    if (symbol && symbol !== 'all') { query += ' AND symbol = ?'; params.push(symbol); }
    if (timeframe && timeframe !== 'all') { query += ' AND timeframe = ?'; params.push(timeframe); }
    if (direction && direction !== 'all') { query += ' AND direction = ?'; params.push(direction); }
    if (status && status !== 'all') { query += ' AND status = ?'; params.push(status); }

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

    const total = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades`).first();
    const open  = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='OPEN'`).first();
    const wins  = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='WIN'`).first();
    const losses = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='LOSS'`).first();
    const avgWin = await env.DB.prepare(`SELECT AVG(result_pct) as a FROM practice_trades WHERE status='WIN'`).first();
    const avgLoss = await env.DB.prepare(`SELECT AVG(result_pct) as a FROM practice_trades WHERE status='LOSS'`).first();

    const closed = (wins.c || 0) + (losses.c || 0);
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

async function processSignal(env, signal) {
  console.log('📊 Processing signal:', signal.symbol, signal.direction, signal.trigger);

  await ensureTables(env);

  const analysis = await analyzeSignalWithAI(env, signal);

  const signalId = `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  await env.DB.prepare(`
    INSERT INTO signals (
      id, symbol, timeframe, price, direction, trigger,
      ai_recommendation, ai_score, ai_risk, ai_entry, ai_tp, ai_sl, ai_reason,
      rule_score, rule_reason, created_at, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    signalId,
    signal.symbol || 'UNKNOWN',
    String(signal.timeframe || '5'),
    signal.price || 0,
    signal.direction || 'LONG',
    signal.trigger || 'MANUAL',
    analysis.recommendation,
    analysis.score,
    analysis.risk,
    analysis.entry,
    analysis.tp,
    analysis.sl,
    analysis.reason,
    analysis.score,
    analysis.reason,
    Date.now(),
    'OPEN'
  ).run();

  // Create a practice trade for paper-trading evaluation
  await createPracticeTrade(env, signalId, signal, analysis);

  if (analysis.score >= 65) {
    const telegramMessage = formatSignalForTelegram({
      ...signal,
      ai_score: analysis.score,
      ai_entry: analysis.entry,
      ai_tp: analysis.tp,
      ai_sl: analysis.sl,
      ai_reason: analysis.reason
    });
    await sendTelegramMessage(env, telegramMessage);
  }

  console.log('✅ Signal processed:', signalId, 'Score:', analysis.score);
  return { status: 'ok', signalId, analysis };
}

// ═══════════════════════════════════════════════════════════════
// AUTH FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function login(env, username, password) {
  const user = await env.DB.prepare(`
    SELECT * FROM users WHERE username = ? OR email = ?
  `).bind(username, username).first();

  if (!user) return { success: false, error: 'Benutzer nicht gefunden' };

  const passwordHash = hashPassword(password);
  if (user.password_hash !== passwordHash) return { success: false, error: 'Falsches Passwort' };

  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    userId: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.must_change_password === 1,
    createdAt: Date.now()
  };

  sessions.set(sessionId, session);

  return {
    success: true,
    session,
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
  const passwordHash = hashPassword(newPassword);
  await env.DB.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?
  `).bind(passwordHash, Date.now(), userId).run();
  return { success: true };
}

function validateSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function logout(sessionId) {
  sessions.delete(sessionId);
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

async function getSnapshot(env, symbol, timeframe = '5') {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'`
    ).first();
    if (!tableCheck) return null;

    const row = await env.DB.prepare(`
      SELECT * FROM snapshots WHERE symbol = ? AND timeframe = ?
      ORDER BY created_at DESC LIMIT 1
    `).bind(symbol, String(timeframe)).first();

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

async function getBestSignal(env) {
  try {
    const signal = await env.DB.prepare(
      `SELECT * FROM signals WHERE outcome = 'OPEN' ORDER BY ai_score DESC LIMIT 1`
    ).first();
    return signal;
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
      const snap = await getSnapshot(env, symbol, '5');

      if (snap) {
        let trend = 'neutral';
        let change = 0;

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
  const users = await env.DB.prepare(`
    SELECT id, username, email, role, must_change_password, created_at, updated_at
    FROM users ORDER BY created_at DESC
  `).all();
  return users.results || [];
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
        return jsonResponse(logout(request.headers.get("X-Session-ID")));
      }

      if (request.method === "POST" && url.pathname === "/auth/change-password") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const { newPassword } = await request.json();
        return jsonResponse(await changePassword(env, session.userId, newPassword));
      }

      // ── DASHBOARD LIVE DATA ─────────────────────────────────

      if (request.method === "GET" && url.pathname === "/dashboard/live") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const [stats, latestSignals, bestSignal, marketBias, todayPnL] = await Promise.all([
          getStats(env),
          getHistory(env, 10),
          getBestSignal(env),
          getMarketBias(env),
          getTodayPnL(env)
        ]);

        return jsonResponse({
          stats: {
            equity: 12473.50,
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

      // ── DATA ROUTES ─────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/stats") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getStats(env));
      }

      if (request.method === "GET" && url.pathname === "/history") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const limit = parseInt(url.searchParams.get("limit") || "50");
        return jsonResponse(await getHistory(env, limit));
      }

      if (request.method === "GET" && url.pathname === "/analytics") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const stats = await getStats(env);
        const history = await getHistory(env, 100);
        const closedTrades = history.filter(t => t.outcome !== 'OPEN' && t.updated_at);
        const avgHoldTime = closedTrades.length > 0
          ? closedTrades.reduce((sum, t) => sum + (t.updated_at - t.created_at), 0) / closedTrades.length
          : 0;

        return jsonResponse({ ...stats, avgHoldTimeMs: avgHoldTime, totalSignals: history.length });
      }

      // ── PRACTICE TRADES ─────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/practice-trades") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const filters = {
          symbol:    url.searchParams.get("symbol")    || 'all',
          timeframe: url.searchParams.get("timeframe") || 'all',
          direction: url.searchParams.get("direction") || 'all',
          status:    url.searchParams.get("status")    || 'all',
          limit:     parseInt(url.searchParams.get("limit") || "100")
        };

        return jsonResponse(await getPracticeTrades(env, filters));
      }

      if (request.method === "GET" && url.pathname === "/practice-trades/stats") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getPracticeTradeStats(env));
      }

      // ── CHECKLIST ───────────────────────────────────────────

      if (request.method === "POST" && url.pathname === "/checklist") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        return jsonResponse(await saveChecklist(env, body, session.username));
      }

      if (request.method === "GET" && url.pathname === "/checklist") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        return jsonResponse(await getChecklist(env, date, session.username));
      }

      // ── ADMIN ───────────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/users") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getUsers(env));
      }

      if (request.method === "GET" && url.pathname === "/test-telegram") {
        const session = validateSession(request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const testMessage = `🧪 <b>WAVESCOUT Test</b>\n\nTelegram ist korrekt konfiguriert!\n⏰ ${new Date().toLocaleString('de-DE')}`;
        const success = await sendTelegramMessage(env, testMessage);
        return jsonResponse({ success, message: success ? 'Telegram-Nachricht gesendet!' : 'Fehler beim Senden' });
      }

      // ── WEBHOOK (TradingView) ────────────────────────────────

      if (request.method === "POST" && url.pathname === "/webhook") {
        const secret = url.searchParams.get("secret");
        if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
          console.warn('⛔ Webhook: wrong or missing secret');
          return jsonResponse({ error: "Unauthorized" }, 401);
        }

        // Read raw body first for logging
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
            const result = await saveSnapshot(env, payload);
            return jsonResponse(result);
          }

          // SIGNAL or unknown → treat as tradeable signal
          const direction = (payload.direction || '').toUpperCase();
          const action    = (payload.action    || '').toUpperCase();

          if (!direction || direction === 'NONE' || action === 'NONE') {
            console.log('⏭️ Signal skipped: direction=', direction, 'action=', action);
            return jsonResponse({ status: 'skipped', reason: 'no_actionable_direction', direction, action });
          }

          const result = await processSignal(env, payload);
          return jsonResponse(result);

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
        try {
          await env.DB.prepare('SELECT 1').first();
          dbStatus = 'ok';
        } catch (e) {
          dbStatus = 'error: ' + e.message;
        }

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
      return jsonResponse({
        error: "Internal Server Error",
        message: error.message,
        stack: error.stack
      }, 500);
    }
  },

  // Scheduled jobs (cron triggers in wrangler.toml)
  async scheduled(event, env, ctx) {
    console.log('⏰ Scheduled trigger:', event.cron);
    try {
      // Re-evaluate all open practice trades using latest snapshot prices
      const tableCheck = await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
      ).first();

      if (!tableCheck) return;

      const openTrades = await env.DB.prepare(
        `SELECT DISTINCT symbol FROM practice_trades WHERE status='OPEN'`
      ).all();

      for (const row of (openTrades.results || [])) {
        const snap = await getSnapshot(env, row.symbol, '5');
        if (snap?.price) {
          await checkPracticeTrades(env, row.symbol, snap.price);
        }
      }

      console.log('✅ Scheduled practice trade check complete');
    } catch (error) {
      console.error('❌ Scheduled job error:', error.message);
    }
  }
};
