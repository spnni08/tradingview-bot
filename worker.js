export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", time: new Date().toISOString() });
    }

    // Telegram Bot Webhook — empfängt Nachrichten/Commands von Telegram
    if (request.method === "POST" && url.pathname === "/telegram") {
      const update = await request.json();
      ctx.waitUntil(handleTelegramUpdate(env, update));
      return Response.json({ ok: true });
    }

    // Telegram Webhook registrieren (einmalig aufrufen)
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
      return Response.json({ status: "ok", workerUrl, telegram: data });
    }

    if (request.method === "GET" && url.pathname === "/test-telegram") {
      return Response.json(await sendTelegram(env, "✅ WAVESCOUT Telegram Test funktioniert."));
    }

    if (request.method === "GET" && url.pathname === "/check-outcomes") {
      if (!checkSecret(url, env)) return unauthorized();
      const result = await checkOutcomes(env);
      return Response.json({ status: "ok", result });
    }

    if (request.method === "GET" && url.pathname === "/morning-brief") {
      if (!checkSecret(url, env)) return unauthorized();
      await morningBrief(env);
      return Response.json({ status: "ok", message: "Morning Brief gesendet" });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      return Response.json(await getStats(env));
    }

    if (request.method === "GET" && url.pathname === "/history") {
      return Response.json(await getHistory(env));
    }

    if (request.method === "GET" && url.pathname === "/backtesting") {
      return Response.json(await getBacktesting(env));
    }

    if (request.method === "GET" && url.pathname === "/dashboard") {
      return new Response(dashboardHtml(), {
        headers: { "Content-Type": "text/html;charset=utf-8" }
      });
    }

    if (request.method === "GET" && url.pathname === "/snapshots") {
      return Response.json(await getSnapshots(env));
    }

    if (request.method === "POST" && url.pathname === "/outcome") {
      if (!checkSecret(url, env)) return unauthorized();
      const id = url.searchParams.get("id");
      const outcome = url.searchParams.get("outcome");
      if (!id || !["WIN","LOSS","OPEN","SKIPPED"].includes(outcome)) {
        return Response.json({ error: "Missing or invalid id/outcome" }, { status: 400 });
      }
      await setOutcome(env, id, outcome);
      return Response.json({ status: "ok", id, outcome });
    }

    if (request.method === "POST" && url.pathname === "/snapshot") {
      if (!checkSecret(url, env)) return unauthorized();
      const signal = await request.json();
      await saveSnapshot(env, signal);
      return Response.json({ status: "ok", saved: true, signal });
    }

    if (request.method === "GET" && url.pathname === "/ask") {
      if (!checkSecret(url, env)) return unauthorized();
      const symbol = url.searchParams.get("symbol");
      if (!symbol) return Response.json({ error: "Missing symbol" }, { status: 400 });

      const snapshot = await getSnapshot(env, symbol);
      if (!snapshot) return Response.json({ error: "No snapshot found for symbol" }, { status: 404 });

      const snap1h = await getSnapshot(env, symbol, "1H");
      const snap4h = await getSnapshot(env, symbol, "4H");
      const ruleScore = calculateRuleScore(snapshot, snap1h, snap4h);
      const ai = await analyzeWithClaude(env, snapshot, ruleScore, snap1h, snap4h);
      const text = formatTelegram(snapshot, ai, ruleScore, "🧠 MANUELLER CHART-CHECK");
      const telegram = await sendTelegram(env, text);

      return Response.json({ status: "ok", snapshot, ai, telegram });
    }

    if (request.method === "POST" && (url.pathname === "/webhook" || url.pathname === "/backtest")) {
      if (!checkSecret(url, env)) return unauthorized();

      const signal = await request.json();

      // SNAPSHOT-Typ nur speichern, nicht analysieren
      if (signal.event_type === "SNAPSHOT") {
        await saveSnapshot(env, signal);
        return Response.json({
          status: "ok",
          type: "snapshot_saved",
          symbol: signal.symbol,
          time: signal.time
        });
      }

      // Multi-Timeframe Snapshots laden
      const snap1h = await getSnapshot(env, signal.symbol, "1H");
      const snap4h = await getSnapshot(env, signal.symbol, "4H");

      const ruleScore = calculateRuleScore(signal, snap1h, snap4h);
      const ai = await analyzeWithClaude(env, signal, ruleScore, snap1h, snap4h);

      const finalScore = clamp(Math.round((Number(ai.score || 0) * 0.75) + (ruleScore.score * 0.25)));
      ai.score = finalScore;

      const priority = getPriority(ai.score, ai.recommendation, ai.risk);

      await saveSignal(env, signal, ai, ruleScore);

      // Telegram nur bei wirklich guten Signalen
      const shouldSendTelegram =
        url.pathname === "/webhook" &&
        ai.recommendation === "RECOMMENDED" &&
        ai.score >= 70 &&
        ai.risk !== "HIGH";

      let telegram = null;
      if (shouldSendTelegram) {
        telegram = await sendTelegram(env, formatTelegram(signal, ai, ruleScore, priority));
      }

      return Response.json({
        status: "ok",
        route: url.pathname,
        sent_to_telegram: shouldSendTelegram,
        signal,
        ruleScore,
        ai,
        priority,
        telegram
      });
    }

    return new Response("WAVESCOUT läuft ✅");
  },

  async scheduled(controller, env, ctx) {
    const cron = controller.cron;
    if (cron === "0 7 * * *") {
      // 07:00 Uhr → Daily Summary
      ctx.waitUntil(dailySummary(env));
    } else {
      // Jede andere Stunde → Outcome Tracking
      ctx.waitUntil(checkOutcomes(env));
    }
  }
};

// ─── Auth ────────────────────────────────────────────────────────────────────

function checkSecret(url, env) {
  return env.WEBHOOK_SECRET && url.searchParams.get("secret") === env.WEBHOOK_SECRET;
}

function unauthorized() {
  return Response.json({ status: "error", message: "Unauthorized" }, { status: 401 });
}

function clamp(n) {
  return Math.max(0, Math.min(100, Number(n) || 0));
}

// ─── Priorität & Score ───────────────────────────────────────────────────────

function getPriority(score, recommendation, risk) {
  if (recommendation === "NOT_RECOMMENDED" || score < 50) return "❌ NICHT EMPFOHLEN";
  if (score >= 75 && risk !== "HIGH") return "🔥 STARKE EMPFEHLUNG";
  return "⚠️ MITTLERE EMPFEHLUNG";
}

// ─── Regelbasierter Score (Top-Down Strategie) ───────────────────────────────

function calculateRuleScore(signal, snap1h, snap4h) {
  let score = 50;
  const notes = [];

  const price = Number(signal.price);
  const rsi = Number(signal.rsi);
  const ema50 = Number(signal.ema50);
  const ema200 = Number(signal.ema200);
  const support = Number(signal.support);
  const resistance = Number(signal.resistance);
  const trend = signal.trend || "";
  const trigger = signal.trigger || "";
  const action = signal.action || "";
  const waveBias = signal.wave_bias || "";

  const wantsLong = action === "BUY" || trigger === "RSI_CROSS_UP_30";
  const wantsShort = action === "SELL" || trigger === "RSI_CROSS_DOWN_70";

  // ── Strategie-Regel 1: Tages-Bias via EMA200 auf 4H ──
  // EMA200 bestimmt die Hauptrichtung – gegen Bias = sofort Abzug
  if (wantsLong) {
    if (price > ema200) { score += 15; notes.push("Preis über EMA200 ✓"); }
    else { score -= 25; notes.push("Preis unter EMA200 – gegen Bias"); }
  }
  if (wantsShort) {
    if (price < ema200) { score += 15; notes.push("Preis unter EMA200 ✓"); }
    else { score -= 25; notes.push("Preis über EMA200 – gegen Bias"); }
  }

  // ── Strategie-Regel 2: EMA50/200 Trendstruktur ──
  if (wantsLong) {
    if (price > ema50 && ema50 > ema200) { score += 15; notes.push("Bullische EMA-Struktur ✓"); }
    else if (ema50 < ema200) { score -= 10; notes.push("EMA bearish"); }
  }
  if (wantsShort) {
    if (price < ema50 && ema50 < ema200) { score += 15; notes.push("Bearische EMA-Struktur ✓"); }
    else if (ema50 > ema200) { score -= 10; notes.push("EMA bullish"); }
  }

  // ── Strategie-Regel 3: RSI-Filter (kein Entry bei Extremen) ──
  if (!Number.isNaN(rsi)) {
    if (wantsLong) {
      if (rsi >= 30 && rsi <= 55) { score += 12; notes.push(`RSI ${rsi.toFixed(1)} – guter Einstieg ✓`); }
      else if (rsi > 70) { score -= 20; notes.push(`RSI ${rsi.toFixed(1)} – überkauft ✗`); }
      else if (rsi < 30) { score -= 10; notes.push(`RSI ${rsi.toFixed(1)} – extrem`); }
    }
    if (wantsShort) {
      if (rsi >= 45 && rsi <= 70) { score += 12; notes.push(`RSI ${rsi.toFixed(1)} – guter Short ✓`); }
      else if (rsi < 30) { score -= 20; notes.push(`RSI ${rsi.toFixed(1)} – überverkauft ✗`); }
      else if (rsi > 70) { score -= 10; notes.push(`RSI ${rsi.toFixed(1)} – extrem`); }
    }
  }

  // ── Strategie-Regel 4: Support/Resistance Abstand ──
  if (wantsLong && !Number.isNaN(resistance) && resistance > price) {
    const distPct = ((resistance - price) / price) * 100;
    if (distPct < 0.5) { score -= 20; notes.push("Resistance zu nah ✗"); }
    else if (distPct >= 1.5) { score += 10; notes.push("Genug Raum bis Resistance ✓"); }
  }
  if (wantsShort && !Number.isNaN(support) && support < price) {
    const distPct = ((price - support) / price) * 100;
    if (distPct < 0.5) { score -= 20; notes.push("Support zu nah ✗"); }
    else if (distPct >= 1.5) { score += 10; notes.push("Genug Raum bis Support ✓"); }
  }

  // ── Strategie-Regel 5: Kein Chaos/Seitwärtsmarkt ──
  if (trend === "neutral") { score -= 15; notes.push("Seitwärtsmarkt – kein klarer Trend ✗"); }

  // ── Strategie-Regel 6: Wave Bias als weicher Filter ──
  if (wantsLong && waveBias === "bullish_impulse_possible") { score += 8; notes.push("Wave Bias bullish ✓"); }
  if (wantsLong && waveBias === "bearish_impulse_possible") { score -= 8; }
  if (wantsShort && waveBias === "bearish_impulse_possible") { score += 8; notes.push("Wave Bias bearish ✓"); }
  if (wantsShort && waveBias === "bullish_impulse_possible") { score -= 8; }

  // ── Keine klare Richtung ──
  if (!wantsLong && !wantsShort) {
    score -= 20;
    notes.push("Kein klares Signal");
  }

  // ── Strategie-Regel 7: Multi-Timeframe Bestätigung (stärkster Filter) ──
  // 4H Bias ist die Hauptregel laut Strategie — wenn 4H verfügbar, stark gewichten
  if (snap4h) {
    const p4h = Number(snap4h.price);
    const ema200_4h = Number(snap4h.ema200);
    const ema50_4h = Number(snap4h.ema50);
    const trend4h = snap4h.trend || "";
    const rsi4h = Number(snap4h.rsi);

    if (wantsLong) {
      if (p4h > ema200_4h) {
        score += 20;
        notes.push("4H über EMA200 ✓✓");
      } else {
        score -= 30;
        notes.push("4H unter EMA200 — gegen Hauptbias ✗✗");
      }
      if (trend4h === "bullish") { score += 10; notes.push("4H Trend bullish ✓"); }
      if (trend4h === "bearish") { score -= 15; notes.push("4H Trend bearish ✗"); }
      // EMA flach auf 4H = kein Trade
      if (ema50_4h && ema200_4h) {
        const spread = Math.abs(ema50_4h - ema200_4h) / ema200_4h * 100;
        if (spread < 0.3) { score -= 20; notes.push("4H EMA flach — kein Trade ✗"); }
      }
    }
    if (wantsShort) {
      if (p4h < ema200_4h) {
        score += 20;
        notes.push("4H unter EMA200 ✓✓");
      } else {
        score -= 30;
        notes.push("4H über EMA200 — gegen Hauptbias ✗✗");
      }
      if (trend4h === "bearish") { score += 10; notes.push("4H Trend bearish ✓"); }
      if (trend4h === "bullish") { score -= 15; notes.push("4H Trend bullish ✗"); }
    }
  }

  // 1H Bestätigung — mittlerer Filter
  if (snap1h) {
    const p1h = Number(snap1h.price);
    const ema200_1h = Number(snap1h.ema200);
    const trend1h = snap1h.trend || "";
    const rsi1h = Number(snap1h.rsi);

    if (wantsLong) {
      if (p1h > ema200_1h) { score += 10; notes.push("1H über EMA200 ✓"); }
      else { score -= 10; notes.push("1H unter EMA200 ✗"); }
      if (trend1h === "bullish") { score += 5; notes.push("1H bullish ✓"); }
      if (!isNaN(rsi1h) && rsi1h > 60) { score -= 8; notes.push(`1H RSI ${rsi1h.toFixed(0)} zu hoch`); }
    }
    if (wantsShort) {
      if (p1h < ema200_1h) { score += 10; notes.push("1H unter EMA200 ✓"); }
      else { score -= 10; notes.push("1H über EMA200 ✗"); }
      if (trend1h === "bearish") { score += 5; notes.push("1H bearish ✓"); }
      if (!isNaN(rsi1h) && rsi1h < 40) { score -= 8; notes.push(`1H RSI ${rsi1h.toFixed(0)} zu niedrig`); }
    }
  }

  return { score: clamp(score), reason: notes.join(" | ") || "Keine Daten" };
}

