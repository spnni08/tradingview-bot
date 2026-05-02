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
  const LOGO = "data:image/png;base64,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AAAAAAAAAAMFAABAAAAQFIiApAUAgAAAAABSFAIUAAAAAgKAAAAAAAAACgAAAAAAAdAQAAAAAAAhQAAggUAAAEKQEBQAUAAAAAAEKAAAAAAAAQoYAAAAAIUAADqAAAAAAUADYAAAAAAADIYAAAAAAGQAwMgoAAIAGAgAAAAgQoAABQAAQAAAAhQAB0AKAACAAdQAAAMgAAAAEAKAAAAAAQoAAAYABCkAABQACEAKAAAQAFYAAAAAAAAAYBQAAQAAAAAAABgAAAAAdQAAAAB0AKAB1BAAAAAQoAAAABCgAhQQAAhQUAEBCF6ggBSAoBQAAACgAAAAAAAAAAAAAAAAAAAIAAAhAUEKACFAAACAAAKACFIAAGUAAAAAAAAAAMAAAAAAAAAAAgAIAUAoAAAHQAFAAAAAAAABAAAUAAABgAAAAAhQQAoAQAA5AAEKAAAAAAAAAAAAAAAAAAAAAAAACAAAoIUEICoAFAAAAHUAAAAAAAgIUAAAAAAAAhQAAAAAAQAFAKAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEKAB0AABCgAAAAD2gAgIUEAKAAAAAACFAAA6gAAFAABAAAUAhQQAAAAAAAAFAYAQAA6AgAAAAIUAAAoABACgAAAAAAAgAAKAAAAQoAAAAIUAgAAZQAAAB1AAAAAAAAAAKAAAAACAAAAAhSgAAAAIIAABgAAAAAgBQAAAAAAAAAAAAwAACFAAAAAAIAAACApACgIAAAAAAhQUAEBCgAAAAEKQoAACAAAKAAAAACAAIAAAFAAYIAQoAIUAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAEAIUFAAQICFAAADAAAAAABQB1AIAAAACAApChAAIAAAAAAAAAAAZABQAAQEKCAFAAAAAAABQAQAFAABCgEABCgBgAoAAAAAAAA6gAAAAAAAAEAABQAAAAAAAB1KAGAQAAAAAAAAAAAAAAAAhQAAAAAAAAAUAAAAAhAUAAAAAAAFAYAAAYAAABAAAAAQoABCgAAAAAAAAAEKAAQoAAAAAAAAAAAAAAAAAAAAAAACBACgAAAIAAAgBR0AAAAKAACAAZABCggABQAAAAAAAAAAAAQAAAAAAAgABQAACAEAABQAAAUAAEKAAAAAQAEBQAUAgAAAABQAAQoAAAABAAACgAEAAAAAAKAUAAAAAEAABQAAAAAQEAAAAABSAAFHMAoHQAAAAAAAAAgABQAQAAADIAKAyAEBQAUAAAAAAAgAAABABkAAoAKAAAAAAAQAgKACgEAAKAAAAAAAAAAAAAAAAAAACAAAoBACAvMAAAAFAABAAAAAAAQoBQAAQAAFAABAQoBUAAAAAAAAAAQAAFAICFAACABUAssAAh//2Q==";
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
      --bg:#0d0d0f;--surface:#141416;--surface2:#1a1a1e;--surface3:#202026;
      --border:#2a2a32;--border2:#34343e;
      --pink:#e91e8c;--pink2:#ff4db8;--pink-dim:rgba(233,30,140,0.12);--pink-glow:rgba(233,30,140,0.25);
      --blue:#4f8ef7;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--purple:#a855f7;
      --text:#e8e8f0;--text2:#9090a8;--text3:#60607a;
      --font:'Inter',sans-serif;--mono:'JetBrains Mono',monospace;
      --radius:12px;--sidebar:210px;
    }
    *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
    html{height:100%;}
    body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;display:flex;}

    /* ── LOGIN PAGE ── */
    .login-page{
      position:fixed;inset:0;background:var(--bg);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      z-index:1000;padding:24px;
    }
    .login-page.hidden{display:none;}
    .login-logo{width:80px;height:80px;border-radius:20px;margin-bottom:20px;object-fit:cover;}
    .login-brand{font-size:1.4rem;font-weight:700;background:linear-gradient(135deg,var(--pink),var(--pink2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;}
    .login-tagline{font-size:0.75rem;color:var(--text3);margin-bottom:32px;text-align:center;}
    .login-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px;width:100%;max-width:360px;}
    .login-title{font-size:0.9rem;font-weight:600;margin-bottom:20px;color:var(--text2);}
    .user-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px;}
    .user-btn{
      background:var(--surface2);border:2px solid var(--border);border-radius:12px;
      padding:14px 8px;cursor:pointer;text-align:center;transition:all 0.15s;
      font-family:var(--font);
    }
    .user-btn:hover{border-color:var(--pink);background:var(--pink-dim);}
    .user-btn.selected{border-color:var(--pink2);background:var(--pink-dim);}
    .user-avatar{width:40px;height:40px;border-radius:50%;margin:0 auto 8px;display:flex;align-items:center;justify-content:center;font-size:1.1rem;font-weight:700;color:#fff;}
    .ua-marvin{background:linear-gradient(135deg,var(--pink),var(--purple));}
    .ua-sandro{background:linear-gradient(135deg,var(--blue),var(--purple));}
    .ua-iven{background:linear-gradient(135deg,var(--green),var(--blue));}
    .user-name{font-size:0.78rem;font-weight:600;color:var(--text);}
    .pw-section{display:none;margin-bottom:16px;}
    .pw-section.show{display:block;}
    .pw-label{font-size:0.68rem;color:var(--text3);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;}
    .pw-input{
      width:100%;background:var(--surface2);border:1px solid var(--border);
      color:var(--text);font-family:var(--mono);font-size:0.9rem;
      padding:10px 14px;border-radius:8px;outline:none;
      transition:border-color 0.15s;
    }
    .pw-input:focus{border-color:var(--pink);}
    .pw-hint{font-size:0.62rem;color:var(--text3);margin-top:6px;}
    .login-btn{
      width:100%;background:linear-gradient(135deg,var(--pink),var(--pink2));
      color:#fff;border:none;border-radius:10px;padding:12px;
      font-family:var(--font);font-size:0.88rem;font-weight:700;
      cursor:pointer;transition:opacity 0.15s,transform 0.1s;
    }
    .login-btn:hover{opacity:0.9;}
    .login-btn:active{transform:scale(0.98);}
    .login-error{font-size:0.72rem;color:var(--red);text-align:center;margin-top:10px;min-height:18px;}
    .login-footer{margin-top:32px;text-align:center;}
    .login-footer p{font-size:0.68rem;color:var(--text3);line-height:1.8;}
    .login-footer span{color:var(--pink2);font-weight:600;}

    /* ── SIDEBAR ── */
    .sidebar{
      width:var(--sidebar);flex-shrink:0;
      background:var(--surface);border-right:1px solid var(--border);
      display:flex;flex-direction:column;
      position:fixed;top:0;left:0;bottom:0;z-index:50;
    }
    .sidebar-logo-wrap{
      padding:18px 16px 14px;border-bottom:1px solid var(--border);
      display:flex;align-items:center;gap:10px;
    }
    .sidebar-logo-img{width:34px;height:34px;border-radius:8px;object-fit:cover;}
    .sidebar-logo-text{font-size:1rem;font-weight:700;background:linear-gradient(135deg,var(--pink),var(--pink2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
    .sidebar-logo-sub{font-size:0.58rem;color:var(--text3);}
    .sidebar-nav{padding:12px 8px;flex:1;display:flex;flex-direction:column;gap:2px;overflow-y:auto;}
    .nav-item{
      display:flex;align-items:center;gap:10px;
      padding:9px 10px;border-radius:8px;cursor:pointer;
      font-size:0.8rem;font-weight:500;color:var(--text2);
      transition:background 0.1s,color 0.1s;text-decoration:none;
      border:none;background:none;width:100%;text-align:left;
    }
    .nav-item:hover{background:var(--surface2);color:var(--text);}
    .nav-item.active{background:var(--pink-dim);color:var(--pink2);}
    .nav-icon{font-size:1rem;width:20px;text-align:center;flex-shrink:0;}
    .sidebar-bottom{padding:12px 8px;border-top:1px solid var(--border);}
    .sidebar-user{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;}
    .sidebar-user:hover{background:var(--surface2);}
    .s-avatar{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:700;color:#fff;flex-shrink:0;}
    .s-username{font-size:0.78rem;font-weight:600;}
    .s-role{font-size:0.6rem;color:var(--text3);}
    .s-logout{font-size:0.62rem;color:var(--red);margin-left:auto;cursor:pointer;padding:3px 6px;border-radius:4px;border:none;background:none;}
    .status-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:blink 2s infinite;display:inline-block;}
    @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}

    /* ── MAIN ── */
    .main{margin-left:var(--sidebar);flex:1;min-width:0;display:flex;flex-direction:column;}
    .topbar{
      position:sticky;top:0;z-index:40;
      background:rgba(13,13,15,0.92);backdrop-filter:blur(12px);
      border-bottom:1px solid var(--border);
      padding:0 24px;height:56px;
      display:flex;align-items:center;justify-content:space-between;
    }
    .topbar-title{font-size:1rem;font-weight:600;}
    .topbar-right{display:flex;align-items:center;gap:12px;}
    .topbar-time{font-family:var(--mono);font-size:0.7rem;color:var(--text3);}
    .topbar-live{display:flex;align-items:center;gap:5px;font-size:0.68rem;color:var(--green);font-weight:600;}

    /* ── PAGES ── */
    .page{display:none;padding:24px;}
    .page.active{display:block;}

    /* ── HOME ── */
    .greeting{margin-bottom:22px;}
    .greeting-day{font-size:0.75rem;color:var(--text3);margin-bottom:3px;}
    .greeting-title{font-size:1.45rem;font-weight:700;}
    .greeting-title span{color:var(--pink2);}
    .kpi-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:18px;}
    .kpi-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;position:relative;overflow:hidden;}
    .kpi-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
    .kpi-card.pink::before{background:linear-gradient(90deg,var(--pink),var(--pink2));}
    .kpi-card.green::before{background:var(--green);}
    .kpi-card.red::before{background:var(--red);}
    .kpi-card.blue::before{background:var(--blue);}
    .kpi-label{font-size:0.62rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text3);margin-bottom:8px;}
    .kpi-value{font-size:1.8rem;font-weight:700;line-height:1;font-family:var(--mono);}
    .kpi-value.pink{color:var(--pink2);}
    .kpi-value.green{color:var(--green);}
    .kpi-value.red{color:var(--red);}
    .kpi-value.blue{color:var(--blue);}
    .kpi-sub{font-size:0.62rem;color:var(--text3);margin-top:4px;}
    .section-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:14px;}
    .sc-header{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;}
    .sc-title{font-size:0.82rem;font-weight:600;}
    .sc-body{padding:14px 16px;}
    .quick-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
    .quick-btn{background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:border-color 0.15s;font-family:var(--font);}
    .quick-btn:hover{border-color:var(--border2);}
    .quick-btn:active{background:var(--surface3);}
    .qb-icon{font-size:1.2rem;flex-shrink:0;}
    .qb-label{font-size:0.78rem;font-weight:600;color:var(--text);}
    .qb-desc{font-size:0.6rem;color:var(--text3);margin-top:1px;}
    .mini-signal{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);}
    .mini-signal:last-child{border-bottom:none;padding-bottom:0;}
    .ms-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
    .ms-symbol{font-size:0.82rem;font-weight:700;}
    .ms-trigger{font-size:0.62rem;color:var(--text3);font-family:var(--mono);}
    .ms-score{font-family:var(--mono);font-size:0.78rem;font-weight:700;}
    .ms-time{font-size:0.6rem;color:var(--text3);}
    .wb-card{background:linear-gradient(135deg,rgba(233,30,140,0.12),rgba(79,142,247,0.08));border:1px solid rgba(233,30,140,0.25);border-radius:var(--radius);padding:16px;display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;transition:border-color 0.15s,transform 0.1s;margin-bottom:14px;}
    .wb-card:hover{border-color:var(--pink);transform:translateY(-1px);}
    .wb-icon{font-size:2rem;flex-shrink:0;}
    .wb-title{font-size:0.95rem;font-weight:700;}
    .wb-sub{font-size:0.65rem;color:var(--text3);margin-top:2px;}
    .wb-arrow{margin-left:auto;background:var(--pink-dim);color:var(--pink2);font-size:0.62rem;font-weight:700;padding:5px 10px;border-radius:6px;flex-shrink:0;}

    /* ── SIGNALS ── */
    .filter-bar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
    .filter-select{background:var(--surface2);border:1px solid var(--border);color:var(--text);font-family:var(--font);font-size:0.73rem;padding:7px 10px;border-radius:8px;cursor:pointer;flex:1;min-width:90px;}
    .filter-select:focus{outline:none;border-color:var(--pink);}
    .sort-btn{background:var(--surface2);border:1px solid var(--border);color:var(--text2);font-family:var(--font);font-size:0.7rem;padding:7px 12px;border-radius:8px;cursor:pointer;white-space:nowrap;transition:all 0.15s;}
    .sort-btn.active{border-color:var(--pink);color:var(--pink2);}
    .signal-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;margin-bottom:8px;transition:border-color 0.15s;}
    .signal-card:hover{border-color:var(--border2);}
    .sig-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
    .sig-symbol{font-weight:700;font-size:0.9rem;}
    .sig-time{font-family:var(--mono);font-size:0.6rem;color:var(--text3);}
    .sig-mid{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}
    .sig-trigger{font-family:var(--mono);font-size:0.63rem;color:var(--text3);}
    .sig-score{font-family:var(--mono);font-size:0.78rem;font-weight:700;}
    .sig-prices{font-family:var(--mono);font-size:0.63rem;color:var(--text3);display:flex;gap:10px;margin-bottom:8px;}
    .bar-bg{height:3px;background:var(--surface3);border-radius:2px;margin-bottom:10px;overflow:hidden;}
    .bar-fill{height:100%;border-radius:2px;}
    .sig-footer{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;}
    .badges{display:flex;gap:5px;flex-wrap:wrap;}
    .badge{font-size:0.6rem;font-weight:600;padding:3px 7px;border-radius:5px;}
    .b-win{background:rgba(34,197,94,0.12);color:var(--green);border:1px solid rgba(34,197,94,0.2);}
    .b-open{background:rgba(79,142,247,0.1);color:var(--blue);border:1px solid rgba(79,142,247,0.2);}
    .b-loss{background:rgba(239,68,68,0.12);color:var(--red);border:1px solid rgba(239,68,68,0.2);}
    .b-skipped{background:rgba(96,96,122,0.15);color:var(--text3);border:1px solid var(--border);}
    .b-rec{background:rgba(34,197,94,0.1);color:var(--green);}
    .b-norec{background:rgba(239,68,68,0.1);color:var(--red);}
    .b-low{background:rgba(34,197,94,0.1);color:var(--green);}
    .b-med{background:rgba(245,158,11,0.1);color:var(--yellow);}
    .b-high{background:rgba(239,68,68,0.1);color:var(--red);}

    /* ── RESULT CARD ── */
    .result-wrap{margin:4px 0 8px;}
    .result-card{background:var(--surface2);border:1px solid var(--border2);border-radius:var(--radius);overflow:hidden;animation:slideIn 0.2s ease;}
    @keyframes slideIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
    .result-header{padding:12px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);}
    .result-badge{font-size:0.7rem;font-weight:700;padding:4px 10px;border-radius:6px;}
    .result-badge.rec{background:rgba(34,197,94,0.15);color:var(--green);}
    .result-badge.norec{background:rgba(239,68,68,0.15);color:var(--red);}
    .result-body{padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
    .result-row{display:flex;justify-content:space-between;}
    .result-key{font-size:0.63rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.07em;}
    .result-val{font-family:var(--mono);font-size:0.76rem;}
    .result-plan{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}
    .plan-cell{background:var(--surface3);border-radius:8px;padding:10px;text-align:center;}
    .plan-lbl{font-size:0.56rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.06em;}
    .plan-val{font-family:var(--mono);font-size:0.78rem;font-weight:700;margin-top:4px;}
    .result-reason{font-size:0.74rem;color:var(--text2);line-height:1.6;padding-top:10px;border-top:1px solid var(--border);}

    /* ── BACKTESTING ── */
    .bt-period-tabs{display:flex;gap:6px;margin-bottom:16px;}
    .bt-tab{background:var(--surface2);border:1px solid var(--border);color:var(--text2);font-family:var(--font);font-size:0.72rem;font-weight:600;padding:7px 16px;border-radius:8px;cursor:pointer;transition:all 0.15s;}
    .bt-tab.active{border-color:var(--pink);color:var(--pink2);background:var(--pink-dim);}
    .bt-kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;}
    .bt-kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px;text-align:center;}
    .bt-kpi-val{font-family:var(--mono);font-size:1.4rem;font-weight:700;line-height:1;}
    .bt-kpi-lbl{font-size:0.6rem;color:var(--text3);margin-top:5px;text-transform:uppercase;letter-spacing:0.07em;}
    .bt-score-compare{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:14px;}
    .bt-sc-title{font-size:0.78rem;font-weight:600;margin-bottom:14px;}
    .bt-score-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;}
    .bt-score-row:last-child{margin-bottom:0;}
    .bt-score-label{font-size:0.72rem;font-weight:600;width:60px;flex-shrink:0;}
    .bt-score-bar-bg{flex:1;height:8px;background:var(--surface3);border-radius:4px;overflow:hidden;}
    .bt-score-bar-fill{height:100%;border-radius:4px;transition:width 0.8s ease;}
    .bt-score-val{font-family:var(--mono);font-size:0.72rem;font-weight:700;width:40px;text-align:right;flex-shrink:0;}
    .sym-table{width:100%;border-collapse:collapse;font-size:0.76rem;}
    .sym-table th{text-align:left;padding:8px 10px;font-size:0.62rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.07em;border-bottom:1px solid var(--border);font-weight:600;}
    .sym-table td{padding:9px 10px;border-bottom:1px solid var(--border);}
    .sym-table tr:last-child td{border-bottom:none;}
    .bt-signal-item{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);}
    .bt-signal-item:last-child{border-bottom:none;padding-bottom:0;}
    .bt-sig-left{}
    .bt-sig-sym{font-size:0.82rem;font-weight:700;}
    .bt-sig-dir{font-size:0.62rem;color:var(--text3);font-family:var(--mono);}
    .bt-sig-score{font-family:var(--mono);font-size:0.9rem;font-weight:700;}

    /* ── STRATEGIE ── */
    .strat-section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:12px;overflow:hidden;}
    .strat-header{padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;}
    .strat-icon{font-size:1.2rem;}
    .strat-title{font-size:0.88rem;font-weight:600;}
    .strat-body{padding:14px 16px;}
    .strat-step{display:flex;gap:12px;margin-bottom:14px;}
    .strat-step:last-child{margin-bottom:0;}
    .strat-num{width:24px;height:24px;border-radius:50%;background:var(--pink-dim);border:1px solid var(--pink-glow);color:var(--pink2);font-size:0.7rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}
    .strat-step-text{font-size:0.78rem;line-height:1.6;color:var(--text2);}
    .strat-step-title{font-size:0.82rem;font-weight:600;color:var(--text);margin-bottom:3px;}
    .strat-rule{display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border);}
    .strat-rule:last-child{border-bottom:none;}
    .strat-rule-icon{width:20px;flex-shrink:0;font-size:0.85rem;}
    .strat-rule-text{font-size:0.76rem;color:var(--text2);line-height:1.5;}
    .strat-rule-text strong{color:var(--text);font-weight:600;}
    .no-trade-list{display:flex;flex-direction:column;gap:6px;}
    .no-trade-item{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.1);border-radius:8px;font-size:0.75rem;color:var(--text2);}

    /* ── TOOLS ── */
    .tool-section{margin-bottom:14px;}
    .tool-section-title{font-size:0.62rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:var(--text3);margin-bottom:8px;padding:0 4px;}
    .tool-list{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;}
    .tool-row{display:flex;align-items:center;padding:13px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.1s;text-decoration:none;color:inherit;}
    .tool-row:last-child{border-bottom:none;}
    .tool-row:hover{background:var(--surface2);}
    .tr-icon{font-size:1.1rem;width:28px;flex-shrink:0;}
    .tr-text{flex:1;}
    .tr-label{font-size:0.8rem;font-weight:600;}
    .tr-desc{font-size:0.63rem;color:var(--text3);margin-top:2px;}
    .tr-arrow{color:var(--text3);font-size:0.8rem;}

    /* ── TELEGRAM ── */
    .cmd-grid{display:flex;flex-direction:column;gap:6px;}
    .cmd-row{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;transition:background 0.1s;}
    .cmd-row:hover{background:var(--surface2);}
    .cmd-code{font-family:var(--mono);font-size:0.8rem;color:var(--pink2);font-weight:700;}
    .cmd-desc{font-size:0.63rem;color:var(--text3);margin-top:2px;}

    /* ── BUTTONS ── */
    .btn{font-family:var(--font);font-weight:600;font-size:0.75rem;border:none;border-radius:8px;padding:8px 14px;cursor:pointer;transition:opacity 0.15s,transform 0.1s;display:inline-flex;align-items:center;gap:5px;}
    .btn:active{transform:scale(0.96);}
    .btn:disabled{opacity:0.35;cursor:not-allowed;transform:none;}
    .btn-primary{background:linear-gradient(135deg,var(--pink),var(--pink2));color:#fff;}
    .btn-ghost{background:var(--surface2);border:1px solid var(--border);color:var(--text2);font-size:0.7rem;padding:6px 12px;}
    .btn-ghost:hover{border-color:var(--border2);color:var(--text);}
    .btn-win{background:rgba(34,197,94,0.12);color:var(--green);border:1px solid rgba(34,197,94,0.25);font-size:0.65rem;padding:5px 9px;}
    .btn-loss{background:rgba(239,68,68,0.12);color:var(--red);border:1px solid rgba(239,68,68,0.25);font-size:0.65rem;padding:5px 9px;}
    .btn-skip{background:rgba(96,96,122,0.12);color:var(--text3);border:1px solid var(--border);font-size:0.65rem;padding:5px 9px;}

    /* ── EMPTY / TOAST ── */
    .empty{text-align:center;padding:32px;color:var(--text3);font-size:0.8rem;line-height:1.7;}
    .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface2);border:1px solid var(--border2);color:var(--text);font-size:0.76rem;padding:10px 20px;border-radius:20px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.2s;white-space:nowrap;max-width:90vw;}
    .toast.show{opacity:1;}

    /* ── MOBILE ── */
    @media(max-width:640px){
      :root{--sidebar:0px;}
      .sidebar{display:none;}
      .main{margin-left:0;}
      .page{padding:16px;}
      .topbar{padding:0 16px;}
      .topbar-time{display:none;}
      .bottom-nav{display:flex !important;}
      body{padding-bottom:68px;}
      .kpi-grid{grid-template-columns:repeat(2,1fr);}
      .bt-kpi-grid{grid-template-columns:repeat(3,1fr);}
    }
    .bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;z-index:50;background:var(--surface);border-top:1px solid var(--border);padding:6px 0 max(6px,env(safe-area-inset-bottom));}
    .bn-item{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;padding:4px 0;font-size:0.56rem;font-weight:600;color:var(--text3);transition:color 0.15s;border:none;background:none;font-family:var(--font);}
    .bn-item.active{color:var(--pink2);}
    .bn-icon{font-size:1.15rem;}
  </style>
