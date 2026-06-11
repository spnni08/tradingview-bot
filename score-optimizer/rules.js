// rules.js — Kanonische Regel-Definitionen für den WAVESCOUT Score Optimizer.
//
// Der Worker speichert Regeln als deutsche Freitext-Strings mit dynamischen
// Zahlen ("RSI neutral-niedrig (44)"). Für die Kalibrierung werden sie auf
// stabile Keys normalisiert. Zusätzlich werden abgeleitete Features berechnet
// (RSI-Buckets, EMA200-Distanz, Session), die nicht als Regel-String existieren,
// aber laut Backtesting die stärksten Signale tragen.

// ── Kanonische Regel-Keys ──────────────────────────────────────
// re wird gegen den rohen Regel-String gematcht (matched_rules / failed_rules).
export const RULE_PATTERNS = [
  // RSI
  { key: 'RSI_EXTREME_SETUP_A',     re: /^RSI extrem über(kauft|verkauft) \(\d+\) – Setup A/u,             label: 'RSI extrem (>75/<25) – Setup A Reversal' },
  { key: 'RSI_REVERSAL_RISK',       re: /^RSI extrem über(kauft|verkauft) \(\d+\) – (Reversal-Risiko|kein Continuation)/u, label: 'RSI extrem – Reversal-Risiko (gegen Richtung)' },
  { key: 'RSI_PULLBACK_IDEAL',      re: /^RSI über(kauft|verkauft) \(\d+\) – Pullback günstig/u,           label: 'RSI überkauft/überverkauft – Pullback-Entry (Setup A ideal)' },
  { key: 'RSI_SETUP_A_FIT',         re: /^RSI (niedrig|hoch) \(\d+\) – passt zu Setup A/u,                 label: 'RSI niedrig/hoch – passt zu Setup A' },
  { key: 'RSI_NEUTRAL_LOW_LONG',    re: /^RSI neutral-niedrig \(\d+\)/u,                                   label: 'RSI neutral-niedrig (40–50) bei LONG' },
  { key: 'RSI_NEUTRAL_HIGH_SHORT',  re: /^RSI neutral-hoch \(\d+\)/u,                                      label: 'RSI neutral-hoch (50–60) bei SHORT' },
  { key: 'RSI_NEUTRAL',             re: /^RSI neutral \(\d+\)/u,                                           label: 'RSI neutral (50–60 LONG / 40–50 SHORT)' },
  { key: 'RSI_NO_PULLBACK',         re: /– kein Pullback-Entry$/u,                                         label: 'RSI auf falscher Seite – kein Pullback-Entry' },
  { key: 'RSI_CAUTION',             re: /– Vorsicht bei (LONG|SHORT)$/u,                                   label: 'RSI hoch/niedrig – Vorsicht' },
  { key: 'RSI_TREND_RANGE_B',       re: /^RSI \d+ im Trend-Bereich/u,                                      label: 'RSI im Trend-Bereich (Setup B)' },
  { key: 'RSI_SETUP_B_PARTIAL',     re: /^RSI \d+ – (leicht (unter|über) Trend-Bereich|(Stärke|Schwäche) passt zu Setup B)/u, label: 'RSI nahe Trend-Bereich (Setup B partial)' },
  { key: 'RSI_OUTSIDE_B',           re: /^RSI \d+ – außerhalb Setup B Bereich/u,                           label: 'RSI außerhalb Setup B Bereich' },

  // EMA 50/200
  { key: 'EMA200_PROXIMITY_EXCLUSION', re: /^Preis zu nah an EMA ?200/u,                                   label: 'Preis <0,5% an EMA200 – Ausschluss v2.0' },
  { key: 'EMA_ALIGNED_LONG',        re: /^EMA bullish \(EMA50>EMA200.*– LONG$/u,                           label: 'EMA bullish Alignment – LONG' },
  { key: 'EMA_ALIGNED_SHORT',       re: /^EMA bearish \(EMA50<EMA200.*– SHORT$/u,                          label: 'EMA bearish Alignment – SHORT' },
  { key: 'EMA_AGAINST',             re: /^EMA (bullish|bearish) – Trend gegen/u,                           label: 'EMA Alignment gegen Trade-Richtung' },
  { key: 'PRICE_WRONG_SIDE_EMA200', re: /^Preis (unter|über) EMA ?200 – kein/u,                            label: 'Preis auf falscher Seite der EMA200' },

  // Trend-Label & Wave Bias
  { key: 'TREND_MATCH',             re: /^Trend (BULLISH|BEARISH) – passt zu/u,                            label: 'Trend-Label kongruent' },
  { key: 'TREND_AGAINST',           re: /^Trend (BULLISH|BEARISH) – gegen/u,                               label: 'Trend-Label gegen Richtung' },
  { key: 'WAVE_MATCH',              re: /^Wave Bias (LONG|SHORT) – passt zu/u,                             label: 'Wave Bias kongruent' },
  { key: 'WAVE_AGAINST',            re: /^Wave Bias (LONG|SHORT) – gegen/u,                                label: 'Wave Bias gegen Richtung' },

  // Timeframe
  { key: 'TF_ENTRY',                re: /^Timeframe \d+min – Entry-Timeframe/u,                            label: 'Timeframe 5/15min (Entry-TF)' },
  { key: 'TF_SHORT_OK',             re: /– kurz, aber gültig$/u,                                           label: 'Timeframe 1/3min' },
  { key: 'TF_HIGHER',               re: /– (höherer TF|Bias-TF)/u,                                         label: 'Höherer Timeframe' },
  { key: 'TF_UNKNOWN',              re: /^Timeframe .* – unbekannt$/u,                                     label: 'Timeframe unbekannt' },

  // Support / Resistance
  { key: 'SR_SUPPORT_NEAR_LONG',    re: /^Preis nah an Support/u,                                          label: 'Support-Nähe – LONG' },
  { key: 'SR_RESISTANCE_NEAR_SHORT',re: /^Preis nah an Resistance/u,                                       label: 'Resistance-Nähe – SHORT' },
  { key: 'SR_TOO_FAR',              re: /^Preis zu weit von (Support|Resistance)/u,                        label: 'Preis zu weit von S/R-Zone' },
  { key: 'SR_NOT_IN_ZONE',          re: /^Preis nicht in Key-Zone/u,                                       label: 'Preis nicht in Key-Zone' },

  // Session
  { key: 'SESSION_LONDON',          re: /^London-Open Session/u,                                           label: 'London-Open Session (07–10 UTC)' },
  { key: 'SESSION_US',              re: /^US-Open Session/u,                                               label: 'US-Open Session (13:30–16 UTC)' },

  // Konfidenz & News
  { key: 'CONF_HIGH',               re: /^Konfidenz \d+%? – hoch/u,                                        label: 'Konfidenz hoch' },
  { key: 'CONF_MID',                re: /^Konfidenz \d+%? – mittel/u,                                      label: 'Konfidenz mittel' },
  { key: 'CONF_LOW',                re: /^Konfidenz \d+%? – niedrig/u,                                     label: 'Konfidenz niedrig' },
  { key: 'NEWS_HIGH_IMPACT',        re: /HIGH-Impact News/u,                                               label: 'HIGH-Impact News aktiv' },
];

export const RULE_LABELS = Object.fromEntries(RULE_PATTERNS.map(p => [p.key, p.label]));

// Abgeleitete Features (nicht in den Regel-Strings enthalten)
export const FEATURE_LABELS = {
  RSI_55_65:        'RSI 55–65 (Neutralzone)',
  EMA_DIST_SWEET:   'EMA200-Distanz 0,5–1,3% + Alignment (Sweet Spot)',
  EMA_DIST_FAR:     'EMA200-Distanz >3%',
  CLUSTERED_ENTRY:  'Korrelierter Einstieg (≥2 Signale gleiche Richtung in 5min)',
};

// Alte Gewichte (aktuelle Worker-Formel, approximiert) — Fallback für Keys
// ohne ausreichende Datenbasis.
export const DEFAULT_WEIGHTS = {
  RSI_EXTREME_SETUP_A: 9,  RSI_REVERSAL_RISK: -18, RSI_PULLBACK_IDEAL: 18,
  RSI_SETUP_A_FIT: 10,     RSI_NEUTRAL_LOW_LONG: 4, RSI_NEUTRAL_HIGH_SHORT: 4,
  RSI_NEUTRAL: 0,          RSI_NO_PULLBACK: -18,    RSI_CAUTION: -6,
  RSI_TREND_RANGE_B: 18,   RSI_SETUP_B_PARTIAL: 7,  RSI_OUTSIDE_B: -5,
  EMA200_PROXIMITY_EXCLUSION: -12,
  EMA_ALIGNED_LONG: 10,    EMA_ALIGNED_SHORT: 10,   EMA_AGAINST: -15,
  PRICE_WRONG_SIDE_EMA200: -6,
  TREND_MATCH: 10,         TREND_AGAINST: -10,
  WAVE_MATCH: 8,           WAVE_AGAINST: -4,
  TF_ENTRY: 7,             TF_SHORT_OK: 4,          TF_HIGHER: 2, TF_UNKNOWN: 0,
  SR_SUPPORT_NEAR_LONG: 10, SR_RESISTANCE_NEAR_SHORT: 10,
  SR_TOO_FAR: 0,           SR_NOT_IN_ZONE: 0,
  SESSION_LONDON: 5,       SESSION_US: 5,
  CONF_HIGH: 7,            CONF_MID: 4,             CONF_LOW: 0,
  NEWS_HIGH_IMPACT: -5,
  // Features haben in der alten Formel kein Gewicht:
  RSI_55_65: 0, EMA_DIST_SWEET: 0, EMA_DIST_FAR: 0, CLUSTERED_ENTRY: 0,
};

/** Normalisiert einen rohen Regel-String auf einen kanonischen Key. */
export function normalizeRule(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  for (const p of RULE_PATTERNS) {
    if (p.re.test(s)) return p.key;
  }
  // Fallback: Zahlen maskieren, damit unbekannte Regeln stabil gruppieren
  return 'RAW:' + s.replace(/\d+(?:[.,]\d+)?\s*%?/g, '#').replace(/\s+/g, ' ').trim();
}

/** Parsed matched_rules/failed_rules: JSON-Array ODER pipe-separierter String. */
export function parseRuleList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const s = String(value).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try { return JSON.parse(s).map(String).filter(Boolean); } catch { /* fall through */ }
  }
  return s.split('|').map(x => x.trim()).filter(Boolean);
}