// ─── Claude AI Analyse ───────────────────────────────────────────────────────

async function analyzeWithClaude(env, signal, ruleScore) {
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

  const endpoint = "https://api.anthropic.com/v1/messages";

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    // Kein Credit / Auth Fehler → Regelbasierter Fallback
    if (!response.ok) {
      const errMsg = data.error?.message || "";
      const isCredit = data.error?.type === "credit_balance_too_low" ||
                       response.status === 402 ||
                       errMsg.toLowerCase().includes("credit") ||
                       errMsg.toLowerCase().includes("billing");
      if (isCredit) {
        console.error("Claude API: Keine Credits — Regelbasierter Fallback");
        sendTelegram(env, "WAVESCOUT: Claude API Credits aufgebraucht! Analyse laeuft regelbasiert weiter.").catch(()=>{});
      }
      return ruleBasedFallback(signal, ruleScore, snap1h, snap4h);
    }

    const raw = data.content?.[0]?.text || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return ruleBasedFallback(signal, ruleScore, snap1h, snap4h);
    return JSON.parse(match[0]);

  } catch (err) {
    console.error("Claude Fetch Fehler:", err);
    return ruleBasedFallback(signal, ruleScore, snap1h, snap4h);
  }
}

// Regelbasierter Fallback wenn Claude API nicht verfuegbar
function ruleBasedFallback(signal, ruleScore, snap1h, snap4h) {
  const score = ruleScore ? ruleScore.score : 50;
  const price = Number(signal.price) || 0;
  const trigger = signal.trigger || "";
  const action = signal.action || "";
  const wantsLong = action === "BUY" || trigger === "RSI_CROSS_UP_30";
  const wantsShort = action === "SELL" || trigger === "RSI_CROSS_DOWN_70";
  const direction = wantsLong ? "LONG" : wantsShort ? "SHORT" : "NONE";

  // 4H Bias pruefen
  let biasOk = true;
  if (snap4h) {
    const p4h = Number(snap4h.price);
    const e4h = Number(snap4h.ema200);
    if (wantsLong && p4h < e4h) biasOk = false;
    if (wantsShort && p4h > e4h) biasOk = false;
  }

  const finalScore = biasOk ? score : Math.min(score, 40);
  const recommendation = finalScore >= 65 && direction !== "NONE" && biasOk ? "RECOMMENDED" : "NOT_RECOMMENDED";
  const risk = finalScore >= 70 ? "LOW" : finalScore >= 50 ? "MEDIUM" : "HIGH";

  const support = Number(signal.support) || 0;
  const resistance = Number(signal.resistance) || 0;
  const tp = wantsLong && resistance > price ? resistance : price * 1.015;
  const sl = wantsLong && support > 0 && support < price ? support : price * 0.992;

  return {
    recommendation,
    direction,
    score: finalScore,
    risk,
    confidence: Math.round(finalScore * 0.65),
    reason: "[Regelbasiert - Claude offline] " + (ruleScore ? ruleScore.reason : "Keine Daten"),
    entry: price,
    take_profit: Number(tp.toFixed(4)),
    stop_loss: Number(sl.toFixed(4))
  };
}

function fallback(signal, reason) {
  return ruleBasedFallback(signal, { score: 30, reason: reason }, null, null);
}

// ─── Datenbank ───────────────────────────────────────────────────────────────

async function saveSignal(env, signal, ai, ruleScore) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      created_at INTEGER,
      timestamp TEXT,
      symbol TEXT,
      name TEXT,
      timeframe TEXT,
      trigger TEXT,
      price REAL,
      rsi REAL,
      ema50 REAL,
      ema200 REAL,
      trend TEXT,
      support REAL,
      resistance REAL,
      wave_bias TEXT,
      ai_recommendation TEXT,
      ai_direction TEXT,
      ai_score INTEGER,
      ai_risk TEXT,
      ai_confidence INTEGER,
      ai_entry REAL,
      ai_take_profit REAL,
      ai_stop_loss REAL,
      outcome TEXT,
      raw_signal TEXT,
      raw_ai TEXT
    )
  `).run();

  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO signals (
      id, created_at, timestamp, symbol, name, timeframe, trigger, price,
      rsi, ema50, ema200, trend, support, resistance, wave_bias,
      ai_recommendation, ai_direction, ai_score, ai_risk, ai_confidence,
      ai_entry, ai_take_profit, ai_stop_loss, outcome, raw_signal, raw_ai
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, now,
    signal.time || new Date(now).toISOString(),
    signal.symbol || "",
    signal.name || signal.symbol || "",
    signal.timeframe || "",
    signal.trigger || signal.action || "",
    Number(signal.price) || null,
    Number(signal.rsi) || null,
    Number(signal.ema50) || null,
    Number(signal.ema200) || null,
    signal.trend || "",
    Number(signal.support) || null,
    Number(signal.resistance) || null,
    signal.wave_bias || "",
    ai.recommendation || "",
    ai.direction || "",
    Number(ai.score) || 0,
    ai.risk || "",
    Number(ai.confidence) || 0,
    Number(ai.entry) || null,
    Number(ai.take_profit) || null,
    Number(ai.stop_loss) || null,
    "OPEN",
    JSON.stringify(signal),
    JSON.stringify(ai)
  ).run();

  return id;
}

async function saveSnapshot(env, signal) {
  // Timeframe-aware key: symbol + timeframe (z.B. BTCUSDT_1H, BTCUSDT_4H, BTCUSDT_5)
  const tf = signal.timeframe || "5";
  const key = `${signal.symbol}_${tf}`;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS snapshots (
      key TEXT PRIMARY KEY,
      symbol TEXT,
      timeframe TEXT,
      updated_at INTEGER,
      raw_signal TEXT
    )
  `).run();

  await env.DB.prepare(`
    INSERT INTO snapshots (key, symbol, timeframe, updated_at, raw_signal)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      updated_at = excluded.updated_at,
      raw_signal = excluded.raw_signal
  `).bind(key, signal.symbol, tf, Date.now(), JSON.stringify(signal)).run();
}

async function getSnapshot(env, symbol, timeframe) {
  const tf = timeframe || "5";
  const key = `${symbol}_${tf}`;
  try {
    const row = await env.DB.prepare(
      `SELECT raw_signal FROM snapshots WHERE key = ?`
    ).bind(key).first();
    return row ? JSON.parse(row.raw_signal) : null;
  } catch {
    // Fallback: alte Tabelle ohne key-Spalte
    try {
      const row2 = await env.DB.prepare(
        `SELECT raw_signal FROM snapshots WHERE symbol = ?`
      ).bind(symbol).first();
      return row2 ? JSON.parse(row2.raw_signal) : null;
    } catch {
      return null;
    }
  }
}
async function getSnapshots(env) {
  try {
    const result = await env.DB.prepare(
      `SELECT raw_signal, updated_at, timeframe FROM snapshots ORDER BY updated_at DESC LIMIT 60`
    ).all();
    // Nur 5min Snapshots fürs Dashboard (1H/4H separat)
    return (result.results || [])
      .filter(row => {
        const tf = row.timeframe || "5";
        return tf === "5" || tf === "5m" || tf === "1" || !["60","240","1H","4H"].includes(tf);
      })
      .map(row => {
        const s = JSON.parse(row.raw_signal);
        s._updated_at = row.updated_at;
        return s;
      });
  } catch {
    return [];
  }
}

async function getStats(env) {
  try {
    const row = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN outcome='OPEN' THEN 1 ELSE 0 END) AS open
      FROM signals
    `).first();

    const closed = Number(row.wins || 0) + Number(row.losses || 0);
    return {
      total: row.total || 0,
      wins: row.wins || 0,
      losses: row.losses || 0,
      open: row.open || 0,
      winrate: closed ? Number(((row.wins / closed) * 100).toFixed(2)) : 0
    };
  } catch {
    return { total: 0, wins: 0, losses: 0, open: 0, winrate: 0 };
  }
}

async function getHistory(env) {
  try {
    const result = await env.DB.prepare(`
      SELECT * FROM signals ORDER BY created_at DESC LIMIT 50
    `).all();
    return result.results || [];
  } catch {
    return [];
  }
}

async function setOutcome(env, id, outcome) {
  await env.DB.prepare(
    `UPDATE signals SET outcome = ? WHERE id = ?`
  ).bind(outcome, id).run();
}

async function getBacktesting(env) {
  try {
    // Overall stats
    const overall = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN outcome='SKIPPED' THEN 1 ELSE 0 END) as skipped,
        AVG(CASE WHEN outcome='WIN' THEN ai_score ELSE NULL END) as avg_score_win,
        AVG(CASE WHEN outcome='LOSS' THEN ai_score ELSE NULL END) as avg_score_loss,
        AVG(CASE WHEN outcome='OPEN' THEN ai_score ELSE NULL END) as avg_score_open
      FROM signals
    `).first();

    // Per symbol
    const bySymbol = await env.DB.prepare(`
      SELECT symbol,
        COUNT(*) as total,
        SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
        AVG(ai_score) as avg_score
      FROM signals
      WHERE outcome IN ('WIN','LOSS')
      GROUP BY symbol
      ORDER BY wins DESC
      LIMIT 10
    `).all();

    // Last 7 days
    const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const week = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
      FROM signals WHERE created_at > ?
    `).bind(since7d).first();

    // Last 30 days
    const since30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const month = await env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
      FROM signals WHERE created_at > ?
    `).bind(since30d).first();

    // Best signals (WIN mit höchstem Score)
    const best = await env.DB.prepare(`
      SELECT symbol, ai_direction, ai_score, ai_entry, ai_take_profit, ai_stop_loss, created_at
      FROM signals WHERE outcome='WIN'
      ORDER BY ai_score DESC LIMIT 5
    `).all();

    // Worst signals (LOSS mit höchstem Score - sollte gewonnen haben)
    const worst = await env.DB.prepare(`
      SELECT symbol, ai_direction, ai_score, ai_entry, ai_take_profit, ai_stop_loss, created_at
      FROM signals WHERE outcome='LOSS'
      ORDER BY ai_score DESC LIMIT 5
    `).all();

    const closed = Number(overall.wins||0) + Number(overall.losses||0);
    const winrate = closed > 0 ? ((overall.wins/closed)*100).toFixed(1) : 0;

    const w7 = Number(week.wins||0) + Number(week.losses||0);
    const w30 = Number(month.wins||0) + Number(month.losses||0);

    return {
      overall: {
        total: overall.total||0,
        wins: overall.wins||0,
        losses: overall.losses||0,
        skipped: overall.skipped||0,
        winrate: Number(winrate),
        avg_score_win: Number((overall.avg_score_win||0).toFixed(1)),
        avg_score_loss: Number((overall.avg_score_loss||0).toFixed(1)),
      },
      week: {
        total: week.total||0, wins: week.wins||0, losses: week.losses||0,
        winrate: w7 > 0 ? Number(((week.wins/w7)*100).toFixed(1)) : 0
      },
      month: {
        total: month.total||0, wins: month.wins||0, losses: month.losses||0,
        winrate: w30 > 0 ? Number(((month.wins/w30)*100).toFixed(1)) : 0
      },
      bySymbol: bySymbol.results||[],
      best: best.results||[],
      worst: worst.results||[]
    };
  } catch(e) {
    return { error: e.message };
  }
}

// ─── Telegram ────────────────────────────────────────────────────────────────

