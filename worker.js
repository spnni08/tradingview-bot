export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Checklist Routes
    if (request.method === "POST" && url.pathname === "/checklist") {
      if (secret !== env.WEBHOOK_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const body = await request.json();
      const { date, user, type, data, id: customId } = body;
      if (!date || !type || !data) return Response.json({ error: "Missing fields" }, { status: 400 });
      // Trades get unique IDs (multiple per day), others use date+type
      let id;
      if (customId) {
        id = customId; // editing existing trade
      } else if (type === "trade") {
        id = date + "_trade_" + (user || "default") + "_" + Date.now();
      } else {
        id = date + "_" + type + "_" + (user || "default");
      }
      await env.DB.prepare(
        `INSERT OR REPLACE INTO checklists (id, date, user, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(id, date, user || "default", type, JSON.stringify(data), Date.now()).run();
      return Response.json({ status: "ok", id });
    }

    if (request.method === "GET" && url.pathname === "/checklist") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      const user = url.searchParams.get("user") || "default";
      const rows = await env.DB.prepare(
        `SELECT * FROM checklists WHERE date = ? AND user = ? ORDER BY created_at ASC`
      ).bind(date, user).all();
      return Response.json(rows.results || []);
    }

    if (request.method === "GET" && url.pathname === "/checklist/history") {
      const user = url.searchParams.get("user") || "default";
      const rows = await env.DB.prepare(
        `SELECT date, type, data FROM checklists WHERE user = ? ORDER BY date DESC, type ASC LIMIT 60`
      ).bind(user).all();
      return Response.json(rows.results || []);
    }

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

    if (request.method === "GET" && url.pathname === "/analytics") {
      return Response.json(await getAnalytics(env));
    }

    if (request.method === "GET" && url.pathname === "/checklist") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0,10);
      const rows = await env.DB.prepare(
        "SELECT * FROM checklists WHERE date = ?"
      ).bind(date).all();
      return Response.json(rows.results?.[0] || { date, data: null });
    }

    if (request.method === "POST" && url.pathname === "/checklist") {
      if (!isAuth) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const body = await request.json();
      const date = body.date || new Date().toISOString().slice(0,10);
      await env.DB.prepare(
        "INSERT INTO checklists (date, user, data, updated_at) VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET data=excluded.data, user=excluded.user, updated_at=excluded.updated_at"
      ).bind(date, body.user || "unknown", JSON.stringify(body.data), Date.now()).run();
      return Response.json({ status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/checklist/history") {
      const rows = await env.DB.prepare(
        "SELECT date, user, data, updated_at FROM checklists ORDER BY date DESC LIMIT 30"
      ).all();
      return Response.json(rows.results || []);
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
      const exitPrice = url.searchParams.get("exit_price") ? Number(url.searchParams.get("exit_price")) : null;
      if (!id || !["WIN","LOSS","OPEN","SKIPPED"].includes(outcome)) {
        return Response.json({ error: "Missing or invalid id/outcome" }, { status: 400 });
      }
      await setOutcome(env, id, outcome, exitPrice);
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
      if (signal.event_type === "SNAPSHOT" || signal.type === "SNAPSHOT") {
        await saveSnapshot(env, signal);
        return Response.json({
          status: "ok",
          type: "snapshot_saved",
          symbol: signal.symbol,
          time: signal.time
        });
      }

      // Normalize field names (support both old event_type and new type field)
      if (!signal.event_type && signal.type) signal.event_type = signal.type;
      if (!signal.trigger && signal.type === "SIGNAL") signal.trigger = signal.direction === "LONG" ? "RSI_CROSS_UP_30" : "RSI_CROSS_DOWN_70";

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
    CREATE TABLE IF NOT EXISTS checklists (
      date TEXT PRIMARY KEY,
      user TEXT,
      data TEXT,
      updated_at INTEGER
    )
  \`).run();

  await env.DB.prepare(\`
    CREATE TABLE IF NOT EXISTS checklists (
      id TEXT PRIMARY KEY,
      date TEXT,
      user TEXT,
      type TEXT,
      data TEXT,
      created_at INTEGER
    )
  `).run();

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
      exit_price REAL,
      pnl_pct REAL,
      closed_at INTEGER,
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
  // Migration: add missing columns for older DBs
  const migrations = [
    'ALTER TABLE snapshots ADD COLUMN key TEXT',
    'ALTER TABLE snapshots ADD COLUMN timeframe TEXT',
    'ALTER TABLE snapshots ADD COLUMN symbol TEXT',
    'ALTER TABLE snapshots ADD COLUMN updated_at INTEGER',
    'ALTER TABLE snapshots ADD COLUMN raw_signal TEXT',
    'ALTER TABLE signals ADD COLUMN exit_price REAL',
    'ALTER TABLE signals ADD COLUMN pnl_pct REAL',
    'ALTER TABLE signals ADD COLUMN closed_at INTEGER',
  ];
  for (const sql of migrations) {
    try { await env.DB.prepare(sql).run(); } catch(e) { /* already exists */ }
  }

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

async function setOutcome(env, id, outcome, exitPrice) {
  if (exitPrice) {
    // Calculate P&L
    const sig = await env.DB.prepare(`SELECT ai_entry, ai_direction FROM signals WHERE id = ?`).bind(id).first();
    if (sig) {
      const entry = Number(sig.ai_entry) || 0;
      const dir = sig.ai_direction;
      let pnl = 0;
      if (entry > 0 && exitPrice > 0) {
        pnl = dir === 'LONG'
          ? ((exitPrice - entry) / entry) * 100
          : ((entry - exitPrice) / entry) * 100;
      }
      await env.DB.prepare(
        `UPDATE signals SET outcome=?, exit_price=?, pnl_pct=?, closed_at=? WHERE id=?`
      ).bind(outcome, exitPrice, Number(pnl.toFixed(4)), Date.now(), id).run();
      return;
    }
  }
  await env.DB.prepare(
    `UPDATE signals SET outcome=?, closed_at=? WHERE id=?`
  ).bind(outcome, Date.now(), id).run();
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

// ─── Analytics (P&L, Equity, Filter-Vergleich) ───────────────────────────────

async function getAnalytics(env) {
  try {
    // Alle abgeschlossenen Trades mit P&L
    const trades = await env.DB.prepare(`
      SELECT id, created_at, closed_at, symbol, ai_direction, ai_score,
             ai_recommendation, ai_entry, ai_take_profit, ai_stop_loss,
             exit_price, pnl_pct, outcome, trend, rsi, ema50, ema200,
             support, resistance, wave_bias, trigger
      FROM signals
      WHERE outcome IN ('WIN','LOSS')
      ORDER BY created_at ASC
    `).all();

    const rows = trades.results || [];

    // P&L pro Trade (mit Fallback wenn kein exit_price)
    const tradeList = rows.map(r => {
      let pnl = Number(r.pnl_pct) || 0;
      // Fallback: TP/SL Preis als Exit schätzen
      if (!pnl && r.ai_entry && r.ai_take_profit && r.ai_stop_loss) {
        const entry = Number(r.ai_entry);
        const exitEst = r.outcome === 'WIN'
          ? Number(r.ai_take_profit)
          : Number(r.ai_stop_loss);
        pnl = r.ai_direction === 'LONG'
          ? ((exitEst - entry) / entry) * 100
          : ((entry - exitEst) / entry) * 100;
      }
      return { ...r, pnl_calc: Number(pnl.toFixed(3)) };
    });

    // Equity Kurve (10% pro Trade vom Kapital, kumulativ)
    let equity = 10000;
    const equityCurve = tradeList.map(t => {
      const pnlPct = t.pnl_calc;
      equity = equity * (1 + (pnlPct / 100));
      return {
        date: new Date(t.created_at).toISOString().slice(0,10),
        equity: Number(equity.toFixed(2)),
        symbol: t.symbol,
        outcome: t.outcome,
        pnl: t.pnl_calc
      };
    });

    // Gesamt P&L Stats
    const wins = tradeList.filter(t => t.outcome === 'WIN');
    const losses = tradeList.filter(t => t.outcome === 'LOSS');
    const avgWinPct = wins.length ? wins.reduce((s,t) => s + t.pnl_calc, 0) / wins.length : 0;
    const avgLossPct = losses.length ? losses.reduce((s,t) => s + t.pnl_calc, 0) / losses.length : 0;
    const totalPnl = tradeList.reduce((s,t) => s + t.pnl_calc, 0);
    const profitFactor = losses.length && avgLossPct !== 0
      ? Math.abs(avgWinPct * wins.length / (avgLossPct * losses.length))
      : 0;

    // Max Drawdown
    let peak = 10000, maxDD = 0;
    let runEq = 10000;
    for (const t of tradeList) {
      runEq = runEq * (1 + t.pnl_calc / 100);
      if (runEq > peak) peak = runEq;
      const dd = ((peak - runEq) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    // Filter-Vergleich: Claude empfohlen vs nicht
    const recommended = tradeList.filter(t => t.ai_recommendation === 'RECOMMENDED');
    const notRecommended = tradeList.filter(t => t.ai_recommendation === 'NOT_RECOMMENDED');
    const recWins = recommended.filter(t => t.outcome === 'WIN');
    const nrecWins = notRecommended.filter(t => t.outcome === 'WIN');

    // EMA-Filter Analyse: Long über EMA200 vs darunter
    const longTrades = tradeList.filter(t => t.ai_direction === 'LONG' && t.ai_entry && t.ema200);
    const longWithBias = longTrades.filter(t => Number(t.ai_entry) > Number(t.ema200));
    const longAgainstBias = longTrades.filter(t => Number(t.ai_entry) <= Number(t.ema200));
    const shortTrades = tradeList.filter(t => t.ai_direction === 'SHORT' && t.ai_entry && t.ema200);
    const shortWithBias = shortTrades.filter(t => Number(t.ai_entry) < Number(t.ema200));
    const shortAgainstBias = shortTrades.filter(t => Number(t.ai_entry) >= Number(t.ema200));

    const withBias = [...longWithBias, ...shortWithBias];
    const againstBias = [...longAgainstBias, ...shortAgainstBias];

    function wrOf(arr) {
      const w = arr.filter(t => t.outcome === 'WIN').length;
      return arr.length > 0 ? Number(((w / arr.length) * 100).toFixed(1)) : 0;
    }
    function avgPnlOf(arr) {
      return arr.length > 0 ? Number((arr.reduce((s,t) => s + t.pnl_calc, 0) / arr.length).toFixed(2)) : 0;
    }

    // Score-Buckets: wie performt jede Score-Range
    const buckets = [
      { label: '0–49', min: 0, max: 49 },
      { label: '50–64', min: 50, max: 64 },
      { label: '65–74', min: 65, max: 74 },
      { label: '75–100', min: 75, max: 100 },
    ].map(b => {
      const bTrades = tradeList.filter(t => t.ai_score >= b.min && t.ai_score <= b.max);
      return {
        label: b.label,
        total: bTrades.length,
        wr: wrOf(bTrades),
        avgPnl: avgPnlOf(bTrades)
      };
    });

    return {
      summary: {
        total: tradeList.length,
        wins: wins.length,
        losses: losses.length,
        winrate: tradeList.length > 0 ? Number(((wins.length / tradeList.length) * 100).toFixed(1)) : 0,
        total_pnl_pct: Number(totalPnl.toFixed(2)),
        avg_win_pct: Number(avgWinPct.toFixed(2)),
        avg_loss_pct: Number(avgLossPct.toFixed(2)),
        profit_factor: Number(profitFactor.toFixed(2)),
        max_drawdown_pct: Number(maxDD.toFixed(2)),
        final_equity: Number(equity.toFixed(2))
      },
      equityCurve,
      filters: {
        claude: {
          recommended: { total: recommended.length, wins: recWins.length, wr: wrOf(recommended), avgPnl: avgPnlOf(recommended) },
          not_recommended: { total: notRecommended.length, wins: nrecWins.length, wr: wrOf(notRecommended), avgPnl: avgPnlOf(notRecommended) }
        },
        ema_bias: {
          with_bias: { total: withBias.length, wr: wrOf(withBias), avgPnl: avgPnlOf(withBias) },
          against_bias: { total: againstBias.length, wr: wrOf(againstBias), avgPnl: avgPnlOf(againstBias) }
        },
        score_buckets: buckets
      },
      recentTrades: tradeList.slice(-20).reverse().map(t => ({
        date: new Date(t.created_at).toISOString().slice(0,10),
        symbol: t.symbol,
        direction: t.ai_direction,
        score: t.ai_score,
        outcome: t.outcome,
        pnl: t.pnl_calc,
        recommended: t.ai_recommendation === 'RECOMMENDED'
      }))
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
        // P&L berechnen
        const pnlPct2 = direction === 'LONG'
          ? ((price - entry) / entry) * 100
          : ((entry - price) / entry) * 100;

        // In DB updaten mit Exit-Preis und P&L
        await env.DB.prepare(
          `UPDATE signals SET outcome=?, exit_price=?, pnl_pct=?, closed_at=? WHERE id=?`
        ).bind(outcome, price, Number(pnlPct2.toFixed(4)), Date.now(), sig.id).run();

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
  return "<!doctype html>\n<html lang=\"de\" data-theme=\"dark\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1\">\n<title>WAVESCOUT</title>\n<style>\n[data-theme=dark]{--bg:#07101f;--bg2:#0a1628;--bg3:#0e1e38;--card:#101e35;--card2:#132440;--border:#1c3055;--border2:#24406e;--blue:#2563eb;--blue2:#3b7bff;--blue3:#60a5fa;--dim:rgba(37,99,235,.1);--gr:#10b981;--rd:#f43f5e;--am:#f59e0b;--t1:#f1f8ff;--t2:#c8daf0;--t3:#6b8cac}\n[data-theme=light]{--bg:#f5f7fa;--bg2:#edf0f5;--bg3:#e2e8f0;--card:#fff;--card2:#f8fafc;--border:#dde5f0;--border2:#c5d3e8;--blue:#1d4ed8;--blue2:#2563eb;--blue3:#3b82f6;--dim:rgba(37,99,235,.07);--gr:#059669;--rd:#e11d48;--am:#d97706;--t1:#0f172a;--t2:#334155;--t3:#64748b}\n*{box-sizing:border-box;margin:0;padding:0}\nhtml,body{height:100%;font-family:system-ui,sans-serif;background:var(--bg);color:var(--t2)}\n#ls{position:fixed;inset:0;z-index:500;background:var(--bg);display:flex;align-items:center;justify-content:center;padding:20px}\n#ls.gone{display:none!important}\n.lc{width:100%;max-width:400px;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:32px 28px}\n.lh{text-align:center;margin-bottom:24px}\n.ll{width:48px;height:48px;border-radius:12px;margin:0 auto 12px;display:block}\n.lb{font-size:1.35rem;font-weight:700;color:var(--t1);margin-bottom:2px}\n.ls2{font-size:.78rem;color:var(--t3)}\n.lul{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--t3);margin-bottom:10px}\n.lug{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:16px}\n.lu{border:2px solid var(--border);border-radius:11px;padding:14px 6px;cursor:pointer;text-align:center;background:var(--card2);transition:all .15s;font-family:system-ui,sans-serif;width:100%;display:flex;flex-direction:column;align-items:center}\n.lu:hover{border-color:var(--blue3)}.lu.sel{border-color:var(--blue2);background:var(--dim)}\n.lav{width:36px;height:36px;border-radius:50%;margin:0 auto 7px;display:flex;align-items:center;justify-content:center;font-size:.88rem;font-weight:700;color:#fff}\n.av-M{background:linear-gradient(135deg,#1e40af,#3b82f6)}.av-S{background:linear-gradient(135deg,#0369a1,#2563eb)}.av-I{background:linear-gradient(135deg,#065f46,#059669)}\n.lun{font-size:.75rem;font-weight:600;color:var(--t1)}\n.lft{text-align:center;margin-top:16px}.lft p{font-size:.62rem;color:var(--t3);line-height:2}.lft strong{color:var(--blue3);font-weight:600}\nheader{position:sticky;top:0;z-index:100;height:54px;background:var(--card);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 18px;gap:10px}\n.hl{display:flex;align-items:center;gap:8px;flex-shrink:0;margin-right:12px}\n.hli{width:28px;height:28px;border-radius:7px}.hln{font-size:.88rem;font-weight:700;color:var(--t1)}.htg{font-size:.52rem;font-weight:600;text-transform:uppercase;color:var(--blue3);background:var(--dim);border:1px solid rgba(96,165,250,.2);padding:2px 6px;border-radius:4px}\n.hdiv{width:1px;height:20px;background:var(--border);flex-shrink:0}\nnav{display:flex;gap:1px;flex:1;overflow-x:auto;scrollbar-width:none}\nnav::-webkit-scrollbar{display:none}\n.nb{padding:6px 11px;border-radius:7px;font-size:.75rem;font-weight:500;color:var(--t3);border:none;background:none;cursor:pointer;white-space:nowrap;font-family:system-ui,sans-serif}\n.nb:hover{color:var(--t2);background:var(--bg2)}.nb.on{color:var(--blue2);background:var(--dim);font-weight:600}\n.hr{display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0}\n.hclk{font-family:monospace;font-size:.62rem;color:var(--t3)}\n.hli2{display:flex;align-items:center;gap:4px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.18);padding:3px 8px;border-radius:20px;font-size:.6rem;font-weight:600;color:var(--gr)}\n.hldot{width:5px;height:5px;border-radius:50%;background:var(--gr);animation:pulse 2s infinite}\n@keyframes pulse{0%,100%{opacity:1}60%{opacity:.5}}\n.tbtn{width:30px;height:30px;border-radius:7px;border:1px solid var(--border);background:var(--bg2);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.88rem}\n.uchip{display:flex;align-items:center;gap:6px;padding:4px 9px 4px 4px;border-radius:20px;border:1px solid var(--border);background:var(--card2);cursor:pointer}\n.uchip:hover{background:var(--bg2)}.uav{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.62rem;font-weight:700;color:#fff;flex-shrink:0}.uname{font-size:.7rem;font-weight:600;color:var(--t1)}\n.page{display:none;padding:20px 18px;max-width:920px;margin:0 auto}.page.on{display:block}\n.ph{margin-bottom:22px}.pt{font-size:1.3rem;font-weight:700;color:var(--t1)}.pt em{color:var(--blue3);font-style:normal}.ps{font-size:.78rem;color:var(--t3);margin-top:3px;line-height:1.5}\n.eban{background:var(--dim);border:1px solid rgba(37,99,235,.2);border-radius:14px;padding:16px 18px;margin-bottom:20px;display:flex;align-items:flex-start;gap:12px}\n.eban-t{font-size:.88rem;font-weight:700;color:var(--t1);margin-bottom:3px}.eban-tx{font-size:.75rem;color:var(--t3);line-height:1.6}\n.eban-steps{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.eban-step{display:flex;align-items:center;gap:5px;font-size:.68rem;color:var(--t2);background:var(--card);border:1px solid var(--border);border-radius:20px;padding:3px 9px}\n.eban-n{width:16px;height:16px;border-radius:50%;background:var(--blue);color:#fff;font-size:.58rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}\n.krow{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px}\n.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 14px;position:relative;overflow:hidden}\n.kpi::before{content:\"\";position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}\n.kb::before{background:linear-gradient(90deg,var(--blue),var(--blue3))}.kg::before{background:var(--gr)}.kr::before{background:var(--rd)}.kw::before{background:var(--border2)}\n.kpi-ic{font-size:1.1rem;margin-bottom:6px}.kpi-lbl{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--t3);margin-bottom:5px}\n.kpi-val{font-family:monospace;font-size:1.85rem;font-weight:700;line-height:1;color:var(--t1)}.vb{color:var(--blue3)}.vg{color:var(--gr)}.vr{color:var(--rd)}\n.kpi-desc{font-size:.6rem;color:var(--t3);margin-top:4px}\n.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}\n.card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}\n.ch{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid var(--border)}\n.ct{font-size:.8rem;font-weight:600;color:var(--t1)}.cs{font-size:.65rem;color:var(--t3);margin-top:1px}.cb{padding:14px 16px}\n.qa-list{display:flex;flex-direction:column;gap:7px}\n.qa{display:flex;align-items:center;gap:12px;padding:11px 14px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;cursor:pointer;transition:all .15s;font-family:system-ui,sans-serif;text-align:left;width:100%}\n.qa:hover{background:var(--dim);border-color:var(--blue3)}.qa-ic{font-size:1.1rem;width:32px;height:32px;border-radius:8px;background:var(--card);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0}\n.qa-info{flex:1;text-align:left}.qa-lbl{font-size:.78rem;font-weight:600;color:var(--t1)}.qa-desc{font-size:.63rem;color:var(--t3);margin-top:1px}.qa-arr{color:var(--t3);font-size:.75rem;flex-shrink:0}\n.rs{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)}.rs:last-child{border-bottom:none;padding-bottom:0}\n.rs-dp{width:30px;height:30px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:.65rem;font-weight:700;flex-shrink:0}\n.dp-L{background:rgba(16,185,129,.12);color:var(--gr);border:1px solid rgba(16,185,129,.2)}.dp-S{background:rgba(244,63,94,.12);color:var(--rd);border:1px solid rgba(244,63,94,.2)}\n.rs-sym{font-size:.82rem;font-weight:700;color:var(--t1)}.rs-sub{font-size:.62rem;color:var(--t3);font-family:monospace;margin-top:1px}\n.rs-sc{font-family:monospace;font-size:.78rem;font-weight:500}.rs-age{font-size:.58rem;color:var(--t3);margin-top:1px}\n.wbl{display:flex;align-items:center;gap:12px;padding:15px 16px;border-radius:12px;background:var(--card);border:1px solid var(--border);text-decoration:none;color:inherit;transition:all .15s}\n.wbl:hover{border-color:var(--blue3)}.wbl-ic{font-size:1.7rem;flex-shrink:0}.wbl-t{font-size:.88rem;font-weight:700;color:var(--t1)}.wbl-s{font-size:.65rem;color:var(--t3);margin-top:2px}\n.wbl-btn{margin-left:auto;background:var(--blue);color:#fff;font-size:.65rem;font-weight:600;padding:5px 12px;border-radius:20px;flex-shrink:0}\n.snap{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:12px 14px;display:flex;align-items:center;gap:11px;margin-bottom:7px}\n.snap-sym{font-size:.86rem;font-weight:700;color:var(--t1)}.snap-meta{font-family:monospace;font-size:.6rem;color:var(--t3);margin-top:2px}.snap-px{font-family:monospace;font-size:.85rem;font-weight:500;color:var(--blue3);white-space:nowrap}\n.res{background:var(--card2);border:1px solid var(--border2);border-radius:11px;overflow:hidden;margin-bottom:7px;animation:fd .2s ease}\n@keyframes fd{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}\n.res-top{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border)}\n.rbadge{font-size:.68rem;font-weight:700;padding:3px 9px;border-radius:20px}.ry{background:rgba(16,185,129,.12);color:var(--gr)}.rn{background:rgba(244,63,94,.12);color:var(--rd)}\n.res-bd{padding:12px 14px;display:flex;flex-direction:column;gap:8px}\n.rr{display:flex;justify-content:space-between;align-items:center}.rk{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--t3)}.rv{font-family:monospace;font-size:.76rem;color:var(--t2)}\n.rplan{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px}.rpc{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:9px;text-align:center}\n.rpl{font-size:.55rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--t3)}.rpv{font-family:monospace;font-size:.78rem;font-weight:700;margin-top:3px}\n.rreason{font-size:.72rem;color:var(--t3);line-height:1.65;padding-top:8px;border-top:1px solid var(--border)}\n.bar{height:3px;background:var(--bg3);border-radius:99px;overflow:hidden}.bar-f{height:100%;border-radius:99px}\n.frow{display:flex;gap:7px;margin-bottom:12px;flex-wrap:wrap}\n.fsel{flex:1;min-width:95px;padding:7px 11px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui,sans-serif;font-size:.74rem;outline:none;cursor:pointer}\n.fpill{padding:6px 13px;background:var(--card);border:1px solid var(--border);border-radius:20px;color:var(--t3);font-family:system-ui,sans-serif;font-size:.7rem;font-weight:500;cursor:pointer;white-space:nowrap}\n.fpill.on{background:var(--dim);border-color:var(--blue3);color:var(--blue2);font-weight:600}\n.sc{background:var(--card);border:1px solid var(--border);border-radius:11px;padding:14px 16px;margin-bottom:7px}\n.sc-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:9px}.sc-sym{font-size:.88rem;font-weight:700;color:var(--t1)}\n.sc-dp{font-size:.62rem;font-weight:600;padding:2px 7px;border-radius:20px;margin-top:3px;display:inline-block}\n.dp-long{background:rgba(16,185,129,.1);color:var(--gr)}.dp-short{background:rgba(244,63,94,.1);color:var(--rd)}\n.sc-score{font-family:monospace;font-size:.88rem;font-weight:500}.sc-age{font-size:.58rem;color:var(--t3);margin-top:2px}\n.sc-px{font-family:monospace;font-size:.64rem;color:var(--t3);display:flex;gap:12px;margin-bottom:8px}\n.sc-ft{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:7px;margin-top:8px}\n.tgs{display:flex;gap:4px;flex-wrap:wrap}.tg{font-size:.6rem;font-weight:600;padding:3px 7px;border-radius:20px}\n.tw{background:rgba(16,185,129,.1);color:var(--gr);border:1px solid rgba(16,185,129,.18)}.to{background:var(--dim);color:var(--blue3);border:1px solid rgba(59,123,255,.18)}\n.tl{background:rgba(244,63,94,.1);color:var(--rd);border:1px solid rgba(244,63,94,.18)}.tsk{background:var(--bg2);color:var(--t3);border:1px solid var(--border)}\n.tr{background:rgba(16,185,129,.08);color:var(--gr)}.tnr{background:rgba(244,63,94,.08);color:var(--rd)}\n.tlo{background:rgba(16,185,129,.08);color:var(--gr)}.tmd{background:rgba(245,158,11,.08);color:var(--am)}.thi{background:rgba(244,63,94,.08);color:var(--rd)}\n.obt{display:flex;gap:5px}.ob{font-family:system-ui,sans-serif;font-size:.66rem;font-weight:600;padding:5px 9px;border-radius:7px;cursor:pointer;border:1px solid}\n.obw{background:rgba(16,185,129,.1);color:var(--gr);border-color:rgba(16,185,129,.25)}.obl{background:rgba(244,63,94,.1);color:var(--rd);border-color:rgba(244,63,94,.25)}.obs{background:var(--bg2);color:var(--t3);border-color:var(--border)}\n.bt-tabs{display:flex;gap:5px;margin-bottom:16px}.bttab{padding:6px 16px;background:var(--card);border:1px solid var(--border);border-radius:20px;color:var(--t3);font-family:system-ui,sans-serif;font-size:.72rem;font-weight:500;cursor:pointer}\n.bttab.on{background:var(--blue);border-color:var(--blue);color:#fff;font-weight:600}\n.bt-ks{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px}.btk{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}\n.btkv{font-family:monospace;font-size:1.5rem;font-weight:700;line-height:1}.btkl{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);margin-top:6px}\n.str{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:10px}\n.strh{display:flex;align-items:center;gap:9px;padding:13px 16px;border-bottom:1px solid var(--border);background:var(--card2)}.strhi{font-size:.95rem}.strt{font-size:.82rem;font-weight:700;color:var(--t1)}.strb{padding:14px 16px}\n.step{display:flex;gap:11px;margin-bottom:13px}.step:last-child{margin-bottom:0}\n.stn{width:22px;height:22px;border-radius:50%;background:var(--dim);border:1px solid rgba(59,123,255,.25);color:var(--blue3);font-size:.62rem;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}\n.stit{font-size:.78rem;font-weight:700;color:var(--t1);margin-bottom:3px}.sttx{font-size:.74rem;line-height:1.65;color:var(--t3)}\n.srul{display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)}.srul:last-child{border-bottom:none}\n.sruli{width:17px;flex-shrink:0;font-size:.8rem;margin-top:1px}.srult{font-size:.74rem;color:var(--t3);line-height:1.55}\n.nol{display:flex;flex-direction:column;gap:6px}.noi{display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(244,63,94,.04);border:1px solid rgba(244,63,94,.1);border-radius:8px;font-size:.74rem;color:var(--t3)}\n.tlg{margin-bottom:14px}.tlgl{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);margin-bottom:7px;padding:0 2px}\n.tll{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}.tlr{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s;text-decoration:none;color:inherit}\n.tlr:last-child{border-bottom:none}.tlr:hover{background:var(--bg2)}.tlri{font-size:1rem;width:24px;flex-shrink:0}.tlrtx{flex:1}.tlrl{font-size:.78rem;font-weight:600;color:var(--t1)}.tlrd{font-size:.63rem;color:var(--t3);margin-top:1px}.tlra{color:var(--t3);font-size:.72rem}\n.cmdi{font-size:.76rem;color:var(--t3);line-height:1.65;margin-bottom:14px;padding:13px 15px;background:var(--dim);border:1px solid rgba(37,99,235,.15);border-radius:9px}\n.cmdg{display:flex;flex-direction:column;gap:5px}.cmdr{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:var(--card);border:1px solid var(--border);border-radius:9px;cursor:pointer;transition:all .12s}\n.cmdr:hover{background:var(--card2);border-color:var(--border2)}.cmdc{font-family:monospace;font-size:.8rem;color:var(--blue3);font-weight:500}.cmdd{font-size:.66rem;color:var(--t3);margin-top:2px}\n.btn{font-family:system-ui,sans-serif;font-weight:600;font-size:.74rem;border:none;border-radius:8px;padding:7px 13px;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:5px}\n.btn-p{background:var(--blue);color:#fff}.btn-p:hover{background:var(--blue2)}.btn-g{background:var(--bg2);border:1px solid var(--border);color:var(--t3);font-size:.68rem;padding:5px 11px}.btn-g:hover{background:var(--bg3)}\n.sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px}.sl{font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--t3)}\n.empty{text-align:center;padding:32px 20px;color:var(--t3)}.empty p{font-size:.8rem;line-height:1.7}\n.stbl{width:100%;border-collapse:collapse;font-size:.74rem}.stbl th{text-align:left;padding:8px 10px;font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--t3);border-bottom:1px solid var(--border)}.stbl td{padding:9px 10px;border-bottom:1px solid var(--border)}.stbl tr:last-child td{border-bottom:none}\n.bsr{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)}.bsr:last-child{border-bottom:none;padding-bottom:0}\n.bsr-sym{font-size:.8rem;font-weight:700;color:var(--t1)}.bsr-sub{font-size:.62rem;color:var(--t3);font-family:monospace;margin-top:1px}.bsr-sc{font-family:monospace;font-size:.88rem;font-weight:500}\n.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--t1);color:var(--bg);font-size:.74rem;font-weight:500;padding:9px 18px;border-radius:20px;z-index:9999;pointer-events:none;opacity:0;transition:opacity .2s;white-space:nowrap;max-width:92vw}\n.toast.on{opacity:1}\n@media(max-width:640px){.page{padding:14px 13px}.krow{grid-template-columns:repeat(2,1fr)}.g2{grid-template-columns:1fr}.hclk,.htg,.uname{display:none}.nb{font-size:.7rem;padding:5px 8px}.bnv{display:flex!important}body{padding-bottom:58px}}\n.bnv{display:none;position:fixed;bottom:0;left:0;right:0;z-index:100;background:var(--card);border-top:1px solid var(--border);padding:5px 0 max(5px,env(safe-area-inset-bottom))}\n@media(max-width:640px){.bnv{display:flex}}\n.bn{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;padding:5px 0;font-size:.54rem;font-weight:600;color:var(--t3);border:none;background:none;font-family:system-ui,sans-serif}.bn.on{color:var(--blue2)}.bn-ic{font-size:1.1rem}\n\n.cl-list{display:flex;flex-direction:column;gap:6px}\n.cl-item{display:flex;align-items:flex-start;gap:10px;padding:9px 12px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all .12s}\n.cl-item:hover{background:var(--dim);border-color:var(--blue3)}\n.cl-item.checked{background:rgba(16,185,129,.06);border-color:rgba(16,185,129,.2)}\n.cl-cb{font-size:1rem;flex-shrink:0;transition:all .12s;margin-top:1px}\n.cl-label{font-size:.74rem;color:var(--t2);line-height:1.5}\n.cl-item.checked .cl-label{color:var(--t3);text-decoration:line-through}\n.cl-outcome-btn.sel-win{border-color:var(--gr)!important;background:rgba(16,185,129,.15)!important}\n.cl-outcome-btn.sel-loss{border-color:var(--rd)!important;background:rgba(244,63,94,.15)!important}\n.tab-bar{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:12px}\n.tab-btn{padding:6px 14px;border-radius:8px;font-size:.76rem;font-weight:500;color:var(--t3);border:none;background:none;cursor:pointer;font-family:system-ui;transition:all .12s;white-space:nowrap}\n.tab-btn:hover{color:var(--t2);background:var(--bg2)}\n.tab-btn.on{background:var(--dim);color:var(--blue2);font-weight:600;border:1px solid rgba(37,99,235,.2)}\n.tab-pane{display:none}.tab-pane.on{display:block}\n</style>\n</head>\n<body>\n<div id=\"ls\">\n  <div class=\"lc\">\n    <div class=\"lh\">\n      <img src=\"data:image/svg+xml;charset=utf-8,%3Csvg%20viewBox%3D%220%200%2080%2080%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%25%22%20y1%3D%22100%25%22%20x2%3D%22100%25%22%20y2%3D%220%25%22%3E%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%231e40af%22/%3E%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%233b82f6%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20rx%3D%2218%22%20fill%3D%22%230f172a%22/%3E%3Cg%20stroke%3D%22url%28%23g%29%22%20stroke-width%3D%222.6%22%20fill%3D%22none%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cline%20x1%3D%2240%22%20y1%3D%2247%22%20x2%3D%2240%22%20y2%3D%2263%22/%3E%3Crect%20x%3D%2231%22%20y%3D%2263%22%20width%3D%2218%22%20height%3D%225%22%20rx%3D%222.5%22/%3E%3Ccircle%20cx%3D%2240%22%20cy%3D%2243%22%20r%3D%224%22%20fill%3D%22url%28%23g%29%22%20stroke%3D%22none%22/%3E%3Cpath%20d%3D%22M29%2037%20C23%2031%2023%2021%2026%2015%22/%3E%3Cpath%20d%3D%22M51%2037%20C57%2031%2057%2021%2054%2015%22/%3E%3Cpath%20d%3D%22M34%2040%20C30%2035%2030%2028%2032%2023%22/%3E%3Cpath%20d%3D%22M46%2040%20C50%2035%2050%2028%2048%2023%22/%3E%3Cpath%20d%3D%22M37.5%2042%20C35%2039%2035%2035%2037%2032%22/%3E%3Cpath%20d%3D%22M42.5%2042%20C45%2039%2045%2035%2043%2032%22/%3E%3C/g%3E%3C/svg%3E\" class=\"ll\" alt=\"\">\n      <div class=\"lb\">WAVESCOUT</div>\n      <div class=\"ls2\">Trading Signal Dashboard</div>\n    </div>\n    <div class=\"lul\">Wer bist du?</div>\n    <div class=\"lug\">\n      <button class=\"lu\" type=\"button\" id=\"btn-Marvin\"><div class=\"lav av-M\">M</div><div class=\"lun\">Marvin</div></button>\n      <button class=\"lu\" type=\"button\" id=\"btn-Sandro\"><div class=\"lav av-S\">S</div><div class=\"lun\">Sandro</div></button>\n      <button class=\"lu\" type=\"button\" id=\"btn-Iven\"><div class=\"lav av-I\">I</div><div class=\"lun\">Iven</div></button>\n    </div>\n    <div class=\"lft\"><p>Made by <strong>WaveWatch</strong> &middot; Made for Trader</p></div>\n  </div>\n</div>\n<header>\n  <div class=\"hl\"><img src=\"data:image/svg+xml;charset=utf-8,%3Csvg%20viewBox%3D%220%200%2080%2080%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%25%22%20y1%3D%22100%25%22%20x2%3D%22100%25%22%20y2%3D%220%25%22%3E%3Cstop%20offset%3D%220%25%22%20stop-color%3D%22%231e40af%22/%3E%3Cstop%20offset%3D%22100%25%22%20stop-color%3D%22%233b82f6%22/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect%20width%3D%2280%22%20height%3D%2280%22%20rx%3D%2218%22%20fill%3D%22%230f172a%22/%3E%3Cg%20stroke%3D%22url%28%23g%29%22%20stroke-width%3D%222.6%22%20fill%3D%22none%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cline%20x1%3D%2240%22%20y1%3D%2247%22%20x2%3D%2240%22%20y2%3D%2263%22/%3E%3Crect%20x%3D%2231%22%20y%3D%2263%22%20width%3D%2218%22%20height%3D%225%22%20rx%3D%222.5%22/%3E%3Ccircle%20cx%3D%2240%22%20cy%3D%2243%22%20r%3D%224%22%20fill%3D%22url%28%23g%29%22%20stroke%3D%22none%22/%3E%3Cpath%20d%3D%22M29%2037%20C23%2031%2023%2021%2026%2015%22/%3E%3Cpath%20d%3D%22M51%2037%20C57%2031%2057%2021%2054%2015%22/%3E%3Cpath%20d%3D%22M34%2040%20C30%2035%2030%2028%2032%2023%22/%3E%3Cpath%20d%3D%22M46%2040%20C50%2035%2050%2028%2048%2023%22/%3E%3Cpath%20d%3D%22M37.5%2042%20C35%2039%2035%2035%2037%2032%22/%3E%3Cpath%20d%3D%22M42.5%2042%20C45%2039%2045%2035%2043%2032%22/%3E%3C/g%3E%3C/svg%3E\" class=\"hli\" alt=\"\"><span class=\"hln\">WAVESCOUT</span><span class=\"htg\">v3</span></div>\n  <div class=\"hdiv\"></div>\n  <nav>\n    <button class=\"nb on\" id=\"nb-home\" data-page=\"home\">Home</button>\n    <button class=\"nb\" id=\"nb-analyse\" data-page=\"analyse\">Analyse</button>\n    <button class=\"nb\" id=\"nb-signals\" data-page=\"signals\">Signale</button>\n    <button class=\"nb\" id=\"nb-bt\" data-page=\"bt\">Backtesting</button>\n    <button class=\"nb\" id=\"nb-str\" data-page=\"str\">Strategie</button>\n    <button class=\"nb\" id=\"nb-tools\" data-page=\"tools\">Tools</button>\n    <button class=\"nb\" id=\"nb-tg\" data-page=\"tg\">Telegram</button>\n    <button class=\"nb\" id=\"nb-cl\" data-page=\"cl\">Checkliste</button>\n  </nav>\n  <div class=\"hr\">\n    <div class=\"hclk\" id=\"clk\">--:--:--</div>\n    <div class=\"hli2\"><div class=\"hldot\"></div>Live</div>\n    <button class=\"tbtn\" id=\"thbtn\" type=\"button\">&#127769;</button>\n    <div class=\"uchip\" id=\"logout-btn\">\n      <div class=\"uav\" id=\"uav\" style=\"background:linear-gradient(135deg,#1e40af,#3b82f6)\">?</div>\n      <span class=\"uname\" id=\"uname\">-</span>\n      <span style=\"font-size:.6rem;color:var(--t3);margin-left:2px\">&#x2715;</span>\n    </div>\n  </div>\n</header>\n<div class=\"page on\" id=\"pg-home\">\n  <div class=\"ph\"><div class=\"pt\" id=\"htitle\">Guten Morgen, <em>Trader</em></div><div class=\"ps\" id=\"hdate\">-</div></div>\n  <div class=\"eban\">\n    <div style=\"font-size:1.4rem;flex-shrink:0\">&#128161;</div>\n    <div>\n      <div class=\"eban-t\">Wie funktioniert WAVESCOUT?</div>\n      <div class=\"eban-tx\">TradingView erkennt Signale automatisch und schickt sie hierher. Claude analysiert sie und du bekommst eine Telegram-Nachricht.</div>\n      <div class=\"eban-steps\">\n        <div class=\"eban-step\"><div class=\"eban-n\">1</div>Signal erkannt</div>\n        <div class=\"eban-step\"><div class=\"eban-n\">2</div>Claude analysiert</div>\n        <div class=\"eban-step\"><div class=\"eban-n\">3</div>Telegram</div>\n        <div class=\"eban-step\"><div class=\"eban-n\">4</div>Du entscheidest</div>\n      </div>\n    </div>\n  </div>\n  <div class=\"krow\">\n    <div class=\"kpi kb\"><div class=\"kpi-ic\">&#128194;</div><div class=\"kpi-lbl\">Offene Trades</div><div class=\"kpi-val vb\" id=\"k-open\">-</div><div class=\"kpi-desc\">Nicht ausgewertet</div></div>\n    <div class=\"kpi kg\"><div class=\"kpi-ic\">&#9989;</div><div class=\"kpi-lbl\">Wins</div><div class=\"kpi-val vg\" id=\"k-wins\">-</div><div class=\"kpi-desc\">Profitable Trades</div></div>\n    <div class=\"kpi kr\"><div class=\"kpi-ic\">&#10060;</div><div class=\"kpi-lbl\">Losses</div><div class=\"kpi-val vr\" id=\"k-losses\">-</div><div class=\"kpi-desc\">Verluste</div></div>\n    <div class=\"kpi kw\"><div class=\"kpi-ic\">&#127919;</div><div class=\"kpi-lbl\">Winrate</div><div class=\"kpi-val\" id=\"k-wr\" style=\"color:var(--t1)\">-</div><div class=\"kpi-desc\">Trefferquote</div></div>\n  </div>\n  <div class=\"g2\">\n    <div class=\"card\">\n      <div class=\"ch\"><div><div class=\"ct\">Was moechtest du tun?</div><div class=\"cs\">Klicke auf eine Aktion</div></div></div>\n      <div class=\"cb\">\n        <div class=\"qa-list\">\n          <button class=\"qa\" data-page=\"analyse\"><div class=\"qa-ic\">&#128269;</div><div class=\"qa-info\"><div class=\"qa-lbl\">Symbol analysieren</div><div class=\"qa-desc\">Claude prueft den aktuellen Markt</div></div><div class=\"qa-arr\">&#8250;</div></button>\n          <button class=\"qa\" data-ta=\"morning\"><div class=\"qa-ic\">&#127749;</div><div class=\"qa-info\"><div class=\"qa-lbl\">Morning Brief</div><div class=\"qa-desc\">Tages-Bias als Telegram-Nachricht</div></div><div class=\"qa-arr\">&#8250;</div></button>\n          <button class=\"qa\" data-ta=\"outcomes\"><div class=\"qa-ic\">&#128260;</div><div class=\"qa-info\"><div class=\"qa-lbl\">WIN/LOSS aktualisieren</div><div class=\"qa-desc\">Offene Trades automatisch aufloesen</div></div><div class=\"qa-arr\">&#8250;</div></button>\n          <button class=\"qa\" data-page=\"bt\"><div class=\"qa-ic\">&#128202;</div><div class=\"qa-info\"><div class=\"qa-lbl\">Backtesting</div><div class=\"qa-desc\">Winrate und Auswertung</div></div><div class=\"qa-arr\">&#8250;</div></button>\n        </div>\n      </div>\n    </div>\n    <div class=\"card\">\n      <div class=\"ch\"><div class=\"ct\">Letzte Signale</div><button class=\"btn btn-g\" data-page=\"signals\">Alle &#8594;</button></div>\n      <div class=\"cb\" id=\"home-sigs\"><div class=\"empty\"><p>Lade...</p></div></div>\n    </div>\n  </div>\n  <a class=\"wbl\" href=\"https://waveboard-e54ed.web.app/waveboard/dashboard\" target=\"_blank\"><div class=\"wbl-ic\">&#127754;</div><div><div class=\"wbl-t\">WaveBoard oeffnen</div><div class=\"wbl-s\">Externes Trading Dashboard</div></div><div class=\"wbl-btn\">&#8599; Oeffnen</div></a>\n</div>\n<div class=\"page\" id=\"pg-analyse\">\n  <div class=\"ph\"><div class=\"pt\">Analyse</div><div class=\"ps\">Klicke auf Prufen - Claude erstellt eine Analyse des aktuellen Snapshots.</div></div>\n  <div class=\"sh\"><div class=\"sl\">Aktuelle Snapshots</div><button class=\"btn btn-g\" id=\"ref-snaps\">&#8635; Refresh</button></div>\n  <div id=\"snap-list\"><div class=\"empty\"><p>Lade...</p></div></div>\n</div>\n<div class=\"page\" id=\"pg-signals\">\n  <div class=\"ph\"><div class=\"pt\">Signale</div><div class=\"ps\">Alle erkannten Signale. Filtere und markiere als WIN, LOSS oder Skip.</div></div>\n  <div class=\"frow\">\n    <select class=\"fsel\" id=\"fsym\"><option value=\"\">Alle Symbole</option></select>\n    <select class=\"fsel\" id=\"fout\" style=\"flex:.7\"><option value=\"\">Alle Status</option><option value=\"OPEN\">Open</option><option value=\"WIN\">Win</option><option value=\"LOSS\">Loss</option><option value=\"SKIPPED\">Skipped</option></select>\n    <button class=\"fpill on\" id=\"ss\" data-srt=\"score\">Score &#8595;</button>\n    <button class=\"fpill\" id=\"st\" data-srt=\"time\">Neueste</button>\n  </div>\n  <div id=\"sig-list\"><div class=\"empty\"><p>Lade...</p></div></div>\n</div>\n<div class=\"page\" id=\"pg-bt\">\n  <div class=\"ph\"><div class=\"pt\">Backtesting</div><div class=\"ps\">Auswertung aller Trades. Score-Vergleich zeigt ob hohere Scores besser performen.</div></div>\n  <div class=\"bt-tabs\">\n    <button class=\"bttab on\" data-btp=\"analytics\">Auswertung</button>\n    <button class=\"bttab\" data-btp=\"symbol\">Pro Symbol</button>\n  </div>\n  <div id=\"bt-body\"><div class=\"empty\"><p>Lade...</p></div></div>\n</div>\n<div class=\"page\" id=\"pg-str\">\n  <div class=\"ph\"><div class=\"pt\">Strategie</div><div class=\"ps\">Top-Down Daytrading - alle Regeln auf einen Blick.</div></div>\n  <div class=\"str\"><div class=\"strh\"><div class=\"strhi\">&#127919;</div><div class=\"strt\">Der 3-Schritt-Prozess</div></div><div class=\"strb\">\n    <div class=\"step\"><div class=\"stn\">1</div><div><div class=\"stit\">Morgen-Routine (10 Min)</div><div class=\"sttx\">4H Chart oeffnen, EMA200 pruefen. Preis darueber = Long-Bias, darunter = Short-Bias. EMA flach = kein Trade.</div></div></div>\n    <div class=\"step\"><div class=\"stn\">2</div><div><div class=\"stit\">Zonenanalyse (15min)</div><div class=\"sttx\">Warten bis Preis eine Zone erreicht. Higher Low oder Lower High sichtbar. Kein Chaos.</div></div></div>\n    <div class=\"step\"><div class=\"stn\">3</div><div><div class=\"stit\">Entry (5-10min)</div><div class=\"sttx\">Klare Trendkerze, starker Body, wenig Docht. RSI als Filter.</div></div></div>\n  </div></div>\n  <div class=\"str\"><div class=\"strh\"><div class=\"strhi\">&#128207;</div><div class=\"strt\">Entry-Regeln</div></div><div class=\"strb\">\n    <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\">RSI Long: 30-55 steigend. Short: 45-70 fallend.</div></div>\n    <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\">EMA200 (4H): Preis darueber = nur Long. Darunter = nur Short.</div></div>\n    <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\">Trendstruktur: EMA50 ueber EMA200 (Long) oder darunter. Neutral = kein Trade.</div></div>\n    <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\">Zone: Long nah an Support. Short nah an Resistance.</div></div>\n    <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\">R/R: Mindestens 1:1.5. SL logisch unter/ueber Struktur.</div></div>\n  </div></div>\n  <div class=\"str\"><div class=\"strh\"><div class=\"strhi\">&#128683;</div><div class=\"strt\">Kein Trade</div></div><div class=\"strb\"><div class=\"nol\">\n    <div class=\"noi\">&#10060; Gegen Tages-Bias</div>\n    <div class=\"noi\">&#10060; EMA200 flach oder Preis direkt dran</div>\n    <div class=\"noi\">&#10060; Chaos, viele Wicks</div>\n    <div class=\"noi\">&#10060; FOMO</div>\n    <div class=\"noi\">&#10060; RSI extrem</div>\n  </div></div></div>\n</div>\n<div class=\"page\" id=\"pg-tools\">\n  <div class=\"ph\"><div class=\"pt\">Tools</div><div class=\"ps\">Aktionen und externe Links.</div></div>\n  <a class=\"wbl\" href=\"https://waveboard-e54ed.web.app/waveboard/dashboard\" target=\"_blank\" style=\"display:flex;margin-bottom:14px\"><div class=\"wbl-ic\">&#127754;</div><div><div class=\"wbl-t\">WaveBoard Dashboard</div><div class=\"wbl-s\">waveboard-e54ed.web.app</div></div><div class=\"wbl-btn\">&#8599;</div></a>\n  <div class=\"tlg\"><div class=\"tlgl\">System</div><div class=\"tll\">\n    <div class=\"tlr\" data-ta=\"health\"><div class=\"tlri\">&#128154;</div><div class=\"tlrtx\"><div class=\"tlrl\">Health Check</div><div class=\"tlrd\">Worker Status pruefen</div></div><div class=\"tlra\">&#8250;</div></div>\n    <div class=\"tlr\" data-ta=\"telegram\"><div class=\"tlri\">&#128232;</div><div class=\"tlrtx\"><div class=\"tlrl\">Telegram testen</div><div class=\"tlrd\">Test-Nachricht senden</div></div><div class=\"tlra\">&#8250;</div></div>\n    <div class=\"tlr\" data-ta=\"morning\"><div class=\"tlri\">&#127749;</div><div class=\"tlrtx\"><div class=\"tlrl\">Morning Brief</div><div class=\"tlrd\">Tages-Bias fuer alle Symbole</div></div><div class=\"tlra\">&#8250;</div></div>\n    <div class=\"tlr\" data-ta=\"outcomes\"><div class=\"tlri\">&#128260;</div><div class=\"tlrtx\"><div class=\"tlrl\">Outcome Tracking</div><div class=\"tlrd\">WIN/LOSS aktualisieren</div></div><div class=\"tlra\">&#8250;</div></div>\n  </div></div>\n  <div class=\"tlg\"><div class=\"tlgl\">Links</div><div class=\"tll\">\n    <a class=\"tlr\" href=\"https://tradingview.com\" target=\"_blank\"><div class=\"tlri\">&#128202;</div><div class=\"tlrtx\"><div class=\"tlrl\">TradingView</div><div class=\"tlrd\">Charts und Alerts</div></div><div class=\"tlra\">&#8599;</div></a>\n    <a class=\"tlr\" href=\"https://dash.cloudflare.com\" target=\"_blank\"><div class=\"tlri\">&#9729;&#65039;</div><div class=\"tlrtx\"><div class=\"tlrl\">Cloudflare</div><div class=\"tlrd\">Worker und Logs</div></div><div class=\"tlra\">&#8599;</div></a>\n    <a class=\"tlr\" href=\"https://github.com/spnni08/tradingview-bot\" target=\"_blank\"><div class=\"tlri\">&#128025;</div><div class=\"tlrtx\"><div class=\"tlrl\">GitHub</div><div class=\"tlrd\">spnni08/tradingview-bot</div></div><div class=\"tlra\">&#8599;</div></a>\n    <a class=\"tlr\" href=\"https://console.anthropic.com\" target=\"_blank\"><div class=\"tlri\">&#129302;</div><div class=\"tlrtx\"><div class=\"tlrl\">Anthropic Console</div><div class=\"tlrd\">Claude API Keys</div></div><div class=\"tlra\">&#8599;</div></a>\n  </div></div>\n</div>\n<div class=\"page\" id=\"pg-tg\">\n  <div class=\"ph\"><div class=\"pt\">Telegram Kommandos</div><div class=\"ps\">Tippe diese Kommandos an den WAVESCOUT Bot.</div></div>\n  <div class=\"cmdi\">Tipp: Schreibe z.B. /btc in Telegram und bekomme sofort eine Claude-Analyse.</div>\n  <div class=\"cmdg\">\n    <div class=\"cmdr\" data-cp=\"/btc\"><div><div class=\"cmdc\">/btc</div><div class=\"cmdd\">Bitcoin analysieren</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n    <div class=\"cmdr\" data-cp=\"/eth\"><div><div class=\"cmdc\">/eth</div><div class=\"cmdd\">Ethereum analysieren</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n    <div class=\"cmdr\" data-cp=\"/sol\"><div><div class=\"cmdc\">/sol</div><div class=\"cmdd\">Solana analysieren</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n    <div class=\"cmdr\" data-cp=\"/check RENDERUSDT\"><div><div class=\"cmdc\">/check SYMBOL</div><div class=\"cmdd\">Beliebiges Symbol</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n    <div class=\"cmdr\" data-cp=\"/status\"><div><div class=\"cmdc\">/status</div><div class=\"cmdd\">Winrate und Stats</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n    <div class=\"cmdr\" data-cp=\"/brief\"><div><div class=\"cmdc\">/brief</div><div class=\"cmdd\">Morning Brief</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n    <div class=\"cmdr\" data-cp=\"/open\"><div><div class=\"cmdc\">/open</div><div class=\"cmdd\">Offene Trades</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n    <div class=\"cmdr\" data-cp=\"/top\"><div><div class=\"cmdc\">/top</div><div class=\"cmdd\">Beste Signale heute</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n    <div class=\"cmdr\" data-cp=\"/hilfe\"><div><div class=\"cmdc\">/hilfe</div><div class=\"cmdd\">Alle Kommandos</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n  </div>\n</div>\n<nav class=\"bnv\" id=\"bnv\">\n  <button class=\"bn on\" id=\"bn-home\" data-page=\"home\"><span class=\"bn-ic\">&#127968;</span>Home</button>\n  <button class=\"bn\" id=\"bn-analyse\" data-page=\"analyse\"><span class=\"bn-ic\">&#128269;</span>Analyse</button>\n  <button class=\"bn\" id=\"bn-signals\" data-page=\"signals\"><span class=\"bn-ic\">&#128203;</span>Signale</button>\n  <button class=\"bn\" id=\"bn-bt\" data-page=\"bt\"><span class=\"bn-ic\">&#128202;</span>Backtest</button>\n  <button class=\"bn\" id=\"bn-tools\" data-page=\"tools\"><span class=\"bn-ic\">&#128295;</span>Tools</button>\n</nav>\n<div class=\"toast\" id=\"toast\"></div>\n\n<div class=\"page\" id=\"pg-cl\">\n  <div class=\"ph\">\n    <div class=\"pt\">&#128218; Trade Journal</div>\n    <div class=\"ps\">Morgenroutine einmal pro Tag. Pre-Trade und After-Trade fuer jeden einzelnen Trade \u2014 unbegrenzt viele pro Tag.</div>\n  </div>\n\n  <!-- Date picker + controls -->\n  <div style=\"display:flex;gap:8px;margin-bottom:18px;align-items:center;flex-wrap:wrap\">\n    <input type=\"date\" id=\"cl-date\" style=\"padding:7px 11px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.76rem;outline:none;cursor:pointer\">\n    <span style=\"font-size:.7rem;color:var(--t3)\">Nutzer: <strong id=\"cl-user-disp\" style=\"color:var(--blue3)\">-</strong></span>\n    <button class=\"btn btn-g\" id=\"cl-load-btn\">Laden</button>\n    <button class=\"btn btn-g\" id=\"cl-hist-btn\">&#128196; Verlauf</button>\n  </div>\n\n  <!-- MORGEN-ROUTINE (einmal pro Tag) -->\n  <div class=\"card\" style=\"margin-bottom:12px\">\n    <div class=\"ch\" style=\"background:rgba(37,99,235,.06)\">\n      <div><div class=\"ct\">&#127749; Morgen-Routine</div><div class=\"cs\">Einmal am Morgen ausfuellen</div></div>\n      <div id=\"ms-st\" style=\"font-size:.7rem;font-weight:600;color:var(--t3)\">&#9744; Offen</div>\n    </div>\n    <div class=\"cb\">\n      <div class=\"cl-list\" id=\"ms-items\">\n        <div class=\"cl-item\" data-key=\"ema4h\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">EMA200 auf 4H gecheckt und Bias bestimmt (Long / Short / Kein Trade)</span></div>\n        <div class=\"cl-item\" data-key=\"zones\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">1-2 Key-Zonen auf 15min markiert</span></div>\n        <div class=\"cl-item\" data-key=\"ema_ok\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">EMA200 nicht flach (sonst kein Trade heute)</span></div>\n        <div class=\"cl-item\" data-key=\"news\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Keine marktbewegenden News heute</span></div>\n        <div class=\"cl-item\" data-key=\"mind\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Klarer Kopf, kein FOMO, ruhig</span></div>\n      </div>\n      <div style=\"margin-top:10px\">\n        <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px\">Tages-Bias und Notizen</div>\n        <textarea id=\"ms-notes\" placeholder=\"z.B. 4H Bias: LONG ueber EMA200. Key-Zonen bei 78.200 und 79.500.\" style=\"width:100%;padding:9px 11px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.74rem;resize:vertical;min-height:56px;outline:none\"></textarea>\n      </div>\n      <button class=\"btn btn-p\" id=\"ms-save\" style=\"margin-top:8px;width:100%\">Morgen-Routine speichern</button>\n    </div>\n  </div>\n\n  <!-- TRADE LISTE -->\n  <div style=\"display:flex;align-items:center;justify-content:space-between;margin-bottom:10px\">\n    <div style=\"font-size:.8rem;font-weight:700;color:var(--t1)\">&#128200; Trades heute</div>\n    <button class=\"btn btn-p\" id=\"cl-new-trade-btn\">+ Neuer Trade</button>\n  </div>\n  <div id=\"cl-trades-list\"><div class=\"empty\"><p>Noch keine Trades heute.<br>Klicke auf \"Neuer Trade\" um zu beginnen.</p></div></div>\n\n  <!-- NEW TRADE FORM (hidden by default) -->\n  <div id=\"cl-trade-form\" style=\"display:none;margin-top:4px\">\n    <div class=\"card\" style=\"border:2px solid var(--blue2)\">\n      <div class=\"ch\" style=\"background:var(--dim)\">\n        <div><div class=\"ct\" id=\"cl-form-title\">Neuer Trade</div><div class=\"cs\" id=\"cl-form-time\" style=\"font-family:monospace\">-</div></div>\n        <button class=\"btn btn-g\" id=\"cl-form-cancel\" style=\"font-size:.65rem;padding:4px 9px\">Abbrechen</button>\n      </div>\n      <div class=\"cb\">\n\n        <!-- Trade Info -->\n        <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px\">\n          <div>\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Symbol *</div>\n            <input type=\"text\" id=\"tf-symbol\" placeholder=\"z.B. BTCUSDT\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t1);font-family:monospace;font-size:.82rem;font-weight:600;outline:none\" oninput=\"this.value=this.value.toUpperCase()\">\n          </div>\n          <div>\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Richtung *</div>\n            <div style=\"display:flex;gap:6px\">\n              <button class=\"btn tf-dir-btn\" data-dir=\"LONG\" id=\"tf-long\" style=\"flex:1;border:2px solid rgba(16,185,129,.3);background:rgba(16,185,129,.06);color:var(--gr);font-weight:700\">&#8593; LONG</button>\n              <button class=\"btn tf-dir-btn\" data-dir=\"SHORT\" id=\"tf-short\" style=\"flex:1;border:2px solid rgba(244,63,94,.3);background:rgba(244,63,94,.06);color:var(--rd);font-weight:700\">&#8595; SHORT</button>\n            </div>\n          </div>\n          <div>\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Timeframe</div>\n            <input type=\"text\" id=\"tf-timeframe\" placeholder=\"5m / 15m / 1H\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.78rem;outline:none\">\n          </div>\n          <div>\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Uhrzeit</div>\n            <input type=\"time\" id=\"tf-time\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.78rem;outline:none\">\n          </div>\n          <div>\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Entry Preis</div>\n            <input type=\"number\" id=\"tf-entry\" placeholder=\"0.00\" step=\"any\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t2);font-family:monospace;font-size:.82rem;outline:none\">\n          </div>\n          <div>\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Take Profit</div>\n            <input type=\"number\" id=\"tf-tp\" placeholder=\"0.00\" step=\"any\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--gr);font-family:monospace;font-size:.82rem;outline:none\">\n          </div>\n          <div>\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Stop Loss</div>\n            <input type=\"number\" id=\"tf-sl\" placeholder=\"0.00\" step=\"any\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--rd);font-family:monospace;font-size:.82rem;outline:none\">\n          </div>\n          <div>\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">R/R</div>\n            <div id=\"tf-rr-display\" style=\"padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--blue3);font-family:monospace;font-size:.82rem;font-weight:600\">-</div>\n          </div>\n        </div>\n\n        <!-- Pre-Trade Checks -->\n        <div style=\"font-size:.72rem;font-weight:700;color:var(--t2);margin-bottom:8px\">&#128269; Pre-Trade Checks</div>\n        <div class=\"cl-list\" id=\"tf-pre-items\" style=\"margin-bottom:12px\">\n          <div class=\"cl-item\" data-key=\"bias\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Trade passt zum Tages-Bias</span></div>\n          <div class=\"cl-item\" data-key=\"zone\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Preis ist in einer Key-Zone</span></div>\n          <div class=\"cl-item\" data-key=\"rsi\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">RSI im gueltigen Bereich</span></div>\n          <div class=\"cl-item\" data-key=\"candle\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Klare Trendkerze sichtbar</span></div>\n          <div class=\"cl-item\" data-key=\"rr\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">R/R mindestens 1:1.5</span></div>\n          <div class=\"cl-item\" data-key=\"explain\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Trade erklaerbar</span></div>\n          <div class=\"cl-item\" data-key=\"calm\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Kein FOMO, ich bin ruhig</span></div>\n        </div>\n\n        <div style=\"margin-bottom:12px\">\n          <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px\">Setup-Begruendung (warum dieser Trade?)</div>\n          <textarea id=\"tf-reason\" placeholder=\"z.B. BTC nah an 78.200 Support, RSI bei 34 steigend, EMA200 Bias LONG, klare Hammer-Kerze auf 5min.\" style=\"width:100%;padding:9px 11px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.74rem;resize:vertical;min-height:60px;outline:none\"></textarea>\n        </div>\n\n        <!-- Outcome (optional beim Erstellen) -->\n        <div style=\"font-size:.72rem;font-weight:700;color:var(--t2);margin-bottom:8px\">&#127937; Ergebnis (optional, kann spaeter eingetragen werden)</div>\n        <div style=\"display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px\">\n          <button class=\"btn tf-oc-btn\" data-oc=\"OPEN\" id=\"oc-open\" style=\"border:2px solid var(--blue3);background:var(--dim);color:var(--blue3);font-size:.68rem;font-weight:700;padding:7px 4px\">Offen</button>\n          <button class=\"btn tf-oc-btn\" data-oc=\"WIN\" id=\"oc-win\" style=\"border:2px solid rgba(16,185,129,.3);background:rgba(16,185,129,.06);color:var(--gr);font-size:.68rem;font-weight:700;padding:7px 4px\">WIN &#9989;</button>\n          <button class=\"btn tf-oc-btn\" data-oc=\"LOSS\" id=\"oc-loss\" style=\"border:2px solid rgba(244,63,94,.3);background:rgba(244,63,94,.06);color:var(--rd);font-size:.68rem;font-weight:700;padding:7px 4px\">LOSS &#10060;</button>\n          <button class=\"btn tf-oc-btn\" data-oc=\"SKIP\" id=\"oc-skip\" style=\"border:2px solid var(--border);background:var(--bg2);color:var(--t3);font-size:.68rem;font-weight:700;padding:7px 4px\">Skip &#8212;</button>\n        </div>\n\n        <div id=\"tf-after-section\" style=\"display:none\">\n          <div class=\"cl-list\" id=\"tf-after-items\" style=\"margin-bottom:10px\">\n            <div class=\"cl-item\" data-key=\"rules\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Alle Regeln befolgt</span></div>\n            <div class=\"cl-item\" data-key=\"emotion\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Keine emotionalen Entscheidungen</span></div>\n          </div>\n          <div style=\"margin-bottom:10px\">\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px\">Exit Preis</div>\n            <input type=\"number\" id=\"tf-exit\" placeholder=\"0.00\" step=\"any\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t2);font-family:monospace;font-size:.82rem;outline:none\">\n          </div>\n          <div>\n            <div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px\">Lernpunkte / Review</div>\n            <textarea id=\"tf-review\" placeholder=\"Was lief gut? Was lief schlecht? Was wuerde ich beim naechsten Mal anders machen?\" style=\"width:100%;padding:9px 11px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.74rem;resize:vertical;min-height:60px;outline:none\"></textarea>\n          </div>\n        </div>\n\n        <button class=\"btn btn-p\" id=\"cl-form-save\" style=\"margin-top:12px;width:100%;font-size:.82rem;padding:11px\">Trade speichern</button>\n      </div>\n    </div>\n  </div>\n\n  <!-- HISTORY -->\n  <div id=\"cl-hist-wrap\" style=\"display:none;margin-top:16px\">\n    <div style=\"font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);margin-bottom:10px\">Verlauf</div>\n    <div id=\"cl-hist-body\"></div>\n  </div>\n</div>\n<!-- \u2550\u2550\u2550 TRADING (Analyse + Signale + Strategie + Checkliste) \u2550\u2550\u2550 -->\n<div class=\"page\" id=\"pg-trading\">\n  <div class=\"tab-bar\">\n    <button class=\"tab-btn on\" data-tab=\"analyse\">&#128269; Analyse</button>\n    <button class=\"tab-btn\" data-tab=\"signals\">&#128203; Signale</button>\n    <button class=\"tab-btn\" data-tab=\"strategy\">&#128218; Strategie</button>\n    <button class=\"tab-btn\" data-tab=\"journal\">&#9989; Journal</button>\n  </div>\n\n  <!-- ANALYSE TAB -->\n  <div class=\"tab-pane on\" id=\"tab-analyse\">\n    <div class=\"ph\" style=\"margin-bottom:14px\"><div class=\"pt\">Analyse</div><div class=\"ps\">Claude analysiert den aktuellen Snapshot \u2014 Entry, TP, SL und Begruendung.</div></div>\n    <div class=\"sh\"><div class=\"sl\">Aktuelle Snapshots</div><button class=\"btn btn-g\" id=\"ref-snaps\">&#8635; Refresh</button></div>\n    <div id=\"snap-list\"><div class=\"empty\"><p>Lade...</p></div></div>\n  </div>\n\n  <!-- SIGNALE TAB -->\n  <div class=\"tab-pane\" id=\"tab-signals\">\n    <div class=\"ph\" style=\"margin-bottom:14px\"><div class=\"pt\">Signale</div><div class=\"ps\">Alle Signale von TradingView. Markiere als WIN, LOSS oder Skip.</div></div>\n    <div class=\"frow\">\n      <select class=\"fsel\" id=\"fsym\"><option value=\"\">Alle Symbole</option></select>\n      <select class=\"fsel\" id=\"fout\" style=\"flex:.7\"><option value=\"\">Alle Status</option><option value=\"OPEN\">Open</option><option value=\"WIN\">Win</option><option value=\"LOSS\">Loss</option><option value=\"SKIPPED\">Skipped</option></select>\n      <button class=\"fpill on\" id=\"ss\" data-srt=\"score\">Score &#8595;</button>\n      <button class=\"fpill\" id=\"st\" data-srt=\"time\">Neueste</button>\n    </div>\n    <div id=\"sig-list\"><div class=\"empty\"><p>Lade...</p></div></div>\n  </div>\n\n  <!-- STRATEGIE TAB -->\n  <div class=\"tab-pane\" id=\"tab-strategy\">\n    <div class=\"ph\" style=\"margin-bottom:14px\"><div class=\"pt\">Strategie</div><div class=\"ps\">Deine Top-Down Daytrading Regeln \u2014 immer griffbereit.</div></div>\n    <div class=\"str\"><div class=\"strh\"><div class=\"strhi\">&#127919;</div><div class=\"strt\">Der 3-Schritt-Prozess</div></div><div class=\"strb\">\n      <div class=\"step\"><div class=\"stn\">1</div><div><div class=\"stit\">Morgen-Routine (10 Min)</div><div class=\"sttx\">4H Chart oeffnen, EMA200 pruefen. Preis darueber = Long-Bias, darunter = Short-Bias. EMA flach = kein Trade.</div></div></div>\n      <div class=\"step\"><div class=\"stn\">2</div><div><div class=\"stit\">Zonenanalyse (15min)</div><div class=\"sttx\">Warten bis Preis eine Zone erreicht. Higher Low oder Lower High sichtbar. Kein Chaos.</div></div></div>\n      <div class=\"step\"><div class=\"stn\">3</div><div><div class=\"stit\">Entry (5-10min)</div><div class=\"sttx\">Klare Trendkerze, starker Body, wenig Docht. RSI als Filter.</div></div></div>\n    </div></div>\n    <div class=\"str\"><div class=\"strh\"><div class=\"strhi\">&#128207;</div><div class=\"strt\">Entry-Regeln (alle erfuellt?)</div></div><div class=\"strb\">\n      <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\"><strong>RSI Long:</strong> 30-55 steigend. <strong>Short:</strong> 45-70 fallend.</div></div>\n      <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\"><strong>EMA200 (4H):</strong> Preis darueber = nur Long. Darunter = nur Short.</div></div>\n      <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\"><strong>Trendstruktur:</strong> EMA50 ueber EMA200 (Long) oder darunter. Neutral = kein Trade.</div></div>\n      <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\"><strong>Zone:</strong> Long nah an Support. Short nah an Resistance.</div></div>\n      <div class=\"srul\"><div class=\"sruli\">&#9989;</div><div class=\"srult\"><strong>R/R:</strong> Mindestens 1:1.5. SL logisch gesetzt.</div></div>\n    </div></div>\n    <div class=\"str\"><div class=\"strh\"><div class=\"strhi\">&#128683;</div><div class=\"strt\">Kein Trade wenn...</div></div><div class=\"strb\"><div class=\"nol\">\n      <div class=\"noi\">&#10060; Gegen Tages-Bias</div>\n      <div class=\"noi\">&#10060; EMA200 flach oder Preis direkt dran</div>\n      <div class=\"noi\">&#10060; Chaos, viele Wicks</div>\n      <div class=\"noi\">&#10060; FOMO</div>\n      <div class=\"noi\">&#10060; RSI extrem</div>\n      <div class=\"noi\">&#10060; Trade nicht erklaerbar</div>\n    </div></div></div>\n    <div class=\"str\"><div class=\"strh\"><div class=\"strhi\">&#10004;&#65039;</div><div class=\"strt\">Final Check \u2014 alle 3 mit Ja?</div></div><div class=\"strb\">\n      <div class=\"srul\"><div class=\"sruli\">&#9745;</div><div class=\"srult\">Passt der Trade zum Tages-Bias?</div></div>\n      <div class=\"srul\"><div class=\"sruli\">&#9745;</div><div class=\"srult\">Koennte ich diesen Trade erklaeren?</div></div>\n      <div class=\"srul\"><div class=\"sruli\">&#9745;</div><div class=\"srult\">Ruhig und klar im Kopf?</div></div>\n    </div></div>\n  </div>\n\n  <!-- JOURNAL TAB -->\n  <div class=\"tab-pane\" id=\"tab-journal\">\n    <div class=\"ph\" style=\"margin-bottom:14px\"><div class=\"pt\">Trade Journal</div><div class=\"ps\">Morgenroutine + alle Trades des Tages mit Checks, Begruendung und Review.</div></div>\n    <div style=\"display:flex;gap:8px;margin-bottom:16px;align-items:center;flex-wrap:wrap\">\n      <input type=\"date\" id=\"cl-date\" style=\"padding:7px 11px;background:var(--card);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.76rem;outline:none;cursor:pointer\">\n      <span style=\"font-size:.7rem;color:var(--t3)\">Nutzer: <strong id=\"cl-user-disp\" style=\"color:var(--blue3)\">-</strong></span>\n      <button class=\"btn btn-g\" id=\"cl-load-btn\">Laden</button>\n      <button class=\"btn btn-g\" id=\"cl-hist-btn\">&#128196; Verlauf</button>\n    </div>\n    <div class=\"card\" style=\"margin-bottom:12px\">\n      <div class=\"ch\" style=\"background:rgba(37,99,235,.06)\"><div><div class=\"ct\">&#127749; Morgen-Routine</div><div class=\"cs\">Einmal am Morgen</div></div><div id=\"ms-st\" style=\"font-size:.7rem;font-weight:600;color:var(--t3)\">&#9744; Offen</div></div>\n      <div class=\"cb\">\n        <div class=\"cl-list\" id=\"ms-items\">\n          <div class=\"cl-item\" data-key=\"ema4h\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">EMA200 auf 4H gecheckt und Bias bestimmt</span></div>\n          <div class=\"cl-item\" data-key=\"zones\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">1-2 Key-Zonen auf 15min markiert</span></div>\n          <div class=\"cl-item\" data-key=\"ema_ok\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">EMA200 nicht flach (sonst kein Trade)</span></div>\n          <div class=\"cl-item\" data-key=\"news\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Keine marktbewegenden News heute</span></div>\n          <div class=\"cl-item\" data-key=\"mind\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Klarer Kopf, kein FOMO, ruhig</span></div>\n        </div>\n        <textarea id=\"ms-notes\" placeholder=\"Tages-Bias, Key-Zonen, Besonderheiten...\" style=\"width:100%;margin-top:10px;padding:9px 11px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.74rem;resize:vertical;min-height:52px;outline:none\"></textarea>\n        <button class=\"btn btn-p\" id=\"ms-save\" style=\"margin-top:8px;width:100%\">Morgen-Routine speichern</button>\n      </div>\n    </div>\n    <div style=\"display:flex;align-items:center;justify-content:space-between;margin-bottom:10px\">\n      <div style=\"font-size:.8rem;font-weight:700;color:var(--t1)\">&#128200; Trades heute</div>\n      <button class=\"btn btn-p\" id=\"cl-new-trade-btn\">+ Neuer Trade</button>\n    </div>\n    <div id=\"cl-trades-list\"><div class=\"empty\"><p>Noch keine Trades heute.</p></div></div>\n    <div id=\"cl-trade-form\" style=\"display:none;margin-top:4px\">\n      <div class=\"card\" style=\"border:2px solid var(--blue2)\">\n        <div class=\"ch\" style=\"background:var(--dim)\"><div><div class=\"ct\" id=\"cl-form-title\">Neuer Trade</div><div class=\"cs\" id=\"cl-form-time\">-</div></div><button class=\"btn btn-g\" id=\"cl-form-cancel\" style=\"font-size:.65rem;padding:4px 9px\">Abbrechen</button></div>\n        <div class=\"cb\">\n          <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px\">\n            <div><div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Symbol *</div><input type=\"text\" id=\"tf-symbol\" placeholder=\"BTCUSDT\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t1);font-family:monospace;font-size:.82rem;font-weight:600;outline:none\" oninput=\"this.value=this.value.toUpperCase()\"></div>\n            <div><div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Richtung *</div><div style=\"display:flex;gap:6px\"><button class=\"btn tf-dir-btn\" data-dir=\"LONG\" id=\"tf-long\" style=\"flex:1;border:2px solid rgba(16,185,129,.3);background:rgba(16,185,129,.06);color:var(--gr);font-weight:700\">&#8593; LONG</button><button class=\"btn tf-dir-btn\" data-dir=\"SHORT\" id=\"tf-short\" style=\"flex:1;border:2px solid rgba(244,63,94,.3);background:rgba(244,63,94,.06);color:var(--rd);font-weight:700\">&#8595; SHORT</button></div></div>\n            <div><div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Timeframe</div><input type=\"text\" id=\"tf-timeframe\" placeholder=\"5m / 15m / 1H\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.78rem;outline:none\"></div>\n            <div><div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Uhrzeit</div><input type=\"time\" id=\"tf-time\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.78rem;outline:none\"></div>\n            <div><div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Entry</div><input type=\"number\" id=\"tf-entry\" placeholder=\"0.00\" step=\"any\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t2);font-family:monospace;font-size:.82rem;outline:none\"></div>\n            <div><div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Take Profit</div><input type=\"number\" id=\"tf-tp\" placeholder=\"0.00\" step=\"any\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--gr);font-family:monospace;font-size:.82rem;outline:none\"></div>\n            <div><div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">Stop Loss</div><input type=\"number\" id=\"tf-sl\" placeholder=\"0.00\" step=\"any\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--rd);font-family:monospace;font-size:.82rem;outline:none\"></div>\n            <div><div style=\"font-size:.63rem;color:var(--t3);margin-bottom:5px;font-weight:600\">R/R</div><div id=\"tf-rr-display\" style=\"padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--blue3);font-family:monospace;font-size:.82rem;font-weight:600\">-</div></div>\n          </div>\n          <div style=\"font-size:.72rem;font-weight:700;color:var(--t2);margin-bottom:8px\">&#128269; Pre-Trade Checks</div>\n          <div class=\"cl-list\" id=\"tf-pre-items\" style=\"margin-bottom:12px\">\n            <div class=\"cl-item\" data-key=\"bias\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Trade passt zum Tages-Bias</span></div>\n            <div class=\"cl-item\" data-key=\"zone\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Preis ist in einer Key-Zone</span></div>\n            <div class=\"cl-item\" data-key=\"rsi\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">RSI im gueltigen Bereich</span></div>\n            <div class=\"cl-item\" data-key=\"candle\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Klare Trendkerze sichtbar</span></div>\n            <div class=\"cl-item\" data-key=\"rr\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">R/R mindestens 1:1.5</span></div>\n            <div class=\"cl-item\" data-key=\"explain\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Trade erklaerbar</span></div>\n            <div class=\"cl-item\" data-key=\"calm\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Kein FOMO</span></div>\n          </div>\n          <textarea id=\"tf-reason\" placeholder=\"Warum dieser Trade? z.B. BTC nah an 78.200 Support, RSI 34 steigend, Hammer-Kerze auf 5min...\" style=\"width:100%;padding:9px 11px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.74rem;resize:vertical;min-height:56px;outline:none;margin-bottom:12px\"></textarea>\n          <div style=\"font-size:.72rem;font-weight:700;color:var(--t2);margin-bottom:8px\">&#127937; Ergebnis</div>\n          <div style=\"display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px\">\n            <button class=\"btn tf-oc-btn\" data-oc=\"OPEN\" id=\"oc-open\" style=\"border:2px solid var(--blue3);background:var(--dim);color:var(--blue3);font-size:.68rem;font-weight:700;padding:7px 4px;opacity:1\">Offen</button>\n            <button class=\"btn tf-oc-btn\" data-oc=\"WIN\" id=\"oc-win\" style=\"border:2px solid rgba(16,185,129,.3);background:rgba(16,185,129,.06);color:var(--gr);font-size:.68rem;font-weight:700;padding:7px 4px;opacity:.5\">WIN &#9989;</button>\n            <button class=\"btn tf-oc-btn\" data-oc=\"LOSS\" id=\"oc-loss\" style=\"border:2px solid rgba(244,63,94,.3);background:rgba(244,63,94,.06);color:var(--rd);font-size:.68rem;font-weight:700;padding:7px 4px;opacity:.5\">LOSS &#10060;</button>\n            <button class=\"btn tf-oc-btn\" data-oc=\"SKIP\" id=\"oc-skip\" style=\"border:2px solid var(--border);background:var(--bg2);color:var(--t3);font-size:.68rem;font-weight:700;padding:7px 4px;opacity:.5\">Skip</button>\n          </div>\n          <div id=\"tf-after-section\" style=\"display:none\">\n            <div class=\"cl-list\" id=\"tf-after-items\" style=\"margin-bottom:10px\">\n              <div class=\"cl-item\" data-key=\"rules\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Alle Regeln befolgt</span></div>\n              <div class=\"cl-item\" data-key=\"emotion\"><span class=\"cl-cb\" data-checked=\"false\">&#9744;</span><span class=\"cl-label\">Keine emotionalen Entscheidungen</span></div>\n            </div>\n            <input type=\"number\" id=\"tf-exit\" placeholder=\"Exit Preis\" step=\"any\" style=\"width:100%;padding:8px 11px;background:var(--bg2);border:1.5px solid var(--border);border-radius:8px;color:var(--t2);font-family:monospace;font-size:.82rem;outline:none;margin-bottom:10px\">\n            <textarea id=\"tf-review\" placeholder=\"Was lief gut? Was lief schlecht? Lernpunkte?\" style=\"width:100%;padding:9px 11px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;color:var(--t2);font-family:system-ui;font-size:.74rem;resize:vertical;min-height:60px;outline:none\"></textarea>\n          </div>\n          <button class=\"btn btn-p\" id=\"cl-form-save\" style=\"margin-top:12px;width:100%;font-size:.82rem;padding:11px\">&#128190; Trade speichern</button>\n        </div>\n      </div>\n    </div>\n    <div id=\"cl-hist-wrap\" style=\"display:none;margin-top:16px\">\n      <div style=\"font-size:.62rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);margin-bottom:10px\">Verlauf (letzte 30 Tage)</div>\n      <div id=\"cl-hist-body\"></div>\n    </div>\n  </div>\n</div>\n\n<!-- \u2550\u2550\u2550 STATISTIKEN (Backtesting) \u2550\u2550\u2550 -->\n<div class=\"page\" id=\"pg-stats\">\n  <div class=\"ph\"><div class=\"pt\">Statistiken</div><div class=\"ps\">Auswertung aller Signale \u2014 P&L, Equity-Kurve, Filter-Vergleich.</div></div>\n  <div class=\"bt-tabs\">\n    <button class=\"bttab on\" data-btp=\"analytics\">Auswertung</button>\n    <button class=\"bttab\" data-btp=\"symbol\">Pro Symbol</button>\n  </div>\n  <div id=\"bt-body\"><div class=\"empty\"><p>Lade...</p></div></div>\n</div>\n\n<!-- \u2550\u2550\u2550 SYSTEM (Tools + Telegram) \u2550\u2550\u2550 -->\n<div class=\"page\" id=\"pg-system\">\n  <div class=\"tab-bar\">\n    <button class=\"tab-btn on\" data-tab=\"tools-t\">&#128295; Tools</button>\n    <button class=\"tab-btn\" data-tab=\"telegram-t\">&#128172; Telegram</button>\n  </div>\n\n  <!-- TOOLS TAB -->\n  <div class=\"tab-pane on\" id=\"tab-tools-t\">\n    <div class=\"ph\" style=\"margin-bottom:14px\"><div class=\"pt\">Tools</div><div class=\"ps\">System-Aktionen und externe Links.</div></div>\n    <a class=\"wbl\" href=\"https://waveboard-e54ed.web.app/waveboard/dashboard\" target=\"_blank\" style=\"display:flex;margin-bottom:14px\"><div class=\"wbl-ic\">&#127754;</div><div><div class=\"wbl-t\">WaveBoard Dashboard</div><div class=\"wbl-s\">waveboard-e54ed.web.app</div></div><div class=\"wbl-btn\">&#8599;</div></a>\n    <div class=\"tlg\"><div class=\"tlgl\">System</div><div class=\"tll\">\n      <div class=\"tlr\" data-ta=\"health\"><div class=\"tlri\">&#128154;</div><div class=\"tlrtx\"><div class=\"tlrl\">Health Check</div><div class=\"tlrd\">Worker Status pruefen</div></div><div class=\"tlra\">&#8250;</div></div>\n      <div class=\"tlr\" data-ta=\"telegram\"><div class=\"tlri\">&#128232;</div><div class=\"tlrtx\"><div class=\"tlrl\">Telegram testen</div><div class=\"tlrd\">Test-Nachricht senden</div></div><div class=\"tlra\">&#8250;</div></div>\n      <div class=\"tlr\" data-ta=\"morning\"><div class=\"tlri\">&#127749;</div><div class=\"tlrtx\"><div class=\"tlrl\">Morning Brief</div><div class=\"tlrd\">Tages-Bias senden</div></div><div class=\"tlra\">&#8250;</div></div>\n      <div class=\"tlr\" data-ta=\"outcomes\"><div class=\"tlri\">&#128260;</div><div class=\"tlrtx\"><div class=\"tlrl\">Outcome Tracking</div><div class=\"tlrd\">WIN/LOSS via Binance</div></div><div class=\"tlra\">&#8250;</div></div>\n    </div></div>\n    <div class=\"tlg\"><div class=\"tlgl\">Links</div><div class=\"tll\">\n      <a class=\"tlr\" href=\"https://tradingview.com\" target=\"_blank\"><div class=\"tlri\">&#128202;</div><div class=\"tlrtx\"><div class=\"tlrl\">TradingView</div><div class=\"tlrd\">Charts und Alerts</div></div><div class=\"tlra\">&#8599;</div></a>\n      <a class=\"tlr\" href=\"https://dash.cloudflare.com\" target=\"_blank\"><div class=\"tlri\">&#9729;&#65039;</div><div class=\"tlrtx\"><div class=\"tlrl\">Cloudflare</div><div class=\"tlrd\">Worker und Logs</div></div><div class=\"tlra\">&#8599;</div></a>\n      <a class=\"tlr\" href=\"https://github.com/spnni08/tradingview-bot\" target=\"_blank\"><div class=\"tlri\">&#128025;</div><div class=\"tlrtx\"><div class=\"tlrl\">GitHub</div><div class=\"tlrd\">spnni08/tradingview-bot</div></div><div class=\"tlra\">&#8599;</div></a>\n      <a class=\"tlr\" href=\"https://console.anthropic.com\" target=\"_blank\"><div class=\"tlri\">&#129302;</div><div class=\"tlrtx\"><div class=\"tlrl\">Anthropic Console</div><div class=\"tlrd\">Claude API Keys</div></div><div class=\"tlra\">&#8599;</div></a>\n    </div></div>\n  </div>\n\n  <!-- TELEGRAM TAB -->\n  <div class=\"tab-pane\" id=\"tab-telegram-t\">\n    <div class=\"ph\" style=\"margin-bottom:14px\"><div class=\"pt\">Telegram</div><div class=\"ps\">Kommandos fuer den WAVESCOUT Bot \u2014 tippe zum Kopieren.</div></div>\n    <div class=\"cmdi\">Tipp: Schreibe z.B. <strong>/btc</strong> in Telegram und bekomme sofort eine Claude-Analyse.</div>\n    <div class=\"cmdg\">\n      <div class=\"cmdr\" data-cp=\"/btc\"><div><div class=\"cmdc\">/btc</div><div class=\"cmdd\">Bitcoin analysieren</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n      <div class=\"cmdr\" data-cp=\"/eth\"><div><div class=\"cmdc\">/eth</div><div class=\"cmdd\">Ethereum analysieren</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n      <div class=\"cmdr\" data-cp=\"/sol\"><div><div class=\"cmdc\">/sol</div><div class=\"cmdd\">Solana analysieren</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n      <div class=\"cmdr\" data-cp=\"/check RENDERUSDT\"><div><div class=\"cmdc\">/check SYMBOL</div><div class=\"cmdd\">Beliebiges Symbol</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n      <div class=\"cmdr\" data-cp=\"/status\"><div><div class=\"cmdc\">/status</div><div class=\"cmdd\">Winrate und Stats</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n      <div class=\"cmdr\" data-cp=\"/brief\"><div><div class=\"cmdc\">/brief</div><div class=\"cmdd\">Morning Brief</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n      <div class=\"cmdr\" data-cp=\"/open\"><div><div class=\"cmdc\">/open</div><div class=\"cmdd\">Offene Trades</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n      <div class=\"cmdr\" data-cp=\"/top\"><div><div class=\"cmdc\">/top</div><div class=\"cmdd\">Beste Signale heute</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n      <div class=\"cmdr\" data-cp=\"/hilfe\"><div><div class=\"cmdc\">/hilfe</div><div class=\"cmdd\">Alle Kommandos</div></div><span style=\"color:var(--t3)\">&#8856;</span></div>\n    </div>\n  </div>\n</div>\n\n<script>\nvar SECRET=new URLSearchParams(location.search).get('secret')||'';\nvar UA={Marvin:{bg:'linear-gradient(135deg,#1e40af,#3b82f6)',i:'M'},Sandro:{bg:'linear-gradient(135deg,#0369a1,#2563eb)',i:'S'},Iven:{bg:'linear-gradient(135deg,#065f46,#059669)',i:'I'}};\nvar su=null,aS=[],sm='score',bd=null,bp='analytics';\n\nfunction toggleTheme(){var h=document.documentElement;var d=h.dataset.theme==='dark';h.dataset.theme=d?'light':'dark';localStorage.setItem('wst',d?'light':'dark');document.getElementById('thbtn').textContent=d?String.fromCodePoint(127769):String.fromCodePoint(9728);}\n(function(){var t=localStorage.getItem('wst')||'dark';document.documentElement.dataset.theme=t;})();\n\nfunction loginAs(name){localStorage.setItem('wu',name);var ls=document.getElementById('ls');if(ls)ls.className='gone';var u=UA[name]||UA.Marvin;var av=document.getElementById('uav'),nm=document.getElementById('uname');if(av){av.style.background=u.bg;av.textContent=u.i;}if(nm)nm.textContent=name;ug(name);lh();}\nfunction ca(){var u=localStorage.getItem('wu');if(!u)return false;loginAs(u);return true;}\nfunction logout(){localStorage.removeItem('wu');var ls=document.getElementById('ls');if(ls)ls.className='';}\n\nvar DN=['So','Mo','Di','Mi','Do','Fr','Sa'],MN=['Jan','Feb','Mar','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];\nfunction ug(n){var h=new Date().getHours();var g=h<12?'Guten Morgen':h<18?'Guten Tag':'Guten Abend';var now=new Date();var t=document.getElementById('htitle'),d=document.getElementById('hdate');if(t)t.innerHTML=g+', <em>'+(n||'Trader')+'</em>';if(d)d.textContent=DN[now.getDay()]+', '+now.getDate()+'. '+MN[now.getMonth()]+' '+now.getFullYear();}\nsetInterval(function(){var el=document.getElementById('clk');if(el)el.textContent=new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});var u=localStorage.getItem('wu');if(u)ug(u);},1000);\n\nfunction fmt(n,d){d=d===undefined?2:d;if(!n&&n!==0)return'-';return Number(n).toLocaleString('de-DE',{minimumFractionDigits:d,maximumFractionDigits:d});}\nfunction ago(ts){var d=Date.now()-ts;if(d<60000)return'jetzt';if(d<3600000)return Math.floor(d/60000)+'m';if(d<86400000)return Math.floor(d/3600000)+'h';return Math.floor(d/86400000)+'d';}\nfunction sc(s){return s>=70?'var(--gr)':s>=50?'var(--am)':'var(--rd)';}\nfunction toast(m,d){d=d||2500;var t=document.getElementById('toast');t.textContent=m;t.classList.add('on');setTimeout(function(){t.classList.remove('on');},d);}\n\nvar PG=['home','analyse','signals','bt','str','tools','tg'];\nfunction go(n){document.querySelectorAll('.page').forEach(function(p){p.classList.remove('on');});PG.forEach(function(p){var b=document.getElementById('nb-'+p);if(b)b.classList.toggle('on',p===n);});['home','analyse','signals','bt','tools'].forEach(function(p){var b=document.getElementById('bn-'+p);if(b)b.classList.toggle('on',p===n);});var pg=document.getElementById('pg-'+n);if(pg)pg.classList.add('on');if(n==='analyse')ls2();if(n==='signals')lsg();if(n==='bt')lbt();if(n==='home')lh();}\n\nasync function lst(){var d=await fetch('/stats').then(function(r){return r.json();}).catch(function(){return{};});document.getElementById('k-open').textContent=d.open||0;document.getElementById('k-wins').textContent=d.wins||0;document.getElementById('k-losses').textContent=d.losses||0;document.getElementById('k-wr').textContent=(d.winrate||0)+'%';}\n\nasync function lh(){await lst();var h=await fetch('/history').then(function(r){return r.json();}).catch(function(){return[];});var el=document.getElementById('home-sigs');if(!h.length){el.innerHTML='<div class=\"empty\"><p>Noch keine Signale.</p></div>';return;}el.innerHTML=h.slice(0,5).map(function(x){var s=Number(x.ai_score)||0;var L=x.ai_direction==='LONG';var dp=L?'dp-L':'dp-S';var dir=L?'L':'S';return '<div class=\"rs\"><div class=\"rs-dp '+dp+'\">'+dir+'</div><div style=\"flex:1\"><div class=\"rs-sym\">'+(x.symbol||'-')+'</div><div class=\"rs-sub\">'+(x.trigger||'-')+'</div></div><div style=\"text-align:right\"><div class=\"rs-sc\" style=\"color:'+sc(s)+'\">'+s+'/100</div><div class=\"rs-age\">'+ago(x.created_at)+'</div></div></div>';}).join('');}\n\nasync function ls2(){var el=document.getElementById('snap-list');el.innerHTML='<div class=\"empty\"><p>Lade...</p></div>';var snaps=await fetch('/snapshots').then(function(r){return r.json();}).catch(function(){return[];});if(!snaps.length){el.innerHTML='<div class=\"empty\"><p>Noch keine Snapshots.</p></div>';return;}el.innerHTML=snaps.map(function(s){var sid='sbtn-'+s.symbol.replace(/[^a-zA-Z0-9]/g,'_');var h='<div><div class=\"snap\"><div style=\"flex:1;min-width:0\"><div class=\"snap-sym\">'+s.symbol+'</div><div class=\"snap-meta\">RSI '+fmt(s.rsi,1)+' EMA50 '+fmt(s.ema50,0)+' '+(s.trend||'-')+'</div></div><div class=\"snap-px\">'+fmt(s.price)+'</div>';h+=SECRET?'<button class=\"btn btn-p\" id=\"'+sid+'\" style=\"font-size:.65rem;padding:6px 12px\">Prufen</button>':'<button class=\"btn btn-p\" disabled style=\"font-size:.65rem;padding:6px 12px\">--</button>';h+='</div><div class=\"res\" id=\"res-'+s.symbol+'\" style=\"display:none\"></div></div>';return h;}).join('');snaps.forEach(function(s){var sid='sbtn-'+s.symbol.replace(/[^a-zA-Z0-9]/g,'_');var btn=document.getElementById(sid);if(btn)(function(sym,b){b.addEventListener('click',function(){cn(sym,b);});})(s.symbol,btn);});}\n\nasync function cn(sym,btn){btn.disabled=true;btn.textContent='...';var el=document.getElementById('res-'+sym);try{var d=await fetch('/ask?symbol='+encodeURIComponent(sym)+'&secret='+encodeURIComponent(SECRET)).then(function(r){return r.json();});if(d.error)throw new Error(d.error);var ai=d.ai||{},s=Number(ai.score)||0,rec=ai.recommendation==='RECOMMENDED';var rr=(ai.entry&&ai.take_profit&&ai.stop_loss)?(Math.abs(ai.take_profit-ai.entry)/Math.abs(ai.entry-ai.stop_loss)).toFixed(2):null;el.style.display='block';var p=[];p.push('<div class=\"res-top\"><span class=\"rbadge '+(rec?'ry':'rn')+'\">'+(rec?'Empfohlen':'Nicht empfohlen')+'</span><span style=\"font-family:monospace;font-size:.82rem;color:'+sc(s)+'\">'+s+'/100</span></div>');p.push('<div class=\"res-bd\">');p.push('<div class=\"rr\"><span class=\"rk\">Richtung</span><span class=\"rv\">'+(ai.direction||'-')+'</span></div>');p.push('<div class=\"rr\"><span class=\"rk\">Risiko</span><span class=\"rv\">'+(ai.risk||'-')+'</span></div>');p.push('<div class=\"rr\"><span class=\"rk\">Confidence</span><span class=\"rv\">'+(ai.confidence||0)+'%</span></div>');if(rr)p.push('<div class=\"rr\"><span class=\"rk\">R/R</span><span class=\"rv\">1:'+rr+'</span></div>');p.push('<div class=\"bar\"><div class=\"bar-f\" style=\"width:'+s+'%;background:'+sc(s)+'\"></div></div>');p.push('<div class=\"rplan\"><div class=\"rpc\"><div class=\"rpl\">Entry</div><div class=\"rpv\" style=\"color:var(--blue3)\">'+fmt(ai.entry)+'</div></div><div class=\"rpc\"><div class=\"rpl\">TP</div><div class=\"rpv\" style=\"color:var(--gr)\">'+fmt(ai.take_profit)+'</div></div><div class=\"rpc\"><div class=\"rpl\">SL</div><div class=\"rpv\" style=\"color:var(--rd)\">'+fmt(ai.stop_loss)+'</div></div></div>');if(ai.reason)p.push('<div class=\"rreason\">'+ai.reason+'</div>');p.push('</div>');el.innerHTML=p.join('');toast(rec?'Empfohlen!':'Nicht empfohlen');}catch(e){el.style.display='block';el.innerHTML='<div style=\"padding:12px;color:var(--rd);font-size:.72rem\">Fehler: '+e.message+'</div>';}btn.disabled=false;btn.textContent='Prufen';}\n\nasync function lsg(){var el=document.getElementById('sig-list');el.innerHTML='<div class=\"empty\"><p>Lade...</p></div>';aS=await fetch('/history').then(function(r){return r.json();}).catch(function(){return[];});var syms=[...new Set(aS.map(function(x){return x.symbol;}).filter(Boolean))];var sel=document.getElementById('fsym');sel.innerHTML='<option value=\"\">Alle Symbole</option>'+syms.map(function(s){return '<option value=\"'+s+'\">'+s+'</option>';}).join('');af();}\nfunction srt(m){sm=m;document.getElementById('ss').classList.toggle('on',m==='score');document.getElementById('st').classList.toggle('on',m==='time');af();}\nfunction af(){var sym=document.getElementById('fsym').value;var out=document.getElementById('fout').value;var f=[...aS];if(sym)f=f.filter(function(x){return x.symbol===sym;});if(out)f=f.filter(function(x){return x.outcome===out;});if(sm==='score')f.sort(function(a,b){return(b.ai_score||0)-(a.ai_score||0);});else f.sort(function(a,b){return b.created_at-a.created_at;});var el=document.getElementById('sig-list');if(!f.length){el.innerHTML='<div class=\"empty\"><p>Keine Signale.</p></div>';return;}el.innerHTML=f.map(function(x){var s=Number(x.ai_score)||0;var oc=x.outcome==='WIN'?'tw':x.outcome==='LOSS'?'tl':x.outcome==='SKIPPED'?'tsk':'to';var rc=x.ai_recommendation==='RECOMMENDED'?'tr':'tnr';var rk=x.ai_risk==='HIGH'?'thi':x.ai_risk==='MEDIUM'?'tmd':'tlo';var op=x.outcome==='OPEN';var L=x.ai_direction==='LONG';var h='<div class=\"sc\"><div class=\"sc-top\"><div><div class=\"sc-sym\">'+(x.symbol||'-')+'</div><span class=\"sc-dp '+(L?'dp-long':'dp-short')+'\">'+(x.ai_direction||'-')+'</span></div><div style=\"text-align:right\"><div class=\"sc-score\" style=\"color:'+sc(s)+'\">'+s+'/100</div><div class=\"sc-age\">'+ago(x.created_at)+'</div></div></div>';h+='<div class=\"sc-px\"><span>E:'+fmt(x.ai_entry)+'</span><span style=\"color:var(--gr)\">TP:'+fmt(x.ai_take_profit)+'</span><span style=\"color:var(--rd)\">SL:'+fmt(x.ai_stop_loss)+'</span></div>';h+='<div class=\"bar\" style=\"margin-bottom:8px\"><div class=\"bar-f\" style=\"width:'+s+'%;background:'+sc(s)+'\"></div></div>';h+='<div class=\"sc-ft\"><div class=\"tgs\"><span class=\"tg '+rc+'\">'+(x.ai_recommendation==='RECOMMENDED'?'Empf.':'Nein')+'</span><span class=\"tg '+rk+'\">'+(x.ai_risk||'-')+'</span><span class=\"tg '+oc+'\" id=\"out-'+x.id+'\">'+(x.outcome||'-')+'</span></div>';if(op&&SECRET)h+='<div class=\"obt\" id=\"obt-'+x.id+'\"><button class=\"ob obw\" data-id=\"'+x.id+'\" data-out=\"WIN\">WIN</button><button class=\"ob obl\" data-id=\"'+x.id+'\" data-out=\"LOSS\">LOSS</button><button class=\"ob obs\" data-id=\"'+x.id+'\" data-out=\"SKIPPED\">Skip</button></div>';h+='</div></div>';return h;}).join('');el.querySelectorAll('.ob[data-id]').forEach(function(btn){btn.addEventListener('click',function(){so(btn.dataset.id,btn.dataset.out,btn);});});}\nasync function so(id,o,btn){var all=btn.parentElement.querySelectorAll('.ob');all.forEach(function(b){b.disabled=true;});try{var r=await fetch('/outcome?id='+id+'&outcome='+o+'&secret='+encodeURIComponent(SECRET),{method:'POST'}).then(function(r){return r.json();});if(r.status==='ok'){var b=document.getElementById('out-'+id);if(b){b.className='tg '+(o==='WIN'?'tw':o==='LOSS'?'tl':'tsk');b.textContent=o;}var obt=document.getElementById('obt-'+id);if(obt)obt.style.display='none';lst();toast(o==='WIN'?'WIN!':o==='LOSS'?'LOSS!':'Skip');}}catch(e){all.forEach(function(b){b.disabled=false;});toast('Fehler: '+e.message);}}\n\nasync function lbt(){var el=document.getElementById('bt-body');el.innerHTML='<div class=\"empty\"><p>Lade...</p></div>';var r=await Promise.all([fetch('/analytics').then(function(r){return r.json();}).catch(function(){return null;}),fetch('/backtesting').then(function(r){return r.json();}).catch(function(){return null;})]);bd={analytics:r[0],backtesting:r[1]};rbT(bp);}\nfunction btp(p,btn){bp=p;document.querySelectorAll('.bttab').forEach(function(t){t.classList.remove('on');});btn.classList.add('on');rbT(p);}\nfunction drawEq(curve){if(!curve||curve.length<2)return'';var vals=curve.map(function(p){return p.equity;});var mn=Math.min.apply(null,vals)*0.995,mx=Math.max.apply(null,vals)*1.005;if(mx===mn)return'';var W=300,H=80;var px=function(i){return Math.round((i/(vals.length-1))*W);};var py=function(v){return Math.round(H-((v-mn)/(mx-mn))*H);};var path=vals.map(function(v,i){return(i===0?'M':'L')+px(i)+' '+py(v);}).join(' ');var up=vals[vals.length-1]>=vals[0];var col=up?'var(--gr)':'var(--rd)';return '<svg viewBox=\"0 0 '+W+' '+H+'\" style=\"width:100%;height:80px\" preserveAspectRatio=\"none\"><path d=\"'+path+' L'+W+' '+H+' L0 '+H+' Z\" fill=\"'+col+'\" fill-opacity=\".15\"/><path d=\"'+path+'\" fill=\"none\" stroke=\"'+col+'\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>';}\nfunction rbT(p){if(!bd)return;var el=document.getElementById('bt-body');var an=bd.analytics;if(p==='analytics'){if(!an||an.error){el.innerHTML='<div class=\"empty\"><p>Noch keine abgeschlossenen Trades.</p></div>';return;}var s=an.summary;var pc=s.total_pnl_pct>=0?'var(--gr)':'var(--rd)';var h='<div class=\"bt-ks\"><div class=\"btk\"><div class=\"btkv\" style=\"color:var(--gr)\">'+s.wins+'</div><div class=\"btkl\">Wins</div></div><div class=\"btk\"><div class=\"btkv\" style=\"color:var(--rd)\">'+s.losses+'</div><div class=\"btkl\">Losses</div></div><div class=\"btk\"><div class=\"btkv\" style=\"color:var(--blue3)\">'+s.winrate+'%</div><div class=\"btkl\">Winrate</div></div></div>';h+='<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px\"><div class=\"btk\"><div class=\"btkv\" style=\"color:'+pc+'\">'+(s.total_pnl_pct>0?'+':'')+s.total_pnl_pct+'%</div><div class=\"btkl\">P&L</div></div><div class=\"btk\"><div class=\"btkv\" style=\"color:var(--am)\">'+s.profit_factor+'x</div><div class=\"btkl\">Profit Factor</div></div><div class=\"btk\"><div class=\"btkv\" style=\"color:var(--gr)\">+'+s.avg_win_pct+'%</div><div class=\"btkl\">Avg Win</div></div><div class=\"btk\"><div class=\"btkv\" style=\"color:var(--rd)\">'+s.avg_loss_pct+'%</div><div class=\"btkl\">Avg Loss</div></div></div>';if(an.equityCurve&&an.equityCurve.length>1){h+='<div class=\"card\" style=\"margin-bottom:12px\"><div class=\"ch\"><div class=\"ct\">Equity Kurve</div></div><div style=\"padding:12px 16px 8px\">'+drawEq(an.equityCurve)+'</div></div>';}var f=an.filters;h+='<div class=\"card\" style=\"margin-bottom:12px\"><div class=\"ch\"><div class=\"ct\">Claude Empfehlung</div></div><div class=\"cb\"><div style=\"display:grid;grid-template-columns:1fr 1fr;gap:10px\"><div style=\"background:rgba(16,185,129,.06);border:1px solid rgba(16,185,129,.15);border-radius:10px;padding:14px;text-align:center\"><div style=\"font-size:.62rem;font-weight:600;color:var(--gr);margin-bottom:8px\">Empfohlen ('+f.claude.recommended.total+')</div><div style=\"font-family:monospace;font-size:1.4rem;color:var(--gr)\">'+f.claude.recommended.wr+'%</div></div><div style=\"background:rgba(244,63,94,.06);border:1px solid rgba(244,63,94,.15);border-radius:10px;padding:14px;text-align:center\"><div style=\"font-size:.62rem;font-weight:600;color:var(--rd);margin-bottom:8px\">Nicht empf. ('+f.claude.not_recommended.total+')</div><div style=\"font-family:monospace;font-size:1.4rem;color:var(--rd)\">'+f.claude.not_recommended.wr+'%</div></div></div></div></div>';if(an.recentTrades&&an.recentTrades.length){h+='<div class=\"card\"><div class=\"ch\"><div class=\"ct\">Letzte Trades</div></div><div style=\"padding:0 4px\"><table class=\"stbl\"><tr><th>Datum</th><th>Symbol</th><th>P&L</th><th>Score</th><th>Status</th></tr>'+an.recentTrades.map(function(t){return'<tr><td style=\"font-size:.65rem;color:var(--t3)\">'+t.date+'</td><td><strong>'+t.symbol+'</strong></td><td style=\"font-family:monospace;color:'+(t.pnl>=0?'var(--gr)':'var(--rd)')+'\">'+  (t.pnl>0?'+':'')+t.pnl+'%</td><td style=\"font-family:monospace\">'+t.score+'/100</td><td><span class=\"tg '+(t.outcome==='WIN'?'tw':'tl')+'\">'+t.outcome+'</span></td></tr>';}).join('')+'</table></div></div>';}el.innerHTML=h;}else{var bt2=bd.backtesting;if(!bt2||bt2.error){el.innerHTML='<div class=\"empty\"><p>Keine Daten.</p></div>';return;}var h2='';if(bt2.bySymbol&&bt2.bySymbol.length){h2+='<div class=\"card\"><div class=\"ch\"><div class=\"ct\">Winrate pro Symbol</div></div><div style=\"padding:0 4px\"><table class=\"stbl\"><tr><th>Symbol</th><th>W</th><th>L</th><th>WR</th><th>Score</th></tr>'+bt2.bySymbol.map(function(s){var c=(s.wins||0)+(s.losses||0);var w=c>0?((s.wins/c)*100).toFixed(0):0;return'<tr><td><strong>'+s.symbol+'</strong></td><td style=\"color:var(--gr)\">'+(s.wins||0)+'</td><td style=\"color:var(--rd)\">'+(s.losses||0)+'</td><td style=\"font-family:monospace;color:var(--blue3)\">'+w+'%</td><td style=\"font-family:monospace\">'+Number(s.avg_score||0).toFixed(0)+'</td></tr>';}).join('')+'</table></div></div>';}el.innerHTML=h2||'<div class=\"empty\"><p>Keine Daten.</p></div>';}}\n\nasync function ta(a){if(!SECRET&&a!=='health'){toast('Secret benoetigt');return;}toast('...');try{if(a==='health'){var d=await fetch('/health').then(function(r){return r.json();});toast('OK: '+new Date(d.time).toLocaleTimeString('de-DE'),3000);}else if(a==='telegram'){await fetch('/test-telegram?secret='+encodeURIComponent(SECRET));toast('Telegram gesendet!');}else if(a==='morning'){await fetch('/morning-brief?secret='+encodeURIComponent(SECRET));toast('Morning Brief gesendet!');}else if(a==='outcomes'){var d2=await fetch('/check-outcomes?secret='+encodeURIComponent(SECRET)).then(function(r){return r.json();});toast((d2.result&&d2.result.closed||0)+' Trades aktualisiert',3000);}}catch(e){toast('Fehler: '+e.message);}}\n\ndocument.addEventListener('DOMContentLoaded',function(){\n  ['Marvin','Sandro','Iven'].forEach(function(n){var btn=document.getElementById('btn-'+n);if(btn)btn.addEventListener('click',function(){loginAs(n);});});\n  document.querySelectorAll('[data-page]').forEach(function(btn){btn.addEventListener('click',function(){go(btn.dataset.page);});});\n  document.querySelectorAll('[data-ta]').forEach(function(btn){btn.addEventListener('click',function(){ta(btn.dataset.ta);});});\n  document.querySelectorAll('[data-cp]').forEach(function(btn){btn.addEventListener('click',function(){cp(btn.dataset.cp);});});\n  document.querySelectorAll('[data-srt]').forEach(function(btn){btn.addEventListener('click',function(){srt(btn.dataset.srt);});});\n  document.querySelectorAll('[data-btp]').forEach(function(btn){btn.addEventListener('click',function(){btp(btn.dataset.btp,btn);});});\n  var lb=document.getElementById('logout-btn');if(lb)lb.addEventListener('click',logout);\n  var tbtn=document.getElementById('thbtn');if(tbtn)tbtn.addEventListener('click',toggleTheme);\n  var t=localStorage.getItem('wst')||'dark';tbtn.textContent=t==='dark'?String.fromCodePoint(127769):String.fromCodePoint(9728);\n  document.getElementById('fsym') && document.getElementById('fsym').addEventListener('change',af);\n  document.getElementById('fout') && document.getElementById('fout').addEventListener('change',af);\n  document.getElementById('fout').addEventListener('change',af);\n  if(!ca()){}\n});\nfunction cp(c){navigator.clipboard.writeText(c).then(function(){toast('Kopiert: '+c);});}\ndocument.getElementById('ref-snaps') && document.getElementById('ref-snaps').addEventListener('click', ls2);\n\n// \u2500\u2500\u2500 TRADE JOURNAL JS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\nvar clHistVisible = false;\nvar tfDirection = null;\nvar tfOutcome = 'OPEN';\nvar editingTradeId = null;\n\nfunction clSetupList(listId) {\n  document.querySelectorAll('#'+listId+' .cl-item').forEach(function(item){\n    item.addEventListener('click', function(){\n      var cb = item.querySelector('.cl-cb');\n      var was = cb.dataset.checked === 'true';\n      cb.dataset.checked = was ? 'false' : 'true';\n      cb.textContent = was ? '\\u2744' : '\\u2611';\n      item.classList.toggle('checked', !was);\n      if(listId === 'ms-items') clUpdateMorningStatus();\n    });\n  });\n}\n\nfunction clUpdateMorningStatus() {\n  var cbs = document.querySelectorAll('#ms-items .cl-cb');\n  var done = 0; cbs.forEach(function(c){ if(c.dataset.checked==='true') done++; });\n  var el = document.getElementById('ms-st');\n  if(!el) return;\n  if(done===cbs.length){ el.textContent='\\u2611 Abgeschlossen'; el.style.color='var(--gr)'; }\n  else { el.textContent='\\u2744 '+done+'/'+cbs.length; el.style.color=done>0?'var(--am)':'var(--t3)'; }\n}\n\nfunction clGetChecks(listId) {\n  var out = {};\n  document.querySelectorAll('#'+listId+' .cl-item').forEach(function(i){ out[i.dataset.key]=i.querySelector('.cl-cb').dataset.checked==='true'; });\n  return out;\n}\n\nfunction clSetChecks(listId, checks) {\n  if(!checks) return;\n  document.querySelectorAll('#'+listId+' .cl-item').forEach(function(item){\n    var cb = item.querySelector('.cl-cb');\n    var v = !!checks[item.dataset.key];\n    cb.dataset.checked = v?'true':'false';\n    cb.textContent = v?'\\u2611':''+'\\u2744';\n    item.classList.toggle('checked', v);\n  });\n}\n\nfunction clResetForm() {\n  ['tf-symbol','tf-timeframe','tf-entry','tf-tp','tf-sl','tf-exit','tf-reason','tf-review'].forEach(function(id){\n    var el = document.getElementById(id); if(el) el.value = '';\n  });\n  document.getElementById('tf-rr-display').textContent = '-';\n  document.querySelectorAll('#tf-pre-items .cl-cb').forEach(function(cb){ cb.dataset.checked='false'; cb.textContent='\\u2744'; });\n  document.querySelectorAll('#tf-pre-items .cl-item').forEach(function(i){ i.classList.remove('checked'); });\n  document.querySelectorAll('#tf-after-items .cl-cb').forEach(function(cb){ cb.dataset.checked='false'; cb.textContent='\\u2744'; });\n  document.querySelectorAll('#tf-after-items .cl-item').forEach(function(i){ i.classList.remove('checked'); });\n  tfDirection = null; tfOutcome = 'OPEN'; editingTradeId = null;\n  document.querySelectorAll('.tf-dir-btn').forEach(function(b){ b.style.opacity='0.5'; });\n  document.querySelectorAll('.tf-oc-btn').forEach(function(b){ b.style.opacity='0.5'; });\n  var op = document.getElementById('oc-open'); if(op) op.style.opacity='1';\n  document.getElementById('tf-after-section').style.display = 'none';\n  // Set current time\n  var now = new Date();\n  var tt = now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');\n  var te = document.getElementById('tf-time'); if(te) te.value = tt;\n  document.getElementById('cl-form-title').textContent = 'Neuer Trade';\n  document.getElementById('cl-form-time').textContent = new Date().toLocaleString('de-DE');\n}\n\nfunction calcRR() {\n  var entry = parseFloat(document.getElementById('tf-entry').value);\n  var tp = parseFloat(document.getElementById('tf-tp').value);\n  var sl = parseFloat(document.getElementById('tf-sl').value);\n  var el = document.getElementById('tf-rr-display');\n  if(entry && tp && sl && entry !== sl) {\n    var rr = Math.abs(tp - entry) / Math.abs(entry - sl);\n    el.textContent = '1:' + rr.toFixed(2);\n    el.style.color = rr >= 1.5 ? 'var(--gr)' : rr >= 1.0 ? 'var(--am)' : 'var(--rd)';\n  } else { el.textContent = '-'; el.style.color = 'var(--blue3)'; }\n}\n\nfunction renderTradeCard(t, idx) {\n  var oc = t.outcome || 'OPEN';\n  var ocColor = oc==='WIN'?'var(--gr)':oc==='LOSS'?'var(--rd)':oc==='SKIP'?'var(--t3)':'var(--blue3)';\n  var ocTag = oc==='WIN'?'tw':oc==='LOSS'?'tl':oc==='SKIP'?'tsk':'to';\n  var preChecks = t.pre_checks || {};\n  var preTotal = Object.keys(preChecks).length;\n  var preDone = Object.values(preChecks).filter(Boolean).length;\n  var entry = t.entry ? parseFloat(t.entry) : 0;\n  var tp = t.tp ? parseFloat(t.tp) : 0;\n  var sl = t.sl ? parseFloat(t.sl) : 0;\n  var rr = (entry && tp && sl && entry !== sl) ? (Math.abs(tp-entry)/Math.abs(entry-sl)).toFixed(2) : null;\n\n  var h = '<div class=\"card\" style=\"margin-bottom:8px;border-left:3px solid '+(t.direction==='LONG'?'var(--gr)':'var(--rd)')+'\">';\n  h += '<div class=\"ch\">';\n  h += '<div style=\"display:flex;align-items:center;gap:8px\">';\n  h += '<span style=\"font-family:monospace;font-size:.88rem;font-weight:700;color:var(--t1)\">'+(t.symbol||'-')+'</span>';\n  h += '<span class=\"sc-dp '+(t.direction==='LONG'?'dp-long':'dp-short')+'\">'+(t.direction||'-')+'</span>';\n  if(t.timeframe) h += '<span style=\"font-size:.6rem;color:var(--t3);font-family:monospace\">'+t.timeframe+'</span>';\n  h += '</div>';\n  h += '<div style=\"display:flex;align-items:center;gap:8px\">';\n  h += '<span class=\"tg '+ocTag+'\">'+oc+'</span>';\n  h += '<button class=\"btn btn-g\" data-idx=\"'+idx+'\" style=\"font-size:.62rem;padding:3px 8px\" onclick=\"clEditTrade('+idx+')\">&#9998; Bearbeiten</button>';\n  h += '</div></div>';\n  h += '<div class=\"cb\" style=\"padding:10px 14px\">';\n  h += '<div style=\"display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px\">';\n  if(t.time) h += '<div style=\"font-size:.62rem;color:var(--t3)\">&#128336; '+t.time+'</div>';\n  if(entry) h += '<div style=\"font-size:.66rem;font-family:monospace\">E: <strong style=\"color:var(--t2)\">'+entry+'</strong></div>';\n  if(rr) h += '<div style=\"font-size:.66rem;font-family:monospace\">R/R: <strong style=\"color:'+(parseFloat(rr)>=1.5?'var(--gr)':'var(--am)')+'\">1:'+rr+'</strong></div>';\n  if(tp) h += '<div style=\"font-size:.66rem;font-family:monospace;color:var(--gr)\">TP: '+tp+'</div>';\n  if(sl) h += '<div style=\"font-size:.66rem;font-family:monospace;color:var(--rd)\">SL: '+sl+'</div>';\n  if(t.exit_price) h += '<div style=\"font-size:.66rem;font-family:monospace;color:'+ocColor+'\">Exit: '+t.exit_price+'</div>';\n  h += '</div>';\n  if(preDone > 0) h += '<div style=\"font-size:.62rem;color:var(--t3);margin-bottom:6px\">Pre-Check: '+preDone+'/'+preTotal+'</div>';\n  if(t.reason) h += '<div style=\"font-size:.7rem;color:var(--t3);line-height:1.55;margin-bottom:6px;padding:7px 9px;background:var(--bg2);border-radius:6px\">'+t.reason+'</div>';\n  if(t.review) h += '<div style=\"font-size:.7rem;color:var(--am);line-height:1.55;padding:7px 9px;background:rgba(245,158,11,.05);border:1px solid rgba(245,158,11,.1);border-radius:6px\">&#128161; '+t.review+'</div>';\n  h += '</div></div>';\n  return h;\n}\n\nasync function clLoadTrades(date) {\n  var u = localStorage.getItem('wu')||'default';\n  var el = document.getElementById('cl-trades-list');\n  el.innerHTML = '<div class=\"empty\"><p>Lade...</p></div>';\n  try {\n    var rows = await fetch('/checklist?date='+date+'&user='+encodeURIComponent(u)).then(function(r){return r.json();}).catch(function(){return[];});\n    // Morning routine\n    var morning = rows.find(function(r){return r.type==='morning';});\n    if(morning) {\n      try {\n        var md = JSON.parse(morning.data);\n        clSetChecks('ms-items', md.checks);\n        var mn = document.getElementById('ms-notes'); if(mn&&md.notes) mn.value=md.notes;\n        clUpdateMorningStatus();\n      } catch(e){}\n    }\n    // Trades\n    var trades = rows.filter(function(r){return r.type==='trade';});\n    if(!trades.length){ el.innerHTML='<div class=\"empty\"><p>Noch keine Trades heute.<br>Klicke auf \"+ Neuer Trade\" um zu beginnen.</p></div>'; return; }\n    var h = '';\n    trades.forEach(function(row, idx){\n      try { var t = JSON.parse(row.data); h += renderTradeCard(t, idx); } catch(e){}\n    });\n    el.innerHTML = h;\n  } catch(e){ el.innerHTML='<div class=\"empty\"><p>Fehler beim Laden.</p></div>'; }\n}\n\nfunction clEditTrade(idx) {\n  var date = document.getElementById('cl-date').value || new Date().toISOString().slice(0,10);\n  var u = localStorage.getItem('wu')||'default';\n  fetch('/checklist?date='+date+'&user='+encodeURIComponent(u)).then(function(r){return r.json();}).then(function(rows){\n    var trades = rows.filter(function(r){return r.type==='trade';});\n    if(!trades[idx]) return;\n    editingTradeId = trades[idx].id;\n    var t = JSON.parse(trades[idx].data);\n    // Fill form\n    clResetForm();\n    var fields = {symbol:'tf-symbol',timeframe:'tf-timeframe',time:'tf-time',reason:'tf-reason',review:'tf-review',exit_price:'tf-exit'};\n    Object.keys(fields).forEach(function(k){ var el=document.getElementById(fields[k]); if(el&&t[k])el.value=t[k]; });\n    ['tf-entry','tf-tp','tf-sl'].forEach(function(id){ var k=id.replace('tf-',''); var el=document.getElementById(id); if(el&&t[k])el.value=t[k]; });\n    if(t.direction){ tfDirection=t.direction; document.querySelectorAll('.tf-dir-btn').forEach(function(b){ b.style.opacity=b.dataset.dir===t.direction?'1':'0.4'; }); }\n    if(t.pre_checks) clSetChecks('tf-pre-items', t.pre_checks);\n    if(t.after_checks) clSetChecks('tf-after-items', t.after_checks);\n    if(t.outcome && t.outcome!=='OPEN') { document.getElementById('tf-after-section').style.display='block'; }\n    tfOutcome = t.outcome || 'OPEN';\n    document.querySelectorAll('.tf-oc-btn').forEach(function(b){ b.style.opacity=b.dataset.oc===tfOutcome?'1':'0.5'; });\n    calcRR();\n    document.getElementById('cl-form-title').textContent = 'Trade bearbeiten \u2014 '+( t.symbol||'');\n    document.getElementById('cl-trade-form').style.display = 'block';\n    document.getElementById('cl-trade-form').scrollIntoView({behavior:'smooth'});\n  });\n}\n\nasync function clSaveTrade() {\n  var date = document.getElementById('cl-date').value || new Date().toISOString().slice(0,10);\n  var u = localStorage.getItem('wu')||'default';\n  var symbol = (document.getElementById('tf-symbol').value||'').trim().toUpperCase();\n  if(!symbol){ toast('Symbol eingeben!'); return; }\n  if(!tfDirection){ toast('Richtung waehlen!'); return; }\n  var t = {\n    symbol: symbol,\n    direction: tfDirection,\n    timeframe: (document.getElementById('tf-timeframe').value||'').trim(),\n    time: document.getElementById('tf-time').value || '',\n    entry: document.getElementById('tf-entry').value || '',\n    tp: document.getElementById('tf-tp').value || '',\n    sl: document.getElementById('tf-sl').value || '',\n    exit_price: document.getElementById('tf-exit').value || '',\n    reason: document.getElementById('tf-reason').value || '',\n    review: document.getElementById('tf-review').value || '',\n    outcome: tfOutcome,\n    pre_checks: clGetChecks('tf-pre-items'),\n    after_checks: clGetChecks('tf-after-items'),\n    created_at: Date.now()\n  };\n  try {\n    var body = {date, user:u, type:'trade', data:t};\n    if(editingTradeId) body.id = editingTradeId;\n    var r = await fetch('/checklist?secret='+encodeURIComponent(SECRET), {\n      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)\n    }).then(function(r){return r.json();});\n    if(r.status==='ok'){\n      toast('Trade gespeichert!');\n      document.getElementById('cl-trade-form').style.display='none';\n      clLoadTrades(date);\n    } else toast('Fehler: '+JSON.stringify(r));\n  } catch(e){ toast('Fehler: '+e.message); }\n}\n\nasync function clSaveMorning() {\n  var date = document.getElementById('cl-date').value || new Date().toISOString().slice(0,10);\n  var u = localStorage.getItem('wu')||'default';\n  var data = { checks: clGetChecks('ms-items'), notes: (document.getElementById('ms-notes')||{}).value||'' };\n  try {\n    var r = await fetch('/checklist?secret='+encodeURIComponent(SECRET), {\n      method:'POST', headers:{'Content-Type':'application/json'},\n      body:JSON.stringify({date, user:u, type:'morning', data})\n    }).then(function(r){return r.json();});\n    toast(r.status==='ok'?'Morgen-Routine gespeichert!':'Fehler!');\n  } catch(e){ toast('Fehler: '+e.message); }\n}\n\nasync function clLoadHistory() {\n  var u = localStorage.getItem('wu')||'default';\n  var el = document.getElementById('cl-hist-body');\n  el.innerHTML = '<div class=\"empty\"><p>Lade...</p></div>';\n  var rows = await fetch('/checklist/history?user='+encodeURIComponent(u)).then(function(r){return r.json();}).catch(function(){return[];});\n  if(!rows.length){ el.innerHTML='<div class=\"empty\"><p>Noch keine Eintraege.</p></div>'; return; }\n  var byDate = {};\n  rows.forEach(function(r){ if(!byDate[r.date])byDate[r.date]={trades:[]}; try{ if(r.type==='trade')byDate[r.date].trades.push(JSON.parse(r.data)); if(r.type==='morning')byDate[r.date].morning=JSON.parse(r.data); }catch(e){} });\n  var h = '';\n  Object.keys(byDate).sort().reverse().slice(0,30).forEach(function(date){\n    var d = byDate[date];\n    var wins = d.trades.filter(function(t){return t.outcome==='WIN';}).length;\n    var losses = d.trades.filter(function(t){return t.outcome==='LOSS';}).length;\n    var total = d.trades.length;\n    var mDone = d.morning ? Object.values(d.morning.checks||{}).filter(Boolean).length : 0;\n    var mTotal = d.morning ? Object.keys(d.morning.checks||{}).length : 0;\n    h += '<div style=\"background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:7px\">';\n    h += '<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:8px\">';\n    h += '<div style=\"font-size:.82rem;font-weight:700;color:var(--t1)\">'+date+'</div>';\n    h += '<div style=\"display:flex;gap:6px\">';\n    if(wins) h += '<span class=\"tg tw\">'+wins+' WIN</span>';\n    if(losses) h += '<span class=\"tg tl\">'+losses+' LOSS</span>';\n    if(!wins&&!losses&&total) h += '<span class=\"tg to\">'+total+' offen</span>';\n    h += '</div></div>';\n    h += '<div style=\"font-size:.66rem;color:var(--t3);display:flex;gap:12px\">';\n    h += '<span>&#127749; Morgen: '+mDone+'/'+mTotal+'</span>';\n    h += '<span>&#128200; '+total+' Trades</span>';\n    d.trades.forEach(function(t){\n      h += '<span style=\"font-family:monospace;color:'+(t.direction==='LONG'?'var(--gr)':'var(--rd)')+'\">'+t.symbol+'</span>';\n    });\n    h += '</div>';\n    if(d.morning&&d.morning.notes) h += '<div style=\"font-size:.68rem;color:var(--t2);margin-top:6px;font-style:italic\">'+d.morning.notes.slice(0,80)+'</div>';\n    h += '</div>';\n  });\n  el.innerHTML = h;\n}\n\nfunction clInitPage() {\n  var today = new Date().toISOString().slice(0,10);\n  var di = document.getElementById('cl-date');\n  if(di && !di.value) di.value = today;\n  var u = localStorage.getItem('wu')||'default';\n  var ud = document.getElementById('cl-user-disp');\n  if(ud) ud.textContent = u;\n\n  clSetupList('ms-items');\n  clSetupList('tf-pre-items');\n  clSetupList('tf-after-items');\n\n  // Direction buttons\n  document.querySelectorAll('.tf-dir-btn').forEach(function(btn){\n    btn.addEventListener('click', function(){\n      tfDirection = btn.dataset.dir;\n      document.querySelectorAll('.tf-dir-btn').forEach(function(b){ b.style.opacity='0.4'; });\n      btn.style.opacity = '1';\n    });\n  });\n\n  // Outcome buttons\n  document.querySelectorAll('.tf-oc-btn').forEach(function(btn){\n    btn.addEventListener('click', function(){\n      tfOutcome = btn.dataset.oc;\n      document.querySelectorAll('.tf-oc-btn').forEach(function(b){ b.style.opacity='0.5'; });\n      btn.style.opacity = '1';\n      document.getElementById('tf-after-section').style.display = (tfOutcome==='WIN'||tfOutcome==='LOSS') ? 'block' : 'none';\n    });\n  });\n\n  // RR calculation\n  ['tf-entry','tf-tp','tf-sl'].forEach(function(id){ var el=document.getElementById(id); if(el)el.addEventListener('input', calcRR); });\n\n  // Buttons\n  document.getElementById('cl-new-trade-btn').addEventListener('click', function(){\n    clResetForm(); editingTradeId = null;\n    document.getElementById('cl-trade-form').style.display = 'block';\n    document.getElementById('cl-trade-form').scrollIntoView({behavior:'smooth'});\n  });\n  document.getElementById('cl-form-cancel').addEventListener('click', function(){\n    document.getElementById('cl-trade-form').style.display = 'none';\n  });\n  document.getElementById('cl-form-save').addEventListener('click', clSaveTrade);\n  document.getElementById('ms-save').addEventListener('click', clSaveMorning);\n  document.getElementById('cl-load-btn').addEventListener('click', function(){\n    var d = document.getElementById('cl-date').value; if(d) clLoadTrades(d);\n  });\n  document.getElementById('cl-hist-btn').addEventListener('click', function(){\n    clHistVisible = !clHistVisible;\n    document.getElementById('cl-hist-wrap').style.display = clHistVisible ? 'block' : 'none';\n    if(clHistVisible) clLoadHistory();\n  });\n\n  clLoadTrades(today);\n}\n\n// Tab switching\nfunction switchTab(pageId, tabId) {\n  var prefix = pageId + '-';\n  document.querySelectorAll('#pg-'+pageId+' .tab-btn').forEach(function(b){ b.classList.remove('on'); });\n  document.querySelectorAll('#pg-'+pageId+' .tab-pane').forEach(function(p){ p.classList.remove('on'); });\n  var btn = document.querySelector('#pg-'+pageId+' [data-tab=\"'+tabId+'\"]');\n  var pane = document.getElementById('tab-'+tabId);\n  if(btn) btn.classList.add('on');\n  if(pane) pane.classList.add('on');\n  // Load data for tab\n  if(tabId==='signals') lsg();\n  if(tabId==='analyse') ls2();\n  if(tabId==='journal') clInitPage();\n}\n\nvar _goOrig2 = go;\ngo = function(n) {\n  _goOrig2(n);\n  if(n==='trading'){\n    document.querySelectorAll('#pg-trading .tab-btn').forEach(function(b){\n      b.addEventListener('click', function(){ switchTab('trading', b.dataset.tab); });\n    });\n    ls2(); // load analyse by default\n  }\n  if(n==='stats') lbt();\n  if(n==='system'){\n    document.querySelectorAll('#pg-system .tab-btn').forEach(function(b){\n      b.addEventListener('click', function(){ switchTab('system', b.dataset.tab); });\n    });\n  }\n};\n</script>\n</body>\n</html>";
} 
