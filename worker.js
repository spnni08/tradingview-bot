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
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
[data-theme="dark"]{
  --bg:#07101f;--bg2:#0a1628;--bg3:#0e1e38;
  --card:#101e35;--card2:#132440;--card3:#172b4d;
  --border:#1c3055;--border2:#24406e;
  --blue:#2563eb;--blue2:#3b7bff;--blue3:#60a5fa;--blue4:#93c5fd;
  --dim:rgba(37,99,235,.1);--glow:rgba(37,99,235,.2);
  --green:#10b981;--red:#f43f5e;--amber:#f59e0b;--purple:#8b5cf6;
  --t1:#f1f8ff;--t2:#c8daf0;--t3:#6b8cac;--t4:#2a4466;
  --shadow:0 4px 20px rgba(0,0,0,.4);--shadow-sm:0 2px 8px rgba(0,0,0,.25);
}
[data-theme="light"]{
  --bg:#f5f7fa;--bg2:#edf0f5;--bg3:#e2e8f0;
  --card:#ffffff;--card2:#f8fafc;--card3:#f1f5f9;
  --border:#dde5f0;--border2:#c5d3e8;
  --blue:#1d4ed8;--blue2:#2563eb;--blue3:#3b82f6;--blue4:#1e3a8a;
  --dim:rgba(37,99,235,.07);--glow:rgba(37,99,235,.12);
  --green:#059669;--red:#e11d48;--amber:#d97706;--purple:#7c3aed;
  --t1:#0f172a;--t2:#334155;--t3:#64748b;--t4:#cbd5e1;
  --shadow:0 4px 20px rgba(0,0,0,.06);--shadow-sm:0 2px 8px rgba(0,0,0,.04);
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html{height:100%;scroll-behavior:smooth}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--t2);min-height:100vh;transition:background .3s,color .3s}