function formatTelegram(signal, ai, ruleScore, priority) {
  const tp = ai.take_profit ? Number(ai.take_profit).toFixed(2) : "N/A";
  const sl = ai.stop_loss ? Number(ai.stop_loss).toFixed(2) : "N/A";
  const entry = ai.entry ? Number(ai.entry).toFixed(2) : "N/A";

  // R/R berechnen falls möglich
  let rrText = "";
  if (ai.entry && ai.take_profit && ai.stop_loss) {
    const reward = Math.abs(ai.take_profit - ai.entry);
    const risk = Math.abs(ai.entry - ai.stop_loss);
    if (risk > 0) rrText = `\nR/R: 1:${(reward / risk).toFixed(2)}`;
  }

  return `${priority}

📊 ${signal.name || signal.symbol || "Unknown"} (${signal.timeframe || "5m"})
📡 Signal: ${signal.trigger || signal.action || "DATA"}
💰 Preis: ${signal.price || "N/A"}

📈 Marktdaten
RSI: ${signal.rsi || "N/A"} | Trend: ${signal.trend || "N/A"}
EMA50: ${signal.ema50 || "N/A"} | EMA200: ${signal.ema200 || "N/A"}
Support: ${signal.support || "N/A"} | Resistance: ${signal.resistance || "N/A"}
Wave Bias: ${signal.wave_bias || "N/A"}

🧮 Regel-Score: ${ruleScore.score}/100
${ruleScore.reason}

🧠 Claude Analyse
Empfehlung: ${ai.recommendation}
Richtung: ${ai.direction} | Score: ${ai.score}/100
Risiko: ${ai.risk} | Confidence: ${ai.confidence}%

🎯 Trade Plan
Entry: ${entry}
TP: ${tp}
SL: ${sl}${rrText}

📝 ${ai.reason}

⚠️ Keine Finanzberatung. Eigene Prüfung erforderlich.`;
}

async function sendTelegram(env, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text })
    }
  );
  return response.json();
}

// ─── Outcome Tracking ───────────────────────────────────────────────────────

async function getCurrentPrice(symbol) {
  // Binance symbol cleaning: remove .P suffix (perpetuals), keep base format
  const cleaned = symbol.replace(/\.P$/, '').replace(/USDT\.P$/, 'USDT');
  
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${cleaned}`,
      { headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Number(data.price) || null;
  } catch {
    // Fallback: try futures price
    try {
      const res2 = await fetch(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${cleaned}`
      );
      const data2 = await res2.json();
      return Number(data2.price) || null;
    } catch {
      return null;
    }
  }
}

async function checkOutcomes(env) {
  let checked = 0;
  let closed = 0;
  const notifications = [];

  try {
    // Alle offenen Signale laden die TP und SL haben
    const result = await env.DB.prepare(`
      SELECT id, symbol, ai_direction, ai_entry, ai_take_profit, ai_stop_loss,
             created_at, name, ai_score
      FROM signals
      WHERE outcome = 'OPEN'
        AND ai_take_profit IS NOT NULL AND ai_take_profit > 0
        AND ai_stop_loss IS NOT NULL AND ai_stop_loss > 0
      ORDER BY created_at DESC
      LIMIT 100
    `).all();

    const signals = result.results || [];
    checked = signals.length;

    // Preise cachen um nicht zu viele API calls zu machen
    const priceCache = {};

    for (const sig of signals) {
      const symbol = sig.symbol;

      // Preis aus Cache oder neu holen
      if (!priceCache[symbol]) {
        priceCache[symbol] = await getCurrentPrice(symbol);
        // Kurz warten um Rate Limits zu vermeiden
        await new Promise(r => setTimeout(r, 150));
      }

      const price = priceCache[symbol];
      if (!price) continue;

      const tp = Number(sig.ai_take_profit);
      const sl = Number(sig.ai_stop_loss);
      const entry = Number(sig.ai_entry);
      const direction = sig.ai_direction;

      let outcome = null;

      if (direction === 'LONG') {
        if (price >= tp) outcome = 'WIN';
        else if (price <= sl) outcome = 'LOSS';
      } else if (direction === 'SHORT') {
        if (price <= tp) outcome = 'WIN';
        else if (price >= sl) outcome = 'LOSS';
      }

      if (outcome) {
        // In DB updaten
        await env.DB.prepare(
          `UPDATE signals SET outcome = ? WHERE id = ?`
        ).bind(outcome, sig.id).run();

        closed++;

        // Telegram Benachrichtigung vorbereiten
        const pnlPct = direction === 'LONG'
          ? (((price - entry) / entry) * 100).toFixed(2)
          : (((entry - price) / entry) * 100).toFixed(2);

        const emoji = outcome === 'WIN' ? '✅' : '❌';
        const rr = entry > 0
          ? (Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2)
          : '–';

        notifications.push(`${emoji} TRADE GESCHLOSSEN

📊 ${sig.name || symbol} (${direction})
Score war: ${sig.ai_score}/100

Entry: ${entry.toFixed(2)}
Exit: ${price.toFixed(2)}
${outcome === 'WIN' ? 'TP' : 'SL'} getroffen

P&L: ${outcome === 'WIN' ? '+' : ''}${pnlPct}%
R/R war: 1:${rr}

Ergebnis: ${outcome === 'WIN' ? '🏆 WIN' : '💔 LOSS'}`);
      }
    }

    // Telegram Nachrichten senden
    for (const msg of notifications) {
      await sendTelegram(env, msg);
      await new Promise(r => setTimeout(r, 300));
    }

  } catch (err) {
    console.error('checkOutcomes Fehler:', err);
  }

  return { checked, closed, notifications: notifications.length };
}

// ─── Morning Brief ───────────────────────────────────────────────────────────

function getBiasFromSnapshot(snap) {
  const price = Number(snap.price);
  const ema200 = Number(snap.ema200);
  const ema50 = Number(snap.ema50);
  const rsi = Number(snap.rsi);
  const trend = snap.trend || "";

  if (!price || !ema200) return { bias: "NEUTRAL", emoji: "⚪", reason: "Keine EMA200 Daten" };

  // Hauptregel: Preis vs EMA200
  const overEma200 = price > ema200;
  const underEma200 = price < ema200;

  // EMA200 flach? (EMA50 und EMA200 sehr nah beieinander)
  const emaSpreadPct = Math.abs(ema50 - ema200) / ema200 * 100;
  const emaFlat = emaSpreadPct < 0.3;

  if (emaFlat) {
    return { bias: "NEUTRAL", emoji: "⚪", reason: "EMA200 flach — kein Trade heute" };
  }

  if (overEma200 && trend === "bullish") {
    return { bias: "LONG", emoji: "🟢", reason: `Preis über EMA200 · RSI ${rsi.toFixed(0)} · Trend bullish` };
  }
  if (underEma200 && trend === "bearish") {
    return { bias: "SHORT", emoji: "🔴", reason: `Preis unter EMA200 · RSI ${rsi.toFixed(0)} · Trend bearish` };
  }
  if (overEma200) {
    return { bias: "LONG", emoji: "🟡", reason: `Preis über EMA200 · RSI ${rsi.toFixed(0)} · Trend gemischt` };
  }
  if (underEma200) {
    return { bias: "SHORT", emoji: "🟡", reason: `Preis unter EMA200 · RSI ${rsi.toFixed(0)} · Trend gemischt` };
  }

  return { bias: "NEUTRAL", emoji: "⚪", reason: "Kein klarer Bias" };
}

async function morningBrief(env) {
  const snapshots = await getSnapshots(env);

  if (!snapshots.length) {
    await sendTelegram(env, "🌅 WAVESCOUT Morning Brief\n\nNoch keine Snapshot-Daten vorhanden.");
    return;
  }

  const now = new Date();
  const dayNames = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
  const monthNames = ["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
  const dateStr = `${dayNames[now.getDay()]}, ${now.getDate()}. ${monthNames[now.getMonth()]} ${now.getFullYear()}`;

  const stats = await getStats(env);

  let lines = [];
  lines.push(`🌅 WAVESCOUT Morning Brief`);
  lines.push(`📅 ${dateStr}`);
  lines.push(``);
  lines.push(`📈 Stats: ${stats.wins}W / ${stats.losses}L · Winrate ${stats.winrate}%`);
  lines.push(``);
  lines.push(`─────────────────`);

  // Nur relevante Symbole (keine Duplikate, keine leeren)
  const seen = new Set();
  for (const snap of snapshots) {
    const symbol = snap.symbol;
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);

    const { bias, emoji, reason } = getBiasFromSnapshot(snap);
    const price = Number(snap.price);
    const support = Number(snap.support);
    const resistance = Number(snap.resistance);

    lines.push(``);
    lines.push(`${emoji} ${snap.name || symbol}`);
    lines.push(`Bias: ${bias}`);
    lines.push(`Preis: ${price ? price.toLocaleString('de-DE', {minimumFractionDigits: 2, maximumFractionDigits: 4}) : '–'}`);
    lines.push(`${reason}`);
    if (support && resistance) {
      lines.push(`Zonen: S ${support.toFixed(2)} | R ${resistance.toFixed(2)}`);
    }
  }

  lines.push(``);
  lines.push(`─────────────────`);
  lines.push(`⚠️ Nur in Bias-Richtung traden. Eigene Prüfung erforderlich.`);

  await sendTelegram(env, lines.join("\n"));
}

// ─── Daily Summary ───────────────────────────────────────────────────────────

async function dailySummary(env) {
  // Erst Outcome Tracking laufen lassen
  await checkOutcomes(env);
  // Dann Morning Brief senden
  await morningBrief(env);
}

// ─── Telegram Command Handler ────────────────────────────────────────────────

async function handleTelegramUpdate(env, update) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId = String(msg.chat.id);
  const allowedChatId = String(env.TELEGRAM_CHAT_ID);

  // Nur aus dem erlaubten Chat antworten (Sicherheit)
  if (chatId !== allowedChatId) {
    await sendTelegramTo(env, chatId, "Nicht autorisiert.");
    return;
  }

  const text = msg.text.trim().toLowerCase();

  // ── /start oder /hilfe ──
  if (text === "/start" || text === "/hilfe" || text === "/help") {
    await sendTelegramTo(env, chatId, `🌊 WAVESCOUT Bot — Kommandos

/btc — BTC analysieren
/eth — ETH analysieren  
/sol — SOL analysieren
/check SYMBOL — beliebiges Symbol (z.B. /check RENDERUSDT)
/status — Stats & Winrate
/brief — Morning Brief jetzt senden
/open — alle offenen Trades
/top — beste Signale heute

⚡ Beispiel: /check BTCUSDT`);
    return;
  }

  // ── /status ──
  if (text === "/status") {
    const stats = await getStats(env);
    await sendTelegramTo(env, chatId, `📊 WAVESCOUT Status

Total Signale: ${stats.total}
Wins: ${stats.wins} | Losses: ${stats.losses}
Open: ${stats.open}
Winrate: ${stats.winrate}%`);
    return;
  }

  // ── /brief ──
  if (text === "/brief") {
    await sendTelegramTo(env, chatId, "Morning Brief wird erstellt...");
    await morningBrief(env);
    return;
  }

  // ── /open ──
  if (text === "/open") {
    try {
      const result = await env.DB.prepare(`
        SELECT symbol, ai_direction, ai_score, ai_entry, ai_take_profit, ai_stop_loss, created_at
        FROM signals WHERE outcome = 'OPEN' AND ai_recommendation = 'RECOMMENDED'
        ORDER BY created_at DESC LIMIT 10
      `).all();
      const rows = result.results || [];
      if (!rows.length) {
        await sendTelegramTo(env, chatId, "Keine offenen empfohlenen Trades.");
        return;
      }
      const lines = ["\uD83D\uDCCB Offene Trades (empfohlen)\n"];
      for (const r of rows) {
        const ago = Math.floor((Date.now() - r.created_at) / 60000);
        lines.push(`${r.ai_direction === 'LONG' ? '🟢' : '🔴'} ${r.symbol} (${r.ai_direction})`);
        lines.push(`Score: ${r.ai_score} | Entry: ${Number(r.ai_entry).toFixed(2)}`);
        lines.push(`TP: ${Number(r.ai_take_profit).toFixed(2)} | SL: ${Number(r.ai_stop_loss).toFixed(2)}`);
        lines.push(`vor ${ago}min\n`);
      }
      await sendTelegramTo(env, chatId, lines.join("\n"));
    } catch(e) {
      await sendTelegramTo(env, chatId, "Fehler: " + e.message);
    }
    return;
  }

  // ── /top ──
  if (text === "/top") {
    try {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const result = await env.DB.prepare(`
        SELECT symbol, ai_direction, ai_score, ai_risk, ai_recommendation, created_at
        FROM signals WHERE created_at > ? AND ai_recommendation = 'RECOMMENDED'
        ORDER BY ai_score DESC LIMIT 5
      `).bind(since).all();
      const rows = result.results || [];
      if (!rows.length) {
        await sendTelegramTo(env, chatId, "Heute noch keine empfohlenen Signale.");
        return;
      }
      const lines = ["\uD83C\uDFC6 Top Signale (letzte 24h)\n"];
      for (const r of rows) {
        lines.push(`${r.ai_direction === 'LONG' ? '🟢' : '🔴'} ${r.symbol} — Score ${r.ai_score}/100`);
        lines.push(`Risiko: ${r.ai_risk}\n`);
      }
      await sendTelegramTo(env, chatId, lines.join("\n"));
    } catch(e) {
      await sendTelegramTo(env, chatId, "Fehler: " + e.message);
    }
    return;
  }

  // ── /btc /eth /sol — Shortcuts ──
  const shortcuts = {
    "/btc": "BTCUSDT",
    "/eth": "ETHUSDT",
    "/sol": "SOLUSDT",
    "/bnb": "BNBUSDT",
    "/render": "RENDERUSDT",
    "/virtual": "VIRTUALUSDT",
  };

  let symbol = null;

  if (shortcuts[text]) {
    symbol = shortcuts[text];
  } else if (text.startsWith("/check ")) {
    symbol = text.replace("/check ", "").toUpperCase().trim();
  }

  if (symbol) {
    await sendTelegramTo(env, chatId, `⏳ Analysiere ${symbol}...`);

    const snapshot = await getSnapshot(env, symbol, "5");
    if (!snapshot) {
      await sendTelegramTo(env, chatId, `❌ Kein Snapshot für ${symbol} gefunden.

Stelle sicher dass TradingView Daten sendet.`);
      return;
    }

    const snap1h = await getSnapshot(env, symbol, "1H");
    const snap4h = await getSnapshot(env, symbol, "4H");
    const ruleScore = calculateRuleScore(snapshot, snap1h, snap4h);
    const ai = await analyzeWithClaude(env, snapshot, ruleScore, snap1h, snap4h);

    const finalScore = clamp(Math.round((Number(ai.score || 0) * 0.75) + (ruleScore.score * 0.25)));
    ai.score = finalScore;
    const priority = getPriority(ai.score, ai.recommendation, ai.risk);

    const tp = ai.take_profit ? Number(ai.take_profit).toFixed(2) : "–";
    const sl = ai.stop_loss   ? Number(ai.stop_loss).toFixed(2)   : "–";
    const entry = ai.entry    ? Number(ai.entry).toFixed(2)        : "–";

    let rr = "";
    if (ai.entry && ai.take_profit && ai.stop_loss) {
      const reward = Math.abs(ai.take_profit - ai.entry);
      const risk   = Math.abs(ai.entry - ai.stop_loss);
      if (risk > 0) rr = `
R/R: 1:${(reward / risk).toFixed(2)}`;
    }

    const mtfLine = snap4h
      ? `\n4H: ${Number(snap4h.price) > Number(snap4h.ema200) ? '🟢 LONG-BIAS' : '🔴 SHORT-BIAS'} | Trend: ${snap4h.trend}`
      : "\n4H: kein Snapshot";
    const mtf1h = snap1h
      ? `\n1H: Trend ${snap1h.trend} | RSI ${Number(snap1h.rsi).toFixed(0)}`
      : "\n1H: kein Snapshot";

    const reply = `${priority}

📊 ${snapshot.name || symbol} (5min)
💰 Preis: ${snapshot.price}
${mtfLine}${mtf1h}

🧮 Regel-Score: ${ruleScore.score}/100
${ruleScore.reason}

🧠 Claude: ${ai.recommendation}
Richtung: ${ai.direction} | Score: ${ai.score}/100
Risiko: ${ai.risk} | Confidence: ${ai.confidence}%

🎯 Plan
Entry: ${entry} | TP: ${tp} | SL: ${sl}${rr}

📝 ${ai.reason}

⚠️ Keine Finanzberatung.`;

    await sendTelegramTo(env, chatId, reply);
    return;
  }

  // Unbekannter Command
  if (text.startsWith("/")) {
    await sendTelegramTo(env, chatId,
      "Unbekannter Befehl. Tippe /hilfe fuer alle Kommandos.");
  }
}