</head>
<body>

<!-- LOGIN PAGE -->
<div class="login-page" id="login-page">
  <img src="\${LOGO}" class="login-logo" alt="WaveScout">
  <div class="login-brand">WaveScout</div>
  <div class="login-tagline">Trading Signal Intelligence</div>

  <div class="login-card">
    <div class="login-title">Wer bist du?</div>
    <div class="user-grid">
      <div class="user-btn" onclick="selectUser('Marvin')">
        <div class="user-avatar ua-marvin">M</div>
        <div class="user-name">Marvin</div>
      </div>
      <div class="user-btn" onclick="selectUser('Sandro')">
        <div class="user-avatar ua-sandro">S</div>
        <div class="user-name">Sandro</div>
      </div>
      <div class="user-btn" onclick="selectUser('Iven')">
        <div class="user-avatar ua-iven">I</div>
        <div class="user-name">Iven</div>
      </div>
    </div>

    <div class="pw-section" id="pw-section">
      <div class="pw-label">Passwort</div>
      <input type="password" class="pw-input" id="pw-input" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()">
      <div class="pw-hint" id="pw-hint"></div>
    </div>

    <button class="login-btn" onclick="doLogin()" id="login-btn" style="display:none">Anmelden →</button>
    <div class="login-error" id="login-error"></div>
  </div>

  <div class="login-footer">
    <p>Made by <span>WaveWatch</span></p>
    <p>Made for Trader</p>
  </div>
