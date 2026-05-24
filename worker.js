// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.4 - PRODUCTION WORKER
// Signal Processing · Snapshots · Telegram · Backtesting
// ═══════════════════════════════════════════════════════════════

function hashPassword(password) {
  return btoa(password);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-ID"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

const MARKET_RADAR_CACHE_TTL_MS = 20 * 60 * 1000;
const MARKET_RADAR_MAX_EVENTS = 20;
const MARKET_RADAR_FEEDS = [
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed' },
  { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/' },
  { name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/' },
  { name: 'Google News - Bitcoin', url: 'https://news.google.com/rss/search?q=Bitcoin+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - BTC', url: 'https://news.google.com/rss/search?q=BTC+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Crypto Regulation', url: 'https://news.google.com/rss/search?q=crypto+regulation+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Bitcoin ETF', url: 'https://news.google.com/rss/search?q=Bitcoin+ETF+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - SEC Crypto', url: 'https://news.google.com/rss/search?q=SEC+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Stablecoin', url: 'https://news.google.com/rss/search?q=stablecoin+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Crypto Hack', url: 'https://news.google.com/rss/search?q=crypto+hack+exploit+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Binance', url: 'https://news.google.com/rss/search?q=Binance+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Bybit', url: 'https://news.google.com/rss/search?q=Bybit+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - MEXC', url: 'https://news.google.com/rss/search?q=MEXC+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - BloFin', url: 'https://news.google.com/rss/search?q=BloFin+crypto+when:7d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'Google News - Fed CPI Bitcoin', url: 'https://news.google.com/rss/search?q=Fed+CPI+Bitcoin+when:7d&hl=en-US&gl=US&ceid=US:en' }
];

const RADAR_DISCLAIMER = "Nur Marktübersicht. Keine Finanzberatung. Keine Garantie für Gewinne.";
const AI_TIMEOUT_MS = 8000;
const TELEGRAM_TIMEOUT_MS = 5000;

// ═══════════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════════

async function sendTelegramMessage(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log('⚠️ Telegram not configured');
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
    });
    const result = await response.json();
    console.log('📱 Telegram sent:', result.ok);
    return result.ok;
  } catch (error) {
    console.error('❌ Telegram error:', error);
    return false;
  }
}

async function withTimeout(promise, ms, fallbackValue = null) {
  let timeoutId;
  const timeoutPromise = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve(fallbackValue), ms);
  });
  const result = await Promise.race([promise, timeoutPromise]);
  clearTimeout(timeoutId);
  return result;
}

// ─── Signal helper functions ─────────────────────────────────

function tryParseJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (_) { return null; }
}

function getSignalQuality(score) {
  if (score == null || isNaN(score)) return 'UNBEKANNT';
  if (score >= 90) return 'PREMIUM';
  if (score >= 75) return 'GUT';
  if (score >= 60) return 'OKAY';
  if (score >= 45) return 'SCHWACH';
  return 'SKIP';
}

function safePct(target, base) {
  if (!target || !base || base === 0) return null;
  return parseFloat(((Math.abs(target - base) / Math.abs(base)) * 100).toFixed(2));
}

function calcRR(entry, tp, sl, isLong) {
  const e = parseFloat(entry);
  const t = parseFloat(tp);
  const s = parseFloat(sl);
  if (!isFinite(e) || !isFinite(t) || !isFinite(s)) return null;
  const reward = isLong ? t - e : e - t;
  const risk   = isLong ? e - s : s - e;
  if (risk <= 0) return null;
  return parseFloat((reward / risk).toFixed(2));
}

// ─── Telegram formatting ──────────────────────────────────────

function formatSignalForTelegram(signal) {
  const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
  const sc    = signal.ai_score || 0;
  const scoreEmoji = sc >= 90 ? '⭐⭐⭐' : sc >= 75 ? '⭐⭐' : '⭐';
  const quality = signal.signal_quality || getSignalQuality(sc);
  const rrVal   = signal.risk_reward;
  const rrStr   = rrVal ? `1:${rrVal.toFixed(1)}` : 'N/A';
  const fmt     = (v) => v != null && !isNaN(v) ? `$${parseFloat(v).toFixed(2)}` : 'unbekannt';

  const biasLine = signal.daily_bias
    ? `\n📐 Tagesbias: ${signal.daily_bias}${signal.bias_match ? ` · ${signal.bias_match}` : ''}` : '';

  const matched = tryParseJSON(signal.matched_rules) || [];
  const failed  = tryParseJSON(signal.failed_rules)  || [];
  const matchedStr = matched.slice(0, 3).map(r => `✅ ${r}`).join('\n') || '–';
  const failedStr  = failed.slice(0, 3).map(r => `❌ ${r}`).join('\n')  || '–';

  const disclaimer = '\n\n⚠️ <i>Hinweis: Keine Finanzberatung. Signale dienen nur zu Analyse- und Backtesting-Zwecken. Trading birgt Risiko. Keine Garantie für Gewinne.</i>';

  return `${emoji} <b>${signal.symbol}</b> ${signal.direction}

${scoreEmoji} Score: <b>${sc}/100</b> · ${quality}
💰 Entry: ${fmt(signal.ai_entry ?? signal.price)}
🎯 TP: ${fmt(signal.ai_tp)}
🛑 SL: ${fmt(signal.ai_sl)}
⚖️ R:R: ${rrStr}${biasLine}

✅ <b>Erfüllt:</b>
${matchedStr}

❌ <b>Fehlt / Warnung:</b>
${failedStr}

📋 ${signal.ai_reason || 'Signal von TradingView'}${disclaimer}`.trim();
}

// ═══════════════════════════════════════════════════════════════
// STRATEGY SYSTEM
// ═══════════════════════════════════════════════════════════════

// Top-Down Daytrading Strategie v2.0
// Setup A (Pullback) · Setup B (Continuation-Breakout)
// Fokus: BTC/USDT · ETH/USDT · (opt. SOL/USDT) | Entry 5–15min | Bias auf 4H
const DEFAULT_STRATEGY_CONFIG = {
  version: 'v2.0',
  rules: {
    rsi:                { enabled: true, weight: 18 }, // Setup A: oversold/bought; Setup B: trend-range (45-65)
    ema:                { enabled: true, weight: 15 }, // EMA50/200 alignment + EMA200 distance (min 1%)
    trend:              { enabled: true, weight: 10 },
    wave_bias:          { enabled: true, weight: 8  },
    support_resistance: { enabled: true, weight: 10 }, // "Preis in Key-Zone" ist Pflicht in v2.0
    timeframe:          { enabled: true, weight: 7  }, // 5min/15min bevorzugt (Entry-Timeframes)
    confidence:         { enabled: true, weight: 7  },
    session_filter:     { enabled: true, weight: 5  }, // London 07-10 UTC / US-Open 13:30-16 UTC
  },
  thresholds: {
    min_trade_score:    70,
    min_telegram_score: 55,
    max_risk:           'MEDIUM',
    min_rr:             1.5,      // TP1 mind. 1:1.5R laut Strategie
    risk_per_trade_pct: 1.0,      // 1% Risiko pro Trade
    daily_stop_loss_r:  2,        // -2R Daily Stop
    daily_win_stop_r:   3,        // +3R Daily Win-Stop
    max_trades_per_day: 3,
  }
};

// ═══════════════════════════════════════════════════════════════
// AI ANALYSIS
// ═══════════════════════════════════════════════════════════════

// Guard: ensure prompt is a non-empty string before sending to the API.
// Returns the trimmed prompt, or throws with a clear log message.
function requireNonEmptyPrompt(prompt, context = 'AI call') {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    const msg = `❌ [${context}] Blocked: prompt is empty or non-string. Falling back to rule-based analysis.`;
    console.error(msg);
    throw new Error(msg);
  }
  return prompt.trim();
}

async function analyzeSignalWithAI(env, signal, strategyConfig = null) {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('⚠️ No AI API key, using rule-based analysis');
    return analyzeWithRules(signal);
  }
  try {
    const setupType   = String(signal.setup_type || signal.trigger || '').toUpperCase();
    const isSetupB    = setupType.includes('CONTINUATION') || setupType.includes('BREAKOUT') || setupType.includes('SETUP_B');
    const setupLabel  = isSetupB ? 'Setup B – Continuation-Breakout' : 'Setup A – Pullback-Trade';
    const ema200Dist  = signal.price && signal.ema200
      ? ((Math.abs(signal.price - signal.ema200) / signal.ema200) * 100).toFixed(2)
      : 'n/a';
    const priceVsEma200 = signal.price && signal.ema200
      ? (signal.price > signal.ema200 ? 'ABOVE' : 'BELOW')
      : 'n/a';

    const rawPrompt = `Du analysierst ein Trading-Signal nach der Top-Down Daytrading Strategie v2.0.

Strategie-Kontext:
- Setup: ${setupLabel}
- Fokus: BTC/USDT, ETH/USDT (optional SOL/USDT)
- Entry-Timeframes: 5min / 15min | Bias auf 4H
- Bias gilt nur wenn: EMA50/200 Alignment UND Preis klar über/unter EMA200 (min. 1% Abstand)
- Preis direkt am EMA200 (<0.5% Abstand) = Ausschluss
- Setup A (Pullback): RSI überverkauft/überkauft = gut; in Key-Zone; Struktur dreht; Bestätigungs-Pattern
- Setup B (Continuation): Starker 4H-Trend; RSI im Trend-Bereich (45-65 für Long); Konsolidierung bricht in Trendrichtung
- TP gestaffelt: TP1 bei 1:1.5R (50% schließen + SL auf BE), TP2 bei 1:3R
- Bevorzugte Sessions: London (07-10 UTC), US-Open (13:30-16 UTC)
- Ausschluss: Seitwärtsmarkt, R/R < 1:1.5, RSI extrem (>75 / <25), Major News innerhalb 15min

Signal-Daten:
- Symbol: ${signal.symbol || 'UNKNOWN'}
- Richtung: ${signal.direction || 'UNKNOWN'}
- Preis: ${signal.price ?? 0}
- Timeframe: ${signal.timeframe || 'UNKNOWN'}
- Trigger: ${signal.trigger || 'WEBHOOK'}
- RSI: ${signal.rsi ?? 'n/a'}
- EMA50: ${signal.ema50 ?? 'n/a'}
- EMA200: ${signal.ema200 ?? 'n/a'} (Preis ist ${priceVsEma200} dem EMA200, Abstand: ${ema200Dist}%)
- Trend: ${signal.trend || 'n/a'}
- Wave Bias: ${signal.wave_bias || 'n/a'}
- Support: ${signal.support ?? 'n/a'}
- Resistance: ${signal.resistance ?? 'n/a'}
- Konfidenz: ${signal.confidence ?? 'n/a'}%

Bewerte das Signal nach v2.0 Kriterien. Antworte NUR als JSON:
{
  "recommendation": "RECOMMENDED|WAIT|SKIP",
  "score": 0,
  "risk": "LOW|MEDIUM|HIGH",
  "entry": 0,
  "tp": 0,
  "tp2": 0,
  "sl": 0,
  "reason": "Max 100 Zeichen. Setup-Typ + Hauptgrund."
}`;

    const prompt = requireNonEmptyPrompt(rawPrompt, 'analyzeSignalWithAI');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`❌ Anthropic API error ${response.status}:`, errBody);
      return analyzeWithRules(signal, strategyConfig);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text;
    if (!text) {
      console.error('❌ Anthropic API returned empty content block');
      return analyzeWithRules(signal, strategyConfig);
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('AI analysis error:', error);
  }
  return analyzeWithRules(signal, strategyConfig);
}

