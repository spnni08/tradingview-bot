// WaveScout — Dashboard page
const { useState, useEffect } = React;

const Dashboard = () => {
  const kpis = [
    { label: 'Equity', value: <CountUp to={12473.50} prefix="$" decimals={2}/>, color: 'var(--text-primary)', tip: 'Gesamtkapital im Account' },
    { label: 'Tages-PnL', value: <CountUp to={184.12} prefix="$" decimals={2} sign/>, color: 'var(--win)', tip: 'PnL seit 00:00 UTC' },
    { label: 'Win-Rate', value: <CountUp to={61.2} suffix="%" decimals={1}/>, color: 'var(--win)', tip: 'Letzte 30 Tage' },
  ];

  return (
    <div className="app">
      <Sidebar active="dashboard" />
      <main className="main">
        <Topbar
          title="Guten Mittag, Markus 👋"
          subtitle="3 neue Signale · 1 offener Trade · Markt: BTC dominiert"
          kpis={kpis}
        />
        <div className="content page-enter">

          {/* Row 1: Best Signal + Markt Bias */}
          <div className="grid grid-2" style={{gridTemplateColumns: '1.4fr 1fr'}}>
            <BestSignalCard />
            <MarktBiasCard />
          </div>

          {/* Row 2: KPIs */}
          <div className="grid" style={{gridTemplateColumns: 'repeat(4, 1fr)'}}>
            <StatCard label="Trades heute" value="3" sub="2 gewonnen · 1 verloren"/>
            <StatCard label="Avg. R:R" value="2.4" sub="Ziel: 2.0+" subTone="win"/>
            <StatCard label="Streak" value="4" sub="Gewinn in Folge" subTone="win" icon="flame"/>
            <StatCard label="Risk Used" value="0.8%" sub="von 2% verfügbar" subTone="muted"/>
          </div>

          {/* Row 3: Open Trades + Letzte Trades */}
          <div className="grid grid-2">
            <OpenTradesCard />
            <RecentTradesCard />
          </div>

          {/* Row 4: Performance + Signal Übersicht */}
          <div className="grid grid-2">
            <PerformanceCard />
            <SignalsCard />
          </div>

        </div>
      </main>
      <ShortcutsOverlay />
      <HintChip />
    </div>
  );
};

