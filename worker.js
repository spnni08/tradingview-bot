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
  const LG = `<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#3b82f6"/><stop offset="100%" style="stop-color:#93c5fd"/></linearGradient></defs><rect width="80" height="80" rx="18" fill="#0a1628"/><g stroke="url(#g)" stroke-width="2.8" fill="none" stroke-linecap="round"><line x1="40" y1="46" x2="40" y2="62"/><rect x="30" y="62" width="20" height="6" rx="3"/><circle cx="40" cy="42" r="4" fill="url(#g)" stroke="none"/><path d="M28 36 C22 30 22 21 25 15"/><path d="M52 36 C58 30 58 21 55 15"/><path d="M33 39 C29 34 29 27 31 22"/><path d="M47 39 C51 34 51 27 49 22"/></g></svg>`;
  const LS = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(LG);
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>WAVESCOUT</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#060e1d;
  --s1:#091525;
  --s2:#0d1e35;
  --s3:#102242;
  --ln:#1a3254;
  --ln2:#1f3d65;
  --b:#2563eb;
  --b2:#3b7bff;
  --b3:#60a5fa;
  --b4:#93c5fd;
  --bg:#e8f4ff;
  --glow:rgba(37,99,235,.2);
  --dim:rgba(37,99,235,.1);
  --gr:#10b981;
  --rd:#f43f5e;
  --am:#f59e0b;
  --t1:#f0f6ff;
  --t2:rgba(240,246,255,.65);
  --t3:rgba(240,246,255,.35);
  --t4:rgba(240,246,255,.12);
  --t5:rgba(240,246,255,.05);
  --f:'Inter',sans-serif;
  --m:'JetBrains Mono',monospace;
  --r:10px
}
html,body{height:100%;font-family:var(--f);background:#060e1d;color:var(--t2);overflow-x:hidden}

/* LOGIN */
#LG{position:fixed;inset:0;z-index:300;background:#060e1d;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
#LG.h{display:none}
.lg-glow{position:absolute;width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,rgba(37,99,235,.08) 0%,transparent 70%);top:50%;left:50%;transform:translate(-50%,-55%);pointer-events:none}
.lg-wrap{position:relative;z-index:1;width:100%;max-width:360px;display:flex;flex-direction:column;align-items:center}
.lg-logo{width:56px;height:56px;margin-bottom:12px}
.lg-brand{font-size:1.5rem;font-weight:800;color:var(--t1);letter-spacing:.08em;margin-bottom:2px}
.lg-tag{font-size:.62rem;color:var(--t3);text-transform:uppercase;letter-spacing:.14em;margin-bottom:28px}
.lg-box{width:100%;background:var(--s1);border:1px solid var(--ln);border-radius:14px;padding:22px 20px}
.lg-who{font-size:.65rem;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.1em;margin-bottom:13px}
.lg-users{display:flex;gap:9px;margin-bottom:18px}
.lg-u{flex:1;background:var(--s2);border:2px solid var(--ln);border-radius:9px;padding:14px 6px;cursor:pointer;text-align:center;transition:all .15s;font-family:var(--f)}
.lg-u:hover{border-color:var(--b2)}
.lg-u.ok{border-color:var(--b2);background:var(--dim)}
.lg-av{width:36px;height:36px;border-radius:50%;margin:0 auto 7px;display:flex;align-items:center;justify-content:center;font-size:.9rem;font-weight:700;color:var(--t1)}
.av0{background:linear-gradient(135deg,#1d4ed8,#2563eb)}
.av1{background:linear-gradient(135deg,#0284c7,#2563eb)}
.av2{background:linear-gradient(135deg,#059669,#0284c7)}
.lg-un{font-size:.72rem;font-weight:600;color:var(--t1)}
.lg-pw{display:none;margin-bottom:15px}
.lg-pw.v{display:block}
.lg-pl{font-size:.6rem;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.lg-in{width:100%;background:#060e1d;border:1px solid var(--ln);color:var(--t1);font-family:var(--m);font-size:.9rem;padding:9px 12px;border-radius:7px;outline:none;transition:border-color .15s}
.lg-in:focus{border-color:var(--b2);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.lg-ph{font-size:.58rem;color:var(--t3);margin-top:4px}
.lg-btn{width:100%;background:var(--b);color:var(--t1);border:none;border-radius:8px;padding:11px;font-family:var(--f);font-size:.88rem;font-weight:700;cursor:pointer;transition:background .15s,box-shadow .15s;letter-spacing:.02em}
.lg-btn:hover{background:var(--b2);box-shadow:0 4px 18px rgba(37,99,235,.35)}
.lg-err{font-size:.66rem;color:var(--rd);text-align:center;margin-top:9px;min-height:15px}
.lg-ft{margin-top:22px;text-align:center}
.lg-ft p{font-size:.6rem;color:var(--t3);line-height:2.2;letter-spacing:.04em}
.lg-ft strong{color:var(--b3);font-weight:600}

/* SHELL */
body{display:grid;grid-template-rows:auto 1fr;grid-template-columns:1fr;min-height:100vh}

/* HEADER */
header{
  position:sticky;top:0;z-index:100;
  background:rgba(6,14,29,.93);backdrop-filter:blur(16px);
  border-bottom:1px solid var(--ln);
  padding:0 18px;
  display:flex;align-items:center;height:52px;gap:6px
}
.h-logo{display:flex;align-items:center;gap:8px;margin-right:16px;flex-shrink:0}
.h-logo-img{width:26px;height:26px}
.h-logo-txt{font-size:.82rem;font-weight:800;color:var(--t1);letter-spacing:.06em}
.h-badge{font-size:.52rem;font-weight:600;background:var(--dim);color:var(--b3);border:1px solid rgba(37,99,235,.25);padding:2px 6px;border-radius:4px;letter-spacing:.06em;text-transform:uppercase}
nav{display:flex;gap:1px;flex:1;overflow-x:auto;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
.nb{padding:5px 10px;border-radius:6px;font-size:.72rem;font-weight:500;color:var(--t3);border:none;background:none;cursor:pointer;white-space:nowrap;transition:color .12s,background .12s;font-family:var(--f)}
.nb:hover{color:var(--t2);background:var(--t5)}
.nb.on{color:var(--b3);background:var(--dim);font-weight:600}
.h-right{display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0}
.h-clk{font-family:var(--m);font-size:.62rem;color:var(--t3)}
.h-live{display:flex;align-items:center;gap:4px;font-size:.6rem;font-weight:600;color:var(--gr)}
.h-dot{width:5px;height:5px;border-radius:50%;background:var(--gr);animation:p 2s infinite}
@keyframes p{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(16,185,129,.4)}50%{opacity:.5;box-shadow:0 0 0 4px rgba(16,185,129,0)}}
.h-user{display:flex;align-items:center;gap:6px;cursor:pointer;padding:4px 7px;border-radius:6px;transition:background .12s}
.h-user:hover{background:var(--t5)}
.h-av{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.65rem;font-weight:700;color:var(--t1);flex-shrink:0}
.h-uname{font-size:.68rem;font-weight:600;color:var(--t2)}
.h-out{font-size:.58rem;color:var(--t3);background:none;border:1px solid var(--ln);border-radius:4px;padding:2px 6px;cursor:pointer;font-family:var(--f);transition:all .12s}
.h-out:hover{color:var(--rd);border-color:var(--rd)}

/* PAGES */
main{overflow-y:auto}
.pg{display:none;padding:20px 18px;max-width:860px;margin:0 auto}
.pg.on{display:block}

/* ── HOME ── */
.h-hero{padding:22px 0 18px;border-bottom:1px solid var(--ln);margin-bottom:20px}
.h-day{font-size:.62rem;color:var(--t3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}
.h-ttl{font-size:1.5rem;font-weight:800;color:var(--t1);line-height:1.2}
.h-ttl span{color:var(--b3)}

.stats-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--ln);border:1px solid var(--ln);border-radius:var(--r);overflow:hidden;margin-bottom:20px}
.ss-cell{background:var(--s1);padding:14px 12px;text-align:center}
.ss-lbl{font-size:.55rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);margin-bottom:7px}
.ss-val{font-family:var(--m);font-size:1.6rem;font-weight:700;line-height:1;color:var(--t1)}
.ss-val.b{color:var(--b3)}
.ss-val.g{color:var(--gr)}
.ss-val.r{color:var(--rd)}

.two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
@media(max-width:580px){.two-col{grid-template-columns:1fr}.stats-strip{grid-template-columns:repeat(2,1fr)}}

.box{background:var(--s1);border:1px solid var(--ln);border-radius:var(--r);overflow:hidden}
.box-hdr{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;border-bottom:1px solid var(--ln)}
.box-t{font-size:.74rem;font-weight:700;color:var(--t2);letter-spacing:.02em}
.box-body{padding:12px 14px}

.qa-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.qa{background:var(--s2);border:1px solid var(--ln);border-radius:8px;padding:11px 10px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:all .12s;font-family:var(--f)}
.qa:hover{border-color:var(--b);background:var(--dim)}
.qa:active{transform:scale(.98)}
.qa-i{font-size:1rem;flex-shrink:0}
.qa-l{font-size:.72rem;font-weight:600;color:var(--t2)}
.qa-s{font-size:.57rem;color:var(--t3);margin-top:1px}

.rs{display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--ln)}
.rs:last-child{border-bottom:none;padding-bottom:0}
.rs-tag{width:24px;height:24px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:.58rem;font-weight:800;flex-shrink:0}
.rs-tag.L{background:rgba(16,185,129,.12);color:var(--gr);border:1px solid rgba(16,185,129,.2)}
.rs-tag.R{background:rgba(244,63,94,.12);color:var(--rd);border:1px solid rgba(244,63,94,.2)}
.rs-sym{font-size:.78rem;font-weight:700;color:var(--t1)}
.rs-sub{font-size:.58rem;color:var(--t3);font-family:var(--m);margin-top:1px}
.rs-sc{font-family:var(--m);font-size:.74rem;font-weight:700;margin-left:auto;white-space:nowrap}
.rs-ago{font-size:.56rem;color:var(--t3);text-align:right;margin-top:1px}

.wb-link{display:flex;align-items:center;gap:11px;background:linear-gradient(110deg,rgba(37,99,235,.12),rgba(96,165,250,.06));border:1px solid rgba(37,99,235,.22);border-radius:var(--r);padding:14px 15px;text-decoration:none;color:inherit;transition:all .15s}
.wb-link:hover{border-color:var(--b2);box-shadow:0 0 20px rgba(37,99,235,.1)}
.wb-i{font-size:1.6rem;flex-shrink:0}
.wb-ttl{font-size:.84rem;font-weight:700;color:var(--t1)}
.wb-sub{font-size:.6rem;color:var(--t3);margin-top:2px}
.wb-go{margin-left:auto;background:var(--dim);color:var(--b3);font-size:.58rem;font-weight:700;padding:4px 8px;border-radius:5px;flex-shrink:0;border:1px solid rgba(37,99,235,.2)}

/* ── ANALYSE ── */
.snap{background:var(--s1);border:1px solid var(--ln);border-radius:var(--r);padding:12px 14px;display:flex;align-items:center;gap:11px;margin-bottom:6px;transition:border-color .12s}
.snap:hover{border-color:var(--ln2)}
.snap-sym{font-size:.86rem;font-weight:700;color:var(--t1)}
.snap-sub{font-family:var(--m);font-size:.58rem;color:var(--t3);margin-top:2px}
.snap-px{font-family:var(--m);font-size:.82rem;font-weight:700;color:var(--b3);white-space:nowrap}
.res-box{background:var(--s2);border:1px solid var(--ln2);border-radius:var(--r);overflow:hidden;animation:fu .18s ease;margin-bottom:6px}
@keyframes fu{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.res-top{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--ln)}
.res-badge{font-size:.65rem;font-weight:700;padding:3px 9px;border-radius:4px}
.res-badge.y{background:rgba(16,185,129,.14);color:var(--gr)}
.res-badge.n{background:rgba(244,63,94,.14);color:var(--rd)}
.res-bd{padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.res-r{display:flex;justify-content:space-between;align-items:center}
.res-k{font-size:.58rem;color:var(--t3);text-transform:uppercase;letter-spacing:.07em}
.res-v{font-family:var(--m);font-size:.72rem;color:var(--t2)}
.res-pl{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.res-pc{background:#060e1d;border-radius:7px;padding:8px;text-align:center}
.res-pl-l{font-size:.52rem;color:var(--t3);text-transform:uppercase;letter-spacing:.06em}
.res-pl-v{font-family:var(--m);font-size:.74rem;font-weight:700;margin-top:3px}
.res-reason{font-size:.7rem;color:var(--t3);line-height:1.65;padding-top:8px;border-top:1px solid var(--ln)}
.bar{height:2px;background:var(--s3);border-radius:2px;overflow:hidden;margin:2px 0}
.bar-f{height:100%;border-radius:2px}

/* ── SIGNALS ── */
.fb{display:flex;gap:6px;margin-bottom:11px;flex-wrap:wrap}
.fsel{background:var(--s1);border:1px solid var(--ln);color:var(--t2);font-family:var(--f);font-size:.7rem;padding:6px 9px;border-radius:6px;cursor:pointer;flex:1;min-width:85px;outline:none;transition:border-color .12s}
.fsel:focus{border-color:var(--b2)}
.fsort{background:var(--s1);border:1px solid var(--ln);color:var(--t3);font-family:var(--f);font-size:.66rem;font-weight:600;padding:6px 11px;border-radius:6px;cursor:pointer;white-space:nowrap;transition:all .12s}
.fsort.on{border-color:var(--b2);color:var(--b3)}
.sc{background:var(--s1);border:1px solid var(--ln);border-radius:var(--r);padding:12px 14px;margin-bottom:6px;transition:border-color .12s}
.sc:hover{border-color:var(--ln2)}
.sc-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}
.sc-sym{font-size:.86rem;font-weight:700;color:var(--t1)}
.sc-age{font-family:var(--m);font-size:.56rem;color:var(--t3)}
.sc-mid{display:flex;justify-content:space-between;align-items:center;margin-bottom:5px}
.sc-tr{font-family:var(--m);font-size:.6rem;color:var(--t3)}
.sc-s{font-family:var(--m);font-size:.74rem;font-weight:700}
.sc-px{font-family:var(--m);font-size:.6rem;color:var(--t3);display:flex;gap:10px;margin-bottom:7px}
.sc-ft{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px}
.tgs{display:flex;gap:3px;flex-wrap:wrap}
.tg{font-size:.56rem;font-weight:600;padding:2px 6px;border-radius:3px}
.tgw{background:rgba(16,185,129,.1);color:var(--gr);border:1px solid rgba(16,185,129,.17)}
.tgo{background:rgba(37,99,235,.1);color:var(--b3);border:1px solid rgba(37,99,235,.17)}
.tgl{background:rgba(244,63,94,.1);color:var(--rd);border:1px solid rgba(244,63,94,.17)}
.tgs_{background:rgba(240,246,255,.05);color:var(--t3);border:1px solid var(--ln)}
.tgr{background:rgba(16,185,129,.08);color:var(--gr)}
.tgn{background:rgba(244,63,94,.08);color:var(--rd)}
.tglo{background:rgba(16,185,129,.08);color:var(--gr)}
.tgm{background:rgba(245,158,11,.08);color:var(--am)}
.tgh{background:rgba(244,63,94,.08);color:var(--rd)}

/* ── BACKTESTING ── */
.bt-tabs{display:flex;gap:5px;margin-bottom:14px}
.bt-tab{background:var(--s1);border:1px solid var(--ln);color:var(--t3);font-family:var(--f);font-size:.68rem;font-weight:600;padding:6px 16px;border-radius:6px;cursor:pointer;transition:all .12s}
.bt-tab.on{border-color:var(--b2);color:var(--b3);background:var(--dim)}
.bt-ks{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
.bt-k{background:var(--s1);border:1px solid var(--ln);border-radius:var(--r);padding:12px;text-align:center}
.bt-kv{font-family:var(--m);font-size:1.3rem;font-weight:700;line-height:1}
.bt-kl{font-size:.56rem;color:var(--t3);margin-top:5px;text-transform:uppercase;letter-spacing:.08em}
.sc-cmp{background:var(--s1);border:1px solid var(--ln);border-radius:var(--r);padding:14px;margin-bottom:11px}
.sc-cmp-t{font-size:.72rem;font-weight:700;color:var(--t2);margin-bottom:12px}
.sc-row{display:flex;align-items:center;gap:9px;margin-bottom:8px}
.sc-row:last-child{margin-bottom:0}
.sc-l{font-size:.65rem;font-weight:600;width:48px;flex-shrink:0}
.sc-bg{flex:1;height:6px;background:var(--s3);border-radius:3px;overflow:hidden}
.sc-fi{height:100%;border-radius:3px;transition:width .8s ease}
.sc-vl{font-family:var(--m);font-size:.65rem;font-weight:700;width:30px;text-align:right;flex-shrink:0}
.sym-tbl{width:100%;border-collapse:collapse;font-size:.72rem}
.sym-tbl th{text-align:left;padding:7px 9px;font-size:.56rem;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--ln);font-weight:600}
.sym-tbl td{padding:8px 9px;border-bottom:1px solid var(--ln)}
.sym-tbl tr:last-child td{border-bottom:none}
.bsr{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--ln)}
.bsr:last-child{border-bottom:none;padding-bottom:0}
.bsr-sym{font-size:.78rem;font-weight:700;color:var(--t1)}
.bsr-sub{font-size:.58rem;color:var(--t3);font-family:var(--m)}
.bsr-sc{font-family:var(--m);font-size:.84rem;font-weight:700}

/* ── STRATEGIE ── */
.str{background:var(--s1);border:1px solid var(--ln);border-radius:var(--r);margin-bottom:9px;overflow:hidden}
.str-h{display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:1px solid var(--ln)}
.str-hi{font-size:.95rem}
.str-ht{font-size:.8rem;font-weight:700;color:var(--t2)}
.str-b{padding:12px 14px}
.str-step{display:flex;gap:10px;margin-bottom:12px}
.str-step:last-child{margin-bottom:0}
.str-n{width:20px;height:20px;border-radius:50%;background:var(--dim);border:1px solid rgba(37,99,235,.28);color:var(--b3);font-size:.6rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.str-st{font-size:.76rem;font-weight:700;color:var(--t2);margin-bottom:2px}
.str-tx{font-size:.7rem;line-height:1.65;color:var(--t3)}
.str-rule{display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid var(--ln)}
.str-rule:last-child{border-bottom:none}
.str-ri{width:16px;flex-shrink:0;font-size:.76rem;margin-top:1px}
.str-rt{font-size:.7rem;color:var(--t3);line-height:1.55}
.str-rt strong{color:var(--t2);font-weight:600}
.no-t{display:flex;flex-direction:column;gap:5px}
.no-ti{display:flex;align-items:center;gap:8px;padding:7px 10px;background:rgba(244,63,94,.04);border:1px solid rgba(244,63,94,.1);border-radius:6px;font-size:.7rem;color:var(--t3)}

/* ── TOOLS ── */
.tl-g{margin-bottom:12px}
.tl-gt{font-size:.56rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--t3);margin-bottom:6px;padding:0 2px}
.tl-lst{background:var(--s1);border:1px solid var(--ln);border-radius:var(--r);overflow:hidden}
.tl-r{display:flex;align-items:center;padding:11px 14px;border-bottom:1px solid var(--ln);cursor:pointer;transition:background .1s;text-decoration:none;color:inherit}
.tl-r:last-child{border-bottom:none}
.tl-r:hover{background:var(--s2)}
.tl-ri{font-size:.95rem;width:22px;flex-shrink:0}
.tl-tx{flex:1}
.tl-l{font-size:.76rem;font-weight:600;color:var(--t2)}
.tl-d{font-size:.6rem;color:var(--t3);margin-top:1px}
.tl-a{color:var(--t3);font-size:.72rem}

/* ── TELEGRAM ── */
.cmd-g{display:flex;flex-direction:column;gap:5px}
.cmd-r{background:var(--s1);border:1px solid var(--ln);border-radius:8px;padding:10px 13px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:background .1s}
.cmd-r:hover{background:var(--s2)}
.cmd-c{font-family:var(--m);font-size:.76rem;color:var(--b3);font-weight:600}
.cmd-d{font-size:.6rem;color:var(--t3);margin-top:2px}

/* ── SHARED ── */
.btn{font-family:var(--f);font-weight:600;font-size:.7rem;border:none;border-radius:6px;padding:6px 12px;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px}
.btn:active{transform:scale(.96)}
.btn:disabled{opacity:.3;cursor:not-allowed;transform:none}
.btn-b{background:var(--b);color:var(--t1)}
.btn-b:hover{background:var(--b2);box-shadow:0 3px 12px rgba(37,99,235,.3)}
.btn-g{background:var(--s2);border:1px solid var(--ln);color:var(--t3);font-size:.63rem;padding:5px 10px}
.btn-g:hover{border-color:var(--ln2);color:var(--t2)}
.btn-w{background:rgba(16,185,129,.09);color:var(--gr);border:1px solid rgba(16,185,129,.2);font-size:.6rem;padding:4px 7px}
.btn-l{background:rgba(244,63,94,.09);color:var(--rd);border:1px solid rgba(244,63,94,.2);font-size:.6rem;padding:4px 7px}
.btn-s{background:var(--t5);color:var(--t3);border:1px solid var(--ln);font-size:.6rem;padding:4px 7px}
.empty{text-align:center;padding:28px;color:var(--t3);font-size:.76rem;line-height:1.8}
.sec-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.sec-l{font-size:.58rem;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--t3)}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--s2);border:1px solid var(--ln2);color:var(--t2);font-size:.7rem;padding:8px 16px;border-radius:18px;z-index:9999;pointer-events:none;opacity:0;transition:opacity .2s;white-space:nowrap;max-width:92vw}
.toast.on{opacity:1}

/* MOBILE */
@media(max-width:580px){
  header{padding:0 12px;gap:4px}
  .h-clk,.h-uname,.h-badge{display:none}
  .nb{padding:5px 8px;font-size:.68rem}
  .pg{padding:14px 12px}
  .bnv{display:flex!important}
  body{padding-bottom:56px}
}
.bnv{display:none;position:fixed;bottom:0;left:0;right:0;z-index:100;background:rgba(6,14,29,.97);backdrop-filter:blur(12px);border-top:1px solid var(--ln);padding:5px 0 max(5px,env(safe-area-inset-bottom))}
.bnb{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;padding:4px 0;font-size:.5rem;font-weight:600;color:var(--t3);transition:color .12s;border:none;background:none;font-family:var(--f)}
.bnb.on{color:var(--b3)}
.bnb-i{font-size:1.05rem}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="LG">
  <div class="lg-glow"></div>
  <div class="lg-wrap">
    <img src="${LS}" class="lg-logo" alt="">
    <div class="lg-brand">WAVESCOUT</div>
    <div class="lg-tag">Signal Intelligence</div>
    <div class="lg-box">
      <div class="lg-who">Account wählen</div>
      <div class="lg-users">
        <div class="lg-u" onclick="pu('Marvin',this)"><div class="lg-av av0">M</div><div class="lg-un">Marvin</div></div>
        <div class="lg-u" onclick="pu('Sandro',this)"><div class="lg-av av1">S</div><div class="lg-un">Sandro</div></div>
        <div class="lg-u" onclick="pu('Iven',this)"><div class="lg-av av2">I</div><div class="lg-un">Iven</div></div>
      </div>
      <div class="lg-pw" id="lpw">
        <div class="lg-pl">Passwort</div>
        <input type="password" class="lg-in" id="lin" placeholder="••••••••" onkeydown="if(event.key==='Enter')dl()">
        <div class="lg-ph" id="lph"></div>
      </div>
      <button class="lg-btn" id="lgo" style="display:none" onclick="dl()">Anmelden →</button>
      <div class="lg-err" id="ler"></div>
    </div>
    <div class="lg-ft"><p>Made by <strong>WaveWatch</strong></p><p>Made for Trader</p></div>
  </div>
</div>

<!-- HEADER -->
<header>
  <div class="h-logo"><img src="${LS}" class="h-logo-img" alt=""><span class="h-logo-txt">WAVESCOUT</span><span class="h-badge">v3</span></div>
  <nav>
    <button class="nb on" onclick="go('home')">Home</button>
    <button class="nb" onclick="go('analyse')">Analyse</button>
    <button class="nb" onclick="go('signals')">Signale</button>
    <button class="nb" onclick="go('bt')">Backtesting</button>
    <button class="nb" onclick="go('str')">Strategie</button>
    <button class="nb" onclick="go('tools')">Tools</button>
    <button class="nb" onclick="go('tg')">Telegram</button>
  </nav>
  <div class="h-right">
    <div class="h-clk" id="clk">–</div>
    <div class="h-live"><div class="h-dot"></div>Live</div>
    <div class="h-user">
      <div class="h-av" id="hav" style="background:linear-gradient(135deg,#1d4ed8,#2563eb)">M</div>
      <span class="h-uname" id="hun">Marvin</span>
      <button class="h-out" onclick="lo()">Exit</button>
    </div>
  </div>
</header>

<!-- MAIN -->
<main>
  <!-- HOME -->
  <div class="pg on" id="pg-home">
    <div class="h-hero">
      <div class="h-day" id="hday">–</div>
      <div class="h-ttl" id="httl">Guten Morgen, <span>Trader</span> 👋</div>
    </div>

    <div class="stats-strip">
      <div class="ss-cell"><div class="ss-lbl">Open</div><div class="ss-val b" id="k0">–</div></div>
      <div class="ss-cell"><div class="ss-lbl">Wins</div><div class="ss-val g" id="k1">–</div></div>
      <div class="ss-cell"><div class="ss-lbl">Losses</div><div class="ss-val r" id="k2">–</div></div>
      <div class="ss-cell"><div class="ss-lbl">Winrate</div><div class="ss-val" id="k3" style="color:var(--t1)">–</div></div>
    </div>

    <div class="two-col">
      <div class="box">
        <div class="box-hdr"><div class="box-t">Aktionen</div></div>
        <div class="box-body">
          <div class="qa-grid">
            <div class="qa" onclick="go('analyse')"><div class="qa-i">🔍</div><div><div class="qa-l">Analyse</div><div class="qa-s">Symbol prüfen</div></div></div>
            <div class="qa" onclick="ta('morning')"><div class="qa-i">🌅</div><div><div class="qa-l">Brief</div><div class="qa-s">Morgen-Bias</div></div></div>
            <div class="qa" onclick="ta('outcomes')"><div class="qa-i">🔄</div><div><div class="qa-l">Outcomes</div><div class="qa-s">WIN/LOSS sync</div></div></div>
            <div class="qa" onclick="go('bt')"><div class="qa-i">📊</div><div><div class="qa-l">Backtest</div><div class="qa-s">Auswertung</div></div></div>
          </div>
        </div>
      </div>
      <div class="box">
        <div class="box-hdr"><div class="box-t">Letzte Signale</div><button class="btn btn-g" onclick="go('signals')">Alle →</button></div>
        <div class="box-body" id="hsigs"><div class="empty">Lade…</div></div>
      </div>
    </div>

    <a class="wb-link" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank">
      <div class="wb-i">🌊</div>
      <div><div class="wb-ttl">WaveBoard</div><div class="wb-sub">Externes Trading Dashboard öffnen</div></div>
      <div class="wb-go">↗ Öffnen</div>
    </a>
  </div>

  <!-- ANALYSE -->
  <div class="pg" id="pg-analyse">
    <div class="sec-h"><div class="sec-l">Snapshots</div><button class="btn btn-g" onclick="ls()">↻</button></div>
    <div id="sl"><div class="empty">Lade…</div></div>
  </div>

  <!-- SIGNALE -->
  <div class="pg" id="pg-signals">
    <div class="fb">
      <select class="fsel" id="fsym" onchange="af()"><option value="">Alle Symbole</option></select>
      <select class="fsel" id="fout" onchange="af()" style="flex:.75">
        <option value="">Alle</option><option value="OPEN">Open</option><option value="WIN">Win</option><option value="LOSS">Loss</option><option value="SKIPPED">Skipped</option>
      </select>
      <button class="fsort on" id="ss" onclick="srt('score')">Score ↓</button>
      <button class="fsort" id="st" onclick="srt('time')">Zeit</button>
    </div>
    <div id="sgl"><div class="empty">Lade…</div></div>
  </div>

  <!-- BACKTESTING -->
  <div class="pg" id="pg-bt">
    <div class="bt-tabs">
      <button class="bt-tab on" onclick="btt('all',this)">Gesamt</button>
      <button class="bt-tab" onclick="btt('month',this)">30 Tage</button>
      <button class="bt-tab" onclick="btt('week',this)">7 Tage</button>
    </div>
    <div id="btb"><div class="empty">Lade…</div></div>
  </div>

  <!-- STRATEGIE -->
  <div class="pg" id="pg-str">
    <div class="str"><div class="str-h"><div class="str-hi">🎯</div><div class="str-ht">Top-Down Daytrading</div></div><div class="str-b">
      <div class="str-step"><div class="str-n">1</div><div><div class="str-st">Morgen-Routine (10 Min)</div><div class="str-tx">4H Chart öffnen → EMA200 prüfen. Preis darüber = Long-Bias, darunter = Short-Bias. EMA flach = kein Trade. 1–2 Key-Zonen auf 15min markieren.</div></div></div>
      <div class="str-step"><div class="str-n">2</div><div><div class="str-st">Zonenanalyse (15min)</div><div class="str-tx">Warten bis Preis eine markierte Zone erreicht. Higher Low (Long) oder Lower High (Short) sichtbar. Kein Chaos, kein Seitwärtsmarkt.</div></div></div>
      <div class="str-step"><div class="str-n">3</div><div><div class="str-st">Entry (5–10min)</div><div class="str-tx">Klare Trendkerze, starker Body, wenig Docht. Bruch von lokalem High/Low abwarten. RSI als Filter — kein alleiniges Signal.</div></div></div>
    </div></div>
    <div class="str"><div class="str-h"><div class="str-hi">📏</div><div class="str-ht">Entry-Regeln</div></div><div class="str-b">
      <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>RSI Long:</strong> 30–55 steigend. <strong>Short:</strong> 45–70 fallend. Kein Entry bei >70 oder <30.</div></div>
      <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>EMA200 (4H):</strong> Preis darüber = nur Long. Darunter = nur Short.</div></div>
      <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>Trendstruktur:</strong> EMA50 über EMA200 (Long) oder darunter. Neutral = kein Trade.</div></div>
      <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>Zone:</strong> Long nah an Support. Short nah an Resistance.</div></div>
      <div class="str-rule"><div class="str-ri">✅</div><div class="str-rt"><strong>R/R:</strong> Mindestens 1:1.5. SL logisch unter/über Struktur.</div></div>
    </div></div>
    <div class="str"><div class="str-h"><div class="str-hi">🚫</div><div class="str-ht">Kein Trade — Ausschluss</div></div><div class="str-b">
      <div class="no-t">
        <div class="no-ti">❌ Trade gegen Tages-Bias</div>
        <div class="no-ti">❌ EMA200 (4H) flach oder Preis direkt dran</div>
        <div class="no-ti">❌ Chaos, viele Wicks, kein klares Bild</div>
        <div class="no-ti">❌ FOMO — unbedingt rein wollen</div>
        <div class="no-ti">❌ RSI extrem überkauft oder überverkauft</div>
        <div class="no-ti">❌ Trade nicht erklärbar</div>
      </div>
    </div></div>
    <div class="str"><div class="str-h"><div class="str-hi">✔️</div><div class="str-ht">Final Check</div></div><div class="str-b">
      <div class="str-rule"><div class="str-ri">☑️</div><div class="str-rt">Passt der Trade zum Tages-Bias?</div></div>
      <div class="str-rule"><div class="str-ri">☑️</div><div class="str-rt">Könnte ich diesen Trade erklären?</div></div>
      <div class="str-rule"><div class="str-ri">☑️</div><div class="str-rt">Ruhig und klar im Kopf? — Wenn nein: warten.</div></div>
    </div></div>
    <div class="str"><div class="str-h"><div class="str-hi">💱</div><div class="str-ht">Instrumente</div></div><div class="str-b">
      <table class="sym-tbl">
        <tr><th>Symbol</th><th>Prio</th><th>Hinweis</th></tr>
        <tr><td><strong>BTC/USDT</strong></td><td><span class="tg tgw">Primär</span></td><td style="font-size:.68rem;color:var(--t3)">Klarste Strukturen, höchste Liquidität</td></tr>
        <tr><td><strong>ETH/USDT</strong></td><td><span class="tg tgo">Sekundär</span></td><td style="font-size:.68rem;color:var(--t3)">Ähnlich sauber, etwas mehr Bewegung</td></tr>
        <tr><td><strong>SOL/USDT</strong></td><td><span class="tg tgs_">Optional</span></td><td style="font-size:.68rem;color:var(--t3)">Nur bei klar trendendem Markt</td></tr>
      </table>
    </div></div>
  </div>

  <!-- TOOLS -->
  <div class="pg" id="pg-tools">
    <a class="wb-link" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank" style="display:flex;margin-bottom:14px">
      <div class="wb-i">🌊</div><div><div class="wb-ttl">WaveBoard Dashboard</div><div class="wb-sub">waveboard-e54ed.web.app</div></div><div class="wb-go">↗</div>
    </a>
    <div class="tl-g"><div class="tl-gt">System</div><div class="tl-lst">
      <div class="tl-r" onclick="ta('health')"><div class="tl-ri">💚</div><div class="tl-tx"><div class="tl-l">Health Check</div><div class="tl-d">Worker Status prüfen</div></div><div class="tl-a">›</div></div>
      <div class="tl-r" onclick="ta('telegram')"><div class="tl-ri">📨</div><div class="tl-tx"><div class="tl-l">Telegram testen</div><div class="tl-d">Test-Nachricht senden</div></div><div class="tl-a">›</div></div>
      <div class="tl-r" onclick="ta('morning')"><div class="tl-ri">🌅</div><div class="tl-tx"><div class="tl-l">Morning Brief</div><div class="tl-d">Tages-Bias jetzt senden</div></div><div class="tl-a">›</div></div>
      <div class="tl-r" onclick="ta('outcomes')"><div class="tl-ri">🔄</div><div class="tl-tx"><div class="tl-l">Outcome Tracking</div><div class="tl-d">WIN/LOSS via Binance</div></div><div class="tl-a">›</div></div>
    </div></div>
    <div class="tl-g"><div class="tl-gt">Links</div><div class="tl-lst">
      <a class="tl-r" href="https://tradingview.com" target="_blank"><div class="tl-ri">📊</div><div class="tl-tx"><div class="tl-l">TradingView</div><div class="tl-d">Charts & Alerts</div></div><div class="tl-a">↗</div></a>
      <a class="tl-r" href="https://dash.cloudflare.com" target="_blank"><div class="tl-ri">☁️</div><div class="tl-tx"><div class="tl-l">Cloudflare</div><div class="tl-d">Worker & Logs</div></div><div class="tl-a">↗</div></a>
      <a class="tl-r" href="https://github.com/spnni08/tradingview-bot" target="_blank"><div class="tl-ri">🐙</div><div class="tl-tx"><div class="tl-l">GitHub</div><div class="tl-d">spnni08/tradingview-bot</div></div><div class="tl-a">↗</div></a>
      <a class="tl-r" href="https://console.anthropic.com" target="_blank"><div class="tl-ri">🤖</div><div class="tl-tx"><div class="tl-l">Anthropic Console</div><div class="tl-d">Claude API Keys</div></div><div class="tl-a">↗</div></a>
    </div></div>
  </div>

  <!-- TELEGRAM -->
  <div class="pg" id="pg-tg">
    <div class="sec-h" style="margin-bottom:11px"><div class="sec-l">Kommandos — tippe zum Kopieren</div></div>
    <div class="cmd-g">
      <div class="cmd-r" onclick="cp('/btc')"><div><div class="cmd-c">/btc</div><div class="cmd-d">Bitcoin analysieren</div></div><span style="color:var(--t3);font-size:.7rem">⎘</span></div>
      <div class="cmd-r" onclick="cp('/eth')"><div><div class="cmd-c">/eth</div><div class="cmd-d">Ethereum analysieren</div></div><span style="color:var(--t3);font-size:.7rem">⎘</span></div>
      <div class="cmd-r" onclick="cp('/sol')"><div><div class="cmd-c">/sol</div><div class="cmd-d">Solana analysieren</div></div><span style="color:var(--t3);font-size:.7rem">⎘</span></div>
      <div class="cmd-r" onclick="cp('/check RENDERUSDT')"><div><div class="cmd-c">/check SYMBOL</div><div class="cmd-d">Beliebiges Symbol</div></div><span style="color:var(--t3);font-size:.7rem">⎘</span></div>
      <div class="cmd-r" onclick="cp('/status')"><div><div class="cmd-c">/status</div><div class="cmd-d">Winrate & Stats</div></div><span style="color:var(--t3);font-size:.7rem">⎘</span></div>
      <div class="cmd-r" onclick="cp('/brief')"><div><div class="cmd-c">/brief</div><div class="cmd-d">Morning Brief</div></div><span style="color:var(--t3);font-size:.7rem">⎘</span></div>
      <div class="cmd-r" onclick="cp('/open')"><div><div class="cmd-c">/open</div><div class="cmd-d">Offene Trades</div></div><span style="color:var(--t3);font-size:.7rem">⎘</span></div>
      <div class="cmd-r" onclick="cp('/top')"><div><div class="cmd-c">/top</div><div class="cmd-d">Beste Signale heute</div></div><span style="color:var(--t3);font-size:.7rem">⎘</span></div>
      <div class="cmd-r" onclick="cp('/hilfe')"><div><div class="cmd-c">/hilfe</div><div class="cmd-d">Alle Kommandos</div></div><span style="color:var(--t3);font-size:.7rem">⎘</span></div>
    </div>
  </div>
</main>

<!-- BOTTOM NAV -->
<div class="bnv" id="bnv">
  <button class="bnb on" onclick="go('home')"><span class="bnb-i">⌂</span>Home</button>
  <button class="bnb" onclick="go('analyse')"><span class="bnb-i">◎</span>Analyse</button>
  <button class="bnb" onclick="go('signals')"><span class="bnb-i">☰</span>Signale</button>
  <button class="bnb" onclick="go('bt')"><span class="bnb-i">▦</span>Backtest</button>
  <button class="bnb" onclick="go('tools')"><span class="bnb-i">⚙</span>Tools</button>
</div>

<div class="toast" id="t"></div>

<script>
const S=new URLSearchParams(location.search).get('secret')||'';
const UA={Marvin:{bg:'linear-gradient(135deg,#1d4ed8,#2563eb)',i:'M'},Sandro:{bg:'linear-gradient(135deg,#0284c7,#2563eb)',i:'S'},Iven:{bg:'linear-gradient(135deg,#059669,#0284c7)',i:'I'}};
let su=null,aS=[],sm='score',bd=null,bp='all';

function ca(){const u=localStorage.getItem('wu');if(!u)return false;if(!localStorage.getItem('wp_'+u))return false;lok(u);return true;}
function pu(n,e){su=n;document.querySelectorAll('.lg-u').forEach(b=>b.classList.remove('ok'));e.classList.add('ok');const s=localStorage.getItem('wp_'+n);document.getElementById('lpw').classList.add('v');document.getElementById('lgo').style.display='block';document.getElementById('lin').value='';document.getElementById('ler').textContent='';document.getElementById('lph').textContent=s?'Willkommen zurueck, '+n+'!':'Erstes Mal: Passwort festlegen.';document.getElementById('lin').focus();}
function dl(){if(!su)return;const pw=document.getElementById('lin').value;if(!pw||pw.length<4){document.getElementById('ler').textContent='Mind. 4 Zeichen.';return;}const s=localStorage.getItem('wp_'+su);if(!s){localStorage.setItem('wp_'+su,pw);localStorage.setItem('wu',su);lok(su);}else if(s===pw){localStorage.setItem('wu',su);lok(su);}else{document.getElementById('ler').textContent='Falsches Passwort.';document.getElementById('lin').value='';document.getElementById('lin').focus();}}
function lok(n){document.getElementById('LG').classList.add('h');const u=UA[n]||UA.Marvin;document.getElementById('hav').style.background=u.bg;document.getElementById('hav').textContent=u.i;document.getElementById('hun').textContent=n;ug(n);lh();}
function lo(){localStorage.removeItem('wu');document.getElementById('LG').classList.remove('h');document.querySelectorAll('.lg-u').forEach(b=>b.classList.remove('ok'));document.getElementById('lpw').classList.remove('v');document.getElementById('lgo').style.display='none';document.getElementById('ler').textContent='';su=null;}

const M=['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
const D=['So','Mo','Di','Mi','Do','Fr','Sa'];
function ug(n){const h=new Date().getHours();const g=h<12?'Guten Morgen':h<18?'Guten Tag':'Guten Abend';const now=new Date();document.getElementById('hday').textContent=D[now.getDay()]+', '+now.getDate()+'. '+M[now.getMonth()]+' '+now.getFullYear();document.getElementById('httl').innerHTML=g+', <span>'+(n||'Trader')+'</span> 👋';}
setInterval(()=>{document.getElementById('clk').textContent=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});const u=localStorage.getItem('wu');if(u)ug(u);},1000);

const fmt=(n,d=2)=>(!n&&n!==0)?'–':Number(n).toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});
function ago(ts){const d=Date.now()-ts;if(d<60000)return'jetzt';if(d<3600000)return Math.floor(d/60000)+'m';if(d<86400000)return Math.floor(d/3600000)+'h';return Math.floor(d/86400000)+'d';}
const sc=s=>s>=70?'var(--gr)':s>=50?'var(--am)':'var(--rd)';
function toast(msg,dur=2400){const t=document.getElementById('t');t.textContent=msg;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),dur);}