/* ══ LOGIN ══ */
#ls{position:fixed;inset:0;z-index:500;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px;transition:opacity .3s}
#ls.fade{opacity:0;pointer-events:none}
#ls.gone{display:none}
.lc{width:100%;max-width:400px;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:32px 28px;box-shadow:var(--shadow)}
.lh{text-align:center;margin-bottom:28px}
.ll{width:48px;height:48px;border-radius:12px;margin:0 auto 12px;display:block}
.lb{font-size:1.35rem;font-weight:700;color:var(--t1);letter-spacing:.04em;margin-bottom:2px}
.ls2{font-size:.78rem;color:var(--t3)}
.lul{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--t3);margin-bottom:10px}
.lug{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:22px}
.lu{border:2px solid var(--border);border-radius:11px;padding:14px 6px;cursor:pointer;text-align:center;background:var(--card2);transition:all .15s;font-family:'DM Sans',sans-serif}
.lu:hover{border-color:var(--blue3);transform:translateY(-1px)}
.lu.sel{border-color:var(--blue2);background:var(--dim)}
.lav{width:36px;height:36px;border-radius:50%;margin:0 auto 7px;display:flex;align-items:center;justify-content:center;font-size:.88rem;font-weight:700;color:#fff}
.av-M{background:linear-gradient(135deg,#1e40af,#3b82f6)}
.av-S{background:linear-gradient(135deg,#0369a1,#2563eb)}
.av-I{background:linear-gradient(135deg,#065f46,#059669)}
.lun{font-size:.75rem;font-weight:600;color:var(--t1)}
.lpw{display:none;margin-bottom:18px}
.lpw.v{display:block}
.lpl{font-size:.65rem;font-weight:600;color:var(--t3);margin-bottom:6px}
.lph{font-size:.6rem;color:var(--t3);margin-top:4px;font-style:italic}
.lpi{width:100%;padding:10px 13px;background:var(--bg2);border:1.5px solid var(--border);border-radius:9px;color:var(--t1);font-family:'DM Mono',monospace;font-size:.9rem;outline:none;transition:border-color .15s}
.lpi:focus{border-color:var(--blue2);box-shadow:0 0 0 3px var(--dim)}
.lbt{width:100%;padding:11px;background:var(--blue);color:#fff;border:none;border-radius:9px;font-family:'DM Sans',sans-serif;font-size:.88rem;font-weight:600;cursor:pointer;transition:all .15s;letter-spacing:.02em}
.lbt:hover{background:var(--blue2);box-shadow:0 4px 14px var(--glow)}
.lbt:active{transform:scale(.98)}
.lerr{font-size:.68rem;color:var(--red);text-align:center;margin-top:8px;min-height:14px}
.lft{text-align:center;margin-top:20px}
.lft p{font-size:.62rem;color:var(--t3);line-height:2.2}
.lft strong{color:var(--blue3);font-weight:600}

/* ══ HEADER ══ */
header{position:sticky;top:0;z-index:100;height:54px;background:var(--card);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 18px;gap:10px;box-shadow:var(--shadow-sm)}
.hl{display:flex;align-items:center;gap:8px;flex-shrink:0;margin-right:12px}
.hli{width:28px;height:28px;border-radius:7px}
.hln{font-size:.88rem;font-weight:700;color:var(--t1);letter-spacing:.03em}
.htg{font-size:.52rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--blue3);background:var(--dim);border:1px solid rgba(96,165,250,.2);padding:2px 6px;border-radius:4px}
.hdiv{width:1px;height:20px;background:var(--border);flex-shrink:0}
nav{display:flex;gap:1px;flex:1;overflow-x:auto;scrollbar-width:none}
nav::-webkit-scrollbar{display:none}
.nb{padding:6px 11px;border-radius:7px;font-size:.75rem;font-weight:500;color:var(--t3);border:none;background:none;cursor:pointer;white-space:nowrap;transition:all .12s;font-family:'DM Sans',sans-serif;display:flex;align-items:center;gap:5px}
.nb:hover{color:var(--t2);background:var(--bg2)}
.nb.on{color:var(--blue2);background:var(--dim);font-weight:600}
.nb-ic{font-size:.8rem}
.hr{display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0}
.hclk{font-family:'DM Mono',monospace;font-size:.62rem;color:var(--t3)}
.hli2{display:flex;align-items:center;gap:4px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.18);padding:3px 8px;border-radius:20px;font-size:.6rem;font-weight:600;color:var(--green)}
.hldot{width:5px;height:5px;border-radius:50%;background:var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(16,185,129,.4)}60%{opacity:.6;box-shadow:0 0 0 4px rgba(16,185,129,0)}}
.tbtn{width:30px;height:30px;border-radius:7px;border:1px solid var(--border);background:var(--bg2);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.88rem;transition:all .12s}
.tbtn:hover{background:var(--bg3);border-color:var(--border2)}
.uchip{display:flex;align-items:center;gap:6px;padding:4px 9px 4px 4px;border-radius:20px;border:1px solid var(--border);background:var(--card2);cursor:pointer;transition:all .12s}
.uchip:hover{background:var(--bg2);border-color:var(--border2)}
.uav{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.62rem;font-weight:700;color:#fff;flex-shrink:0}
.uname{font-size:.7rem;font-weight:600;color:var(--t1)}
.uout{font-size:.58rem;color:var(--t3)}

/* ══ PAGES ══ */
.page{display:none;padding:22px 18px;max-width:920px;margin:0 auto}
.page.on{display:block}
.ph{margin-bottom:22px}
.pt{font-size:1.3rem;font-weight:700;color:var(--t1)}
.pt em{color:var(--blue3);font-style:normal}
.ps{font-size:.78rem;color:var(--t3);margin-top:3px;line-height:1.5}

/* ══ HOME — EXPLAIN BANNER ══ */
.explain-banner{
  background:linear-gradient(120deg,var(--dim),rgba(59,123,255,.05));
  border:1px solid rgba(37,99,235,.2);border-radius:14px;
  padding:18px 20px;margin-bottom:22px;
  display:flex;align-items:flex-start;gap:14px
}
.eb-icon{font-size:1.6rem;flex-shrink:0;margin-top:2px}
.eb-title{font-size:.9rem;font-weight:700;color:var(--t1);margin-bottom:4px}
.eb-text{font-size:.76rem;color:var(--t3);line-height:1.65}
.eb-steps{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.eb-step{display:flex;align-items:center;gap:6px;font-size:.7rem;color:var(--t2);background:var(--card);border:1px solid var(--border);border-radius:20px;padding:4px 10px}
.eb-step-n{width:18px;height:18px;border-radius:50%;background:var(--blue);color:#fff;font-size:.6rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}

/* ══ KPI STRIP ══ */
.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 14px;position:relative;overflow:hidden;transition:border-color .15s,transform .15s}
.kpi:hover{border-color:var(--border2);transform:translateY(-1px)}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
.kpi.kb::before{background:linear-gradient(90deg,var(--blue),var(--blue3))}
.kpi.kg::before{background:var(--green)}
.kpi.kr::before{background:var(--red)}
.kpi.kw::before{background:linear-gradient(90deg,var(--border2),var(--border))}
.kpi-ic{font-size:1.1rem;margin-bottom:8px}
.kpi-lbl{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--t3);margin-bottom:6px}
.kpi-val{font-family:'DM Mono',monospace;font-size:1.85rem;font-weight:500;line-height:1;color:var(--t1)}
.kpi-val.vb{color:var(--blue3)}
.kpi-val.vg{color:var(--green)}
.kpi-val.vr{color:var(--red)}
.kpi-desc{font-size:.6rem;color:var(--t3);margin-top:5px}

/* ══ GRID ══ */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}

/* ══ CARD ══ */
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--shadow-sm)}
.ch{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid var(--border)}
.ct{font-size:.8rem;font-weight:600;color:var(--t1)}
.cs{font-size:.65rem;color:var(--t3);margin-top:1px}
.cb{padding:14px 16px}

/* ══ QUICK ACTIONS (labeled) ══ */
.qa-list{display:flex;flex-direction:column;gap:7px}
.qa{display:flex;align-items:center;gap:12px;padding:11px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:all .15s;font-family:'DM Sans',sans-serif;text-align:left;width:100%}
.qa:hover{background:var(--dim);border-color:var(--blue3);transform:translateX(2px)}
.qa:active{transform:scale(.99)}
.qa-ic{font-size:1.1rem;width:32px;height:32px;border-radius:8px;background:var(--card);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.qa-info{flex:1;text-align:left}
.qa-lbl{font-size:.78rem;font-weight:600;color:var(--t1)}
.qa-desc{font-size:.63rem;color:var(--t3);margin-top:1px}
.qa-arr{color:var(--t3);font-size:.75rem;flex-shrink:0}

/* ══ RECENT SIGNALS ══ */
.rs{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}
.rs:last-child{border-bottom:none;padding-bottom:0}
.rs-dp{width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:.65rem;font-weight:700;flex-shrink:0}
.dp-L{background:rgba(16,185,129,.12);color:var(--green);border:1px solid rgba(16,185,129,.2)}
.dp-S{background:rgba(244,63,94,.12);color:var(--red);border:1px solid rgba(244,63,94,.2)}
.rs-info{flex:1;min-width:0}
.rs-sym{font-size:.82rem;font-weight:700;color:var(--t1)}
.rs-sub{font-size:.62rem;color:var(--t3);font-family:'DM Mono',monospace;margin-top:1px}
.rs-right{text-align:right;flex-shrink:0}
.rs-sc{font-family:'DM Mono',monospace;font-size:.78rem;font-weight:500}
.rs-age{font-size:.58rem;color:var(--t3);margin-top:1px}

/* ══ WB LINK ══ */
.wbl{display:flex;align-items:center;gap:12px;padding:15px 16px;border-radius:12px;background:var(--card);border:1px solid var(--border);text-decoration:none;color:inherit;transition:all .15s;box-shadow:var(--shadow-sm);margin-bottom:12px;position:relative;overflow:hidden}
.wbl::before{content:'';position:absolute;inset:0;background:linear-gradient(120deg,var(--dim),transparent);pointer-events:none}
.wbl:hover{border-color:var(--blue3);box-shadow:0 0 0 3px var(--dim)}
.wbl-ic{font-size:1.7rem;flex-shrink:0}
.wbl-t{font-size:.88rem;font-weight:700;color:var(--t1)}
.wbl-s{font-size:.65rem;color:var(--t3);margin-top:2px}
.wbl-btn{margin-left:auto;background:var(--blue);color:#fff;font-size:.65rem;font-weight:600;padding:5px 12px;border-radius:20px;flex-shrink:0;transition:background .12s}
.wbl:hover .wbl-btn{background:var(--blue2)}

/* ══ STATUS BAR ══ */
.status-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;background:var(--card2);border:1px solid var(--border);border-radius:10px;margin-bottom:20px;font-size:.72rem;color:var(--t3)}
.sb-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.sb-dot.g{background:var(--green)}
.sb-dot.a{background:var(--amber)}

/* ══ ANALYSE ══ */
.snap{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:13px 15px;display:flex;align-items:center;gap:11px;margin-bottom:7px;transition:border-color .12s;box-shadow:var(--shadow-sm)}
.snap:hover{border-color:var(--border2)}
.snap-sym{font-size:.86rem;font-weight:700;color:var(--t1)}
.snap-meta{font-family:'DM Mono',monospace;font-size:.6rem;color:var(--t3);margin-top:2px}
.snap-px{font-family:'DM Mono',monospace;font-size:.85rem;font-weight:500;color:var(--blue3);white-space:nowrap}
.res{background:var(--card2);border:1px solid var(--border2);border-radius:11px;overflow:hidden;margin-bottom:7px;animation:fd .2s ease}
@keyframes fd{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.res-top{display:flex;align-items:center;justify-content:space-between;padding:11px 15px;border-bottom:1px solid var(--border)}
.rbadge{font-size:.68rem;font-weight:700;padding:4px 10px;border-radius:20px}
.ry{background:rgba(16,185,129,.12);color:var(--green);border:1px solid rgba(16,185,129,.2)}
.rn{background:rgba(244,63,94,.12);color:var(--red);border:1px solid rgba(244,63,94,.2)}
.res-bd{padding:13px 15px;display:flex;flex-direction:column;gap:9px}
.rr{display:flex;justify-content:space-between;align-items:center}
.rk{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--t3)}
.rv{font-family:'DM Mono',monospace;font-size:.76rem;color:var(--t2)}
.rplan{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px}
.rpc{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:9px;text-align:center}
.rpl{font-size:.55rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--t3)}
.rpv{font-family:'DM Mono',monospace;font-size:.78rem;font-weight:500;margin-top:3px}
.rreason{font-size:.72rem;color:var(--t3);line-height:1.65;padding-top:9px;border-top:1px solid var(--border)}
.bar{height:3px;background:var(--bg3);border-radius:99px;overflow:hidden}
.bar-f{height:100%;border-radius:99px}

/* ══ SIGNALS ══ */
.frow{display:flex;gap:7px;margin-bottom:12px;flex-wrap:wrap}
.fsel{flex:1;min-width:95px;padding:7px 11px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:'DM Sans',sans-serif;font-size:.74rem;outline:none;cursor:pointer;transition:border-color .12s}
.fsel:focus{border-color:var(--blue2)}
.fpill{padding:6px 13px;background:var(--card);border:1px solid var(--border);border-radius:20px;color:var(--t3);font-family:'DM Sans',sans-serif;font-size:.7rem;font-weight:500;cursor:pointer;white-space:nowrap;transition:all .12s}
.fpill.on{background:var(--dim);border-color:var(--blue3);color:var(--blue2);font-weight:600}
.sc{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:14px 16px;margin-bottom:7px;box-shadow:var(--shadow-sm);transition:border-color .12s}
.sc:hover{border-color:var(--border2)}
.sc-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:9px}
.sc-left{}
.sc-sym{font-size:.88rem;font-weight:700;color:var(--t1)}
.sc-dp{font-size:.62rem;font-weight:600;padding:2px 7px;border-radius:20px;margin-top:3px;display:inline-block}
.dp-long{background:rgba(16,185,129,.1);color:var(--green)}
.dp-short{background:rgba(244,63,94,.1);color:var(--red)}
.sc-right{text-align:right;flex-shrink:0}
.sc-score{font-family:'DM Mono',monospace;font-size:.88rem;font-weight:500}
.sc-age{font-size:.58rem;color:var(--t3);margin-top:2px}
.sc-px{font-family:'DM Mono',monospace;font-size:.64rem;color:var(--t3);display:flex;gap:12px;margin-bottom:8px}
.sc-ft{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:7px;margin-top:8px}
.tags{display:flex;gap:4px;flex-wrap:wrap}
.tg{font-size:.6rem;font-weight:600;padding:3px 7px;border-radius:20px}
.tw{background:rgba(16,185,129,.1);color:var(--green);border:1px solid rgba(16,185,129,.18)}
.to{background:var(--dim);color:var(--blue3);border:1px solid rgba(59,123,255,.18)}
.tl{background:rgba(244,63,94,.1);color:var(--red);border:1px solid rgba(244,63,94,.18)}
.tsk{background:var(--bg2);color:var(--t3);border:1px solid var(--border)}
.tr{background:rgba(16,185,129,.08);color:var(--green)}
.tnr{background:rgba(244,63,94,.08);color:var(--red)}
.tlo{background:rgba(16,185,129,.08);color:var(--green)}
.tmd{background:rgba(245,158,11,.08);color:var(--amber)}
.thi{background:rgba(244,63,94,.08);color:var(--red)}
.obt{display:flex;gap:5px}
.ob{font-family:'DM Sans',sans-serif;font-size:.66rem;font-weight:600;padding:5px 9px;border-radius:7px;cursor:pointer;border:1px solid;transition:all .12s}
.ob:hover{transform:translateY(-1px)}
.obw{background:rgba(16,185,129,.1);color:var(--green);border-color:rgba(16,185,129,.25)}
.obl{background:rgba(244,63,94,.1);color:var(--red);border-color:rgba(244,63,94,.25)}
.obs{background:var(--bg2);color:var(--t3);border-color:var(--border)}

/* ══ BACKTESTING ══ */
.bt-tabs{display:flex;gap:5px;margin-bottom:16px}
.bttab{padding:6px 16px;background:var(--card);border:1px solid var(--border);border-radius:20px;color:var(--t3);font-family:'DM Sans',sans-serif;font-size:.72rem;font-weight:500;cursor:pointer;transition:all .12s}
.bttab.on{background:var(--blue);border-color:var(--blue);color:#fff;font-weight:600}
.bt-ks{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.btk{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;box-shadow:var(--shadow-sm)}
.btkv{font-family:'DM Mono',monospace;font-size:1.5rem;font-weight:500;line-height:1}
.btkl{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);margin-top:6px}
.scmp{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:var(--shadow-sm)}
.scmp-t{font-size:.8rem;font-weight:600;color:var(--t1);margin-bottom:12px}
.scmp-s{font-size:.7rem;color:var(--t3);margin-bottom:12px;line-height:1.5}
.scr{display:flex;align-items:center;gap:10px;margin-bottom:9px}
.scr:last-child{margin-bottom:0}
.scrl{font-size:.7rem;font-weight:600;width:50px;flex-shrink:0}
.scrb{flex:1;height:7px;background:var(--bg3);border-radius:99px;overflow:hidden}
.scrf{height:100%;border-radius:99px;transition:width .8s ease}
.scrv{font-family:'DM Mono',monospace;font-size:.68rem;font-weight:500;width:32px;text-align:right;flex-shrink:0}
.stbl{width:100%;border-collapse:collapse;font-size:.74rem}
.stbl th{text-align:left;padding:8px 10px;font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);border-bottom:1px solid var(--border)}
.stbl td{padding:9px 10px;border-bottom:1px solid var(--border)}
.stbl tr:last-child td{border-bottom:none}
.bsr{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)}
.bsr:last-child{border-bottom:none;padding-bottom:0}
.bsr-sym{font-size:.8rem;font-weight:700;color:var(--t1)}
.bsr-sub{font-size:.62rem;color:var(--t3);font-family:'DM Mono',monospace;margin-top:1px}
.bsr-sc{font-family:'DM Mono',monospace;font-size:.88rem;font-weight:500}

/* ══ STRATEGIE ══ */
.str{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:10px;box-shadow:var(--shadow-sm)}
.strh{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid var(--border);background:var(--card2)}
.strhi{font-size:.95rem}
.strt{font-size:.82rem;font-weight:700;color:var(--t1)}
.strb{padding:14px 16px}
.step{display:flex;gap:11px;margin-bottom:13px}
.step:last-child{margin-bottom:0}
.stn{width:22px;height:22px;border-radius:50%;background:var(--dim);border:1px solid rgba(59,123,255,.25);color:var(--blue3);font-size:.62rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.stit{font-size:.78rem;font-weight:700;color:var(--t1);margin-bottom:3px}
.sttx{font-size:.74rem;line-height:1.65;color:var(--t3)}
.sttx strong{color:var(--t2);font-weight:600}
.srul{display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)}
.srul:last-child{border-bottom:none}
.sruli{width:17px;flex-shrink:0;font-size:.8rem;margin-top:1px}
.srult{font-size:.74rem;color:var(--t3);line-height:1.55}
.srult strong{color:var(--t2);font-weight:600}
.nol{display:flex;flex-direction:column;gap:6px}
.noi{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(244,63,94,.04);border:1px solid rgba(244,63,94,.1);border-radius:8px;font-size:.74rem;color:var(--t3)}

/* ══ TOOLS ══ */
.tlg{margin-bottom:14px}
.tlgl{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);margin-bottom:7px;padding:0 2px}
.tll{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--shadow-sm)}
.tlr{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s;text-decoration:none;color:inherit}
.tlr:last-child{border-bottom:none}
.tlr:hover{background:var(--bg2)}
.tlri{font-size:1rem;width:24px;flex-shrink:0}
.tlrtx{flex:1}
.tlrl{font-size:.78rem;font-weight:600;color:var(--t1)}
.tlrd{font-size:.63rem;color:var(--t3);margin-top:1px}
.tlra{color:var(--t3);font-size:.72rem}