</div>

<!-- SIDEBAR -->
<div class="sidebar">
  <div class="sidebar-logo-wrap">
    <img src="\${LOGO}" class="sidebar-logo-img" alt="logo">
    <div>
      <div class="sidebar-logo-text">WaveScout</div>
      <div class="sidebar-logo-sub">Signal Intelligence</div>
    </div>
  </div>
  <nav class="sidebar-nav">
    <button class="nav-item active" onclick="goTo('home')"><span class="nav-icon">🏠</span>Dashboard</button>
    <button class="nav-item" onclick="goTo('analyse')"><span class="nav-icon">🔍</span>Analyse</button>
    <button class="nav-item" onclick="goTo('signals')"><span class="nav-icon">📋</span>Signale</button>
    <button class="nav-item" onclick="goTo('backtesting')"><span class="nav-icon">📊</span>Backtesting</button>
    <button class="nav-item" onclick="goTo('strategie')"><span class="nav-icon">📖</span>Strategie</button>
    <button class="nav-item" onclick="goTo('tools')"><span class="nav-icon">🔧</span>Tools</button>
    <button class="nav-item" onclick="goTo('telegram')"><span class="nav-icon">💬</span>Telegram</button>
  </nav>
  <div class="sidebar-bottom">
    <div class="sidebar-user">
      <div class="s-avatar" id="s-avatar" style="background:linear-gradient(135deg,var(--pink),var(--purple))">M</div>
      <div>
        <div class="s-username" id="s-username">Marvin</div>
        <div class="s-role"><span class="status-dot"></span> Live</div>
      </div>
      <button class="s-logout" onclick="logout()">Abmelden</button>
    </div>
  </div>