async function sendTelegramTo(env, chatId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────

function dashboardHtml() {
  const SVG_LOGO = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#2563eb"/><stop offset="100%" style="stop-color:#60a5fa"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width="100" height="100" rx="22" fill="#050e1f"/><g filter="url(#glow)" stroke="url(#g1)" stroke-width="3.5" fill="none" stroke-linecap="round"><path d="M50 58 L50 78"/><rect x="38" y="78" width="24" height="7" rx="3"/><circle cx="50" cy="54" r="5" fill="url(#g1)" stroke="none"/><path d="M35 44 Q27 36 27 26"/><path d="M65 44 Q73 36 73 26"/><path d="M40 49 Q34 42 34 33"/><path d="M60 49 Q66 42 66 33"/><path d="M45 53 Q41 48 41 41"/><path d="M55 53 Q59 48 59 41"/></g></svg>`;
  const LOGO_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(SVG_LOGO);

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>WAVESCOUT</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #030a18;
      --bg2: #050e1f;
      --surface: #091528;
      --surface2: #0d1e38;
      --surface3: #112348;
      --border: #1a3158;
      --border2: #1e3d6e;
      --blue: #2563eb;
      --blue2: #3b82f6;
      --blue3: #60a5fa;
      --blue-dim: rgba(37,99,235,0.12);
      --blue-glow: rgba(37,99,235,0.3);
      --white: #f0f6ff;
      --white2: rgba(240,246,255,0.7);
      --white3: rgba(240,246,255,0.35);
      --white4: rgba(240,246,255,0.12);
      --green: #10b981;
      --red: #ef4444;
      --yellow: #f59e0b;
      --text: #e2efff;
      --text2: #7da8d4;
      --text3: #3d6a96;
      --font: 'Inter', sans-serif;
      --mono: 'JetBrains Mono', monospace;
      --r: 10px;
      --sidebar: 210px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html { height: 100%; }
    body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; display: flex; }

    /* ── LOGIN ── */
    .login-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: var(--bg);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 24px;
    }
    .login-overlay.gone { display: none; }
    .login-logo-wrap { margin-bottom: 16px; }
    .login-logo-svg { width: 72px; height: 72px; }
    .login-brand { font-size: 1.5rem; font-weight: 700; color: var(--white); letter-spacing: 0.04em; margin-bottom: 4px; text-align: center; }
    .login-tagline { font-size: 0.72rem; color: var(--text3); margin-bottom: 32px; text-align: center; letter-spacing: 0.06em; text-transform: uppercase; }
    .login-box {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 16px; padding: 28px 24px; width: 100%; max-width: 340px;
    }
    .login-label { font-size: 0.75rem; font-weight: 600; color: var(--text2); margin-bottom: 14px; }
    .user-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-bottom: 20px; }
    .u-btn {
      background: var(--surface2); border: 2px solid var(--border);
      border-radius: 10px; padding: 14px 8px; cursor: pointer;
      text-align: center; transition: all 0.15s; font-family: var(--font);
    }
    .u-btn:hover { border-color: var(--blue2); }
    .u-btn.sel { border-color: var(--blue2); background: var(--blue-dim); }
    .u-av { width: 38px; height: 38px; border-radius: 50%; margin: 0 auto 8px; display: flex; align-items: center; justify-content: center; font-size: 1rem; font-weight: 700; color: var(--white); }
    .av-m { background: linear-gradient(135deg, #2563eb, #1d4ed8); }
    .av-s { background: linear-gradient(135deg, #0ea5e9, #2563eb); }
    .av-i { background: linear-gradient(135deg, #10b981, #0ea5e9); }
    .u-name { font-size: 0.76rem; font-weight: 600; color: var(--text); }
    .pw-wrap { display: none; margin-bottom: 16px; }
    .pw-wrap.show { display: block; }
    .pw-lbl { font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; color: var(--text3); margin-bottom: 7px; }
    .pw-in {
      width: 100%; background: var(--surface2); border: 1px solid var(--border);
      color: var(--text); font-family: var(--mono); font-size: 0.9rem;
      padding: 10px 14px; border-radius: 8px; outline: none; transition: border-color 0.15s;
    }
    .pw-in:focus { border-color: var(--blue2); }
    .pw-hint { font-size: 0.62rem; color: var(--text3); margin-top: 5px; }
    .login-go {
      width: 100%; background: var(--blue); color: var(--white);
      border: none; border-radius: 8px; padding: 11px;
      font-family: var(--font); font-size: 0.88rem; font-weight: 600;
      cursor: pointer; transition: background 0.15s; letter-spacing: 0.02em;
    }
    .login-go:hover { background: var(--blue2); }
    .login-err { font-size: 0.7rem; color: var(--red); text-align: center; margin-top: 10px; min-height: 16px; }
    .login-foot { margin-top: 28px; text-align: center; }
    .login-foot p { font-size: 0.65rem; color: var(--text3); line-height: 2; }
    .login-foot strong { color: var(--blue3); font-weight: 600; }

    /* ── SIDEBAR ── */
    .sidebar {
      width: var(--sidebar); flex-shrink: 0;
      background: var(--bg2); border-right: 1px solid var(--border);
      display: flex; flex-direction: column;
      position: fixed; inset: 0 auto 0 0; z-index: 50;
    }
    .sb-top {
      padding: 16px 14px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 10px;
    }
    .sb-logo { width: 32px; height: 32px; flex-shrink: 0; }
    .sb-brand { font-size: 0.95rem; font-weight: 700; color: var(--white); letter-spacing: 0.02em; }
    .sb-sub { font-size: 0.56rem; color: var(--text3); text-transform: uppercase; letter-spacing: 0.08em; }
    .sb-nav { padding: 10px 8px; flex: 1; display: flex; flex-direction: column; gap: 1px; overflow-y: auto; }
    .nav-btn {
      display: flex; align-items: center; gap: 9px;
      padding: 9px 10px; border-radius: 7px; cursor: pointer;
      font-size: 0.79rem; font-weight: 500; color: var(--text2);
      border: none; background: none; width: 100%; text-align: left;
      transition: background 0.1s, color 0.1s; font-family: var(--font);
    }
    .nav-btn:hover { background: var(--surface); color: var(--text); }
    .nav-btn.on { background: var(--blue-dim); color: var(--blue3); font-weight: 600; }
    .nav-ic { font-size: 0.95rem; width: 20px; text-align: center; flex-shrink: 0; }
    .sb-bot { padding: 10px 8px; border-top: 1px solid var(--border); }
    .sb-user { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 7px; cursor: pointer; }
    .sb-user:hover { background: var(--surface); }
    .sb-av { width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700; color: var(--white); flex-shrink: 0; }
    .sb-uname { font-size: 0.76rem; font-weight: 600; color: var(--text); }
    .sb-live { font-size: 0.58rem; color: var(--green); display: flex; align-items: center; gap: 3px; }
    .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--green); animation: blink 2s infinite; display: inline-block; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .sb-logout { margin-left: auto; font-size: 0.6rem; color: var(--text3); background: none; border: none; cursor: pointer; padding: 3px 6px; border-radius: 4px; font-family: var(--font); }
    .sb-logout:hover { color: var(--red); }

    /* ── MAIN ── */
    .main { margin-left: var(--sidebar); flex: 1; min-width: 0; }
    .topbar {
      position: sticky; top: 0; z-index: 40;
      background: rgba(3,10,24,0.95); backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 0 24px; height: 52px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .tb-title { font-size: 0.95rem; font-weight: 600; color: var(--white); }
    .tb-right { display: flex; align-items: center; gap: 12px; }
    .tb-time { font-family: var(--mono); font-size: 0.68rem; color: var(--text3); }
    .tb-live { display: flex; align-items: center; gap: 5px; font-size: 0.65rem; color: var(--green); font-weight: 600; }

    /* ── PAGES ── */
    .page { display: none; padding: 22px; }
    .page.on { display: block; }

    /* ── HOME ── */
    .greeting { margin-bottom: 20px; }
    .g-day { font-size: 0.72rem; color: var(--text3); margin-bottom: 3px; letter-spacing: 0.04em; }
    .g-title { font-size: 1.4rem; font-weight: 700; color: var(--white); }
    .g-title span { color: var(--blue3); }
    .kpi-grid { display: grid; grid-template-columns: repeat(2,1fr); gap: 10px; margin-bottom: 18px; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 16px; position: relative; overflow: hidden; }
    .kpi::after { content:''; position:absolute; top:0; left:0; right:0; height:2px; }
    .kpi.c-blue::after { background: var(--blue2); }
    .kpi.c-green::after { background: var(--green); }
    .kpi.c-red::after { background: var(--red); }
    .kpi.c-white::after { background: var(--white3); }
    .kpi-lbl { font-size: 0.6rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text3); margin-bottom: 8px; }
    .kpi-val { font-size: 1.75rem; font-weight: 700; font-family: var(--mono); line-height: 1; }
    .kpi-val.c-blue { color: var(--blue3); }
    .kpi-val.c-green { color: var(--green); }
    .kpi-val.c-red { color: var(--red); }
    .kpi-val.c-white { color: var(--white); }
    .kpi-sub { font-size: 0.6rem; color: var(--text3); margin-top: 4px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; margin-bottom: 12px; }
    .card-hdr { padding: 13px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .card-title { font-size: 0.8rem; font-weight: 600; color: var(--white); }
    .card-body { padding: 14px 16px; }
    .q-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .q-btn { background: var(--surface2); border: 1px solid var(--border); border-radius: 9px; padding: 12px; cursor: pointer; display: flex; align-items: center; gap: 9px; transition: border-color 0.12s; font-family: var(--font); }
    .q-btn:hover { border-color: var(--blue); }
    .q-btn:active { background: var(--surface3); }
    .q-ic { font-size: 1.15rem; flex-shrink: 0; }
    .q-lbl { font-size: 0.76rem; font-weight: 600; color: var(--white); }
    .q-sub { font-size: 0.6rem; color: var(--text3); margin-top: 1px; }
    .mini-sig { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--border); }
    .mini-sig:last-child { border-bottom: none; padding-bottom: 0; }
    .ms-l { display: flex; align-items: center; gap: 9px; }
    .ms-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .ms-sym { font-size: 0.8rem; font-weight: 700; color: var(--white); }
    .ms-trig { font-size: 0.6rem; color: var(--text3); font-family: var(--mono); }
    .ms-score { font-family: var(--mono); font-size: 0.76rem; font-weight: 700; }
    .ms-t { font-size: 0.58rem; color: var(--text3); }
    .wb-link {
      display: flex; align-items: center; gap: 12px;
      background: linear-gradient(135deg, rgba(37,99,235,0.15), rgba(96,165,250,0.08));
      border: 1px solid rgba(37,99,235,0.3); border-radius: var(--r);
      padding: 16px; text-decoration: none; color: inherit;
      transition: border-color 0.15s, transform 0.1s; margin-bottom: 12px;
    }
    .wb-link:hover { border-color: var(--blue2); transform: translateY(-1px); }
    .wb-ic { font-size: 1.8rem; flex-shrink: 0; }
    .wb-title { font-size: 0.9rem; font-weight: 700; color: var(--white); }
    .wb-sub { font-size: 0.63rem; color: var(--text3); margin-top: 2px; }
    .wb-arr { margin-left: auto; background: var(--blue-dim); color: var(--blue3); font-size: 0.6rem; font-weight: 700; padding: 5px 9px; border-radius: 6px; flex-shrink: 0; white-space: nowrap; }

    /* ── FILTERS ── */
    .filter-row { display: flex; gap: 7px; margin-bottom: 12px; flex-wrap: wrap; }
    .f-sel { background: var(--surface2); border: 1px solid var(--border); color: var(--text); font-family: var(--font); font-size: 0.72rem; padding: 7px 9px; border-radius: 7px; cursor: pointer; flex: 1; min-width: 90px; }
    .f-sel:focus { outline: none; border-color: var(--blue2); }
    .sort-btn { background: var(--surface2); border: 1px solid var(--border); color: var(--text2); font-family: var(--font); font-size: 0.68rem; padding: 7px 11px; border-radius: 7px; cursor: pointer; white-space: nowrap; transition: all 0.12s; }
    .sort-btn.on { border-color: var(--blue2); color: var(--blue3); }

    /* ── SIGNAL CARDS ── */
    .sig-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 14px 15px; margin-bottom: 7px; transition: border-color 0.12s; }
    .sig-card:hover { border-color: var(--border2); }
    .sig-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .sig-sym { font-weight: 700; font-size: 0.88rem; color: var(--white); }
    .sig-time { font-family: var(--mono); font-size: 0.58rem; color: var(--text3); }
    .sig-mid { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .sig-tr { font-family: var(--mono); font-size: 0.62rem; color: var(--text3); }
    .sig-sc { font-family: var(--mono); font-size: 0.76rem; font-weight: 700; }
    .sig-px { font-family: var(--mono); font-size: 0.62rem; color: var(--text3); display: flex; gap: 10px; margin-bottom: 8px; }
    .bar-bg { height: 2px; background: var(--surface3); border-radius: 2px; margin-bottom: 10px; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 2px; }
    .sig-foot { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 7px; }
    .badges { display: flex; gap: 4px; flex-wrap: wrap; }
    .badge { font-size: 0.58rem; font-weight: 600; padding: 2px 6px; border-radius: 4px; }
    .bw { background: rgba(16,185,129,0.12); color: var(--green); border: 1px solid rgba(16,185,129,0.2); }
    .bo { background: rgba(37,99,235,0.1); color: var(--blue3); border: 1px solid rgba(37,99,235,0.2); }
    .bl { background: rgba(239,68,68,0.12); color: var(--red); border: 1px solid rgba(239,68,68,0.2); }
    .bs { background: rgba(61,106,150,0.15); color: var(--text3); border: 1px solid var(--border); }
    .brec { background: rgba(16,185,129,0.1); color: var(--green); }
    .bnrec { background: rgba(239,68,68,0.1); color: var(--red); }
    .blo { background: rgba(16,185,129,0.1); color: var(--green); }
    .bme { background: rgba(245,158,11,0.1); color: var(--yellow); }
    .bhi { background: rgba(239,68,68,0.1); color: var(--red); }

    /* ── RESULT ── */
    .res-wrap { margin: 4px 0 6px; }
    .res-card { background: var(--surface2); border: 1px solid var(--border2); border-radius: var(--r); overflow: hidden; animation: si 0.2s ease; }
    @keyframes si { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:none} }
    .res-hdr { padding: 11px 15px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border); }
    .res-badge { font-size: 0.68rem; font-weight: 700; padding: 4px 10px; border-radius: 5px; }
    .res-badge.rec { background: rgba(16,185,129,0.15); color: var(--green); }
    .res-badge.norec { background: rgba(239,68,68,0.15); color: var(--red); }
    .res-body { padding: 13px 15px; display: flex; flex-direction: column; gap: 9px; }
    .res-row { display: flex; justify-content: space-between; }
    .res-k { font-size: 0.6rem; color: var(--text3); text-transform: uppercase; letter-spacing: 0.07em; }
    .res-v { font-family: var(--mono); font-size: 0.74rem; }
    .res-plan { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 7px; }
    .plan-c { background: var(--surface3); border-radius: 7px; padding: 9px; text-align: center; }
    .plan-l { font-size: 0.55rem; color: var(--text3); text-transform: uppercase; letter-spacing: 0.06em; }
    .plan-v { font-family: var(--mono); font-size: 0.76rem; font-weight: 700; margin-top: 3px; }
    .res-reason { font-size: 0.72rem; color: var(--text2); line-height: 1.6; padding-top: 9px; border-top: 1px solid var(--border); }

    /* ── BACKTESTING ── */
    .bt-tabs { display: flex; gap: 6px; margin-bottom: 14px; }
    .bt-tab { background: var(--surface2); border: 1px solid var(--border); color: var(--text2); font-family: var(--font); font-size: 0.7rem; font-weight: 600; padding: 7px 16px; border-radius: 7px; cursor: pointer; transition: all 0.12s; }
    .bt-tab.on { border-color: var(--blue2); color: var(--blue3); background: var(--blue-dim); }
    .bt-kpis { display: grid; grid-template-columns: repeat(3,1fr); gap: 9px; margin-bottom: 14px; }
    .bt-k { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 13px; text-align: center; }
    .bt-kv { font-family: var(--mono); font-size: 1.35rem; font-weight: 700; line-height: 1; }
    .bt-kl { font-size: 0.58rem; color: var(--text3); margin-top: 5px; text-transform: uppercase; letter-spacing: 0.07em; }
    .score-cmp { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 15px; margin-bottom: 12px; }
    .sc-title { font-size: 0.76rem; font-weight: 600; color: var(--white); margin-bottom: 13px; }
    .sc-row { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }
    .sc-row:last-child { margin-bottom: 0; }
    .sc-lbl { font-size: 0.7rem; font-weight: 600; width: 55px; flex-shrink: 0; }
    .sc-bar { flex: 1; height: 7px; background: var(--surface3); border-radius: 3px; overflow: hidden; }
    .sc-fill { height: 100%; border-radius: 3px; transition: width 0.7s ease; }
    .sc-val { font-family: var(--mono); font-size: 0.7rem; font-weight: 700; width: 35px; text-align: right; flex-shrink: 0; }
    .sym-tbl { width: 100%; border-collapse: collapse; font-size: 0.74rem; }
    .sym-tbl th { text-align: left; padding: 8px 10px; font-size: 0.6rem; color: var(--text3); text-transform: uppercase; letter-spacing: 0.07em; border-bottom: 1px solid var(--border); font-weight: 600; }
    .sym-tbl td { padding: 8px 10px; border-bottom: 1px solid var(--border); }
    .sym-tbl tr:last-child td { border-bottom: none; }
    .bt-sig { display: flex; align-items: center; justify-content: space-between; padding: 9px 0; border-bottom: 1px solid var(--border); }
    .bt-sig:last-child { border-bottom: none; padding-bottom: 0; }
    .bt-s-sym { font-size: 0.8rem; font-weight: 700; color: var(--white); }
    .bt-s-dir { font-size: 0.6rem; color: var(--text3); font-family: var(--mono); }
    .bt-s-sc { font-family: var(--mono); font-size: 0.88rem; font-weight: 700; }

    /* ── STRATEGIE ── */
    .str-sec { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); margin-bottom: 10px; overflow: hidden; }
    .str-hdr { padding: 13px 15px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 9px; }
    .str-ic { font-size: 1.1rem; }
    .str-title { font-size: 0.85rem; font-weight: 600; color: var(--white); }
    .str-body { padding: 13px 15px; }
    .str-step { display: flex; gap: 11px; margin-bottom: 13px; }
    .str-step:last-child { margin-bottom: 0; }
    .str-num { width: 22px; height: 22px; border-radius: 50%; background: var(--blue-dim); border: 1px solid rgba(37,99,235,0.3); color: var(--blue3); font-size: 0.65rem; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
    .str-stitle { font-size: 0.8rem; font-weight: 600; color: var(--white); margin-bottom: 3px; }
    .str-text { font-size: 0.75rem; line-height: 1.6; color: var(--text2); }
    .str-rule { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .str-rule:last-child { border-bottom: none; }
    .str-ric { width: 18px; flex-shrink: 0; font-size: 0.82rem; }
    .str-rt { font-size: 0.74rem; color: var(--text2); line-height: 1.5; }
    .str-rt strong { color: var(--white); font-weight: 600; }
    .no-trd { display: flex; flex-direction: column; gap: 6px; }
    .no-trd-item { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: rgba(239,68,68,0.05); border: 1px solid rgba(239,68,68,0.1); border-radius: 7px; font-size: 0.73rem; color: var(--text2); }

    /* ── TOOLS ── */
    .t-sec { margin-bottom: 13px; }
    .t-sec-title { font-size: 0.6rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text3); margin-bottom: 7px; padding: 0 3px; }
    .t-list { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; }
    .t-row { display: flex; align-items: center; padding: 12px 15px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.1s; text-decoration: none; color: inherit; }
    .t-row:last-child { border-bottom: none; }
    .t-row:hover { background: var(--surface2); }
    .t-ic { font-size: 1.05rem; width: 26px; flex-shrink: 0; }
    .t-txt { flex: 1; }
    .t-lbl { font-size: 0.78rem; font-weight: 600; color: var(--white); }
    .t-desc { font-size: 0.62rem; color: var(--text3); margin-top: 1px; }
    .t-arr { color: var(--text3); font-size: 0.78rem; }

    /* ── TELEGRAM ── */
    .cmd-list { display: flex; flex-direction: column; gap: 5px; }
    .cmd-row { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 11px 13px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background 0.1s; }
    .cmd-row:hover { background: var(--surface2); }
    .cmd-code { font-family: var(--mono); font-size: 0.78rem; color: var(--blue3); font-weight: 600; }
    .cmd-desc { font-size: 0.62rem; color: var(--text3); margin-top: 2px; }

    /* ── BUTTONS ── */
    .btn { font-family: var(--font); font-weight: 600; font-size: 0.73rem; border: none; border-radius: 7px; padding: 7px 13px; cursor: pointer; transition: opacity 0.12s, transform 0.1s; display: inline-flex; align-items: center; gap: 5px; }
    .btn:active { transform: scale(0.96); }
    .btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }
    .btn-p { background: var(--blue); color: var(--white); }
    .btn-p:hover { background: var(--blue2); }
    .btn-g { background: var(--surface2); border: 1px solid var(--border); color: var(--text2); font-size: 0.68rem; padding: 6px 11px; }
    .btn-g:hover { border-color: var(--border2); color: var(--text); }
    .btn-win { background: rgba(16,185,129,0.1); color: var(--green); border: 1px solid rgba(16,185,129,0.25); font-size: 0.63rem; padding: 4px 8px; }
    .btn-loss { background: rgba(239,68,68,0.1); color: var(--red); border: 1px solid rgba(239,68,68,0.25); font-size: 0.63rem; padding: 4px 8px; }
    .btn-skip { background: rgba(61,106,150,0.1); color: var(--text3); border: 1px solid var(--border); font-size: 0.63rem; padding: 4px 8px; }

    /* ── EMPTY / TOAST ── */
    .empty { text-align: center; padding: 28px; color: var(--text3); font-size: 0.78rem; line-height: 1.7; }
    .toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: var(--surface2); border: 1px solid var(--border2); color: var(--text); font-size: 0.74rem; padding: 9px 18px; border-radius: 18px; z-index: 9999; pointer-events: none; opacity: 0; transition: opacity 0.2s; white-space: nowrap; max-width: 90vw; }
    .toast.show { opacity: 1; }

    /* ── MOBILE ── */
    @media(max-width:640px) {
      :root { --sidebar: 0px; }
      .sidebar { display: none; }
      .main { margin-left: 0; }
      .page { padding: 14px; }
      .topbar { padding: 0 14px; }
      .tb-time { display: none; }
      .bnav { display: flex !important; }
      body { padding-bottom: 64px; }
    }
    .bnav { display: none; position: fixed; bottom: 0; left: 0; right: 0; z-index: 50; background: var(--bg2); border-top: 1px solid var(--border); padding: 5px 0 max(5px, env(safe-area-inset-bottom)); }
    .bn { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; cursor: pointer; padding: 4px 0; font-size: 0.54rem; font-weight: 600; color: var(--text3); transition: color 0.12s; border: none; background: none; font-family: var(--font); }
    .bn.on { color: var(--blue3); }
    .bn-ic { font-size: 1.1rem; }
  </style>
</head>
<body>

<!-- LOGIN -->
<div class="login-overlay" id="lo">
  <div class="login-logo-wrap">
    <img src="${LOGO_URL}" class="login-logo-svg" alt="WaveScout">
  </div>
  <div class="login-brand">WAVESCOUT</div>
  <div class="login-tagline">Signal Intelligence</div>
  <div class="login-box">
    <div class="login-label">Wer bist du?</div>
    <div class="user-row">
      <div class="u-btn" onclick="selectUser('Marvin',this)">
        <div class="u-av av-m">M</div><div class="u-name">Marvin</div>
      </div>
      <div class="u-btn" onclick="selectUser('Sandro',this)">
        <div class="u-av av-s">S</div><div class="u-name">Sandro</div>
      </div>
      <div class="u-btn" onclick="selectUser('Iven',this)">
        <div class="u-av av-i">I</div><div class="u-name">Iven</div>
      </div>
    </div>
    <div class="pw-wrap" id="pw-wrap">
      <div class="pw-lbl">Passwort</div>
      <input type="password" class="pw-in" id="pw-in" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()">
      <div class="pw-hint" id="pw-hint"></div>
    </div>
    <button class="login-go" id="login-go" style="display:none" onclick="doLogin()">Anmelden</button>
    <div class="login-err" id="login-err"></div>
  </div>
  <div class="login-foot">
    <p>Made by <strong>WaveWatch</strong></p>
    <p>Made for Trader</p>
  </div>
</div>

<!-- SIDEBAR -->
<div class="sidebar">
  <div class="sb-top">
    <img src="${LOGO_URL}" class="sb-logo" alt="logo">
    <div><div class="sb-brand">WaveScout</div><div class="sb-sub">Signal Intelligence</div></div>
  </div>
  <nav class="sb-nav">
    <button class="nav-btn on" onclick="go('home')"><span class="nav-ic">🏠</span>Dashboard</button>
    <button class="nav-btn" onclick="go('analyse')"><span class="nav-ic">🔍</span>Analyse</button>
    <button class="nav-btn" onclick="go('signals')"><span class="nav-ic">📋</span>Signale</button>
    <button class="nav-btn" onclick="go('backtesting')"><span class="nav-ic">📊</span>Backtesting</button>
    <button class="nav-btn" onclick="go('strategie')"><span class="nav-ic">📖</span>Strategie</button>
    <button class="nav-btn" onclick="go('tools')"><span class="nav-ic">🔧</span>Tools</button>
    <button class="nav-btn" onclick="go('telegram')"><span class="nav-ic">💬</span>Telegram</button>
  </nav>
  <div class="sb-bot">
    <div class="sb-user">
      <div class="sb-av" id="sb-av" style="background:linear-gradient(135deg,#2563eb,#1d4ed8)">M</div>
      <div><div class="sb-uname" id="sb-name">Marvin</div><div class="sb-live"><span class="dot"></span>Live</div></div>
      <button class="sb-logout" onclick="logout()">Abmelden</button>
    </div>
  </div>
</div>

<!-- MAIN -->
<div class="main">
  <div class="topbar">
    <div class="tb-title" id="tb-title">Dashboard</div>
    <div class="tb-right">
      <div class="tb-time" id="clk">–</div>
      <div class="tb-live"><span class="dot"></span>Live</div>
    </div>
  </div>

  <!-- HOME -->
  <div class="page on" id="page-home">
    <div class="greeting">
      <div class="g-day" id="g-day">–</div>
      <div class="g-title" id="g-title">Guten Morgen, <span>Trader</span> 👋</div>
    </div>
    <div class="kpi-grid">
      <div class="kpi c-blue"><div class="kpi-lbl">Offene Signale</div><div class="kpi-val c-blue" id="kpi-open">–</div><div class="kpi-sub">aktive Trades</div></div>
      <div class="kpi c-green"><div class="kpi-lbl">Wins</div><div class="kpi-val c-green" id="kpi-wins">–</div><div class="kpi-sub">gesamt</div></div>
      <div class="kpi c-red"><div class="kpi-lbl">Losses</div><div class="kpi-val c-red" id="kpi-losses">–</div><div class="kpi-sub">gesamt</div></div>
      <div class="kpi c-white"><div class="kpi-lbl">Winrate</div><div class="kpi-val c-white" id="kpi-wr">–</div><div class="kpi-sub">Trefferquote</div></div>
    </div>
    <div class="card">
      <div class="card-hdr"><div class="card-title">Schnell-Aktionen</div></div>
      <div class="card-body">
        <div class="q-grid">
          <div class="q-btn" onclick="go('analyse')"><div class="q-ic">🔍</div><div><div class="q-lbl">Analyse</div><div class="q-sub">Symbol prüfen</div></div></div>
          <div class="q-btn" onclick="toolAct('morning')"><div class="q-ic">🌅</div><div><div class="q-lbl">Morning Brief</div><div class="q-sub">Jetzt senden</div></div></div>
          <div class="q-btn" onclick="toolAct('outcomes')"><div class="q-ic">🔄</div><div><div class="q-lbl">Outcomes</div><div class="q-sub">WIN/LOSS prüfen</div></div></div>
          <div class="q-btn" onclick="go('backtesting')"><div class="q-ic">📊</div><div><div class="q-lbl">Backtesting</div><div class="q-sub">Auswertung</div></div></div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-hdr"><div class="card-title">Letzte Signale</div><button class="btn btn-g" onclick="go('signals')">Alle →</button></div>
      <div class="card-body" id="home-sigs"><div class="empty">Lade...</div></div>
    </div>
    <a class="wb-link" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank">
      <div class="wb-ic">🌊</div>
      <div><div class="wb-title">WaveBoard</div><div class="wb-sub">Externes Trading Dashboard</div></div>
      <div class="wb-arr">↗ Öffnen</div>
    </a>
  </div>

  <!-- ANALYSE -->
  <div class="page" id="page-analyse">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:13px">
      <div style="font-size:0.6rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em">Snapshots</div>
      <button class="btn btn-g" onclick="loadSnaps()">↻</button>
    </div>
    <div id="snap-list"><div class="empty">Lade...</div></div>
  </div>

  <!-- SIGNALE -->
  <div class="page" id="page-signals">
    <div class="filter-row">
      <select class="f-sel" id="f-sym" onchange="applyF()"><option value="">Alle Symbole</option></select>
      <select class="f-sel" id="f-out" onchange="applyF()" style="flex:0.75">
        <option value="">Alle</option>
        <option value="OPEN">Open</option>
        <option value="WIN">Win</option>
        <option value="LOSS">Loss</option>
        <option value="SKIPPED">Skipped</option>
      </select>
      <button class="sort-btn on" id="srt-sc" onclick="setSort('score')">Score ↓</button>
      <button class="sort-btn" id="srt-tm" onclick="setSort('time')">Zeit</button>
    </div>
    <div id="sig-list"><div class="empty">Lade...</div></div>
  </div>

  <!-- BACKTESTING -->
  <div class="page" id="page-backtesting">
    <div class="bt-tabs">
      <button class="bt-tab on" onclick="btTab('all',this)">Gesamt</button>
      <button class="bt-tab" onclick="btTab('month',this)">30 Tage</button>
      <button class="bt-tab" onclick="btTab('week',this)">7 Tage</button>
    </div>
    <div id="bt-body"><div class="empty">Lade...</div></div>
  </div>

  <!-- STRATEGIE -->
  <div class="page" id="page-strategie">
    <div class="str-sec">
      <div class="str-hdr"><div class="str-ic">🎯</div><div class="str-title">Top-Down Daytrading — Überblick</div></div>
      <div class="str-body">
        <div class="str-step"><div class="str-num">1</div><div><div class="str-stitle">Morgen-Routine (10 Min)</div><div class="str-text">4H Chart öffnen → EMA200 prüfen. Preis darüber = Long-Bias, darunter = Short-Bias. EMA flach = kein Trade heute. 1–2 Key-Zonen auf 15min markieren.</div></div></div>
        <div class="str-step"><div class="str-num">2</div><div><div class="str-stitle">Zonenanalyse (15min)</div><div class="str-text">Warten bis Preis eine markierte Zone erreicht. Higher Low (Long) oder Lower High (Short) sichtbar. Kein Chaos, kein Seitwärtsmarkt.</div></div></div>
        <div class="str-step"><div class="str-num">3</div><div><div class="str-stitle">Entry (5–10min)</div><div class="str-text">Klare Trendkerze, starker Body, wenig Docht. Bruch von lokalem High (Long) oder Low (Short) abwarten. RSI als Filter — kein Signal allein.</div></div></div>
      </div>
    </div>
    <div class="str-sec">
      <div class="str-hdr"><div class="str-ic">📏</div><div class="str-title">Entry-Regeln</div></div>
      <div class="str-body">
        <div class="str-rule"><div class="str-ric">✅</div><div class="str-rt"><strong>RSI Long:</strong> 30–55 steigend. <strong>Short:</strong> 45–70 fallend. Kein Entry bei RSI über 70 oder unter 30.</div></div>
        <div class="str-rule"><div class="str-ric">✅</div><div class="str-rt"><strong>EMA200 (4H):</strong> Preis darüber = nur Long. Darunter = nur Short.</div></div>
        <div class="str-rule"><div class="str-ric">✅</div><div class="str-rt"><strong>Trendstruktur:</strong> EMA50 über EMA200 (Long) oder darunter (Short). Neutral = kein Trade.</div></div>
        <div class="str-rule"><div class="str-ric">✅</div><div class="str-rt"><strong>Zone:</strong> Long nah an Support. Short nah an Resistance.</div></div>
        <div class="str-rule"><div class="str-ric">✅</div><div class="str-rt"><strong>R/R:</strong> Mindestens 1:1.5. SL logisch unter/über Struktur.</div></div>
      </div>
    </div>
    <div class="str-sec">
      <div class="str-hdr"><div class="str-ic">🚫</div><div class="str-title">Kein Trade — Ausschluss</div></div>
      <div class="str-body">
        <div class="no-trd">
          <div class="no-trd-item">❌ Trade läuft gegen Tages-Bias</div>
          <div class="no-trd-item">❌ EMA200 auf 4H flach oder Preis direkt dran</div>
          <div class="no-trd-item">❌ Viele Wicks, Chaos, kein klares Bild</div>
          <div class="no-trd-item">❌ FOMO — man will unbedingt rein</div>
          <div class="no-trd-item">❌ RSI extrem (über 70 oder unter 30)</div>
        </div>
      </div>
    </div>
    <div class="str-sec">
      <div class="str-hdr"><div class="str-ic">✔️</div><div class="str-title">Final Check — alle 3 mit Ja?</div></div>
      <div class="str-body">
        <div class="str-rule"><div class="str-ric">☑️</div><div class="str-rt">Passt der Trade zum Tages-Bias?</div></div>
        <div class="str-rule"><div class="str-ric">☑️</div><div class="str-rt">Könnte ich diesen Trade erklären?</div></div>
        <div class="str-rule"><div class="str-ric">☑️</div><div class="str-rt">Ruhig und klar im Kopf? — Wenn nein: warten.</div></div>
      </div>
    </div>
    <div class="str-sec">
      <div class="str-hdr"><div class="str-ic">💱</div><div class="str-title">Instrumente</div></div>
      <div class="str-body">
        <table class="sym-tbl">
          <tr><th>Symbol</th><th>Priorität</th><th>Hinweis</th></tr>
          <tr><td><strong>BTC/USDT</strong></td><td><span class="badge bw">Primär</span></td><td style="font-size:0.7rem;color:var(--text2)">Klarste Strukturen</td></tr>
          <tr><td><strong>ETH/USDT</strong></td><td><span class="badge bo">Sekundär</span></td><td style="font-size:0.7rem;color:var(--text2)">Etwas mehr Bewegung</td></tr>
          <tr><td><strong>SOL/USDT</strong></td><td><span class="badge bs">Optional</span></td><td style="font-size:0.7rem;color:var(--text2)">Nur bei klarem Trend</td></tr>
        </table>
      </div>
    </div>
  </div>

  <!-- TOOLS -->
  <div class="page" id="page-tools">
    <a class="wb-link" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank" style="margin-bottom:14px">
      <div class="wb-ic">🌊</div>
      <div><div class="wb-title">WaveBoard Dashboard</div><div class="wb-sub">waveboard-e54ed.web.app</div></div>
      <div class="wb-arr">↗ Öffnen</div>
    </a>
    <div class="t-sec">
      <div class="t-sec-title">System</div>
      <div class="t-list">
        <div class="t-row" onclick="toolAct('health')"><div class="t-ic">💚</div><div class="t-txt"><div class="t-lbl">Health Check</div><div class="t-desc">Worker Status prüfen</div></div><div class="t-arr">›</div></div>
        <div class="t-row" onclick="toolAct('telegram')"><div class="t-ic">📨</div><div class="t-txt"><div class="t-lbl">Telegram testen</div><div class="t-desc">Test-Nachricht senden</div></div><div class="t-arr">›</div></div>
        <div class="t-row" onclick="toolAct('morning')"><div class="t-ic">🌅</div><div class="t-txt"><div class="t-lbl">Morning Brief</div><div class="t-desc">Tages-Bias jetzt abrufen</div></div><div class="t-arr">›</div></div>
        <div class="t-row" onclick="toolAct('outcomes')"><div class="t-ic">🔄</div><div class="t-txt"><div class="t-lbl">Outcome Tracking</div><div class="t-desc">WIN/LOSS via Binance</div></div><div class="t-arr">›</div></div>
      </div>
    </div>
    <div class="t-sec">
      <div class="t-sec-title">Links</div>
      <div class="t-list">
        <a class="t-row" href="https://tradingview.com" target="_blank"><div class="t-ic">📊</div><div class="t-txt"><div class="t-lbl">TradingView</div><div class="t-desc">Charts & Alerts</div></div><div class="t-arr">↗</div></a>
        <a class="t-row" href="https://dash.cloudflare.com" target="_blank"><div class="t-ic">☁️</div><div class="t-txt"><div class="t-lbl">Cloudflare</div><div class="t-desc">Worker & Logs</div></div><div class="t-arr">↗</div></a>
        <a class="t-row" href="https://github.com/spnni08/tradingview-bot" target="_blank"><div class="t-ic">🐙</div><div class="t-txt"><div class="t-lbl">GitHub</div><div class="t-desc">spnni08/tradingview-bot</div></div><div class="t-arr">↗</div></a>
        <a class="t-row" href="https://console.anthropic.com" target="_blank"><div class="t-ic">🤖</div><div class="t-txt"><div class="t-lbl">Anthropic Console</div><div class="t-desc">Claude API Keys</div></div><div class="t-arr">↗</div></a>
      </div>
    </div>
  </div>

  <!-- TELEGRAM -->
  <div class="page" id="page-telegram">
    <div style="font-size:0.6rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:11px">Tippe zum Kopieren</div>
    <div class="cmd-list">
      <div class="cmd-row" onclick="cpCmd('/btc')"><div><div class="cmd-code">/btc</div><div class="cmd-desc">Bitcoin analysieren</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="cpCmd('/eth')"><div><div class="cmd-code">/eth</div><div class="cmd-desc">Ethereum analysieren</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="cpCmd('/sol')"><div><div class="cmd-code">/sol</div><div class="cmd-desc">Solana analysieren</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="cpCmd('/check RENDERUSDT')"><div><div class="cmd-code">/check SYMBOL</div><div class="cmd-desc">Beliebiges Symbol</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="cpCmd('/status')"><div><div class="cmd-code">/status</div><div class="cmd-desc">Winrate & Stats</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="cpCmd('/brief')"><div><div class="cmd-code">/brief</div><div class="cmd-desc">Morning Brief senden</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="cpCmd('/open')"><div><div class="cmd-code">/open</div><div class="cmd-desc">Offene Trades</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="cpCmd('/top')"><div><div class="cmd-code">/top</div><div class="cmd-desc">Beste Signale heute</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="cpCmd('/hilfe')"><div><div class="cmd-code">/hilfe</div><div class="cmd-desc">Alle Kommandos</div></div><div>📋</div></div>
    </div>
  </div>
</div>

<!-- BOTTOM NAV -->
<div class="bnav" id="bnav">
  <button class="bn on" onclick="go('home')"><span class="bn-ic">🏠</span>Home</button>
  <button class="bn" onclick="go('analyse')"><span class="bn-ic">🔍</span>Analyse</button>
  <button class="bn" onclick="go('signals')"><span class="bn-ic">📋</span>Signale</button>
  <button class="bn" onclick="go('backtesting')"><span class="bn-ic">📊</span>Backtest</button>
  <button class="bn" onclick="go('tools')"><span class="bn-ic">🔧</span>Tools</button>
</div>

<div class="toast" id="toast"></div>

<script>
const S = new URLSearchParams(location.search).get('secret') || '';
const USERS = {
  Marvin: { bg: 'linear-gradient(135deg,#2563eb,#1d4ed8)', i: 'M' },
  Sandro: { bg: 'linear-gradient(135deg,#0ea5e9,#2563eb)', i: 'S' },
  Iven:   { bg: 'linear-gradient(135deg,#10b981,#0ea5e9)', i: 'I' }
};
let selUser = null;
let allSigs = [];
let sortM = 'score';
let btData = null;
let btPer = 'all';

// ── AUTH ──
function chkAuth() {
  const u = localStorage.getItem('ws_user');
  if (!u) return false;
  const pw = localStorage.getItem('ws_pw_' + u);
  if (!pw) return false;
  loginOk(u);
  return true;
}
function selectUser(name, el) {
  selUser = name;
  document.querySelectorAll('.u-btn').forEach(b => b.classList.remove('sel'));
  el.classList.add('sel');
  const stored = localStorage.getItem('ws_pw_' + name);
  document.getElementById('pw-wrap').classList.add('show');
  document.getElementById('login-go').style.display = 'block';
  document.getElementById('pw-in').value = '';
  document.getElementById('login-err').textContent = '';
  document.getElementById('pw-hint').textContent = stored
    ? 'Willkommen zurueck, ' + name + '!'
    : 'Erste Anmeldung: Setze dein Passwort.';
  document.getElementById('pw-in').focus();
}
function doLogin() {
  if (!selUser) return;
  const pw = document.getElementById('pw-in').value;
  if (!pw || pw.length < 4) { document.getElementById('login-err').textContent = 'Mind. 4 Zeichen.'; return; }
  const stored = localStorage.getItem('ws_pw_' + selUser);
  if (!stored) {
    localStorage.setItem('ws_pw_' + selUser, pw);
    localStorage.setItem('ws_user', selUser);
    loginOk(selUser);
  } else if (stored === pw) {
    localStorage.setItem('ws_user', selUser);
    loginOk(selUser);
  } else {
    document.getElementById('login-err').textContent = 'Falsches Passwort.';
    document.getElementById('pw-in').value = '';
    document.getElementById('pw-in').focus();
  }
}
function loginOk(name) {
  document.getElementById('lo').classList.add('gone');
  const u = USERS[name] || USERS.Marvin;
  document.getElementById('sb-av').style.background = u.bg;
  document.getElementById('sb-av').textContent = u.i;
  document.getElementById('sb-name').textContent = name;
  updGreeting(name);
  loadHome();
}
function logout() {
  localStorage.removeItem('ws_user');
  document.getElementById('lo').classList.remove('gone');
  document.querySelectorAll('.u-btn').forEach(b => b.classList.remove('sel'));
  document.getElementById('pw-wrap').classList.remove('show');
  document.getElementById('login-go').style.display = 'none';
  document.getElementById('login-err').textContent = '';
  selUser = null;
}

// ── CLOCK ──
function updGreeting(name) {
  const h = new Date().getHours();
  const g = h < 12 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
  const days = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const months = ['Januar','Februar','Maerz','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const now = new Date();
  document.getElementById('g-day').textContent = days[now.getDay()] + ', ' + now.getDate() + '. ' + months[now.getMonth()] + ' ' + now.getFullYear();
  document.getElementById('g-title').innerHTML = g + ', <span>' + (name || 'Trader') + '</span> 👋';
}
setInterval(() => {
  document.getElementById('clk').textContent = new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const u = localStorage.getItem('ws_user');
  if(u) updGreeting(u);
}, 1000);

// ── UTILS ──
function fmt(n,d=2) { if(!n&&n!==0)return'–'; return Number(n).toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d}); }
function ago(ts) { const d=Date.now()-ts; if(d<60000)return'jetzt'; if(d<3600000)return Math.floor(d/60000)+'m'; if(d<86400000)return Math.floor(d/3600000)+'h'; return Math.floor(d/86400000)+'d'; }
function sc(s) { if(s>=70)return'var(--green)'; if(s>=50)return'var(--yellow)'; return'var(--red)'; }
function toast(msg,dur=2400) { const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),dur); }

