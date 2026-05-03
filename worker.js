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
  const LG = `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="#1e40af"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient></defs><rect width="80" height="80" rx="18" fill="#0f172a"/><g stroke="url(#g)" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="40" y1="47" x2="40" y2="63"/><rect x="31" y="63" width="18" height="5" rx="2.5"/><circle cx="40" cy="43" r="4" fill="url(#g)" stroke="none"/><path d="M29 37 C23 31 23 21 26 15"/><path d="M51 37 C57 31 57 21 54 15"/><path d="M34 40 C30 35 30 28 32 23"/><path d="M46 40 C50 35 50 28 48 23"/><path d="M37.5 42 C35 39 35 35 37 32"/><path d="M42.5 42 C45 39 45 35 43 32"/></g></svg>`;
  const LS = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(LG);
  return `<!doctype html>
<html lang="de" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>WAVESCOUT</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* ═══ TOKENS ═══ */
[data-theme="dark"] {
  --bg:      #0a0f1e;
  --bg2:     #0d1525;
  --bg3:     #111c30;
  --card:    #131f35;
  --card2:   #162540;
  --border:  #1e3355;
  --border2: #253f6b;
  --blue:    #2563eb;
  --blue2:   #3b7bff;
  --blue3:   #60a5fa;
  --blue4:   #bfdbfe;
  --dim:     rgba(37,99,235,.12);
  --glow:    rgba(37,99,235,.25);
  --green:   #10b981;
  --red:     #f43f5e;
  --amber:   #f59e0b;
  --text1:   #f1f8ff;
  --text2:   #94b4d4;
  --text3:   #4a6d8c;
  --text4:   #1e3355;
  --shadow:  0 4px 24px rgba(0,0,0,.4);
  --shadow2: 0 1px 3px rgba(0,0,0,.3);
  --logo-bg: #0f172a;
}
[data-theme="light"] {
  --bg:      #f0f4f8;
  --bg2:     #e8eef5;
  --bg3:     #dde5ee;
  --card:    #ffffff;
  --card2:   #f7fafc;
  --border:  #d0dce9;
  --border2: #b8ccdf;
  --blue:    #1d4ed8;
  --blue2:   #2563eb;
  --blue3:   #3b7bff;
  --blue4:   #1e3a8a;
  --dim:     rgba(37,99,235,.08);
  --glow:    rgba(37,99,235,.15);
  --green:   #059669;
  --red:     #e11d48;
  --amber:   #d97706;
  --text1:   #0f172a;
  --text2:   #334155;
  --text3:   #64748b;
  --text4:   #cbd5e1;
  --shadow:  0 4px 24px rgba(0,0,0,.08);
  --shadow2: 0 1px 3px rgba(0,0,0,.06);
  --logo-bg: #1e3a8a;
}

/* ═══ RESET ═══ */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
html { height: 100%; scroll-behavior: smooth; }
body { font-family: 'DM Sans', sans-serif; background: var(--bg); color: var(--text2); min-height: 100vh; transition: background .3s, color .3s; }

/* ═══ LOGIN SCREEN ═══ */
#login-screen {
  position: fixed; inset: 0; z-index: 500;
  background: var(--bg);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  transition: opacity .3s;
}
#login-screen.hidden { opacity: 0; pointer-events: none; }
#login-screen.gone { display: none; }

.login-card {
  width: 100%; max-width: 420px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 36px 32px;
  box-shadow: var(--shadow);
}
.login-header {
  text-align: center; margin-bottom: 32px;
}
.login-logo {
  width: 52px; height: 52px;
  border-radius: 14px; margin: 0 auto 14px;
  display: block;
}
.login-brand {
  font-size: 1.4rem; font-weight: 700; letter-spacing: .04em;
  color: var(--text1); margin-bottom: 3px;
}
.login-sub { font-size: .8rem; color: var(--text3); }

.login-label {
  font-size: .7rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: .08em; color: var(--text3); margin-bottom: 12px;
}
.user-select { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; margin-bottom: 24px; }
.user-opt {
  border: 2px solid var(--border); border-radius: 12px;
  padding: 16px 8px; cursor: pointer; text-align: center;
  background: var(--card2); transition: all .15s; font-family: 'DM Sans', sans-serif;
}
.user-opt:hover { border-color: var(--blue3); transform: translateY(-1px); }
.user-opt.active { border-color: var(--blue2); background: var(--dim); }
.user-avatar {
  width: 38px; height: 38px; border-radius: 50%;
  margin: 0 auto 8px; display: flex; align-items: center; justify-content: center;
  font-size: .95rem; font-weight: 700; color: #fff;
}
.u-M { background: linear-gradient(135deg, #1e40af, #3b82f6); }
.u-S { background: linear-gradient(135deg, #0369a1, #2563eb); }
.u-I { background: linear-gradient(135deg, #065f46, #059669); }
.user-name { font-size: .78rem; font-weight: 600; color: var(--text1); }

.pw-section { display: none; margin-bottom: 20px; }
.pw-section.show { display: block; }
.pw-label { font-size: .7rem; font-weight: 600; color: var(--text3); margin-bottom: 7px; }
.pw-hint { font-size: .65rem; color: var(--text3); margin-top: 5px; font-style: italic; }
.pw-input {
  width: 100%; padding: 11px 14px;
  background: var(--bg2); border: 1.5px solid var(--border);
  border-radius: 10px; color: var(--text1);
  font-family: 'DM Mono', monospace; font-size: .95rem;
  outline: none; transition: border-color .15s, box-shadow .15s;
}
.pw-input:focus { border-color: var(--blue2); box-shadow: 0 0 0 3px var(--dim); }
.login-submit {
  width: 100%; padding: 12px; background: var(--blue);
  color: #fff; border: none; border-radius: 10px;
  font-family: 'DM Sans', sans-serif; font-size: .9rem; font-weight: 600;
  cursor: pointer; letter-spacing: .02em;
  transition: background .15s, box-shadow .15s, transform .1s;
}
.login-submit:hover { background: var(--blue2); box-shadow: 0 4px 16px var(--glow); }
.login-submit:active { transform: scale(.98); }
.login-error { font-size: .7rem; color: var(--red); text-align: center; margin-top: 10px; min-height: 16px; }
.login-footer { text-align: center; margin-top: 24px; }
.login-footer p { font-size: .65rem; color: var(--text3); line-height: 2.2; }
.login-footer strong { color: var(--blue3); font-weight: 600; }

/* ═══ APP LAYOUT ═══ */
.app { display: flex; flex-direction: column; min-height: 100vh; }

/* ── TOPBAR ── */
.topbar {
  position: sticky; top: 0; z-index: 100;
  height: 58px; padding: 0 20px;
  background: var(--card);
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: 12px;
  box-shadow: var(--shadow2);
}
.tb-logo { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.tb-logo-img { width: 30px; height: 30px; border-radius: 8px; }
.tb-logo-name { font-size: .9rem; font-weight: 700; color: var(--text1); letter-spacing: .04em; }
.tb-logo-tag {
  font-size: .55rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: .08em; color: var(--blue3);
  background: var(--dim); border: 1px solid rgba(59,123,255,.2);
  padding: 2px 6px; border-radius: 4px;
}
.tb-divider { width: 1px; height: 22px; background: var(--border); flex-shrink: 0; }
.tb-nav { display: flex; gap: 2px; flex: 1; overflow-x: auto; scrollbar-width: none; }
.tb-nav::-webkit-scrollbar { display: none; }
.tn {
  padding: 6px 12px; border-radius: 8px;
  font-size: .78rem; font-weight: 500; color: var(--text3);
  border: none; background: none; cursor: pointer; white-space: nowrap;
  transition: color .12s, background .12s; font-family: 'DM Sans', sans-serif;
}
.tn:hover { color: var(--text2); background: var(--bg2); }
.tn.on { color: var(--blue2); background: var(--dim); font-weight: 600; }
.tb-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-shrink: 0; }
.tb-time { font-family: 'DM Mono', monospace; font-size: .65rem; color: var(--text3); }
.live-pill {
  display: flex; align-items: center; gap: 5px;
  background: rgba(16,185,129,.1); border: 1px solid rgba(16,185,129,.2);
  padding: 3px 9px; border-radius: 20px;
  font-size: .62rem; font-weight: 600; color: var(--green);
}
.live-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(16,185,129,.5)} 60%{opacity:.7;box-shadow:0 0 0 4px rgba(16,185,129,0)} }
.theme-btn {
  width: 32px; height: 32px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg2);
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  font-size: .95rem; transition: background .12s, border-color .12s;
}
.theme-btn:hover { background: var(--bg3); border-color: var(--border2); }
.user-chip {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 10px 5px 5px; border-radius: 20px;
  border: 1px solid var(--border); background: var(--card2);
  cursor: pointer; transition: background .12s, border-color .12s;
}
.user-chip:hover { background: var(--bg2); border-color: var(--border2); }
.chip-av { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: .65rem; font-weight: 700; color: #fff; flex-shrink: 0; }
.chip-name { font-size: .73rem; font-weight: 600; color: var(--text1); }
.chip-logout { font-size: .6rem; color: var(--text3); margin-left: 2px; }

/* ═══ CONTENT ═══ */
.content { flex: 1; }
.page { display: none; max-width: 900px; margin: 0 auto; padding: 24px 20px; }
.page.on { display: block; }

/* ── PAGE HEADER ── */
.page-hdr { margin-bottom: 24px; }
.page-hdr-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.page-title { font-size: 1.35rem; font-weight: 700; color: var(--text1); line-height: 1.2; }
.page-title em { color: var(--blue3); font-style: normal; }
.page-sub { font-size: .8rem; color: var(--text3); margin-top: 4px; line-height: 1.5; }
.page-date { font-size: .72rem; color: var(--text3); flex-shrink: 0; margin-top: 4px; }

/* ── KPI STRIP ── */
.kpi-strip { display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 24px; }
.kpi-card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: 14px; padding: 18px 16px;
  position: relative; overflow: hidden;
  transition: border-color .15s, transform .15s, box-shadow .15s;
}
.kpi-card:hover { border-color: var(--border2); transform: translateY(-1px); box-shadow: var(--shadow); }
.kpi-card::before { content:''; position:absolute; top:0; left:0; right:0; height:3px; border-radius:14px 14px 0 0; }
.kpi-blue::before { background: linear-gradient(90deg, var(--blue), var(--blue3)); }
.kpi-green::before { background: var(--green); }
.kpi-red::before { background: var(--red); }
.kpi-white::before { background: linear-gradient(90deg, var(--border2), var(--border)); }
.kpi-label { font-size: .65rem; font-weight: 600; text-transform: uppercase; letter-spacing: .09em; color: var(--text3); margin-bottom: 10px; }
.kpi-value { font-family: 'DM Mono', monospace; font-size: 2rem; font-weight: 500; line-height: 1; color: var(--text1); }
.kpi-value.c-blue { color: var(--blue3); }
.kpi-value.c-green { color: var(--green); }
.kpi-value.c-red { color: var(--red); }
.kpi-footer { font-size: .62rem; color: var(--text3); margin-top: 6px; }

/* ── GRID ── */
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }

/* ── CARDS ── */
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: 14px; overflow: hidden;
  box-shadow: var(--shadow2);
}
.card-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border);
}
.card-title { font-size: .82rem; font-weight: 600; color: var(--text1); }
.card-subtitle { font-size: .68rem; color: var(--text3); margin-top: 1px; }
.card-body { padding: 16px 18px; }

/* ── QUICK ACTIONS ── */
.qa-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.qa {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 12px; background: var(--bg2);
  border: 1px solid var(--border); border-radius: 10px;
  cursor: pointer; transition: all .15s; font-family: 'DM Sans', sans-serif;
  text-align: left;
}
.qa:hover { background: var(--dim); border-color: var(--blue3); transform: translateY(-1px); }
.qa:active { transform: scale(.98); }
.qa-icon { font-size: 1.1rem; flex-shrink: 0; }
.qa-label { font-size: .78rem; font-weight: 600; color: var(--text1); }
.qa-desc { font-size: .62rem; color: var(--text3); margin-top: 1px; }

/* ── SIGNAL MINI (home) ── */
.sig-mini { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.sig-mini:last-child { border-bottom: none; padding-bottom: 0; }
.dir-pill { width: 28px; height: 28px; border-radius: 7px; display: flex; align-items: center; justify-content: center; font-size: .62rem; font-weight: 700; flex-shrink: 0; }
.dir-L { background: rgba(16,185,129,.12); color: var(--green); border: 1px solid rgba(16,185,129,.2); }
.dir-S { background: rgba(244,63,94,.12); color: var(--red); border: 1px solid rgba(244,63,94,.2); }
.sig-info { flex: 1; min-width: 0; }
.sig-sym { font-size: .82rem; font-weight: 700; color: var(--text1); }
.sig-trig { font-size: .62rem; color: var(--text3); font-family: 'DM Mono', monospace; margin-top: 1px; }
.sig-meta { text-align: right; flex-shrink: 0; }
.sig-score { font-family: 'DM Mono', monospace; font-size: .78rem; font-weight: 500; }
.sig-ago { font-size: .6rem; color: var(--text3); margin-top: 1px; }

/* ── WB LINK ── */
.wb-card {
  display: flex; align-items: center; gap: 14px;
  padding: 16px 18px; border-radius: 14px;
  background: var(--card); border: 1px solid var(--border);
  text-decoration: none; color: inherit;
  transition: all .15s; box-shadow: var(--shadow2);
  position: relative; overflow: hidden;
}
.wb-card::before { content:''; position:absolute; inset:0; background:linear-gradient(120deg,var(--dim),transparent); opacity:.5; }
.wb-card:hover { border-color: var(--blue3); box-shadow: 0 0 0 3px var(--dim), var(--shadow); }
.wb-icon { font-size: 1.8rem; flex-shrink: 0; position: relative; }
.wb-title { font-size: .9rem; font-weight: 700; color: var(--text1); position: relative; }
.wb-sub { font-size: .68rem; color: var(--text3); margin-top: 2px; position: relative; }
.wb-badge { margin-left: auto; background: var(--blue); color: #fff; font-size: .65rem; font-weight: 600; padding: 5px 12px; border-radius: 20px; flex-shrink: 0; position: relative; transition: background .12s; }
.wb-card:hover .wb-badge { background: var(--blue2); }

/* ── ANALYSE ── */
.snap-item {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px; background: var(--card);
  border: 1px solid var(--border); border-radius: 12px;
  margin-bottom: 8px; transition: border-color .12s;
  box-shadow: var(--shadow2);
}
.snap-item:hover { border-color: var(--border2); }
.snap-sym { font-size: .88rem; font-weight: 700; color: var(--text1); }
.snap-meta { font-family: 'DM Mono', monospace; font-size: .62rem; color: var(--text3); margin-top: 3px; }
.snap-price { font-family: 'DM Mono', monospace; font-size: .88rem; font-weight: 500; color: var(--blue3); white-space: nowrap; }
.result-box {
  background: var(--card2); border: 1px solid var(--border2);
  border-radius: 12px; overflow: hidden; margin-bottom: 8px;
  animation: slideDown .2s ease;
}
@keyframes slideDown { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:none; } }
.result-top { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--border); }
.rec-badge { font-size:.7rem; font-weight:700; padding:4px 10px; border-radius:20px; }
.rec-yes { background:rgba(16,185,129,.12); color:var(--green); border:1px solid rgba(16,185,129,.2); }
.rec-no  { background:rgba(244,63,94,.12); color:var(--red); border:1px solid rgba(244,63,94,.2); }
.result-body { padding:14px 16px; display:flex; flex-direction:column; gap:10px; }
.res-row { display:flex; justify-content:space-between; align-items:center; }
.res-k { font-size:.65rem; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--text3); }
.res-v { font-family:'DM Mono',monospace; font-size:.78rem; color:var(--text2); }
.res-plan { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
.plan-box { background:var(--bg2); border:1px solid var(--border); border-radius:9px; padding:10px; text-align:center; }
.plan-l { font-size:.58rem; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--text3); }
.plan-v { font-family:'DM Mono',monospace; font-size:.8rem; font-weight:500; margin-top:4px; }
.res-reason { font-size:.74rem; color:var(--text3); line-height:1.65; padding-top:10px; border-top:1px solid var(--border); }

/* ── PROGRESS BAR ── */
.progress { height:3px; background:var(--bg3); border-radius:99px; overflow:hidden; }
.progress-fill { height:100%; border-radius:99px; transition:width .6s ease; }

/* ── SIGNAL LIST ── */
.filter-row { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
.f-select {
  flex:1; min-width:100px; padding:8px 12px;
  background:var(--card); border:1px solid var(--border); border-radius:9px;
  color:var(--text2); font-family:'DM Sans',sans-serif; font-size:.76rem;
  outline:none; cursor:pointer; transition:border-color .12s;
}
.f-select:focus { border-color:var(--blue2); }
.sort-pill {
  padding:7px 14px; background:var(--card); border:1px solid var(--border);
  border-radius:20px; color:var(--text3); font-family:'DM Sans',sans-serif;
  font-size:.72rem; font-weight:500; cursor:pointer; white-space:nowrap;
  transition:all .12s;
}
.sort-pill.on { background:var(--dim); border-color:var(--blue3); color:var(--blue2); font-weight:600; }
.signal-card {
  background:var(--card); border:1px solid var(--border); border-radius:12px;
  padding:16px 18px; margin-bottom:8px;
  box-shadow:var(--shadow2); transition:border-color .12s;
}
.signal-card:hover { border-color:var(--border2); }
.sc-top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px; }
.sc-sym { font-size:.9rem; font-weight:700; color:var(--text1); }
.sc-dir { font-size:.65rem; font-weight:600; padding:2px 8px; border-radius:20px; margin-top:2px; display:inline-block; }
.sc-dir.L { background:rgba(16,185,129,.1); color:var(--green); }
.sc-dir.S { background:rgba(244,63,94,.1); color:var(--red); }
.sc-right { text-align:right; flex-shrink:0; }
.sc-score { font-family:'DM Mono',monospace; font-size:.88rem; font-weight:500; }
.sc-age { font-size:.6rem; color:var(--text3); margin-top:2px; }
.sc-prices { display:flex; gap:14px; margin:8px 0; font-family:'DM Mono',monospace; font-size:.68rem; color:var(--text3); }
.sc-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-top:10px; }
.tags { display:flex; gap:5px; flex-wrap:wrap; }
.tag { font-size:.62rem; font-weight:600; padding:3px 8px; border-radius:20px; }
.t-win  { background:rgba(16,185,129,.1); color:var(--green); border:1px solid rgba(16,185,129,.18); }
.t-open { background:var(--dim); color:var(--blue3); border:1px solid rgba(59,123,255,.18); }
.t-loss { background:rgba(244,63,94,.1); color:var(--red); border:1px solid rgba(244,63,94,.18); }
.t-skip { background:var(--bg2); color:var(--text3); border:1px solid var(--border); }
.t-rec  { background:rgba(16,185,129,.08); color:var(--green); }
.t-nrec { background:rgba(244,63,94,.08); color:var(--red); }
.t-lo   { background:rgba(16,185,129,.08); color:var(--green); }
.t-med  { background:rgba(245,158,11,.08); color:var(--amber); }
.t-hi   { background:rgba(244,63,94,.08); color:var(--red); }
.outcome-btns { display:flex; gap:6px; }
.ob { font-family:'DM Sans',sans-serif; font-size:.68rem; font-weight:600; padding:5px 10px; border-radius:7px; cursor:pointer; border:1px solid; transition:all .12s; }
.ob:hover { transform:translateY(-1px); }
.ob-w { background:rgba(16,185,129,.1); color:var(--green); border-color:rgba(16,185,129,.25); }
.ob-l { background:rgba(244,63,94,.1); color:var(--red); border-color:rgba(244,63,94,.25); }
.ob-s { background:var(--bg2); color:var(--text3); border-color:var(--border); }

/* ── BACKTESTING ── */
.bt-tabs { display:flex; gap:6px; margin-bottom:18px; }
.bt-tab { padding:7px 18px; background:var(--card); border:1px solid var(--border); border-radius:20px; color:var(--text3); font-family:'DM Sans',sans-serif; font-size:.74rem; font-weight:500; cursor:pointer; transition:all .12s; }
.bt-tab.on { background:var(--blue); border-color:var(--blue); color:#fff; font-weight:600; }
.bt-kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:18px; }
.bt-kpi { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px; text-align:center; box-shadow:var(--shadow2); }
.bt-kv { font-family:'DM Mono',monospace; font-size:1.6rem; font-weight:500; line-height:1; }
.bt-kl { font-size:.62rem; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--text3); margin-top:7px; }
.score-cmp { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px; margin-bottom:14px; box-shadow:var(--shadow2); }
.sc-title { font-size:.82rem; font-weight:600; color:var(--text1); margin-bottom:14px; }
.sc-row { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
.sc-row:last-child { margin-bottom:0; }
.sc-lbl { font-size:.72rem; font-weight:600; width:52px; flex-shrink:0; }
.sc-bar { flex:1; height:7px; background:var(--bg3); border-radius:99px; overflow:hidden; }
.sc-fill { height:100%; border-radius:99px; transition:width .8s ease; }
.sc-num { font-family:'DM Mono',monospace; font-size:.72rem; font-weight:500; width:34px; text-align:right; flex-shrink:0; }
.sym-table { width:100%; border-collapse:collapse; font-size:.76rem; }
.sym-table th { text-align:left; padding:8px 12px; font-size:.62rem; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--text3); border-bottom:1px solid var(--border); }
.sym-table td { padding:10px 12px; border-bottom:1px solid var(--border); }
.sym-table tr:last-child td { border-bottom:none; }
.bt-row { display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border); }
.bt-row:last-child { border-bottom:none; padding-bottom:0; }
.bt-sym { font-size:.82rem; font-weight:700; color:var(--text1); }
.bt-sub { font-size:.64rem; color:var(--text3); font-family:'DM Mono',monospace; margin-top:1px; }
.bt-sc { font-family:'DM Mono',monospace; font-size:.9rem; font-weight:500; }

/* ── STRATEGIE ── */
.str-card { background:var(--card); border:1px solid var(--border); border-radius:14px; overflow:hidden; margin-bottom:12px; box-shadow:var(--shadow2); }
.str-hdr { display:flex; align-items:center; gap:10px; padding:14px 18px; border-bottom:1px solid var(--border); background:var(--card2); }
.str-icon { font-size:1rem; }
.str-title { font-size:.84rem; font-weight:700; color:var(--text1); }
.str-body { padding:16px 18px; }
.str-step { display:flex; gap:12px; margin-bottom:14px; }
.str-step:last-child { margin-bottom:0; }
.str-num { width:24px; height:24px; border-radius:50%; background:var(--dim); border:1px solid rgba(59,123,255,.25); color:var(--blue3); font-size:.65rem; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px; }
.str-st { font-size:.8rem; font-weight:700; color:var(--text1); margin-bottom:4px; }
.str-tx { font-size:.76rem; line-height:1.7; color:var(--text3); }
.str-rule { display:flex; align-items:flex-start; gap:9px; padding:9px 0; border-bottom:1px solid var(--border); }
.str-rule:last-child { border-bottom:none; }
.str-ri { width:18px; flex-shrink:0; font-size:.82rem; margin-top:1px; }
.str-rt { font-size:.76rem; color:var(--text3); line-height:1.6; }
.str-rt strong { color:var(--text2); font-weight:600; }
.no-list { display:flex; flex-direction:column; gap:7px; }
.no-item { display:flex; align-items:center; gap:9px; padding:9px 12px; background:rgba(244,63,94,.04); border:1px solid rgba(244,63,94,.1); border-radius:9px; font-size:.76rem; color:var(--text3); }

/* ── TOOLS ── */
.tl-section { margin-bottom:16px; }
.tl-label { font-size:.62rem; font-weight:600; text-transform:uppercase; letter-spacing:.1em; color:var(--text3); margin-bottom:8px; padding:0 2px; }
.tl-list { background:var(--card); border:1px solid var(--border); border-radius:14px; overflow:hidden; box-shadow:var(--shadow2); }
.tl-row { display:flex; align-items:center; padding:13px 18px; border-bottom:1px solid var(--border); cursor:pointer; transition:background .1s; text-decoration:none; color:inherit; }
.tl-row:last-child { border-bottom:none; }
.tl-row:hover { background:var(--bg2); }
.tl-icon { font-size:1.05rem; width:26px; flex-shrink:0; }
.tl-info { flex:1; }
.tl-l { font-size:.8rem; font-weight:600; color:var(--text1); }
.tl-d { font-size:.65rem; color:var(--text3); margin-top:2px; }
.tl-arr { color:var(--text3); font-size:.75rem; }

/* ── TELEGRAM ── */
.cmd-intro { font-size:.76rem; color:var(--text3); line-height:1.6; margin-bottom:16px; padding:14px 16px; background:var(--dim); border:1px solid rgba(59,123,255,.15); border-radius:10px; }
.cmd-grid { display:flex; flex-direction:column; gap:6px; }
.cmd-row { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:var(--card); border:1px solid var(--border); border-radius:10px; cursor:pointer; transition:all .12s; box-shadow:var(--shadow2); }
.cmd-row:hover { background:var(--card2); border-color:var(--border2); transform:translateX(2px); }
.cmd-code { font-family:'DM Mono',monospace; font-size:.82rem; color:var(--blue3); font-weight:500; }
.cmd-desc { font-size:.68rem; color:var(--text3); margin-top:2px; }
.cmd-copy { font-size:.72rem; color:var(--text3); transition:color .12s; }
.cmd-row:hover .cmd-copy { color:var(--blue3); }

/* ── SHARED ── */
.btn { font-family:'DM Sans',sans-serif; font-weight:600; font-size:.76rem; border:none; border-radius:9px; padding:8px 14px; cursor:pointer; transition:all .15s; display:inline-flex; align-items:center; gap:5px; }
.btn:active { transform:scale(.97); }
.btn:disabled { opacity:.35; cursor:not-allowed; transform:none; }
.btn-primary { background:var(--blue); color:#fff; }
.btn-primary:hover { background:var(--blue2); box-shadow:0 4px 14px var(--glow); }
.btn-ghost { background:var(--bg2); border:1px solid var(--border); color:var(--text3); font-size:.7rem; padding:6px 12px; }
.btn-ghost:hover { background:var(--bg3); border-color:var(--border2); color:var(--text2); }
.section-hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.section-lbl { font-size:.65rem; font-weight:600; text-transform:uppercase; letter-spacing:.1em; color:var(--text3); }
.empty-state { text-align:center; padding:36px 20px; color:var(--text3); }
.empty-state p { font-size:.82rem; line-height:1.7; }
.toast { position:fixed; bottom:22px; left:50%; transform:translateX(-50%); background:var(--text1); color:var(--bg); font-size:.76rem; font-weight:500; padding:10px 20px; border-radius:20px; z-index:9999; pointer-events:none; opacity:0; transition:opacity .2s; white-space:nowrap; max-width:92vw; box-shadow:0 8px 24px rgba(0,0,0,.3); }
.toast.on { opacity:1; }
.divider { height:1px; background:var(--border); margin:16px 0; }

/* ═══ RESPONSIVE ═══ */
@media(max-width:640px) {
  .page { padding:16px 14px; }
  .kpi-strip { grid-template-columns:repeat(2,1fr); gap:10px; }
  .grid-2 { grid-template-columns:1fr; }
  .bt-kpis { grid-template-columns:repeat(3,1fr); }
  .tb-time,.tb-logo-tag,.chip-name { display:none; }
  .tn { font-size:.72rem; padding:5px 9px; }
  .bnav { display:flex !important; }
  body { padding-bottom:60px; }
}
.bnav { display:none; position:fixed; bottom:0; left:0; right:0; z-index:100; background:var(--card); border-top:1px solid var(--border); padding:6px 0 max(6px,env(safe-area-inset-bottom)); box-shadow:0 -4px 16px rgba(0,0,0,.1); }
.bnav { display:none; }
@media(max-width:640px) { .bnav { display:flex; } }
.bn { flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; cursor:pointer; padding:5px 0; font-size:.56rem; font-weight:600; color:var(--text3); transition:color .12s; border:none; background:none; font-family:'DM Sans',sans-serif; }
.bn.on { color:var(--blue2); }
.bn-icon { font-size:1.15rem; }
</style>
</head>
<body>

<!-- ═══ LOGIN ═══ -->
<div id="login-screen">
  <div class="login-card">
    <div class="login-header">
      <img src="${LS}" class="login-logo" alt="WAVESCOUT">
      <div class="login-brand">WAVESCOUT</div>
      <div class="login-sub">Dein Trading Signal Dashboard</div>
    </div>

    <div class="login-label">Account wählen</div>
    <div class="user-select">
      <div class="user-opt" onclick="pickUser('Marvin',this)">
        <div class="user-avatar u-M">M</div>
        <div class="user-name">Marvin</div>
      </div>
      <div class="user-opt" onclick="pickUser('Sandro',this)">
        <div class="user-avatar u-S">S</div>
        <div class="user-name">Sandro</div>
      </div>
      <div class="user-opt" onclick="pickUser('Iven',this)">
        <div class="user-avatar u-I">I</div>
        <div class="user-name">Iven</div>
      </div>
    </div>

    <div class="pw-section" id="pw-sec">
      <div class="pw-label">Passwort</div>
      <input type="password" class="pw-input" id="pw-in" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()">
      <div class="pw-hint" id="pw-hint"></div>
    </div>

    <button class="login-submit" id="login-btn" style="display:none" onclick="doLogin()">
      Anmelden →
    </button>
    <div class="login-error" id="login-err"></div>

    <div class="login-footer">
      <p>Made by <strong>WaveWatch</strong> &nbsp;·&nbsp; Made for Trader</p>
    </div>
  </div>
</div>

<!-- ═══ APP ═══ -->
<div class="app">

  <!-- TOPBAR -->
  <header class="topbar">
    <div class="tb-logo">
      <img src="${LS}" class="tb-logo-img" alt="">
      <span class="tb-logo-name">WAVESCOUT</span>
      <span class="tb-logo-tag">v3 · MTF</span>
    </div>

    <div class="tb-divider"></div>

    <nav class="tb-nav">
      <button class="tn on" onclick="go('home')">🏠 Home</button>
      <button class="tn" onclick="go('analyse')">🔍 Analyse</button>
      <button class="tn" onclick="go('signals')">📋 Signale</button>
      <button class="tn" onclick="go('backtest')">📊 Backtesting</button>
      <button class="tn" onclick="go('strategy')">📖 Strategie</button>
      <button class="tn" onclick="go('tools')">🔧 Tools</button>
      <button class="tn" onclick="go('telegram')">💬 Telegram</button>
    </nav>

    <div class="tb-actions">
      <div class="tb-time" id="tb-clk">–</div>
      <div class="live-pill"><div class="live-dot"></div>Live</div>
      <button class="theme-btn" onclick="toggleTheme()" id="theme-btn" title="Hellmodus wechseln">🌙</button>
      <div class="user-chip" onclick="logout()">
        <div class="chip-av" id="chip-av" style="background:linear-gradient(135deg,#1e40af,#3b82f6)">M</div>
        <span class="chip-name" id="chip-name">Marvin</span>
        <span class="chip-logout">Abmelden</span>
      </div>
    </div>
  </header>

  <!-- CONTENT -->
  <div class="content">

    <!-- HOME -->
    <div class="page on" id="page-home">
      <div class="page-hdr">
        <div class="page-hdr-top">
          <div>
            <div class="page-title" id="home-title">Guten Morgen, <em>Trader</em> 👋</div>
            <div class="page-sub">Hier ist dein Trading-Überblick für heute.</div>
          </div>
          <div class="page-date" id="home-date">–</div>
        </div>
      </div>

      <div class="kpi-strip">
        <div class="kpi-card kpi-blue">
          <div class="kpi-label">Offene Trades</div>
          <div class="kpi-value c-blue" id="kpi-open">–</div>
          <div class="kpi-footer">Warten auf Auflösung</div>
        </div>
        <div class="kpi-card kpi-green">
          <div class="kpi-label">Wins</div>
          <div class="kpi-value c-green" id="kpi-wins">–</div>
          <div class="kpi-footer">Profitable Trades</div>
        </div>
        <div class="kpi-card kpi-red">
          <div class="kpi-label">Losses</div>
          <div class="kpi-value c-red" id="kpi-losses">–</div>
          <div class="kpi-footer">Verlustbringende Trades</div>
        </div>
        <div class="kpi-card kpi-white">
          <div class="kpi-label">Winrate</div>
          <div class="kpi-value" id="kpi-wr" style="color:var(--text1)">–</div>
          <div class="kpi-footer">Trefferquote gesamt</div>
        </div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Schnell-Aktionen</div>
              <div class="card-subtitle">Das Wichtigste auf einen Klick</div>
            </div>
          </div>
          <div class="card-body">
            <div class="qa-grid">
              <div class="qa" onclick="go('analyse')">
                <div class="qa-icon">🔍</div>
                <div><div class="qa-label">Analyse starten</div><div class="qa-desc">Symbol per Claude prüfen</div></div>
              </div>
              <div class="qa" onclick="toolAction('morning')">
                <div class="qa-icon">🌅</div>
                <div><div class="qa-label">Morning Brief</div><div class="qa-desc">Tages-Bias abrufen</div></div>
              </div>
              <div class="qa" onclick="toolAction('outcomes')">
                <div class="qa-icon">🔄</div>
                <div><div class="qa-label">Outcomes sync</div><div class="qa-desc">WIN/LOSS via Binance</div></div>
              </div>
              <div class="qa" onclick="go('backtest')">
                <div class="qa-icon">📊</div>
                <div><div class="qa-label">Backtesting</div><div class="qa-desc">Statistiken ansehen</div></div>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-header">
            <div class="card-title">Letzte Signale</div>
            <button class="btn btn-ghost" onclick="go('signals')">Alle ansehen →</button>
          </div>
          <div class="card-body" id="home-signals">
            <div class="empty-state"><p>Lade Signale…</p></div>
          </div>
        </div>
      </div>

      <a class="wb-card" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank">
        <div class="wb-icon">🌊</div>
        <div>
          <div class="wb-title">WaveBoard öffnen</div>
          <div class="wb-sub">Dein externes Trading Dashboard</div>
        </div>
        <div class="wb-badge">↗ Öffnen</div>
      </a>
    </div>

    <!-- ANALYSE -->
    <div class="page" id="page-analyse">
      <div class="page-hdr">
        <div class="page-title">Analyse</div>
        <div class="page-sub">Klicke auf „Prüfen" um Claude eine sofortige Analyse des aktuellen Snapshots zu erstellen.</div>
      </div>
      <div class="section-hdr">
        <div class="section-lbl">Aktuelle Snapshots</div>
        <button class="btn btn-ghost" onclick="loadSnapshots()">↻ Refresh</button>
      </div>
      <div id="snap-list"><div class="empty-state"><p>Lade…</p></div></div>
    </div>

    <!-- SIGNALE -->
    <div class="page" id="page-signals">
      <div class="page-hdr">
        <div class="page-title">Signale</div>
        <div class="page-sub">Alle erkannten Signale — filter und sortier nach deinen Bedürfnissen.</div>
      </div>
      <div class="filter-row">
        <select class="f-select" id="f-sym" onchange="applyFilters()">
          <option value="">Alle Symbole</option>
        </select>
        <select class="f-select" id="f-out" onchange="applyFilters()" style="flex:.75">
          <option value="">Alle Status</option>
          <option value="OPEN">Open</option>
          <option value="WIN">Win</option>
          <option value="LOSS">Loss</option>
          <option value="SKIPPED">Skipped</option>
        </select>
        <button class="sort-pill on" id="sort-sc" onclick="setSort('score')">Score ↓</button>
        <button class="sort-pill" id="sort-tm" onclick="setSort('time')">Neueste ↓</button>
      </div>
      <div id="sig-list"><div class="empty-state"><p>Lade…</p></div></div>
    </div>

    <!-- BACKTESTING -->
    <div class="page" id="page-backtest">
      <div class="page-hdr">
        <div class="page-title">Backtesting</div>
        <div class="page-sub">Auswertung deiner Trades — Winrate, Score-Analyse und die besten und schlechtesten Signale.</div>
      </div>
      <div class="bt-tabs">
        <button class="bt-tab on" onclick="btSetPeriod('all',this)">Gesamt</button>
        <button class="bt-tab" onclick="btSetPeriod('month',this)">30 Tage</button>
        <button class="bt-tab" onclick="btSetPeriod('week',this)">7 Tage</button>
      </div>
      <div id="bt-content"><div class="empty-state"><p>Lade…</p></div></div>
    </div>

    <!-- STRATEGIE -->
    <div class="page" id="page-strategy">
      <div class="page-hdr">
        <div class="page-title">Strategie</div>
        <div class="page-sub">Top-Down Daytrading — deine vollständige Strategie auf einen Blick.</div>
      </div>

      <div class="str-card">
        <div class="str-hdr"><div class="str-icon">🎯</div><div class="str-title">Der 3-Schritt-Prozess</div></div>
        <div class="str-body">
          <div class="str-step">
            <div class="str-num">1</div>
            <div><div class="str-st">Morgen-Routine (10 Min)</div><div class="str-tx">4H Chart öffnen → EMA200 prüfen. Preis <strong>darüber = Long-Bias</strong>, darunter = Short-Bias. EMA flach = kein Trade heute. 1–2 Key-Zonen auf 15min markieren.</div></div>
          </div>
          <div class="str-step">
            <div class="str-num">2</div>
            <div><div class="str-st">Zonenanalyse (15min)</div><div class="str-tx">Warten bis der Preis eine markierte Zone erreicht. <strong>Nicht hinterherlaufen.</strong> Higher Low (Long) oder Lower High (Short) sichtbar. Kein Chaos, kein Seitwärtsmarkt.</div></div>
          </div>
          <div class="str-step">
            <div class="str-num">3</div>
            <div><div class="str-st">Entry (5–10min)</div><div class="str-tx">Klare Trendkerze, <strong>starker Body, wenig Docht.</strong> Bruch von lokalem High (Long) oder Low (Short) abwarten. RSI als Filter — kein alleiniges Signal.</div></div>
          </div>
        </div>
      </div>

      <div class="str-card">
        <div class="str-hdr"><div class="str-icon">📏</div><div class="str-title">Entry-Regeln (alle müssen erfüllt sein)</div></div>
        <div class="str-body">
          <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>RSI Long:</strong> 30–55 steigend. <strong>Short:</strong> 45–70 fallend. Kein Entry bei RSI über 70 oder unter 30.</div></div>
          <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>EMA200 (4H):</strong> Preis darüber = nur Long. Preis darunter = nur Short. Gegen Bias = kein Trade.</div></div>
          <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>Trendstruktur:</strong> EMA50 über EMA200 (Long) oder darunter (Short). Neutral = kein Trade.</div></div>
          <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>Zone:</strong> Long nah an Support. Short nah an Resistance. Genug Abstand zur Gegenseite.</div></div>
          <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>R/R:</strong> Mindestens 1:1.5 — Ziel 1:2. SL logisch unter/über Struktur platziert.</div></div>
        </div>
      </div>

      <div class="str-card">
        <div class="str-hdr"><div class="str-icon">🚫</div><div class="str-title">Kein Trade — sofort raus wenn eines zutrifft</div></div>
        <div class="str-body">
          <div class="no-list">
            <div class="no-item">❌ Trade läuft gegen den Tages-Bias</div>
            <div class="no-item">❌ EMA200 auf 4H flach oder Preis direkt dran</div>
            <div class="no-item">❌ Viele Wicks, Chaos, kein klares Bild</div>
            <div class="no-item">❌ FOMO-Gefühl — man will unbedingt rein</div>
            <div class="no-item">❌ RSI extrem überkauft (über 70) oder überverkauft (unter 30)</div>
            <div class="no-item">❌ Man könnte den Trade nicht klar erklären</div>
          </div>
        </div>
      </div>

      <div class="str-card">
        <div class="str-hdr"><div class="str-icon">✔️</div><div class="str-title">Final Check — alle 3 mit Ja?</div></div>
        <div class="str-body">
          <div class="str-rule"><div class="str-ri">☑️</div><div class="str-rt">Passt der Trade zum heutigen Tages-Bias?</div></div>
          <div class="str-rule"><div class="str-ri">☑️</div><div class="str-rt">Könnte ich diesen Trade einem anderen Trader erklären?</div></div>
          <div class="str-rule"><div class="str-ri">☑️</div><div class="str-rt">Bin ich ruhig und klar im Kopf? — Wenn nein: warten.</div></div>
        </div>
      </div>

      <div class="str-card">
        <div class="str-hdr"><div class="str-icon">💱</div><div class="str-title">Empfohlene Instrumente</div></div>
        <div class="str-body">
          <table class="sym-table">
            <tr><th>Symbol</th><th>Priorität</th><th>Begründung</th></tr>
            <tr><td><strong>BTC/USDT</strong></td><td><span class="tag t-win">Primär</span></td><td style="font-size:.74rem;color:var(--text3)">Höchste Liquidität, klarste Strukturen</td></tr>
            <tr><td><strong>ETH/USDT</strong></td><td><span class="tag t-open">Sekundär</span></td><td style="font-size:.74rem;color:var(--text3)">Ähnlich sauber, etwas mehr Bewegung</td></tr>
            <tr><td><strong>SOL/USDT</strong></td><td><span class="tag t-skip">Optional</span></td><td style="font-size:.74rem;color:var(--text3)">Nur bei klar trendendem Markt</td></tr>
          </table>
        </div>
      </div>
    </div>

    <!-- TOOLS -->
    <div class="page" id="page-tools">
      <div class="page-hdr">
        <div class="page-title">Tools</div>
        <div class="page-sub">Aktionen, Links und externe Dienste auf einen Blick.</div>
      </div>

      <a class="wb-card" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank" style="display:flex;margin-bottom:20px">
        <div class="wb-icon">🌊</div>
        <div><div class="wb-title">WaveBoard Dashboard</div><div class="wb-sub">waveboard-e54ed.web.app</div></div>
        <div class="wb-badge">↗ Öffnen</div>
      </a>

      <div class="tl-section">
        <div class="tl-label">System-Aktionen</div>
        <div class="tl-list">
          <div class="tl-row" onclick="toolAction('health')"><div class="tl-icon">💚</div><div class="tl-info"><div class="tl-l">Health Check</div><div class="tl-d">Worker Status und Verfügbarkeit prüfen</div></div><div class="tl-arr">›</div></div>
          <div class="tl-row" onclick="toolAction('telegram')"><div class="tl-icon">📨</div><div class="tl-info"><div class="tl-l">Telegram testen</div><div class="tl-d">Test-Nachricht an Telegram senden</div></div><div class="tl-arr">›</div></div>
          <div class="tl-row" onclick="toolAction('morning')"><div class="tl-icon">🌅</div><div class="tl-info"><div class="tl-l">Morning Brief senden</div><div class="tl-d">Tages-Bias für alle Symbole abrufen</div></div><div class="tl-arr">›</div></div>
          <div class="tl-row" onclick="toolAction('outcomes')"><div class="tl-icon">🔄</div><div class="tl-info"><div class="tl-l">Outcome Tracking</div><div class="tl-d">WIN/LOSS automatisch via Binance prüfen</div></div><div class="tl-arr">›</div></div>
        </div>
      </div>

      <div class="tl-section">
        <div class="tl-label">Externe Links</div>
        <div class="tl-list">
          <a class="tl-row" href="https://tradingview.com" target="_blank"><div class="tl-icon">📊</div><div class="tl-info"><div class="tl-l">TradingView</div><div class="tl-d">Charts & Alert-Verwaltung</div></div><div class="tl-arr">↗</div></a>
          <a class="tl-row" href="https://dash.cloudflare.com" target="_blank"><div class="tl-icon">☁️</div><div class="tl-info"><div class="tl-l">Cloudflare Dashboard</div><div class="tl-d">Worker, Logs und Einstellungen</div></div><div class="tl-arr">↗</div></a>
          <a class="tl-row" href="https://github.com/spnni08/tradingview-bot" target="_blank"><div class="tl-icon">🐙</div><div class="tl-info"><div class="tl-l">GitHub Repository</div><div class="tl-d">spnni08/tradingview-bot</div></div><div class="tl-arr">↗</div></a>
          <a class="tl-row" href="https://console.anthropic.com" target="_blank"><div class="tl-icon">🤖</div><div class="tl-info"><div class="tl-l">Anthropic Console</div><div class="tl-d">Claude API Keys & Usage</div></div><div class="tl-arr">↗</div></a>
        </div>
      </div>
    </div>

    <!-- TELEGRAM -->
    <div class="page" id="page-telegram">
      <div class="page-hdr">
        <div class="page-title">Telegram Kommandos</div>
        <div class="page-sub">Tippe direkt in Telegram — oder klicke hier zum Kopieren.</div>
      </div>
      <div class="cmd-intro">
        💡 <strong>Tipp:</strong> Schicke diese Kommandos einfach in deinen Telegram-Chat mit dem WAVESCOUT Bot. Du bekommst sofort eine KI-Analyse zurück.
      </div>
      <div class="cmd-grid">
        <div class="cmd-row" onclick="copyCmd('/btc')"><div><div class="cmd-code">/btc</div><div class="cmd-desc">Bitcoin sofort analysieren</div></div><div class="cmd-copy">⎘</div></div>
        <div class="cmd-row" onclick="copyCmd('/eth')"><div><div class="cmd-code">/eth</div><div class="cmd-desc">Ethereum analysieren</div></div><div class="cmd-copy">⎘</div></div>
        <div class="cmd-row" onclick="copyCmd('/sol')"><div><div class="cmd-code">/sol</div><div class="cmd-desc">Solana analysieren</div></div><div class="cmd-copy">⎘</div></div>
        <div class="cmd-row" onclick="copyCmd('/check RENDERUSDT')"><div><div class="cmd-code">/check SYMBOL</div><div class="cmd-desc">Beliebiges Symbol analysieren</div></div><div class="cmd-copy">⎘</div></div>
        <div class="cmd-row" onclick="copyCmd('/status')"><div><div class="cmd-code">/status</div><div class="cmd-desc">Winrate & Stats abrufen</div></div><div class="cmd-copy">⎘</div></div>
        <div class="cmd-row" onclick="copyCmd('/brief')"><div><div class="cmd-code">/brief</div><div class="cmd-desc">Morning Brief jetzt senden</div></div><div class="cmd-copy">⎘</div></div>
        <div class="cmd-row" onclick="copyCmd('/open')"><div><div class="cmd-code">/open</div><div class="cmd-desc">Alle offenen Trades anzeigen</div></div><div class="cmd-copy">⎘</div></div>
        <div class="cmd-row" onclick="copyCmd('/top')"><div><div class="cmd-code">/top</div><div class="cmd-desc">Beste Signale der letzten 24h</div></div><div class="cmd-copy">⎘</div></div>
        <div class="cmd-row" onclick="copyCmd('/hilfe')"><div><div class="cmd-code">/hilfe</div><div class="cmd-desc">Alle Kommandos anzeigen</div></div><div class="cmd-copy">⎘</div></div>
      </div>
    </div>

  </div><!-- /content -->
</div><!-- /app -->

<!-- BOTTOM NAV (mobile) -->
<nav class="bnav" id="bnav">
  <button class="bn on" onclick="go('home')"><span class="bn-icon">🏠</span>Home</button>
  <button class="bn" onclick="go('analyse')"><span class="bn-icon">🔍</span>Analyse</button>
  <button class="bn" onclick="go('signals')"><span class="bn-icon">📋</span>Signale</button>
  <button class="bn" onclick="go('backtest')"><span class="bn-icon">📊</span>Backtest</button>
  <button class="bn" onclick="go('tools')"><span class="bn-icon">🔧</span>Tools</button>
</nav>

<div class="toast" id="toast"></div>

<script>
const SECRET = new URLSearchParams(location.search).get('secret') || '';
const USERS = {
  Marvin: { bg:'linear-gradient(135deg,#1e40af,#3b82f6)', i:'M' },
  Sandro: { bg:'linear-gradient(135deg,#0369a1,#2563eb)', i:'S' },
  Iven:   { bg:'linear-gradient(135deg,#065f46,#059669)', i:'I' }
};
let selUser = null, allSignals = [], sortMode = 'score', btData = null, btPeriod = 'all';

/* ── THEME ── */
function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('theme-btn').textContent = isDark ? '🌙' : '☀️';
  localStorage.setItem('ws_theme', isDark ? 'light' : 'dark');
}
(function initTheme() {
  const t = localStorage.getItem('ws_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', t);
  document.getElementById('theme-btn').textContent = t === 'dark' ? '🌙' : '☀️';
})();

/* ── AUTH ── */
function checkAuth() {
  const u = localStorage.getItem('ws_user');
  if (!u || !localStorage.getItem('ws_pw_' + u)) return false;
  loginSuccess(u); return true;
}
function pickUser(name, el) {
  selUser = name;
  document.querySelectorAll('.user-opt').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  const hasPw = localStorage.getItem('ws_pw_' + name);
  document.getElementById('pw-sec').classList.add('show');
  document.getElementById('login-btn').style.display = 'block';
  document.getElementById('pw-in').value = '';
  document.getElementById('login-err').textContent = '';
  document.getElementById('pw-hint').textContent = hasPw
    ? 'Willkommen zurueck, ' + name + '!'
    : 'Erste Anmeldung: Lege jetzt dein persoenliches Passwort fest.';
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
    loginSuccess(selUser);
  } else if (stored === pw) {
    localStorage.setItem('ws_user', selUser);
    loginSuccess(selUser);
  } else {
    document.getElementById('login-err').textContent = 'Falsches Passwort. Bitte erneut versuchen.';
    document.getElementById('pw-in').value = '';
    document.getElementById('pw-in').focus();
  }
}
function loginSuccess(name) {
  const screen = document.getElementById('login-screen');
  screen.classList.add('hidden');
  setTimeout(() => screen.classList.add('gone'), 300);
  const u = USERS[name] || USERS.Marvin;
  document.getElementById('chip-av').style.background = u.bg;
  document.getElementById('chip-av').textContent = u.i;
  document.getElementById('chip-name').textContent = name;
  updateGreeting(name);
  loadHome();
}
function logout() {
  localStorage.removeItem('ws_user');
  const screen = document.getElementById('login-screen');
  screen.classList.remove('gone', 'hidden');
  document.querySelectorAll('.user-opt').forEach(b => b.classList.remove('active'));
  document.getElementById('pw-sec').classList.remove('show');
  document.getElementById('login-btn').style.display = 'none';
  document.getElementById('login-err').textContent = '';
  selUser = null;
}

/* ── CLOCK ── */
const DAYS = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
const MONTHS = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
function updateGreeting(name) {
  const h = new Date().getHours();
  const g = h < 12 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
  const now = new Date();
  const titleEl = document.getElementById('home-title');
  const dateEl = document.getElementById('home-date');
  if (titleEl) titleEl.innerHTML = g + ', <em>' + (name || 'Trader') + '</em> 👋';
  if (dateEl) dateEl.textContent = DAYS[now.getDay()] + ', ' + now.getDate() + '. ' + MONTHS[now.getMonth()] + ' ' + now.getFullYear();
}
setInterval(() => {
  document.getElementById('tb-clk').textContent = new Date().toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const u = localStorage.getItem('ws_user');
  if (u) updateGreeting(u);
}, 1000);

/* ── UTILS ── */
const fmt = (n, d=2) => (!n && n!==0) ? '–' : Number(n).toLocaleString('de-DE', {minimumFractionDigits:d, maximumFractionDigits:d});
function timeAgo(ts) { const d=Date.now()-ts; if(d<60000)return'jetzt'; if(d<3600000)return Math.floor(d/60000)+'m'; if(d<86400000)return Math.floor(d/3600000)+'h'; return Math.floor(d/86400000)+'d'; }
const scoreColor = s => s>=70 ? 'var(--green)' : s>=50 ? 'var(--amber)' : 'var(--red)';
function showToast(msg, dur=2500) { const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('on'); setTimeout(()=>t.classList.remove('on'),dur); }

/* ── NAV ── */
const PAGES = ['home','analyse','signals','backtest','strategy','tools','telegram'];
function go(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('on'));
  document.querySelectorAll('.tn').forEach((b,i) => b.classList.toggle('on', PAGES[i]===name));
  document.querySelectorAll('.bn').forEach((b,i) => b.classList.toggle('on', ['home','analyse','signals','backtest','tools'][i]===name));
  document.getElementById('page-'+name).classList.add('on');
  if (name==='analyse') loadSnapshots();
  if (name==='signals') loadSignals();
  if (name==='backtest') loadBacktest();
  if (name==='home') loadHome();
}

/* ── STATS ── */
async function loadStats() {
  const s = await fetch('/stats').then(r=>r.json()).catch(()=>({}));
  document.getElementById('kpi-open').textContent = s.open||0;
  document.getElementById('kpi-wins').textContent = s.wins||0;
  document.getElementById('kpi-losses').textContent = s.losses||0;
  document.getElementById('kpi-wr').textContent = (s.winrate||0)+'%';
}

/* ── HOME ── */
async function loadHome() {
  await loadStats();
  const hist = await fetch('/history').then(r=>r.json()).catch(()=>[]);
  const el = document.getElementById('home-signals');
  if (!hist.length) { el.innerHTML = '<div class="empty-state"><p>Noch keine Signale. TradingView muss erst Daten senden.</p></div>'; return; }
  el.innerHTML = hist.slice(0,5).map(x => {
    const s = Number(x.ai_score)||0;
    const L = x.ai_direction === 'LONG';
    return \`<div class="sig-mini">
      <div class="dir-pill \${L?'dir-L':'dir-S'}">\${L?'L':'S'}</div>
      <div class="sig-info">
        <div class="sig-sym">\${x.symbol||'–'}</div>
        <div class="sig-trig">\${x.trigger||'–'}</div>
      </div>
      <div class="sig-meta">
        <div class="sig-score" style="color:\${scoreColor(s)}">\${s}/100</div>
        <div class="sig-ago">\${timeAgo(x.created_at)}</div>
      </div>
    </div>\`;
  }).join('');
}

/* ── SNAPSHOTS ── */
async function loadSnapshots() {
  const el = document.getElementById('snap-list');
  el.innerHTML = '<div class="empty-state"><p>Lade…</p></div>';
  const snaps = await fetch('/snapshots').then(r=>r.json()).catch(()=>[]);
  if (!snaps.length) { el.innerHTML = '<div class="empty-state"><p>Noch keine Snapshots vorhanden.<br>TradingView muss erst Daten senden.</p></div>'; return; }
  el.innerHTML = snaps.map(s => \`<div>
    <div class="snap-item">
      <div style="flex:1;min-width:0">
        <div class="snap-sym">\${s.symbol}</div>
        <div class="snap-meta">RSI \${fmt(s.rsi,1)} · EMA50 \${fmt(s.ema50,0)} · Trend: \${s.trend||'–'}</div>
      </div>
      <div class="snap-price">\${fmt(s.price)}</div>
      <button class="btn btn-primary" onclick="runAnalysis('\${s.symbol}',this)" \${SECRET?'':'disabled'} style="font-size:.68rem;padding:7px 14px">
        \${SECRET ? '🔍 Prüfen' : '🔒 Secret'}
      </button>
    </div>
    <div class="result-box" id="res-\${s.symbol}" style="display:none"></div>
  </div>\`).join('');
}

/* ── ANALYSIS ── */
async function runAnalysis(sym, btn) {
  btn.disabled = true; btn.textContent = '⏳';
  const el = document.getElementById('res-'+sym);
  try {
    const d = await fetch('/ask?symbol='+encodeURIComponent(sym)+'&secret='+encodeURIComponent(SECRET)).then(r=>r.json());
    if (d.error) throw new Error(d.error);
    const ai = d.ai||{}, s = Number(ai.score)||0, rec = ai.recommendation==='RECOMMENDED';
    const rr = (ai.entry&&ai.take_profit&&ai.stop_loss) ? (Math.abs(ai.take_profit-ai.entry)/Math.abs(ai.entry-ai.stop_loss)).toFixed(2) : null;
    el.style.display = 'block';
    el.innerHTML = \`
      <div class="result-top">
        <span class="rec-badge \${rec?'rec-yes':'rec-no'}">\${rec?'✓ Empfohlen':'✗ Nicht empfohlen'}</span>
        <span style="font-family:'DM Mono',monospace;font-size:.85rem;font-weight:500;color:\${scoreColor(s)}">\${s}/100</span>
      </div>
      <div class="result-body">
        <div class="res-row"><span class="res-k">Richtung</span><span class="res-v">\${ai.direction||'–'}</span></div>
        <div class="res-row"><span class="res-k">Risiko</span><span class="res-v">\${ai.risk||'–'}</span></div>
        <div class="res-row"><span class="res-k">Confidence</span><span class="res-v">\${ai.confidence||0}%</span></div>
        \${rr ? '<div class="res-row"><span class="res-k">R/R</span><span class="res-v">1:'+rr+'</span></div>' : ''}
        <div class="progress"><div class="progress-fill" style="width:\${s}%;background:\${scoreColor(s)}"></div></div>
        <div class="res-plan">
          <div class="plan-box"><div class="plan-l">Entry</div><div class="plan-v" style="color:var(--blue3)">\${fmt(ai.entry)}</div></div>
          <div class="plan-box"><div class="plan-l">Take Profit</div><div class="plan-v" style="color:var(--green)">\${fmt(ai.take_profit)}</div></div>
          <div class="plan-box"><div class="plan-l">Stop Loss</div><div class="plan-v" style="color:var(--red)">\${fmt(ai.stop_loss)}</div></div>
        </div>
        <div class="res-reason">\${ai.reason||''}</div>
      </div>
    \`;
    showToast(rec ? '✅ Empfohlen!' : '⛔ Nicht empfohlen');
  } catch(e) {
    el.style.display = 'block';
    el.innerHTML = '<div style="padding:14px 16px;color:var(--red);font-size:.74rem">Fehler: '+e.message+'</div>';
  }
  btn.disabled = false; btn.textContent = '🔍 Prüfen';
}

/* ── SIGNALS ── */
async function loadSignals() {
  const el = document.getElementById('sig-list');
  el.innerHTML = '<div class="empty-state"><p>Lade…</p></div>';
  allSignals = await fetch('/history').then(r=>r.json()).catch(()=>[]);
  const syms = [...new Set(allSignals.map(x=>x.symbol).filter(Boolean))];
  const sel = document.getElementById('f-sym');
  sel.innerHTML = '<option value="">Alle Symbole</option>' + syms.map(s=>'<option value="'+s+'">'+s+'</option>').join('');
  applyFilters();
}
function setSort(m) {
  sortMode = m;
  document.getElementById('sort-sc').classList.toggle('on', m==='score');
  document.getElementById('sort-tm').classList.toggle('on', m==='time');
  applyFilters();
}
function applyFilters() {
  const sym = document.getElementById('f-sym').value;
  const out = document.getElementById('f-out').value;
  let f = [...allSignals];
  if (sym) f = f.filter(x => x.symbol===sym);
  if (out) f = f.filter(x => x.outcome===out);
  if (sortMode==='score') f.sort((a,b) => (b.ai_score||0)-(a.ai_score||0));
  else f.sort((a,b) => b.created_at-a.created_at);
  const el = document.getElementById('sig-list');
  if (!f.length) { el.innerHTML = '<div class="empty-state"><p>Keine Signale für diese Filter.</p></div>'; return; }
  el.innerHTML = f.map(x => {
    const s = Number(x.ai_score)||0;
    const oc = x.outcome==='WIN'?'t-win':x.outcome==='LOSS'?'t-loss':x.outcome==='SKIPPED'?'t-skip':'t-open';
    const rc = x.ai_recommendation==='RECOMMENDED'?'t-rec':'t-nrec';
    const rk = x.ai_risk==='HIGH'?'t-hi':x.ai_risk==='MEDIUM'?'t-med':'t-lo';
    const isOpen = x.outcome==='OPEN';
    const L = x.ai_direction==='LONG';
    return \`<div class="signal-card">
      <div class="sc-top">
        <div>
          <div class="sc-sym">\${x.symbol||'–'}</div>
          <span class="sc-dir \${L?'L':'S'}">\${x.ai_direction||'–'}</span>
        </div>
        <div class="sc-right">
          <div class="sc-score" style="color:\${scoreColor(s)}">\${s}/100</div>
          <div class="sc-age">\${timeAgo(x.created_at)}</div>
        </div>
      </div>
      <div class="sc-prices">
        <span>Entry: \${fmt(x.ai_entry)}</span>
        <span style="color:var(--green)">TP: \${fmt(x.ai_take_profit)}</span>
        <span style="color:var(--red)">SL: \${fmt(x.ai_stop_loss)}</span>
      </div>
      <div class="progress" style="margin-bottom:10px"><div class="progress-fill" style="width:\${s}%;background:\${scoreColor(s)}"></div></div>
      <div class="sc-footer">
        <div class="tags">
          <span class="tag \${rc}">\${x.ai_recommendation==='RECOMMENDED'?'Empfohlen':'Nicht empf.'}</span>
          <span class="tag \${rk}">\${x.ai_risk||'–'}</span>
          <span class="tag \${oc}" id="out-\${x.id}">\${x.outcome||'–'}</span>
        </div>
        \${isOpen && SECRET ? \`<div class="outcome-btns">
          <button class="ob ob-w" onclick="setOutcome('\${x.id}','WIN',this)">✓ WIN</button>
          <button class="ob ob-l" onclick="setOutcome('\${x.id}','LOSS',this)">✗ LOSS</button>
          <button class="ob ob-s" onclick="setOutcome('\${x.id}','SKIPPED',this)">— Skip</button>
        </div>\` : ''}
      </div>
    </div>\`;
  }).join('');
}
async function setOutcome(id, outcome, btn) {
  const all = btn.parentElement.querySelectorAll('.ob');
  all.forEach(b => b.disabled=true);
  try {
    const r = await fetch('/outcome?id='+id+'&outcome='+outcome+'&secret='+encodeURIComponent(SECRET), {method:'POST'}).then(r=>r.json());
    if (r.status==='ok') {
      const badge = document.getElementById('out-'+id);
      if (badge) { badge.className='tag '+(outcome==='WIN'?'t-win':outcome==='LOSS'?'t-loss':'t-skip'); badge.textContent=outcome; }
      btn.parentElement.style.display = 'none';
      loadStats();
      showToast(outcome==='WIN' ? '🏆 WIN gespeichert!' : outcome==='LOSS' ? '❌ LOSS gespeichert!' : '— Als Skip markiert');
    }
  } catch(e) { all.forEach(b=>b.disabled=false); showToast('Fehler: '+e.message); }
}

/* ── BACKTESTING ── */
async function loadBacktest() {
  const el = document.getElementById('bt-content');
  el.innerHTML = '<div class="empty-state"><p>Lade…</p></div>';
  btData = await fetch('/backtesting').then(r=>r.json()).catch(()=>null);
  if (!btData || btData.error) { el.innerHTML = '<div class="empty-state"><p>Fehler beim Laden der Daten.</p></div>'; return; }
  renderBacktest(btPeriod);
}
function btSetPeriod(p, btn) {
  btPeriod = p;
  document.querySelectorAll('.bt-tab').forEach(t => t.classList.remove('on'));
  btn.classList.add('on');
  renderBacktest(p);
}
function renderBacktest(p) {
  if (!btData) return;
  const el = document.getElementById('bt-content');
  const d = p==='week' ? btData.week : p==='month' ? btData.month : btData.overall;
  const closed = (d.wins||0) + (d.losses||0);
  const wr = closed > 0 ? ((d.wins/closed)*100).toFixed(1) : 0;
  const o = btData.overall;
  let html = \`
  <div class="bt-kpis">
    <div class="bt-kpi"><div class="bt-kv" style="color:var(--green)">\${d.wins||0}</div><div class="bt-kl">Wins</div></div>
    <div class="bt-kpi"><div class="bt-kv" style="color:var(--red)">\${d.losses||0}</div><div class="bt-kl">Losses</div></div>
    <div class="bt-kpi"><div class="bt-kv" style="color:var(--blue3)">\${wr}%</div><div class="bt-kl">Winrate</div></div>
  </div>
  <div class="score-cmp">
    <div class="sc-title">Durchschnittlicher Score — WIN vs. LOSS</div>
    <div class="sc-row">
      <div class="sc-lbl" style="color:var(--green)">WIN</div>
      <div class="sc-bar"><div class="sc-fill" style="width:\${o.avg_score_win||0}%;background:var(--green)"></div></div>
      <div class="sc-num" style="color:var(--green)">\${o.avg_score_win||0}</div>
    </div>
    <div class="sc-row">
      <div class="sc-lbl" style="color:var(--red)">LOSS</div>
      <div class="sc-bar"><div class="sc-fill" style="width:\${o.avg_score_loss||0}%;background:var(--red)"></div></div>
      <div class="sc-num" style="color:var(--red)">\${o.avg_score_loss||0}</div>
    </div>
  </div>\`;

  if (btData.bySymbol?.length) {
    html += \`<div class="card" style="margin-bottom:14px">
      <div class="card-header"><div class="card-title">Winrate pro Symbol</div></div>
      <div style="padding:0 4px">
        <table class="sym-table">
          <tr><th>Symbol</th><th>Wins</th><th>Losses</th><th>Winrate</th><th>Ø Score</th></tr>
          \${btData.bySymbol.map(s=>{const c=(s.wins||0)+(s.losses||0);const w=c>0?((s.wins/c)*100).toFixed(0):0;return\`<tr>
            <td><strong>\${s.symbol}</strong></td>
            <td style="color:var(--green)">\${s.wins||0}</td>
            <td style="color:var(--red)">\${s.losses||0}</td>
            <td style="font-family:'DM Mono',monospace;font-weight:500;color:var(--blue3)">\${w}%</td>
            <td style="font-family:'DM Mono',monospace;color:var(--text2)">\${Number(s.avg_score||0).toFixed(0)}</td>
          </tr>\`;}).join('')}
        </table>
      </div>
    </div>\`;
  }

  if (btData.best?.length) {
    html += \`<div class="card" style="margin-bottom:14px">
      <div class="card-header"><div class="card-title">🏆 Beste Signale (WIN)</div></div>
      <div class="card-body">
        \${btData.best.map(x=>\`<div class="bt-row">
          <div><div class="bt-sym">\${x.symbol} <span style="color:var(--green);font-size:.65rem;font-weight:600">\${x.ai_direction}</span></div>
          <div class="bt-sub">Entry: \${fmt(x.ai_entry)} → TP: \${fmt(x.ai_take_profit)}</div></div>
          <div class="bt-sc" style="color:var(--green)">\${x.ai_score}/100</div>
        </div>\`).join('')}
      </div>
    </div>\`;
  }

  if (btData.worst?.length) {
    html += \`<div class="card">
      <div class="card-header"><div class="card-title">📉 Schlechteste Signale (LOSS)</div></div>
      <div class="card-body">
        \${btData.worst.map(x=>\`<div class="bt-row">
          <div><div class="bt-sym">\${x.symbol} <span style="color:var(--red);font-size:.65rem;font-weight:600">\${x.ai_direction}</span></div>
          <div class="bt-sub">Entry: \${fmt(x.ai_entry)} · SL: \${fmt(x.ai_stop_loss)}</div></div>
          <div class="bt-sc" style="color:var(--red)">\${x.ai_score}/100</div>
        </div>\`).join('')}
      </div>
    </div>\`;
  }

  el.innerHTML = html;
}

/* ── TOOLS ── */
async function toolAction(a) {
  if (!SECRET && a !== 'health') { showToast('⚠️ Secret in URL benoetigt'); return; }
  showToast('Wird ausgefuehrt…');
  try {
    if (a==='health') { const d=await fetch('/health').then(r=>r.json()); showToast('✅ Worker OK — '+new Date(d.time).toLocaleTimeString('de-DE'), 3000); }
    else if (a==='telegram') { await fetch('/test-telegram?secret='+encodeURIComponent(SECRET)); showToast('📨 Telegram Test gesendet!'); }
    else if (a==='morning') { await fetch('/morning-brief?secret='+encodeURIComponent(SECRET)); showToast('🌅 Morning Brief gesendet!'); }
    else if (a==='outcomes') { const d=await fetch('/check-outcomes?secret='+encodeURIComponent(SECRET)).then(r=>r.json()); showToast('🔄 '+(d.result?.closed||0)+' Trades aktualisiert', 3000); }
  } catch(e) { showToast('❌ Fehler: '+e.message); }
}

/* ── COPY ── */
function copyCmd(c) { navigator.clipboard.writeText(c).then(()=>showToast('📋 Kopiert: '+c)); }

/* ── INIT ── */
if (!checkAuth()) { /* login shown */ }
</script>
</body>
</html>`;
}