function analyzeWithRules(signal, strategyConfig = null) {
  const cfg     = strategyConfig || DEFAULT_STRATEGY_CONFIG;
  const dir     = (signal.direction || signal.side || signal.signal || '').toUpperCase();
  const isLong  = dir === 'LONG';
  const isShort = dir === 'SHORT';

  // Detect setup type: Setup A (Pullback) vs Setup B (Continuation-Breakout)
  const setupType = String(signal.setup_type || signal.trigger || '').toUpperCase();
  const isSetupB  = setupType.includes('CONTINUATION') || setupType.includes('BREAKOUT') || setupType.includes('SETUP_B');

  const rW    = cfg.rules?.rsi?.enabled                !== false ? (cfg.rules?.rsi?.weight                ?? 18) : 0;
  const eW    = cfg.rules?.ema?.enabled                !== false ? (cfg.rules?.ema?.weight                ?? 15) : 0;
  const tW    = cfg.rules?.trend?.enabled              !== false ? (cfg.rules?.trend?.weight              ?? 10) : 0;
  const wW    = cfg.rules?.wave_bias?.enabled          !== false ? (cfg.rules?.wave_bias?.weight          ?? 8)  : 0;
  const srW   = cfg.rules?.support_resistance?.enabled !== false ? (cfg.rules?.support_resistance?.weight ?? 10) : 0;
  const sfW   = cfg.rules?.session_filter?.enabled     !== false ? (cfg.rules?.session_filter?.weight     ?? 5)  : 0;
  const tfW   = cfg.rules?.timeframe?.enabled         !== false ? (cfg.rules?.timeframe?.weight          ?? 7)  : 0;
  const cW    = cfg.rules?.confidence?.enabled        !== false ? (cfg.rules?.confidence?.weight         ?? 7)  : 0;

  const matched_rules  = [];
  const failed_rules   = [];
  const unknown_rules  = [];
  const score_breakdown = {};

  // ── RSI (v2.0: Setup A = Pullback, Setup B = Continuation) ────
  // RSI thresholds are configurable via strategy params
  const rsiParams         = cfg.rules?.rsi?.params || {};
  const rsiLower          = rsiParams.lowerBound          ?? 30; // oversold threshold (Setup A LONG)
  const rsiUpper          = rsiParams.upperBound          ?? 70; // overbought threshold (Setup A SHORT)
  const rsiLongMin        = rsiParams.longPreferredAbove  ?? 40; // LONG partial score above this
  const rsiShortMax       = rsiParams.shortPreferredBelow ?? 60; // SHORT partial score below this
  const rsi = signal.rsi != null ? parseFloat(signal.rsi) : null;

  // Start lower when there's no indicator data — prevents empty signals from
  // hitting the Telegram threshold solely via the session-filter bonus.
  const hasIndicatorData = rsi != null
    || (parseFloat(signal.ema50 ?? 0) && parseFloat(signal.ema200 ?? 0))
    || !!(signal.trend || '').trim()
    || !!(signal.wave_bias || '').trim();
  let score = hasIndicatorData ? 50 : 30;
  if (rW > 0) {
    if (rsi == null) {
      unknown_rules.push('RSI (keine Daten)');
      score_breakdown.rsi = 0;
    } else {
      let rsiDelta = 0;
      // Extreme RSI (>75 or <25) always signals reversal risk — not configurable
      if (rsi > 75) {
        if (isLong)  { rsiDelta = -rW; failed_rules.push(`RSI extrem überkauft (${rsi.toFixed(0)}) – Reversal-Risiko, kein LONG`); }
        if (isShort && !isSetupB) { rsiDelta = Math.round(rW * 0.5); matched_rules.push(`RSI extrem überkauft (${rsi.toFixed(0)}) – Setup A SHORT`); }
        if (isShort && isSetupB)  { rsiDelta = -Math.round(rW * 0.5); failed_rules.push(`RSI extrem überkauft (${rsi.toFixed(0)}) – kein Continuation`); }
      } else if (rsi < 25) {
        if (isShort) { rsiDelta = -rW; failed_rules.push(`RSI extrem überverkauft (${rsi.toFixed(0)}) – Reversal-Risiko, kein SHORT`); }
        if (isLong && !isSetupB)  { rsiDelta = Math.round(rW * 0.5); matched_rules.push(`RSI extrem überverkauft (${rsi.toFixed(0)}) – Setup A LONG`); }
        if (isLong && isSetupB)   { rsiDelta = -Math.round(rW * 0.5); failed_rules.push(`RSI extrem überverkauft (${rsi.toFixed(0)}) – kein Continuation`); }
      } else if (isSetupB) {
        // Setup B: RSI in trend range = desired
        const longB_lo = rsiLongMin + 5, longB_hi = rsiUpper - 5;
        const shortB_lo = rsiLower + 5, shortB_hi = rsiShortMax - 5;
        if (isLong) {
          if      (rsi >= longB_lo && rsi <= longB_hi) { rsiDelta = rW;                    matched_rules.push(`RSI ${rsi.toFixed(0)} im Trend-Bereich (${longB_lo}-${longB_hi}) – Setup B LONG`); }
          else if (rsi >= rsiLongMin && rsi < longB_lo){ rsiDelta = Math.round(rW * 0.4);  matched_rules.push(`RSI ${rsi.toFixed(0)} – leicht unter Trend-Bereich`); }
          else if (rsi > longB_hi && rsi <= 75)        { rsiDelta = Math.round(rW * 0.4);  matched_rules.push(`RSI ${rsi.toFixed(0)} – Stärke passt zu Setup B LONG`); }
          else                                         { rsiDelta = -Math.round(rW * 0.3); failed_rules.push(`RSI ${rsi.toFixed(0)} – außerhalb Setup B Bereich`); }
        } else if (isShort) {
          if      (rsi >= shortB_lo && rsi <= shortB_hi){ rsiDelta = rW;                    matched_rules.push(`RSI ${rsi.toFixed(0)} im Trend-Bereich (${shortB_lo}-${shortB_hi}) – Setup B SHORT`); }
          else if (rsi > shortB_hi && rsi <= rsiShortMax){ rsiDelta = Math.round(rW * 0.4); matched_rules.push(`RSI ${rsi.toFixed(0)} – leicht über Trend-Bereich`); }
          else if (rsi >= 25 && rsi < shortB_lo)       { rsiDelta = Math.round(rW * 0.4);  matched_rules.push(`RSI ${rsi.toFixed(0)} – Schwäche passt zu Setup B SHORT`); }
          else                                         { rsiDelta = -Math.round(rW * 0.3); failed_rules.push(`RSI ${rsi.toFixed(0)} – außerhalb Setup B Bereich`); }
        }
      } else {
        // Setup A (Pullback): oversold/overbought logic using configurable thresholds
        if (isLong) {
          if      (rsi < rsiLower)    { rsiDelta = rW;                        matched_rules.push(`RSI überverkauft (${rsi.toFixed(0)}) – Pullback günstig für LONG`); }
          else if (rsi < rsiLongMin)  { rsiDelta = Math.round(rW * 0.56);    matched_rules.push(`RSI niedrig (${rsi.toFixed(0)}) – passt zu Setup A LONG`); }
          else if (rsi < 50)          { rsiDelta = Math.round(rW * 0.22);    matched_rules.push(`RSI neutral-niedrig (${rsi.toFixed(0)})`); }
          else if (rsi > rsiUpper)    { rsiDelta = -rW;                       failed_rules.push(`RSI überkauft (${rsi.toFixed(0)}) – kein Pullback-Entry`); }
          else if (rsi > rsiShortMax) { rsiDelta = -Math.round(rW * 0.33);   failed_rules.push(`RSI hoch (${rsi.toFixed(0)}) – Vorsicht bei LONG`); }
          else                        {                                        matched_rules.push(`RSI neutral (${rsi.toFixed(0)})`); }
        } else if (isShort) {
          if      (rsi > rsiUpper)    { rsiDelta = rW;                        matched_rules.push(`RSI überkauft (${rsi.toFixed(0)}) – Pullback günstig für SHORT`); }
          else if (rsi > rsiShortMax) { rsiDelta = Math.round(rW * 0.56);    matched_rules.push(`RSI hoch (${rsi.toFixed(0)}) – passt zu Setup A SHORT`); }
          else if (rsi > 50)          { rsiDelta = Math.round(rW * 0.22);    matched_rules.push(`RSI neutral-hoch (${rsi.toFixed(0)})`); }
          else if (rsi < rsiLower)    { rsiDelta = -rW;                       failed_rules.push(`RSI überverkauft (${rsi.toFixed(0)}) – kein Pullback-Entry`); }
          else if (rsi < rsiLongMin)  { rsiDelta = -Math.round(rW * 0.33);   failed_rules.push(`RSI niedrig (${rsi.toFixed(0)}) – Vorsicht bei SHORT`); }
          else                        {                                        matched_rules.push(`RSI neutral (${rsi.toFixed(0)})`); }
        }
      }
      score += rsiDelta;
      score_breakdown.rsi = rsiDelta;
    }
  }

  // ── EMA v2.0: alignment + EMA200 distance (≥1% required) ─────
  // Bias gilt nur wenn: EMA50/200 Alignment UND Preis klar über/unter EMA200 (>1%)
  // Preis direkt am EMA200 (<0.5%) → Ausschlusskriterium
  const ema50  = parseFloat(signal.ema50  ?? 0);
  const ema200 = parseFloat(signal.ema200 ?? 0);
  const priceForEma = parseFloat(signal.price ?? 0);
  if (eW > 0) {
    if (!ema50 || !ema200) {
      unknown_rules.push('EMA 50/200 (keine Daten)');
      score_breakdown.ema = 0;
    } else {
      const bullish       = ema50 > ema200;
      const ema200Dist    = priceForEma && ema200 ? Math.abs(priceForEma - ema200) / ema200 : 0;
      const aboveEma200   = priceForEma > ema200;
      let emaDelta = 0;

      // EMA200 distance check (v2.0: min 1% Abstand, <0.5% = Ausschluss)
      if (priceForEma && ema200Dist < 0.005) {
        // Price within 0.5% of EMA200 → exclusion criterion
        emaDelta = -Math.round(eW * 0.8);
        failed_rules.push(`Preis zu nah an EMA 200 (${(ema200Dist*100).toFixed(2)}%) – Ausschluss v2.0`);
      } else {
        // EMA50/200 alignment
        if (isLong  && bullish)  {
          const distBonus = ema200Dist > 0.03 ? eW : ema200Dist > 0.01 ? Math.round(eW * 0.7) : Math.round(eW * 0.4);
          emaDelta = distBonus;
          matched_rules.push(`EMA bullish (EMA50>EMA200, Dist ${(ema200Dist*100).toFixed(1)}%) – LONG`);
        } else if (isShort && !bullish) {
          const distBonus = ema200Dist > 0.03 ? eW : ema200Dist > 0.01 ? Math.round(eW * 0.7) : Math.round(eW * 0.4);
          emaDelta = distBonus;
          matched_rules.push(`EMA bearish (EMA50<EMA200, Dist ${(ema200Dist*100).toFixed(1)}%) – SHORT`);
        } else if (isLong  && !bullish) {
          emaDelta = -eW;
          failed_rules.push('EMA bearish – Trend gegen LONG, kein Bias');
        } else if (isShort && bullish)  {
          emaDelta = -eW;
          failed_rules.push('EMA bullish – Trend gegen SHORT, kein Bias');
        }
        // Additional EMA200 position check
        if (isLong && !aboveEma200 && priceForEma) {
          emaDelta -= Math.round(eW * 0.4);
          failed_rules.push('Preis unter EMA 200 – kein Long-Bias nach v2.0');
        } else if (isShort && aboveEma200 && priceForEma) {
          emaDelta -= Math.round(eW * 0.4);
          failed_rules.push('Preis über EMA 200 – kein Short-Bias nach v2.0');
        }
      }
      score += emaDelta;
      score_breakdown.ema = emaDelta;
    }
  }

  // ── Trend label ──────────────────────────────────────────────
  const trend = (signal.trend || '').toUpperCase();
  if (tW > 0) {
    if (!trend) {
      unknown_rules.push('Trend-Label (keine Daten)');
      score_breakdown.trend = 0;
    } else {
      let tDelta = 0;
      if (trend === 'BULLISH' || trend === 'UP') {
        tDelta = isLong ? tW : -tW;
        if (isLong)  matched_rules.push('Trend BULLISH – passt zu LONG');
        else         failed_rules.push('Trend BULLISH – gegen SHORT');
      } else if (trend === 'BEARISH' || trend === 'DOWN') {
        tDelta = isShort ? tW : -tW;
        if (isShort) matched_rules.push('Trend BEARISH – passt zu SHORT');
        else         failed_rules.push('Trend BEARISH – gegen LONG');
      } else {
        unknown_rules.push(`Trend unklar (${trend})`);
      }
      score += tDelta;
      score_breakdown.trend = tDelta;
    }
  }

  // ── Wave bias ────────────────────────────────────────────────
  const waveBias = (signal.wave_bias || '').toUpperCase();
  if (wW > 0) {
    if (!waveBias) {
      unknown_rules.push('Wave Bias (keine Daten)');
      score_breakdown.wave_bias = 0;
    } else {
      let wDelta = 0;
      if (waveBias === 'LONG') {
        wDelta = isLong ? wW : -Math.round(wW * 0.5);
        if (isLong)  matched_rules.push('Wave Bias LONG – passt zu LONG');
        else         failed_rules.push('Wave Bias LONG – gegen SHORT');
      } else if (waveBias === 'SHORT') {
        wDelta = isShort ? wW : -Math.round(wW * 0.5);
        if (isShort) matched_rules.push('Wave Bias SHORT – passt zu SHORT');
        else         failed_rules.push('Wave Bias SHORT – gegen LONG');
      }
      score += wDelta;
      score_breakdown.wave_bias = wDelta;
    }
  }

  // ── Timeframe (v2.0: 5min/15min = Entry-TF, volle Wertung) ───
  if (tfW > 0) {
    const tf = String(signal.timeframe || '').replace('m','').replace('h','H');
    let tfDelta = 0;
    if      (['5','15'].includes(tf))             { tfDelta = tfW;                    matched_rules.push(`Timeframe ${tf}min – Entry-Timeframe v2.0`); }
    else if (['1','3'].includes(tf))              { tfDelta = Math.round(tfW * 0.6);  matched_rules.push(`Timeframe ${tf}min – kurz, aber gültig`); }
    else if (['30','60','1H'].includes(tf))       { tfDelta = Math.round(tfW * 0.3);  matched_rules.push(`Timeframe ${tf} – höherer TF, Entry bevorzugt auf 5/15min`); }
    else if (['240','4H'].includes(tf))           { tfDelta = Math.round(tfW * 0.2);  matched_rules.push(`Timeframe ${tf} – Bias-TF, kein Entry-TF`); }
    else if (tf)                                  {                                    failed_rules.push(`Timeframe ${tf} – unbekannt`); }
    else                                          { unknown_rules.push('Timeframe (keine Daten)'); }
    score += tfDelta;
    score_breakdown.timeframe = tfDelta;
  }

  // ── Confidence ───────────────────────────────────────────────
  if (cW > 0) {
    const confidence = parseFloat(signal.confidence ?? -1);
    if (confidence < 0) {
      unknown_rules.push('Konfidenz (keine Daten)');
      score_breakdown.confidence = 0;
    } else {
      let cDelta = 0;
      if      (confidence >= 80) { cDelta = cW;                    matched_rules.push(`Konfidenz ${confidence}% – hoch`); }
      else if (confidence >= 60) { cDelta = Math.round(cW * 0.5); matched_rules.push(`Konfidenz ${confidence}% – mittel`); }
      else                       {                                  failed_rules.push(`Konfidenz ${confidence}% – niedrig`); }
      score += cDelta;
      score_breakdown.confidence = cDelta;
    }
  }

  // ── Support / Resistance proximity ───────────────────────────
  const price      = parseFloat(signal.price ?? 0);
  const support    = parseFloat(signal.support ?? 0);
  const resistance = parseFloat(signal.resistance ?? 0);
  if (srW > 0) {
    let srDelta = 0;
    if (!price) {
      unknown_rules.push('Support/Resistance (kein Preis)');
      score_breakdown.support_resistance = 0;
    } else if (!support && !resistance) {
      unknown_rules.push('Support/Resistance (keine Zonen)');
      score_breakdown.support_resistance = 0;
    } else {
      if (price && support && isLong && price > support) {
        if ((price - support) / price < 0.02) { srDelta = srW; matched_rules.push('Preis nah an Support – günstig für LONG'); }
        else { failed_rules.push('Preis zu weit von Support entfernt'); }
      } else if (price && resistance && isShort && price < resistance) {
        if ((resistance - price) / price < 0.02) { srDelta = srW; matched_rules.push('Preis nah an Resistance – günstig für SHORT'); }
        else { failed_rules.push('Preis zu weit von Resistance entfernt'); }
      } else {
        failed_rules.push('Preis nicht in Key-Zone');
      }
      score += srDelta;
      score_breakdown.support_resistance = srDelta;
    }
  }

  // ── Session filter (v2.0: London 07-10 UTC, US-Open 13:30-16 UTC) ──
  if (sfW > 0) {
    const utcHour = new Date().getUTCHours();
    const utcMin  = new Date().getUTCMinutes();
    const utcTime = utcHour * 60 + utcMin;
    const inLondon  = utcTime >= 7*60     && utcTime <= 10*60;
    const inUSOpen  = utcTime >= 13*60+30 && utcTime <= 16*60;
    if (inLondon) {
      score += sfW;
      score_breakdown.session_filter = sfW;
      matched_rules.push('London-Open Session (07-10 UTC) – bevorzugte Zeit');
    } else if (inUSOpen) {
      score += sfW;
      score_breakdown.session_filter = sfW;
      matched_rules.push('US-Open Session (13:30-16 UTC) – bevorzugte Zeit');
    } else {
      score_breakdown.session_filter = 0;
      unknown_rules.push('Außerhalb bevorzugter Sessions (London/US-Open)');
    }
  }

  // ── Clamp ────────────────────────────────────────────────────
  score = Math.max(0, Math.min(100, Math.round(score)));

  // ── Recommendation ───────────────────────────────────────────
  const minTrade    = cfg.thresholds?.min_trade_score    ?? 70;
  const minTelegram = cfg.thresholds?.min_telegram_score ?? 55;

  let recommendation, risk;
  if (score >= minTrade) {
    recommendation = dir || 'RECOMMENDED';
    risk = score >= minTrade + 12 ? 'LOW' : 'MEDIUM';
  } else if (score >= minTelegram) {
    recommendation = 'WAIT';
    risk = 'MEDIUM';
  } else {
    recommendation = 'SKIP';
    risk = 'HIGH';
  }

  // ── TP / SL (v2.0: TP1 = 1.5R, TP2 = 3R) ────────────────────
  const entry   = price || 0;
  // SL: 1% distance; TP: 1.5x SL distance (TP1 target)
  const slDist  = entry * 0.01;
  const tp      = isLong  ? entry + slDist * 1.5 : entry - slDist * 1.5;
  const sl      = isLong  ? entry - slDist       : entry + slDist;
  const tp2     = isLong  ? entry + slDist * 3   : entry - slDist * 3;

  // ── Reason ───────────────────────────────────────────────────
  const reasons = [];
  const setupLabel = isSetupB ? 'Setup B (Continuation)' : 'Setup A (Pullback)';
  reasons.push(setupLabel);
  if (rsi != null && (rsi < 35 || rsi > 65)) reasons.push(`RSI ${rsi.toFixed(0)}`);
  if (ema50 && ema200) reasons.push(`EMA ${ema50 > ema200 ? 'bullish' : 'bearish'}`);
  if (trend)    reasons.push(`Trend: ${trend}`);
  if (waveBias) reasons.push(`Bias: ${waveBias}`);
  const reason = reasons.join(' · ');

  // ── R:R & quality ────────────────────────────────────────────
  const risk_reward        = calcRR(entry, tp, sl, isLong);
  const planned_profit_pct = safePct(tp, entry);
  const planned_risk_pct   = safePct(sl, entry);
  const signal_quality     = getSignalQuality(score);

  return {
    recommendation, score, risk, entry, tp, sl, tp2, reason, direction: dir,
    matched_rules, failed_rules, unknown_rules, score_breakdown,
    risk_reward, planned_profit_pct, planned_risk_pct, signal_quality,
    setup_type: isSetupB ? 'SETUP_B' : 'SETUP_A',
  };
}

// ═══════════════════════════════════════════════════════════════
// DB INITIALIZATION
// ═══════════════════════════════════════════════════════════════

// Module-level flag: run the full CREATE/ALTER sequence only once per Worker
// instance to avoid hammering D1 with ~70 statements on every request.
let _tablesReady = false;