/* ══ TELEGRAM ══ */
.cmdi{font-size:.76rem;color:var(--t3);line-height:1.65;margin-bottom:14px;padding:13px 15px;background:var(--dim);border:1px solid rgba(37,99,235,.15);border-radius:9px}
.cmdg{display:flex;flex-direction:column;gap:5px}
.cmdr{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:var(--card);border:1px solid var(--border);border-radius:9px;cursor:pointer;transition:all .12s;box-shadow:var(--shadow-sm)}
.cmdr:hover{background:var(--card2);border-color:var(--border2);transform:translateX(2px)}
.cmdc{font-family:'DM Mono',monospace;font-size:.8rem;color:var(--blue3);font-weight:500}
.cmdd{font-size:.66rem;color:var(--t3);margin-top:2px}

/* ══ SHARED ══ */
.btn{font-family:'DM Sans',sans-serif;font-weight:600;font-size:.74rem;border:none;border-radius:8px;padding:7px 13px;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:5px}
.btn:active{transform:scale(.97)}
.btn:disabled{opacity:.3;cursor:not-allowed;transform:none}
.btn-p{background:var(--blue);color:#fff}
.btn-p:hover{background:var(--blue2);box-shadow:0 4px 12px var(--glow)}
.btn-g{background:var(--bg2);border:1px solid var(--border);color:var(--t3);font-size:.68rem;padding:5px 11px}
.btn-g:hover{background:var(--bg3);border-color:var(--border2);color:var(--t2)}
.sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px}
.sl{font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--t3)}
.empty{text-align:center;padding:32px 20px;color:var(--t3)}
.empty p{font-size:.8rem;line-height:1.7}
.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--t1);color:var(--bg);font-size:.74rem;font-weight:500;padding:9px 18px;border-radius:20px;z-index:9999;pointer-events:none;opacity:0;transition:opacity .2s;white-space:nowrap;max-width:92vw;box-shadow:0 8px 24px rgba(0,0,0,.25)}
.toast.on{opacity:1}