</div>

<!-- MAIN -->
<div class="main">
  <div class="topbar">
    <div class="topbar-title" id="topbar-title">Dashboard</div>
    <div class="topbar-right">
      <div class="topbar-time" id="clock">–</div>
      <div class="topbar-live"><span class="status-dot"></span>Live</div>
    </div>
  </div>

  <!-- HOME -->
  <div class="page active" id="page-home">
    <div class="greeting">
      <div class="greeting-day" id="greeting-day">–</div>
      <div class="greeting-title" id="greeting-title">Guten Morgen, <span>Marvin</span> 👋</div>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card pink"><div class="kpi-label">Offene Signale</div><div class="kpi-value pink" id="kpi-open">–</div><div class="kpi-sub">aktive Trades</div></div>
      <div class="kpi-card green"><div class="kpi-label">Wins</div><div class="kpi-value green" id="kpi-wins">–</div><div class="kpi-sub">gesamt</div></div>
      <div class="kpi-card red"><div class="kpi-label">Losses</div><div class="kpi-value red" id="kpi-losses">–</div><div class="kpi-sub">gesamt</div></div>
      <div class="kpi-card blue"><div class="kpi-label">Winrate</div><div class="kpi-value blue" id="kpi-winrate">–</div><div class="kpi-sub">Trefferquote</div></div>
    </div>
    <div class="section-card">
      <div class="sc-header"><div class="sc-title">Schnell-Aktionen</div></div>
      <div class="sc-body">
        <div class="quick-grid">
          <div class="quick-btn" onclick="goTo('analyse')"><div class="qb-icon">🔍</div><div><div class="qb-label">Analyse</div><div class="qb-desc">Symbol prüfen</div></div></div>
          <div class="quick-btn" onclick="toolAction('morning')"><div class="qb-icon">🌅</div><div><div class="qb-label">Morning Brief</div><div class="qb-desc">Jetzt senden</div></div></div>
          <div class="quick-btn" onclick="toolAction('outcomes')"><div class="qb-icon">🔄</div><div><div class="qb-label">Outcomes</div><div class="qb-desc">WIN/LOSS prüfen</div></div></div>
          <div class="quick-btn" onclick="goTo('backtesting')"><div class="qb-icon">📊</div><div><div class="qb-label">Backtesting</div><div class="qb-desc">Auswertung</div></div></div>
        </div>
      </div>
    </div>
    <div class="section-card">
      <div class="sc-header"><div class="sc-title">Letzte Signale</div><button class="btn btn-ghost" onclick="goTo('signals')">Alle →</button></div>
      <div class="sc-body" id="home-signals"><div class="empty">Lade...</div></div>
    </div>
    <a class="wb-card" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank">
      <div class="wb-icon">🌊</div>
      <div><div class="wb-title">WaveBoard</div><div class="wb-sub">Externes Trading Dashboard</div></div>
      <div class="wb-arrow">↗ Öffnen</div>
    </a>
  </div>

  <!-- ANALYSE -->
  <div class="page" id="page-analyse">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div style="font-size:0.63rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em">Snapshots</div>
      <button class="btn btn-ghost" onclick="loadSnapshots()">↻ Refresh</button>
    </div>
    <div id="snapshots-list"><div class="empty">Lade...</div></div>
  </div>

  <!-- SIGNALE -->
  <div class="page" id="page-signals">
    <div class="filter-bar">
      <select class="filter-select" id="filter-symbol" onchange="applyFilters()"><option value="">Alle Symbole</option></select>
      <select class="filter-select" id="filter-outcome" onchange="applyFilters()" style="flex:0.8">
        <option value="">Alle</option>
        <option value="OPEN">Open</option>
        <option value="WIN">Win</option>
        <option value="LOSS">Loss</option>
        <option value="SKIPPED">Skipped</option>
      </select>
      <button class="sort-btn active" id="sort-score" onclick="toggleSort('score')">Score ↓</button>
      <button class="sort-btn" id="sort-time" onclick="toggleSort('time')">Zeit ↓</button>
    </div>
    <div id="signals-list"><div class="empty">Lade...</div></div>
  </div>

  <!-- BACKTESTING -->
  <div class="page" id="page-backtesting">
    <div class="bt-period-tabs">
      <button class="bt-tab active" onclick="btPeriod('all',this)">Gesamt</button>
      <button class="bt-tab" onclick="btPeriod('month',this)">30 Tage</button>
      <button class="bt-tab" onclick="btPeriod('week',this)">7 Tage</button>
    </div>
    <div id="bt-content"><div class="empty">Lade...</div></div>
  </div>

  <!-- STRATEGIE -->
  <div class="page" id="page-strategie">
    <div class="strat-section">
      <div class="strat-header"><div class="strat-icon">🎯</div><div class="strat-title">Top-Down Daytrading — Überblick</div></div>
      <div class="strat-body">
        <div class="strat-step"><div class="strat-num">1</div><div><div class="strat-step-title">Morgen-Routine (10 Min)</div><div class="strat-step-text">4H Chart öffnen → EMA200 prüfen. Preis darüber = Long-Bias, darunter = Short-Bias. EMA flach = kein Trade heute. 1–2 Key-Zonen auf 15min markieren.</div></div></div>
        <div class="strat-step"><div class="strat-num">2</div><div><div class="strat-step-title">Zonenanalyse (15min)</div><div class="strat-step-text">Warten bis der Preis eine der markierten Zonen erreicht. Nicht hinterherlaufen. Higher Low (Long) oder Lower High (Short) muss sichtbar sein. Kein Chaos, kein Seitwärtsmarkt.</div></div></div>
        <div class="strat-step"><div class="strat-num">3</div><div><div class="strat-step-title">Entry (5–10min)</div><div class="strat-step-text">Klare Trendkerze mit starkem Body, wenig Docht. Bruch von lokalem High (Long) oder Low (Short) abwarten. RSI als Filter — kein Signal allein.</div></div></div>
      </div>
    </div>

    <div class="strat-section">
      <div class="strat-header"><div class="strat-icon">📏</div><div class="strat-title">Entry-Regeln</div></div>
      <div class="strat-body">
        <div class="strat-rule"><div class="strat-rule-icon">✅</div><div class="strat-rule-text"><strong>RSI Long:</strong> 30–55 steigend. <strong>RSI Short:</strong> 45–70 fallend. Kein Entry bei RSI über 70 oder unter 30.</div></div>
        <div class="strat-rule"><div class="strat-rule-icon">✅</div><div class="strat-rule-text"><strong>EMA200 (4H):</strong> Preis über EMA200 = nur Long. Preis unter EMA200 = nur Short.</div></div>
        <div class="strat-rule"><div class="strat-rule-icon">✅</div><div class="strat-rule-text"><strong>Trendstruktur:</strong> EMA50 über EMA200 (Long) oder darunter (Short). Neutral = kein Trade.</div></div>
        <div class="strat-rule"><div class="strat-rule-icon">✅</div><div class="strat-rule-text"><strong>Zone:</strong> Long nah an Support. Short nah an Resistance. Genug Abstand zur Gegenseite.</div></div>
        <div class="strat-rule"><div class="strat-rule-icon">✅</div><div class="strat-rule-text"><strong>R/R:</strong> Mindestens 1:1.5 — Ziel 1:2. SL logisch unter/über Struktur.</div></div>
      </div>
    </div>

    <div class="strat-section">
      <div class="strat-header"><div class="strat-icon">🚫</div><div class="strat-title">Kein Trade — Ausschlusskriterien</div></div>
      <div class="strat-body">
        <div class="no-trade-list">
          <div class="no-trade-item">❌ Trade läuft gegen den Tages-Bias</div>
          <div class="no-trade-item">❌ EMA200 auf 4H ist flach oder Preis direkt dran</div>
          <div class="no-trade-item">❌ Viele Wicks, Chaos, kein klares Bild</div>
          <div class="no-trade-item">❌ FOMO-Gefühl — man will unbedingt rein</div>
          <div class="no-trade-item">❌ Man könnte den Trade nicht klar erklären</div>
          <div class="no-trade-item">❌ RSI extrem überkauft oder überverkauft</div>
        </div>
      </div>
    </div>

    <div class="strat-section">
      <div class="strat-header"><div class="strat-icon">✔️</div><div class="strat-title">Final Check — alle 3 mit Ja?</div></div>
      <div class="strat-body">
        <div class="strat-rule"><div class="strat-rule-icon">☑️</div><div class="strat-rule-text">Passt der Trade zum Tages-Bias?</div></div>
        <div class="strat-rule"><div class="strat-rule-icon">☑️</div><div class="strat-rule-text">Könnte ich diesen Trade jemandem erklären?</div></div>
        <div class="strat-rule"><div class="strat-rule-icon">☑️</div><div class="strat-rule-text">Ruhig und klar im Kopf? — Wenn nein: warten.</div></div>
      </div>
    </div>

    <div class="strat-section">
      <div class="strat-header"><div class="strat-icon">💱</div><div class="strat-title">Instrumente</div></div>
      <div class="strat-body">
        <table class="sym-table">
          <tr><th>Symbol</th><th>Priorität</th><th>Begründung</th></tr>
          <tr><td><strong>BTC/USDT</strong></td><td><span class="badge b-win">Primär</span></td><td style="font-size:0.72rem;color:var(--text2)">Höchste Liquidität, klarste Strukturen</td></tr>
          <tr><td><strong>ETH/USDT</strong></td><td><span class="badge b-open">Sekundär</span></td><td style="font-size:0.72rem;color:var(--text2)">Ähnlich sauber, etwas mehr Bewegung</td></tr>
          <tr><td><strong>SOL/USDT</strong></td><td><span class="badge b-skipped">Optional</span></td><td style="font-size:0.72rem;color:var(--text2)">Nur bei klarer Trendstruktur</td></tr>
        </table>
      </div>
    </div>
  </div>

  <!-- TOOLS -->
  <div class="page" id="page-tools">
    <a class="wb-card" href="https://waveboard-e54ed.web.app/waveboard/dashboard" target="_blank">
      <div class="wb-icon">🌊</div>
      <div><div class="wb-title">WaveBoard Dashboard</div><div class="wb-sub">waveboard-e54ed.web.app</div></div>
      <div class="wb-arrow">↗ Öffnen</div>
    </a>
    <div class="tool-section">
      <div class="tool-section-title">System</div>
      <div class="tool-list">
        <div class="tool-row" onclick="toolAction('health')"><div class="tr-icon">💚</div><div class="tr-text"><div class="tr-label">Health Check</div><div class="tr-desc">Worker Status prüfen</div></div><div class="tr-arrow">›</div></div>
        <div class="tool-row" onclick="toolAction('telegram')"><div class="tr-icon">📨</div><div class="tr-text"><div class="tr-label">Telegram testen</div><div class="tr-desc">Test-Nachricht senden</div></div><div class="tr-arrow">›</div></div>
        <div class="tool-row" onclick="toolAction('morning')"><div class="tr-icon">🌅</div><div class="tr-text"><div class="tr-label">Morning Brief</div><div class="tr-desc">Tages-Bias jetzt abrufen</div></div><div class="tr-arrow">›</div></div>
        <div class="tool-row" onclick="toolAction('outcomes')"><div class="tr-icon">🔄</div><div class="tr-text"><div class="tr-label">Outcome Tracking</div><div class="tr-desc">WIN/LOSS via Binance prüfen</div></div><div class="tr-arrow">›</div></div>
      </div>
    </div>
    <div class="tool-section">
      <div class="tool-section-title">Links</div>
      <div class="tool-list">
        <a class="tool-row" href="https://tradingview.com" target="_blank"><div class="tr-icon">📊</div><div class="tr-text"><div class="tr-label">TradingView</div><div class="tr-desc">Charts & Alerts</div></div><div class="tr-arrow">↗</div></a>
        <a class="tool-row" href="https://dash.cloudflare.com" target="_blank"><div class="tr-icon">☁️</div><div class="tr-text"><div class="tr-label">Cloudflare</div><div class="tr-desc">Worker & Logs</div></div><div class="tr-arrow">↗</div></a>
        <a class="tool-row" href="https://github.com/spnni08/tradingview-bot" target="_blank"><div class="tr-icon">🐙</div><div class="tr-text"><div class="tr-label">GitHub</div><div class="tr-desc">spnni08/tradingview-bot</div></div><div class="tr-arrow">↗</div></a>
        <a class="tool-row" href="https://console.anthropic.com" target="_blank"><div class="tr-icon">🤖</div><div class="tr-text"><div class="tr-label">Anthropic Console</div><div class="tr-desc">Claude API Keys</div></div><div class="tr-arrow">↗</div></a>
      </div>
    </div>
  </div>

  <!-- TELEGRAM -->
  <div class="page" id="page-telegram">
    <div style="font-size:0.62rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:12px">Tippe zum Kopieren</div>
    <div class="cmd-grid">
      <div class="cmd-row" onclick="copyCmd('/btc')"><div><div class="cmd-code">/btc</div><div class="cmd-desc">Bitcoin analysieren</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="copyCmd('/eth')"><div><div class="cmd-code">/eth</div><div class="cmd-desc">Ethereum analysieren</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="copyCmd('/sol')"><div><div class="cmd-code">/sol</div><div class="cmd-desc">Solana analysieren</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="copyCmd('/check RENDERUSDT')"><div><div class="cmd-code">/check SYMBOL</div><div class="cmd-desc">Beliebiges Symbol</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="copyCmd('/status')"><div><div class="cmd-code">/status</div><div class="cmd-desc">Winrate & Stats</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="copyCmd('/brief')"><div><div class="cmd-code">/brief</div><div class="cmd-desc">Morning Brief senden</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="copyCmd('/open')"><div><div class="cmd-code">/open</div><div class="cmd-desc">Offene Trades</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="copyCmd('/top')"><div><div class="cmd-code">/top</div><div class="cmd-desc">Beste Signale heute</div></div><div>📋</div></div>
      <div class="cmd-row" onclick="copyCmd('/hilfe')"><div><div class="cmd-code">/hilfe</div><div class="cmd-desc">Alle Kommandos</div></div><div>📋</div></div>
    </div>
  </div>
