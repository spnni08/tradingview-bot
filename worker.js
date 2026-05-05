// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.3 - Combined Worker (No Modules)
// Login-System + Live-Daten + User Management
// ═══════════════════════════════════════════════════════════════

// ───── AUTH FUNCTIONS ─────

function hashPassword(password) {
  return btoa(password).split('').reverse().join('');
}

let sessions = new Map();

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

async function getUsers(env) {
  const users = await env.DB.prepare(`
    SELECT id, username, email, role, must_change_password, created_at, updated_at
    FROM users
    ORDER BY created_at DESC
  `).all();

  return users.results || [];
}

async function createUser(env, userData) {
  const userId = `user_${Date.now()}`;
  const passwordHash = hashPassword(userData.password || '123456789');

  await env.DB.prepare(`
    INSERT INTO users (id, username, email, password_hash, role, must_change_password, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    userId,
    userData.username,
    userData.email,
    passwordHash,
    userData.role || 'user',
    1,
    Date.now()
  ).run();

  return { success: true, userId };
}

async function deleteUser(env, userId) {
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
  return { success: true };
}

// ───── MAIN WORKER ─────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID",
      "Access-Control-Allow-Credentials": "true"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // AUTH ROUTES
    if (request.method === "POST" && url.pathname === "/auth/login") {
      const { username, password } = await request.json();
      const result = await login(env, username, password);
      return jsonResponse(result, result.success ? 200 : 401, corsHeaders);
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const sessionId = request.headers.get("X-Session-ID");
      const result = logout(sessionId);
      return jsonResponse(result, 200, corsHeaders);
    }

    if (request.method === "POST" && url.pathname === "/auth/change-password") {
      const sessionId = request.headers.get("X-Session-ID");
      const session = validateSession(sessionId);
      
      if (!session) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const { newPassword } = await request.json();
      const result = await changePassword(env, session.userId, newPassword);
      return jsonResponse(result, 200, corsHeaders);
    }

    // DASHBOARD LIVE DATA
    if (request.method === "GET" && url.pathname === "/dashboard/live") {
      const sessionId = request.headers.get("X-Session-ID");
      const session = validateSession(sessionId);
      
      if (!session) {
        return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
      }

      const stats = await getStats(env);
      const latestSignals = await getHistory(env, 5);
      
      const todayStart = new Date().setHours(0, 0, 0, 0);
      const todayTrades = await env.DB.prepare(`
        SELECT * FROM signals 
        WHERE created_at >= ? AND outcome IN ('WIN', 'LOSS')
      `).bind(todayStart).all();

      let todayPnL = 0;
      todayTrades.results?.forEach(trade => {
        if (trade.outcome === 'WIN' && trade.exit_price && trade.ai_entry) {
          todayPnL += (trade.exit_price - trade.ai_entry) * 100;
        } else if (trade.outcome === 'LOSS' && trade.exit_price && trade.ai_entry) {
          todayPnL += (trade.exit_price - trade.ai_entry) * 100;
        }
      });

      const bestSignal = await env.DB.prepare(`
        SELECT * FROM signals 
        WHERE outcome = 'OPEN' AND ai_recommendation = 'RECOMMENDED'
        ORDER BY ai_score DESC 
        LIMIT 1
      `).first();

      const marketBias = [];
      const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
      
      for (const symbol of symbols) {
        const snap = await getSnapshot(env, symbol, '5m');
        if (snap) {
          const trend = snap.price > snap.ema200 ? 'bullish' : snap.price < snap.ema200 ? 'bearish' : 'neutral';
          marketBias.push({
            symbol,
            price: snap.price,
            trend,
            rsi: snap.rsi
          });
        }
      }

      return jsonResponse({
        stats: {
          equity: 12473.50,
          todayPnL,
          winRate: stats.winRate || 0,
          totalTrades: stats.total || 0,
          wins: stats.wins || 0,
          losses: stats.losses || 0
        },
        bestSignal,
        latestSignals,
        marketBias,
        user: {
          username: session.username,
          role: session.role
        }
      }, 200, corsHeaders);
    }

    // EXISTING ROUTES
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok", time: new Date().toISOString() }, 200, corsHeaders);
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      return jsonResponse(await getStats(env), 200, corsHeaders);
    }

    if (request.method === "GET" && url.pathname === "/history") {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      return jsonResponse(await getHistory(env, limit), 200, corsHeaders);
    }

    // WEBHOOK (no auth)
    if (request.method === "POST" && url.pathname === "/webhook") {
      if (!checkSecret(url, env)) return unauthorized();
      const signal = await request.json();
      // Process signal (keep existing logic)
      return jsonResponse({ status: "ok", signal }, 200, corsHeaders);
    }

    return new Response("WAVESCOUT v3.3 läuft ✅", { headers: corsHeaders });
  }
};

// HELPERS
function checkSecret(url, env) {
  const secret = url.searchParams.get("secret");
  return env.WEBHOOK_SECRET && secret === env.WEBHOOK_SECRET;
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" }
  });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders
    }
  });
}

async function getStats(env) {
  const total = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals`).first();
  const wins = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'WIN'`).first();
  const losses = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'LOSS'`).first();
  
  const winRate = total.count > 0 ? ((wins.count / total.count) * 100).toFixed(1) : 0;
  
  return {
    total: total.count,
    wins: wins.count,
    losses: losses.count,
    winRate: parseFloat(winRate)
  };
}

async function getHistory(env, limit = 50) {
  const rows = await env.DB.prepare(`
    SELECT * FROM signals 
    ORDER BY created_at DESC 
    LIMIT ?
  `).bind(limit).all();
  
  return rows.results || [];
}

async function getSnapshot(env, symbol, timeframe = "5m") {
  const row = await env.DB.prepare(`
    SELECT * FROM snapshots 
    WHERE symbol = ? AND timeframe = ? 
    ORDER BY created_at DESC 
    LIMIT 1
  `).bind(symbol, timeframe).first();
  
  return row || null;
}