/* ══ RESPONSIVE ══ */
@media(max-width:640px){
  .page{padding:14px 13px}
  .kpi-row{grid-template-columns:repeat(2,1fr);gap:8px}
  .g2{grid-template-columns:1fr}
  .bt-ks{grid-template-columns:repeat(3,1fr)}
  .hclk,.htg,.uname{display:none}
  .nb{font-size:.7rem;padding:5px 8px}
  .nb-ic{display:none}
  .bnv{display:flex!important}
  body{padding-bottom:58px}
}
.bnv{display:none;position:fixed;bottom:0;left:0;right:0;z-index:100;background:var(--card);border-top:1px solid var(--border);padding:5px 0 max(5px,env(safe-area-inset-bottom));box-shadow:0 -4px 16px rgba(0,0,0,.08)}
@media(max-width:640px){.bnv{display:flex}}
.bn{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;padding:5px 0;font-size:.54rem;font-weight:600;color:var(--t3);transition:color .12s;border:none;background:none;font-family:'DM Sans',sans-serif}
.bn.on{color:var(--blue2)}
.bn-ic{font-size:1.1rem}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="ls">
  <div class="lc">
    <div class="lh">
      <img src="${LS}" class="ll" alt="">
      <div class="lb">WAVESCOUT</div>
      <div class="ls2">Trading Signal Dashboard</div>
    </div>
    <div class="lul">Account wählen</div>
    <div class="lug">
      <div class="lu" onclick="pu('Marvin',this)"><div class="lav av-M">M</div><div class="lun">Marvin</div></div>
      <div class="lu" onclick="pu('Sandro',this)"><div class="lav av-S">S</div><div class="lun">Sandro</div></div>
      <div class="lu" onclick="pu('Iven',this)"><div class="lav av-I">I</div><div class="lun">Iven</div></div>
    </div>
    <div class="lpw" id="lpw">
      <div class="lpl">Passwort</div>
      <input type="password" class="lpi" id="lpi" placeholder="••••••••" onkeydown="if(event.key==='Enter')dl()">
      <div class="lph" id="lph"></div>
    </div>
    <button class="lbt" id="lbt" style="display:none" onclick="dl()">Anmelden →</button>
    <div class="lerr" id="lerr"></div>
    <div class="lft"><p>Made by <strong>WaveWatch</strong> · Made for Trader</p></div>
  </div>
</div>

<!-- HEADER -->
<header>
  <div class="hl">
    <img src="${LS}" class="hli" alt="">
    <span class="hln">WAVESCOUT</span>
    <span class="htg">v3</span>
  </div>
  <div class="hdiv"></div>
  <nav>
    <button class="nb on" onclick="go('home')"><span class="nb-ic">🏠</span>Home</button>
    <button class="nb" onclick="go('analyse')"><span class="nb-ic">🔍</span>Analyse</button>
    <button class="nb" onclick="go('signals')"><span class="nb-ic">📋</span>Signale</button>
    <button class="nb" onclick="go('bt')"><span class="nb-ic">📊</span>Backtesting</button>
    <button class="nb" onclick="go('str')"><span class="nb-ic">📖</span>Strategie</button>
    <button class="nb" onclick="go('tools')"><span class="nb-ic">🔧</span>Tools</button>
    <button class="nb" onclick="go('tg')"><span class="nb-ic">💬</span>Telegram</button>
  </nav>
  <div class="hr">
    <div class="hclk" id="clk">–</div>
    <div class="hli2"><div class="hldot"></div>Live</div>
    <button class="tbtn" id="thbtn" onclick="toggleTheme()">🌙</button>
    <div class="uchip" onclick="logout()">
      <div class="uav" id="uav" style="background:linear-gradient(135deg,#1e40af,#3b82f6)">M</div>
      <span class="uname" id="uname">Marvin</span>
      <span class="uout">✕</span>
    </div>
  </div>
</header>

<div>
<!-- HOME -->
<div class="page on" id="pg-home">
  <div class="ph">
    <div class="pt" id="htitle">Guten Morgen, <em>Trader</em> 👋</div>
    <div class="ps" id="hdate">Dein Trading-Überblick für heute</div>
  </div>

  <!-- Erklärungs-Banner für neue Nutzer -->
  <div class="explain-banner">
    <div class="eb-icon">💡</div>
    <div>
      <div class="eb-title">Wie funktioniert WAVESCOUT?</div>
      <div class="eb-text">TradingView erkennt automatisch Signale nach deiner Strategie und schickt sie hierher. Claude analysiert sie und du bekommst eine Telegram-Nachricht wenn ein gutes Setup vorliegt.</div>
      <div class="eb-steps">
        <div class="eb-step"><div class="eb-step-n">1</div>TradingView erkennt Signal</div>
        <div class="eb-step"><div class="eb-step-n">2</div>Claude analysiert</div>
        <div class="eb-step"><div class="eb-step-n">3</div>Telegram-Nachricht</div>
        <div class="eb-step"><div class="eb-step-n">4</div>Du entscheidest</div>
      </div>
    </div>
  </div>

  <!-- KPIs -->
  <div class="kpi-row">
    <div class="kpi kb">
      <div class="kpi-ic">📂</div>
      <div class="kpi-lbl">Offene Trades</div>
      <div class="kpi-val vb" id="k-open">–</div>
      <div class="kpi-desc">Noch nicht ausgewertet</div>
    </div>
    <div class="kpi kg">
      <div class="kpi-ic">✅</div>
      <div class="kpi-lbl">Wins</div>
      <div class="kpi-val vg" id="k-wins">–</div>
      <div class="kpi-desc">Erfolgreiche Trades</div>
    </div>
    <div class="kpi kr">
      <div class="kpi-ic">❌</div>
      <div class="kpi-lbl">Losses</div>
      <div class="kpi-val vr" id="k-losses">–</div>
      <div class="kpi-desc">Verlustbringende Trades</div>
    </div>
    <div class="kpi kw">
      <div class="kpi-ic">🎯</div>
      <div class="kpi-lbl">Winrate</div>
      <div class="kpi-val" id="k-wr" style="color:var(--t1)">–</div>
      <div class="kpi-desc">Trefferquote gesamt</div>
    </div>
  </div>

  <div class="g2">
    <!-- Aktionen mit Erklärung -->
    <div class="card">
      <div class="ch">
        <div><div class="ct">Was möchtest du tun?</div><div class="cs">Klicke auf eine Aktion</div></div>
      </div>
      <div class="cb">
        <div class="qa-list">
          <button class="qa" onclick="go('analyse')">
            <div class="qa-ic">🔍</div>
            <div class="qa-info"><div class="qa-lbl">Symbol analysieren</div><div class="qa-desc">Claude prüft den aktuellen Markt für ein Symbol</div></div>
            <div class="qa-arr">›</div>
          </button>
          <button class="qa" onclick="ta('morning')">
            <div class="qa-ic">🌅</div>
            <div class="qa-info"><div class="qa-lbl">Morning Brief abrufen</div><div class="qa-desc">Tages-Bias für alle Symbole als Telegram-Nachricht</div></div>
            <div class="qa-arr">›</div>
          </button>
          <button class="qa" onclick="ta('outcomes')">
            <div class="qa-ic">🔄</div>
            <div class="qa-info"><div class="qa-lbl">WIN/LOSS aktualisieren</div><div class="qa-desc">Offene Trades automatisch via Binance-Preis auflösen</div></div>
            <div class="qa-arr">›</div>
          </button>
          <button class="qa" onclick="go('bt')">
            <div class="qa-ic">📊</div>
            <div class="qa-info"><div class="qa-lbl">Backtesting ansehen</div><div class="qa-desc">Winrate, Score-Analyse und beste/schlechteste Signale</div></div>
            <div class="qa-arr">›</div>
          </button>
        </div>
      </div>
    </div>

    <!-- Letzte Signale -->
    <div class="card">
      <div class="ch">
        <div><div class="ct">Letzte Signale</div><div class="cs">Von TradingView empfangen</div></div>
        <button class="btn btn-g" onclick="go('signals')">Alle →</button>
      </div>
      <div class="cb" id="home-sigs"><div class="empty"><p>Noch keine Signale.<br>TradingView muss erst Daten senden.</p></div></div>
    </div>
  </div>

  <a class="wbl" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank">
    <div class="wbl-ic">🌊</div>
    <div><div class="wbl-t">WaveBoard öffnen</div><div class="wbl-s">Dein externes Trading Dashboard</div></div>
    <div class="wbl-btn">↗ Öffnen</div>
  </a>