</div>

<!-- BOTTOM NAV -->
<div class="bottom-nav" id="bottom-nav">
  <button class="bn-item active" onclick="goTo('home')"><span class="bn-icon">🏠</span>Home</button>
  <button class="bn-item" onclick="goTo('analyse')"><span class="bn-icon">🔍</span>Analyse</button>
  <button class="bn-item" onclick="goTo('signals')"><span class="bn-icon">📋</span>Signale</button>
  <button class="bn-item" onclick="goTo('backtesting')"><span class="bn-icon">📊</span>Backtest</button>
  <button class="bn-item" onclick="goTo('tools')"><span class="bn-icon">🔧</span>Tools</button>
</div>

<div class="toast" id="toast"></div>

<script>
const SECRET = new URLSearchParams(location.search).get('secret') || '';

// ── USER PASSWORDS (stored in localStorage) ──
const USERS = {
  Marvin: { color: 'linear-gradient(135deg,#e91e8c,#a855f7)', initial: 'M' },
  Sandro: { color: 'linear-gradient(135deg,#4f8ef7,#a855f7)', initial: 'S' },
  Iven:   { color: 'linear-gradient(135deg,#22c55e,#4f8ef7)', initial: 'I' }
};
const DEFAULT_PW = 'wavescout2024';
let selectedUser = null;
let currentBtData = null;