// ── NAV ──
const pn={home:'Dashboard',analyse:'Analyse',signals:'Signale',backtesting:'Backtesting',strategie:'Strategie',tools:'Tools',telegram:'Telegram'};
function go(name) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.nav-btn').forEach(n=>n.classList.remove('on'));
  document.querySelectorAll('.bn').forEach((b,i)=>{
    ['home','analyse','signals','backtesting','tools'].forEach((p,j)=>{ if(i===j) b.classList.toggle('on',p===name); });
  });
  document.getElementById('page-'+name).classList.add('on');
  document.getElementById('tb-title').textContent=pn[name]||name;
  ['home','analyse','signals','backtesting','strategie','tools','telegram'].forEach((p,i)=>{
    document.querySelectorAll('.nav-btn')[i]?.classList.toggle('on',p===name);
  });
  if(name==='analyse') loadSnaps();
  if(name==='signals') loadHist();
  if(name==='backtesting') loadBT();
  if(name==='home') loadHome();
}

// ── STATS ──
async function loadStats() {
  const d=await fetch('/stats').then(r=>r.json()).catch(()=>({}));
  document.getElementById('kpi-open').textContent=d.open||0;
  document.getElementById('kpi-wins').textContent=d.wins||0;
  document.getElementById('kpi-losses').textContent=d.losses||0;
  document.getElementById('kpi-wr').textContent=(d.winrate||0)+'%';
}