</div>

<!-- ANALYSE -->
<div class="page" id="pg-analyse">
  <div class="ph">
    <div class="pt">Analyse</div>
    <div class="ps">Klicke auf <strong>Prüfen</strong> — Claude analysiert den aktuellen Snapshot dieses Symbols und gibt dir eine Empfehlung mit Entry, TP und SL.</div>
  </div>
  <div class="sh"><div class="sl">Aktuelle Snapshots</div><button class="btn btn-g" onclick="ls2()">↻ Refresh</button></div>
  <div id="snap-list"><div class="empty"><p>Lade…</p></div></div>
</div>

<!-- SIGNALE -->
<div class="page" id="pg-signals">
  <div class="ph">
    <div class="pt">Signale</div>
    <div class="ps">Alle erkannten Signale von TradingView. Filtere nach Symbol oder Status. Markiere Trades als WIN, LOSS oder Skip wenn du sie ausgewertet hast.</div>
  </div>
  <div class="frow">
    <select class="fsel" id="fsym" onchange="af()"><option value="">Alle Symbole</option></select>
    <select class="fsel" id="fout" onchange="af()" style="flex:.7">
      <option value="">Alle Status</option>
      <option value="OPEN">Open</option>
      <option value="WIN">Win</option>
      <option value="LOSS">Loss</option>
      <option value="SKIPPED">Skipped</option>
    </select>
    <button class="fpill on" id="ss" onclick="srt('score')">Score ↓</button>
    <button class="fpill" id="st" onclick="srt('time')">Neueste ↓</button>
  </div>
  <div id="sig-list"><div class="empty"><p>Lade…</p></div></div>
</div>

<!-- BACKTESTING -->
<div class="page" id="pg-bt">
  <div class="ph">
    <div class="pt">Backtesting</div>
    <div class="ps">Auswertung aller bisherigen Signale. Der Score-Vergleich zeigt ob höhere Scores wirklich besser performen.</div>
  </div>
  <div class="bt-tabs">
    <button class="bttab on" onclick="btp('all',this)">Gesamt</button>
    <button class="bttab" onclick="btp('month',this)">30 Tage</button>
    <button class="bttab" onclick="btp('week',this)">7 Tage</button>
  </div>
  <div id="bt-body"><div class="empty"><p>Lade…</p></div></div>
</div>

<!-- STRATEGIE -->
<div class="page" id="pg-str">
  <div class="ph">
    <div class="pt">Strategie</div>
    <div class="ps">Deine Top-Down Daytrading Strategie — alle Regeln auf einen Blick.</div>
  </div>
  <div class="str"><div class="strh"><div class="strhi">🎯</div><div class="strt">Der 3-Schritt-Prozess</div></div><div class="strb">
    <div class="step"><div class="stn">1</div><div><div class="stit">Morgen-Routine (10 Min)</div><div class="sttx">4H Chart öffnen → EMA200 prüfen. Preis <strong>darüber = Long-Bias</strong>, darunter = Short-Bias. EMA flach = kein Trade heute. 1–2 Key-Zonen auf 15min markieren.</div></div></div>
    <div class="step"><div class="stn">2</div><div><div class="stit">Zonenanalyse (15min)</div><div class="sttx">Warten bis der Preis eine markierte Zone erreicht. <strong>Nicht hinterherlaufen.</strong> Higher Low (Long) oder Lower High (Short) sichtbar. Kein Chaos, kein Seitwärtsmarkt.</div></div></div>
    <div class="step"><div class="stn">3</div><div><div class="stit">Entry (5–10min)</div><div class="sttx">Klare Trendkerze, <strong>starker Body, wenig Docht.</strong> Bruch von lokalem High/Low abwarten. RSI als Filter — kein alleiniges Signal.</div></div></div>
  </div></div>
  <div class="str"><div class="strh"><div class="strhi">📏</div><div class="strt">Entry-Regeln (alle müssen zutreffen)</div></div><div class="strb">
    <div class="srul"><div class="sruli">✅</div><div class="srult"><strong>RSI Long:</strong> 30–55 steigend. <strong>Short:</strong> 45–70 fallend. Kein Entry bei RSI über 70 oder unter 30.</div></div>
    <div class="srul"><div class="sruli">✅</div><div class="srult"><strong>EMA200 (4H):</strong> Preis darüber = nur Long. Darunter = nur Short.</div></div>
    <div class="srul"><div class="sruli">✅</div><div class="srult"><strong>Trendstruktur:</strong> EMA50 über EMA200 (Long) oder darunter. Neutral = kein Trade.</div></div>
    <div class="srul"><div class="sruli">✅</div><div class="srult"><strong>Zone:</strong> Long nah an Support. Short nah an Resistance.</div></div>
    <div class="srul"><div class="sruli">✅</div><div class="srult"><strong>R/R:</strong> Mindestens 1:1.5. SL logisch unter/über Struktur.</div></div>
  </div></div>
  <div class="str"><div class="strh"><div class="strhi">🚫</div><div class="strt">Kein Trade — sofort raus wenn eines zutrifft</div></div><div class="strb">
    <div class="nol">
      <div class="noi">❌ Trade läuft gegen den Tages-Bias</div>
      <div class="noi">❌ EMA200 (4H) flach oder Preis direkt dran</div>
      <div class="noi">❌ Viele Wicks, Chaos, kein klares Bild</div>
      <div class="noi">❌ FOMO — man will unbedingt rein</div>
      <div class="noi">❌ RSI extrem überkauft oder überverkauft</div>
      <div class="noi">❌ Man könnte den Trade nicht erklären</div>
    </div>
  </div></div>
  <div class="str"><div class="strh"><div class="strhi">✔️</div><div class="strt">Final Check — alle 3 mit Ja?</div></div><div class="strb">
    <div class="srul"><div class="sruli">☑️</div><div class="srult">Passt der Trade zum heutigen Tages-Bias?</div></div>
    <div class="srul"><div class="sruli">☑️</div><div class="srult">Könnte ich diesen Trade einem anderen Trader erklären?</div></div>
    <div class="srul"><div class="sruli">☑️</div><div class="srult">Ruhig und klar im Kopf? — Wenn nein: warten.</div></div>
  </div></div>
</div>

