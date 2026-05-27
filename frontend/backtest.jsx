// ═══════════════════════════════════════════════════════════════
// WAVESCOUT v3.5 - BACKTESTING & STRATEGIE-LABOR
// ═══════════════════════════════════════════════════════════════

const { useState, useEffect, useRef, useCallback } = React;

const API_URL = 'https://tradingview-bot.spnn08.workers.dev';

// ─── Strategy config metadata (mirrors worker.js) ─────────────

const RULE_META = {
  rsi: {
    label: 'RSI',
    desc: 'Prüft, ob Momentum zur Richtung passt und ob der Markt überkauft/überverkauft ist.',
    tooltip: 'RSI (Relative Strength Index) misst die Kursdynamik zwischen 0–100. Überverkauft (<lowerBound) = potenzielle LONG-Chance (Setup A). Überkauft (>upperBound) = potenzielle SHORT-Chance.',
    maxW: 30,
    params: {
      lowerBound:          { label: 'Überverkauft-Grenze',         default: 30, min: 10, max: 50, desc: 'RSI unter diesem Wert = überverkauft → Setup A LONG-Chance' },
      upperBound:          { label: 'Überkauft-Grenze',            default: 70, min: 50, max: 90, desc: 'RSI über diesem Wert = überkauft → Setup A SHORT-Chance' },
      longPreferredAbove:  { label: 'LONG bevorzugt ab RSI ≥',     default: 40, min: 20, max: 65, desc: 'LONG-Trades erzielen Teilpunkte ab diesem RSI-Wert aufwärts' },
      shortPreferredBelow: { label: 'SHORT bevorzugt unter RSI ≤', default: 60, min: 35, max: 80, desc: 'SHORT-Trades erzielen Teilpunkte unter diesem RSI-Wert' },
    }
  },
  ema: {
    label: 'EMA 50/200',
    desc: 'Bewertet, ob Preis und Trend über/unter den wichtigen EMAs liegen. EMA-Kreuzungen werden als Trendsignal gewertet.',
    tooltip: 'EMA50 = kurzfristiger Trend, EMA200 = langfristiger Trend. EMA50 > EMA200 = bullish. Preis direkt am EMA200 (<0.5% Abstand) gilt als Ausschlusskriterium (zu unsicher).',
    maxW: 30,
    params: null
  },
  trend: {
    label: 'Trend-Label',
    desc: 'Prüft, ob das BULLISH/BEARISH-Label mit der Trade-Richtung übereinstimmt. Gegenläufige Trades erhalten Abzüge.',
    tooltip: 'Das Trend-Label kommt direkt aus TradingView (BULLISH/BEARISH). Passt es zur Trade-Richtung, erhält das Signal volle Punkte. Gegenläufig = Abzug.',
    maxW: 30,
    params: null
  },
  wave_bias: {
    label: 'Wave Bias',
    desc: 'Bewertet, ob der Tagesbias aus der Morgenroutine mit der Signal-Richtung übereinstimmt (LONG/SHORT).',
    tooltip: 'Der Wave Bias wird täglich in der Morgenroutine festgelegt. Stimmt ein Signal damit überein, erhält es Bonus-Punkte. NEUTRAL = kein Abzug, aber auch kein Bonus.',
    maxW: 20,
    params: null
  },
  support_resistance: {
    label: 'Support/Resistance',
    desc: 'Prüft Nähe zu wichtigen S/R-Zonen. Entries in der Nähe von Zonen erhalten Bonus-Punkte.',
    tooltip: 'Support = Kaufzone (Preis springt hoch), Resistance = Verkaufszone (Preis dreht ab). Ein Entry nahe dieser Zonen bietet statistisch günstigeres Risiko/Ertrag-Verhältnis.',
    maxW: 30,
    params: null
  },
  timeframe: {
    label: 'Timeframe',
    desc: 'Bewertet den Zeitrahmen des Signals. Höhere Zeitrahmen (4H, 1D) erhalten mehr Gewichtung als niedrige (1M, 5M).',
    tooltip: 'Signale auf höheren Zeitrahmen haben weniger Rauschen und mehr Zuverlässigkeit. 15min = guter Einstiegs-TF, 5min = nur mit Kontext aus höheren Zeitrahmen sinnvoll.',
    maxW: 20,
    params: null
  },
  confidence: {
    label: 'Confidence',
    desc: 'Wertet die vom Sender gelieferte Signal-Konfidenz aus. Höhere Konfidenz erhöht den Score, niedrige reduziert ihn.',
    tooltip: 'Die Konfidenz wird von TradingView oder der AI-Analyse mitgesendet. HIGH = voller Gewichtungsbeitrag, MEDIUM = 50%, LOW = 0 Punkte.',
    maxW: 20,
    params: null
  },
  session_filter: {
    label: 'Session-Filter',
    desc: 'Bewertet, ob das Signal während einer liquiden Handelssession (London/US-Open) eingeht.',
    tooltip: 'London-Session 07:00–10:00 UTC und US-Open 13:30–16:00 UTC sind die liquidesten Phasen des Tages. Signale in diesen Fenstern erhalten Bonus-Punkte für bessere Ausführbarkeit.',
    maxW: 10,
    params: null
  },
};

const DEFAULT_RULE_WEIGHTS = {
  rsi: 18, ema: 15, trend: 10, wave_bias: 8,
  support_resistance: 10, timeframe: 7, confidence: 7, session_filter: 5
};

const LOSS_REASONS = [
  'RSI Fehlsignal', 'EMA zu spät', 'Trend falsch erkannt', 'Support/Resistance falsch',
  'Seitwärtsmarkt', 'SL zu eng', 'TP zu weit', 'News/Volatilität',
  'Signal zu spät', 'Kein 1H/4H Kontext', 'Manuell geschlossen', 'Sonstiges',
];

// ─── Helpers ──────────────────────────────────────────────────

function calculatePnL(trade) {
  if (!trade.exit_price || !trade.ai_entry || trade.ai_entry === 0) return 0;
  const pct = ((trade.exit_price - trade.ai_entry) / trade.ai_entry) * 100;
  return trade.direction === 'LONG' ? pct : -pct;
}

function fmtDate(val) {
  const d = new Date(val);
  if (isNaN(d)) return '–';
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
    + ' ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '–';
  return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtPrice(v, symbol = '') {
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  const s = String(symbol || '').toUpperCase();
  if (s.includes('BTC') || s.includes('XAU') || s.includes('NAS')) return n.toFixed(2);
  const abs = Math.abs(n);
  if (abs < 0.01) return n.toFixed(8);
  if (abs < 1) return n.toFixed(6);
  return n.toFixed(4);
}

// ─── iOS Toggle ────────────────────────────────────────────────

function Toggle({ on, onChange, disabled }) {
  return (
    <button
      className={`ios-toggle ${on ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!on)}
      disabled={disabled}
      role="switch"
      aria-checked={on}
    />
  );
}

// ─── PnL Chart ─────────────────────────────────────────────────

function PnLChart({ points }) {
  const W = 100, H = 60;
  if (!points || points.length < 2) return null;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;
  const toY = v => H - ((v - min) / range) * H;
  const toX = i => (i / (points.length - 1)) * W;
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p).toFixed(1)}`).join(' ');
  const zero  = toY(0);
  const fillD = `${pathD} L ${toX(points.length - 1).toFixed(1)} ${zero} L 0 ${zero} Z`;
  const color = points[points.length - 1] >= 0 ? 'var(--win)' : 'var(--loss)';
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 80 }} preserveAspectRatio="none">
      <defs>
        <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.3"/>
          <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      {zero > 0 && zero < H && <line x1="0" y1={zero.toFixed(1)} x2={W} y2={zero.toFixed(1)} stroke="var(--border)" strokeWidth="0.5"/>}
      <path d={fillD} fill="url(#pnlGrad)"/>
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.2"/>
    </svg>
  );
}

// ─── Outcome Selector (shared) ────────────────────────────────
const OutcomeSelector = ({ tradeId, current, onChange }) => (
  <window.OutcomeEditor
    id={tradeId}
    currentOutcome={current}
    type={String(tradeId).startsWith('signal_') ? 'signal' : 'practice'}
    onUpdated={(next) => onChange(tradeId, next)}
  />
);

// ─── Loss Reason Modal ─────────────────────────────────────────