async function ensureTables(env) {
  if (_tablesReady) return;
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        symbol TEXT,
        timeframe TEXT,
        price REAL,
        direction TEXT,
        trigger TEXT,
        ai_recommendation TEXT,
        ai_score INTEGER,
        ai_risk TEXT,
        ai_entry REAL,
        ai_tp REAL,
        ai_sl REAL,
        ai_reason TEXT,
        rule_score INTEGER,
        rule_reason TEXT,
        exit_price REAL,
        outcome TEXT DEFAULT 'OPEN',
        created_at INTEGER,
        updated_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        timeframe TEXT,
        price REAL,
        rsi REAL,
        ema50 REAL,
        ema200 REAL,
        support REAL,
        resistance REAL,
        trend TEXT,
        trend_1h TEXT,
        trend_4h TEXT,
        created_at TEXT
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS practice_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT,
        symbol TEXT,
        timeframe TEXT,
        direction TEXT,
        entry_price REAL,
        take_profit REAL,
        stop_loss REAL,
        status TEXT DEFAULT 'OPEN',
        exit_price REAL,
        result_pct REAL,
        created_at TEXT,
        closed_at TEXT
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS checklists (
        id TEXT PRIMARY KEY,
        date TEXT,
        user TEXT,
        type TEXT,
        data TEXT,
        created_at INTEGER,
        updated_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT,
        email TEXT,
        password_hash TEXT,
        role TEXT DEFAULT 'user',
        must_change_password INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT DEFAULT 'v1.0',
        active INTEGER DEFAULT 0,
        is_default INTEGER DEFAULT 0,
        protected INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        config_json TEXT
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS signal_loss_reasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id TEXT NOT NULL,
        strategy_id TEXT,
        reason TEXT NOT NULL,
        note TEXT,
        created_at INTEGER,
        created_by TEXT
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS market_events (
        id TEXT PRIMARY KEY,
        created_at INTEGER,
        updated_at INTEGER,
        event_time INTEGER,
        title TEXT,
        category TEXT,
        impact TEXT,
        affected_markets TEXT,
        source TEXT,
        source_url TEXT,
        summary TEXT,
        radar_status TEXT,
        raw_json TEXT,
        long_text TEXT,
        affected_symbols TEXT,
        affected_scope TEXT,
        status TEXT DEFAULT 'ACTIVE'
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS morning_routines (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT 'BTCUSDT',
        bias TEXT,
        chart_opened INTEGER DEFAULT 0,
        ema200_checked INTEGER DEFAULT 0,
        ema_direction TEXT,
        key_zones_marked INTEGER DEFAULT 0,
        zone_notes TEXT,
        bias_reason TEXT,
        completed_at INTEGER,
        created_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS pre_trade_checklists (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        signal_id TEXT,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT 'BTCUSDT',
        bias_match INTEGER DEFAULT 0,
        in_key_zone INTEGER DEFAULT 0,
        structure_confirmed INTEGER DEFAULT 0,
        no_chop INTEGER DEFAULT 0,
        trend_candle INTEGER DEFAULT 0,
        break_confirmed INTEGER DEFAULT 0,
        rsi_ok INTEGER DEFAULT 0,
        rsi_not_extreme INTEGER DEFAULT 0,
        sl_logical INTEGER DEFAULT 0,
        rr_ok INTEGER DEFAULT 0,
        can_explain INTEGER DEFAULT 0,
        clear_minded INTEGER DEFAULT 0,
        no_fomo INTEGER DEFAULT 0,
        notes TEXT,
        created_at INTEGER
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS trade_reviews (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        signal_id TEXT,
        date TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT 'BTCUSDT',
        instrument TEXT,
        direction TEXT,
        entry REAL,
        stop_loss REAL,
        take_profit REAL,
        exit_price REAL,
        outcome TEXT,
        realized_rr REAL,
        bias_clear INTEGER DEFAULT 0,
        bias_direction TEXT,
        in_key_zone INTEGER DEFAULT 0,
        structure_hl_lh INTEGER DEFAULT 0,
        trend_candle_clean INTEGER DEFAULT 0,
        break_confirmed INTEGER DEFAULT 0,
        rsi_ok INTEGER DEFAULT 0,
        sl_logical INTEGER DEFAULT 0,
        rr_acceptable INTEGER DEFAULT 0,
        what_went_well TEXT,
        what_went_wrong TEXT,
        discipline TEXT,
        mood_before TEXT,
        no_fomo INTEGER DEFAULT 0,
        sl_not_moved INTEGER DEFAULT 0,
        tp_not_closed_early INTEGER DEFAULT 0,
        no_revenge INTEGER DEFAULT 0,
        lesson TEXT,
        would_take_again INTEGER DEFAULT 0,
        followed_plan INTEGER DEFAULT 0,
        waited_confirmation INTEGER DEFAULT 0,
        felt_confident INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER
      )
    `).run();

    // Migrate journal tables — add symbol column (safe, duplicate-protected)
    for (const tbl of ['morning_routines', 'pre_trade_checklists', 'trade_reviews']) {
      try { await env.DB.prepare(`ALTER TABLE ${tbl} ADD COLUMN symbol TEXT NOT NULL DEFAULT 'BTCUSDT'`).run(); } catch (_) {}
    }

    // Migrate signals table
    const stratCols = [
      ['strategy_id',           'TEXT'],
      ['strategy_name',         'TEXT'],
      ['strategy_version',      'TEXT'],
      ['is_test',               'INTEGER DEFAULT 0'],
      ['telegram_sent',         'INTEGER DEFAULT 0'],
      ['telegram_reason',       'TEXT'],
      ['source',                'TEXT'],
      ['pnl_pct',               'REAL'],
      ['closed_at',             'INTEGER'],
      ['outcome_source',        'TEXT'],
      ['telegram_outcome_sent', 'INTEGER DEFAULT 0'],
      ['admin_note',            'TEXT'],
      ['manual_reason',         'TEXT'],
      ['updated_at',            'INTEGER'],
      ['exit_price',            'REAL'],
    ];
    for (const [col, type] of stratCols) {
      try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    // Migrate signals table — technical indicator + scoring columns
    const signalIndicatorCols = [
      ['action',               'TEXT'],
      ['rsi',                  'REAL'],
      ['ema50',                'REAL'],
      ['ema200',               'REAL'],
      ['trend',                'TEXT'],
      ['support',              'REAL'],
      ['resistance',           'REAL'],
      ['wave_bias',            'TEXT'],
      ['ai_direction',         'TEXT'],
      ['ai_confidence',        'REAL'],
      ['matched_rules',        'TEXT'],
      ['failed_rules',         'TEXT'],
      ['unknown_rules',        'TEXT'],
      ['score_breakdown',      'TEXT'],
      ['signal_quality',       'TEXT'],
      ['risk_reward',          'REAL'],
      ['planned_profit_pct',   'REAL'],
      ['planned_risk_pct',     'REAL'],
      ['trigger_reason',       'TEXT'],
      ['disclaimer_shown',     'INTEGER DEFAULT 0'],
      ['daily_bias',           'TEXT'],
      ['bias_match',           'TEXT'],
      ['before_morning_routine','INTEGER DEFAULT 0'],
      ['counts_for_strategy',  'INTEGER DEFAULT 0'],
    ];
    for (const [col, type] of signalIndicatorCols) {
      try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    // Migrate users table
    const userCols = [
      ['skip_password_change', 'INTEGER DEFAULT 0'],
      ['blocked',              'INTEGER DEFAULT 0'],
      ['last_seen',            'INTEGER'],
    ];
    for (const [col, type] of userCols) {
      try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    // Migrate snapshots table (compat with unique symbol snapshots)
    const snapshotCols = [
      ['timeframe',  'TEXT'],
      ['price',      'REAL'],
      ['rsi',        'REAL'],
      ['ema50',      'REAL'],
      ['ema200',     'REAL'],
      ['support',    'REAL'],
      ['resistance', 'REAL'],
      ['trend',      'TEXT'],
      ['trend_1h',   'TEXT'],
      ['trend_4h',   'TEXT'],
      ['direction',  'TEXT'],
      ['trigger',    'TEXT'],
      ['strength',   'TEXT'],
      ['timestamp',  'TEXT'],
      ['raw_signal', 'TEXT'],
      ['created_at', 'TEXT'],
      ['updated_at', 'TEXT'],
    ];
    for (const [col, type] of snapshotCols) {
      try { await env.DB.prepare(`ALTER TABLE snapshots ADD COLUMN ${col} ${type}`).run(); }
      catch (_) {}
    }

    _tablesReady = true;
  } catch (error) {
    console.error('❌ ensureTables error:', error.message);
  }
}

// ─── Strategy helpers ────────────────────────────────────────

async function getActiveStrategy(env) {
  try {
    const strategy = await env.DB.prepare(
      `SELECT * FROM strategies WHERE active = 1 ORDER BY updated_at DESC LIMIT 1`
    ).first();
    if (!strategy) return null;
    return { ...strategy, config: strategy.config_json ? JSON.parse(strategy.config_json) : DEFAULT_STRATEGY_CONFIG };
  } catch (_) { return null; }
}

async function initDefaultStrategy(env) {
  try {
    const id = 'strategy_default';
    const existing = await env.DB.prepare(`SELECT id FROM strategies WHERE id = ?`).bind(id).first();
    if (existing) {
      await env.DB.prepare(`UPDATE strategies SET active = 1 WHERE id = ?`).bind(id).run();
      return { id, name: 'WAVESCOUT Standard', version: 'v1.0', config: DEFAULT_STRATEGY_CONFIG };
    }
    await env.DB.prepare(`
      INSERT INTO strategies (id, name, version, active, is_default, protected, created_at, updated_at, config_json)
      VALUES (?, 'WAVESCOUT Standard', 'v1.0', 1, 1, 1, ?, ?, ?)
    `).bind(id, Date.now(), Date.now(), JSON.stringify(DEFAULT_STRATEGY_CONFIG)).run();
    return { id, name: 'WAVESCOUT Standard', version: 'v1.0', config: DEFAULT_STRATEGY_CONFIG };
  } catch (e) {
    console.error('initDefaultStrategy error:', e.message);
    return null;
  }
}

// ─── Settings helpers ─────────────────────────────────────────

async function getSetting(env, key, defaultValue = null) {
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first();
    return row ? row.value : defaultValue;
  } catch (_) { return defaultValue; }
}

async function setSetting(env, key, value) {
  try {
    await env.DB.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(key, String(value), Date.now()).run();
  } catch (_) {}
}

// ─── Live price (Binance public API, snapshot fallback) ───────

async function getLivePrice(env, symbol) {
  // 1. Try Binance
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (res.ok) {
      const data = await res.json();
      if (data?.price) return parseFloat(data.price);
    }
  } catch (_) {}

  // 2. Fallback: Bybit (covers NAS100USDT, XAUTUSDT, RIVERUSDT etc. not listed on Binance)
  try {
    const res = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`);
    if (res.ok) {
      const data = await res.json();
      const price = data?.result?.list?.[0]?.lastPrice;
      if (price) return parseFloat(price);
    }
  } catch (_) {}

  // 3. Last resort: latest snapshot price
  const snap = await getSnapshot(env, symbol, '5m');
  return snap?.price || null;
}

// ─── Duration formatter ───────────────────────────────────────

function formatDuration(ms) {
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ═══════════════════════════════════════════════════════════════
// SNAPSHOT HANDLING
// ═══════════════════════════════════════════════════════════════

async function saveSnapshot(env, data) {
  console.log('📸 Saving snapshot:', data.symbol, data.timeframe, 'price:', data.price);

  await ensureTables(env);
  const nowIso = new Date().toISOString();
  const symbol = data.symbol || 'UNKNOWN';
  const tf     = String(data.timeframe || '5');
  const rawSignal = JSON.stringify(data);

  // Use UPDATE first, INSERT only if no existing row for this symbol+timeframe.
  // D1 has no UNIQUE constraint on snapshots(symbol) so ON CONFLICT would fail.
  const existing = await env.DB.prepare(
    `SELECT id FROM snapshots WHERE symbol = ? AND timeframe = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(symbol, tf).first();

  if (existing) {
    await env.DB.prepare(`
      UPDATE snapshots SET
        price = ?, rsi = ?, ema50 = ?, ema200 = ?,
        support = ?, resistance = ?, trend = ?, trend_1h = ?, trend_4h = ?,
        direction = ?, trigger = ?, strength = ?, timestamp = ?,
        raw_signal = ?, updated_at = ?
      WHERE id = ?
    `).bind(
      data.price || 0, data.rsi ?? null, data.ema50 ?? null, data.ema200 ?? null,
      data.support ?? null, data.resistance ?? null, data.trend || null,
      data.trend_1h || null, data.trend_4h || null,
      data.direction || null, data.trigger || null, data.strength || null,
      data.timestamp || nowIso, rawSignal, nowIso,
      existing.id
    ).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO snapshots (
        symbol, timeframe, price, rsi, ema50, ema200,
        support, resistance, trend, trend_1h, trend_4h,
        direction, trigger, strength, timestamp, raw_signal, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      symbol, tf,
      data.price || 0, data.rsi ?? null, data.ema50 ?? null, data.ema200 ?? null,
      data.support ?? null, data.resistance ?? null, data.trend || null,
      data.trend_1h || null, data.trend_4h || null,
      data.direction || null, data.trigger || null, data.strength || null,
      data.timestamp || nowIso, rawSignal, nowIso, nowIso
    ).run();
  }

  if (data.price && data.symbol) {
    await checkPracticeTrades(env, data.symbol, data.price);
  }

  console.log('✅ Snapshot saved:', symbol);
  return { ok: true, type: 'SNAPSHOT', message: 'Snapshot saved', symbol };
}

// ═══════════════════════════════════════════════════════════════
// PRACTICE TRADES
// ═══════════════════════════════════════════════════════════════

async function createPracticeTrade(env, signalId, signal, analysis) {
  try {
    const direction = signal.direction;
    if (!direction || direction === 'NONE') return null;

    const entryPrice = analysis.entry || signal.price || 0;
    const takeProfit = analysis.tp || 0;
    const stopLoss   = analysis.sl || 0;

    if (!entryPrice || !takeProfit || !stopLoss) {
      console.log('⚠️ Practice trade skipped: missing entry/tp/sl');
      return null;
    }

    await env.DB.prepare(`
      INSERT INTO practice_trades (
        signal_id, symbol, timeframe, direction,
        entry_price, take_profit, stop_loss, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)
    `).bind(
      signalId,
      signal.symbol || 'UNKNOWN',
      String(signal.timeframe || '5'),
      direction,
      entryPrice,
      takeProfit,
      stopLoss,
      new Date().toISOString()
    ).run();

    console.log('📝 Practice trade created for signal:', signalId);
  } catch (error) {
    console.error('❌ createPracticeTrade error:', error.message);
  }
}

async function checkPracticeTrades(env, symbol, currentPrice) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
    ).first();
    if (!tableCheck) return;

    const openTrades = await env.DB.prepare(
      `SELECT * FROM practice_trades WHERE symbol = ? AND status = 'OPEN'`
    ).bind(symbol).all();

    for (const trade of (openTrades.results || [])) {
      let newStatus = null;

      if (trade.direction === 'LONG') {
        if (currentPrice >= trade.take_profit) newStatus = 'WIN';
        else if (currentPrice <= trade.stop_loss) newStatus = 'LOSS';
      } else if (trade.direction === 'SHORT') {
        if (currentPrice <= trade.take_profit) newStatus = 'WIN';
        else if (currentPrice >= trade.stop_loss) newStatus = 'LOSS';
      }

      if (newStatus) {
        const resultPct = trade.direction === 'LONG'
          ? ((currentPrice - trade.entry_price) / trade.entry_price) * 100
          : ((trade.entry_price - currentPrice) / trade.entry_price) * 100;

        await env.DB.prepare(`
          UPDATE practice_trades SET status = ?, exit_price = ?, result_pct = ?, closed_at = ?
          WHERE id = ?
        `).bind(newStatus, currentPrice, parseFloat(resultPct.toFixed(2)), new Date().toISOString(), trade.id).run();

        console.log(`📊 Practice trade #${trade.id} closed: ${newStatus} (${resultPct.toFixed(2)}%)`);
      }
    }
  } catch (error) {
    console.error('❌ checkPracticeTrades error:', error.message);
  }
}

async function getPracticeTrades(env, { symbol, timeframe, direction, status, limit = 100 } = {}) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
    ).first();
    if (!tableCheck) return [];

    let query = 'SELECT * FROM practice_trades WHERE 1=1';
    const params = [];

    if (symbol    && symbol    !== 'all') { query += ' AND symbol = ?';    params.push(symbol); }
    if (timeframe && timeframe !== 'all') { query += ' AND timeframe = ?'; params.push(timeframe); }
    if (direction && direction !== 'all') { query += ' AND direction = ?'; params.push(direction); }
    if (status    && status    !== 'all') { query += ' AND status = ?';    params.push(status); }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = await env.DB.prepare(query).bind(...params).all();
    return rows.results || [];
  } catch (error) {
    console.error('❌ getPracticeTrades error:', error.message);
    return [];
  }
}