<!-- TOOLS -->
<div class="page" id="pg-tools">
  <div class="ph"><div class="pt">Tools</div><div class="ps">Aktionen und externe Links.</div></div>
  <a class="wbl" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank" style="display:flex;margin-bottom:16px">
    <div class="wbl-ic">🌊</div><div><div class="wbl-t">WaveBoard Dashboard</div><div class="wbl-s">waveboard-e54ed.web.app</div></div><div class="wbl-btn">↗ Öffnen</div>
  </a>
  <div class="tlg"><div class="tlgl">System-Aktionen</div><div class="tll">
    <div class="tlr" onclick="ta('health')"><div class="tlri">💚</div><div class="tlrtx"><div class="tlrl">Health Check</div><div class="tlrd">Worker Status prüfen</div></div><div class="tlra">›</div></div>
    <div class="tlr" onclick="ta('telegram')"><div class="tlri">📨</div><div class="tlrtx"><div class="tlrl">Telegram testen</div><div class="tlrd">Test-Nachricht senden</div></div><div class="tlra">›</div></div>
    <div class="tlr" onclick="ta('morning')"><div class="tlri">🌅</div><div class="tlrtx"><div class="tlrl">Morning Brief</div><div class="tlrd">Tages-Bias für alle Symbole</div></div><div class="tlra">›</div></div>
    <div class="tlr" onclick="ta('outcomes')"><div class="tlri">🔄</div><div class="tlrtx"><div class="tlrl">Outcome Tracking</div><div class="tlrd">WIN/LOSS via Binance aktualisieren</div></div><div class="tlra">›</div></div>
  </div></div>
  <div class="tlg"><div class="tlgl">Externe Links</div><div class="tll">
    <a class="tlr" href="https://tradingview.com" target="_blank"><div class="tlri">📊</div><div class="tlrtx"><div class="tlrl">TradingView</div><div class="tlrd">Charts & Alerts verwalten</div></div><div class="tlra">↗</div></a>
    <a class="tlr" href="https://dash.cloudflare.com" target="_blank"><div class="tlri">☁️</div><div class="tlrtx"><div class="tlrl">Cloudflare</div><div class="tlrd">Worker & Logs</div></div><div class="tlra">↗</div></a>
    <a class="tlr" href="https://github.com/spnni08/tradingview-bot" target="_blank"><div class="tlri">🐙</div><div class="tlrtx"><div class="tlrl">GitHub Repository</div><div class="tlrd">spnni08/tradingview-bot</div></div><div class="tlra">↗</div></a>
    <a class="tlr" href="https://console.anthropic.com" target="_blank"><div class="tlri">🤖</div><div class="tlrtx"><div class="tlrl">Anthropic Console</div><div class="tlrd">Claude API Keys</div></div><div class="tlra">↗</div></a>
  </div></div>
</div>

<!-- TELEGRAM -->
<div class="page" id="pg-tg">
  <div class="ph"><div class="pt">Telegram Kommandos</div><div class="ps">Schicke diese Kommandos direkt an den WAVESCOUT Bot in Telegram. Du bekommst sofort eine Claude-Analyse zurück.</div></div>
  <div class="cmdi">💡 <strong>Tipp:</strong> Tippe z.B. <code style="font-family:'DM Mono',monospace;color:var(--blue3)">/btc</code> in deinen Telegram-Chat mit dem Bot — du bekommst innerhalb von Sekunden eine vollständige Analyse.</div>
  <div class="cmdg">
    <div class="cmdr" onclick="cp('/btc')"><div><div class="cmdc">/btc</div><div class="cmdd">Bitcoin sofort analysieren</div></div><span style="color:var(--t3)">⎘</span></div>
    <div class="cmdr" onclick="cp('/eth')"><div><div class="cmdc">/eth</div><div class="cmdd">Ethereum analysieren</div></div><span style="color:var(--t3)">⎘</span></div>
    <div class="cmdr" onclick="cp('/sol')"><div><div class="cmdc">/sol</div><div class="cmdd">Solana analysieren</div></div><span style="color:var(--t3)">⎘</span></div>
    <div class="cmdr" onclick="cp('/check RENDERUSDT')"><div><div class="cmdc">/check SYMBOL</div><div class="cmdd">Beliebiges Symbol analysieren</div></div><span style="color:var(--t3)">⎘</span></div>
    <div class="cmdr" onclick="cp('/status')"><div><div class="cmdc">/status</div><div class="cmdd">Winrate & Stats abrufen</div></div><span style="color:var(--t3)">⎘</span></div>
    <div class="cmdr" onclick="cp('/brief')"><div><div class="cmdc">/brief</div><div class="cmdd">Morning Brief jetzt senden</div></div><span style="color:var(--t3)">⎘</span></div>
    <div class="cmdr" onclick="cp('/open')"><div><div class="cmdc">/open</div><div class="cmdd">Alle offenen Trades anzeigen</div></div><span style="color:var(--t3)">⎘</span></div>
    <div class="cmdr" onclick="cp('/top')"><div><div class="cmdc">/top</div><div class="cmdd">Beste Signale der letzten 24h</div></div><span style="color:var(--t3)">⎘</span></div>
    <div class="cmdr" onclick="cp('/hilfe')"><div><div class="cmdc">/hilfe</div><div class="cmdd">Alle Kommandos anzeigen</div></div><span style="color:var(--t3)">⎘</span></div>
  </div>
</div>
</div>

<!-- BOTTOM NAV -->
<nav class="bnv" id="bnv">
  <button class="bn on" onclick="go('home')"><span class="bn-ic">🏠</span>Home</button>
  <button class="bn" onclick="go('analyse')"><span class="bn-ic">🔍</span>Analyse</button>
  <button class="bn" onclick="go('signals')"><span class="bn-ic">📋</span>Signale</button>
  <button class="bn" onclick="go('bt')"><span class="bn-ic">📊</span>Backtest</button>
  <button class="bn" onclick="go('tools')"><span class="bn-ic">🔧</span>Tools</button>
</nav>

<div class="toast" id="toast"></div>

<script>
const SECRET=new URLSearchParams(location.search).get('secret')||'';
const UA={Marvin:{bg:'linear-gradient(135deg,#1e40af,#3b82f6)',i:'M'},Sandro:{bg:'linear-gradient(135deg,#0369a1,#2563eb)',i:'S'},Iven:{bg:'linear-gradient(135deg,#065f46,#059669)',i:'I'}};
let su=null,aS=[],sm='score',bd=null,bp='all';

/* THEME */
function toggleTheme(){const h=document.documentElement;const d=h.dataset.theme==='dark';h.dataset.theme=d?'light':'dark';document.getElementById('thbtn').textContent=d?'🌙':'☀️';localStorage.setItem('wst',d?'light':'dark');}
(()=>{const t=localStorage.getItem('wst')||'dark';document.documentElement.dataset.theme=t;document.getElementById('thbtn').textContent=t==='dark'?'🌙':'☀️';})();

/* AUTH */
function ca(){const u=localStorage.getItem('wu');if(!u||!localStorage.getItem('wp_'+u))return false;lok(u);return true;}
function pu(n,e){su=n;document.querySelectorAll('.lu').forEach(b=>b.classList.remove('sel'));e.classList.add('sel');const s=localStorage.getItem('wp_'+n);document.getElementById('lpw').classList.add('v');document.getElementById('lbt').style.display='block';document.getElementById('lpi').value='';document.getElementById('lerr').textContent='';document.getElementById('lph').textContent=s?'Willkommen zurueck, '+n+'!':'Erste Anmeldung — lege dein Passwort fest.';document.getElementById('lpi').focus();}
function dl(){if(!su)return;const pw=document.getElementById('lpi').value;if(!pw||pw.length<4){document.getElementById('lerr').textContent='Mind. 4 Zeichen.';return;}const s=localStorage.getItem('wp_'+su);if(!s){localStorage.setItem('wp_'+su,pw);localStorage.setItem('wu',su);lok(su);}else if(s===pw){localStorage.setItem('wu',su);lok(su);}else{document.getElementById('lerr').textContent='Falsches Passwort.';document.getElementById('lpi').value='';document.getElementById('lpi').focus();}}
function lok(n){const el=document.getElementById('ls');el.classList.add('fade');setTimeout(()=>el.classList.add('gone'),300);const u=UA[n]||UA.Marvin;document.getElementById('uav').style.background=u.bg;document.getElementById('uav').textContent=u.i;document.getElementById('uname').textContent=n;ug(n);lh();}
function logout(){localStorage.removeItem('wu');const el=document.getElementById('ls');el.classList.remove('fade','gone');document.querySelectorAll('.lu').forEach(b=>b.classList.remove('sel'));document.getElementById('lpw').classList.remove('v');document.getElementById('lbt').style.display='none';document.getElementById('lerr').textContent='';su=null;}

