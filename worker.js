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
      if (!id || !["WIN","LOSS","OPEN"].includes(outcome)) {
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
        model: "claude-haiku-4-5-20251001",  // Schnell & günstig für Signal-Analyse
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Claude API Fehler:", data);
      return fallback(signal, data.error?.message || "Claude API Fehler");
    }

    const raw = data.content?.[0]?.text || "";

    // JSON aus der Antwort extrahieren
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallback(signal, "Claude JSON konnte nicht gelesen werden.");

    return JSON.parse(match[0]);

  } catch (err) {
    console.error("Claude Fetch Fehler:", err);
    return fallback(signal, err.message || "Unbekannter Fehler");
  }
}

function fallback(signal, reason) {
  const price = Number(signal.price) || 0;
  return {
    recommendation: "NOT_RECOMMENDED",
    direction: "NONE",
    score: 0,
    risk: "HIGH",
    confidence: 0,
    reason: `Fehler: ${reason}`,
    entry: price,
    take_profit: 0,
    stop_loss: 0
  };
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
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>WAVESCOUT</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0d0d0f;
      --surface: #141416;
      --surface2: #1a1a1e;
      --surface3: #202026;
      --border: #2a2a32;
      --border2: #34343e;
      --pink: #e91e8c;
      --pink2: #ff4db8;
      --pink-dim: rgba(233,30,140,0.12);
      --pink-glow: rgba(233,30,140,0.25);
      --blue: #4f8ef7;
      --green: #22c55e;
      --red: #ef4444;
      --yellow: #f59e0b;
      --purple: #a855f7;
      --text: #e8e8f0;
      --text2: #9090a8;
      --text3: #60607a;
      --font: 'Inter', sans-serif;
      --mono: 'JetBrains Mono', monospace;
      --radius: 12px;
      --sidebar: 200px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    html { scroll-behavior: smooth; height: 100%; }
    body { font-family: var(--font); background: var(--bg); color: var(--text); min-height: 100vh; display: flex; }

    /* ── Sidebar ── */
    .sidebar {
      width: var(--sidebar); flex-shrink: 0;
      background: var(--surface);
      border-right: 1px solid var(--border);
      display: flex; flex-direction: column;
      position: fixed; top: 0; left: 0; bottom: 0; z-index: 50;
    }
    .sidebar-logo {
      padding: 20px 16px 16px;
      border-bottom: 1px solid var(--border);
    }
    .sidebar-logo-text {
      font-size: 1.1rem; font-weight: 700; letter-spacing: 0.02em;
      background: linear-gradient(135deg, var(--pink), var(--pink2));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .sidebar-logo-sub { font-size: 0.62rem; color: var(--text3); margin-top: 2px; }
    .sidebar-nav { padding: 12px 8px; flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .nav-item {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 10px; border-radius: 8px; cursor: pointer;
      font-size: 0.82rem; font-weight: 500; color: var(--text2);
      transition: background 0.1s, color 0.1s; text-decoration: none;
      border: none; background: none; width: 100%; text-align: left;
    }
    .nav-item:hover { background: var(--surface2); color: var(--text); }
    .nav-item.active { background: var(--pink-dim); color: var(--pink2); }
    .nav-item .nav-icon { font-size: 1rem; width: 20px; text-align: center; flex-shrink: 0; }
    .sidebar-bottom {
      padding: 12px 8px;
      border-top: 1px solid var(--border);
    }
    .sidebar-user {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-radius: 8px;
    }
    .sidebar-avatar {
      width: 28px; height: 28px; border-radius: 50%;
      background: var(--pink-dim); border: 1px solid var(--pink-glow);
      display: flex; align-items: center; justify-content: center;
      font-size: 0.75rem; font-weight: 700; color: var(--pink2);
      flex-shrink: 0;
    }
    .sidebar-username { font-size: 0.75rem; font-weight: 600; color: var(--text2); }
    .sidebar-status { font-size: 0.6rem; color: var(--green); display: flex; align-items: center; gap: 4px; }
    .status-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--green); animation: blink 2s infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }

    /* ── Main ── */
    .main {
      margin-left: var(--sidebar);
      flex: 1; min-width: 0;
      display: flex; flex-direction: column;
    }

    /* ── Topbar ── */
    .topbar {
      position: sticky; top: 0; z-index: 40;
      background: rgba(13,13,15,0.9); backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 0 24px; height: 56px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .topbar-title { font-size: 1rem; font-weight: 600; color: var(--text); }
    .topbar-right { display: flex; align-items: center; gap: 12px; }
    .topbar-time { font-family: var(--mono); font-size: 0.72rem; color: var(--text3); }
    .topbar-live {
      display: flex; align-items: center; gap: 6px;
      font-size: 0.68rem; color: var(--green); font-weight: 600;
    }

    /* ── Pages ── */
    .page { display: none; padding: 24px; }
    .page.active { display: block; }

    /* ── Home page ── */
    .greeting { margin-bottom: 24px; }
    .greeting-day { font-size: 0.78rem; color: var(--text3); margin-bottom: 4px; }
    .greeting-title { font-size: 1.5rem; font-weight: 700; }
    .greeting-title span { color: var(--pink2); }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px; margin-bottom: 20px;
    }
    .kpi-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 16px;
      position: relative; overflow: hidden;
    }
    .kpi-card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
    }
    .kpi-card.pink::before { background: linear-gradient(90deg, var(--pink), var(--pink2)); }
    .kpi-card.green::before { background: var(--green); }
    .kpi-card.red::before { background: var(--red); }
    .kpi-card.blue::before { background: var(--blue); }
    .kpi-label { font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text3); margin-bottom: 8px; }
    .kpi-value { font-size: 1.8rem; font-weight: 700; line-height: 1; font-family: var(--mono); }
    .kpi-value.pink { color: var(--pink2); }
    .kpi-value.green { color: var(--green); }
    .kpi-value.red { color: var(--red); }
    .kpi-value.blue { color: var(--blue); }
    .kpi-sub { font-size: 0.65rem; color: var(--text3); margin-top: 4px; }

    .home-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }

    .section-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); overflow: hidden;
    }
    .section-card-header {
      padding: 14px 16px; border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
    }
    .section-card-title { font-size: 0.82rem; font-weight: 600; }
    .section-card-body { padding: 14px 16px; }

    /* ── Quick Actions ── */
    .quick-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .quick-btn {
      background: var(--surface2); border: 1px solid var(--border);
      border-radius: 10px; padding: 12px; cursor: pointer;
      display: flex; align-items: center; gap: 10px;
      transition: border-color 0.15s, background 0.15s;
      font-family: var(--font);
    }
    .quick-btn:active { background: var(--surface3); }
    .quick-btn:hover { border-color: var(--border2); }
    .quick-btn-icon { font-size: 1.2rem; flex-shrink: 0; }
    .quick-btn-label { font-size: 0.78rem; font-weight: 600; color: var(--text); }
    .quick-btn-desc { font-size: 0.62rem; color: var(--text3); margin-top: 1px; }

    /* ── Recent signals on home ── */
    .mini-signal {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 0; border-bottom: 1px solid var(--border);
    }
    .mini-signal:last-child { border-bottom: none; padding-bottom: 0; }
    .mini-signal-left { display: flex; align-items: center; gap: 10px; }
    .mini-signal-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .mini-signal-symbol { font-size: 0.82rem; font-weight: 700; }
    .mini-signal-trigger { font-size: 0.65rem; color: var(--text3); font-family: var(--mono); }
    .mini-signal-right { text-align: right; }
    .mini-signal-score { font-family: var(--mono); font-size: 0.78rem; font-weight: 700; }
    .mini-signal-time { font-size: 0.62rem; color: var(--text3); }

    /* ── Analyse page ── */
    .snapshot-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 14px 16px;
      display: flex; align-items: center; gap: 12px;
      margin-bottom: 8px;
    }
    .snapshot-info { flex: 1; min-width: 0; }
    .snapshot-symbol { font-size: 0.95rem; font-weight: 700; }
    .snapshot-meta { font-family: var(--mono); font-size: 0.62rem; color: var(--text3); margin-top: 3px; }
    .snapshot-price { font-family: var(--mono); font-size: 0.88rem; font-weight: 700; color: var(--blue); white-space: nowrap; }

    /* ── Signals page ── */
    .filter-bar {
      display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; align-items: center;
    }
    .filter-select {
      background: var(--surface2); border: 1px solid var(--border);
      color: var(--text); font-family: var(--font); font-size: 0.75rem;
      padding: 7px 10px; border-radius: 8px; cursor: pointer; flex: 1; min-width: 100px;
    }
    .filter-select:focus { outline: none; border-color: var(--pink); }
    .sort-btn {
      background: var(--surface2); border: 1px solid var(--border);
      color: var(--text2); font-family: var(--font); font-size: 0.72rem;
      padding: 7px 12px; border-radius: 8px; cursor: pointer; white-space: nowrap;
      transition: border-color 0.15s, color 0.15s;
    }
    .sort-btn.active { border-color: var(--pink); color: var(--pink2); }

    .signal-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); padding: 14px 16px; margin-bottom: 8px;
      transition: border-color 0.15s;
    }
    .signal-card:hover { border-color: var(--border2); }
    .signal-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .signal-symbol { font-weight: 700; font-size: 0.92rem; }
    .signal-time { font-family: var(--mono); font-size: 0.6rem; color: var(--text3); }
    .signal-mid { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .signal-trigger { font-family: var(--mono); font-size: 0.65rem; color: var(--text3); }
    .signal-score { font-family: var(--mono); font-size: 0.8rem; font-weight: 700; }
    .signal-prices { font-family: var(--mono); font-size: 0.65rem; color: var(--text3); display: flex; gap: 12px; margin-bottom: 8px; }
    .signal-bar-bg { height: 3px; background: var(--surface3); border-radius: 2px; margin-bottom: 10px; overflow: hidden; }
    .signal-bar-fill { height: 100%; border-radius: 2px; }
    .signal-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }

    /* ── Result card ── */
    .result-wrap { margin-top: 8px; margin-bottom: 8px; }
    .result-card {
      background: var(--surface2); border: 1px solid var(--border2);
      border-radius: var(--radius); overflow: hidden;
      animation: slideIn 0.2s ease;
    }
    @keyframes slideIn { from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:none} }
    .result-header {
      padding: 12px 16px; display: flex; align-items: center;
      justify-content: space-between; border-bottom: 1px solid var(--border);
    }
    .result-badge { font-size: 0.72rem; font-weight: 700; padding: 4px 10px; border-radius: 6px; }
    .result-badge.rec { background: rgba(34,197,94,0.15); color: var(--green); }
    .result-badge.norec { background: rgba(239,68,68,0.15); color: var(--red); }
    .result-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
    .result-row { display: flex; justify-content: space-between; }
    .result-key { font-size: 0.65rem; color: var(--text3); text-transform: uppercase; letter-spacing: 0.08em; }
    .result-val { font-family: var(--mono); font-size: 0.78rem; }
    .result-plan { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    .plan-cell { background: var(--surface3); border-radius: 8px; padding: 10px; text-align: center; }
    .plan-lbl { font-size: 0.58rem; color: var(--text3); text-transform: uppercase; letter-spacing: 0.06em; }
    .plan-val { font-family: var(--mono); font-size: 0.8rem; font-weight: 700; margin-top: 4px; }
    .result-reason { font-size: 0.75rem; color: var(--text2); line-height: 1.6; padding-top: 10px; border-top: 1px solid var(--border); }

    /* ── Tools page ── */
    .waveboard-card {
      background: linear-gradient(135deg, rgba(233,30,140,0.15), rgba(79,142,247,0.1));
      border: 1px solid rgba(233,30,140,0.3); border-radius: var(--radius);
      padding: 18px; display: flex; align-items: center; gap: 14px;
      text-decoration: none; color: inherit; margin-bottom: 16px;
      transition: border-color 0.15s, transform 0.1s;
    }
    .waveboard-card:hover { border-color: var(--pink); transform: translateY(-1px); }
    .waveboard-card:active { transform: scale(0.99); }
    .wb-icon { font-size: 2.2rem; flex-shrink: 0; }
    .wb-title { font-size: 1rem; font-weight: 700; }
    .wb-sub { font-size: 0.68rem; color: var(--text3); margin-top: 2px; }
    .wb-arrow { margin-left: auto; background: rgba(233,30,140,0.15); color: var(--pink2); font-size: 0.65rem; font-weight: 700; padding: 5px 10px; border-radius: 6px; flex-shrink: 0; }

    .tool-section { margin-bottom: 16px; }
    .tool-section-title { font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text3); margin-bottom: 8px; padding: 0 4px; }
    .tool-list { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
    .tool-row {
      display: flex; align-items: center; padding: 13px 16px;
      border-bottom: 1px solid var(--border); cursor: pointer;
      transition: background 0.1s; text-decoration: none; color: inherit;
    }
    .tool-row:last-child { border-bottom: none; }
    .tool-row:hover { background: var(--surface2); }
    .tool-row:active { background: var(--surface3); }
    .tool-row-icon { font-size: 1.1rem; width: 28px; flex-shrink: 0; }
    .tool-row-text { flex: 1; }
    .tool-row-label { font-size: 0.82rem; font-weight: 600; }
    .tool-row-desc { font-size: 0.65rem; color: var(--text3); margin-top: 2px; }
    .tool-row-arrow { color: var(--text3); font-size: 0.8rem; }

    /* ── Telegram page ── */
    .cmd-grid { display: flex; flex-direction: column; gap: 6px; }
    .cmd-row {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 12px 14px;
      display: flex; align-items: center; justify-content: space-between;
      cursor: pointer; transition: background 0.1s;
    }
    .cmd-row:hover { background: var(--surface2); }
    .cmd-code { font-family: var(--mono); font-size: 0.8rem; color: var(--pink2); font-weight: 700; }
    .cmd-desc { font-size: 0.65rem; color: var(--text3); margin-top: 2px; }
    .cmd-copy-icon { color: var(--text3); font-size: 0.75rem; }

    /* ── Badges ── */
    .badges { display: flex; gap: 5px; flex-wrap: wrap; }
    .badge { font-size: 0.62rem; font-weight: 600; padding: 3px 8px; border-radius: 5px; }
    .b-win  { background: rgba(34,197,94,0.12);  color: var(--green);  border: 1px solid rgba(34,197,94,0.2); }
    .b-open { background: rgba(79,142,247,0.12); color: var(--blue);   border: 1px solid rgba(79,142,247,0.2); }
    .b-loss { background: rgba(239,68,68,0.12);  color: var(--red);    border: 1px solid rgba(239,68,68,0.2); }
    .b-rec  { background: rgba(34,197,94,0.1);   color: var(--green); }
    .b-norec{ background: rgba(239,68,68,0.1);   color: var(--red); }
    .b-low  { background: rgba(34,197,94,0.1);   color: var(--green); }
    .b-med  { background: rgba(245,158,11,0.1);  color: var(--yellow); }
    .b-high { background: rgba(239,68,68,0.1);   color: var(--red); }

    /* ── Buttons ── */
    .btn {
      font-family: var(--font); font-weight: 600; font-size: 0.75rem;
      border: none; border-radius: 8px; padding: 8px 14px;
      cursor: pointer; transition: opacity 0.15s, transform 0.1s;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .btn:active { transform: scale(0.96); }
    .btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; }
    .btn-primary { background: linear-gradient(135deg, var(--pink), var(--pink2)); color: #fff; }
    .btn-ghost { background: var(--surface2); border: 1px solid var(--border); color: var(--text2); font-size: 0.7rem; padding: 6px 12px; }
    .btn-ghost:hover { border-color: var(--border2); color: var(--text); }
    .btn-win  { background: rgba(34,197,94,0.12);  color: var(--green); border: 1px solid rgba(34,197,94,0.25);  font-size: 0.68rem; padding: 5px 10px; }
    .btn-loss { background: rgba(239,68,68,0.12);   color: var(--red);   border: 1px solid rgba(239,68,68,0.25);   font-size: 0.68rem; padding: 5px 10px; }

    /* ── Empty ── */
    .empty { text-align: center; padding: 32px; color: var(--text3); font-size: 0.82rem; line-height: 1.7; }

    /* ── Toast ── */
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: var(--surface2); border: 1px solid var(--border2);
      color: var(--text); font-size: 0.78rem; padding: 10px 20px;
      border-radius: 20px; z-index: 999; pointer-events: none;
      opacity: 0; transition: opacity 0.2s; white-space: nowrap; max-width: 90vw;
    }
    .toast.show { opacity: 1; }

    /* ── Mobile ── */
    @media (max-width: 600px) {
      :root { --sidebar: 0px; }
      .sidebar { display: none; }
      .main { margin-left: 0; }
      .page { padding: 16px; }
      .bottom-nav {
        display: flex !important;
        position: fixed; bottom: 0; left: 0; right: 0; z-index: 50;
        background: var(--surface); border-top: 1px solid var(--border);
        padding: 8px 0 max(8px, env(safe-area-inset-bottom));
      }
      body { padding-bottom: 70px; }
      .kpi-grid { grid-template-columns: repeat(2,1fr); }
      .topbar { padding: 0 16px; }
      .topbar-time { display: none; }
    }
    .bottom-nav { display: none; }
    .bottom-nav-item {
      flex: 1; display: flex; flex-direction: column; align-items: center;
      gap: 3px; cursor: pointer; padding: 4px 0;
      font-size: 0.58rem; font-weight: 600; color: var(--text3);
      transition: color 0.15s; border: none; background: none;
    }
    .bottom-nav-item.active { color: var(--pink2); }
    .bottom-nav-item .bn-icon { font-size: 1.2rem; }
  </style>
</head>
<body>

<!-- Sidebar (Desktop) -->
<div class="sidebar">
  <div class="sidebar-logo">
    <div class="sidebar-logo-text">WaveScout</div>
    <div class="sidebar-logo-sub">Trading Signal Bot</div>
  </div>
  <nav class="sidebar-nav">
    <button class="nav-item active" onclick="goTo('home')">
      <span class="nav-icon">🏠</span> Dashboard
    </button>
    <button class="nav-item" onclick="goTo('analyse')">
      <span class="nav-icon">🔍</span> Analyse
    </button>
    <button class="nav-item" onclick="goTo('signals')">
      <span class="nav-icon">📋</span> Signale
    </button>
    <button class="nav-item" onclick="goTo('tools')">
      <span class="nav-icon">🔧</span> Tools
    </button>
    <button class="nav-item" onclick="goTo('telegram')">
      <span class="nav-icon">💬</span> Telegram
    </button>
  </nav>
  <div class="sidebar-bottom">
    <div class="sidebar-user">
      <div class="sidebar-avatar">M</div>
      <div>
        <div class="sidebar-username">Marvin</div>
        <div class="sidebar-status"><div class="status-dot"></div>Live</div>
      </div>
    </div>
  </div>
</div>

<!-- Main Content -->
<div class="main">

  <!-- Topbar -->
  <div class="topbar">
    <div class="topbar-title" id="topbar-title">Dashboard</div>
    <div class="topbar-right">
      <div class="topbar-time" id="clock">–</div>
      <div class="topbar-live"><div class="status-dot"></div>Live</div>
    </div>
  </div>

  <!-- Page: Home -->
  <div class="page active" id="page-home">
    <div class="greeting">
      <div class="greeting-day" id="greeting-day">–</div>
      <div class="greeting-title">Guten Morgen, <span>Marvin</span> 👋</div>
    </div>

    <div class="kpi-grid" id="kpi-grid">
      <div class="kpi-card pink">
        <div class="kpi-label">Offene Signale</div>
        <div class="kpi-value pink" id="kpi-open">–</div>
        <div class="kpi-sub">aktive Trades</div>
      </div>
      <div class="kpi-card green">
        <div class="kpi-label">Wins</div>
        <div class="kpi-value green" id="kpi-wins">–</div>
        <div class="kpi-sub">gesamt</div>
      </div>
      <div class="kpi-card red">
        <div class="kpi-label">Losses</div>
        <div class="kpi-value red" id="kpi-losses">–</div>
        <div class="kpi-sub">gesamt</div>
      </div>
      <div class="kpi-card blue">
        <div class="kpi-label">Winrate</div>
        <div class="kpi-value blue" id="kpi-winrate">–</div>
        <div class="kpi-sub">Trefferquote</div>
      </div>
    </div>

    <div class="home-grid">
      <!-- Quick Actions -->
      <div class="section-card">
        <div class="section-card-header">
          <div class="section-card-title">Schnell-Aktionen</div>
        </div>
        <div class="section-card-body">
          <div class="quick-actions">
            <div class="quick-btn" onclick="goTo('analyse')">
              <div class="quick-btn-icon">🔍</div>
              <div>
                <div class="quick-btn-label">Analyse</div>
                <div class="quick-btn-desc">Symbol prüfen</div>
              </div>
            </div>
            <div class="quick-btn" onclick="toolAction('morning')">
              <div class="quick-btn-icon">🌅</div>
              <div>
                <div class="quick-btn-label">Morning Brief</div>
                <div class="quick-btn-desc">Jetzt senden</div>
              </div>
            </div>
            <div class="quick-btn" onclick="toolAction('outcomes')">
              <div class="quick-btn-icon">🔄</div>
              <div>
                <div class="quick-btn-label">Outcomes</div>
                <div class="quick-btn-desc">WIN/LOSS prüfen</div>
              </div>
            </div>
            <div class="quick-btn" onclick="goTo('signals')">
              <div class="quick-btn-icon">📋</div>
              <div>
                <div class="quick-btn-label">Signale</div>
                <div class="quick-btn-desc">Alle ansehen</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Recent Signals -->
      <div class="section-card">
        <div class="section-card-header">
          <div class="section-card-title">Letzte Signale</div>
          <button class="btn btn-ghost" onclick="goTo('signals')">Alle →</button>
        </div>
        <div class="section-card-body" id="home-signals">
          <div class="empty">Lade...</div>
        </div>
      </div>

      <!-- Waveboard -->
      <a class="waveboard-card" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank">
        <div class="wb-icon">🌊</div>
        <div>
          <div class="wb-title">WaveBoard</div>
          <div class="wb-sub">Externes Trading Dashboard öffnen</div>
        </div>
        <div class="wb-arrow">↗ Öffnen</div>
      </a>
    </div>
  </div>

  <!-- Page: Analyse -->
  <div class="page" id="page-analyse">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="font-size:0.65rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em">Aktuelle Snapshots</div>
      <button class="btn btn-ghost" onclick="loadSnapshots()">↻ Refresh</button>
    </div>
    <div id="snapshots-list"><div class="empty">Lade Snapshots...</div></div>
  </div>

  <!-- Page: Signale -->
  <div class="page" id="page-signals">
    <div class="filter-bar">
      <select class="filter-select" id="filter-symbol" onchange="applyFilters()">
        <option value="">Alle Symbole</option>
      </select>
      <select class="filter-select" id="filter-outcome" onchange="applyFilters()" style="flex:0.7">
        <option value="">Alle</option>
        <option value="OPEN">Open</option>
        <option value="WIN">Win</option>
        <option value="LOSS">Loss</option>
      </select>
      <button class="sort-btn active" id="sort-score" onclick="toggleSort('score')">Score ↓</button>
      <button class="sort-btn" id="sort-time" onclick="toggleSort('time')">Zeit</button>
    </div>
    <div id="signals-list"><div class="empty">Lade Signale...</div></div>
  </div>

  <!-- Page: Tools -->
  <div class="page" id="page-tools">
    <a class="waveboard-card" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank">
      <div class="wb-icon">🌊</div>
      <div>
        <div class="wb-title">WaveBoard Dashboard</div>
        <div class="wb-sub">waveboard-e54ed.web.app</div>
      </div>
      <div class="wb-arrow">↗ Öffnen</div>
    </a>

    <div class="tool-section">
      <div class="tool-section-title">System</div>
      <div class="tool-list">
        <div class="tool-row" onclick="toolAction('health')">
          <div class="tool-row-icon">💚</div>
          <div class="tool-row-text">
            <div class="tool-row-label">Health Check</div>
            <div class="tool-row-desc">Worker Status prüfen</div>
          </div>
          <div class="tool-row-arrow">›</div>
        </div>
        <div class="tool-row" onclick="toolAction('telegram')">
          <div class="tool-row-icon">📨</div>
          <div class="tool-row-text">
            <div class="tool-row-label">Telegram testen</div>
            <div class="tool-row-desc">Test-Nachricht senden</div>
          </div>
          <div class="tool-row-arrow">›</div>
        </div>
        <div class="tool-row" onclick="toolAction('morning')">
          <div class="tool-row-icon">🌅</div>
          <div class="tool-row-text">
            <div class="tool-row-label">Morning Brief</div>
            <div class="tool-row-desc">Tages-Bias jetzt abrufen</div>
          </div>
          <div class="tool-row-arrow">›</div>
        </div>
        <div class="tool-row" onclick="toolAction('outcomes')">
          <div class="tool-row-icon">🔄</div>
          <div class="tool-row-text">
            <div class="tool-row-label">Outcome Tracking</div>
            <div class="tool-row-desc">WIN/LOSS via Binance prüfen</div>
          </div>
          <div class="tool-row-arrow">›</div>
        </div>
      </div>
    </div>

    <div class="tool-section">
      <div class="tool-section-title">Links</div>
      <div class="tool-list">
        <a class="tool-row" href="https://tradingview.com" target="_blank">
          <div class="tool-row-icon">📊</div>
          <div class="tool-row-text">
            <div class="tool-row-label">TradingView</div>
            <div class="tool-row-desc">Charts & Alerts verwalten</div>
          </div>
          <div class="tool-row-arrow">↗</div>
        </a>
        <a class="tool-row" href="https://dash.cloudflare.com" target="_blank">
          <div class="tool-row-icon">☁️</div>
          <div class="tool-row-text">
            <div class="tool-row-label">Cloudflare</div>
            <div class="tool-row-desc">Worker & Logs verwalten</div>
          </div>
          <div class="tool-row-arrow">↗</div>
        </a>
        <a class="tool-row" href="https://github.com/spnni08/tradingview-bot" target="_blank">
          <div class="tool-row-icon">🐙</div>
          <div class="tool-row-text">
            <div class="tool-row-label">GitHub Repository</div>
            <div class="tool-row-desc">spnni08/tradingview-bot</div>
          </div>
          <div class="tool-row-arrow">↗</div>
        </a>
        <a class="tool-row" href="https://console.anthropic.com" target="_blank">
          <div class="tool-row-icon">🤖</div>
          <div class="tool-row-text">
            <div class="tool-row-label">Anthropic Console</div>
            <div class="tool-row-desc">Claude API Keys & Usage</div>
          </div>
          <div class="tool-row-arrow">↗</div>
        </a>
      </div>
    </div>
  </div>

  <!-- Page: Telegram -->
  <div class="page" id="page-telegram">
    <div style="margin-bottom:16px">
      <div style="font-size:0.65rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px">Kommandos — tippe zum Kopieren</div>
      <div class="cmd-grid">
        <div class="cmd-row" onclick="copyCmd('/btc')">
          <div><div class="cmd-code">/btc</div><div class="cmd-desc">Bitcoin analysieren</div></div>
          <div class="cmd-copy-icon">📋</div>
        </div>
        <div class="cmd-row" onclick="copyCmd('/eth')">
          <div><div class="cmd-code">/eth</div><div class="cmd-desc">Ethereum analysieren</div></div>
          <div class="cmd-copy-icon">📋</div>
        </div>
        <div class="cmd-row" onclick="copyCmd('/sol')">
          <div><div class="cmd-code">/sol</div><div class="cmd-desc">Solana analysieren</div></div>
          <div class="cmd-copy-icon">📋</div>
        </div>
        <div class="cmd-row" onclick="copyCmd('/check RENDERUSDT')">
          <div><div class="cmd-code">/check SYMBOL</div><div class="cmd-desc">Beliebiges Symbol analysieren</div></div>
          <div class="cmd-copy-icon">📋</div>
        </div>
        <div class="cmd-row" onclick="copyCmd('/status')">
          <div><div class="cmd-code">/status</div><div class="cmd-desc">Winrate & Stats</div></div>
          <div class="cmd-copy-icon">📋</div>
        </div>
        <div class="cmd-row" onclick="copyCmd('/brief')">
          <div><div class="cmd-code">/brief</div><div class="cmd-desc">Morning Brief senden</div></div>
          <div class="cmd-copy-icon">📋</div>
        </div>
        <div class="cmd-row" onclick="copyCmd('/open')">
          <div><div class="cmd-code">/open</div><div class="cmd-desc">Offene Trades anzeigen</div></div>
          <div class="cmd-copy-icon">📋</div>
        </div>
        <div class="cmd-row" onclick="copyCmd('/top')">
          <div><div class="cmd-code">/top</div><div class="cmd-desc">Beste Signale heute</div></div>
          <div class="cmd-copy-icon">📋</div>
        </div>
        <div class="cmd-row" onclick="copyCmd('/hilfe')">
          <div><div class="cmd-code">/hilfe</div><div class="cmd-desc">Alle Kommandos</div></div>
          <div class="cmd-copy-icon">📋</div>
        </div>
      </div>
    </div>
  </div>

</div><!-- /main -->

<!-- Bottom Nav (Mobile) -->
<div class="bottom-nav" id="bottom-nav">
  <button class="bottom-nav-item active" onclick="goTo('home')"><span class="bn-icon">🏠</span>Home</button>
  <button class="bottom-nav-item" onclick="goTo('analyse')"><span class="bn-icon">🔍</span>Analyse</button>
  <button class="bottom-nav-item" onclick="goTo('signals')"><span class="bn-icon">📋</span>Signale</button>
  <button class="bottom-nav-item" onclick="goTo('tools')"><span class="bn-icon">🔧</span>Tools</button>
  <button class="bottom-nav-item" onclick="goTo('telegram')"><span class="bn-icon">💬</span>Telegram</button>
</div>

<div class="toast" id="toast"></div>

<script>
const SECRET = new URLSearchParams(location.search).get('secret') || '';
let allSignals = [];
let sortMode = 'score';

// ── Utils ──
function fmt(n,d=2) {
  if (!n && n!==0) return '–';
  return Number(n).toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});
}
function timeAgo(ts) {
  const d = Date.now()-ts;
  if(d<60000) return 'jetzt';
  if(d<3600000) return Math.floor(d/60000)+'m';
  if(d<86400000) return Math.floor(d/3600000)+'h';
  return Math.floor(d/86400000)+'d';
}
function scoreColor(s) {
  if(s>=70) return 'var(--green)';
  if(s>=50) return 'var(--yellow)';
  return 'var(--red)';
}
function showToast(msg,dur=2500) {
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),dur);
}
function greeting() {
  const h=new Date().getHours();
  if(h<12) return 'Guten Morgen,';
  if(h<18) return 'Guten Tag,';
  return 'Guten Abend,';
}