function LossReasonModal({ signalId, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [note,   setNote]   = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!reason) return;
    setSaving(true);
    try {
      await fetch(`${API_URL}/signals/${signalId}/loss-reason`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({ reason, note: note.trim() || null })
      });
      onSaved?.();
      onClose();
    } catch (e) { console.error(e); } finally { setSaving(false); }
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Loss-Grund markieren</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 8, display: 'block', color: 'var(--text-secondary)' }}>Grund auswählen</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {LOSS_REASONS.map(r => (
                <button key={r} onClick={() => setReason(r)} className="btn btn-sm" style={{ fontSize: 11, background: reason === r ? 'rgba(59,130,246,0.15)' : 'var(--bg-3)', color: reason === r ? 'var(--blue-400)' : 'var(--text-secondary)', border: `1px solid ${reason === r ? 'rgba(59,130,246,0.35)' : 'var(--border)'}` }}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'block', color: 'var(--text-secondary)' }}>Notiz (optional)</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="Zusätzliche Anmerkung…" style={{ width: '100%' }}/>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
          <button className="btn btn-primary" onClick={save} disabled={!reason || saving}>
            {saving ? <div className="spinner-sm"/> : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Signal Detail Modal ───────────────────────────────────────

function SignalDetailModal({ signal, onClose, onMarkLoss }) {
  if (!signal) return null;
  const pnl = calculatePnL(signal);

  const sc         = signal.ai_score || 0;
  const scoreColor = sc >= 80 ? 'var(--win)' : sc >= 65 ? 'var(--wait)' : 'var(--loss)';
  const scoreLabel = sc >= 90 ? 'PREMIUM' : sc >= 75 ? 'GUT' : sc >= 60 ? 'OKAY' : sc >= 45 ? 'SCHWACH' : 'SKIP';
  const rr         = signal.risk_reward;
  const rrStr      = rr ? '1:' + parseFloat(rr).toFixed(1) : '–';
  const fmt        = (v) => { const n = Number(v); return Number.isFinite(n) ? '$' + n.toFixed(2) : '–'; };

  const safeParse      = (s, def) => { try { return JSON.parse(s) ?? def; } catch (_) { return def; } };
  const matchedRules   = safeParse(signal.matched_rules,  []);
  const failedRules    = safeParse(signal.failed_rules,   []);
  const unknownRules   = safeParse(signal.unknown_rules,  []);
  const breakdownEntries = Object.entries(safeParse(signal.score_breakdown, {})).filter(([, v]) => v !== 0);

  const RULE_LABELS = {
    rsi: 'RSI', ema: 'EMA', trend: 'Trend', wave_bias: 'Wave Bias',
    support_resistance: 'S&R Zone', timeframe: 'Timeframe',
    confidence: 'Konfidenz', session_filter: 'Session',
  };

  const biasStatus = signal.daily_bias
    ? (signal.bias_match === 'conform'
        ? { color: 'var(--win)',          icon: '✓', label: `Bias konform (${signal.daily_bias})` }
        : signal.bias_match === 'against'
        ? { color: 'var(--loss)',         icon: '✗', label: `Gegen Bias (${signal.daily_bias})` }
        : { color: 'var(--text-tertiary)', icon: '–', label: `Bias: ${signal.daily_bias}` })
    : { color: 'var(--text-quaternary)', icon: '–', label: 'Kein Tagesbias' };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: 640, maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="modal-head" style={{ position: 'sticky', top: 0, background: 'var(--bg-1)', zIndex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className={`badge ${signal.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{signal.direction}</span>
            <h3 style={{ margin: 0 }}>{signal.symbol}</h3>
            <span className="badge badge-tag" style={{ fontSize: 11 }}>{signal.timeframe ? signal.timeframe + 'm' : '–'}</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '0 20px 20px' }}>

          {/* Score + Quality */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '16px 0 12px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ textAlign: 'center', flexShrink: 0 }}>
              <div style={{ fontSize: 32, fontWeight: 800, fontFamily: 'var(--font-mono)', color: scoreColor, lineHeight: 1 }}>{sc}</div>
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 2 }}>Score</div>
            </div>
            <div style={{ width: 1, height: 40, background: 'var(--border)', flexShrink: 0 }}/>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: scoreColor }}>{scoreLabel}</div>
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{signal.signal_quality || '–'}</div>
            </div>
            <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Ergebnis</div>
              <span className={`badge ${signal.outcome === 'WIN' ? 'badge-win' : signal.outcome === 'LOSS' ? 'badge-loss' : signal.outcome === 'IGNORED' ? 'badge-neutral' : 'badge-wait'}`} style={{ marginTop: 4 }}>
                {signal.outcome || 'OPEN'}
              </span>
            </div>
          </div>

          {/* Prices grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
            {[
              ['Entry',      fmt(signal.ai_entry ?? signal.price), 'var(--text-primary)'],
              ['Take Profit', fmt(signal.ai_tp),                    'var(--win)'],
              ['Stop Loss',   fmt(signal.ai_sl),                    'var(--loss)'],
              ['Exit',        fmt(signal.exit_price),               pnl > 0 ? 'var(--win)' : pnl < 0 ? 'var(--loss)' : 'var(--text-primary)'],
              ['R:R',         rrStr,                                rr && rr >= 1.5 ? 'var(--win)' : rr ? 'var(--wait)' : 'var(--text-tertiary)'],
              ['PnL',         pnl !== 0 ? fmtPct(pnl) : '–',      pnl > 0 ? 'var(--win)' : pnl < 0 ? 'var(--loss)' : 'var(--text-tertiary)'],
            ].map(([l, v, c]) => (
              <div key={l} style={{ background: 'var(--bg-0)', borderRadius: 8, padding: '8px 12px' }}>
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 3 }}>{l}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: c }}>{v}</div>
              </div>
            ))}
          </div>

          {/* Planned profit/risk */}
          {(signal.planned_profit_pct != null || signal.planned_risk_pct != null) && (
            <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
              {signal.planned_profit_pct != null && (
                <span style={{ color: 'var(--win)' }}>Geplanter Gewinn: +{parseFloat(signal.planned_profit_pct).toFixed(2)}%</span>
              )}
              {signal.planned_risk_pct != null && (
                <span style={{ color: 'var(--loss)' }}>Geplantes Risiko: -{parseFloat(signal.planned_risk_pct).toFixed(2)}%</span>
              )}
            </div>
          )}

          {/* Strategy status */}
          <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>STRATEGIE-STATUS</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: signal.counts_for_strategy !== 0 ? 'var(--win)' : 'var(--loss)', display: 'inline-block' }}/>
                {signal.counts_for_strategy !== 0 ? 'Zählt zur Strategie' : 'Zählt nicht zur Strategie'}
              </span>
              <span style={{ color: biasStatus.color }}>{biasStatus.icon} {biasStatus.label}</span>
              {signal.strategy_name && (
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {signal.strategy_name} {signal.strategy_version || ''}
                </span>
              )}
            </div>
          </div>

          {/* Score breakdown */}
          {breakdownEntries.length > 0 && (
            <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>SCORE-AUFSCHLÜSSELUNG</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-quaternary)', marginBottom: 2 }}>
                  <span>Basis</span><span style={{ fontFamily: 'var(--font-mono)' }}>+50</span>
                </div>
                {breakdownEntries.map(([key, val]) => (
                  <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{RULE_LABELS[key] || key}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: val > 0 ? 'var(--win)' : 'var(--loss)' }}>
                      {val > 0 ? '+' : ''}{val}
                    </span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 700, borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 2 }}>
                  <span>Gesamt</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: scoreColor }}>{sc}/100</span>
                </div>
              </div>
            </div>
          )}

          {/* Matched / Failed / Unknown rules */}
          {(matchedRules.length > 0 || failedRules.length > 0 || unknownRules.length > 0) && (
            <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 8 }}>STRATEGIE-CHECK</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {matchedRules.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
                    <span style={{ color: 'var(--win)', flexShrink: 0, marginTop: 1 }}>✓</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{r}</span>
                  </div>
                ))}
                {failedRules.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
                    <span style={{ color: 'var(--loss)', flexShrink: 0, marginTop: 1 }}>✗</span>
                    <span style={{ color: 'var(--text-secondary)' }}>{r}</span>
                  </div>
                ))}
                {unknownRules.map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-tertiary)', flexShrink: 0, marginTop: 1 }}>?</span>
                    <span style={{ color: 'var(--text-tertiary)' }}>{r}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI Reason */}
          {signal.ai_reason && (
            <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 6 }}>ANALYSE-BEGRÜNDUNG</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', background: 'var(--bg-0)', borderRadius: 8, padding: '8px 12px', lineHeight: 1.6 }}>{signal.ai_reason}</div>
            </div>
          )}

          {/* Meta info */}
          <div style={{ paddingTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 20px', fontSize: 12 }}>
            {[
              ['Datum',          fmtDate(signal.created_at)],
              ['RSI',            signal.rsi ?? '–'],
              ['EMA 50',         signal.ema50  ? signal.ema50.toFixed(0)  : '–'],
              ['EMA 200',        signal.ema200 ? signal.ema200.toFixed(0) : '–'],
              ['Trend',          signal.trend     || '–'],
              ['Wave Bias',      signal.wave_bias || '–'],
              ['Risiko-Level',   signal.ai_risk   || '–'],
              ['Empfehlung',     signal.ai_recommendation || '–'],
              ['Telegram',       signal.telegram_sent ? `✓ Gesendet (${signal.telegram_reason || ''})` : `– ${signal.telegram_reason || 'nicht gesendet'}`],
              ['Quelle',         signal.source || 'WEBHOOK'],
            ].map(([l, v]) => (
              <div key={l}>
                <span style={{ color: 'var(--text-quaternary)' }}>{l}: </span>
                <span style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="modal-foot" style={{ position: 'sticky', bottom: 0, background: 'var(--bg-1)' }}>
          {signal.outcome === 'LOSS' && (
            <button className="btn btn-ghost" style={{ color: 'var(--loss)', marginRight: 'auto' }} onClick={() => { onMarkLoss?.(); onClose(); }}>
              Loss-Grund markieren
            </button>
          )}
          <button className="btn btn-ghost" onClick={onClose}>Schließen</button>
        </div>
      </div>
    </div>
  );
}

// ─── Practice Trades Tab ───────────────────────────────────────

function PracticeTradesTab() {
  const [trades, setTrades]   = useState([]);
  const [stats,  setStats]    = useState(null);
  const [loading,setLoading]  = useState(true);
  const [fSymbol,setFSymbol]  = useState('all');
  const [fTf,    setFTf]      = useState('all');
  const [fDir,   setFDir]     = useState('all');
  const [fStatus,setFStatus]  = useState('all');

  useEffect(() => { load(); }, []);
  const load = async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch(`${API_URL}/practice-trades?limit=200`, { credentials: 'include' }),
        fetch(`${API_URL}/practice-trades/stats`,     { credentials: 'include' })
      ]);
      if (tRes.ok) setTrades(await tRes.json());
      if (sRes.ok) setStats(await sRes.json());
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const symbols    = ['all', ...new Set(trades.map(t => t.symbol).filter(Boolean))];
  const timeframes = ['all', ...new Set(trades.map(t => t.timeframe).filter(Boolean))];
  const filtered   = trades.filter(t => {
    if (fSymbol !== 'all' && t.symbol    !== fSymbol)  return false;
    if (fTf     !== 'all' && t.timeframe !== fTf)      return false;
    if (fDir    !== 'all' && t.direction !== fDir)     return false;
    if (fStatus !== 'all' && t.status    !== fStatus)  return false;
    return true;
  });

  const updatePracticeStatus = async (tradeId, status) => {
    setTrades(prev => prev.map(t => String(t.id) === String(tradeId) ? { ...t, status } : t));
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade Übungstrades…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="kpi-grid">
        <div className="kpi-card"><div className="kpi-val">{stats?.total ?? 0}</div><div className="kpi-lbl">Gesamt</div></div>
        <div className="kpi-card"><div className="kpi-val">{stats?.open ?? 0}</div><div className="kpi-lbl">Offen</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--win)' }}>{stats?.wins ?? 0}</div><div className="kpi-lbl">Wins</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--loss)' }}>{stats?.losses ?? 0}</div><div className="kpi-lbl">Losses</div></div>
        <div className="kpi-card">
          <div className="kpi-val" style={{ color: (stats?.winRate ?? 0) >= 50 ? 'var(--win)' : 'var(--loss)' }}>{(stats?.winRate ?? 0).toFixed(1)}%</div>
          <div className="kpi-lbl">Win-Rate</div>
        </div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--win)' }}>{fmtPct(stats?.avgWinPct)}</div><div className="kpi-lbl">Ø Gewinn</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--loss)' }}>{fmtPct(stats?.avgLossPct)}</div><div className="kpi-lbl">Ø Verlust</div></div>
      </div>

      <div className="card">
        <div className="card-head">
          <Icon name="filter" className="ico"/><h3>Filter</h3>
          <div className="actions">
            <button className="btn btn-ghost btn-sm" onClick={() => { setFSymbol('all'); setFTf('all'); setFDir('all'); setFStatus('all'); }}>Zurücksetzen</button>
            <button className="btn btn-ghost btn-sm" onClick={load}>↻</button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {[
              { label: 'Symbol',    value: fSymbol, set: setFSymbol, opts: symbols.map(s => [s, s === 'all' ? 'Alle Symbole' : s]) },
              { label: 'Timeframe', value: fTf,     set: setFTf,    opts: timeframes.map(t => [t, t === 'all' ? 'Alle TFs' : t + 'm']) },
              { label: 'Richtung',  value: fDir,    set: setFDir,   opts: [['all','Alle'],['LONG','Long'],['SHORT','Short']] },
              { label: 'Status',    value: fStatus, set: setFStatus,opts: [['all','Alle'],['OPEN','Offen'],['WIN','Gewinner'],['LOSS','Verlierer']] },
            ].map(({ label, value, set, opts }) => (
              <div key={label}>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 12, fontWeight: 500 }}>{label}</label>
                <select value={value} onChange={e => set(e.target.value)} className="input" style={{ minWidth: 140 }}>
                  {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico"/><h3>Übungstrades</h3>
          <div className="actions"><span className="badge badge-tag">{filtered.length}</span></div>
        </div>
        {filtered.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-tertiary)' }}>{trades.length === 0 ? 'Noch keine Übungstrades — werden automatisch beim nächsten Signal erstellt' : 'Keine Trades mit diesen Filtern'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>#</th><th>Datum</th><th>Symbol</th><th>TF</th><th>Richtung</th><th>Entry</th><th>TP</th><th>SL</th><th>Exit</th><th>Result</th><th>Status</th></tr></thead>
              <tbody>
                {filtered.map((t, i) => (
                  <tr key={t.id ?? i}>
                    <td className="mono muted" style={{ fontSize: 11 }}>{t.id}</td>
                    <td className="mono muted" style={{ fontSize: 11 }}>{fmtDate(t.created_at)}</td>
                    <td><AssetChip symbol={t.symbol}/></td>
                    <td className="mono muted">{t.timeframe}</td>
                    <td><span className={`badge ${t.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{t.direction}</span></td>
                    <td className="mono">${fmtPrice((t.entry_price || 0), t.symbol)}</td>
                    <td className="mono" style={{ color: 'var(--win)' }}>${fmtPrice((t.take_profit || 0), t.symbol)}</td>
                    <td className="mono" style={{ color: 'var(--loss)' }}>${fmtPrice((t.stop_loss || 0), t.symbol)}</td>
                    <td className="mono">{t.exit_price ? `$${t.exit_price.toFixed(2)}` : '–'}</td>
                    <td className={`mono ${t.result_pct > 0 ? 'win' : t.result_pct < 0 ? 'loss' : ''}`}>{t.result_pct != null ? fmtPct(t.result_pct) : '–'}</td>
                    <td><OutcomeSelector tradeId={t.id} current={t.status} onChange={updatePracticeStatus}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Signal History Tab ────────────────────────────────────────

const EMPTY_HIST_FILTERS = {
  outcome: 'all', symbol: 'all', direction: 'all',
  quality: 'all', official: 'all', biasMatch: 'all',
  scoreMin: '', scoreMax: '', ruleSearch: '',
};

function SignalHistoryTab() {
  const [history,   setHistory]   = useState([]);
  const [stats,     setStats]     = useState(null);
  const [loading,   setLoading]   = useState(true);
  const [filters,   setFilters]   = useState({ ...EMPTY_HIST_FILTERS });
  const [selected,  setSelected]  = useState(null);
  const [lossModal, setLossModal] = useState(null);

  useEffect(() => { load(); }, []);
  const load = async () => {
    setLoading(true);
    try {
      const [hRes, sRes] = await Promise.all([
        fetch(`${API_URL}/history?limit=500`, { credentials: 'include' }),
        fetch(`${API_URL}/stats`,             { credentials: 'include' }),
      ]);
      if (hRes.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      setHistory(hRes.ok ? await hRes.json() : []);
      setStats(sRes.ok  ? await sRes.json()  : null);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const setF = (key, val) => setFilters(f => ({ ...f, [key]: val }));
  const resetFilters = () => setFilters({ ...EMPTY_HIST_FILTERS });
  const isFiltered = Object.entries(filters).some(([k, v]) => v !== EMPTY_HIST_FILTERS[k]);

  const updateOutcome = (tradeId, outcome) => {
    setHistory(prev => prev.map(t => t.id === tradeId ? { ...t, outcome } : t));
  };

  const parseRules = (val) => { try { return JSON.parse(val || '[]'); } catch { return []; } };

  const filtered = history.filter(h => {
    if (filters.outcome   !== 'all' && h.outcome !== filters.outcome) return false;
    if (filters.symbol    !== 'all' && h.symbol  !== filters.symbol)  return false;
    if (filters.direction !== 'all' && h.direction !== filters.direction) return false;
    if (filters.quality   !== 'all' && h.signal_quality !== filters.quality) return false;
    if (filters.official  !== 'all') {
      if (filters.official === 'official'   && !(h.counts_for_strategy === 1)) return false;
      if (filters.official === 'unofficial' &&   h.counts_for_strategy === 1)  return false;
    }
    if (filters.biasMatch !== 'all' && h.bias_match !== filters.biasMatch) return false;
    if (filters.scoreMin !== '' && (h.ai_score || 0) < Number(filters.scoreMin)) return false;
    if (filters.scoreMax !== '' && (h.ai_score || 0) > Number(filters.scoreMax)) return false;
    if (filters.ruleSearch !== '') {
      const q = filters.ruleSearch.toLowerCase();
      const matched = parseRules(h.matched_rules).map(r => (r.rule || r).toLowerCase()).join(' ');
      const failed  = parseRules(h.failed_rules).map(r => (r.rule || r).toLowerCase()).join(' ');
      if (!matched.includes(q) && !failed.includes(q)) return false;
    }
    return true;
  });

  const fWins   = filtered.filter(t => t.outcome === 'WIN').length;
  const fLosses = filtered.filter(t => t.outcome === 'LOSS').length;
  const fBE     = filtered.filter(t => t.outcome === 'BE').length;
  const fOpen   = filtered.filter(t => t.outcome === 'OPEN' || !t.outcome).length;
  const fClosed = fWins + fLosses;
  const fWinRate = fClosed > 0 ? ((fWins / fClosed) * 100).toFixed(1) : '–';
  const fScores = filtered.map(t => t.ai_score).filter(s => s != null);
  const fAvgScore = fScores.length ? (fScores.reduce((a, b) => a + b, 0) / fScores.length).toFixed(1) : '–';
  const fRRs = filtered.map(t => parseFloat(t.risk_reward)).filter(r => r > 0);
  const fAvgRR = fRRs.length ? (fRRs.reduce((a, b) => a + b, 0) / fRRs.length).toFixed(2) : '–';

  const totalClosed = (stats?.wins || 0) + (stats?.losses || 0);
  const winRate     = totalClosed > 0 ? (stats.wins / totalClosed) * 100 : 0;
  const symbols     = ['all', ...new Set(history.map(h => h.symbol).filter(Boolean))];
  const closedTrades = history.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS').slice().reverse();
  let cumulative = 0;
  const pnlPoints = closedTrades.map(t => { cumulative += calculatePnL(t); return cumulative; });

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade Signal-History…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {selected   && <SignalDetailModal signal={selected} onClose={() => setSelected(null)} onMarkLoss={() => { setLossModal(selected.id); setSelected(null); }}/>}
      {lossModal  && <LossReasonModal signalId={lossModal} onClose={() => setLossModal(null)} onSaved={() => setLossModal(null)}/>}

      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="kpi-card"><div className="kpi-val">{history.length}</div><div className="kpi-lbl">Total Signale</div></div>
        <div className="kpi-card"><div className="kpi-val">{totalClosed}</div><div className="kpi-lbl">Abgeschlossen</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: winRate >= 50 ? 'var(--win)' : 'var(--loss)' }}>{winRate.toFixed(1)}%</div><div className="kpi-lbl">Win-Rate (gesamt)</div></div>
        <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--text-tertiary)' }}>{stats?.open || 0}</div><div className="kpi-lbl">Offen</div></div>
      </div>

      {pnlPoints.length >= 2 && (
        <div className="card">
          <div className="card-head"><Icon name="chart" className="ico"/><h3>Kumulativer PnL</h3>
            <div className="actions"><span className={`badge ${pnlPoints[pnlPoints.length-1] >= 0 ? 'badge-win' : 'badge-loss'}`}>{pnlPoints[pnlPoints.length-1] >= 0 ? '+' : ''}{pnlPoints[pnlPoints.length-1].toFixed(2)}%</span></div>
          </div>
          <div className="card-body" style={{ padding: '12px 20px 16px' }}><PnLChart points={pnlPoints}/></div>
        </div>
      )}

      {/* Extended Filters */}
      <div className="card">
        <div className="card-head">
          <Icon name="filter" className="ico"/><h3>Filter</h3>
          {isFiltered && <div className="actions"><button className="btn btn-ghost btn-sm" onClick={resetFilters}>Zurücksetzen</button></div>}
        </div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.06em' }}>ERGEBNIS</label>
              <select value={filters.outcome} onChange={e => setF('outcome', e.target.value)} className="input">
                <option value="all">Alle</option>
                <option value="WIN">Win</option>
                <option value="LOSS">Loss</option>
                <option value="BE">Break Even</option>
                <option value="OPEN">Offen</option>
                <option value="IGNORED">Ignoriert</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.06em' }}>SYMBOL</label>
              <select value={filters.symbol} onChange={e => setF('symbol', e.target.value)} className="input">
                {symbols.map(s => <option key={s} value={s}>{s === 'all' ? 'Alle' : s}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.06em' }}>RICHTUNG</label>
              <select value={filters.direction} onChange={e => setF('direction', e.target.value)} className="input">
                <option value="all">Alle</option>
                <option value="LONG">LONG</option>
                <option value="SHORT">SHORT</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.06em' }}>QUALITÄT</label>
              <select value={filters.quality} onChange={e => setF('quality', e.target.value)} className="input">
                <option value="all">Alle</option>
                <option value="PREMIUM">Premium</option>
                <option value="GUT">Gut</option>
                <option value="OKAY">Okay</option>
                <option value="SCHWACH">Schwach</option>
                <option value="SKIP">Skip</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.06em' }}>BIAS-MATCH</label>
              <select value={filters.biasMatch} onChange={e => setF('biasMatch', e.target.value)} className="input">
                <option value="all">Alle</option>
                <option value="conform">Bias-Konform</option>
                <option value="against">Gegen Bias</option>
                <option value="none">Kein Bias</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.06em' }}>STRATEGIE</label>
              <select value={filters.official} onChange={e => setF('official', e.target.value)} className="input">
                <option value="all">Alle</option>
                <option value="official">Offiziell</option>
                <option value="unofficial">Inoffiziell</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.06em' }}>SCORE MIN</label>
              <input type="number" value={filters.scoreMin} onChange={e => setF('scoreMin', e.target.value)} placeholder="0" className="input" min="0" max="100"/>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.06em' }}>SCORE MAX</label>
              <input type="number" value={filters.scoreMax} onChange={e => setF('scoreMax', e.target.value)} placeholder="100" className="input" min="0" max="100"/>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={{ display: 'block', marginBottom: 5, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '.06em' }}>REGEL ENTHÄLT (matched oder failed)</label>
            <input type="text" value={filters.ruleSearch} onChange={e => setF('ruleSearch', e.target.value)} placeholder="z.B. rsi, ema, trend…" className="input" style={{ maxWidth: 320 }}/>
          </div>
        </div>
      </div>

      {/* Filtered Stats Bar */}
      {isFiltered && (
        <div className="card">
          <div className="card-head"><Icon name="stats" className="ico"/><h3>Gefilterte Statistiken</h3>
            <span className="badge badge-tag" style={{ marginLeft: 'auto' }}>{filtered.length} Signale</span>
          </div>
          <div className="card-body">
            <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
              <div className="kpi-card"><div className="kpi-val win">{fWins}</div><div className="kpi-lbl">Wins</div></div>
              <div className="kpi-card"><div className="kpi-val loss">{fLosses}</div><div className="kpi-lbl">Losses</div></div>
              <div className="kpi-card"><div className="kpi-val">{fBE}</div><div className="kpi-lbl">Break Even</div></div>
              <div className="kpi-card"><div className="kpi-val" style={{ color: 'var(--text-tertiary)' }}>{fOpen}</div><div className="kpi-lbl">Offen</div></div>
              <div className="kpi-card"><div className="kpi-val" style={{ color: parseFloat(fWinRate) >= 50 ? 'var(--win)' : 'var(--loss)' }}>{fWinRate === '–' ? '–' : `${fWinRate}%`}</div><div className="kpi-lbl">Win-Rate</div></div>
              <div className="kpi-card"><div className="kpi-val">{fAvgScore}</div><div className="kpi-lbl">Ø Score</div></div>
              <div className="kpi-card"><div className="kpi-val">{fAvgRR === '–' ? '–' : `1:${fAvgRR}`}</div><div className="kpi-lbl">Ø R:R</div></div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><Icon name="signal" className="ico"/><h3>Trade History</h3>
          <div className="actions"><span className="badge badge-tag">{filtered.length}</span></div>
        </div>
        {filtered.length === 0 ? (
          <div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-tertiary)' }}>{history.length === 0 ? 'Noch keine Signale empfangen' : 'Keine Trades mit diesen Filtern'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>#</th><th>Datum</th><th>Symbol</th><th>Richtung</th><th>Entry</th><th>TP</th><th>SL</th><th>Exit</th><th>PnL</th><th>Score</th><th>R:R</th><th>Auslöser</th><th>Qualität</th><th>Strategie</th><th>Ergebnis</th></tr></thead>
              <tbody>
                {filtered.map((trade, i) => {
                  const pnl = calculatePnL(trade);
                  const qualColor = trade.signal_quality === 'PREMIUM' ? 'var(--win)' : trade.signal_quality === 'GUT' ? 'var(--blue-400)' : trade.signal_quality === 'OKAY' ? 'var(--wait)' : trade.signal_quality === 'SCHWACH' ? 'var(--loss)' : trade.signal_quality === 'SKIP' ? 'var(--text-quaternary)' : 'var(--text-tertiary)';
                  return (
                    <tr key={i} style={{ cursor: 'pointer' }} onClick={() => setSelected(trade)}>
                      <td className="mono" style={{ fontSize: 10, color: 'var(--text-quaternary)', letterSpacing: '.03em' }}>{trade.id ? trade.id.slice(-8) : '–'}</td>
                      <td className="mono muted" style={{ fontSize: 11 }}>{fmtDate(trade.created_at)}</td>
                      <td><AssetChip symbol={trade.symbol}/></td>
                      <td><span className={`badge ${trade.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{trade.direction}</span></td>
                      <td className="mono">${(trade.ai_entry || trade.price || 0).toFixed(2)}</td>
                      <td className="mono" style={{ color: 'var(--win)' }}>{trade.ai_tp  ? `$${fmtPrice(trade.ai_tp, trade.symbol)}`  : '—'}</td>
                      <td className="mono" style={{ color: 'var(--loss)' }}>{trade.ai_sl ? `$${fmtPrice(trade.ai_sl, trade.symbol)}`  : '—'}</td>
                      <td className="mono">{trade.exit_price ? `$${fmtPrice(trade.exit_price, trade.symbol)}` : '—'}</td>
                      <td className={`mono ${pnl > 0 ? 'win' : pnl < 0 ? 'loss' : ''}`}>{pnl !== 0 ? fmtPct(pnl) : '—'}</td>
                      <td className="mono">{trade.ai_score || 0}</td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {trade.risk_reward ? `1:${parseFloat(trade.risk_reward).toFixed(1)}` : '–'}
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--text-tertiary)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={trade.trigger_reason || trade.trigger || trade.action || ''}>
                        {trade.trigger_reason || trade.trigger || trade.action || '–'}
                      </td>
                      <td style={{ fontSize: 11, fontWeight: 600, color: qualColor }}>{trade.signal_quality || '–'}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{trade.strategy_name || 'Standard'} <span style={{ color: 'var(--text-quaternary)' }}>{trade.strategy_version || ''}</span></td>
                      <td onClick={e => e.stopPropagation()}>
                        <OutcomeSelector tradeId={trade.id} current={trade.outcome} onChange={updateOutcome}/>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ padding: '10px 20px', fontSize: 12, color: 'var(--text-tertiary)', borderTop: '1px solid var(--border)' }}>
              Klicke auf eine Zeile für Details
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Rule Frequency Tab ────────────────────────────────────────

function RuleFrequencyTab() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/history?limit=500`, { credentials: 'include' });
      if (res.status === 401) { localStorage.clear(); window.location.href = 'login.html'; return; }
      const signals = res.ok ? await res.json() : [];

      const parseRules = (val) => { try { const arr = JSON.parse(val || '[]'); return arr.map(r => typeof r === 'string' ? r : (r.rule || r.name || JSON.stringify(r))); } catch { return []; } };

      const matchedInWins  = {};
      const failedInLosses = {};
      const matchedTotal   = {};
      const failedTotal    = {};

      for (const s of signals) {
        const matched = parseRules(s.matched_rules);
        const failed  = parseRules(s.failed_rules);
        matched.forEach(r => {
          matchedTotal[r] = (matchedTotal[r] || 0) + 1;
          if (s.outcome === 'WIN') matchedInWins[r] = (matchedInWins[r] || 0) + 1;
        });
        failed.forEach(r => {
          failedTotal[r] = (failedTotal[r] || 0) + 1;
          if (s.outcome === 'LOSS') failedInLosses[r] = (failedInLosses[r] || 0) + 1;
        });
      }

      const wins   = signals.filter(s => s.outcome === 'WIN').length;
      const losses = signals.filter(s => s.outcome === 'LOSS').length;

      const matchedRows = Object.entries(matchedTotal).map(([rule, total]) => {
        const inWins = matchedInWins[rule] || 0;
        return { rule, total, inWins, winRate: total > 0 ? ((inWins / total) * 100).toFixed(1) : '0.0' };
      }).sort((a, b) => b.inWins - a.inWins);

      const failedRows = Object.entries(failedTotal).map(([rule, total]) => {
        const inLosses = failedInLosses[rule] || 0;
        return { rule, total, inLosses, lossRate: total > 0 ? ((inLosses / total) * 100).toFixed(1) : '0.0' };
      }).sort((a, b) => b.inLosses - a.inLosses);

      setData({ matchedRows, failedRows, wins, losses, total: signals.length });
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Analysiere Regeln…</div>;
  if (!data || data.total === 0) return (
    <div className="card"><div className="card-body" style={{ padding: 60, textAlign: 'center' }}>
      <p style={{ color: 'var(--text-tertiary)' }}>Noch keine Signale mit Regel-Daten vorhanden</p>
    </div></div>
  );

  const labelMap = { rsi: 'RSI', ema: 'EMA 50/200', trend: 'Trend-Label', wave_bias: 'Wave Bias', support_resistance: 'Support/Resistance', timeframe: 'Timeframe', confidence: 'Confidence' };
  const ruleLabel = r => labelMap[r] || r;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="kpi-card"><div className="kpi-val">{data.total}</div><div className="kpi-lbl">Analysierte Signale</div></div>
        <div className="kpi-card"><div className="kpi-val win">{data.wins}</div><div className="kpi-lbl">Wins</div></div>
        <div className="kpi-card"><div className="kpi-val loss">{data.losses}</div><div className="kpi-lbl">Losses</div></div>
      </div>

      <div className="card">
        <div className="card-head"><Icon name="chart" className="ico"/><h3>Matched Rules → Wins</h3>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 8 }}>Welche gematchten Regeln kommen in Wins vor?</span>
        </div>
        {data.matchedRows.length === 0 ? (
          <div className="card-body"><p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Keine Daten (Signale haben noch keine matched_rules)</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Regel</th><th>In Wins</th><th>Total matched</th><th>Win-Rate wenn matched</th></tr></thead>
              <tbody>
                {data.matchedRows.map((row, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{ruleLabel(row.rule)}</td>
                    <td className="mono win">{row.inWins}</td>
                    <td className="mono">{row.total}</td>
                    <td className="mono" style={{ color: parseFloat(row.winRate) >= 50 ? 'var(--win)' : 'var(--loss)' }}>{row.winRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head"><Icon name="chart" className="ico"/><h3>Failed Rules → Losses</h3>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', marginLeft: 8 }}>Welche nicht-erfüllten Regeln kommen in Losses vor?</span>
        </div>
        {data.failedRows.length === 0 ? (
          <div className="card-body"><p style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Keine Daten (Signale haben noch keine failed_rules)</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Regel</th><th>In Losses</th><th>Total failed</th><th>Loss-Rate wenn gefailed</th></tr></thead>
              <tbody>
                {data.failedRows.map((row, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{ruleLabel(row.rule)}</td>
                    <td className="mono loss">{row.inLosses}</td>
                    <td className="mono">{row.total}</td>
                    <td className="mono" style={{ color: parseFloat(row.lossRate) >= 50 ? 'var(--loss)' : 'var(--win)' }}>{row.lossRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Strategy Lab Tab ──────────────────────────────────────────

function TooltipInfo({ text }) {
  const [show, setShow] = React.useState(false);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button
        onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
        onClick={e => { e.stopPropagation(); setShow(s => !s); }}
        style={{ width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--border)', background: 'var(--bg-3)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 700, flexShrink: 0, padding: 0 }}>
        ?
      </button>
      {show && (
        <div style={{ position: 'absolute', top: 24, right: 0, zIndex: 200, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', fontSize: 12, color: 'var(--text-secondary)', maxWidth: 280, lineHeight: 1.55, boxShadow: '0 8px 24px rgba(0,0,0,0.35)', whiteSpace: 'normal' }}>
          {text}
        </div>
      )}
    </div>
  );
}

function StrategyLabTab({ userRole }) {
  const [strategies,     setStrategies]     = useState([]);
  const [selected,       setSelected]       = useState(null);
  const [editCfg,        setEditCfg]        = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [saving,         setSaving]         = useState(false);
  const [newName,        setNewName]        = useState('');
  const [newVersion,     setNewVersion]     = useState('');
  const [toast,          setToast]          = useState(null);
  const [resetDlg,       setResetDlg]      = useState(false);
  const [createCopyDlg,  setCreateCopyDlg]  = useState(false);
  const [copyName,       setCopyName]       = useState('');
  const [copyVersion,    setCopyVersion]    = useState('');
  const isAdmin = userRole === 'admin';

  useEffect(() => { load(); }, []);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/strategies`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setStrategies(data);
        if (data.length > 0) {
          const active = data.find(s => s.active) || data[0];
          setSelected(active);
          setEditCfg(JSON.parse(JSON.stringify(active.config || {})));
        }
      }
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const selectStrategy = s => {
    setSelected(s);
    setEditCfg(JSON.parse(JSON.stringify(s.config || {})));
  };

  const exportStrategy = async (format) => {
    if (!selected) return;
    showToast('Exportiere…', 'info');
    const safeName = (selected.name || 'strategie').replace(/\s+/g, '-').toLowerCase();
    const fileName = `wavescout-${safeName}-${selected.version || 'v1'}`;

    // Fetch all supporting data in parallel
    const [statsRes, historyRes, practiceRes, compareRes] = await Promise.allSettled([
      fetch(`${API_URL}/stats`,                    { credentials: 'include' }),
      fetch(`${API_URL}/history?limit=500`,        { credentials: 'include' }),
      fetch(`${API_URL}/practice-trades/stats`,    { credentials: 'include' }),
      fetch(`${API_URL}/strategies/compare`,       { credentials: 'include' }),
    ]);
    const safe = async (r) => { try { return r.status === 'fulfilled' && r.value.ok ? await r.value.json() : null; } catch { return null; } };
    const [stats, history, practice, compare] = await Promise.all([safe(statsRes), safe(historyRes), safe(practiceRes), safe(compareRes)]);

    if (format === 'json') {
      const payload = {
        exported_at:  new Date().toISOString(),
        strategy: {
          name:    selected.name,
          version: selected.version,
          active:  !!selected.active,
          config:  selected.config,
        },
        performance: {
          overall_stats:        stats,
          practice_trade_stats: practice,
          strategy_comparison:  compare,
        },
        signal_logs:   history,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fileName + '.json'; a.click();
    } else {
      const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const row  = (...cols) => cols.map(cell).join(',');
      const sep  = () => '';
      const head = (title) => `"=== ${title} ==="`;
      const lines = [];

      // 1 — Strategie-Config
      lines.push(head('STRATEGIE'), row('Name', 'Version', 'Aktiv', 'Export-Datum'));
      lines.push(row(selected.name, selected.version, selected.active ? 'ja' : 'nein', new Date().toISOString()));
      lines.push(sep());

      // 2 — Regeln
      lines.push(head('REGELN'), row('Regel', 'Aktiv', 'Score', 'Params'));
      Object.entries(selected.config?.rules || {}).forEach(([k, r]) =>
        lines.push(row(k, r.enabled ? 'ja' : 'nein', r.score ?? '', JSON.stringify(r.params || {}))));
      lines.push(sep());

      // 3 — Schwellenwerte
      lines.push(head('SCHWELLENWERTE'), row('Schlüssel', 'Wert'));
      Object.entries(selected.config?.thresholds || {}).forEach(([k, v]) => lines.push(row(k, v)));
      lines.push(sep());

      // 4 — Gesamtperformance
      if (stats) {
        lines.push(head('GESAMTPERFORMANCE'));
        lines.push(row('Metrik', 'Wert'));
        Object.entries(stats).forEach(([k, v]) => lines.push(row(k, typeof v === 'object' ? JSON.stringify(v) : v)));
        lines.push(sep());
      }

      // 5 — Practice-Trade-Stats
      if (practice) {
        lines.push(head('PRACTICE-TRADES'));
        lines.push(row('Metrik', 'Wert'));
        Object.entries(practice).forEach(([k, v]) => lines.push(row(k, typeof v === 'object' ? JSON.stringify(v) : v)));
        lines.push(sep());
      }

      // 6 — Strategie-Vergleich
      if (compare?.length) {
        lines.push(head('STRATEGIE-VERGLEICH'));
        lines.push(row('Strategie', 'Version', 'Total', 'Wins', 'Losses', 'Win-Rate %', 'Ø Score'));
        compare.forEach(s => lines.push(row(s.strategy_name, s.strategy_version, s.total, s.wins, s.losses, s.winRate, s.avg_score)));
        lines.push(sep());
      }

      // 7 — Signal-Log / Trade-Historie
      if (history?.length) {
        lines.push(head('SIGNAL-LOG (Trade-Historie)'));
        lines.push(row('Datum', 'Symbol', 'TF', 'Richtung', 'Score', 'Empfehlung', 'Einstieg', 'TP', 'SL', 'R/R', 'Outcome', 'P&L %', 'Ausgang'));
        history.forEach(s => lines.push(row(
          s.created_at ? new Date(s.created_at).toLocaleString('de-DE') : '',
          s.symbol, s.timeframe, s.direction,
          s.ai_score, s.ai_recommendation,
          s.ai_entry || s.price, s.ai_tp, s.ai_sl, s.risk_reward,
          s.outcome, s.pnl_pct, s.exit_price
        )));
      }

      const csv = '﻿' + lines.join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = fileName + '.csv'; a.click();
    }
    showToast(`Exportiert als ${format.toUpperCase()}`);
  };

  const updateRule = (key, field, value) =>
    setEditCfg(prev => ({ ...prev, rules: { ...prev.rules, [key]: { ...prev.rules?.[key], [field]: value } } }));

  const updateRuleParam = (key, paramKey, value) =>
    setEditCfg(prev => ({
      ...prev,
      rules: { ...prev.rules, [key]: { ...prev.rules?.[key], params: { ...prev.rules?.[key]?.params, [paramKey]: value } } }
    }));

  const updateThreshold = (key, value) =>
    setEditCfg(prev => ({ ...prev, thresholds: { ...prev.thresholds, [key]: value } }));

  const saveNewVersion = async () => {
    if (!newName.trim()) return showToast('Bitte Namen eingeben', 'error');
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/strategies`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({ name: newName.trim(), version: newVersion.trim() || 'v2.1', config: editCfg })
      });
      if (res.ok) { showToast('Strategie gespeichert'); setNewName(''); setNewVersion(''); await load(); }
      else { const e = await res.json(); showToast(e.error || 'Fehler', 'error'); }
    } catch (e) { showToast(e.message, 'error'); } finally { setSaving(false); }
  };

  const createCopy = async () => {
    if (!copyName.trim()) return showToast('Bitte Namen eingeben', 'error');
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/strategies`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({ name: copyName.trim(), version: copyVersion.trim() || 'v2.1', config: editCfg })
      });
      if (res.ok) {
        showToast('Neue Strategie-Version erstellt');
        setCreateCopyDlg(false);
        setCopyName('');
        setCopyVersion('');
        const data = await (await fetch(`${API_URL}/strategies`, { credentials: 'include' })).json();
        setStrategies(data);
        const newest = data.find(s => s.name === copyName.trim()) || data[data.length - 1];
        if (newest) selectStrategy(newest);
      } else { const e = await res.json(); showToast(e.error || 'Fehler', 'error'); }
    } catch (e) { showToast(e.message, 'error'); } finally { setSaving(false); }
  };

  const activate = async stratId => {
    try {
      const res = await fetch(`${API_URL}/strategies/${stratId}/activate`, {
        method: 'POST', credentials: 'include' });
      if (res.ok) { showToast('Strategie aktiviert'); await load(); }
    } catch (e) { showToast(e.message, 'error'); }
  };

  const deleteStrategy = async stratId => {
    try {
      const res = await fetch(`${API_URL}/strategies/${stratId}`, {
        method: 'DELETE', credentials: 'include' });
      if (res.ok) { showToast('Strategie gelöscht'); await load(); }
      else { const e = await res.json(); showToast(e.error || 'Fehler', 'error'); }
    } catch (e) { showToast(e.message, 'error'); }
  };

  const resetToDefault = async () => {
    try {
      const res = await fetch(`${API_URL}/strategies/reset-to-default`, {
        method: 'POST', credentials: 'include' });
      if (res.ok) { showToast('Auf Standardstrategie zurückgesetzt'); setResetDlg(false); await load(); }
    } catch (e) { showToast(e.message, 'error'); }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade Strategien…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {toast && (
        <div className={`toast-bar ${toast.type}`} style={{ position: 'fixed', top: 80, right: 24, zIndex: 999, animation: 'none' }}>
          {toast.msg}
        </div>
      )}

      {resetDlg && (
        <div className="modal-overlay" onClick={() => setResetDlg(false)}>
          <div className="modal-box" style={{ maxWidth: 400 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head"><h3>Auf Standard zurücksetzen?</h3></div>
            <div style={{ padding: '16px 20px' }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                Die aktive Strategie wird auf WAVESCOUT Standard zurückgesetzt. Deine gespeicherten Strategie-Versionen bleiben erhalten.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setResetDlg(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={resetToDefault}>Zurücksetzen</button>
            </div>
          </div>
        </div>
      )}

      {createCopyDlg && (
        <div className="modal-overlay" onClick={() => setCreateCopyDlg(false)}>
          <div className="modal-box" style={{ maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head"><h3>Neue Strategie-Version erstellen</h3></div>
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, margin: 0 }}>
                Erstellt eine editierbare Kopie der aktuellen Standard-Konfiguration. Du kannst sie anschließend frei anpassen und aktivieren.
              </p>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'block' }}>Name</label>
                <input className="input" value={copyName} onChange={e => setCopyName(e.target.value)}
                  placeholder="Meine Strategie v2" style={{ width: '100%' }} autoFocus/>
              </div>
              <div>
                <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'block' }}>Version</label>
                <input className="input" value={copyVersion} onChange={e => setCopyVersion(e.target.value)}
                  placeholder="v2.1" style={{ width: 120 }}/>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setCreateCopyDlg(false)}>Abbrechen</button>
              <button className="btn btn-primary" onClick={createCopy} disabled={saving || !copyName.trim()}>
                {saving ? <div className="spinner-sm"/> : 'Erstellen & bearbeiten'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 16, alignItems: 'start' }}>

        {/* Strategy list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, padding: '0 4px' }}>Versionen</div>
          {strategies.map(s => (
            <div key={s.id} onClick={() => selectStrategy(s)} style={{
              padding: '12px 14px', borderRadius: 12, cursor: 'pointer',
              border: `1px solid ${selected?.id === s.id ? 'rgba(59,130,246,0.4)' : 'var(--border)'}`,
              background: selected?.id === s.id ? 'rgba(59,130,246,0.07)' : 'var(--bg-2)',
              transition: 'all 0.15s'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: s.active ? 'var(--win)' : 'var(--bg-4)', display: 'inline-block', flexShrink: 0 }}/>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
              </div>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', paddingLeft: 13 }}>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.version}</span>
                {s.is_default && <span className="badge badge-tag" style={{ fontSize: 9, padding: '1px 5px' }}>Standard</span>}
                {s.active     && <span className="badge badge-win"  style={{ fontSize: 9, padding: '1px 5px' }}>Aktiv</span>}
              </div>
            </div>
          ))}
        </div>

        {/* Editor */}
        {selected && editCfg ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* Header card */}
            <div className="card">
              <div className="card-head">
                <div>
                  <h3 style={{ margin: 0 }}>{selected.name}</h3>
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontWeight: 400 }}>{selected.version}</span>
                </div>
                <div className="actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => exportStrategy('json')} title="Strategie als JSON herunterladen">↓ JSON</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => exportStrategy('csv')} title="Strategie als CSV herunterladen">↓ CSV</button>
                  {isAdmin && !selected.active && <button className="btn btn-ghost btn-sm" onClick={() => activate(selected.id)}>Als aktiv setzen</button>}
                  {isAdmin && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--wait)' }} onClick={() => setResetDlg(true)}>Auf Standard zurücksetzen</button>}
                  {isAdmin && !selected.is_default && !selected.protected && <button className="btn btn-ghost btn-sm" style={{ color: 'var(--loss)' }} onClick={() => deleteStrategy(selected.id)}>Löschen</button>}
                </div>
              </div>
              {selected.protected && (
                <div style={{ margin: '0 20px 16px', padding: '14px 16px', background: 'rgba(59,130,246,0.06)', borderRadius: 10, border: '1px solid rgba(59,130,246,0.18)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>WAVESCOUT Standard — Schreibgeschützt</div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>Diese Strategie ist schreibgeschützt. Erstelle eine eigene Version um Gewichtungen und Parameter anzupassen.</div>
                  </div>
                  {isAdmin && (
                    <button className="btn btn-primary btn-sm" onClick={() => { setCopyName(selected.name + ' — Meine Version'); setCopyVersion('v2.1'); setCreateCopyDlg(true); }}>
                      Neue Strategie-Version erstellen
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Rules & Weights card — two-section layout per rule */}
            <div className="card">
              <div className="card-head"><Icon name="book" className="ico"/><h3>Regeln & Gewichtungen</h3></div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {Object.entries(RULE_META).map(([key, meta]) => {
                  const rule          = editCfg.rules?.[key] || { enabled: true, weight: DEFAULT_RULE_WEIGHTS[key] || 10 };
                  const disabled      = !!selected.protected;
                  const defWeight     = DEFAULT_RULE_WEIGHTS[key] || 10;
                  const weightChanged = rule.weight !== defWeight;
                  return (
                    <div key={key} style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', opacity: rule.enabled ? 1 : 0.5, transition: 'opacity 0.2s' }}>
                      {/* Rule header: name + tooltip + toggle */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 16px', background: 'var(--bg-3)', borderBottom: rule.enabled ? '1px solid var(--border)' : 'none' }}>
                        <span style={{ flex: 1, fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>{meta.label}</span>
                        <TooltipInfo text={meta.tooltip}/>
                        <Toggle on={!!rule.enabled} onChange={v => updateRule(key, 'enabled', v)} disabled={disabled}/>
                      </div>

                      {rule.enabled && (
                        <>
                          {/* Section A: Conditions & Parameters */}
                          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)' }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue-400)', textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 7 }}>A · Bedingungen & Parameter</div>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: meta.params ? 12 : 0 }}>{meta.desc}</div>
                            {meta.params && (
                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
                                {Object.entries(meta.params).map(([pk, pmeta]) => {
                                  const pVal     = rule.params?.[pk] ?? pmeta.default;
                                  const pChanged = pVal !== pmeta.default;
                                  return (
                                    <div key={pk} style={{ background: 'var(--bg-3)', borderRadius: 9, padding: '10px 12px', border: `1px solid ${pChanged ? 'rgba(245,158,11,0.25)' : 'var(--border)'}` }}>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 3, gap: 6 }}>
                                        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', lineHeight: 1.3 }}>{pmeta.label}</span>
                                        {pChanged && <span style={{ fontSize: 10, color: 'var(--wait)', background: 'rgba(245,158,11,0.12)', padding: '1px 5px', borderRadius: 4, flexShrink: 0 }}>Standard: {pmeta.default}</span>}
                                      </div>
                                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 8, lineHeight: 1.4 }}>{pmeta.desc}</div>
                                      <input type="number" min={pmeta.min} max={pmeta.max} value={pVal} disabled={disabled}
                                        onChange={e => {
                                          const v = Math.max(pmeta.min, Math.min(pmeta.max, parseInt(e.target.value) || pmeta.default));
                                          updateRuleParam(key, pk, v);
                                        }}
                                        className="input"
                                        style={{ width: '100%', textAlign: 'center', padding: '6px 8px', fontSize: 16, fontWeight: 700, color: 'var(--blue-400)', cursor: disabled ? 'not-allowed' : 'auto' }}/>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>

                          {/* Section B: Weight & Score influence */}
                          <div style={{ padding: '12px 16px', background: 'var(--bg-1)' }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.09em', marginBottom: 9 }}>B · Gewichtung & Score-Einfluss</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <input type="range" min={0} max={meta.maxW} step={1} value={rule.weight} disabled={disabled}
                                onChange={e => updateRule(key, 'weight', parseInt(e.target.value))}
                                style={{ flex: 1, accentColor: 'var(--blue-500)', cursor: disabled ? 'not-allowed' : 'pointer' }}/>
                              <input type="number" min={0} max={meta.maxW} value={rule.weight} disabled={disabled}
                                onChange={e => {
                                  const v = Math.max(0, Math.min(meta.maxW, parseInt(e.target.value) || 0));
                                  updateRule(key, 'weight', v);
                                }}
                                className="input"
                                style={{ width: 56, textAlign: 'center', padding: '4px 6px', fontSize: 14, fontWeight: 700, color: 'var(--blue-400)', cursor: disabled ? 'not-allowed' : 'auto' }}/>
                            </div>
                            <div style={{ marginTop: 7, fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span>Aktuell kann diese Regel bis zu <strong style={{ color: 'var(--blue-400)' }}>{rule.weight} Punkte</strong> beitragen (max. {meta.maxW})</span>
                              {weightChanged && <span style={{ fontSize: 11, color: 'var(--wait)', background: 'rgba(245,158,11,0.12)', padding: '1px 6px', borderRadius: 4 }}>Standard: {defWeight}</span>}
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Score thresholds */}
            <div className="card">
              <div className="card-head"><Icon name="settings" className="ico"/><h3>Score-Schwellen</h3></div>
              <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {[
                  { key: 'min_trade_score',    label: 'Min. Trade Score',    desc: 'Ab diesem Score gilt ein Signal als handelsbar und wird empfohlen. Signale darunter werden als WAIT markiert.',   min: 50, max: 90, def: 70 },
                  { key: 'min_telegram_score', label: 'Min. Telegram Score', desc: 'Ab diesem Score wird eine Telegram-Benachrichtigung gesendet. Kann niedriger als Trade Score gesetzt werden.',     min: 30, max: 80, def: 55 },
                ].map(({ key, label, desc, min, max, def }) => {
                  const val      = editCfg.thresholds?.[key] ?? def;
                  const disabled = !!selected.protected;
                  const changed  = val !== def;
                  return (
                    <div key={key} style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{label}</div>
                          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{desc}</div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flexShrink: 0, paddingTop: 2 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <input type="range" min={min} max={max} step={1} value={val} disabled={disabled}
                              onChange={e => updateThreshold(key, parseInt(e.target.value))}
                              style={{ width: 160, accentColor: 'var(--blue-500)', cursor: disabled ? 'not-allowed' : 'pointer' }}/>
                            <input type="number" min={min} max={max} value={val} disabled={disabled}
                              onChange={e => {
                                const v = Math.max(min, Math.min(max, parseInt(e.target.value) || min));
                                updateThreshold(key, v);
                              }}
                              className="input"
                              style={{ width: 56, textAlign: 'center', padding: '4px 6px', fontSize: 13, fontWeight: 700, color: 'var(--blue-400)' }}/>
                          </div>
                          {changed && <span style={{ fontSize: 11, color: 'var(--wait)', background: 'rgba(245,158,11,0.12)', padding: '1px 6px', borderRadius: 4 }}>Standard: {def}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Save as new version (non-protected strategies) */}
            {isAdmin && !selected.protected && (
              <div className="card">
                <div className="card-head"><Icon name="plus" className="ico"/><h3>Als neue Version speichern</h3></div>
                <div className="card-body">
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
                    Erstellt eine neue Strategie-Version mit den aktuell eingestellten Regeln, Gewichtungen und Parametern.
                  </p>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'block' }}>Name</label>
                      <input className="input" value={newName} onChange={e => setNewName(e.target.value)}
                        placeholder={`${selected.name} — Variante`} style={{ minWidth: 200 }}/>
                    </div>
                    <div>
                      <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 6, display: 'block' }}>Version</label>
                      <input className="input" value={newVersion} onChange={e => setNewVersion(e.target.value)}
                        placeholder="v2.1" style={{ width: 80 }}/>
                    </div>
                    <button className="btn btn-primary" onClick={saveNewVersion} disabled={saving || !newName.trim()}>
                      {saving ? <div className="spinner-sm"/> : 'Speichern'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}>Keine Strategie ausgewählt</div>
        )}
      </div>
    </div>
  );
}

// ─── Strategy Compare Tab ──────────────────────────────────────

function CompareTable({ rows, keyPrefix }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="tbl">
        <thead><tr><th>Strategie</th><th>Version</th><th>Total</th><th>Wins</th><th>Losses</th><th>Win-Rate</th><th>WAIT</th><th>SKIP</th><th>Ø Score</th></tr></thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={`${keyPrefix}-${i}`}>
              <td style={{ fontWeight: 500 }}>{s.strategy_name || s.strategyName || '–'}</td>
              <td className="mono muted" style={{ fontSize: 11 }}>{s.strategy_version || s.strategyVersion || '–'}</td>
              <td className="mono">{s.total}</td>
              <td className="mono" style={{ color: 'var(--win)' }}>{s.wins}</td>
              <td className="mono" style={{ color: 'var(--loss)' }}>{s.losses}</td>
              <td className={`mono ${(s.winRate) >= 50 ? 'win' : 'loss'}`}>{s.winRate}%</td>
              <td className="mono muted">{s.wait_count || s.waitCount || 0}</td>
              <td className="mono muted">{s.skip_count || s.skipCount || 0}</td>
              <td className="mono">{s.avg_score || s.avgScore || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StrategyCompareTab() {
  const [compareData, setCompareData] = useState([]);
  const [allStrats,   setAllStrats]   = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [abRunning,   setAbRunning]   = useState(false);
  const [abResult,    setAbResult]    = useState(null);

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const [cRes, sRes] = await Promise.all([
        fetch(`${API_URL}/strategies/compare`, { credentials: 'include' }),
        fetch(`${API_URL}/strategies`,          { credentials: 'include' }),
      ]);
      if (cRes.ok) setCompareData(await cRes.json());
      if (sRes.ok) setAllStrats(await sRes.json());
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const runAbTest = async () => {
    if (!allStrats.length) return;
    setAbRunning(true);
    try {
      const res = await fetch(`${API_URL}/strategies/ab-backtest`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json'},
        body: JSON.stringify({ strategyIds: allStrats.map(s => s.id) })
      });
      if (res.ok) setAbResult(await res.json());
    } catch (e) { console.error(e); } finally { setAbRunning(false); }
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico"/><h3>Performance nach Strategie</h3>
          <div className="actions"><button className="btn btn-ghost btn-sm" onClick={load}>↻ Aktualisieren</button></div>
        </div>
        {compareData.length === 0 ? (
          <div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Noch keine Signale mit Strategie-Zuordnung. Neue Signale über den Webhook werden automatisch der aktiven Strategie zugeordnet.</p>
          </div>
        ) : (
          <>
            <CompareTable rows={compareData} keyPrefix="real"/>
            {compareData.some(s => s.total < 20) && (
              <div style={{ padding: '10px 20px', background: 'var(--bg-warning)', color: 'var(--wait)', fontSize: 12, borderTop: '1px solid var(--border)' }}>
                ⚠ Ergebnisse mit unter 20 Signalen sind noch nicht aussagekräftig.
              </div>
            )}
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <Icon name="chart" className="ico"/><h3>A/B Backtest</h3>
          <div className="actions"><span className="badge badge-tag">Alle Strategien · Historische Signale</span></div>
        </div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Alle {allStrats.length} gespeicherten Strategien werden gegen die letzten 100 historischen Signale getestet. Die Regel-Scores werden neu berechnet, das tatsächliche Outcome (WIN/LOSS) bleibt wie gespeichert.
          </p>
          <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={runAbTest} disabled={abRunning || allStrats.length === 0}>
            {abRunning ? <><div className="spinner-sm" style={{ display: 'inline-block', marginRight: 6 }}/>Berechne…</> : 'A/B Test starten'}
          </button>
          {abResult && (
            <div>
              <p style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 10 }}>Ergebnis ({abResult.signalCount} Signale):</p>
              <CompareTable rows={abResult.results} keyPrefix="ab"/>
              {abResult.signalCount < 20 && (
                <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--bg-warning)', borderRadius: 8, fontSize: 12, color: 'var(--wait)' }}>
                  ⚠ Nur {abResult.signalCount} Signale für den Test — für belastbare Aussagen werden mehr Trades benötigt.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Loss Analysis Tab ─────────────────────────────────────────

function LossAnalysisTab() {
  const [losses,    setLosses]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [lossModal, setLossModal] = useState(null);
  const [reasons,   setReasons]   = useState({});

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/history?limit=200`, { credentials: 'include' });
      if (res.ok) setLosses((await res.json()).filter(t => t.outcome === 'LOSS'));
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const loadReasons = async signalId => {
    try {
      const res = await fetch(`${API_URL}/signals/${signalId}/loss-reasons`, { credentials: 'include' });
      if (res.ok) {
        const reasonData = await res.json();
        setReasons(prev => ({ ...prev, [signalId]: reasonData }));
      }
    } catch (e) { console.error(e); }
  };

  const reasonCounts = {};
  Object.values(reasons).flat().forEach(r => { reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1; });
  const topReasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]);

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {lossModal && (
        <LossReasonModal signalId={lossModal}
          onClose={() => setLossModal(null)}
          onSaved={() => { loadReasons(lossModal); setLossModal(null); }}/>
      )}

      {topReasons.length > 0 && (
        <div className="card">
          <div className="card-head"><Icon name="chart" className="ico"/><h3>Häufige Loss-Gründe</h3></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {topReasons.map(([reason, cnt]) => (
              <div key={reason} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ flex: 1, fontSize: 13 }}>{reason}</div>
                <div style={{ width: 120, background: 'var(--bg-3)', borderRadius: 4, height: 6, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: 'var(--loss)', borderRadius: 4, width: `${Math.min(100, (cnt / losses.length) * 200)}%` }}/>
                </div>
                <span className="badge badge-loss" style={{ minWidth: 28, textAlign: 'center', fontSize: 11 }}>{cnt}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <Icon name="signal" className="ico"/>
          <h3>Loss-Trades</h3>
          <div className="actions">
            <span className="badge badge-loss">{losses.length} Losses</span>
            <button className="btn btn-ghost btn-sm" onClick={load}>↻</button>
          </div>
        </div>
        {losses.length === 0 ? (
          <div className="card-body" style={{ textAlign: 'center', padding: 40 }}><p style={{ color: 'var(--text-tertiary)' }}>Keine Losses vorhanden</p></div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead><tr><th>Datum</th><th>Symbol</th><th>Richtung</th><th>Score</th><th>Strategie</th><th>Loss-Gründe</th><th></th></tr></thead>
              <tbody>
                {losses.map((t, i) => {
                  const signalReasons = reasons[t.id] || [];
                  return (
                    <tr key={i}>
                      <td className="mono muted" style={{ fontSize: 11 }}>{fmtDate(t.created_at)}</td>
                      <td><AssetChip symbol={t.symbol}/></td>
                      <td><span className={`badge ${t.direction === 'LONG' ? 'badge-long' : 'badge-short'}`}>{t.direction}</span></td>
                      <td className="mono" style={{ color: 'var(--loss)' }}>{t.ai_score || 0}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{t.strategy_name || 'Standard'}</td>
                      <td>
                        {signalReasons.length > 0 ? (
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {signalReasons.map((r, ri) => <span key={ri} className="badge badge-tag" style={{ fontSize: 10 }}>{r.reason}</span>)}
                          </div>
                        ) : <span style={{ color: 'var(--text-quaternary)', fontSize: 12 }}>–</span>}
                      </td>
                      <td>
                        <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
                          onClick={() => { setLossModal(t.id); loadReasons(t.id); }}>
                          {signalReasons.length > 0 ? 'Bearbeiten' : '+ Markieren'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Suggestions Tab ───────────────────────────────────────────

function SuggestionsTab() {
  const [suggestions, setSuggestions] = useState([]);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => { load(); }, []);
  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/strategies/suggestions`, { credentials: 'include' });
      if (res.ok) setSuggestions(await res.json());
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const priColor = p => p === 'high' ? 'var(--loss)' : p === 'medium' ? 'var(--wait)' : 'var(--text-tertiary)';
  const priLabel = p => p === 'high' ? 'Hoch' : p === 'medium' ? 'Mittel' : 'Niedrig';

  if (loading) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Analysiere…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Automatische Analyse — Änderungen werden nicht automatisch übernommen. Du entscheidest selbst, ob du eine neue Strategie-Version erstellst.
        </p>
        <button className="btn btn-ghost btn-sm" onClick={load} style={{ flexShrink: 0, marginLeft: 16 }}>↻ Aktualisieren</button>
      </div>
      {suggestions.map((s, i) => (
        <div key={i} className="card" style={{ borderLeft: `3px solid ${priColor(s.priority)}` }}>
          <div className="card-body" style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{s.title}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: priColor(s.priority), textTransform: 'uppercase', letterSpacing: '0.06em' }}>{priLabel(s.priority)}</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>{s.message}</p>
            </div>
            {s.action && <div style={{ flexShrink: 0, fontSize: 12, color: 'var(--blue-400)', fontWeight: 500, marginTop: 2 }}>→ {s.action}</div>}
          </div>
        </div>
      ))}
      {suggestions.length === 0 && <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}>Keine Vorschläge verfügbar</div>}
    </div>
  );
}

// ─── Bias Stats Tab ────────────────────────────────────────────

function BiasStatsTab() {
  const [stats,   setStats]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState({ direction: '' });

  useEffect(() => { load(); }, []);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter.direction) params.set('direction', filter.direction);
      const res = await fetch(`${API_URL}/bias-stats?${params}`, { credentials: 'include' });
      if (res.ok) setStats(await res.json());
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [filter.direction]);

  if (loading) return <div style={{ textAlign: 'center', padding: 60 }}><div className="spinner-lg" style={{ margin: '0 auto 16px' }}/>Lade Bias-Statistiken…</div>;

  if (!stats) return <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-tertiary)' }}>Keine Daten verfügbar</div>;

  const pct = (a, b) => b > 0 ? ((a / b) * 100).toFixed(1) : '0.0';

  const StatBox = ({ label, value, sub, color }) => (
    <div style={{ background: 'var(--bg-1)', borderRadius: 10, padding: '14px 18px', border: '1px solid var(--border)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: color || 'var(--text-primary)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>{sub}</div>}
    </div>
  );

  const BiasBlock = ({ title, data, accentColor }) => {
    if (!data) return null;
    const wr = pct(data.wins, data.total);
    return (
      <div className="card">
        <div className="card-head">
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: accentColor, display: 'inline-block', flexShrink: 0 }}/>
          <h3 style={{ color: accentColor }}>{title}</h3>
          <span className="badge badge-tag" style={{ marginLeft: 'auto' }}>{data.total} Trades</span>
        </div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 }}>
            <StatBox label="Win-Rate" value={`${wr}%`} color={parseFloat(wr) >= 50 ? 'var(--win)' : 'var(--loss)'}/>
            <StatBox label="Wins" value={data.wins} color="var(--win)"/>
            <StatBox label="Losses" value={data.losses} color="var(--loss)"/>
            <StatBox label="Ø Score" value={data.avg_score != null ? data.avg_score.toFixed(1) : '–'}/>
          </div>
          {data.strategies && data.strategies.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 700, letterSpacing: '.08em', marginBottom: 10 }}>STRATEGIE-AUFSCHLÜSSELUNG</div>
              <div style={{ overflowX: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr><th>Strategie</th><th>Total</th><th>Wins</th><th>Losses</th><th>Win-Rate</th><th>Ø Score</th></tr>
                  </thead>
                  <tbody>
                    {data.strategies.map((s, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 500 }}>{s.strategy_name || '–'}</td>
                        <td className="mono">{s.total}</td>
                        <td className="mono win">{s.wins}</td>
                        <td className="mono loss">{s.losses}</td>
                        <td className="mono" style={{ color: parseFloat(pct(s.wins, s.total)) >= 50 ? 'var(--win)' : 'var(--loss)' }}>
                          {pct(s.wins, s.total)}%
                        </td>
                        <td className="mono">{s.avg_score != null ? s.avg_score.toFixed(1) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Filters */}
      <div className="card">
        <div className="card-body" style={{ padding: '12px 20px' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)', fontWeight: 600 }}>Filter:</span>
            <select value={filter.direction} onChange={e => setFilter(f => ({ ...f, direction: e.target.value }))} className="input" style={{ width: 'auto', minWidth: 140 }}>
              <option value="">Alle Richtungen</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
            <button className="btn btn-ghost btn-sm" onClick={() => setFilter({ direction: '' })}>Zurücksetzen</button>
          </div>
        </div>
      </div>

      {/* Overview */}
      {stats.overview && (
        <div className="card">
          <div className="card-head"><Icon name="chart" className="ico"/><h3>Gesamtübersicht</h3></div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 }}>
              <StatBox label="Gesamt" value={stats.overview.total}/>
              <StatBox label="Win-Rate" value={`${pct(stats.overview.wins, stats.overview.total)}%`} color={parseFloat(pct(stats.overview.wins, stats.overview.total)) >= 50 ? 'var(--win)' : 'var(--loss)'}/>
              <StatBox label="Mit Bias" value={stats.overview.with_bias || 0} sub="Morgenroutine gemacht"/>
              <StatBox label="Ohne Bias" value={stats.overview.without_bias || 0} sub="Vor Morgenroutine"/>
              <StatBox label="Bias-Match" value={stats.overview.bias_match || 0} sub="Richtung passte"/>
            </div>
          </div>
        </div>
      )}

      <BiasBlock title="Mit Bias (Morgenroutine abgeschlossen)" data={stats.with_bias} accentColor="var(--win)"/>
      <BiasBlock title="Ohne Bias (vor Morgenroutine)" data={stats.without_bias} accentColor="var(--wait)"/>
      <BiasBlock title="Bias-Match (Richtung entsprach Tages-Bias)" data={stats.bias_match} accentColor="var(--blue-400)"/>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────

const BacktestPage = ({ user }) => {
  const [activeTab, setActiveTab] = useState('practice');
  const userRole  = user?.role || 'user';

  const isTraderOrAdmin = userRole === 'admin' || userRole === 'trader';

  const tabs = [
    { id: 'practice',      label: 'Übungstrades'       },
    { id: 'history',       label: 'Signal-Historie'     },
    ...(isTraderOrAdmin ? [
      { id: 'strategy',    label: 'Strategie-Labor'     },
      { id: 'compare',     label: 'Strategie-Vergleich' },
      { id: 'regelanalyse',label: 'Regel-Analyse'       },
    ] : []),
    { id: 'loss',          label: 'Loss-Analyse'        },
    { id: 'biasstats',     label: 'Bias-Statistiken'    },
    { id: 'suggestions',   label: 'Vorschläge'          },
  ];

  return (
    <div className="content page-enter">
      <div className="page-header">
        <h2>Backtesting & Strategie-Labor</h2>
        <p className="subtitle">Paper-Trades · Strategie-Versionen · Loss-Analyse · Verbesserungsvorschläge</p>
      </div>

      <div style={{ overflowX: 'auto', marginBottom: 20, paddingBottom: 1 }}>
        <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border)', minWidth: 'max-content' }}>
          {tabs.map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              background: 'none', border: 'none', padding: '10px 18px', cursor: 'pointer',
              fontSize: 14, fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? 'var(--blue-500)' : 'var(--text-secondary)',
              borderBottom: activeTab === tab.id ? '2px solid var(--blue-500)' : '2px solid transparent',
              marginBottom: -1, transition: 'all .15s', whiteSpace: 'nowrap', fontFamily: 'var(--font-main)'
            }}>{tab.label}</button>
          ))}
        </div>
      </div>

      {activeTab === 'practice'      && <PracticeTradesTab/>}
      {activeTab === 'history'       && <SignalHistoryTab/>}
      {activeTab === 'strategy'      && <StrategyLabTab     userRole={userRole}/>}
      {activeTab === 'compare'       && <StrategyCompareTab/>}
      {activeTab === 'regelanalyse'  && <RuleFrequencyTab/>}
      {activeTab === 'loss'          && <LossAnalysisTab/>}
      {activeTab === 'biasstats'     && <BiasStatsTab/>}
      {activeTab === 'suggestions'   && <SuggestionsTab/>}
    </div>
  );
};

window.BacktestPage = BacktestPage;