async function getPracticeTradeStats(env) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
    ).first();
    if (!tableCheck) return { total: 0, open: 0, wins: 0, losses: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0 };

    const total   = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades`).first();
    const open    = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='OPEN'`).first();
    const wins    = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='WIN'`).first();
    const losses  = await env.DB.prepare(`SELECT COUNT(*) as c FROM practice_trades WHERE status='LOSS'`).first();
    const avgWin  = await env.DB.prepare(`SELECT AVG(result_pct) as a FROM practice_trades WHERE status='WIN'`).first();
    const avgLoss = await env.DB.prepare(`SELECT AVG(result_pct) as a FROM practice_trades WHERE status='LOSS'`).first();

    const closed  = (wins.c || 0) + (losses.c || 0);
    const winRate = closed > 0 ? ((wins.c / closed) * 100) : 0;

    return {
      total: total.c || 0,
      open: open.c || 0,
      wins: wins.c || 0,
      losses: losses.c || 0,
      winRate: parseFloat(winRate.toFixed(1)),
      avgWinPct: parseFloat((avgWin.a || 0).toFixed(2)),
      avgLossPct: parseFloat((avgLoss.a || 0).toFixed(2))
    };
  } catch (error) {
    console.error('❌ getPracticeTradeStats error:', error.message);
    return { total: 0, open: 0, wins: 0, losses: 0, winRate: 0, avgWinPct: 0, avgLossPct: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL PROCESSING
// ═══════════════════════════════════════════════════════════════

function normalizeDirection(payload) {
  const candidates = [payload.direction, payload.side, payload.signal, payload.action, payload.trigger];
  for (const c of candidates) {
    const v = String(c || '').toUpperCase();
    if (v === 'LONG' || v === 'BUY')   return 'LONG';
    if (v === 'SHORT' || v === 'SELL') return 'SHORT';
  }
  return null;
}

function normalizeAction(payload) {
  const raw = String(payload.action || payload.trigger || '').toUpperCase();
  if (raw === 'BUY'  || raw === 'LONG')  return 'BUY';
  if (raw === 'SELL' || raw === 'SHORT') return 'SELL';
  return raw || null;
}

async function processSignal(env, signal) {
  const direction = normalizeDirection(signal);
  const action    = normalizeAction(signal);
  signal.direction = direction;

  console.log('📊 Processing signal:', signal.symbol, direction, '| action:', action, '| rsi:', signal.rsi);

  // For low-value assets (price < $10), TradingView sometimes rounds to 2 dp
  // (e.g. TRX: 0.36 instead of 0.3621). Fetch a precise live price so that
  // the TP/SL levels are calculated from an accurate entry.
  if (signal.price && signal.price < 10 && parseFloat(signal.price.toFixed(2)) === signal.price) {
    const livePrice = await getLivePrice(env, signal.symbol);
    if (livePrice && Math.abs(livePrice - signal.price) / signal.price < 0.05) {
      console.log(`🔬 Price precision fix: ${signal.symbol} ${signal.price} → ${livePrice}`);
      signal.price = livePrice;
    }
  }

  await ensureTables(env);

  // Auto-register signal symbol so it appears in the journal sidebar
  try {
    const raw = await getSetting(env, 'journal_symbols', '[]');
    const syms = JSON.parse(raw);
    if (!syms.includes(signal.symbol)) {
      syms.push(signal.symbol);
      await setSetting(env, 'journal_symbols', JSON.stringify(syms));
    }
  } catch (_) {}

  // Resolve active strategy (auto-init default if none)
  let strategy = await getActiveStrategy(env);
  if (!strategy) strategy = await initDefaultStrategy(env);
  const strategyConfig = strategy?.config || null;

  const ruleAnalysis  = analyzeWithRules(signal, strategyConfig);
  const fallbackAnalysis = ruleAnalysis;
  const analysis = await withTimeout(
    analyzeSignalWithAI(env, signal, strategyConfig),
    AI_TIMEOUT_MS,
    fallbackAnalysis
  ) || fallbackAnalysis;
  const signalId = `signal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Compute derived fields from ruleAnalysis (always deterministic)
  const matchedRulesJSON   = JSON.stringify(ruleAnalysis.matched_rules  || []);
  const failedRulesJSON    = JSON.stringify(ruleAnalysis.failed_rules   || []);
  const unknownRulesJSON   = JSON.stringify(ruleAnalysis.unknown_rules  || []);
  const scoreBreakdownJSON = JSON.stringify(ruleAnalysis.score_breakdown || {});
  const signalQuality      = getSignalQuality(analysis.score);
  const riskReward         = calcRR(analysis.entry, analysis.tp, analysis.sl, direction === 'LONG');
  const plannedProfitPct   = safePct(analysis.tp, analysis.entry);
  const plannedRiskPct     = safePct(analysis.sl, analysis.entry);
  const triggerReason      = signal.trigger || signal.action || 'WEBHOOK';

  // Determine Telegram notification
  const isTest       = signal.test === true || signal.is_test === 1;
  const shouldNotify = isTest || analysis.score >= 55;
  let telegramSent   = 0;
  let telegramReason = 'below_threshold';

  if (shouldNotify) {
    telegramReason = isTest ? 'test_signal' : (analysis.score >= 70 ? 'score_70' : 'score_55');
    const debugPrefix = (analysis.score < 70 || isTest)
      ? `🧪 <b>[${isTest ? 'TEST' : 'DEBUG'}]</b>\n` : '';
    const telegramMessage = debugPrefix + formatSignalForTelegram({
      ...signal,
      direction,
      ai_score:       analysis.score,
      ai_entry:       analysis.entry,
      ai_tp:          analysis.tp,
      ai_sl:          analysis.sl,
      ai_reason:      analysis.reason,
      signal_quality: signalQuality,
      risk_reward:    riskReward,
      matched_rules:  matchedRulesJSON,
      failed_rules:   failedRulesJSON,
    });
    const sent = await withTimeout(sendTelegramMessage(env, telegramMessage), TELEGRAM_TIMEOUT_MS, false);
    if (sent) telegramSent = 1;
  }

  await env.DB.prepare(`
    INSERT INTO signals (
      id, symbol, timeframe, price, direction, action, trigger,
      rsi, ema50, ema200, trend, support, resistance, wave_bias,
      ai_recommendation, ai_direction, ai_score, ai_risk, ai_confidence,
      ai_entry, ai_tp, ai_sl, ai_reason,
      rule_score, rule_reason,
      strategy_id, strategy_name, strategy_version,
      is_test, source, telegram_sent, telegram_reason,
      matched_rules, failed_rules, unknown_rules, score_breakdown,
      signal_quality, risk_reward, planned_profit_pct, planned_risk_pct,
      trigger_reason, disclaimer_shown,
      created_at, outcome
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    signalId,
    signal.symbol  || 'UNKNOWN',
    String(signal.timeframe || '5'),
    signal.price   || signal.close || 0,
    direction,
    action,
    signal.trigger || 'WEBHOOK',
    signal.rsi        ?? null,
    signal.ema50      ?? null,
    signal.ema200     ?? null,
    signal.trend      || null,
    signal.support    ?? null,
    signal.resistance ?? null,
    signal.wave_bias  || null,
    analysis.recommendation,
    analysis.direction || direction,
    analysis.score,
    analysis.risk,
    signal.confidence ?? null,
    analysis.entry,
    analysis.tp,
    analysis.sl,
    analysis.reason,
    analysis.score,
    analysis.reason,
    strategy?.id      || null,
    strategy?.name    || 'WAVESCOUT Standard',
    strategy?.version || 'v1.0',
    isTest ? 1 : 0,
    signal.source || 'WEBHOOK',
    telegramSent,
    telegramReason,
    matchedRulesJSON,
    failedRulesJSON,
    unknownRulesJSON,
    scoreBreakdownJSON,
    signalQuality,
    riskReward,
    plannedProfitPct,
    plannedRiskPct,
    triggerReason,
    1,
    Date.now(),
    'OPEN'
  ).run();

  // Only open a practice trade for signals that meet the quality threshold
  if (analysis.score >= 75) {
    await createPracticeTrade(env, signalId, { ...signal, direction }, analysis);
  }

  console.log('✅ Signal processed:', signalId, '| Score:', analysis.score, '| Rec:', analysis.recommendation, '| Telegram:', telegramSent ? telegramReason : 'no');
  return { status: 'ok', signalId, analysis };
}

async function handlePriceUpdate(env, payload) {
  try {
    const symbol = payload.symbol;
    const price = parseFloat(payload.price ?? payload.close ?? 0);
    if (!symbol || !price) return { success: true, type: 'PRICE_UPDATE', message: 'Price update accepted (no symbol/price)' };
    await ensureTables(env);
    await checkPracticeTrades(env, symbol, price);
    return { success: true, type: 'PRICE_UPDATE', message: 'Price update processed', symbol, price };
  } catch (error) {
    console.error('❌ PRICE_UPDATE error:', error?.message || error);
    return { success: true, type: 'PRICE_UPDATE', message: 'Price update accepted (processing failed)' };
  }
}

function decodeXml(value = '') {
  return value
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function mapEventCategory(text = '') {
  const t = text.toLowerCase();
  if (/(etf|blackrock|fidelity|approval|denial)/.test(t) && /bitcoin|btc|crypto/.test(t)) return 'BTC_ETF';
  if (/(sec|mica|regulation|lawsuit|ban|compliance)/.test(t) && /bitcoin|btc/.test(t)) return 'BTC_REGULATION';
  if (/(mining|miner|halving|hashrate)/.test(t)) return 'BTC_MINING_HALVING';
  if (/(whale|wallet|on-chain transfer|reserve)/.test(t) && /btc|bitcoin/.test(t)) return 'BTC_WHALE';
  if (/(fed|cpi|inflation|nfp|fomc|rate decision|interest rate)/.test(t)) return 'MACRO';
  if (/(binance|bybit|mexc|blofin|exchange)/.test(t)) return 'EXCHANGE_NEWS';
  if (/(stablecoin|usdt|usdc|depeg)/.test(t)) return 'STABLECOIN';
  if (/(hack|exploit|breach|drain|outage)/.test(t)) return 'SECURITY_INCIDENT';
  if (/(liquidation|volatility|dominance)/.test(t)) return 'MARKET_STRUCTURE';
  return 'CRYPTO_GENERAL';
}

function mapImpact(text = '') {
  const t = text.toLowerCase();
  if (/(hack|exploit|sec lawsuit|lawsuit|etf approval|etf denied|etf denial|rate decision|cpi surprise|depeg|exchange outage)/.test(t)) return 'HIGH';
  if (/(etf flow|regulation|liquidation|fed|cpi|nfp|political|election|sec)/.test(t)) return 'MEDIUM';
  return 'LOW';
}

function mapAffectedMarkets(text = '') {
  const t = text.toLowerCase();
  const out = new Set();
  if (/(btc|bitcoin|etf|mining|halving)/.test(t)) out.add('BTC');
  if (/(eth|ethereum)/.test(t)) out.add('ETH');
  if (/(altcoin|alts|sol|xrp|ada)/.test(t)) out.add('ALTCOINS');
  if (/(fed|cpi|nfp|liquidation|market|exchange|stablecoin|sec|regulation)/.test(t)) out.add('TOTAL_MARKET');
  if (out.size === 0) out.add('BTC');
  return Array.from(out);
}

function computeRadarStatus(events = []) {
  const highCount = events.filter(e => e.impact === 'HIGH').length;
  const mediumCount = events.filter(e => e.impact === 'MEDIUM').length;
  if (highCount >= 1) return 'RISK_OFF';
  if (mediumCount >= 2) return 'CAUTION';
  return 'NORMAL';
}

async function fetchRssItems(feed) {
  try {
    const res = await fetch(feed.url, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [...xml.matchAll(/<item[\s\S]*?<\/item>/g)].slice(0, 10);
    return items.map(m => {
      const chunk = m[0];
      const title = decodeXml((chunk.match(/<title>([\s\S]*?)<\/title>/i) || [,''])[1]).trim();
      const link = decodeXml((chunk.match(/<link>([\s\S]*?)<\/link>/i) || [,''])[1]).trim();
      const description = decodeXml((chunk.match(/<description>([\s\S]*?)<\/description>/i) || [,''])[1]).replace(/<[^>]*>/g, ' ').trim();
      const pubDate = (chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [,''])[1];
      const eventTime = Date.parse(pubDate || '') || Date.now();
      return { title, link, description, eventTime, sourceFeed: feed.name };
    });
  } catch (_) {
    return [];
  }
}

function safeIdPart(input = '') {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

async function getMarketRadar(env, session = null) {
  await ensureTables(env);
  const now = Date.now();
  const debug = {
    feeds_total: MARKET_RADAR_FEEDS.length,
    feeds_success: 0,
    feeds_failed: 0,
    items_loaded: 0,
    items_relevant: 0,
    db_saved: 0,
    error_message: null
  };
  const isAdmin = session?.role === 'admin';
  const withDebug = (payload) => isAdmin ? { ...payload, debug } : payload;

  try {
  const freshCache = await env.DB.prepare(
    `SELECT * FROM market_events WHERE status = 'ACTIVE' AND updated_at >= ? ORDER BY CASE WHEN impact='HIGH' THEN 1 WHEN impact='MEDIUM' THEN 2 ELSE 3 END ASC, event_time DESC LIMIT ?`
  ).bind(now - MARKET_RADAR_CACHE_TTL_MS, MARKET_RADAR_MAX_EVENTS).all();

  if (freshCache.results?.length) {
    const events = freshCache.results.map(r => ({ ...r, affected_markets: JSON.parse(r.affected_markets || '[]') }));
    return withDebug({ success: true, source: 'cache', errors: [], status: computeRadarStatus(events), updated_at: now, updatedAt: new Date(now).toISOString(), summary: "BTC/Krypto-Markt mit erhöhter Event-Aktivität.", events, disclaimer: RADAR_DISCLAIMER });
  }

  const feedArrays = await Promise.all(MARKET_RADAR_FEEDS.map(async (feed) => {
    const items = await fetchRssItems(feed);
    if (items.length > 0) debug.feeds_success += 1;
    else debug.feeds_failed += 1;
    return items;
  }));
  const rssResults = feedArrays.flat();
  debug.items_loaded = rssResults.length;
  const relevant = rssResults
    .filter(item => /bitcoin|btc|crypto|etf|sec|stablecoin|binance|bybit|mexc|blofin|fed|cpi|nfp|liquidation|hack|regulation/i.test(`${item.title} ${item.description}`))
    .slice(0, MARKET_RADAR_MAX_EVENTS)
    .map(item => {
      const text = `${item.title} ${item.description}`;
      return {
        id: `mradar_${item.eventTime}_${safeIdPart(item.title)}`,
        event_time: item.eventTime,
        title: item.title,
        category: mapEventCategory(text),
        impact: mapImpact(text),
        affected_markets: mapAffectedMarkets(text),
        source: 'RSS',
        source_url: item.link,
        summary: item.description.slice(0, 180) || 'Relevantes Krypto-Markt-Event.',
      };
    });
  debug.items_relevant = relevant.length;

  const status = computeRadarStatus(relevant);
  for (const event of relevant) {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO market_events
      (id, created_at, updated_at, event_time, title, category, impact, affected_markets, source, source_url, summary, radar_status, raw_json, long_text, affected_symbols, affected_scope, status)
      VALUES (?, COALESCE((SELECT created_at FROM market_events WHERE id = ?), ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).bind(
      event.id, event.id, now, now, event.event_time, event.title, event.category, event.impact,
      JSON.stringify(event.affected_markets), event.source, event.source_url, event.summary, status, JSON.stringify(event),
      event.long_text || '', event.affected_symbols || '[]', event.affected_scope || 'GLOBAL'
    ).run();
    debug.db_saved += 1;
  }

  const outputEvents = relevant.length ? relevant : (await env.DB.prepare(
    `SELECT * FROM market_events WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT ?`
  ).bind(MARKET_RADAR_MAX_EVENTS).all()).results.map(r => ({ ...r, affected_markets: JSON.parse(r.affected_markets || '[]') }));

  return withDebug({
    success: true,
    source: 'rss',
    errors: [],
    status: computeRadarStatus(outputEvents),
    updated_at: now,
    updatedAt: new Date(now).toISOString(),
    summary: outputEvents.length ? "BTC/Krypto-Markt mit erhöhter Event-Aktivität." : "Keine relevanten Markt-Events gefunden.",
    events: outputEvents,
    disclaimer: RADAR_DISCLAIMER
  });
  } catch (error) {
    console.error('❌ market-radar error:', error?.message || error);
    debug.error_message = String(error?.message || error || 'market-radar failed');
    return withDebug({
      success: true,
      source: 'partial',
      errors: [debug.error_message],
      status: 'NORMAL',
      updated_at: now,
      updatedAt: new Date(now).toISOString(),
      summary: 'Radar-Daten aktuell nicht verfügbar. Letzte Daten konnten nicht geladen werden.',
      events: [],
      disclaimer: RADAR_DISCLAIMER
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTH FUNCTIONS (D1-backed sessions)
// ═══════════════════════════════════════════════════════════════

async function login(env, username, password) {
  const user = await env.DB.prepare(
    `SELECT * FROM users WHERE username = ? OR email = ?`
  ).bind(username, username).first();

  if (!user) return { success: false, error: 'Benutzer nicht gefunden' };
  if (user.blocked) return { success: false, error: 'Konto gesperrt' };

  if (user.password_hash !== hashPassword(password)) {
    return { success: false, error: 'Falsches Passwort' };
  }

  await ensureTables(env);

  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;

  const mustChange = user.must_change_password === 1 && user.skip_password_change !== 1;

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, username, role, must_change_password, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(sessionId, user.id, user.username, user.role, mustChange ? 1 : 0, now, expiresAt).run();

  try {
    await env.DB.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`).bind(now, user.id).run();
  } catch (_) {}

  return {
    success: true,
    session: {
      id: sessionId,
      userId: user.id,
      username: user.username,
      role: user.role,
      mustChangePassword: mustChange
    },
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      mustChangePassword: mustChange
    }
  };
}

async function changePassword(env, userId, newPassword) {
  await env.DB.prepare(
    `UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?`
  ).bind(hashPassword(newPassword), Date.now(), userId).run();
  try {
    await env.DB.prepare(`UPDATE sessions SET must_change_password = 0 WHERE user_id = ?`).bind(userId).run();
  } catch (_) {}
  return { success: true };
}