const num = v => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Session aus UTC-Zeitstempel ("YYYY-MM-DD HH:MM:SS" oder Date/ms). */
export function sessionOf(createdAt) {
  let d = createdAt;
  if (typeof d === 'string') d = new Date(d.includes('T') ? d : d.replace(' ', 'T') + 'Z');
  else if (typeof d === 'number') d = new Date(d);
  if (!(d instanceof Date) || isNaN(d)) return null;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 7 * 60 && mins <= 10 * 60) return 'LONDON';
  if (mins >= 13 * 60 + 30 && mins <= 16 * 60) return 'US';
  return 'OFF';
}

/**
 * Abgeleitete Features eines Trades/Signals (für Kalibrierung und Live-Score).
 * Erwartet Felder: rsi, ema50, ema200, price, direction, created_at|created_at_readable.
 */
export function deriveFeatures(t) {
  const out = [];
  const rsi = num(t.rsi);
  if (rsi != null && rsi >= 55 && rsi <= 65) out.push('RSI_55_65');

  const price = num(t.price) ?? num(t.ai_entry);
  const ema50 = num(t.ema50);
  const ema200 = num(t.ema200);
  const dir = String(t.direction || '').toUpperCase();
  if (price && ema200) {
    const dist = Math.abs(price - ema200) / ema200 * 100; // in %
    const aligned = ema50 && ((dir === 'LONG' && ema50 > ema200) || (dir === 'SHORT' && ema50 < ema200));
    if (aligned && dist >= 0.5 && dist <= 1.3) out.push('EMA_DIST_SWEET');
    if (dist > 3) out.push('EMA_DIST_FAR');
  }
  return out;
}