// ── Clock & Greeting ──
function updateClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const days=['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const months=['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const now=new Date();
  document.getElementById('greeting-day').textContent =
    days[now.getDay()]+', '+now.getDate()+'. '+months[now.getMonth()]+' '+now.getFullYear();
  const greetEl = document.querySelector('.greeting-title');
  if(greetEl) greetEl.innerHTML = greeting()+' <span>Marvin</span> 👋';
}
updateClock();
setInterval(updateClock,1000);

// ── Navigation ──
const pageNames = {home:'Dashboard',analyse:'Analyse',signals:'Signale',tools:'Tools',telegram:'Telegram'};
function goTo(name) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.querySelectorAll('.bottom-nav-item').forEach((b,i)=>{
    const pages=['home','analyse','signals','tools','telegram'];
    b.classList.toggle('active',pages[i]===name);
  });
  document.getElementById('page-'+name).classList.add('active');
  document.getElementById('topbar-title').textContent = pageNames[name]||name;
  const idx=['home','analyse','signals','tools','telegram'].indexOf(name);
  if(idx>=0) document.querySelectorAll('.nav-item')[idx]?.classList.add('active');
  if(name==='analyse') loadSnapshots();
  if(name==='signals') loadHistory();
  if(name==='home') loadHome();
}

