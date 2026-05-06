// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - WORKER MIT ERROR HANDLING
// Zeigt genau an, wo Fehler passieren
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
// AUTH FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function login(env, username, password) {
  const user = await env.DB.prepare(`
    SELECT * FROM users WHERE username = ? OR email = ?
  `).bind(username, username).first();

  if (!user) {
    return { success: false, error: 'Benutzer nicht gefunden' };
  }

  const passwordHash = hashPassword(password);
  
  if (user.password_hash !== passwordHash) {
    return { success: false, error: 'Falsches Passwort' };
  }

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
    UPDATE users 
    SET password_hash = ?, must_change_password = 0, updated_at = ?
    WHERE id = ?
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
// DATA FUNCTIONS (MIT ERROR HANDLING)
// ═══════════════════════════════════════════════════════════════

async function getStats(env) {
  try {
    // Prüfe ob Tabelle existiert
    const tableCheck = await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='signals'
    `).first();
    
    if (!tableCheck) {
      console.log('⚠️ signals table does not exist');
      return { total: 0, wins: 0, losses: 0, open: 0, winRate: 0 };
    }
    
    const total = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals`).first();
    const wins = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'WIN'`).first();
    const losses = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'LOSS'`).first();
    const open = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'OPEN'`).first();
    
    const winRate = (wins.count + losses.count) > 0 
      ? ((wins.count / (wins.count + losses.count)) * 100) 
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
    const tableCheck = await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='signals'
    `).first();
    
    if (!tableCheck) {
      return [];
    }
    
    const rows = await env.DB.prepare(`
      SELECT * FROM signals 
      ORDER BY created_at DESC 
      LIMIT ?
    `).bind(limit).all();
    
    return rows.results || [];
  } catch (error) {
    console.error('Error in getHistory:', error);
    return [];
  }
}

async function getSnapshot(env, symbol, timeframe = "5m") {
  try {
    const tableCheck = await env.DB.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'
    `).first();
    
    if (!tableCheck) {
      return null;
    }
    
    const row = await env.DB.prepare(`
      SELECT * FROM snapshots 
      WHERE symbol = ? AND timeframe = ? 
      ORDER BY created_at DESC 
      LIMIT 1
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
      const pnlTrade = trade.direction === 'LONG' ? diff : -diff;
      pnl += pnlTrade;
    });

    return pnl;
  } catch (error) {
    console.error('Error in getTodayPnL:', error);
    return 0;
  }
}