async function validateSession(env, sessionId) {
  if (!sessionId) return null;
  try {
    const session = await env.DB.prepare(
      `SELECT * FROM sessions WHERE id = ? AND expires_at > ?`
    ).bind(sessionId, Date.now()).first();

    if (!session) return null;

    try {
      await env.DB.prepare(`UPDATE users SET last_seen = ? WHERE id = ?`)
        .bind(Date.now(), session.user_id).run();
    } catch (_) {}

    return {
      id: session.id,
      userId: session.user_id,
      username: session.username,
      role: session.role,
      mustChangePassword: session.must_change_password === 1,
      createdAt: session.created_at
    };
  } catch (_) {
    return null;
  }
}

function isAdmin(session) { return session?.role === 'admin'; }
function isTraderOrAdmin(session) { return session?.role === 'admin' || session?.role === 'trader'; }
function canViewDashboard(session) { return session && !session.blocked; } // admin/trader/viewer/extern all can view

async function logout(env, sessionId) {
  try {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
  } catch (_) {}
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════
// DATA FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function getStats(env) {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='signals'`
    ).first();
    if (!tableCheck) return { total: 0, wins: 0, losses: 0, open: 0, winRate: 0 };

    const total  = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals`).first();
    const wins   = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'WIN'`).first();
    const losses = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'LOSS'`).first();
    const open   = await env.DB.prepare(`SELECT COUNT(*) as count FROM signals WHERE outcome = 'OPEN'`).first();

    const winRate = (wins.count + losses.count) > 0
      ? (wins.count / (wins.count + losses.count)) * 100
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
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='signals'`
    ).first();
    if (!tableCheck) return [];

    const rows = await env.DB.prepare(
      `SELECT * FROM signals ORDER BY created_at DESC LIMIT ?`
    ).bind(limit).all();
    return rows.results || [];
  } catch (error) {
    console.error('Error in getHistory:', error);
    return [];
  }
}

async function getSnapshot(env, symbol, timeframe = '5m') {
  try {
    const tableCheck = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='snapshots'`
    ).first();
    if (!tableCheck) return null;

    const row = await env.DB.prepare(`
      SELECT * FROM snapshots WHERE symbol = ? AND timeframe = ?
      ORDER BY created_at DESC LIMIT 1
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
      pnl += trade.direction === 'LONG' ? diff : -diff;
    });
    return pnl;
  } catch (error) {
    console.error('Error in getTodayPnL:', error);
    return 0;
  }
}

async function getTotalPnL(env) {
  try {
    const trades = await env.DB.prepare(`
      SELECT ai_entry, exit_price, outcome, direction FROM signals
      WHERE outcome IN ('WIN', 'LOSS') AND exit_price IS NOT NULL AND ai_entry IS NOT NULL
    `).all();
    let pnl = 0;
    (trades.results || []).forEach(trade => {
      const diff = trade.exit_price - trade.ai_entry;
      pnl += trade.direction === 'LONG' ? diff : -diff;
    });
    return pnl;
  } catch (_) { return 0; }
}

async function getBestSignal(env) {
  try {
    return await env.DB.prepare(
      `SELECT * FROM signals WHERE outcome = 'OPEN' ORDER BY ai_score DESC LIMIT 1`
    ).first();
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
        let trend = 'neutral', change = 0;
        if (snap.ema50 && snap.ema200) {
          if (snap.price > snap.ema200 && snap.ema50 > snap.ema200) {
            trend = 'bullish';
            change = ((snap.price - snap.ema200) / snap.ema200) * 100;
          } else if (snap.price < snap.ema200 && snap.ema50 < snap.ema200) {
            trend = 'bearish';
            change = ((snap.price - snap.ema200) / snap.ema200) * 100;
          }
        }
        bias.push({ symbol, price: snap.price, trend, change: parseFloat(change.toFixed(2)), rsi: snap.rsi });
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
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).bind(id, date, username, type, JSON.stringify(checklistData), now, now).run();

  return { success: true, id };
}

async function getChecklist(env, date, username) {
  const rows = await env.DB.prepare(`
    SELECT * FROM checklists WHERE date = ? AND user = ? ORDER BY created_at DESC
  `).bind(date, username).all();
  return rows.results || [];
}