// ── Stats ──
async function loadStats() {
  const s=await fetch('/stats').then(r=>r.json()).catch(()=>({}));
  document.getElementById('kpi-open').textContent=s.open||0;
  document.getElementById('kpi-wins').textContent=s.wins||0;
  document.getElementById('kpi-losses').textContent=s.losses||0;
  document.getElementById('kpi-winrate').textContent=(s.winrate||0)+'%';
  return s;
}

// ── Home ──
async function loadHome() {
  await loadStats();
  const hist=await fetch('/history').then(r=>r.json()).catch(()=>[]);
  const recent=hist.slice(0,5);
  const el=document.getElementById('home-signals');
  if(!recent.length){el.innerHTML='<div class="empty">Noch keine Signale.</div>';return;}
  el.innerHTML=recent.map(x=>{
    const sc=Number(x.ai_score)||0;
    const col=scoreColor(sc);
    const isLong=x.ai_direction==='LONG';
    return \`<div class="mini-signal">
      <div class="mini-signal-left">
        <div class="mini-signal-dot" style="background:\${isLong?'var(--green)':'var(--red)'}"></div>
        <div>
          <div class="mini-signal-symbol">\${x.symbol||'–'}</div>
          <div class="mini-signal-trigger">\${x.trigger||'–'}</div>
        </div>
      </div>
      <div class="mini-signal-right">
        <div class="mini-signal-score" style="color:\${col}">\${sc}/100</div>
        <div class="mini-signal-time">\${timeAgo(x.created_at)}</div>
      </div>
    </div>\`;
  }).join('');
}

// ── Snapshots ──
async function loadSnapshots() {
  const el=document.getElementById('snapshots-list');
  el.innerHTML='<div class="empty">Lade...</div>';
  const snaps=await fetch('/snapshots').then(r=>r.json()).catch(()=>[]);
  if(!snaps.length){el.innerHTML='<div class="empty">Noch keine Snapshots.<br>TradingView muss erst Daten senden.</div>';return;}
  el.innerHTML=snaps.map(s=>\`
    <div>
      <div class="snapshot-card">
        <div class="snapshot-info">
          <div class="snapshot-symbol">\${s.symbol}</div>
          <div class="snapshot-meta">RSI \${fmt(s.rsi,1)} · EMA50 \${fmt(s.ema50,0)} · \${s.trend||'–'}</div>
        </div>
        <div class="snapshot-price">\${fmt(s.price)}</div>
        <button class="btn btn-primary" onclick="checkNow('\${s.symbol}',this)" \${SECRET?'':'disabled'} style="font-size:0.68rem;padding:7px 12px">
          \${SECRET?'Prüfen':'🔒'}
        </button>
      </div>
      <div class="result-wrap" id="result-\${s.symbol}" style="display:none"></div>
    </div>
  \`).join('');
}

// ── Analyse ──
async function checkNow(symbol,btn) {
  btn.disabled=true; btn.textContent='...';
  const el=document.getElementById('result-'+symbol);
  try {
    const data=await fetch('/ask?symbol='+encodeURIComponent(symbol)+'&secret='+encodeURIComponent(SECRET)).then(r=>r.json());
    if(data.error) throw new Error(data.error);
    const ai=data.ai||{},sc=Number(ai.score)||0;
    const isRec=ai.recommendation==='RECOMMENDED';
    const rr=(ai.entry&&ai.take_profit&&ai.stop_loss)
      ?(Math.abs(ai.take_profit-ai.entry)/Math.abs(ai.entry-ai.stop_loss)).toFixed(2):null;
    el.style.display='block';
    el.innerHTML=\`<div class="result-card">
      <div class="result-header">
        <span class="result-badge \${isRec?'rec':'norec'}">\${isRec?'✓ Empfohlen':'✗ Nicht empfohlen'}</span>
        <span style="font-family:var(--mono);font-size:0.85rem;font-weight:700;color:\${scoreColor(sc)}">\${sc}/100</span>
      </div>
      <div class="result-body">
        <div class="result-row">
          <span class="result-key">Richtung</span><span class="result-val">\${ai.direction||'–'}</span>
        </div>
        <div class="result-row">
          <span class="result-key">Risiko</span><span class="result-val">\${ai.risk||'–'}</span>
        </div>
        <div class="result-row">
          <span class="result-key">Confidence</span><span class="result-val">\${ai.confidence||0}%</span>
        </div>
        \${rr?'<div class="result-row"><span class="result-key">R/R</span><span class="result-val">1:'+rr+'</span></div>':''}
        <div class="signal-bar-bg"><div class="signal-bar-fill" style="width:\${sc}%;background:\${scoreColor(sc)}"></div></div>
        <div class="result-plan">
          <div class="plan-cell"><div class="plan-lbl">Entry</div><div class="plan-val" style="color:var(--blue)">\${fmt(ai.entry)}</div></div>
          <div class="plan-cell"><div class="plan-lbl">Take Profit</div><div class="plan-val" style="color:var(--green)">\${fmt(ai.take_profit)}</div></div>
          <div class="plan-cell"><div class="plan-lbl">Stop Loss</div><div class="plan-val" style="color:var(--red)">\${fmt(ai.stop_loss)}</div></div>
        </div>
        <div class="result-reason">\${ai.reason||''}</div>
      </div>
    </div>\`;
    showToast(isRec?'Empfohlen!':'Nicht empfohlen');
  } catch(e) {
    el.style.display='block';
    el.innerHTML='<div style="padding:14px 16px;color:var(--red);font-size:0.78rem">Fehler: '+e.message+'</div>';
  }
  btn.disabled=false; btn.textContent=SECRET?'Prüfen':'🔒';
}

// ── History & Filter ──
let currentSort = 'score';
async function loadHistory() {
  const el=document.getElementById('signals-list');
  el.innerHTML='<div class="empty">Lade...</div>';
  allSignals=await fetch('/history').then(r=>r.json()).catch(()=>[]);
  // Populate symbol filter
  const symbols=[...new Set(allSignals.map(x=>x.symbol).filter(Boolean))];
  const sel=document.getElementById('filter-symbol');
  sel.innerHTML='<option value="">Alle Symbole</option>'+symbols.map(s=>'<option value="'+s+'">'+s+'</option>').join('');
  applyFilters();
}
function toggleSort(mode) {
  currentSort=mode;
  document.getElementById('sort-score').classList.toggle('active',mode==='score');
  document.getElementById('sort-time').classList.toggle('active',mode==='time');
  applyFilters();
}
function applyFilters() {
  const sym=document.getElementById('filter-symbol').value;
  const out=document.getElementById('filter-outcome').value;
  let filtered=[...allSignals];
  if(sym) filtered=filtered.filter(x=>x.symbol===sym);
  if(out) filtered=filtered.filter(x=>x.outcome===out);
  if(currentSort==='score') filtered.sort((a,b)=>(b.ai_score||0)-(a.ai_score||0));
  else filtered.sort((a,b)=>b.created_at-a.created_at);
  renderSignals(filtered);
}
function renderSignals(list) {
  const el=document.getElementById('signals-list');
  if(!list.length){el.innerHTML='<div class="empty">Keine Signale gefunden.</div>';return;}
  el.innerHTML=list.map(x=>{
    const sc=Number(x.ai_score)||0;
    const outCls=x.outcome==='WIN'?'b-win':x.outcome==='LOSS'?'b-loss':'b-open';
    const recCls=x.ai_recommendation==='RECOMMENDED'?'b-rec':'b-norec';
    const riskCls=x.ai_risk==='HIGH'?'b-high':x.ai_risk==='MEDIUM'?'b-med':'b-low';
    const isOpen=x.outcome==='OPEN';
    return \`<div class="signal-card">
      <div class="signal-top">
        <span class="signal-symbol">\${x.symbol||'–'}</span>
        <span class="signal-time">\${timeAgo(x.created_at)}</span>
      </div>
      <div class="signal-mid">
        <span class="signal-trigger">\${x.trigger||'–'}</span>
        <span class="signal-score" style="color:\${scoreColor(sc)}">\${sc}/100</span>
      </div>
      <div class="signal-prices">
        <span>E: \${fmt(x.ai_entry)}</span>
        <span style="color:var(--green)">TP: \${fmt(x.ai_take_profit)}</span>
        <span style="color:var(--red)">SL: \${fmt(x.ai_stop_loss)}</span>
      </div>
      <div class="signal-bar-bg"><div class="signal-bar-fill" style="width:\${sc}%;background:\${scoreColor(sc)}"></div></div>
      <div class="signal-footer">
        <div class="badges">
          <span class="badge \${recCls}">\${x.ai_recommendation==='RECOMMENDED'?'Empf.':'Nein'}</span>
          <span class="badge \${riskCls}">\${x.ai_risk||'–'}</span>
          <span class="badge \${outCls}" id="out-\${x.id}">\${x.outcome||'–'}</span>
        </div>
        \${isOpen&&SECRET?\`<div style="display:flex;gap:6px">
          <button class="btn btn-win" onclick="setOutcome('\${x.id}','WIN',this)">WIN</button>
          <button class="btn btn-loss" onclick="setOutcome('\${x.id}','LOSS',this)">LOSS</button>
        </div>\`:''}
      </div>
    </div>\`;
  }).join('');
}

// ── Outcome ──
async function setOutcome(id,outcome,btn) {
  const all=btn.parentElement.querySelectorAll('button');
  all.forEach(b=>b.disabled=true);
  try {
    const r=await fetch('/outcome?id='+id+'&outcome='+outcome+'&secret='+encodeURIComponent(SECRET),{method:'POST'}).then(r=>r.json());
    if(r.status==='ok'){
      const badge=document.getElementById('out-'+id);
      if(badge){badge.className='badge '+(outcome==='WIN'?'b-win':'b-loss');badge.textContent=outcome;}
      btn.parentElement.style.display='none';
      loadStats();
      showToast(outcome==='WIN'?'WIN gespeichert!':'LOSS gespeichert!');
    }
  } catch(e){all.forEach(b=>b.disabled=false);showToast('Fehler: '+e.message);}
}

// ── Tools ──
async function toolAction(action) {
  if(!SECRET&&action!=='health'){showToast('Secret in URL benoetigt');return;}
  showToast('Wird ausgefuehrt...');
  try {
    if(action==='health'){
      const d=await fetch('/health').then(r=>r.json());
      showToast('Worker OK: '+new Date(d.time).toLocaleTimeString('de-DE'),3000);
    } else if(action==='telegram'){
      await fetch('/test-telegram?secret='+encodeURIComponent(SECRET));
      showToast('Telegram Testnachricht gesendet!');
    } else if(action==='morning'){
      await fetch('/morning-brief?secret='+encodeURIComponent(SECRET));
      showToast('Morning Brief gesendet!');
    } else if(action==='outcomes'){
      const d=await fetch('/check-outcomes?secret='+encodeURIComponent(SECRET)).then(r=>r.json());
      showToast((d.result?.closed||0)+' Trades geschlossen',3000);
    }
  } catch(e){showToast('Fehler: '+e.message);}
}

// ── Copy ──
function copyCmd(cmd) {
  navigator.clipboard.writeText(cmd).then(()=>showToast('Kopiert: '+cmd));
}

// Init
loadHome();
</script>
</body>
</html>`;
}