// ── AUTH ──
function checkAuth() {
  const user = localStorage.getItem('ws_user');
  const pw = localStorage.getItem('ws_pw_' + user);
  if (user && pw) {
    loginSuccess(user);
    return true;
  }
  return false;
}

function selectUser(name) {
  selectedUser = name;
  document.querySelectorAll('.user-btn').forEach(b => b.classList.remove('selected'));
  event.currentTarget.classList.add('selected');

  const pwSection = document.getElementById('pw-section');
  const loginBtn = document.getElementById('login-btn');
  const pwHint = document.getElementById('pw-hint');

  const hasPw = localStorage.getItem('ws_pw_' + name);
  pwSection.classList.add('show');
  loginBtn.style.display = 'block';
  document.getElementById('pw-input').value = '';
  document.getElementById('login-error').textContent = '';

  if (!hasPw) {
    pwHint.textContent = 'Erste Anmeldung: Setze dein eigenes Passwort.';
  } else {
    pwHint.textContent = 'Willkommen zurueck, ' + name + '!';
  }
  document.getElementById('pw-input').focus();
}

function doLogin() {
  if (!selectedUser) return;
  const pw = document.getElementById('pw-input').value;
  if (!pw || pw.length < 4) {
    document.getElementById('login-error').textContent = 'Passwort mindestens 4 Zeichen.';
    return;
  }

  const stored = localStorage.getItem('ws_pw_' + selectedUser);

  if (!stored) {
    // First login - set password
    localStorage.setItem('ws_pw_' + selectedUser, pw);
    localStorage.setItem('ws_user', selectedUser);
    loginSuccess(selectedUser);
  } else if (stored === pw) {
    localStorage.setItem('ws_user', selectedUser);
    loginSuccess(selectedUser);
  } else {
    document.getElementById('login-error').textContent = 'Falsches Passwort.';
    document.getElementById('pw-input').value = '';
    document.getElementById('pw-input').focus();
  }
}

function loginSuccess(name) {
  document.getElementById('login-page').classList.add('hidden');
  const u = USERS[name] || USERS.Marvin;
  document.getElementById('s-avatar').style.background = u.color;
  document.getElementById('s-avatar').textContent = u.initial;
  document.getElementById('s-username').textContent = name;
  updateGreeting(name);
  loadHome();
}