async function getUsers(env) {
  try {
    const users = await env.DB.prepare(`
      SELECT id, username, email, role, must_change_password, blocked, last_seen, created_at, updated_at
      FROM users ORDER BY created_at DESC
    `).all();
    return users.results || [];
  } catch (_) {
    const users = await env.DB.prepare(`
      SELECT id, username, email, role, must_change_password, created_at, updated_at
      FROM users ORDER BY created_at DESC
    `).all();
    return users.results || [];
  }
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// 3H PROFIT-CLOSE (cron every 3h)
// Offene Trades die ≥ 3h alt sind: wenn im Profit → schließen;
// wenn nicht → offen lassen und beim nächsten 3h-Check erneut prüfen.
// ═══════════════════════════════════════════════════════════════

async function check3hProfitClose(env) {
  const THREE_H_MS  = 3 * 60 * 60 * 1000;
  const cutoff      = Date.now() - THREE_H_MS;
  const results     = [];

  try {
    const open = await env.DB.prepare(`
      SELECT * FROM signals
      WHERE outcome = 'OPEN' AND created_at <= ?
      ORDER BY created_at ASC
    `).bind(cutoff).all();

    console.log(`⏳ 3h profit-check: ${(open.results || []).length} offene Trades ≥ 3h`);

    for (const signal of (open.results || [])) {
      const currentPrice = await getLivePrice(env, signal.symbol);
      if (!currentPrice) {
        results.push({ id: signal.id, status: 'no_price' });
        continue;
      }

      const isLong    = signal.direction === 'LONG';
      const entryPrice = parseFloat(signal.ai_entry || signal.price || 0);
      if (!entryPrice) { results.push({ id: signal.id, status: 'no_entry' }); continue; }

      const inProfit  = isLong ? currentPrice > entryPrice : currentPrice < entryPrice;

      if (inProfit) {
        const pnlPct  = isLong
          ? ((currentPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - currentPrice) / entryPrice) * 100;
        const now     = Date.now();
        const duration = formatDuration(now - (signal.created_at || now));

        await env.DB.prepare(`
          UPDATE signals SET
            outcome = 'WIN', exit_price = ?, pnl_pct = ?,
            closed_at = ?, updated_at = ?,
            outcome_source = '3H_PROFIT_CLOSE'
          WHERE id = ?
        `).bind(currentPrice, parseFloat(pnlPct.toFixed(2)), now, now, signal.id).run();

        await sendTelegramMessage(env,
          `⏱️ <b>3H-PROFIT-CLOSE — ${signal.symbol} ${signal.direction}</b>\n\n` +
          `✅ Im Profit nach ${duration} geschlossen\n` +
          `Entry: $${entryPrice.toFixed(2)} · Exit: $${currentPrice.toFixed(2)}\n` +
          `PnL: <b>+${pnlPct.toFixed(2)}%</b>\n\n` +
          `<i>Automatisch geschlossen nach 3h-Profit-Check</i>`
        );

        console.log(`✅ 3h-Profit-Close: ${signal.id} | ${signal.symbol} | +${pnlPct.toFixed(2)}%`);
        results.push({ id: signal.id, status: 'closed_profit', pnlPct: pnlPct.toFixed(2), symbol: signal.symbol });
      } else {
        results.push({ id: signal.id, status: 'open_no_profit', symbol: signal.symbol });
        console.log(`⏳ 3h-Check: ${signal.id} | ${signal.symbol} – noch nicht im Profit, weiter offen`);
      }
    }

    // Also check practice trades ≥ 3h
    const openPT = await env.DB.prepare(`
      SELECT * FROM practice_trades
      WHERE status = 'OPEN' AND created_at <= ?
    `).bind(new Date(cutoff).toISOString()).all();

    for (const pt of (openPT.results || [])) {
      const currentPrice = await getLivePrice(env, pt.symbol);
      if (!currentPrice) continue;
      const isLong   = pt.direction === 'LONG';
      const inProfit = isLong ? currentPrice > pt.entry_price : currentPrice < pt.entry_price;
      if (inProfit) {
        const resultPct = isLong
          ? ((currentPrice - pt.entry_price) / pt.entry_price) * 100
          : ((pt.entry_price - currentPrice) / pt.entry_price) * 100;
        await env.DB.prepare(`
          UPDATE practice_trades
          SET status = 'WIN', exit_price = ?, result_pct = ?, closed_at = ?
          WHERE id = ?
        `).bind(currentPrice, parseFloat(resultPct.toFixed(2)), new Date().toISOString(), pt.id).run();
      }
    }
  } catch (err) {
    console.error('❌ check3hProfitClose error:', err.message);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// AUTO-EVALUATION (cron)
// ═══════════════════════════════════════════════════════════════

async function evaluateOpenTrades(env) {
  try {
    const open = await env.DB.prepare(`
      SELECT * FROM signals WHERE outcome = 'OPEN' AND ai_tp IS NOT NULL AND ai_sl IS NOT NULL
      ORDER BY created_at ASC
    `).all();

    for (const signal of (open.results || [])) {
      const price = await getLivePrice(env, signal.symbol);
      if (!price) continue;

      const isLong = signal.direction === 'LONG';
      let outcome = null;
      let hitLevel = null;

      if (isLong) {
        if (price >= signal.ai_tp) { outcome = 'WIN';  hitLevel = signal.ai_tp; }
        else if (price <= signal.ai_sl) { outcome = 'LOSS'; hitLevel = signal.ai_sl; }
      } else {
        if (price <= signal.ai_tp) { outcome = 'WIN';  hitLevel = signal.ai_tp; }
        else if (price >= signal.ai_sl) { outcome = 'LOSS'; hitLevel = signal.ai_sl; }
      }

      if (outcome) {
        const exitPrice = hitLevel || price;
        const entry     = signal.ai_entry || price;
        const pnlPct    = isLong
          ? ((exitPrice - entry) / entry) * 100
          : ((entry - exitPrice) / entry) * 100;
        const duration  = formatDuration(Date.now() - (signal.created_at || Date.now()));
        const now       = Date.now();

        await env.DB.prepare(`
          UPDATE signals SET
            outcome = ?, exit_price = ?, pnl_pct = ?,
            closed_at = ?, outcome_source = 'auto',
            telegram_outcome_sent = 1, updated_at = ?
          WHERE id = ?
        `).bind(outcome, exitPrice, parseFloat(pnlPct.toFixed(2)), now, now, signal.id).run();

        const isWin     = outcome === 'WIN';
        const hitEmoji  = isWin ? '🎯' : '🛑';
        const hitLabel  = isWin ? 'TP HIT' : 'SL HIT';
        const pnlSign   = pnlPct >= 0 ? '+' : '';
        const tpLine    = isWin
          ? `TP: $${signal.ai_tp?.toFixed(2)}`
          : `SL: $${signal.ai_sl?.toFixed(2)}`;

        await sendTelegramMessage(env,
          `${hitEmoji} <b>${hitLabel} — ${signal.symbol} ${signal.direction}</b>\n` +
          `Ergebnis: <b>${outcome}</b>\n\n` +
          `Entry: $${entry.toFixed(2)} · ${tpLine} · Exit: $${exitPrice.toFixed(2)}\n` +
          `PnL: <b>${pnlSign}${pnlPct.toFixed(2)}%</b> · Dauer: ${duration}`
        );

        console.log(`📊 Signal ${signal.id} closed: ${outcome} | PnL: ${pnlPct.toFixed(2)}% | ${duration}`);
      }
    }
    console.log('✅ evaluateOpenTrades done');
  } catch (err) {
    console.error('evaluateOpenTrades error:', err);
  }
}

async function sendDailySummary(env) {
  try {
    const stats = await getStats(env);
    const history = await getHistory(env, 5);
    const recentList = history.length > 0
      ? history.map(s => `• ${s.symbol} ${s.direction} · Score ${s.ai_score} · ${s.outcome}`).join('\n')
      : 'Keine aktuellen Trades';

    await sendTelegramMessage(env,
      `📊 <b>WAVESCOUT Tagesbericht</b>\n\n` +
      `📈 Statistiken:\n• Total: ${stats.total} Trades\n• Wins: ${stats.wins} | Losses: ${stats.losses} | Offen: ${stats.open}\n• Win-Rate: ${stats.winRate}%\n\n` +
      `🕐 Letzte Signale:\n${recentList}\n\n⏰ ${new Date().toLocaleString('de-DE')}`
    );
  } catch (err) {
    console.error('sendDailySummary error:', err);
  }
}

function evaluateOutcomeForSignal(signal, price) {
  if (!price || !Number.isFinite(price)) return { outcome: 'NO_PRICE', hitLevel: null };
  if (signal.ai_tp == null || signal.ai_sl == null) return { outcome: 'OPEN', hitLevel: null };
  const isLong = signal.direction === 'LONG';
  if (isLong) {
    if (price >= signal.ai_tp) return { outcome: 'WIN', hitLevel: signal.ai_tp };
    if (price <= signal.ai_sl) return { outcome: 'LOSS', hitLevel: signal.ai_sl };
  } else {
    if (price <= signal.ai_tp) return { outcome: 'WIN', hitLevel: signal.ai_tp };
    if (price >= signal.ai_sl) return { outcome: 'LOSS', hitLevel: signal.ai_sl };
  }
  return { outcome: 'OPEN', hitLevel: null };
}

async function checkOpenSignals(env, onlySignalId = null) {
  await ensureTables(env);
  const rows = await env.DB.prepare(`
    SELECT * FROM signals
    WHERE (outcome = 'OPEN' OR outcome IS NULL) AND ai_tp IS NOT NULL AND ai_sl IS NOT NULL
    ${onlySignalId ? 'AND id = ?' : ''}
    ORDER BY created_at ASC
  `).bind(...(onlySignalId ? [onlySignalId] : [])).all();

  const checked = [];
  for (const signal of (rows.results || [])) {
    const price = await getLivePrice(env, signal.symbol);
    const { outcome, hitLevel } = evaluateOutcomeForSignal(signal, price);
    const item = {
      id: signal.id, symbol: signal.symbol, direction: signal.direction,
      entry: signal.ai_entry, tp: signal.ai_tp, sl: signal.ai_sl, price
    };
    if (!price || !Number.isFinite(price)) {
      item.status  = 'no_price';
      item.outcome = null;
      item.message = `Kein Preis für ${signal.symbol}`;
    } else if (outcome === 'WIN' || outcome === 'LOSS') {
      const entry = signal.ai_entry || price;
      const exitPrice = hitLevel || price;
      const pnlPct = signal.direction === 'LONG'
        ? ((exitPrice - entry) / entry) * 100
        : ((entry - exitPrice) / entry) * 100;
      const now = Date.now();
      await env.DB.prepare(`
        UPDATE signals
        SET outcome = ?, exit_price = ?, pnl_pct = ?, closed_at = ?, outcome_source = 'auto', updated_at = ?, telegram_outcome_sent = COALESCE(telegram_outcome_sent,0)
        WHERE id = ?
      `).bind(outcome, exitPrice, parseFloat(pnlPct.toFixed(2)), now, now, signal.id).run();
      item.status  = 'closed';
      item.outcome = outcome;
      item.message = `${outcome} — Preis ${price} hat ${outcome === 'WIN' ? 'TP' : 'SL'} erreicht`;
    } else {
      item.status  = 'open';
      item.outcome = 'OPEN';
      item.message = 'Weiter offen';
    }
    checked.push(item);
  }
  return checked;
}

// ═══════════════════════════════════════════════════════════════
// MAIN WORKER
// ═══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {

      // ── AUTH ────────────────────────────────────────────────

      if (request.method === "POST" && url.pathname === "/auth/login") {
        const { username, password } = await request.json();
        const result = await login(env, username, password);
        return jsonResponse(result, result.success ? 200 : 401);
      }

      if (request.method === "POST" && url.pathname === "/auth/logout") {
        return jsonResponse(await logout(env, request.headers.get("X-Session-ID")));
      }

      if (request.method === "POST" && url.pathname === "/auth/change-password") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const { newPassword } = await request.json();
        return jsonResponse(await changePassword(env, session.userId, newPassword));
      }

      // ── DASHBOARD LIVE DATA ─────────────────────────────────

      if (request.method === "GET" && url.pathname === "/dashboard/live") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const [stats, latestSignals, bestSignal, marketBias, todayPnL] = await Promise.all([
          getStats(env), getHistory(env, 10), getBestSignal(env), getMarketBias(env), getTodayPnL(env)
        ]);

        const startingCapital = parseFloat(env.STARTING_CAPITAL || '10000');
        const totalPnL = await getTotalPnL(env);
        const equity = startingCapital + totalPnL;

        return jsonResponse({
          stats: {
            equity: parseFloat(equity.toFixed(2)),
            startingCapital,
            totalPnL: parseFloat(totalPnL.toFixed(2)),
            todayPnL: parseFloat(todayPnL.toFixed(2)),
            winRate: stats.winRate,
            totalTrades: stats.total,
            wins: stats.wins,
            losses: stats.losses,
            open: stats.open
          },
          bestSignal: bestSignal || null,
          latestSignals,
          marketBias,
          user: { username: session.username, role: session.role }
        });
      }

      if (request.method === "GET" && url.pathname === "/market-radar") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getMarketRadar(env, session));
      }

      // ── DATA ─────────────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/stats") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getStats(env));
      }

      if (request.method === "GET" && url.pathname === "/history") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));
        return jsonResponse(await getHistory(env, limit));
      }

      if (request.method === "GET" && url.pathname === "/analytics") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const stats = await getStats(env);
        const history = await getHistory(env, 200);
        const closedTrades = history.filter(t => t.outcome !== 'OPEN' && t.updated_at);
        const avgHoldTime = closedTrades.length > 0
          ? closedTrades.reduce((sum, t) => sum + (t.updated_at - t.created_at), 0) / closedTrades.length
          : 0;
        return jsonResponse({ ...stats, avgHoldTimeMs: avgHoldTime, totalSignals: stats.total });
      }

      if (request.method === "GET" && url.pathname === "/stats/breakdown") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        try {
          const tableCheck = await env.DB.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name='signals'`
          ).first();
          if (!tableCheck) return jsonResponse({ timeframes: [], directions: [] });

          const tfRows = await env.DB.prepare(`
            SELECT timeframe,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
            FROM signals GROUP BY timeframe ORDER BY total DESC
          `).all();

          const dirRows = await env.DB.prepare(`
            SELECT direction,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
            FROM signals WHERE direction IN ('LONG','SHORT')
            GROUP BY direction
          `).all();

          const symbolRows = await env.DB.prepare(`
            SELECT symbol,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
            FROM signals GROUP BY symbol ORDER BY total DESC LIMIT 10
          `).all();

          const calcWR = r => (r.wins + r.losses) > 0 ? parseFloat(((r.wins / (r.wins + r.losses)) * 100).toFixed(1)) : 0;

          return jsonResponse({
            timeframes: (tfRows.results || []).map(r => ({ ...r, winRate: calcWR(r) })),
            directions: (dirRows.results || []).map(r => ({ ...r, winRate: calcWR(r) })),
            symbols:    (symbolRows.results || []).map(r => ({ ...r, winRate: calcWR(r) }))
          });
        } catch (e) {
          return jsonResponse({ timeframes: [], directions: [], symbols: [] });
        }
      }

      // ── SIGNALS PATCH ────────────────────────────────────────

      if (request.method === "PATCH" && url.pathname.startsWith("/signals/") && !url.pathname.includes("/loss-reason")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);

        const signalId = url.pathname.replace("/signals/", "");
        const body = await request.json();
        const { outcome, exitPrice, adminNote, manualReason, closedAt, outcomeSource } = body;

        const allowed = ['WIN', 'LOSS', 'BE', 'OPEN', 'SKIPPED', 'IGNORED'];
        if (outcome && !allowed.includes(outcome)) return jsonResponse({ error: "Ungültiges outcome" }, 400);

        // For pnl_pct calc, fetch existing signal
        let pnlPct = undefined;
        const ep = exitPrice !== undefined ? parseFloat(exitPrice) : null;
        if (ep !== null) {
          try {
            const sig = await env.DB.prepare(`SELECT ai_entry, direction FROM signals WHERE id = ?`).bind(signalId).first();
            if (sig?.ai_entry) {
              pnlPct = sig.direction === 'LONG'
                ? ((ep - sig.ai_entry) / sig.ai_entry) * 100
                : ((sig.ai_entry - ep) / sig.ai_entry) * 100;
              pnlPct = parseFloat(pnlPct.toFixed(2));
            }
          } catch (_) {}
        }

        const sets = [], binds = [];
        if (outcome)                 { sets.push("outcome = ?");        binds.push(outcome); }
        if (ep !== null)             { sets.push("exit_price = ?");     binds.push(ep); }
        if (pnlPct !== undefined)    { sets.push("pnl_pct = ?");        binds.push(pnlPct); }
        if (adminNote !== undefined) { sets.push("admin_note = ?");     binds.push(adminNote); }
        if (manualReason !== undefined) { sets.push("manual_reason = ?"); binds.push(manualReason); }
        if (closedAt !== undefined)  { sets.push("closed_at = ?");      binds.push(closedAt); }
        if (outcomeSource !== undefined) { sets.push("outcome_source = ?"); binds.push(outcomeSource); }
        else if (outcome && session.role === 'admin') { sets.push("outcome_source = ?"); binds.push('manual'); }
        sets.push("updated_at = ?"); binds.push(Date.now());
        binds.push(signalId);

        await env.DB.prepare(`UPDATE signals SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
        return jsonResponse({ success: true, pnlPct });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/signals/") && !url.pathname.includes("/loss-reason")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.replace("/signals/", "");
        await env.DB.prepare(`DELETE FROM signals WHERE id = ?`).bind(signalId).run();
        await env.DB.prepare(`DELETE FROM signal_loss_reasons WHERE signal_id = ?`).bind(signalId).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "PATCH" && url.pathname.startsWith("/practice-trades/")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const tradeId = url.pathname.replace("/practice-trades/", "");
        const { status, exitPrice } = await request.json();
        const allowed = ['WIN', 'LOSS', 'BE', 'OPEN', 'IGNORED'];
        if (!status || !allowed.includes(status)) return jsonResponse({ error: "Ungültiger status" }, 400);
        const now = new Date().toISOString();
        await env.DB.prepare(`
          UPDATE practice_trades
          SET status = ?, exit_price = COALESCE(?, exit_price), closed_at = CASE WHEN ? IN ('WIN','LOSS','BE','IGNORED') THEN ? ELSE closed_at END
          WHERE id = ?
        `).bind(status, exitPrice ?? null, status, now, tradeId).run();
        return jsonResponse({ success: true, id: tradeId, status });
      }

      // ── PRACTICE TRADES ─────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/practice-trades") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getPracticeTrades(env, {
          symbol:    url.searchParams.get("symbol")    || 'all',
          timeframe: url.searchParams.get("timeframe") || 'all',
          direction: url.searchParams.get("direction") || 'all',
          status:    url.searchParams.get("status")    || 'all',
          limit:     parseInt(url.searchParams.get("limit") || "100")
        }));
      }

      if (request.method === "GET" && url.pathname === "/practice-trades/stats") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getPracticeTradeStats(env));
      }

      // ── CHECKLIST ───────────────────────────────────────────

      if (request.method === "POST" && url.pathname === "/checklist") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        return jsonResponse(await saveChecklist(env, body, session.username));
      }

      if (request.method === "GET" && url.pathname === "/checklist") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        return jsonResponse(await getChecklist(env, date, session.username));
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/checklist/")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const entryId = url.pathname.slice("/checklist/".length);
        await env.DB.prepare(`DELETE FROM checklists WHERE id = ? AND user = ?`)
          .bind(entryId, session.username).run();
        return jsonResponse({ success: true });
      }

      // ── ADMIN ───────────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/users") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse(await getUsers(env));
      }

      if (request.method === "POST" && url.pathname === "/admin/create-user") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { username, email, password, role, skipPasswordChange } = await request.json();
        if (!username || !email || !password) return jsonResponse({ error: "Fehlende Felder: username, email, password" }, 400);

        const existing = await env.DB.prepare(`SELECT id FROM users WHERE username = ? OR email = ?`)
          .bind(username, email).first();
        if (existing) return jsonResponse({ error: "Benutzername oder E-Mail bereits vergeben" }, 409);

        const id = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO users (id, username, email, password_hash, role, must_change_password, skip_password_change, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
        `).bind(id, username, email, hashPassword(password), role || 'user', skipPasswordChange ? 1 : 0, now, now).run();
        return jsonResponse({ success: true, id });
      }

      if (request.method === "POST" && url.pathname === "/admin/block-user") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { userId, blocked } = await request.json();
        await env.DB.prepare(`UPDATE users SET blocked = ?, updated_at = ? WHERE id = ?`)
          .bind(blocked ? 1 : 0, Date.now(), userId).run();
        if (blocked) {
          try { await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run(); } catch (_) {}
        }
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname === "/admin/logout-user") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { userId } = await request.json();
        try { await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run(); } catch (_) {}
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname === "/admin/change-password") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { userId, newPassword } = await request.json();
        return jsonResponse(await changePassword(env, userId, newPassword));
      }

      if (request.method === "GET" && url.pathname === "/test-telegram") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const testMessage = `🧪 <b>WAVESCOUT Test</b>\n\nTelegram ist korrekt konfiguriert!\n⏰ ${new Date().toLocaleString('de-DE')}`;
        const success = await sendTelegramMessage(env, testMessage);
        return jsonResponse({ success, message: success ? 'Telegram-Nachricht gesendet!' : 'Fehler beim Senden' });
      }

      // Send custom Telegram message
      if (request.method === "POST" && url.pathname === "/admin/telegram/send") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const { message } = await request.json();
        if (!message?.trim()) return jsonResponse({ error: 'message erforderlich' }, 400);
        const success = await sendTelegramMessage(env, message.trim());
        return jsonResponse({ success, message: success ? 'Gesendet!' : 'Fehler beim Senden' });
      }

      // System status overview
      if (request.method === "GET" && url.pathname === "/admin/status") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        let dbOk = false;
        try { await env.DB.prepare('SELECT 1').first(); dbOk = true; } catch (_) {}

        const tables = ['signals', 'snapshots', 'practice_trades', 'users', 'sessions', 'checklists'];
        const tableCounts = {};
        for (const t of tables) {
          try {
            const r = await env.DB.prepare(`SELECT COUNT(*) as c FROM ${t}`).first();
            tableCounts[t] = r?.c ?? 0;
          } catch (_) { tableCounts[t] = null; }
        }

        return jsonResponse({
          db: dbOk,
          telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
          anthropic: !!env.ANTHROPIC_API_KEY,
          webhook: !!env.WEBHOOK_SECRET,
          tables: tableCounts,
          version: '3.4.0',
          time: new Date().toISOString()
        });
      }

      // Test Anthropic AI connection
      if (request.method === "POST" && url.pathname === "/admin/test-ai") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        if (!env.ANTHROPIC_API_KEY) {
          return jsonResponse({ ok: false, error: 'ANTHROPIC_API_KEY ist nicht gesetzt', keySet: false });
        }

        const t0 = Date.now();
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-5',
              max_tokens: 10,
              messages: [{ role: 'user', content: 'ping' }]
            })
          });
          const data = await res.json();
          const ms = Date.now() - t0;

          if (data.content) {
            return jsonResponse({
              ok: true, keySet: true,
              latencyMs: ms,
              model: data.model,
              inputTokens: data.usage?.input_tokens ?? 0,
              outputTokens: data.usage?.output_tokens ?? 0
            });
          }
          return jsonResponse({ ok: false, keySet: true, error: data.error?.message || 'Unbekannter Fehler', latencyMs: ms });
        } catch (e) {
          return jsonResponse({ ok: false, keySet: true, error: e.message, latencyMs: Date.now() - t0 });
        }
      }

      // Webhook tester — inject test SNAPSHOT or SIGNAL
      if (request.method === "POST" && url.pathname === "/admin/test-webhook") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { type } = await request.json();
        try {
          if (type === 'SNAPSHOT') {
            const result = await saveSnapshot(env, {
              symbol: 'BTCUSDT', event_type: 'SNAPSHOT', timeframe: '5',
              price: 80000, rsi: 55, ema50: 79800, ema200: 78000,
              support: 79000, resistance: 81000,
              trend: 'bullish', trend_1h: 'GREEN', trend_4h: 'GREEN'
            });
            return jsonResponse(result);
          } else {
            const result = await processSignal(env, {
              symbol: 'BTCUSDT', event_type: 'SIGNAL', timeframe: '5',
              price: 80000, direction: 'LONG', trigger: 'ADMIN_TEST',
              rsi: 55, ema50: 79800, ema200: 78000, action: 'BUY'
            });
            return jsonResponse({ ok: true, type: 'SIGNAL', result });
          }
        } catch (e) {
          console.error('❌ /admin/test-webhook failed:', e?.message || e);
          return jsonResponse({ ok: false, error: e.message || 'test-webhook failed' }, 200);
        }
      }

      // ── 3H PROFIT-CLOSE (manual trigger) ────────────────────────
      if (request.method === "POST" && url.pathname === "/admin/check-3h-profit") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const results  = await check3hProfitClose(env);
          const closed   = results.filter(r => r.status === 'closed_profit').length;
          const open     = results.filter(r => r.status === 'open_no_profit').length;
          const noPrice  = results.filter(r => r.status === 'no_price').length;
          return jsonResponse({ success: true, checked: results.length, closed_profit: closed, still_open: open, no_price: noPrice, results });
        } catch (e) {
          return jsonResponse({ success: false, error: e.message }, 500);
        }
      }

      if (request.method === "POST" && url.pathname === "/admin/check-open-trades") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const results = await checkOpenSignals(env);
          const closed  = results.filter(r => r.status === 'closed').length;
          const open    = results.filter(r => r.status === 'open').length;
          const noprice = results.filter(r => r.status === 'no_price').length;
          return jsonResponse({ success: true, checked: results.length, closed, open, no_price: noprice, skipped: 0, results });
        } catch (e) {
          console.error('❌ /admin/check-open-trades failed:', e?.message || e);
          return jsonResponse({ success: false, error: e.message || 'trade-check failed' }, 200);
        }
      }

      if (request.method === "POST" && url.pathname.startsWith("/admin/check-trade/")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.replace("/admin/check-trade/", "");
        if (!signalId) return jsonResponse({ error: "Missing signal ID" }, 400);
        try {
          const results = await checkOpenSignals(env, signalId);
          const r = results[0];
          if (!r) return jsonResponse({ error: "Signal nicht gefunden" }, 404);
          return jsonResponse({ success: true, status: r.status, outcome: r.outcome, direction: r.direction, entry: r.entry, price: r.price, tp: r.tp, sl: r.sl, message: r.message });
        } catch (e) {
          console.error('❌ /admin/check-trade failed:', e?.message || e);
          return jsonResponse({ success: false, error: e.message || 'trade-check failed' }, 200);
        }
      }

      if (request.method === "POST" && url.pathname === "/admin/eod-check") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const results = await checkOpenSignals(env);
          const closed = results.filter(r => r.status === 'closed').length;
          return jsonResponse({ success: true, checked: results.length, closed, results });
        } catch (e) {
          console.error('❌ /admin/eod-check failed:', e?.message || e);
          return jsonResponse({ success: false, error: e.message || 'eod-check failed' }, 200);
        }
      }

      // DB cleanup — remove old snapshots & expired sessions
      if (request.method === "POST" && url.pathname === "/admin/db-cleanup") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const results = [];

        try {
          await env.DB.prepare(`
            DELETE FROM snapshots WHERE id NOT IN (
              SELECT id FROM (
                SELECT id FROM snapshots ORDER BY created_at DESC LIMIT 500
              )
            )
          `).run();
          results.push('✅ Snapshots: auf 500 gekürzt');
        } catch (e) { results.push('❌ Snapshots: ' + e.message); }

        try {
          await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(Date.now()).run();
          results.push('✅ Abgelaufene Sessions gelöscht');
        } catch (e) { results.push('❌ Sessions: ' + e.message); }

        try {
          await env.DB.prepare(`
            DELETE FROM practice_trades WHERE status != 'OPEN' AND closed_at < datetime('now', '-90 days')
          `).run();
          results.push('✅ Alte Practice Trades (>90 Tage) bereinigt');
        } catch (e) { results.push('❌ Practice Trades: ' + e.message); }

        return jsonResponse({ ok: true, results });
      }

      // Active sessions list
      if (request.method === "GET" && url.pathname === "/admin/sessions") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        try {
          const rows = await env.DB.prepare(`
            SELECT id, username, role, created_at, expires_at FROM sessions
            WHERE expires_at > ? ORDER BY created_at DESC
          `).bind(Date.now()).all();
          return jsonResponse(rows.results || []);
        } catch (_) { return jsonResponse([]); }
      }

      if (request.method === "POST" && url.pathname === "/admin/setup-db") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        await ensureTables(env);
        const results = ['All tables: OK'];

        try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN blocked INTEGER DEFAULT 0`).run(); results.push('users.blocked: added'); }
        catch (_) { results.push('users.blocked: already exists'); }

        try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN last_seen INTEGER`).run(); results.push('users.last_seen: added'); }
        catch (_) { results.push('users.last_seen: already exists'); }

        // signals extra columns
        const signalCols = [
          ['action',         'TEXT'],
          ['rsi',            'REAL'],
          ['ema50',          'REAL'],
          ['ema200',         'REAL'],
          ['trend',          'TEXT'],
          ['support',        'REAL'],
          ['resistance',     'REAL'],
          ['wave_bias',      'TEXT'],
          ['ai_direction',   'TEXT'],
          ['ai_confidence',  'REAL'],
          ['ai_take_profit', 'REAL'],
          ['ai_stop_loss',   'REAL'],
          ['raw_signal',     'TEXT'],
          ['raw_ai',         'TEXT'],
          ['status',         'TEXT'],
          ['timestamp',      'INTEGER'],
        ];
        for (const [col, type] of signalCols) {
          try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); results.push(`signals.${col}: added`); }
          catch (_) { results.push(`signals.${col}: already exists`); }
        }

        // Strategy + Phase-2 signal columns
        const stratCols = [
          ['strategy_id',           'TEXT'],
          ['strategy_name',         'TEXT'],
          ['strategy_version',      'TEXT'],
          ['is_test',               'INTEGER DEFAULT 0'],
          ['telegram_sent',         'INTEGER DEFAULT 0'],
          ['telegram_reason',       'TEXT'],
          ['source',                'TEXT'],
          ['pnl_pct',               'REAL'],
          ['closed_at',             'INTEGER'],
          ['outcome_source',        'TEXT'],
          ['telegram_outcome_sent', 'INTEGER DEFAULT 0'],
          ['admin_note',            'TEXT'],
          ['manual_reason',         'TEXT'],
        ];
        for (const [col, type] of stratCols) {
          try { await env.DB.prepare(`ALTER TABLE signals ADD COLUMN ${col} ${type}`).run(); results.push(`signals.${col}: added`); }
          catch (_) { results.push(`signals.${col}: already exists`); }
        }

        // User Phase-2 columns
        const userP2Cols = [
          ['skip_password_change', 'INTEGER DEFAULT 0'],
        ];
        for (const [col, type] of userP2Cols) {
          try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN ${col} ${type}`).run(); results.push(`users.${col}: added`); }
          catch (_) { results.push(`users.${col}: already exists`); }
        }

        // Ensure default strategy exists
        await initDefaultStrategy(env);
        results.push('strategies: default initialised');

        return jsonResponse({ success: true, results });
      }

      // ── ADMIN DATA MANAGEMENT ───────────────────────────────

      if (request.method === "POST" && url.pathname === "/admin/delete-signals") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { type } = await request.json();
        let query = null;
        if      (type === 'test')     query = `DELETE FROM signals WHERE is_test = 1`;
        else if (type === 'wait')     query = `DELETE FROM signals WHERE ai_recommendation = 'WAIT'`;
        else if (type === 'skipped')  query = `DELETE FROM signals WHERE outcome = 'SKIPPED'`;
        else if (type === 'practice') {
          await env.DB.prepare(`DELETE FROM practice_trades`).run();
          return jsonResponse({ success: true, type: 'practice', deleted: true });
        }
        else if (type === 'all') {
          await env.DB.prepare(`DELETE FROM signals`).run();
          await env.DB.prepare(`DELETE FROM signal_loss_reasons`).run();
          await env.DB.prepare(`DELETE FROM practice_trades`).run();
          return jsonResponse({ success: true, type: 'all', deleted: true });
        }
        else return jsonResponse({ error: 'Ungültiger type (test|wait|skipped|practice|all)' }, 400);

        const info = await env.DB.prepare(query).run();
        return jsonResponse({ success: true, type, deleted: info.meta?.changes ?? 0 });
      }

      if (request.method === "POST" && url.pathname === "/admin/live-start") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);

        const { deleteTestSignals } = await request.json();
        await ensureTables(env);
        await setSetting(env, 'mode', 'live');
        await setSetting(env, 'live_started_at', String(Date.now()));

        let deletedSignals = 0;
        if (deleteTestSignals) {
          // Delete practice_trades FIRST while signal IDs still exist in the DB
          await env.DB.prepare(`DELETE FROM practice_trades WHERE signal_id IN (SELECT id FROM signals WHERE is_test = 1)`).run();
          const info = await env.DB.prepare(`DELETE FROM signals WHERE is_test = 1`).run();
          deletedSignals = info.meta?.changes ?? 0;
        }
        return jsonResponse({ success: true, mode: 'live', liveStartedAt: Date.now(), deletedSignals });
      }

      if (request.method === "GET" && url.pathname === "/admin/settings") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        await ensureTables(env);
        try {
          const rows = await env.DB.prepare(`SELECT key, value, updated_at FROM settings ORDER BY key`).all();
          const obj = {};
          for (const r of (rows.results || [])) obj[r.key] = r.value;
          return jsonResponse(obj);
        } catch (_) { return jsonResponse({}); }
      }

      if (request.method === "POST" && url.pathname === "/admin/settings") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || session.role !== 'admin') return jsonResponse({ error: "Unauthorized" }, 401);
        await ensureTables(env);
        const body = await request.json();
        for (const [key, value] of Object.entries(body)) {
          await setSetting(env, key, value);
        }
        return jsonResponse({ success: true });
      }

      // ── STRATEGIES ──────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/strategies") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        await ensureTables(env);
        const existing = await env.DB.prepare(`SELECT COUNT(*) as c FROM strategies`).first();
        if (!existing?.c) await initDefaultStrategy(env);
        const rows = await env.DB.prepare(`SELECT * FROM strategies ORDER BY is_default DESC, created_at DESC`).all();
        return jsonResponse((rows.results || []).map(s => ({
          ...s, config: s.config_json ? JSON.parse(s.config_json) : DEFAULT_STRATEGY_CONFIG
        })));
      }

      if (request.method === "POST" && url.pathname === "/strategies") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const { name, version, config } = await request.json();
        if (!name || !config) return jsonResponse({ error: "name and config required" }, 400);
        const id = `strategy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO strategies (id, name, version, active, is_default, protected, created_at, updated_at, config_json)
          VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)
        `).bind(id, name, version || 'v1.0', now, now, JSON.stringify(config)).run();
        return jsonResponse({ success: true, id });
      }

      if (request.method === "PUT" && url.pathname.startsWith("/strategies/") && !url.pathname.endsWith("/activate") && url.pathname !== "/strategies/reset-to-default" && url.pathname !== "/strategies/compare" && url.pathname !== "/strategies/ab-backtest" && url.pathname !== "/strategies/suggestions") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const stratId = url.pathname.slice("/strategies/".length);
        const existing = await env.DB.prepare(`SELECT * FROM strategies WHERE id = ?`).bind(stratId).first();
        if (!existing) return jsonResponse({ error: "Nicht gefunden" }, 404);
        if (existing.protected) return jsonResponse({ error: "Standardstrategie kann nicht geändert werden" }, 403);
        const { name, version, config } = await request.json();
        const sets = [], binds = [];
        if (name)   { sets.push("name = ?");        binds.push(name); }
        if (version){ sets.push("version = ?");     binds.push(version); }
        if (config) { sets.push("config_json = ?"); binds.push(JSON.stringify(config)); }
        sets.push("updated_at = ?"); binds.push(Date.now());
        binds.push(stratId);
        await env.DB.prepare(`UPDATE strategies SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/strategies/")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const stratId = url.pathname.slice("/strategies/".length);
        const existing = await env.DB.prepare(`SELECT * FROM strategies WHERE id = ?`).bind(stratId).first();
        if (!existing) return jsonResponse({ error: "Nicht gefunden" }, 404);
        if (existing.is_default || existing.protected) return jsonResponse({ error: "Standardstrategie kann nicht gelöscht werden" }, 403);
        await env.DB.prepare(`DELETE FROM strategies WHERE id = ?`).bind(stratId).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname.endsWith("/activate") && url.pathname.startsWith("/strategies/")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const stratId = url.pathname.replace("/activate", "").slice("/strategies/".length);
        await env.DB.prepare(`UPDATE strategies SET active = 0`).run();
        await env.DB.prepare(`UPDATE strategies SET active = 1, updated_at = ? WHERE id = ?`).bind(Date.now(), stratId).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "POST" && url.pathname === "/strategies/reset-to-default") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        await env.DB.prepare(`UPDATE strategies SET active = 0`).run();
        await env.DB.prepare(`UPDATE strategies SET active = 1, updated_at = ? WHERE is_default = 1`).bind(Date.now()).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "GET" && url.pathname === "/strategies/compare") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const rows = await env.DB.prepare(`
            SELECT strategy_id, strategy_name, strategy_version,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN'  THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
              SUM(CASE WHEN outcome='OPEN' THEN 1 ELSE 0 END) as open_count,
              SUM(CASE WHEN ai_recommendation='WAIT' THEN 1 ELSE 0 END) as wait_count,
              SUM(CASE WHEN ai_recommendation='SKIP' THEN 1 ELSE 0 END) as skip_count,
              AVG(ai_score) as avg_score
            FROM signals WHERE strategy_id IS NOT NULL
            GROUP BY strategy_id ORDER BY total DESC
          `).all();
          return jsonResponse((rows.results || []).map(r => ({
            ...r,
            winRate: (r.wins + r.losses) > 0 ? parseFloat(((r.wins / (r.wins + r.losses)) * 100).toFixed(1)) : 0,
            avg_score: r.avg_score ? parseFloat(r.avg_score.toFixed(1)) : 0
          })));
        } catch (e) { return jsonResponse([]); }
      }

      if (request.method === "POST" && url.pathname === "/strategies/ab-backtest") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session || !isTraderOrAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const { strategyIds } = await request.json();
        if (!strategyIds?.length) return jsonResponse({ error: "strategyIds required" }, 400);
        const signals = await env.DB.prepare(`SELECT * FROM signals ORDER BY created_at DESC LIMIT 100`).all();
        const results = [];
        for (const stratId of strategyIds) {
          const strat = await env.DB.prepare(`SELECT * FROM strategies WHERE id = ?`).bind(stratId).first();
          if (!strat) continue;
          const config = strat.config_json ? JSON.parse(strat.config_json) : DEFAULT_STRATEGY_CONFIG;
          let wins = 0, losses = 0, waitCount = 0, skipCount = 0, totalScore = 0;
          for (const sig of (signals.results || [])) {
            const analysis = analyzeWithRules(sig, config);
            totalScore += analysis.score;
            if (analysis.recommendation === 'WAIT') waitCount++;
            else if (analysis.recommendation === 'SKIP') skipCount++;
            if (sig.outcome === 'WIN') wins++;
            else if (sig.outcome === 'LOSS') losses++;
          }
          const total = (signals.results || []).length;
          const closed = wins + losses;
          results.push({
            strategyId: stratId, strategyName: strat.name, strategyVersion: strat.version,
            total, wins, losses, waitCount, skipCount,
            winRate: closed > 0 ? parseFloat(((wins / closed) * 100).toFixed(1)) : 0,
            avgScore: total > 0 ? parseFloat((totalScore / total).toFixed(1)) : 0
          });
        }
        return jsonResponse({ results, signalCount: (signals.results || []).length });
      }

      if (request.method === "GET" && url.pathname === "/strategies/suggestions") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const suggestions = [];
          const lowScoreLosses = await env.DB.prepare(`SELECT COUNT(*) as c FROM signals WHERE outcome='LOSS' AND ai_score < 70`).first();
          const lowScoreWins   = await env.DB.prepare(`SELECT COUNT(*) as c FROM signals WHERE outcome='WIN'  AND ai_score < 70`).first();
          if ((lowScoreLosses?.c || 0) > (lowScoreWins?.c || 0) && (lowScoreLosses?.c || 0) > 2) {
            suggestions.push({ type: 'score_threshold', priority: 'high', title: 'Min. Score erhöhen', message: `${lowScoreLosses.c} Losses hatten Score < 70. Erwäge min_trade_score auf 75+ zu erhöhen.`, action: 'Schwellenwert anpassen' });
          }
          const symRows = await env.DB.prepare(`
            SELECT symbol, COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
            FROM signals WHERE outcome IN ('WIN','LOSS')
            GROUP BY symbol HAVING (wins+losses) >= 3
            ORDER BY (wins*1.0/(wins+losses)) ASC LIMIT 3
          `).all();
          for (const sym of (symRows.results || [])) {
            const wr = (sym.wins + sym.losses) > 0 ? (sym.wins / (sym.wins + sym.losses)) * 100 : 0;
            if (wr < 35) suggestions.push({ type: 'symbol_filter', priority: 'medium', title: `${sym.symbol} performat schlecht`, message: `${sym.symbol}: ${wr.toFixed(0)}% Win-Rate bei ${sym.wins + sym.losses} Trades`, action: 'Symbol-Filter prüfen' });
          }
          const lrRows = await env.DB.prepare(`SELECT reason, COUNT(*) as cnt FROM signal_loss_reasons GROUP BY reason ORDER BY cnt DESC LIMIT 5`).all();
          for (const r of (lrRows.results || [])) {
            suggestions.push({ type: 'rule_weight', priority: 'low', title: `Häufiger Loss-Grund: ${r.reason}`, message: `"${r.reason}" wurde ${r.cnt}× als Verlustgrund markiert`, action: 'Regel-Gewicht anpassen' });
          }
          if (suggestions.length === 0) suggestions.push({ type: 'info', priority: 'low', title: 'Zu wenig Daten', message: 'Für aussagekräftige Vorschläge werden mehr abgeschlossene Trades benötigt.', action: null });
          return jsonResponse(suggestions);
        } catch (e) { return jsonResponse([{ type: 'error', priority: 'low', title: 'Fehler', message: e.message, action: null }]); }
      }

      // ── SIGNAL LOSS REASONS ──────────────────────────────────

      if (request.method === "POST" && url.pathname.startsWith("/signals/") && url.pathname.endsWith("/loss-reason")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.slice("/signals/".length, -"/loss-reason".length);
        const { reason, note, strategyId } = await request.json();
        if (!reason) return jsonResponse({ error: "reason required" }, 400);
        await ensureTables(env);
        await env.DB.prepare(`INSERT INTO signal_loss_reasons (signal_id, strategy_id, reason, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(signalId, strategyId || null, reason, note || null, Date.now(), session.username).run();
        return jsonResponse({ success: true });
      }

      if (request.method === "GET" && url.pathname.startsWith("/signals/") && url.pathname.endsWith("/loss-reasons")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const signalId = url.pathname.slice("/signals/".length, -"/loss-reasons".length);
        try {
          const rows = await env.DB.prepare(`SELECT * FROM signal_loss_reasons WHERE signal_id = ? ORDER BY created_at DESC`).bind(signalId).all();
          return jsonResponse(rows.results || []);
        } catch (_) { return jsonResponse([]); }
      }

      // ── ADMIN: ROLE CHANGE ──────────────────────────────────

      if (request.method === "PATCH" && url.pathname.startsWith("/admin/users/") && url.pathname.endsWith("/role")) {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!isAdmin(session)) return jsonResponse({ error: "Unauthorized" }, 401);
        const userId = url.pathname.split("/")[3];
        const { role } = await request.json();
        const validRoles = ['admin', 'trader', 'viewer', 'extern'];
        if (!validRoles.includes(role)) return jsonResponse({ error: "Ungültige Rolle" }, 400);
        await env.DB.prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`)
          .bind(role, Date.now(), userId).run();
        try {
          await env.DB.prepare(`UPDATE sessions SET role = ? WHERE user_id = ?`).bind(role, userId).run();
        } catch (_) {}
        return jsonResponse({ success: true });
      }

      // ── JOURNAL SYMBOLS ──────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/journal/symbols") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const raw = await getSetting(env, 'journal_symbols', '[]');
        try { return jsonResponse({ symbols: JSON.parse(raw) }); }
        catch { return jsonResponse({ symbols: [] }); }
      }

      if (request.method === "POST" && url.pathname === "/journal/symbols") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const raw = await getSetting(env, 'journal_symbols', '[]');
        let syms = (() => { try { return JSON.parse(raw); } catch { return []; } })();
        if (body.action === 'remove' && body.symbol) {
          syms = syms.filter(s => s !== body.symbol);
        } else if (body.symbol) {
          const sym = String(body.symbol).toUpperCase().trim();
          if (sym && !syms.includes(sym)) syms.push(sym);
        }
        await setSetting(env, 'journal_symbols', JSON.stringify(syms));
        return jsonResponse({ symbols: syms });
      }

      // ── MORNING ROUTINE ──────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/morning-routine/status") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const rows = await env.DB.prepare(
          `SELECT symbol, completed_at FROM morning_routines WHERE user_id = ? AND date = ?`
        ).bind(session.userId, date).all();
        const done = {};
        for (const row of (rows.results || [])) {
          if (row.completed_at) done[row.symbol] = true;
        }
        return jsonResponse(done);
      }

      if (request.method === "GET" && url.pathname === "/morning-routine") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const symbol = url.searchParams.get("symbol") || 'BTCUSDT';
        const routine = await env.DB.prepare(
          `SELECT * FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? ORDER BY created_at DESC LIMIT 1`
        ).bind(session.userId, date, symbol).first();
        return jsonResponse(routine || null);
      }

      if (request.method === "POST" && url.pathname === "/morning-routine") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const date = body.date || new Date().toISOString().slice(0, 10);
        const symbol = body.symbol || 'BTCUSDT';
        // Use symbol+user+date as the natural key so each symbol gets one routine per day
        const existing = await env.DB.prepare(
          `SELECT id FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? ORDER BY created_at DESC LIMIT 1`
        ).bind(session.userId, date, symbol).first();
        const id = existing?.id || body.id || `mr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO morning_routines (id, user_id, date, symbol, bias, chart_opened, ema200_checked, ema_direction, key_zones_marked, zone_notes, bias_reason, completed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET bias = excluded.bias, chart_opened = excluded.chart_opened, ema200_checked = excluded.ema200_checked, ema_direction = excluded.ema_direction, key_zones_marked = excluded.key_zones_marked, zone_notes = excluded.zone_notes, bias_reason = excluded.bias_reason, completed_at = excluded.completed_at
        `).bind(
          id, session.userId, date, symbol, body.bias || 'KEIN_TRADE',
          (body.chart_opened ?? body.chartOpened) ? 1 : 0,
          (body.ema200_checked ?? body.ema200Checked) ? 1 : 0,
          body.ema_direction || body.emaDirection || null,
          (body.key_zones_marked ?? body.keyZonesMarked) ? 1 : 0,
          body.zone_notes || body.zoneNotes || null,
          body.bias_reason || body.biasReason || null,
          body.bias ? now : (body.completed ? now : null), now
        ).run();
        return jsonResponse({ success: true, id });
      }

      // ── MORNING BRIEFING ─────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/morning-briefing") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const since = Date.now() - 14 * 60 * 60 * 1000; // last 14 hours
          const rows = await env.DB.prepare(
            `SELECT * FROM market_events WHERE status = 'ACTIVE' AND (updated_at >= ? OR created_at >= ?) ORDER BY impact DESC, event_time DESC LIMIT 30`
          ).bind(since, since).all();
          const events = rows.results || [];
          const highImpact = events.filter(e => e.impact === 'HIGH');
          const affectedSymbols = [...new Set(
            events.flatMap(e => { try { return JSON.parse(e.affected_symbols || '[]'); } catch { return []; } })
          )];
          const marketScope = highImpact.some(e => ['MACRO','GLOBAL','REGULATION'].includes(e.affected_scope))
            ? 'GLOBAL' : affectedSymbols.length > 0 ? 'COIN_SPECIFIC' : 'GLOBAL';
          const summary = events.length === 0
            ? 'Keine relevanten Marktnews in den letzten 14 Stunden.'
            : `${events.length} Ereignisse — ${highImpact.length} HIGH Impact.${affectedSymbols.length ? ' Betroffene Coins: ' + affectedSymbols.slice(0,5).join(', ') + '.' : ''} Erhöhte Aufmerksamkeit empfohlen. Kein direkter Trade-Hinweis.`;
          return jsonResponse({
            success: true,
            date: new Date().toISOString().slice(0, 10),
            summary,
            highImpact: highImpact.slice(0, 10),
            affectedSymbols: affectedSymbols.slice(0, 10),
            marketScope,
            events: events.slice(0, 20),
            disclaimer: 'Nur Marktübersicht. Keine Finanzberatung. Jeder Trade ist eigenverantwortlich zu prüfen.'
          });
        } catch (e) {
          return jsonResponse({ success: false, error: e.message }, 500);
        }
      }

      // ── TODAY BIAS ───────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/today-bias") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = new Date().toISOString().slice(0, 10);
        const symbol = url.searchParams.get("symbol") || null;
        const query = symbol
          ? `SELECT bias, completed_at FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? AND completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`
          : `SELECT bias, completed_at FROM morning_routines WHERE user_id = ? AND date = ? AND completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
        const routine = symbol
          ? await env.DB.prepare(query).bind(session.userId, date, symbol).first()
          : await env.DB.prepare(query).bind(session.userId, date).first();
        return jsonResponse({ date, bias: routine?.bias || null, routineDone: !!routine });
      }

      // ── PRE-TRADE CHECKLIST ──────────────────────────────────

      if (request.method === "GET" && url.pathname === "/pre-trade-checklist") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const symbol = url.searchParams.get("symbol") || 'BTCUSDT';
        // Enforce order: morning routine must be completed first
        const routine = await env.DB.prepare(
          `SELECT id FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? AND completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`
        ).bind(session.userId, date, symbol).first();
        if (!routine) {
          return jsonResponse({ locked: true, reason: `Bitte zuerst die Morgenroutine für ${symbol} abschließen.` });
        }
        const rows = await env.DB.prepare(
          `SELECT * FROM pre_trade_checklists WHERE user_id = ? AND date = ? AND symbol = ? ORDER BY created_at DESC`
        ).bind(session.userId, date, symbol).all();
        return jsonResponse(rows.results || []);
      }

      if (request.method === "POST" && url.pathname === "/pre-trade-checklist") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const symbol = body.symbol || 'BTCUSDT';
        const date = body.date || new Date().toISOString().slice(0, 10);
        // Enforce order: morning routine must be completed first
        const routine = await env.DB.prepare(
          `SELECT id FROM morning_routines WHERE user_id = ? AND date = ? AND symbol = ? AND completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`
        ).bind(session.userId, date, symbol).first();
        if (!routine) {
          return jsonResponse({ error: `Bitte zuerst die Morgenroutine für ${symbol} abschließen.`, locked: true }, 400);
        }
        const id = body.id || `ptc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO pre_trade_checklists (id, user_id, signal_id, date, symbol, bias_match, in_key_zone, structure_confirmed, no_chop, trend_candle, break_confirmed, rsi_ok, rsi_not_extreme, sl_logical, rr_ok, can_explain, clear_minded, no_fomo, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET bias_match=excluded.bias_match, in_key_zone=excluded.in_key_zone, structure_confirmed=excluded.structure_confirmed, no_chop=excluded.no_chop, trend_candle=excluded.trend_candle, break_confirmed=excluded.break_confirmed, rsi_ok=excluded.rsi_ok, rsi_not_extreme=excluded.rsi_not_extreme, sl_logical=excluded.sl_logical, rr_ok=excluded.rr_ok, can_explain=excluded.can_explain, clear_minded=excluded.clear_minded, no_fomo=excluded.no_fomo, notes=excluded.notes
        `).bind(
          id, session.userId, body.signal_id || body.signalId || null,
          date, symbol,
          (body.bias_match ?? body.biasMatch) ? 1 : 0,
          (body.in_key_zone ?? body.inKeyZone) ? 1 : 0,
          (body.structure_confirmed ?? body.structureConfirmed) ? 1 : 0,
          (body.no_chop ?? body.noChop) ? 1 : 0,
          (body.trend_candle ?? body.trendCandle) ? 1 : 0,
          (body.break_confirmed ?? body.breakConfirmed) ? 1 : 0,
          (body.rsi_ok ?? body.rsiOk) ? 1 : 0,
          (body.rsi_not_extreme ?? body.rsiNotExtreme) ? 1 : 0,
          (body.sl_logical ?? body.slLogical) ? 1 : 0,
          (body.rr_ok ?? body.rrOk) ? 1 : 0,
          (body.can_explain ?? body.canExplain) ? 1 : 0,
          (body.clear_minded ?? body.clearMinded) ? 1 : 0,
          (body.no_fomo ?? body.noFomo) ? 1 : 0,
          body.notes || null, now
        ).run();
        return jsonResponse({ success: true, id });
      }

      // ── TRADE REVIEW ─────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/trade-review") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
        const symbol = url.searchParams.get("symbol") || null;
        const rows = symbol
          ? await env.DB.prepare(`SELECT * FROM trade_reviews WHERE user_id = ? AND date = ? AND symbol = ? ORDER BY created_at DESC`).bind(session.userId, date, symbol).all()
          : await env.DB.prepare(`SELECT * FROM trade_reviews WHERE user_id = ? AND date = ? ORDER BY created_at DESC`).bind(session.userId, date).all();
        const mapped = (rows.results || []).map(r => ({
          ...r,
          entry_price:   r.entry_price  ?? r.entry,
          sl_price:      r.sl_price     ?? r.stop_loss,
          tp_price:      r.tp_price     ?? r.take_profit,
          lessons:       r.lessons      ?? r.lesson,
          trade_emotion: r.trade_emotion?? r.mood_before,
          respected_sl:  r.respected_sl ?? r.sl_not_moved,
          respected_tp:  r.respected_tp ?? r.tp_not_closed_early,
          would_retake:  r.would_retake ?? r.would_take_again,
          mistakes:      r.mistakes     ?? r.what_went_wrong,
        }));
        return jsonResponse(mapped);
      }

      if (request.method === "POST" && url.pathname === "/trade-review") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const symbol = body.symbol || body.instrument || 'BTCUSDT';
        const id = body.id || `tr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = Date.now();
        await env.DB.prepare(`
          INSERT INTO trade_reviews (id, user_id, signal_id, date, symbol, instrument, direction, entry, stop_loss, take_profit, exit_price, outcome, realized_rr, bias_clear, bias_direction, in_key_zone, structure_hl_lh, trend_candle_clean, break_confirmed, rsi_ok, sl_logical, rr_acceptable, what_went_well, what_went_wrong, discipline, mood_before, no_fomo, sl_not_moved, tp_not_closed_early, no_revenge, lesson, would_take_again, followed_plan, waited_confirmation, felt_confident, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET instrument=excluded.instrument, direction=excluded.direction, entry=excluded.entry, stop_loss=excluded.stop_loss, take_profit=excluded.take_profit, exit_price=excluded.exit_price, outcome=excluded.outcome, realized_rr=excluded.realized_rr, what_went_wrong=excluded.what_went_wrong, mood_before=excluded.mood_before, no_fomo=excluded.no_fomo, sl_not_moved=excluded.sl_not_moved, tp_not_closed_early=excluded.tp_not_closed_early, no_revenge=excluded.no_revenge, lesson=excluded.lesson, would_take_again=excluded.would_take_again, followed_plan=excluded.followed_plan, waited_confirmation=excluded.waited_confirmation, felt_confident=excluded.felt_confident, updated_at=excluded.updated_at
        `).bind(
          id, session.userId, body.signal_id || body.signalId || null,
          body.date || new Date().toISOString().slice(0, 10),
          symbol,
          body.instrument || null, body.direction || null,
          body.entry_price ?? body.entry ?? null,
          body.sl_price    ?? body.stopLoss ?? null,
          body.tp_price    ?? body.takeProfit ?? null,
          body.exit_price  ?? body.exitPrice ?? null,
          body.outcome || null,
          body.realizedRR || null,
          0, 0, 0, 0, 0, 0, 0, 0, 0,
          null,
          body.mistakes    || body.whatWentWrong || null,
          null,
          body.trade_emotion || body.moodBefore || null,
          (body.no_fomo ?? body.noFomo) ? 1 : 0,
          (body.respected_sl ?? body.slNotMoved) ? 1 : 0,
          (body.respected_tp ?? body.tpNotClosedEarly) ? 1 : 0,
          (body.no_revenge ?? body.noRevenge) ? 1 : 0,
          body.lessons || body.lesson || null,
          (body.would_retake ?? body.wouldTakeAgain) ? 1 : 0,
          (body.followed_plan ?? body.followedPlan) ? 1 : 0,
          (body.waited_confirmation ?? body.waitedConfirmation) ? 1 : 0,
          (body.felt_confident ?? body.feltConfident) ? 1 : 0,
          now, now
        ).run();
        return jsonResponse({ success: true, id });
      }

      // ── BIAS STATS ───────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/bias-stats") {
        const session = await validateSession(env, request.headers.get("X-Session-ID"));
        if (!session) return jsonResponse({ error: "Unauthorized" }, 401);
        try {
          const all = await env.DB.prepare(
            `SELECT outcome, daily_bias, before_morning_routine, counts_for_strategy FROM signals WHERE outcome IN ('WIN','LOSS')`
          ).all();
          const rows = all.results || [];
          const calc = (filter) => {
            const s = rows.filter(filter);
            const w = s.filter(r => r.outcome === 'WIN').length;
            const l = s.filter(r => r.outcome === 'LOSS').length;
            return { total: s.length, wins: w, losses: l, winRate: (w + l) > 0 ? parseFloat(((w / (w + l)) * 100).toFixed(1)) : 0 };
          };
          return jsonResponse({
            official:   calc(r => r.counts_for_strategy === 1),
            all:        calc(() => true),
            biasConform: calc(r => r.bias_match === 'conform'),
            againstBias: calc(r => r.bias_match === 'against'),
            beforeRoutine: calc(r => r.before_morning_routine === 1),
            noTradeDay:  calc(r => r.daily_bias === 'KEIN_TRADE'),
          });
        } catch (e) { return jsonResponse({ error: e.message }, 500); }
      }

      // ── WEBHOOK (TradingView) ────────────────────────────────

      if (request.method === "POST" && url.pathname === "/webhook") {
        const secret = url.searchParams.get("secret");
        if (env.WEBHOOK_SECRET && secret !== env.WEBHOOK_SECRET) {
          console.warn('⛔ Webhook: wrong or missing secret');
          return jsonResponse({ error: "Unauthorized" }, 401);
        }

        let rawBody = '';
        let payload = null;

        try {
          rawBody = await request.text();
          console.log('📥 Webhook raw body:', rawBody.substring(0, 1000));
        } catch (readErr) {
          console.error('❌ Failed to read request body:', readErr.message);
          return jsonResponse({ error: 'Failed to read body', message: readErr.message }, 400);
        }

        try {
          payload = JSON.parse(rawBody);
          console.log('📦 Parsed payload:', JSON.stringify(payload).substring(0, 500));
        } catch (parseErr) {
          console.error('❌ JSON parse error:', parseErr.message, '| raw:', rawBody.substring(0, 200));
          return jsonResponse({
            error: 'Invalid JSON',
            message: parseErr.message,
            rawBodyPreview: rawBody.substring(0, 200)
          }, 400);
        }

        const eventType = (payload.event_type || 'SIGNAL').toUpperCase();
        console.log('🎯 event_type:', eventType, '| symbol:', payload.symbol, '| action:', payload.action);

        try {
          if (eventType === 'SNAPSHOT') {
            ctx.waitUntil(
              saveSnapshot(env, payload).catch(err => console.error('❌ SNAPSHOT async save failed:', err?.message || err))
            );
            return jsonResponse({ success: true, type: 'SNAPSHOT', message: 'Snapshot accepted' });
          }

          if (eventType === 'PRICE_UPDATE') {
            ctx.waitUntil(
              handlePriceUpdate(env, payload).catch(err => console.error('❌ PRICE_UPDATE async failed:', err?.message || err))
            );
            return jsonResponse({ success: true, type: 'PRICE_UPDATE', message: 'Price update accepted' });
          }

          if (eventType === 'SIGNAL_NEW' || eventType === 'SIGNAL') {
            const direction = normalizeDirection(payload);
            const action    = normalizeAction(payload);
            if (!direction) {
              console.log('⏭️ SIGNAL_NEW skipped — no recognisable direction:', JSON.stringify(payload).substring(0, 300));
              return jsonResponse({ success: true, type: 'SIGNAL_NEW', status: 'skipped', reason: 'no_actionable_direction', direction, action });
            }
            return jsonResponse(await processSignal(env, payload));
          }

          return jsonResponse({ success: true, type: eventType, message: 'Unsupported event_type accepted' });
        } catch (processingErr) {
          const errMsg = processingErr?.message || String(processingErr);
          console.error('❌ Webhook processing error:', errMsg, processingErr?.stack);
          return jsonResponse({
            success: false,
            type: eventType,
            error: errMsg,
            message: 'Processing failed — signal NOT saved. Check Worker logs.'
          }, 500);
        }
      }

      // ── HEALTH CHECK ────────────────────────────────────────

      if (request.method === "GET" && url.pathname === "/health") {
        let dbStatus = 'unknown';
        try { await env.DB.prepare('SELECT 1').first(); dbStatus = 'ok'; }
        catch (e) { dbStatus = 'error: ' + e.message; }
        return jsonResponse({
          status: 'ok',
          time: new Date().toISOString(),
          version: '3.4.0-production',
          db: dbStatus
        });
      }

      return new Response("WAVESCOUT v3.4 Production ✅", { headers: CORS_HEADERS });

    } catch (error) {
      console.error('❌ Unhandled worker error:', error.message);
      console.error('Stack:', error.stack);
      return jsonResponse({ error: "Internal Server Error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    console.log('⏰ Cron triggered:', event.cron);

    // Every 3h: close open trades that are in profit
    if (event.cron === "0 */3 * * *") {
      await check3hProfitClose(env);
    }

    // Every 4h: evaluate TP/SL hits + profit-close for 4h window
    if (event.cron === "0 */4 * * *") {
      await check3hProfitClose(env);
      await evaluateOpenTrades(env);
    }

    // Re-evaluate open practice trades with latest snapshot prices
    try {
      const tableCheck = await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='practice_trades'`
      ).first();
      if (tableCheck) {
        const openTrades = await env.DB.prepare(
          `SELECT DISTINCT symbol FROM practice_trades WHERE status='OPEN'`
        ).all();
        for (const row of (openTrades.results || [])) {
          const snap = await getSnapshot(env, row.symbol, '5m');
          if (snap?.price) await checkPracticeTrades(env, row.symbol, snap.price);
        }
      }
    } catch (err) {
      console.error('❌ Practice trades cron error:', err.message);
    }

    if (event.cron === "0 7 * * *") {
      await sendDailySummary(env);
    }
  }
};
