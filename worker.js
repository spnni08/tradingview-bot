// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.2 - Cloudflare Worker
// Multi-Broker Support: Bybit, Binance, MEXC
// ═══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ═══════════════════════════════════════════════════════════
    // CHECKLIST ROUTES
    // ═══════════════════════════════════════════════════════════

    if (request.method === "POST" && url.pathname === "/checklist") {
      if (!checkSecret(url, env)) return unauthorized();
      
      let body;
      try { 
        body = await request.json(); 
      } catch(e) { 
        return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders); 
      }

      const { date, user, type, data, id: customId } = body;
      if (!date || !type || !data) {
        return jsonResponse({ error: "Missing required fields: date, type, data" }, 400, corsHeaders);
      }

      let id;
      if (customId) {
        id = customId;
      } else if (type === "trade") {
        id = `${date}_trade_${user || "default"}_${Date.now()}`;
      } else {
        id = `${date}_${type}_${user || "default"}`;
      }

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
        user || "default", 
        type, 
        JSON.stringify(data), 
        now,
        now
      ).run();

      return jsonResponse({ status: "ok", id }, 200, corsHeaders);
    }

    if (request.method === "GET" && url.pathname === "/checklist") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      const user = url.searchParams.get("user") || "default";
      
      const rows = await env.DB.prepare(`
        SELECT * FROM checklists 
        WHERE date = ? AND user = ? 
        ORDER BY created_at ASC
      `).bind(date, user).all();

      return jsonResponse(rows.results || [], 200, corsHeaders);
    }

    if (request.method === "GET" && url.pathname === "/checklist/history") {
      const user = url.searchParams.get("user") || "default";
      
      const rows = await env.DB.prepare(`
        SELECT date, type, data, updated_at 
        FROM checklists 
        WHERE user = ? 
        ORDER BY date DESC, updated_at DESC 
        LIMIT 60
      `).bind(user).all();

      return jsonResponse(rows.results || [], 200, corsHeaders);
    }

    // ═══════════════════════════════════════════════════════════
    // BROKER SETTINGS
    // ═══════════════════════════════════════════════════════════

    if (request.method === "GET" && url.pathname === "/settings") {
      const user = url.searchParams.get("user") || "default";
      
      const row = await env.DB.prepare(`
        SELECT data FROM settings WHERE user = ? LIMIT 1
      `).bind(user).first();

      const defaultSettings = {
        broker: "bybit",
        apiKey: "",
        apiSecret: "",
        testnet: true,
        defaultLeverage: 5,
        maxRiskPercent: 2,
        minConfidenceScore: 65
      };

      return jsonResponse(
        row ? JSON.parse(row.data) : defaultSettings,
        200,
        corsHeaders
      );
    }

    if (request.method === "POST" && url.pathname === "/settings") {
      if (!checkSecret(url, env)) return unauthorized();
      
      const user = url.searchParams.get("user") || "default";
      const settings = await request.json();

      await env.DB.prepare(`
        INSERT INTO settings (user, data, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user) DO UPDATE SET
          data = excluded.data,
          updated_at = excluded.updated_at
      `).bind(
        user,
        JSON.stringify(settings),
        Date.now()
      ).run();

      return jsonResponse({ status: "ok" }, 200, corsHeaders);
    }

    // ═══════════════════════════════════════════════════════════
    // TELEGRAM ROUTES
    // ═══════════════════════════════════════════════════════════

    if (request.method === "POST" && url.pathname === "/telegram") {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(env, update));
      return jsonResponse({ ok: true }, 200, corsHeaders);
    }

    if (request.method === "GET" && url.pathname === "/setup-telegram") {
      if (!checkSecret(url, env)) return unauthorized();
      const workerUrl = `https://${url.hostname}/telegram`;
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: workerUrl })
        }
      );
      const data = await res.json();
      return jsonResponse({ status: "ok", workerUrl, telegram: data }, 200, corsHeaders);
    }

    if (request.method === "GET" && url.pathname === "/test-telegram") {
      if (!checkSecret(url, env)) return unauthorized();
      return jsonResponse(await sendTelegram(env, "✅ WAVESCOUT Telegram Test funktioniert."), 200, corsHeaders);
    }

    // ═══════════════════════════════════════════════════════════
    // SYSTEM ROUTES
    // ═══════════════════════════════════════════════════════════

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

    if (request.method === "GET" && url.pathname === "/analytics") {
      return jsonResponse(await getAnalytics(env), 200, corsHeaders);
    }

    if (request.method === "GET" && url.pathname === "/snapshots") {
      return jsonResponse(await getSnapshots(env), 200, corsHeaders);
    }

    // ═══════════════════════════════════════════════════════════
    // OUTCOME MANAGEMENT
    // ═══════════════════════════════════════════════════════════

    if (request.method === "POST" && url.pathname === "/outcome") {
      if (!checkSecret(url, env)) return unauthorized();
      const id = url.searchParams.get("id");
      const outcome = url.searchParams.get("outcome");
      const exitPrice = url.searchParams.get("exit_price") ? Number(url.searchParams.get("exit_price")) : null;
      
      if (!id || !["WIN","LOSS","OPEN","SKIPPED"].includes(outcome)) {
        return jsonResponse({ error: "Missing or invalid id/outcome" }, 400, corsHeaders);
      }
      
      await setOutcome(env, id, outcome, exitPrice);
      return jsonResponse({ status: "ok", id, outcome }, 200, corsHeaders);
    }

    // ═══════════════════════════════════════════════════════════
    // SNAPSHOT & SIGNAL PROCESSING
    // ═══════════════════════════════════════════════════════════

    if (request.method === "POST" && url.pathname === "/snapshot") {
      if (!checkSecret(url, env)) return unauthorized();
      const signal = await request.json();
      await saveSnapshot(env, signal);
      return jsonResponse({ status: "ok", saved: true, signal }, 200, corsHeaders);
    }

    if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/backtest")) {
      if (!checkSecret(url, env)) return unauthorized();

      let signal;
      try {
        signal = await request.json();
      } catch(e) {
        console.error("Invalid webhook JSON:", e.message);
        return jsonResponse({ status: "error", message: "Invalid JSON" }, 400, corsHeaders);
      }

      if (signal.event_type === "SNAPSHOT" || signal.type === "SNAPSHOT") {
        await saveSnapshot(env, signal);
        return jsonResponse({
          status: "ok",
          type: "snapshot_saved",
          symbol: signal.symbol,
          time: signal.time
        }, 200, corsHeaders);
      }

      if (!signal.event_type && signal.type) signal.event_type = signal.type;
      if (!signal.trigger && signal.type === "SIGNAL") {
        signal.trigger = signal.direction === "LONG" ? "RSI_CROSS_UP_30" : "RSI_CROSS_DOWN_70";
      }

      let snap1h = null, snap4h = null;
      try {
        snap1h = await getSnapshot(env, signal.symbol, "1H");
        snap4h = await getSnapshot(env, signal.symbol, "4H");
      } catch(e) {
        console.error("Snapshot load error:", e.message);
      }

      let ruleScore, ai;
      try {
        ruleScore = calculateRuleScore(signal, snap1h, snap4h);
      } catch(e) {
        console.error("calculateRuleScore error:", e.message);
        ruleScore = { score: 0, reason: "Fehler bei Regelberechnung" };
      }

      const isPromising = ruleScore.score >= 55;
      const fallbackAI = () => ({
        recommendation: ruleScore.score >= 65 ? "RECOMMENDED" : "NOT_RECOMMENDED",
        direction: signal.direction || (signal.action === "BUY" ? "LONG" : signal.action === "SELL" ? "SHORT" : "NONE"),
        score: ruleScore.score,
        risk: ruleScore.score >= 70 ? "LOW" : ruleScore.score >= 50 ? "MEDIUM" : "HIGH",
        confidence: Math.min(80, ruleScore.score),
        entry: Number(signal.price) || 0,
        take_profit: 0,
        stop_loss: 0,
        reason: "Regelbasierte Analyse (Score: " + ruleScore.score + ")"
      });

      if (!isPromising) {
        ai = fallbackAI();
        console.log(`Skipped Claude (rule score ${ruleScore.score} < 55): ${signal.symbol}`);
      } else {
        try {
          ai = await analyzeWithClaude(env, signal, ruleScore, snap1h, snap4h);
        } catch(e) {
          console.error("Claude analysis error:", e.message);
          ai = fallbackAI();
        }
      }

      const finalScore = clamp(Math.round((Number(ai.score || 0) * 0.75) + (ruleScore.score * 0.25)));
      ai.score = finalScore;

      const priority = getPriority(ai.score, ai.recommendation, ai.risk);

      try {
        await saveSignal(env, signal, ai, ruleScore);
      } catch(e) {
        console.error("saveSignal error:", e.message);
      }

      let rr = 0;
      if (ai.entry && ai.take_profit && ai.stop_loss && ai.entry !== ai.stop_loss) {
        rr = Math.abs(ai.take_profit - ai.entry) / Math.abs(ai.entry - ai.stop_loss);
      }

      const wantsLong = signal.action === "BUY" || signal.trigger === "RSI_CROSS_UP_30";
      const wantsShort = signal.action === "SELL" || signal.trigger === "RSI_CROSS_DOWN_70";
      let tfAligned = true;
      if (snap4h) {
        const p4h = Number(snap4h.price), e4h = Number(snap4h.ema200);
        if (wantsLong && p4h < e4h) tfAligned = false;
        if (wantsShort && p4h > e4h) tfAligned = false;
      }
      if (snap1h) {
        const p1h = Number(snap1h.price), e1h = Number(snap1h.ema200);
        if (wantsLong && p1h < e1h) tfAligned = false;
        if (wantsShort && p1h > e1h) tfAligned = false;
      }

      const rrOk = rr === 0 || rr >= 1.5;
      const shouldSendTelegram =
        url.pathname === "/webhook" &&
        signal.event_type === "SIGNAL" &&
        ai.recommendation === "RECOMMENDED" &&
        ai.score >= 65 &&
        ai.risk !== "HIGH" &&
        rrOk &&
        tfAligned;

      let telegram = null;
      if (shouldSendTelegram) {
        telegram = await sendTelegram(env, formatTelegram(signal, ai, ruleScore, priority));
      }

      if (shouldSendTelegram && ai.score >= 85) {
        const sym = signal.symbol || "?";
        const dir = ai.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
        const excMsg = `🚨 *EXCELLENT SIGNAL — ${sym}*\n${dir} | Score: *${ai.score}/100*\nSetup ist top — sofort pruefen!`;
        await sendTelegram(env, excMsg);
      }

      return jsonResponse({
        status: "ok",
        route: url.pathname,
        sent_to_telegram: shouldSendTelegram,
        signal,
        ruleScore,
        ai,
        priority,
        telegram
      }, 200, corsHeaders);
    }

    return new Response("WAVESCOUT v3.2 läuft ✅", { headers: corsHeaders });
  },

  async scheduled(controller, env, ctx) {
    const cron = controller.cron;
    if (cron === "0 7 * * *") {
      ctx.waitUntil(dailySummary(env));
    } else {
      ctx.waitUntil(checkOutcomes(env));
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function checkSecret(url, env) {
  const secret = url.searchParams.get("secret");
  return env.WEBHOOK_SECRET && secret === env.WEBHOOK_SECRET;
}

function unauthorized() {
  return new Response(JSON.stringify({ status: "error", message: "Unauthorized" }), {
    status: 401,
    headers: { 
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
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

function clamp(n) {
  return Math.max(0, Math.min(100, Number(n) || 0));
}

function getPriority(score, recommendation, risk) {
  if (recommendation === "NOT_RECOMMENDED" || score < 50) return "❌ NICHT EMPFOHLEN";
  if (score >= 75 && risk !== "HIGH") return "🔥 STARKE EMPFEHLUNG";
  return "⚠️ MITTLERE EMPFEHLUNG";
}

// ═══════════════════════════════════════════════════════════════
// RULE-BASED SCORE CALCULATION
// ═══════════════════════════════════════════════════════════════

function calculateRuleScore(signal, snap1h, snap4h) {
  let score = 50;
  const notes = [];

  const price = Number(signal.price);
  const rsi = Number(signal.rsi);
  const ema50 = Number(signal.ema50);
  const ema200 = Number(signal.ema200);
  const support = Number(signal.support);
  const resistance = Number(signal.resistance);
  const trigger = signal.trigger || "";
  const action = signal.action || "";

  const wantsLong = action === "BUY" || trigger === "RSI_CROSS_UP_30";
  const wantsShort = action === "SELL" || trigger === "RSI_CROSS_DOWN_70";

  if (wantsLong) {
    if (price > ema200) { score += 15; notes.push("Preis über EMA200 ✓"); }
    else { score -= 25; notes.push("Preis unter EMA200 – gegen Bias"); }
  }
  if (wantsShort) {
    if (price < ema200) { score += 15; notes.push("Preis unter EMA200 ✓"); }
    else { score -= 25; notes.push("Preis über EMA200 – gegen Bias"); }
  }

  if (wantsLong) {
    if (price > ema50 && ema50 > ema200) { score += 15; notes.push("Bullische EMA-Struktur ✓"); }
  }
  if (wantsShort) {
    if (price < ema50 && ema50 < ema200) { score += 15; notes.push("Bearische EMA-Struktur ✓"); }
  }

  if (!Number.isNaN(rsi)) {
    if (wantsLong) {
      if (rsi >= 30 && rsi <= 55) { score += 12; notes.push(`RSI ${rsi.toFixed(1)} – guter Einstieg ✓`); }
      else if (rsi > 70) { score -= 20; notes.push(`RSI ${rsi.toFixed(1)} – überkauft ✗`); }
    }
    if (wantsShort) {
      if (rsi >= 45 && rsi <= 70) { score += 12; notes.push(`RSI ${rsi.toFixed(1)} – guter Short ✓`); }
      else if (rsi < 30) { score -= 20; notes.push(`RSI ${rsi.toFixed(1)} – überverkauft ✗`); }
    }
  }

  if (snap4h) {
    const p4h = Number(snap4h.price);
    const ema200_4h = Number(snap4h.ema200);

    if (wantsLong) {
      if (p4h > ema200_4h) {
        score += 20;
        notes.push("4H über EMA200 ✓✓");
      } else {
        score -= 30;
        notes.push("4H unter EMA200 ✗✗");
      }
    }
    if (wantsShort) {
      if (p4h < ema200_4h) {
        score += 20;
        notes.push("4H unter EMA200 ✓✓");
      } else {
        score -= 30;
        notes.push("4H über EMA200 ✗✗");
      }
    }
  }

  if (snap1h) {
    const p1h = Number(snap1h.price);
    const ema200_1h = Number(snap1h.ema200);

    if (wantsLong && p1h > ema200_1h) { score += 10; notes.push("1H über EMA200 ✓"); }
    if (wantsShort && p1h < ema200_1h) { score += 10; notes.push("1H unter EMA200 ✓"); }
  }

  return { score: clamp(score), reason: notes.join(" | ") || "Keine Daten" };
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE AI ANALYSIS
// ═══════════════════════════════════════════════════════════════

async function analyzeWithClaude(env, signal, ruleScore, snap1h, snap4h) {
  const prompt = `Du bist WAVESCOUT, ein vorsichtiger Trading-Analyst der die folgende Top-Down Daytrading Strategie anwendet:

STRATEGIE-REGELN (strikt einhalten):
1. Tages-Bias: Preis über EMA200 (4H) = Long-Bias, darunter = Short-Bias. Gegen Bias = kein Trade.
2. Entry nur in Key-Zonen (Support für Long, Resistance für Short)
3. RSI-Filter: Entry NUR bei RSI 30–55 (Long) oder 45–70 (Short). Kein Entry bei Extremen (>70 oder <30).
4. Klare Trendstruktur nötig (kein Chaos, kein Seitwärtsmarkt)
5. R/R mindestens 1:1.5, Ziel 1:2
6. Im Zweifel: KEIN Trade. Verpasste Trades sind keine Verluste.

Signal:
${JSON.stringify(signal, null, 2)}

Regelbasierter Score:
${JSON.stringify(ruleScore, null, 2)}

${snap1h ? `1H Timeframe:\n${JSON.stringify(snap1h, null, 2)}\n` : ''}
${snap4h ? `4H Timeframe:\n${JSON.stringify(snap4h, null, 2)}\n` : ''}

Bewerte streng nach der Strategie. Lieber 3 gute Trades als 10 schlechte.

Antworte NUR als JSON (kein Markdown, keine Erklärung außerhalb):
{
  "recommendation": "RECOMMENDED" oder "NOT_RECOMMENDED",
  "direction": "LONG" oder "SHORT" oder "NONE",
  "score": 0-100,
  "risk": "LOW" oder "MEDIUM" oder "HIGH",
  "confidence": 0-100,
  "reason": "kurze deutsche Begründung (max 2 Sätze)",
  "entry": Zahl,
  "take_profit": Zahl,
  "stop_loss": Zahl
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return ruleBasedFallback(signal, ruleScore);
    }

    const raw = data.content?.[0]?.text || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return ruleBasedFallback(signal, ruleScore);
    return JSON.parse(match[0]);

  } catch (err) {
    console.error("Claude Fetch Fehler:", err);
    return ruleBasedFallback(signal, ruleScore);
  }
}

function ruleBasedFallback(signal, ruleScore) {
  const score = ruleScore ? ruleScore.score : 50;
  const price = Number(signal.price) || 0;
  const trigger = signal.trigger || "";
  const action = signal.action || "";
  const wantsLong = action === "BUY" || trigger === "RSI_CROSS_UP_30";
  const wantsShort = action === "SELL" || trigger === "RSI_CROSS_DOWN_70";
  const direction = wantsLong ? "LONG" : wantsShort ? "SHORT" : "NONE";

  const recommendation = score >= 65 && direction !== "NONE" ? "RECOMMENDED" : "NOT_RECOMMENDED";
  const risk = score >= 70 ? "LOW" : score >= 50 ? "MEDIUM" : "HIGH";

  return {
    recommendation,
    direction,
    score,
    risk,
    confidence: Math.round(score * 0.65),
    reason: "[Regelbasiert] " + (ruleScore ? ruleScore.reason : "Keine Daten"),
    entry: price,
    take_profit: price * (wantsLong ? 1.015 : 0.985),
    stop_loss: price * (wantsLong ? 0.992 : 1.008)
  };
}

// ═══════════════════════════════════════════════════════════════
// DATABASE FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function saveSignal(env, signal, ai, ruleScore) {
  const id = `${signal.symbol}_${Date.now()}`;
  await env.DB.prepare(`
    INSERT INTO signals (
      id, symbol, timeframe, price, direction, trigger, 
      ai_recommendation, ai_score, ai_risk, ai_entry, ai_tp, ai_sl, ai_reason,
      rule_score, rule_reason, created_at, outcome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    signal.symbol,
    signal.timeframe || "5m",
    Number(signal.price),
    ai.direction,
    signal.trigger || "",
    ai.recommendation,
    ai.score,
    ai.risk,
    ai.entry,
    ai.take_profit,
    ai.stop_loss,
    ai.reason,
    ruleScore.score,
    ruleScore.reason,
    Date.now(),
    "OPEN"
  ).run();
  
  return id;
}

async function saveSnapshot(env, snapshot) {
  const id = `${snapshot.symbol}_${snapshot.timeframe || "5m"}_${Date.now()}`;
  await env.DB.prepare(`
    INSERT INTO snapshots (
      id, symbol, timeframe, price, rsi, ema50, ema200, 
      support, resistance, trend, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    snapshot.symbol,
    snapshot.timeframe || "5m",
    Number(snapshot.price),
    Number(snapshot.rsi),
    Number(snapshot.ema50),
    Number(snapshot.ema200),
    Number(snapshot.support),
    Number(snapshot.resistance),
    snapshot.trend || "",
    Date.now()
  ).run();
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

async function setOutcome(env, id, outcome, exitPrice = null) {
  await env.DB.prepare(`
    UPDATE signals 
    SET outcome = ?, exit_price = ?, updated_at = ? 
    WHERE id = ?
  `).bind(outcome, exitPrice, Date.now(), id).run();
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

async function getAnalytics(env) {
  const stats = await getStats(env);
  
  const avgScore = await env.DB.prepare(`
    SELECT AVG(ai_score) as avg FROM signals WHERE outcome IN ('WIN', 'LOSS')
  `).first();

  const bestWin = await env.DB.prepare(`
    SELECT * FROM signals WHERE outcome = 'WIN' ORDER BY ai_score DESC LIMIT 1
  `).first();

  const worstLoss = await env.DB.prepare(`
    SELECT * FROM signals WHERE outcome = 'LOSS' ORDER BY ai_score ASC LIMIT 1
  `).first();

  return {
    ...stats,
    avgScore: avgScore?.avg ? parseFloat(avgScore.avg.toFixed(1)) : 0,
    bestWin,
    worstLoss
  };
}

async function getSnapshots(env) {
  const rows = await env.DB.prepare(`
    SELECT * FROM snapshots 
    ORDER BY created_at DESC 
    LIMIT 100
  `).all();
  
  return rows.results || [];
}

// ═══════════════════════════════════════════════════════════════
// TELEGRAM FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function formatTelegram(signal, ai, ruleScore, priority) {
  const sym = signal.symbol || "?";
  const dir = ai.direction === "LONG" ? "🟢 LONG" : ai.direction === "SHORT" ? "🔴 SHORT" : "⚪ NEUTRAL";
  const entry = ai.entry ? `$${ai.entry.toFixed(4)}` : "N/A";
  const tp = ai.take_profit ? `$${ai.take_profit.toFixed(4)}` : "N/A";
  const sl = ai.stop_loss ? `$${ai.stop_loss.toFixed(4)}` : "N/A";
  
  return `${priority}\n\n*${sym}* | ${dir}\n\n` +
         `📊 AI Score: *${ai.score}/100*\n` +
         `📏 Rule Score: ${ruleScore.score}/100\n` +
         `⚠️ Risk: ${ai.risk}\n\n` +
         `💰 Entry: ${entry}\n` +
         `🎯 Take Profit: ${tp}\n` +
         `🛡️ Stop Loss: ${sl}\n\n` +
         `📝 ${ai.reason}\n` +
         `🔍 ${ruleScore.reason}`;
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("Telegram not configured");
    return { ok: false, message: "Not configured" };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "Markdown"
      })
    });
    return await res.json();
  } catch(e) {
    console.error("Telegram send error:", e);
    return { ok: false, error: e.message };
  }
}

async function handleTelegramUpdate(env, update) {
  if (!update.message?.text) return;
  
  const text = update.message.text.toLowerCase();
  const chatId = update.message.chat.id;
  
  if (text === "/start" || text === "/help") {
    await sendTelegram(env, "🤖 *WAVESCOUT Bot*\n\n/stats - Zeige Statistiken\n/history - Letzte Signale\n/help - Diese Hilfe");
  } else if (text === "/stats") {
    const stats = await getStats(env);
    await sendTelegram(env, `📊 *Statistiken*\n\nTotal: ${stats.total}\nWins: ${stats.wins}\nLosses: ${stats.losses}\nWin-Rate: ${stats.winRate}%`);
  } else if (text === "/history") {
    const history = await getHistory(env, 5);
    let msg = "📜 *Letzte 5 Signale:*\n\n";
    history.forEach((s, i) => {
      msg += `${i+1}. ${s.symbol} ${s.direction} - Score: ${s.ai_score} - ${s.outcome}\n`;
    });
    await sendTelegram(env, msg);
  }
}

async function dailySummary(env) {
  const stats = await getStats(env);
  const msg = `🌅 *Tägliche Zusammenfassung*\n\n` +
              `Trades: ${stats.total}\n` +
              `Wins: ${stats.wins}\n` +
              `Losses: ${stats.losses}\n` +
              `Win-Rate: ${stats.winRate}%`;
  await sendTelegram(env, msg);
}

async function checkOutcomes(env) {
  // Placeholder for automated outcome checking
  console.log("Checking outcomes...");
}