const PG=['home','analyse','signals','bt','str','tools','tg'];
function go(n){
  document.querySelectorAll('.pg').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.nb').forEach((b,i)=>b.classList.toggle('on',PG[i]===n));
  document.querySelectorAll('.bnb').forEach((b,i)=>b.classList.toggle('on',['home','analyse','signals','bt','tools'][i]===n));
  document.getElementById('pg-'+n).classList.add('on');
  if(n==='analyse')ls();if(n==='signals')lsg();if(n==='bt')lbt();if(n==='home')lh();
}

async function lst(){const d=await fetch('/stats').then(r=>r.json()).catch(()=>({}));document.getElementById('k0').textContent=d.open||0;document.getElementById('k1').textContent=d.wins||0;document.getElementById('k2').textContent=d.losses||0;document.getElementById('k3').textContent=(d.winrate||0)+'%';}
async function lh(){await lst();const h=await fetch('/history').then(r=>r.json()).catch(()=>[]);const el=document.getElementById('hsigs');if(!h.length){el.innerHTML='<div class="empty">Noch keine Signale.</div>';return;}el.innerHTML=h.slice(0,5).map(x=>{const s=Number(x.ai_score)||0;const L=x.ai_direction==='LONG';return\`<div class="rs"><div class="rs-tag \${L?'L':'R'}">\${L?'L':'S'}</div><div><div class="rs-sym">\${x.symbol||'–'}</div><div class="rs-sub">\${x.trigger||'–'}</div></div><div class="rs-right"><div class="rs-sc" style="color:\${sc(s)}">\${s}/100</div><div class="rs-ago">\${ago(x.created_at)}</div></div></div>\`;}).join('');}

async function ls(){const el=document.getElementById('sl');el.innerHTML='<div class="empty">Lade…</div>';const snaps=await fetch('/snapshots').then(r=>r.json()).catch(()=>[]);if(!snaps.length){el.innerHTML='<div class="empty">Keine Snapshots.</div>';return;}el.innerHTML=snaps.map(s=>\`<div><div class="snap"><div style="flex:1;min-width:0"><div class="snap-sym">\${s.symbol}</div><div class="snap-sub">RSI \${fmt(s.rsi,1)} · EMA50 \${fmt(s.ema50,0)} · \${s.trend||'–'}</div></div><div class="snap-px">\${fmt(s.price)}</div><button class="btn btn-b" onclick="cn('\${s.symbol}',this)" \${S?'':'disabled'} style="font-size:.62rem;padding:5px 10px">\${S?'Prüfen':'🔒'}</button></div><div class="res-box" id="rb-\${s.symbol}" style="display:none"></div></div>\`).join('');}

async function cn(sym,btn){btn.disabled=true;btn.textContent='…';const el=document.getElementById('rb-'+sym);try{const d=await fetch('/ask?symbol='+encodeURIComponent(sym)+'&secret='+encodeURIComponent(S)).then(r=>r.json());if(d.error)throw new Error(d.error);const ai=d.ai||{},s=Number(ai.score)||0,rec=ai.recommendation==='RECOMMENDED';const rr=(ai.entry&&ai.take_profit&&ai.stop_loss)?(Math.abs(ai.take_profit-ai.entry)/Math.abs(ai.entry-ai.stop_loss)).toFixed(2):null;el.style.display='block';el.innerHTML=\`<div class="res-top"><span class="res-badge \${rec?'y':'n'}">\${rec?'✓ Empfohlen':'✗ Nicht empfohlen'}</span><span style="font-family:var(--m);font-size:.8rem;font-weight:700;color:\${sc(s)}">\${s}/100</span></div><div class="res-bd"><div class="res-r"><span class="res-k">Richtung</span><span class="res-v">\${ai.direction||'–'}</span></div><div class="res-r"><span class="res-k">Risiko</span><span class="res-v">\${ai.risk||'–'}</span></div><div class="res-r"><span class="res-k">Confidence</span><span class="res-v">\${ai.confidence||0}%</span></div>\${rr?'<div class="res-r"><span class="res-k">R/R</span><span class="res-v">1:'+rr+'</span></div>':''}<div class="bar"><div class="bar-f" style="width:\${s}%;background:\${sc(s)}"></div></div><div class="res-pl"><div class="res-pc"><div class="res-pl-l">Entry</div><div class="res-pl-v" style="color:var(--b3)">\${fmt(ai.entry)}</div></div><div class="res-pc"><div class="res-pl-l">TP</div><div class="res-pl-v" style="color:var(--gr)">\${fmt(ai.take_profit)}</div></div><div class="res-pc"><div class="res-pl-l">SL</div><div class="res-pl-v" style="color:var(--rd)">\${fmt(ai.stop_loss)}</div></div></div><div class="res-reason">\${ai.reason||''}</div></div>\`;toast(rec?'Empfohlen!':'Nicht empfohlen');}catch(e){el.style.display='block';el.innerHTML='<div style="padding:12px 14px;color:var(--rd);font-size:.7rem">Fehler: '+e.message+'</div>';}btn.disabled=false;btn.textContent=S?'Prüfen':'🔒';}

async function lsg(){const el=document.getElementById('sgl');el.innerHTML='<div class="empty">Lade…</div>';aS=await fetch('/history').then(r=>r.json()).catch(()=>[]);const syms=[...new Set(aS.map(x=>x.symbol).filter(Boolean))];const sel=document.getElementById('fsym');sel.innerHTML='<option value="">Alle Symbole</option>'+syms.map(s=>'<option value="'+s+'">'+s+'</option>').join('');af();}
function srt(m){sm=m;document.getElementById('ss').classList.toggle('on',m==='score');document.getElementById('st').classList.toggle('on',m==='time');af();}
function af(){const sym=document.getElementById('fsym').value;const out=document.getElementById('fout').value;let f=[...aS];if(sym)f=f.filter(x=>x.symbol===sym);if(out)f=f.filter(x=>x.outcome===out);if(sm==='score')f.sort((a,b)=>(b.ai_score||0)-(a.ai_score||0));else f.sort((a,b)=>b.created_at-a.created_at);const el=document.getElementById('sgl');if(!f.length){el.innerHTML='<div class="empty">Keine Signale.</div>';return;}el.innerHTML=f.map(x=>{const s=Number(x.ai_score)||0;const oc=x.outcome==='WIN'?'tgw':x.outcome==='LOSS'?'tgl':x.outcome==='SKIPPED'?'tgs_':'tgo';const rc=x.ai_recommendation==='RECOMMENDED'?'tgr':'tgn';const rk=x.ai_risk==='HIGH'?'tgh':x.ai_risk==='MEDIUM'?'tgm':'tglo';const op=x.outcome==='OPEN';return\`<div class="sc"><div class="sc-top"><span class="sc-sym">\${x.symbol||'–'}</span><span class="sc-age">\${ago(x.created_at)}</span></div><div class="sc-mid"><span class="sc-tr">\${x.trigger||'–'}</span><span class="sc-s" style="color:\${sc(s)}">\${s}/100</span></div><div class="sc-px"><span>E: \${fmt(x.ai_entry)}</span><span style="color:var(--gr)">TP: \${fmt(x.ai_take_profit)}</span><span style="color:var(--rd)">SL: \${fmt(x.ai_stop_loss)}</span></div><div class="bar"><div class="bar-f" style="width:\${s}%;background:\${sc(s)}"></div></div><div class="sc-ft"><div class="tgs"><span class="tg \${rc}">\${x.ai_recommendation==='RECOMMENDED'?'Empf.':'Nein'}</span><span class="tg \${rk}">\${x.ai_risk||'–'}</span><span class="tg \${oc}" id="out-\${x.id}">\${x.outcome||'–'}</span></div>\${op&&S?\`<div style="display:flex;gap:4px"><button class="btn btn-w" onclick="so('\${x.id}','WIN',this)">WIN</button><button class="btn btn-l" onclick="so('\${x.id}','LOSS',this)">LOSS</button><button class="btn btn-s" onclick="so('\${x.id}','SKIPPED',this)">Skip</button></div>\`:''}</div></div>\`;}).join('');}
async function so(id,o,btn){const all=btn.parentElement.querySelectorAll('button');all.forEach(b=>b.disabled=true);try{const r=await fetch('/outcome?id='+id+'&outcome='+o+'&secret='+encodeURIComponent(S),{method:'POST'}).then(r=>r.json());if(r.status==='ok'){const b=document.getElementById('out-'+id);if(b){b.className='tg '+(o==='WIN'?'tgw':o==='LOSS'?'tgl':'tgs_');b.textContent=o;}btn.parentElement.style.display='none';lst();toast(o==='WIN'?'WIN!':o==='LOSS'?'LOSS!':'Skip');}}catch(e){all.forEach(b=>b.disabled=false);toast('Fehler: '+e.message);}}

async function lbt(){const el=document.getElementById('btb');el.innerHTML='<div class="empty">Lade…</div>';bd=await fetch('/backtesting').then(r=>r.json()).catch(()=>null);if(!bd||bd.error){el.innerHTML='<div class="empty">Fehler.</div>';return;}rbt(bp);}
function btt(p,btn){bp=p;document.querySelectorAll('.bt-tab').forEach(t=>t.classList.remove('on'));btn.classList.add('on');rbt(p);}
function rbt(p){if(!bd)return;const el=document.getElementById('btb');const d=p==='week'?bd.week:p==='month'?bd.month:bd.overall;const cl=(d.wins||0)+(d.losses||0);const wr=cl>0?((d.wins/cl)*100).toFixed(1):0;const o=bd.overall;let h=\`<div class="bt-ks"><div class="bt-k"><div class="bt-kv" style="color:var(--gr)">\${d.wins||0}</div><div class="bt-kl">Wins</div></div><div class="bt-k"><div class="bt-kv" style="color:var(--rd)">\${d.losses||0}</div><div class="bt-kl">Losses</div></div><div class="bt-k"><div class="bt-kv" style="color:var(--b3)">\${wr}%</div><div class="bt-kl">Winrate</div></div></div><div class="sc-cmp"><div class="sc-cmp-t">Score Durchschnitt — WIN vs LOSS</div><div class="sc-row"><div class="sc-l" style="color:var(--gr)">WIN</div><div class="sc-bg"><div class="sc-fi" style="width:\${o.avg_score_win||0}%;background:var(--gr)"></div></div><div class="sc-vl" style="color:var(--gr)">\${o.avg_score_win||0}</div></div><div class="sc-row"><div class="sc-l" style="color:var(--rd)">LOSS</div><div class="sc-bg"><div class="sc-fi" style="width:\${o.avg_score_loss||0}%;background:var(--rd)"></div></div><div class="sc-vl" style="color:var(--rd)">\${o.avg_score_loss||0}</div></div></div>\`;
if(bd.bySymbol?.length)h+=\`<div class="box" style="margin-bottom:11px"><div class="box-hdr"><div class="box-t">Winrate pro Symbol</div></div><div style="padding:0 4px"><table class="sym-tbl"><tr><th>Symbol</th><th>W</th><th>L</th><th>Win%</th><th>Ø Score</th></tr>\${bd.bySymbol.map(s=>{const c=(s.wins||0)+(s.losses||0);const w=c>0?((s.wins/c)*100).toFixed(0):0;return\`<tr><td><strong>\${s.symbol}</strong></td><td style="color:var(--gr)">\${s.wins||0}</td><td style="color:var(--rd)">\${s.losses||0}</td><td style="color:var(--b3);font-family:var(--m);font-weight:700">\${w}%</td><td style="font-family:var(--m)">\${Number(s.avg_score||0).toFixed(0)}</td></tr>\`;}).join('')}</table></div></div>\`;
if(bd.best?.length)h+=\`<div class="box" style="margin-bottom:11px"><div class="box-hdr"><div class="box-t">Beste Signale (WIN)</div></div><div class="box-body">\${bd.best.map(x=>\`<div class="bsr"><div><div class="bsr-sym">\${x.symbol} <span style="color:var(--gr);font-size:.58rem">\${x.ai_direction}</span></div><div class="bsr-sub">E: \${fmt(x.ai_entry)} → TP: \${fmt(x.ai_take_profit)}</div></div><div class="bsr-sc" style="color:var(--gr)">\${x.ai_score}/100</div></div>\`).join('')}</div></div>\`;
if(bd.worst?.length)h+=\`<div class="box"><div class="box-hdr"><div class="box-t">Schlechteste Signale (LOSS)</div></div><div class="box-body">\${bd.worst.map(x=>\`<div class="bsr"><div><div class="bsr-sym">\${x.symbol} <span style="color:var(--rd);font-size:.58rem">\${x.ai_direction}</span></div><div class="bsr-sub">E: \${fmt(x.ai_entry)} · SL: \${fmt(x.ai_stop_loss)}</div></div><div class="bsr-sc" style="color:var(--rd)">\${x.ai_score}/100</div></div>\`).join('')}</div></div>\`;
el.innerHTML=h;}

async function ta(a){if(!S&&a!=='health'){toast('Secret benoetigt');return;}toast('...');try{if(a==='health'){const d=await fetch('/health').then(r=>r.json());toast('OK: '+new Date(d.time).toLocaleTimeString('de-DE'),3000);}else if(a==='telegram'){await fetch('/test-telegram?secret='+encodeURIComponent(S));toast('Telegram Test gesendet!');}else if(a==='morning'){await fetch('/morning-brief?secret='+encodeURIComponent(S));toast('Morning Brief gesendet!');}else if(a==='outcomes'){const d=await fetch('/check-outcomes?secret='+encodeURIComponent(S)).then(r=>r.json());toast((d.result?.closed||0)+' Trades geschlossen',3000);}}catch(e){toast('Fehler: '+e.message);}}
function cp(c){navigator.clipboard.writeText(c).then(()=>toast('Kopiert: '+c));}

if(!ca()){}
</script>
</body>
</html>`;
}