/**
 * Regel-Engine: leitet aus rohen Signal-Feldern die kanonischen Regeln ab.
 * Spiegelt die Setup-A-Logik des Workers (Pullback), gibt {keys, reasons, unknown}.
 */
export function deriveRules(signal) {
  const keys = [];
  const reasons = [];
  const unknown = [];
  const add = (key, reason) => { keys.push(key); reasons.push(reason); };

  const dir = String(signal.direction || '').toUpperCase();
  const isLong = dir === 'LONG';
  const isShort = dir === 'SHORT';
  const rsi = num(signal.rsi);

  // RSI (Setup A Pullback-Logik, Schwellen wie Worker-Defaults 30/40/60/70)
  if (rsi == null) unknown.push('RSI (keine Daten)');
  else if (rsi > 75) {
    if (isLong) add('RSI_REVERSAL_RISK', `RSI extrem überkauft (${rsi.toFixed(0)}) – Reversal-Risiko für LONG`);
    if (isShort) add('RSI_EXTREME_SETUP_A', `RSI extrem überkauft (${rsi.toFixed(0)}) – Setup A SHORT`);
  } else if (rsi < 25) {
    if (isShort) add('RSI_REVERSAL_RISK', `RSI extrem überverkauft (${rsi.toFixed(0)}) – Reversal-Risiko für SHORT`);
    if (isLong) add('RSI_EXTREME_SETUP_A', `RSI extrem überverkauft (${rsi.toFixed(0)}) – Setup A LONG`);
  } else if (isLong) {
    if (rsi < 30)      add('RSI_PULLBACK_IDEAL', `RSI überverkauft (${rsi.toFixed(0)}) – Pullback günstig für LONG`);
    else if (rsi < 40) add('RSI_SETUP_A_FIT', `RSI niedrig (${rsi.toFixed(0)}) – passt zu Setup A LONG`);
    else if (rsi < 50) add('RSI_NEUTRAL_LOW_LONG', `RSI neutral-niedrig (${rsi.toFixed(0)})`);
    else if (rsi > 70) add('RSI_NO_PULLBACK', `RSI überkauft (${rsi.toFixed(0)}) – kein Pullback-Entry`);
    else if (rsi > 60) add('RSI_CAUTION', `RSI hoch (${rsi.toFixed(0)}) – Vorsicht bei LONG`);
    else               add('RSI_NEUTRAL', `RSI neutral (${rsi.toFixed(0)})`);
  } else if (isShort) {
    if (rsi > 70)      add('RSI_PULLBACK_IDEAL', `RSI überkauft (${rsi.toFixed(0)}) – Pullback günstig für SHORT`);
    else if (rsi > 60) add('RSI_SETUP_A_FIT', `RSI hoch (${rsi.toFixed(0)}) – passt zu Setup A SHORT`);
    else if (rsi > 50) add('RSI_NEUTRAL_HIGH_SHORT', `RSI neutral-hoch (${rsi.toFixed(0)})`);
    else if (rsi < 30) add('RSI_NO_PULLBACK', `RSI überverkauft (${rsi.toFixed(0)}) – kein Pullback-Entry`);
    else if (rsi < 40) add('RSI_CAUTION', `RSI niedrig (${rsi.toFixed(0)}) – Vorsicht bei SHORT`);
    else               add('RSI_NEUTRAL', `RSI neutral (${rsi.toFixed(0)})`);
  }

  // EMA 50/200
  const ema50 = num(signal.ema50);
  const ema200 = num(signal.ema200);
  const price = num(signal.price) ?? num(signal.ai_entry);
  if (!ema50 || !ema200) unknown.push('EMA 50/200 (keine Daten)');
  else {
    const bullish = ema50 > ema200;
    const dist = price ? Math.abs(price - ema200) / ema200 : 0;
    if (price && dist < 0.005) {
      add('EMA200_PROXIMITY_EXCLUSION', `Preis ${(dist * 100).toFixed(2)}% an EMA200 (alte Ausschluss-Regel)`);
    } else {
      if (isLong && bullish)   add('EMA_ALIGNED_LONG', `EMA bullish (Dist ${(dist * 100).toFixed(1)}%) – LONG`);
      if (isShort && !bullish) add('EMA_ALIGNED_SHORT', `EMA bearish (Dist ${(dist * 100).toFixed(1)}%) – SHORT`);
      if (isLong && !bullish)  add('EMA_AGAINST', 'EMA bearish – Trend gegen LONG');
      if (isShort && bullish)  add('EMA_AGAINST', 'EMA bullish – Trend gegen SHORT');
      if (price && isLong && price < ema200)  add('PRICE_WRONG_SIDE_EMA200', 'Preis unter EMA200 – kein Long-Bias');
      if (price && isShort && price > ema200) add('PRICE_WRONG_SIDE_EMA200', 'Preis über EMA200 – kein Short-Bias');
    }
  }

  // Trend-Label
  const trend = String(signal.trend || '').toUpperCase();
  if (trend === 'BULLISH' || trend === 'UP') add(isLong ? 'TREND_MATCH' : 'TREND_AGAINST', `Trend BULLISH – ${isLong ? 'passt zu LONG' : 'gegen SHORT'}`);
  else if (trend === 'BEARISH' || trend === 'DOWN') add(isShort ? 'TREND_MATCH' : 'TREND_AGAINST', `Trend BEARISH – ${isShort ? 'passt zu SHORT' : 'gegen LONG'}`);

  // Wave Bias
  const wave = String(signal.wave_bias || '').toUpperCase();
  if (wave === 'LONG')  add(isLong ? 'WAVE_MATCH' : 'WAVE_AGAINST', `Wave Bias LONG – ${isLong ? 'passt' : 'gegen SHORT'}`);
  if (wave === 'SHORT') add(isShort ? 'WAVE_MATCH' : 'WAVE_AGAINST', `Wave Bias SHORT – ${isShort ? 'passt' : 'gegen LONG'}`);

  // Timeframe
  const tf = String(signal.timeframe || '').replace('m', '').replace('h', 'H');
  if (['5', '15'].includes(tf)) add('TF_ENTRY', `Timeframe ${tf}min – Entry-Timeframe`);
  else if (['1', '3'].includes(tf)) add('TF_SHORT_OK', `Timeframe ${tf}min – kurz, aber gültig`);
  else if (['30', '60', '1H', '240', '4H'].includes(tf)) add('TF_HIGHER', `Timeframe ${tf} – höherer TF`);
  else if (tf) add('TF_UNKNOWN', `Timeframe ${tf} – unbekannt`);

  // Support / Resistance (nur wenn Zonen geliefert)
  const support = num(signal.support);
  const resistance = num(signal.resistance);
  if (price && (support || resistance)) {
    if (isLong && support && price > support && (price - support) / price < 0.02) add('SR_SUPPORT_NEAR_LONG', 'Preis nah an Support – LONG');
    else if (isShort && resistance && price < resistance && (resistance - price) / price < 0.02) add('SR_RESISTANCE_NEAR_SHORT', 'Preis nah an Resistance – SHORT');
    else add('SR_NOT_IN_ZONE', 'Preis nicht in Key-Zone');
  }

  // Session (aus Signal-Zeit, nicht aus Auswertungszeit!)
  const session = sessionOf(signal.created_at ?? signal.created_at_readable ?? signal.timestamp ?? Date.now());
  if (session === 'LONDON') add('SESSION_LONDON', 'London-Open Session (07–10 UTC)');
  if (session === 'US') add('SESSION_US', 'US-Open Session (13:30–16 UTC)');

  // Konfidenz
  const conf = num(signal.confidence);
  if (conf != null) {
    if (conf >= 80) add('CONF_HIGH', `Konfidenz ${conf}% – hoch`);
    else if (conf >= 60) add('CONF_MID', `Konfidenz ${conf}% – mittel`);
    else add('CONF_LOW', `Konfidenz ${conf}% – niedrig`);
  }

  // Vom Aufrufer mitgelieferte rohe Regel-Strings ergänzen (z. B. News-Flags)
  for (const raw of [...parseRuleList(signal.matchedRules ?? signal.matched_rules), ...parseRuleList(signal.failedRules ?? signal.failed_rules)]) {
    const key = normalizeRule(raw);
    if (key && !keys.includes(key)) { keys.push(key); reasons.push(raw); }
  }

  // Abgeleitete Features
  for (const f of deriveFeatures(signal)) {
    if (!keys.includes(f)) { keys.push(f); reasons.push(FEATURE_LABELS[f] || f); }
  }

  return { keys, reasons, unknown };
}

export function labelOf(key) {
  return RULE_LABELS[key] || FEATURE_LABELS[key] || key;
}