/* CLOCK */
const DN=['So','Mo','Di','Mi','Do','Fr','Sa'],MN=['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
function ug(n){const h=new Date().getHours();const g=h<12?'Guten Morgen':h<18?'Guten Tag':'Guten Abend';const now=new Date();const t=document.getElementById('htitle'),d=document.getElementById('hdate');if(t)t.innerHTML=g+', <em>'+(n||'Trader')+'</em> 👋';if(d)d.textContent=DN[now.getDay()]+', '+now.getDate()+'. '+MN[now.getMonth()]+' '+now.getFullYear();}
setInterval(()=>{document.getElementById('clk').textContent=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});const u=localStorage.getItem('wu');if(u)ug(u);},1000);

/* UTILS */
const fmt=(n,d=2)=>(!n&&n!==0)?'–':Number(n).toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});
const ago=ts=>{const d=Date.now()-ts;if(d<60000)return'jetzt';if(d<3600000)return Math.floor(d/60000)+'m';if(d<86400000)return Math.floor(d/3600000)+'h';return Math.floor(d/86400000)+'d';};
const sc=s=>s>=70?'var(--green)':s>=50?'var(--amber)':'var(--red)';
function toast(m,d=2500){const t=document.getElementById('toast');t.textContent=m;t.classList.add('on');setTimeout(()=>t.classList.remove('on'),d);}

/* NAV */
const PG=['home','analyse','signals','bt','str','tools','tg'];
function go(n){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.nb').forEach((b,i)=>b.classList.toggle('on',PG[i]===n));
  document.querySelectorAll('.bn').forEach((b,i)=>b.classList.toggle('on',['home','analyse','signals','bt','tools'][i]===n));
  document.getElementById('pg-'+n).classList.add('on');
  if(n==='analyse')ls2();if(n==='signals')lsg();if(n==='bt')lbt();if(n==='home')lh();
}

/* STATS */
async function lst(){const d=await fetch('/stats').then(r=>r.json()).catch(()=>({}));document.getElementById('k-open').textContent=d.open||0;document.getElementById('k-wins').textContent=d.wins||0;document.getElementById('k-losses').textContent=d.losses||0;document.getElementById('k-wr').textContent=(d.winrate||0)+'%';}