async function getBestSignal(env) {
  try {
    const signal = await env.DB.prepare(`
      SELECT * FROM signals 
      WHERE outcome = 'OPEN' 
      ORDER BY ai_score DESC 
      LIMIT 1
    `).first();
    
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
      const snap = await getSnapshot(env, symbol, '5m');
      
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
        
        bias.push({
          symbol,
          price: snap.price,
          trend,
          change: parseFloat(change.toFixed(2)),
          rsi: snap.rsi
        });
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
    ON CONFLICT(id) DO UPDATE SET 
      data = excluded.data,
      updated_at = excluded.updated_at
  `).bind(
    id, 
    date, 
    username, 
    type, 
    JSON.stringify(checklistData), 
    now,
    now
  ).run();

  return { success: true, id };
}

async function getChecklist(env, date, username) {
  const rows = await env.DB.prepare(`
    SELECT * FROM checklists 
    WHERE date = ? AND user = ? 
    ORDER BY created_at DESC
  `).bind(date, username).all();

  return rows.results || [];
}

// ═══════════════════════════════════════════════════════════════
// MAIN WORKER
// ═══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Wrap everything in try-catch
    try {

      // ═══════════════════════════════════════════════════════════
      // AUTH ROUTES
      // ═══════════════════════════════════════════════════════════

      if (request.method === "POST" && url.pathname === "/auth/login") {
        const { username, password } = await request.json();
        const result = await login(env, username, password);
        return jsonResponse(result, result.success ? 200 : 401);
      }

      if (request.method === "POST" && url.pathname === "/auth/logout") {
        const sessionId = request.headers.get("X-Session-ID");
        const result = logout(sessionId);
        return jsonResponse(result);
      }

      if (request.method === "POST" && url.pathname === "/auth/change-password") {
        const sessionId = request.headers.get("X-Session-ID");
        const session = validateSession(sessionId);
        
        if (!session) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }

        const { newPassword } = await request.json();
        const result = await changePassword(env, session.userId, newPassword);
        return jsonResponse(result);
      }

      // ═══════════════════════════════════════════════════════════
      // DASHBOARD LIVE DATA
      // ═══════════════════════════════════════════════════════════

      if (request.method === "GET" && url.pathname === "/dashboard/live") {
        console.log('📊 Dashboard live request received');
        
        const sessionId = request.headers.get("X-Session-ID");
        const session = validateSession(sessionId);
        
        if (!session) {
          console.log('❌ No valid session');
          return jsonResponse({ error: "Unauthorized" }, 401);
        }

        console.log('✅ Session valid:', session.username);

        const [stats, latestSignals, bestSignal, marketBias, todayPnL] = await Promise.all([
          getStats(env),
          getHistory(env, 10),
          getBestSignal(env),
          getMarketBias(env),
          getTodayPnL(env)
        ]);

        console.log('📊 Data loaded:', {
          stats,
          signalsCount: latestSignals.length,
          hasBestSignal: !!bestSignal,
          biasCount: marketBias.length
        });

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
          latestSignals: latestSignals,
          marketBias: marketBias,
          user: {
            username: session.username,
            role: session.role
          }
        });
      }

      // ═══════════════════════════════════════════════════════════
      // OTHER ROUTES
      // ═══════════════════════════════════════════════════════════

      if (request.method === "GET" && url.pathname === "/stats") {
        const sessionId = request.headers.get("X-Session-ID");
        const session = validateSession(sessionId);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        
        return jsonResponse(await getStats(env));
      }

      if (request.method === "GET" && url.pathname === "/history") {
        const sessionId = request.headers.get("X-Session-ID");
        const session = validateSession(sessionId);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        
        const limit = parseInt(url.searchParams.get("limit") || "50");
        return jsonResponse(await getHistory(env, limit));
      }

      if (request.method === "GET" && url.pathname === "/analytics") {
        const sessionId = request.headers.get("X-Session-ID");
        const session = validateSession(sessionId);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        
        const stats = await getStats(env);
        const history = await getHistory(env, 100);
        
        const closedTrades = history.filter(t => t.outcome !== 'OPEN' && t.updated_at);
        const avgHoldTime = closedTrades.length > 0
          ? closedTrades.reduce((sum, t) => sum + (t.updated_at - t.created_at), 0) / closedTrades.length
          : 0;
        
        return jsonResponse({
          ...stats,
          avgHoldTimeMs: avgHoldTime,
          totalSignals: history.length
        });
      }

      if (request.method === "POST" && url.pathname === "/checklist") {
        const sessionId = request.headers.get("X-Session-ID");
        const session = validateSession(sessionId);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const body = await request.json();
        const result = await saveChecklist(env, body, session.username);
        return jsonResponse(result);
      }

      if (request.method === "GET" && url.pathname === "/checklist") {
        const sessionId = request.headers.get("X-Session-ID");
        const session = validateSession(sessionId);
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const result = await getChecklist(env, date, session.username);
        return jsonResponse(result);
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        const secret = url.searchParams.get("secret");
        if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        
        const signal = await request.json();
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
          signal.timeframe || '5m',
          signal.price || 0,
          signal.direction || 'LONG',
          signal.trigger || 'MANUAL',
          'PENDING',
          0,
          'UNKNOWN',
          signal.price || 0,
          0,
          0,
          'Signal received from TradingView',
          0,
          'Awaiting analysis',
          Date.now(),
          'OPEN'
        ).run();
        
        return jsonResponse({ status: "ok", signalId });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ 
          status: "ok", 
          time: new Date().toISOString(),
          version: "3.3.0-debug"
        });
      }

      return new Response("WAVESCOUT v3.3 läuft ✅", { headers: CORS_HEADERS });

    } catch (error) {
      // Global error handler
      console.error('❌ Worker error:', error);
      return jsonResponse({
        error: "Internal Server Error",
        message: error.message,
        stack: error.stack
      }, 500);
    }
  }
};