// ── HOME ──
async function loadHome() {
  await loadStats();
  const h=await fetch('/history').then(r=>r.json()).catch(()=>[]);
  const el=document.getElementById('home-sigs');
  if(!h.length){el.innerHTML='<div class="empty">Noch keine Signale.</div>';return;}
  el.innerHTML=h.slice(0,5).map(x=>{
    const s=Number(x.ai_score)||0;
    return \`<div class="mini-sig">
      <div class="ms-l"><div class="ms-dot" style="background:\${x.ai_direction==='LONG'?'var(--green)':'var(--red)'}"></div>
      <div><div class="ms-sym">\${x.symbol||'–'}</div><div class="ms-trig">\${x.trigger||'–'}</div></div></div>
      <div style="text-align:right"><div class="ms-score" style="color:\${sc(s)}">\${s}/100</div><div class="ms-t">\${ago(x.created_at)}</div></div>
    </div>\`;
  }).join('');
}

// ── SNAPSHOTS ──
async function loadSnaps() {
  const el=document.getElementById('snap-list');
  el.innerHTML='<div class="empty">Lade...</div>';
  const snaps=await fetch('/snapshots').then(r=>r.json()).catch(()=>[]);
  if(!snaps.length){el.innerHTML='<div class="empty">Noch keine Snapshots.</div>';return;}
  el.innerHTML=snaps.map(s=>\`<div>
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:13px 15px;display:flex;align-items:center;gap:11px;margin-bottom:4px">
      <div style="flex:1;min-width:0">
        <div style="font-size:0.88rem;font-weight:700;color:var(--white)">\${s.symbol}</div>
        <div style="font-family:var(--mono);font-size:0.58rem;color:var(--text3);margin-top:2px">RSI \${fmt(s.rsi,1)} · EMA50 \${fmt(s.ema50,0)} · \${s.trend||'–'}</div>
      </div>
      <div style="font-family:var(--mono);font-size:0.85rem;font-weight:700;color:var(--blue3);white-space:nowrap">\${fmt(s.price)}</div>
      <button class="btn btn-p" onclick="checkNow('\${s.symbol}',this)" \${S?'':'disabled'} style="font-size:0.65rem;padding:6px 11px">\${S?'Prüfen':'🔒'}</button>
    </div>
    <div class="res-wrap" id="res-\${s.symbol}" style="display:none"></div>
  </div>\`).join('');
}

// ── ANALYSE ──
async function checkNow(sym,btn) {
  btn.disabled=true;btn.textContent='...';
  const el=document.getElementById('res-'+sym);
  try {
    const d=await fetch('/ask?symbol='+encodeURIComponent(sym)+'&secret='+encodeURIComponent(S)).then(r=>r.json());
    if(d.error) throw new Error(d.error);
    const ai=d.ai||{},s=Number(ai.score)||0;
    const rec=ai.recommendation==='RECOMMENDED';
    const rr=(ai.entry&&ai.take_profit&&ai.stop_loss)?(Math.abs(ai.take_profit-ai.entry)/Math.abs(ai.entry-ai.stop_loss)).toFixed(2):null;
    el.style.display='block';
    el.innerHTML=\`<div class="res-card">
      <div class="res-hdr">
        <span class="res-badge \${rec?'rec':'norec'}">\${rec?'✓ Empfohlen':'✗ Nicht empfohlen'}</span>
        <span style="font-family:var(--mono);font-size:0.83rem;font-weight:700;color:\${sc(s)}">\${s}/100</span>
      </div>
      <div class="res-body">
        <div class="res-row"><span class="res-k">Richtung</span><span class="res-v">\${ai.direction||'–'}</span></div>
        <div class="res-row"><span class="res-k">Risiko</span><span class="res-v">\${ai.risk||'–'}</span></div>
        <div class="res-row"><span class="res-k">Confidence</span><span class="res-v">\${ai.confidence||0}%</span></div>
        \${rr?'<div class="res-row"><span class="res-k">R/R</span><span class="res-v">1:'+rr+'</span></div>':''}
        <div class="bar-bg"><div class="bar-fill" style="width:\${s}%;background:\${sc(s)}"></div></div>
        <div class="res-plan">
          <div class="plan-c"><div class="plan-l">Entry</div><div class="plan-v" style="color:var(--blue3)">\${fmt(ai.entry)}</div></div>
          <div class="plan-c"><div class="plan-l">Take Profit</div><div class="plan-v" style="color:var(--green)">\${fmt(ai.take_profit)}</div></div>
          <div class="plan-c"><div class="plan-l">Stop Loss</div><div class="plan-v" style="color:var(--red)">\${fmt(ai.stop_loss)}</div></div>
        </div>
        <div class="res-reason">\${ai.reason||''}</div>
      </div>
    </div>\`;
    toast(rec?'Empfohlen!':'Nicht empfohlen');
  } catch(e) {
    el.style.display='block';
    el.innerHTML='<div style="padding:13px 15px;color:var(--red);font-size:0.74rem">Fehler: '+e.message+'</div>';
  }
  btn.disabled=false;btn.textContent=S?'Prüfen':'🔒';
}

// ── SIGNALS ──
async function loadHist() {
  const el=document.getElementById('sig-list');
  el.innerHTML='<div class="empty">Lade...</div>';
  allSigs=await fetch('/history').then(r=>r.json()).catch(()=>[]);
  const syms=[...new Set(allSigs.map(x=>x.symbol).filter(Boolean))];
  const sel=document.getElementById('f-sym');
  sel.innerHTML='<option value="">Alle Symbole</option>'+syms.map(s=>'<option value="'+s+'">'+s+'</option>').join('');
  applyF();
}
function setSort(m) {
  sortM=m;
  document.getElementById('srt-sc').classList.toggle('on',m==='score');
  document.getElementById('srt-tm').classList.toggle('on',m==='time');
  applyF();
}
function applyF() {
  const sym=document.getElementById('f-sym').value;
  const out=document.getElementById('f-out').value;
  let f=[...allSigs];
  if(sym) f=f.filter(x=>x.symbol===sym);
  if(out) f=f.filter(x=>x.outcome===out);
  if(sortM==='score') f.sort((a,b)=>(b.ai_score||0)-(a.ai_score||0));
  else f.sort((a,b)=>b.created_at-a.created_at);
  const el=document.getElementById('sig-list');
  if(!f.length){el.innerHTML='<div class="empty">Keine Signale.</div>';return;}
  el.innerHTML=f.map(x=>{
    const s=Number(x.ai_score)||0;
    const oc=x.outcome==='WIN'?'bw':x.outcome==='LOSS'?'bl':x.outcome==='SKIPPED'?'bs':'bo';
    const rc=x.ai_recommendation==='RECOMMENDED'?'brec':'bnrec';
    const rk=x.ai_risk==='HIGH'?'bhi':x.ai_risk==='MEDIUM'?'bme':'blo';
    const open=x.outcome==='OPEN';
    return \`<div class="sig-card">
      <div class="sig-top"><span class="sig-sym">\${x.symbol||'–'}</span><span class="sig-time">\${ago(x.created_at)}</span></div>
      <div class="sig-mid"><span class="sig-tr">\${x.trigger||'–'}</span><span class="sig-sc" style="color:\${sc(s)}">\${s}/100</span></div>
      <div class="sig-px"><span>E: \${fmt(x.ai_entry)}</span><span style="color:var(--green)">TP: \${fmt(x.ai_take_profit)}</span><span style="color:var(--red)">SL: \${fmt(x.ai_stop_loss)}</span></div>
      <div class="bar-bg"><div class="bar-fill" style="width:\${s}%;background:\${sc(s)}"></div></div>
      <div class="sig-foot">
        <div class="badges">
          <span class="badge \${rc}">\${x.ai_recommendation==='RECOMMENDED'?'Empf.':'Nein'}</span>
          <span class="badge \${rk}">\${x.ai_risk||'–'}</span>
          <span class="badge \${oc}" id="out-\${x.id}">\${x.outcome||'–'}</span>
        </div>
        \${open&&S?\`<div style="display:flex;gap:5px">
          <button class="btn btn-win" onclick="setOut('\${x.id}','WIN',this)">WIN</button>
          <button class="btn btn-loss" onclick="setOut('\${x.id}','LOSS',this)">LOSS</button>
          <button class="btn btn-skip" onclick="setOut('\${x.id}','SKIPPED',this)">Skip</button>
        </div>\`:''}
      </div>
    </div>\`;
  }).join('');
}
async function setOut(id,outcome,btn) {
  const all=btn.parentElement.querySelectorAll('button');
  all.forEach(b=>b.disabled=true);
  try {
    const r=await fetch('/outcome?id='+id+'&outcome='+outcome+'&secret='+encodeURIComponent(S),{method:'POST'}).then(r=>r.json());
    if(r.status==='ok'){
      const b=document.getElementById('out-'+id);
      if(b){b.className='badge '+(outcome==='WIN'?'bw':outcome==='LOSS'?'bl':'bs');b.textContent=outcome;}
      btn.parentElement.style.display='none';
      loadStats();
      toast(outcome==='WIN'?'WIN!':outcome==='LOSS'?'LOSS':'Skip gespeichert');
    }
  } catch(e){all.forEach(b=>b.disabled=false);toast('Fehler: '+e.message);}
}

// ── BACKTESTING ──
async function loadBT() {
  const el=document.getElementById('bt-body');
  el.innerHTML='<div class="empty">Lade...</div>';
  btData=await fetch('/backtesting').then(r=>r.json()).catch(()=>null);
  if(!btData||btData.error){el.innerHTML='<div class="empty">Fehler.</div>';return;}
  renderBT(btPer);
}
function btTab(p,btn) {
  btPer=p;
  document.querySelectorAll('.bt-tab').forEach(t=>t.classList.remove('on'));
  btn.classList.add('on');
  renderBT(p);
}
function renderBT(p) {
  if(!btData) return;
  const el=document.getElementById('bt-body');
  const d=p==='week'?btData.week:p==='month'?btData.month:btData.overall;
  const cl=(d.wins||0)+(d.losses||0);
  const wr=cl>0?((d.wins/cl)*100).toFixed(1):0;
  const o=btData.overall;
  let h=\`<div class="bt-kpis">
    <div class="bt-k"><div class="bt-kv" style="color:var(--green)">\${d.wins||0}</div><div class="bt-kl">Wins</div></div>
    <div class="bt-k"><div class="bt-kv" style="color:var(--red)">\${d.losses||0}</div><div class="bt-kl">Losses</div></div>
    <div class="bt-k"><div class="bt-kv" style="color:var(--blue3)">\${wr}%</div><div class="bt-kl">Winrate</div></div>
  </div>
  <div class="score-cmp">
    <div class="sc-title">Ø Score — Wins vs Losses</div>
    <div class="sc-row"><div class="sc-lbl" style="color:var(--green)">WIN</div><div class="sc-bar"><div class="sc-fill" style="width:\${o.avg_score_win||0}%;background:var(--green)"></div></div><div class="sc-val" style="color:var(--green)">\${o.avg_score_win||0}</div></div>
    <div class="sc-row"><div class="sc-lbl" style="color:var(--red)">LOSS</div><div class="sc-bar"><div class="sc-fill" style="width:\${o.avg_score_loss||0}%;background:var(--red)"></div></div><div class="sc-val" style="color:var(--red)">\${o.avg_score_loss||0}</div></div>
  </div>\`;
  if(btData.bySymbol&&btData.bySymbol.length) {
    h+=\`<div class="card" style="margin-bottom:12px">
      <div class="card-hdr"><div class="card-title">Winrate pro Symbol</div></div>
      <div style="padding:0 4px"><table class="sym-tbl">
        <tr><th>Symbol</th><th>W</th><th>L</th><th>Win%</th><th>Ø Score</th></tr>
        \${btData.bySymbol.map(s=>{const cl2=(s.wins||0)+(s.losses||0);const w2=cl2>0?((s.wins/cl2)*100).toFixed(0):0;return\`<tr>
          <td><strong>\${s.symbol}</strong></td>
          <td style="color:var(--green)">\${s.wins||0}</td>
          <td style="color:var(--red)">\${s.losses||0}</td>
          <td style="color:var(--blue3);font-family:var(--mono);font-weight:700">\${w2}%</td>
          <td style="font-family:var(--mono)">\${Number(s.avg_score||0).toFixed(0)}</td>
        </tr>\`;}).join('')}
      </table></div>
    </div>\`;
  }
  if(btData.best&&btData.best.length) {
    h+=\`<div class="card" style="margin-bottom:12px">
      <div class="card-hdr"><div class="card-title">Beste Signale (WIN)</div></div>
      <div class="card-body">\${btData.best.map(x=>\`<div class="bt-sig">
        <div><div class="bt-s-sym">\${x.symbol} <span style="color:var(--green);font-size:0.6rem">\${x.ai_direction}</span></div>
        <div class="bt-s-dir">E: \${fmt(x.ai_entry)} → TP: \${fmt(x.ai_take_profit)}</div></div>
        <div class="bt-s-sc" style="color:var(--green)">\${x.ai_score}/100</div>
      </div>\`).join('')}</div>
    </div>\`;
  }
  if(btData.worst&&btData.worst.length) {
    h+=\`<div class="card">
      <div class="card-hdr"><div class="card-title">Schlechteste Signale (LOSS)</div></div>
      <div class="card-body">\${btData.worst.map(x=>\`<div class="bt-sig">
        <div><div class="bt-s-sym">\${x.symbol} <span style="color:var(--red);font-size:0.6rem">\${x.ai_direction}</span></div>
        <div class="bt-s-dir">E: \${fmt(x.ai_entry)} · SL: \${fmt(x.ai_stop_loss)}</div></div>
        <div class="bt-s-sc" style="color:var(--red)">\${x.ai_score}/100</div>
      </div>\`).join('')}</div>
    </div>\`;
  }
  el.innerHTML=h;
}

// ── TOOLS ──
async function toolAct(a) {
  if(!S&&a!=='health'){toast('Secret benoetigt');return;}
  toast('Wird ausgefuehrt...');
  try {
    if(a==='health'){const d=await fetch('/health').then(r=>r.json());toast('Worker OK: '+new Date(d.time).toLocaleTimeString('de-DE'),3000);}
    else if(a==='telegram'){await fetch('/test-telegram?secret='+encodeURIComponent(S));toast('Telegram Testnachricht gesendet!');}
    else if(a==='morning'){await fetch('/morning-brief?secret='+encodeURIComponent(S));toast('Morning Brief gesendet!');}
    else if(a==='outcomes'){const d=await fetch('/check-outcomes?secret='+encodeURIComponent(S)).then(r=>r.json());toast((d.result?.closed||0)+' Trades geschlossen',3000);}
  } catch(e){toast('Fehler: '+e.message);}
}
function cpCmd(c) { navigator.clipboard.writeText(c).then(()=>toast('Kopiert: '+c)); }

// ── INIT ──
if(!chkAuth()) { /* login shown */ }
</script>
</body>
</html>`;
}