/* HOME */
async function lh(){await lst();const h=await fetch('/history').then(r=>r.json()).catch(()=>[]);const el=document.getElementById('home-sigs');if(!h.length){el.innerHTML='<div class="empty"><p>Noch keine Signale empfangen.<br>TradingView muss erst Daten senden.</p></div>';return;}el.innerHTML=h.slice(0,5).map(x=>{const s=Number(x.ai_score)||0;const L=x.ai_direction==='LONG';return\`<div class="rs"><div class="rs-dp \${L?'dp-L':'dp-S'}">\${L?'L':'S'}</div><div class="rs-info"><div class="rs-sym">\${x.symbol||'–'}</div><div class="rs-sub">\${x.trigger||'–'}</div></div><div class="rs-right"><div class="rs-sc" style="color:\${sc(s)}">\${s}/100</div><div class="rs-age">\${ago(x.created_at)}</div></div></div>\`;}).join('');}

/* SNAPSHOTS */
async function ls2(){const el=document.getElementById('snap-list');el.innerHTML='<div class="empty"><p>Lade…</p></div>';const snaps=await fetch('/snapshots').then(r=>r.json()).catch(()=>[]);if(!snaps.length){el.innerHTML='<div class="empty"><p>Noch keine Snapshots.<br>TradingView sendet diese automatisch alle 5 Minuten.</p></div>';return;}el.innerHTML=snaps.map(s=>\`<div><div class="snap"><div style="flex:1;min-width:0"><div class="snap-sym">\${s.symbol}</div><div class="snap-meta">RSI \${fmt(s.rsi,1)} · EMA50 \${fmt(s.ema50,0)} · Trend: \${s.trend||'–'}</div></div><div class="snap-px">\${fmt(s.price)}</div><button class="btn btn-p" onclick="cn('\${s.symbol}',this)" \${SECRET?'':'disabled'} style="font-size:.65rem;padding:6px 12px">\${SECRET?'🔍 Prüfen':'🔒'}</button></div><div class="res" id="res-\${s.symbol}" style="display:none"></div></div>\`).join('');}

/* ANALYSE */
async function cn(sym,btn){btn.disabled=true;btn.textContent='⏳';const el=document.getElementById('res-'+sym);try{const d=await fetch('/ask?symbol='+encodeURIComponent(sym)+'&secret='+encodeURIComponent(SECRET)).then(r=>r.json());if(d.error)throw new Error(d.error);const ai=d.ai||{},s=Number(ai.score)||0,rec=ai.recommendation==='RECOMMENDED';const rr=(ai.entry&&ai.take_profit&&ai.stop_loss)?(Math.abs(ai.take_profit-ai.entry)/Math.abs(ai.entry-ai.stop_loss)).toFixed(2):null;el.style.display='block';el.innerHTML=\`<div class="res-top"><span class="rbadge \${rec?'ry':'rn'}">\${rec?'✓ Empfohlen':'✗ Nicht empfohlen'}</span><span style="font-family:'DM Mono',monospace;font-size:.82rem;font-weight:500;color:\${sc(s)}">\${s}/100</span></div><div class="res-bd"><div class="rr"><span class="rk">Richtung</span><span class="rv">\${ai.direction||'–'}</span></div><div class="rr"><span class="rk">Risiko</span><span class="rv">\${ai.risk||'–'}</span></div><div class="rr"><span class="rk">Confidence</span><span class="rv">\${ai.confidence||0}%</span></div>\${rr?'<div class="rr"><span class="rk">R/R</span><span class="rv">1:'+rr+'</span></div>':''}<div class="bar"><div class="bar-f" style="width:\${s}%;background:\${sc(s)}"></div></div><div class="rplan"><div class="rpc"><div class="rpl">Entry</div><div class="rpv" style="color:var(--blue3)">\${fmt(ai.entry)}</div></div><div class="rpc"><div class="rpl">Take Profit</div><div class="rpv" style="color:var(--green)">\${fmt(ai.take_profit)}</div></div><div class="rpc"><div class="rpl">Stop Loss</div><div class="rpv" style="color:var(--red)">\${fmt(ai.stop_loss)}</div></div></div><div class="rreason">\${ai.reason||''}</div></div>\`;toast(rec?'✅ Empfohlen!':'⛔ Nicht empfohlen');}catch(e){el.style.display='block';el.innerHTML='<div style="padding:12px 15px;color:var(--red);font-size:.72rem">Fehler: '+e.message+'</div>';}btn.disabled=false;btn.textContent='🔍 Prüfen';}

/* SIGNALS */
async function lsg(){const el=document.getElementById('sig-list');el.innerHTML='<div class="empty"><p>Lade…</p></div>';aS=await fetch('/history').then(r=>r.json()).catch(()=>[]);const syms=[...new Set(aS.map(x=>x.symbol).filter(Boolean))];const sel=document.getElementById('fsym');sel.innerHTML='<option value="">Alle Symbole</option>'+syms.map(s=>'<option value="'+s+'">'+s+'</option>').join('');af();}
function srt(m){sm=m;document.getElementById('ss').classList.toggle('on',m==='score');document.getElementById('st').classList.toggle('on',m==='time');af();}
function af(){const sym=document.getElementById('fsym').value;const out=document.getElementById('fout').value;let f=[...aS];if(sym)f=f.filter(x=>x.symbol===sym);if(out)f=f.filter(x=>x.outcome===out);if(sm==='score')f.sort((a,b)=>(b.ai_score||0)-(a.ai_score||0));else f.sort((a,b)=>b.created_at-a.created_at);const el=document.getElementById('sig-list');if(!f.length){el.innerHTML='<div class="empty"><p>Keine Signale für diese Filter.</p></div>';return;}el.innerHTML=f.map(x=>{const s=Number(x.ai_score)||0;const oc=x.outcome==='WIN'?'tw':x.outcome==='LOSS'?'tl':x.outcome==='SKIPPED'?'tsk':'to';const rc=x.ai_recommendation==='RECOMMENDED'?'tr':'tnr';const rk=x.ai_risk==='HIGH'?'thi':x.ai_risk==='MEDIUM'?'tmd':'tlo';const op=x.outcome==='OPEN';const L=x.ai_direction==='LONG';return\`<div class="sc"><div class="sc-top"><div class="sc-left"><div class="sc-sym">\${x.symbol||'–'}</div><span class="sc-dp \${L?'dp-long':'dp-short'}">\${x.ai_direction||'–'}</span></div><div class="sc-right"><div class="sc-score" style="color:\${sc(s)}">\${s}/100</div><div class="sc-age">\${ago(x.created_at)}</div></div></div><div class="sc-px"><span>Entry: \${fmt(x.ai_entry)}</span><span style="color:var(--green)">TP: \${fmt(x.ai_take_profit)}</span><span style="color:var(--red)">SL: \${fmt(x.ai_stop_loss)}</span></div><div class="bar" style="margin-bottom:8px"><div class="bar-f" style="width:\${s}%;background:\${sc(s)}"></div></div><div class="sc-ft"><div class="tags"><span class="tg \${rc}">\${x.ai_recommendation==='RECOMMENDED'?'Empfohlen':'Nicht empf.'}</span><span class="tg \${rk}">\${x.ai_risk||'–'}</span><span class="tg \${oc}" id="out-\${x.id}">\${x.outcome||'–'}</span></div>\${op&&SECRET?\`<div class="obt"><button class="ob obw" onclick="so('\${x.id}','WIN',this)">✓ WIN</button><button class="ob obl" onclick="so('\${x.id}','LOSS',this)">✗ LOSS</button><button class="ob obs" onclick="so('\${x.id}','SKIPPED',this)">— Skip</button></div>\`:''}</div></div>\`;}).join('');}
async function so(id,o,btn){const all=btn.parentElement.querySelectorAll('.ob');all.forEach(b=>b.disabled=true);try{const r=await fetch('/outcome?id='+id+'&outcome='+o+'&secret='+encodeURIComponent(SECRET),{method:'POST'}).then(r=>r.json());if(r.status==='ok'){const b=document.getElementById('out-'+id);if(b){b.className='tg '+(o==='WIN'?'tw':o==='LOSS'?'tl':'tsk');b.textContent=o;}btn.parentElement.style.display='none';lst();toast(o==='WIN'?'🏆 WIN!':o==='LOSS'?'❌ LOSS':'— Skip');}}catch(e){all.forEach(b=>b.disabled=false);toast('Fehler: '+e.message);}}

/* BACKTESTING */
async function lbt(){const el=document.getElementById('bt-body');el.innerHTML='<div class="empty"><p>Lade…</p></div>';bd=await fetch('/backtesting').then(r=>r.json()).catch(()=>null);if(!bd||bd.error){el.innerHTML='<div class="empty"><p>Fehler beim Laden.</p></div>';return;}rbT(bp);}
function btp(p,btn){bp=p;document.querySelectorAll('.bttab').forEach(t=>t.classList.remove('on'));btn.classList.add('on');rbT(p);}
function rbT(p){if(!bd)return;const el=document.getElementById('bt-body');const d=p==='week'?bd.week:p==='month'?bd.month:bd.overall;const cl=(d.wins||0)+(d.losses||0);const wr=cl>0?((d.wins/cl)*100).toFixed(1):0;const o=bd.overall;let h=\`<div class="bt-ks"><div class="btk"><div class="btkv" style="color:var(--green)">\${d.wins||0}</div><div class="btkl">Wins</div></div><div class="btk"><div class="btkv" style="color:var(--red)">\${d.losses||0}</div><div class="btkl">Losses</div></div><div class="btk"><div class="btkv" style="color:var(--blue3)">\${wr}%</div><div class="btkl">Winrate</div></div></div><div class="scmp"><div class="scmp-t">Score-Analyse</div><div class="scmp-s">Zeigt ob höhere Scores wirklich besser performen. Idealerweise sollte der WIN-Score deutlich höher sein als der LOSS-Score.</div><div class="scr"><div class="scrl" style="color:var(--green)">WIN</div><div class="scrb"><div class="scrf" style="width:\${o.avg_score_win||0}%;background:var(--green)"></div></div><div class="scrv" style="color:var(--green)">\${o.avg_score_win||0}</div></div><div class="scr"><div class="scrl" style="color:var(--red)">LOSS</div><div class="scrb"><div class="scrf" style="width:\${o.avg_score_loss||0}%;background:var(--red)"></div></div><div class="scrv" style="color:var(--red)">\${o.avg_score_loss||0}</div></div></div>\`;
if(bd.bySymbol?.length)h+=\`<div class="card" style="margin-bottom:12px"><div class="ch"><div class="ct">Winrate pro Symbol</div></div><div style="padding:0 4px"><table class="stbl"><tr><th>Symbol</th><th>Wins</th><th>Losses</th><th>Winrate</th><th>Ø Score</th></tr>\${bd.bySymbol.map(s=>{const c=(s.wins||0)+(s.losses||0);const w=c>0?((s.wins/c)*100).toFixed(0):0;return\`<tr><td><strong>\${s.symbol}</strong></td><td style="color:var(--green)">\${s.wins||0}</td><td style="color:var(--red)">\${s.losses||0}</td><td style="font-family:'DM Mono',monospace;font-weight:500;color:var(--blue3)">\${w}%</td><td style="font-family:'DM Mono',monospace">\${Number(s.avg_score||0).toFixed(0)}</td></tr>\`;}).join('')}</table></div></div>\`;
if(bd.best?.length)h+=\`<div class="card" style="margin-bottom:12px"><div class="ch"><div class="ct">🏆 Beste Signale (WIN)</div></div><div class="cb">\${bd.best.map(x=>\`<div class="bsr"><div><div class="bsr-sym">\${x.symbol} <span style="color:var(--green);font-size:.62rem">\${x.ai_direction}</span></div><div class="bsr-sub">E: \${fmt(x.ai_entry)} → TP: \${fmt(x.ai_take_profit)}</div></div><div class="bsr-sc" style="color:var(--green)">\${x.ai_score}/100</div></div>\`).join('')}</div></div>\`;
if(bd.worst?.length)h+=\`<div class="card"><div class="ch"><div class="ct">📉 Schlechteste Signale (LOSS)</div></div><div class="cb">\${bd.worst.map(x=>\`<div class="bsr"><div><div class="bsr-sym">\${x.symbol} <span style="color:var(--red);font-size:.62rem">\${x.ai_direction}</span></div><div class="bsr-sub">E: \${fmt(x.ai_entry)} · SL: \${fmt(x.ai_stop_loss)}</div></div><div class="bsr-sc" style="color:var(--red)">\${x.ai_score}/100</div></div>\`).join('')}</div></div>\`;
el.innerHTML=h;}

/* TOOLS */
async function ta(a){if(!SECRET&&a!=='health'){toast('⚠️ Secret in URL benoetigt');return;}toast('Wird ausgefuehrt…');try{if(a==='health'){const d=await fetch('/health').then(r=>r.json());toast('✅ Worker OK · '+new Date(d.time).toLocaleTimeString('de-DE'),3000);}else if(a==='telegram'){await fetch('/test-telegram?secret='+encodeURIComponent(SECRET));toast('📨 Telegram gesendet!');}else if(a==='morning'){await fetch('/morning-brief?secret='+encodeURIComponent(SECRET));toast('🌅 Morning Brief gesendet!');}else if(a==='outcomes'){const d=await fetch('/check-outcomes?secret='+encodeURIComponent(SECRET)).then(r=>r.json());toast('🔄 '+(d.result?.closed||0)+' Trades aktualisiert',3000);}}catch(e){toast('❌ Fehler: '+e.message);}}
function cp(c){navigator.clipboard.writeText(c).then(()=>toast('📋 Kopiert: '+c));}

if(!ca()){}
</script>
</body>
</html>`;
}