function logout() {
  localStorage.removeItem('ws_user');
  document.getElementById('login-page').classList.remove('hidden');
  document.querySelectorAll('.user-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('pw-section').classList.remove('show');
  document.getElementById('login-btn').style.display = 'none';
  document.getElementById('login-error').textContent = '';
  selectedUser = null;
}

// ── CLOCK & GREETING ──
function updateGreeting(name) {
  const h = new Date().getHours();
  const greet = h < 12 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
  const days = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const months = ['Januar','Februar','Maerz','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const now = new Date();
  document.getElementById('greeting-day').textContent = days[now.getDay()] + ', ' + now.getDate() + '. ' + months[now.getMonth()] + ' ' + now.getFullYear();
  document.getElementById('greeting-title').innerHTML = greet + ', <span>' + (name || 'Trader') + '</span> 👋';
}
setInterval(() => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  updateGreeting(localStorage.getItem('ws_user'));
}, 1000);

// ── UTILS ──
function fmt(n,d=2) {
  if(!n&&n!==0) return '–';
  return Number(n).toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});
}
function timeAgo(ts) {
  const d=Date.now()-ts;
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

// ── NAV ──
const pageNames={home:'Dashboard',analyse:'Analyse',signals:'Signale',backtesting:'Backtesting',strategie:'Strategie',tools:'Tools',telegram:'Telegram'};
function goTo(name) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.querySelectorAll('.bn-item').forEach((b,i)=>{
    const pages=['home','analyse','signals','backtesting','tools'];
    b.classList.toggle('active',pages[i]===name);
  });
  document.getElementById('page-'+name).classList.add('active');
  document.getElementById('topbar-title').textContent=pageNames[name]||name;
  const navPages=['home','analyse','signals','backtesting','strategie','tools','telegram'];
  const idx=navPages.indexOf(name);
  if(idx>=0) document.querySelectorAll('.nav-item')[idx]?.classList.add('active');
  if(name==='analyse') loadSnapshots();
  if(name==='signals') loadHistory();
  if(name==='backtesting') loadBacktesting();
  if(name==='home') loadHome();
}

// ── STATS ──
async function loadStats() {
  const s=await fetch('/stats').then(r=>r.json()).catch(()=>({}));
  document.getElementById('kpi-open').textContent=s.open||0;
  document.getElementById('kpi-wins').textContent=s.wins||0;
  document.getElementById('kpi-losses').textContent=s.losses||0;
  document.getElementById('kpi-winrate').textContent=(s.winrate||0)+'%';
}