// ───── Best Signal ─────
const BestSignalCard = () => {
  const reasons = [
    'Trend in Richtung des höheren TF (4H bullish)',
    'Bullishe Divergenz auf 1H-RSI bestätigt',
    'Volumen-Profil: Support bei 67.450 USDT',
    'Funding Rate neutral (-0.003%)',
  ];
  return (
    <div className="card best-signal-card">
      <div className="card-head">
        <Icon name="bolt" className="ico" />
        <h3>Bestes Signal</h3>
        <div className="actions">
          <span className="badge badge-tag">VOR 4 MIN</span>
          <button className="btn-ghost btn btn-sm" data-tip="Mehr Optionen"><Icon name="more"/></button>
        </div>
      </div>
      <div className="card-body">
        <div className="best-signal-grid">
          <div>
            <div style={{display:'flex', alignItems:'center', gap:14, marginBottom:14}}>
              <AssetChip symbol="BTCUSDT" />
              <span className="badge badge-long">LONG</span>
              <span style={{color:'var(--text-tertiary)', fontSize:12}}>Perpetual · 5x</span>
            </div>

            <div className="signal-meta">
              <div className="cell">
                <div className="l">Entry</div>
                <div className="v mono"><CountUp to={67580.00} prefix="$" decimals={2}/></div>
              </div>
              <div className="cell">
                <div className="l">Stop Loss</div>
                <div className="v mono">$66.920</div>
              </div>
              <div className="cell">
                <div className="l">Take Profit</div>
                <div className="v mono win">$69.450</div>
              </div>
            </div>

            <ul className="reasons-list">
              {reasons.map((r, i) => (
                <li key={i}>
                  <span className="check"><Icon name="check" size={11}/></span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>

            <div style={{display:'flex', gap:10, marginTop:18}}>
              <button className="btn btn-primary" data-tip="Trade ausführen (Hotkey: T)">
                <Icon name="bolt" size={14}/>
                Trade ausführen
              </button>
              <button className="btn" data-tip="Signal in Journal speichern">
                <Icon name="book" size={14}/>
                Im Journal speichern
              </button>
              <button className="btn btn-ghost" data-tip="Signal verwerfen (I)">Ignorieren</button>
            </div>
          </div>

          {/* Score ring on the right */}
          <div style={{display:'flex', flexDirection:'column', alignItems:'center', gap:8}}>
            <div className="score-ring" style={{'--pct': 78}}>
              <div className="score-text"><CountUp to={78}/></div>
              <div className="score-sub">CONFIDENCE</div>
            </div>
            <div style={{fontSize:11, color:'var(--text-tertiary)', textAlign:'center', maxWidth:120}}>
              Sehr starkes Setup. Über deinem Schwellwert von 65.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ───── Markt Bias ─────
const MarktBiasCard = () => {
  const rows = [
    { sym: 'BTCUSDT', pct: '+2.1%', bias: 'bull', spark: [10,12,11,14,13,16,18,17,20,22], tone: 'win' },
    { sym: 'ETHUSDT', pct: '+1.4%', bias: 'bull', spark: [8,9,10,9,11,12,11,13,14,15], tone: 'win' },
    { sym: 'SOLUSDT', pct: '−0.3%', bias: 'neutral', spark: [12,14,13,12,11,12,13,12,11,12], tone: 'muted' },
    { sym: 'XRPUSDT', pct: '−1.8%', bias: 'bear', spark: [20,19,18,19,17,16,15,14,13,12], tone: 'loss' },
    { sym: 'DOGEUSDT', pct: '+0.4%', bias: 'neutral', spark: [10,11,10,11,12,11,12,11,12,11], tone: 'muted' },
  ];
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="target" className="ico"/>
        <h3>Markt Bias</h3>
        <div className="actions">
          <span className="badge badge-tag">5 ASSETS</span>
        </div>
      </div>
      <div className="card-body" style={{padding: '6px 18px 14px'}}>
        {rows.map((r, i) => (
          <div className="bias-row" key={i}>
            <AssetChip symbol={r.sym} />
            <div style={{display:'flex', justifyContent:'flex-end'}}>
              <Spark points={r.spark}
                     color={r.tone === 'win' ? 'var(--win)' : r.tone === 'loss' ? 'rgba(255,255,255,0.85)' : 'var(--text-tertiary)'}
                     w={90}/>
            </div>
            <div style={{display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, minWidth:80}}>
              <span className={`mono ${r.tone}`} style={{fontSize:13}}>{r.pct}</span>
              <span className={`badge ${r.bias === 'bull' ? 'badge-bullish' : r.bias === 'bear' ? 'badge-bearish' : 'badge-neutral'}`}>
                {r.bias === 'bull' ? 'BULLISH' : r.bias === 'bear' ? 'BEARISH' : 'NEUTRAL'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───── Stat Card (small) ─────
const StatCard = ({ label, value, sub, subTone = 'muted', icon }) => (
  <div className="stat" data-tip={`${label}: ${value}`}>
    <div className="label" style={{display:'flex', alignItems:'center', gap:6}}>
      {icon && <Icon name={icon} size={11}/>}
      {label}
    </div>
    <div className="value">{value}</div>
    {sub && <div className={`sub ${subTone}`}>{sub}</div>}
  </div>
);

// ───── Open Trades ─────
const OpenTradesCard = () => {
  const trades = [
    { sym:'ETHUSDT', dir:'LONG', entry:3284.50, current:3312.20, pnl:+82.40, pnlPct:+0.84, time:'12m' },
    { sym:'SOLUSDT', dir:'SHORT', entry:142.80, current:140.20, pnl:+38.10, pnlPct:+1.82, time:'45m' },
  ];
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="folder" className="ico"/>
        <h3>Offene Trades · 2</h3>
        <div className="actions">
          <button className="btn btn-sm btn-ghost" data-tip="Alle anzeigen">Alle <Icon name="chevronRight" size={12}/></button>
        </div>
      </div>
      <div className="row-list">
        {trades.map((t, i) => (
          <div className="row-item" key={i}>
            <div className="left">
              <div className="top-line">
                <AssetChip symbol={t.sym}/>
                <span className={`badge ${t.dir === 'LONG' ? 'badge-long' : 'badge-short'}`}>{t.dir}</span>
              </div>
              <div className="meta">
                Entry ${t.entry.toFixed(2)} · Aktuell ${t.current.toFixed(2)} · {t.time} offen
              </div>
            </div>
            <div className="right">
              <span className="mono win" style={{fontSize:14, fontWeight:500}}>+${t.pnl.toFixed(2)}</span>
              <span className="badge badge-win">+{t.pnlPct.toFixed(2)}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───── Recent Trades ─────
const RecentTradesCard = () => {
  const trades = [
    { sym:'BTCUSDT', dir:'LONG', pnl:+241.20, pct:+2.1, status:'win', time:'1h' },
    { sym:'ETHUSDT', dir:'SHORT', pnl:-78.40, pct:-0.9, status:'loss', time:'3h' },
    { sym:'ADAUSDT', dir:'LONG', pnl:+52.10, pct:+0.6, status:'win', time:'5h' },
    { sym:'SOLUSDT', dir:'LONG', pnl:+138.50, pct:+1.5, status:'win', time:'gestern' },
  ];
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="receipt" className="ico"/>
        <h3>Letzte Trades</h3>
        <div className="actions">
          <a className="btn btn-sm btn-ghost" href="journal.html" data-tip="Zum Journal">Im Journal <Icon name="chevronRight" size={12}/></a>
        </div>
      </div>
      <div className="row-list">
        {trades.map((t, i) => (
          <div className="row-item" key={i}>
            <div className="left">
              <div className="top-line">
                <AssetChip symbol={t.sym}/>
                <span className={`badge ${t.dir === 'LONG' ? 'badge-long' : 'badge-short'}`}>{t.dir}</span>
                <span className={`badge ${t.status === 'win' ? 'badge-win' : 'badge-loss'}`}>
                  {t.status === 'win' ? 'WIN' : 'LOSS'}
                </span>
              </div>
              <div className="meta">vor {t.time}</div>
            </div>
            <div className="right">
              <span className={`mono ${t.status === 'win' ? 'win' : 'loss'}`} style={{fontSize:14, fontWeight:500}}>
                {t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(2)}
              </span>
              <span className="muted mono" style={{fontSize:11}}>
                {t.pct > 0 ? '+' : ''}{t.pct.toFixed(1)}%
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ───── Performance card ─────
const PerformanceCard = () => (
  <div className="card">
    <div className="card-head">
      <Icon name="chart" className="ico"/>
      <h3>Performance · 30 Tage</h3>
      <div className="actions">
        <div className="seg">
          <button>7T</button>
          <button className="active">30T</button>
          <button>90T</button>
          <button>YTD</button>
        </div>
      </div>
    </div>
    <div className="card-body">
      <ChartPlaceholder title="Performance-Chart" sub="Live-Equity bald verfügbar" height={220}/>
      <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginTop:14}}>
        <MiniStat l="Net PnL" v="+$1.847" tone="win"/>
        <MiniStat l="Bester Tag" v="+$412" tone="win"/>
        <MiniStat l="Schlechtester" v="−$184" tone="loss"/>
        <MiniStat l="Avg. pro Tag" v="+$61"/>
      </div>
    </div>
  </div>
);

const MiniStat = ({ l, v, tone }) => (
  <div style={{padding:'8px 12px', background:'var(--bg-1)', border:'1px solid var(--border-default)', borderRadius:8}}>
    <div style={{fontSize:10, color:'var(--text-tertiary)', textTransform:'uppercase', letterSpacing:'0.12em'}}>{l}</div>
    <div className={`mono ${tone || ''}`} style={{fontSize:14, fontWeight:500, marginTop:3}}>{v}</div>
  </div>
);

// ───── Signal Übersicht ─────
const SignalsCard = () => {
  const signals = [
    { sym:'AVAXUSDT', dir:'LONG', score:71, status:'wait' },
    { sym:'LINKUSDT', dir:'SHORT', score:58, status:'skip' },
    { sym:'MATICUSDT', dir:'LONG', score:64, status:'wait' },
  ];
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="signal" className="ico"/>
        <h3>Signal Übersicht</h3>
        <div className="actions">
          <span className="badge badge-tag">{signals.length} OFFEN</span>
          <button className="btn btn-sm btn-ghost"><Icon name="filter" size={12}/></button>
        </div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Richtung</th>
            <th>Score</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {signals.map((s, i) => (
            <tr key={i}>
              <td><AssetChip symbol={s.sym}/></td>
              <td><span className={`badge ${s.dir === 'LONG' ? 'badge-long' : 'badge-short'}`}>{s.dir}</span></td>
              <td className="mono">{s.score}/100</td>
              <td>
                <span className={`badge ${s.status === 'wait' ? 'badge-wait' : 'badge-skip'}`}>
                  {s.status === 'wait' ? 'WARTEN' : 'SKIP'}
                </span>
              </td>
              <td style={{textAlign:'right'}}>
                <button className="btn btn-sm btn-ghost" data-tip="Setup ansehen"><Icon name="chevronRight" size={12}/></button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<Dashboard/>);