// ── HOME ──
async function loadHome() {
  await loadStats();
  const hist=await fetch('/history').then(r=>r.json()).catch(()=>[]);
  const el=document.getElementById('home-signals');
  if(!hist.length){el.innerHTML='<div class="empty">Noch keine Signale.</div>';return;}
  el.innerHTML=hist.slice(0,5).map(x=>{
    const sc=Number(x.ai_score)||0;
    const isLong=x.ai_direction==='LONG';
    return \`<div class="mini-signal">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="ms-dot" style="background:\${isLong?'var(--green)':'var(--red)'}"></div>
        <div><div class="ms-symbol">\${x.symbol||'–'}</div><div class="ms-trigger">\${x.trigger||'–'}</div></div>
      </div>
      <div style="text-align:right">
        <div class="ms-score" style="color:\${scoreColor(sc)}">\${sc}/100</div>
        <div class="ms-time">\${timeAgo(x.created_at)}</div>
      </div>
    </div>\`;
  }).join('');
}

// ── SNAPSHOTS ──
async function loadSnapshots() {
  const el=document.getElementById('snapshots-list');
  el.innerHTML='<div class="empty">Lade...</div>';
  const snaps=await fetch('/snapshots').then(r=>r.json()).catch(()=>[]);
  if(!snaps.length){el.innerHTML='<div class="empty">Noch keine Snapshots.<br>TradingView muss erst Daten senden.</div>';return;}
  el.innerHTML=snaps.map(s=>\`
    <div>
      <div class="snapshot-card" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;display:flex;align-items:center;gap:12px;margin-bottom:4px">
        <div style="flex:1;min-width:0">
          <div style="font-size:0.92rem;font-weight:700">\${s.symbol}</div>
          <div style="font-family:var(--mono);font-size:0.6rem;color:var(--text3);margin-top:3px">RSI \${fmt(s.rsi,1)} · EMA50 \${fmt(s.ema50,0)} · \${s.trend||'–'}</div>
        </div>
        <div style="font-family:var(--mono);font-size:0.88rem;font-weight:700;color:var(--blue);white-space:nowrap">\${fmt(s.price)}</div>
        <button class="btn btn-primary" onclick="checkNow('\${s.symbol}',this)" \${SECRET?'':'disabled'} style="font-size:0.68rem;padding:7px 12px">
          \${SECRET?'Prüfen':'🔒'}
        </button>
      </div>
      <div class="result-wrap" id="result-\${s.symbol}" style="display:none"></div>
    </div>
  \`).join('');
}

// ── ANALYSE ──
async function checkNow(symbol,btn) {
  btn.disabled=true;btn.textContent='...';
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
        <div class="result-row"><span class="result-key">Richtung</span><span class="result-val">\${ai.direction||'–'}</span></div>
        <div class="result-row"><span class="result-key">Risiko</span><span class="result-val">\${ai.risk||'–'}</span></div>
        <div class="result-row"><span class="result-key">Confidence</span><span class="result-val">\${ai.confidence||0}%</span></div>
        \${rr?'<div class="result-row"><span class="result-key">R/R</span><span class="result-val">1:'+rr+'</span></div>':''}
        <div class="bar-bg"><div class="bar-fill" style="width:\${sc}%;background:\${scoreColor(sc)}"></div></div>
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
    el.innerHTML='<div style="padding:14px 16px;color:var(--red);font-size:0.76rem">Fehler: '+e.message+'</div>';
  }
  btn.disabled=false;btn.textContent=SECRET?'Prüfen':'🔒';
}

// ── SIGNALS ──
let allSignals=[];
let currentSort='score';
async function loadHistory() {
  const el=document.getElementById('signals-list');
  el.innerHTML='<div class="empty">Lade...</div>';
  allSignals=await fetch('/history').then(r=>r.json()).catch(()=>[]);
  const syms=[...new Set(allSignals.map(x=>x.symbol).filter(Boolean))];
  const sel=document.getElementById('filter-symbol');
  sel.innerHTML='<option value="">Alle Symbole</option>'+syms.map(s=>'<option value="'+s+'">'+s+'</option>').join('');
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
  let f=[...allSignals];
  if(sym) f=f.filter(x=>x.symbol===sym);
  if(out) f=f.filter(x=>x.outcome===out);
  if(currentSort==='score') f.sort((a,b)=>(b.ai_score||0)-(a.ai_score||0));
  else f.sort((a,b)=>b.created_at-a.created_at);
  renderSignals(f);
}
function renderSignals(list) {
  const el=document.getElementById('signals-list');
  if(!list.length){el.innerHTML='<div class="empty">Keine Signale gefunden.</div>';return;}
  el.innerHTML=list.map(x=>{
    const sc=Number(x.ai_score)||0;
    const outCls=x.outcome==='WIN'?'b-win':x.outcome==='LOSS'?'b-loss':x.outcome==='SKIPPED'?'b-skipped':'b-open';
    const recCls=x.ai_recommendation==='RECOMMENDED'?'b-rec':'b-norec';
    const riskCls=x.ai_risk==='HIGH'?'b-high':x.ai_risk==='MEDIUM'?'b-med':'b-low';
    const isOpen=x.outcome==='OPEN';
    return \`<div class="signal-card">
      <div class="sig-top"><span class="sig-symbol">\${x.symbol||'–'}</span><span class="sig-time">\${timeAgo(x.created_at)}</span></div>
      <div class="sig-mid"><span class="sig-trigger">\${x.trigger||'–'}</span><span class="sig-score" style="color:\${scoreColor(sc)}">\${sc}/100</span></div>
      <div class="sig-prices"><span>E: \${fmt(x.ai_entry)}</span><span style="color:var(--green)">TP: \${fmt(x.ai_take_profit)}</span><span style="color:var(--red)">SL: \${fmt(x.ai_stop_loss)}</span></div>
      <div class="bar-bg"><div class="bar-fill" style="width:\${sc}%;background:\${scoreColor(sc)}"></div></div>
      <div class="sig-footer">
        <div class="badges">
          <span class="badge \${recCls}">\${x.ai_recommendation==='RECOMMENDED'?'Empf.':'Nein'}</span>
          <span class="badge \${riskCls}">\${x.ai_risk||'–'}</span>
          <span class="badge \${outCls}" id="out-\${x.id}">\${x.outcome||'–'}</span>
        </div>
        \${isOpen&&SECRET?\`<div style="display:flex;gap:5px">
          <button class="btn btn-win" onclick="setOutcome('\${x.id}','WIN',this)">WIN</button>
          <button class="btn btn-loss" onclick="setOutcome('\${x.id}','LOSS',this)">LOSS</button>
          <button class="btn btn-skip" onclick="setOutcome('\${x.id}','SKIPPED',this)">Skip</button>
        </div>\`:''}
      </div>
    </div>\`;
  }).join('');
}

// ── OUTCOME ──
async function setOutcome(id,outcome,btn) {
  const all=btn.parentElement.querySelectorAll('button');
  all.forEach(b=>b.disabled=true);
  try {
    const r=await fetch('/outcome?id='+id+'&outcome='+outcome+'&secret='+encodeURIComponent(SECRET),{method:'POST'}).then(r=>r.json());
    if(r.status==='ok'){
      const badge=document.getElementById('out-'+id);
      if(badge){
        badge.className='badge '+(outcome==='WIN'?'b-win':outcome==='LOSS'?'b-loss':'b-skipped');
        badge.textContent=outcome;
      }
      btn.parentElement.style.display='none';
      loadStats();
      showToast(outcome==='WIN'?'WIN gespeichert!':outcome==='LOSS'?'LOSS gespeichert!':'Als Skip markiert');
    }
  } catch(e){all.forEach(b=>b.disabled=false);showToast('Fehler: '+e.message);}
}

// ── BACKTESTING ──
let btPeriodCurrent = 'all';
async function loadBacktesting() {
  const el=document.getElementById('bt-content');
  el.innerHTML='<div class="empty">Lade...</div>';
  currentBtData=await fetch('/backtesting').then(r=>r.json()).catch(()=>null);
  if(!currentBtData||currentBtData.error){el.innerHTML='<div class="empty">Fehler beim Laden.</div>';return;}
  renderBt(btPeriodCurrent);
}
function btPeriod(p,btn) {
  btPeriodCurrent=p;
  document.querySelectorAll('.bt-tab').forEach(t=>t.classList.remove('active'));
  btn.classList.add('active');
  renderBt(p);
}
function renderBt(period) {
  if(!currentBtData) return;
  const el=document.getElementById('bt-content');
  const d=period==='week'?currentBtData.week:period==='month'?currentBtData.month:currentBtData.overall;
  const closed=(d.wins||0)+(d.losses||0);
  const wr=closed>0?((d.wins/closed)*100).toFixed(1):0;
  const o=currentBtData.overall;

  let html=\`
  <div class="bt-kpi-grid">
    <div class="bt-kpi"><div class="bt-kpi-val" style="color:var(--green)">\${d.wins||0}</div><div class="bt-kpi-lbl">Wins</div></div>
    <div class="bt-kpi"><div class="bt-kpi-val" style="color:var(--red)">\${d.losses||0}</div><div class="bt-kpi-lbl">Losses</div></div>
    <div class="bt-kpi"><div class="bt-kpi-val" style="color:var(--pink2)">\${wr}%</div><div class="bt-kpi-lbl">Winrate</div></div>
  </div>

  <div class="bt-score-compare">
    <div class="bt-sc-title">Ø Score bei Wins vs Losses</div>
    <div class="bt-score-row">
      <div class="bt-score-label" style="color:var(--green)">WIN</div>
      <div class="bt-score-bar-bg"><div class="bt-score-bar-fill" style="width:\${o.avg_score_win||0}%;background:var(--green)"></div></div>
      <div class="bt-score-val" style="color:var(--green)">\${o.avg_score_win||0}</div>
    </div>
    <div class="bt-score-row">
      <div class="bt-score-label" style="color:var(--red)">LOSS</div>
      <div class="bt-score-bar-bg"><div class="bt-score-bar-fill" style="width:\${o.avg_score_loss||0}%;background:var(--red)"></div></div>
      <div class="bt-score-val" style="color:var(--red)">\${o.avg_score_loss||0}</div>
    </div>
  </div>\`;

  if(currentBtData.bySymbol&&currentBtData.bySymbol.length) {
    html+=\`<div class="section-card" style="margin-bottom:14px">
      <div class="sc-header"><div class="sc-title">Winrate pro Symbol</div></div>
      <div style="padding:0 4px">
      <table class="sym-table">
        <tr><th>Symbol</th><th>W</th><th>L</th><th>Win%</th><th>Ø Score</th></tr>
        \${currentBtData.bySymbol.map(s=>{
          const cl=(s.wins||0)+(s.losses||0);
          const wr2=cl>0?((s.wins/cl)*100).toFixed(0):0;
          return \`<tr>
            <td><strong>\${s.symbol}</strong></td>
            <td style="color:var(--green)">\${s.wins||0}</td>
            <td style="color:var(--red)">\${s.losses||0}</td>
            <td style="color:var(--pink2);font-family:var(--mono);font-weight:700">\${wr2}%</td>
            <td style="font-family:var(--mono)">\${Number(s.avg_score||0).toFixed(0)}</td>
          </tr>\`;
        }).join('')}
      </table></div>
    </div>\`;
  }

  if(currentBtData.best&&currentBtData.best.length) {
    html+=\`<div class="section-card" style="margin-bottom:14px">
      <div class="sc-header"><div class="sc-title">Beste Signale (WIN)</div></div>
      <div class="sc-body">
        \${currentBtData.best.map(x=>\`<div class="bt-signal-item">
          <div class="bt-sig-left">
            <div class="bt-sig-sym">\${x.symbol} <span style="color:var(--green);font-size:0.65rem">\${x.ai_direction}</span></div>
            <div class="bt-sig-dir">E: \${fmt(x.ai_entry)} → TP: \${fmt(x.ai_take_profit)}</div>
          </div>
          <div class="bt-sig-score" style="color:var(--green)">\${x.ai_score}/100</div>
        </div>\`).join('')}
      </div>
    </div>\`;
  }

  if(currentBtData.worst&&currentBtData.worst.length) {
    html+=\`<div class="section-card">
      <div class="sc-header"><div class="sc-title">Schlechteste Signale (LOSS)</div></div>
      <div class="sc-body">
        \${currentBtData.worst.map(x=>\`<div class="bt-signal-item">
          <div class="bt-sig-left">
            <div class="bt-sig-sym">\${x.symbol} <span style="color:var(--red);font-size:0.65rem">\${x.ai_direction}</span></div>
            <div class="bt-sig-dir">E: \${fmt(x.ai_entry)} · SL: \${fmt(x.ai_stop_loss)}</div>
          </div>
          <div class="bt-sig-score" style="color:var(--red)">\${x.ai_score}/100</div>
        </div>\`).join('')}
      </div>
    </div>\`;
  }

  el.innerHTML=html;
}

// ── TOOLS ──
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

// ── COPY ──
function copyCmd(cmd) {
  navigator.clipboard.writeText(cmd).then(()=>showToast('Kopiert: '+cmd));
}

// ── INIT ──
if(!checkAuth()) {
  // Show login page (already visible by default)
}
</script>
</body>
</html>`;
}
