// WaveScout — Statistiken
const { useState } = React;

const Statistiken = () => {
  const kpis = [
    { label: 'Net PnL', value: <CountUp to={4860.40} prefix="$" decimals={2} sign/>, color: 'var(--win)', tip: 'Letzte 30 Tage' },
    { label: 'Win-Rate', value: <CountUp to={61.2} suffix="%" decimals={1}/>, color: 'var(--win)' },
    { label: 'Avg. R', value: <CountUp to={1.84} decimals={2}/>, color: 'var(--text-primary)' },
    { label: 'Trades', value: <CountUp to={143}/>, color: 'var(--text-primary)' },
  ];

  const [range, setRange] = useState('30 Tage');
  const ranges = ['7 Tage', '30 Tage', '90 Tage', 'YTD', 'Alle'];

  // Months bar
  const months = [
    { l: 'Jan', v: 8.4 }, { l: 'Feb', v: 12.1 }, { l: 'Mär', v: -2.1 },
    { l: 'Apr', v: 6.8 }, { l: 'Mai', v: 4.2 },
  ];
  const maxAbsM = Math.max(...months.map(m => Math.abs(m.v)));

  // Weekday lollipop
  const weekdays = [
    { l: 'Mo', v: 1.8 }, { l: 'Di', v: 2.4 }, { l: 'Mi', v: 3.1 },
    { l: 'Do', v: 0.4 }, { l: 'Fr', v: -0.8 }, { l: 'Sa', v: 0.2 }, { l: 'So', v: -0.3 },
  ];
  const maxAbsW = Math.max(...weekdays.map(w => Math.abs(w.v)));

  // R:R distribution
  const rrDist = [
    { l: '<1', v: 4 }, { l: '1', v: 12 }, { l: '1.5', v: 28 },
    { l: '2', v: 41 }, { l: '2.5', v: 22 }, { l: '3', v: 14 }, { l: '3+', v: 8 },
  ];
  const maxRR = Math.max(...rrDist.map(r => r.v));

  // Heatmap (days x hours, 7x6)
  const heat = Array.from({length: 7}, () => Array.from({length: 8}, () => Math.random()));

  return (
    <div className="app">
      <Sidebar active="statistiken"/>
      <main className="main">
        <Topbar title="Statistiken" subtitle="Tiefere Einblicke in deine Performance" kpis={kpis}/>
        <div className="content page-enter">

          {/* Range selector */}
          <div className="card" style={{padding: '12px 16px'}}>
            <div style={{display:'flex', alignItems:'center', gap: 14, flexWrap:'wrap'}}>
              <Icon name="calendar" size={14} style={{color: 'var(--blue-300)'}}/>
              <span style={{fontSize: 12, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.12em'}}>Zeitraum</span>
              <div className="seg">
                {ranges.map(r => (
                  <button key={r} className={range === r ? 'active' : ''} onClick={() => setRange(r)}>{r}</button>
                ))}
              </div>
              <div className="topbar-spacer"></div>
              <button className="btn btn-sm btn-ghost" data-tip="Bericht herunterladen"><Icon name="download" size={12}/> Export</button>
            </div>
          </div>

          {/* Row 1: Equity Curve */}
          <div className="card">
            <div className="card-head">
              <Icon name="chart" className="ico"/>
              <h3>Equity Curve</h3>
              <div className="actions">
                <span className="badge badge-tag">+$4.860 in {range}</span>
                <button className="btn-ghost btn btn-sm"><Icon name="more"/></button>
              </div>
            </div>
            <div className="card-body">
              <ChartPlaceholder title="Equity Curve wird angebunden" sub="Live-Daten in Vorbereitung" height={220}/>
            </div>
          </div>

          {/* Row 2: Donut + Donut + R:R */}
          <div className="grid" style={{gridTemplateColumns: '1fr 1fr 1.4fr'}}>
            <DonutCard title="Gewinn / Verlust" data={[
              { l: 'Gewinn', v: 87, color: 'var(--win)' },
              { l: 'Verlust', v: 56, color: 'var(--loss)' },
            ]}/>
            <DonutCard title="Long / Short" data={[
              { l: 'Long', v: 92, color: 'var(--blue-300)' },
              { l: 'Short', v: 51, color: 'var(--blue-500)' },
            ]}/>
            <div className="card">
              <div className="card-head">
                <Icon name="target" className="ico"/>
                <h3>R:R Verteilung</h3>
                <div className="actions"><span className="dim small">143 Trades</span></div>
              </div>
              <div className="card-body">
                <div className="rr-chart">
                  {rrDist.map(r => (
                    <div className="rr-bar" key={r.l}>
                      <div className="rr-bar-fill" style={{height: `${(r.v / maxRR) * 100}%`}}>
                        <span className="rr-bar-value">{r.v}</span>
                      </div>
                      <div className="rr-bar-label">{r.l}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Row 3: Months + Weekdays */}
          <div className="grid grid-2">
            <div className="card">
              <div className="card-head">
                <Icon name="stats" className="ico"/>
                <h3>Performance nach Monat</h3>
                <div className="actions"><span className="dim small">2026</span></div>
              </div>
              <div className="card-body">
                <div className="month-chart">
                  {months.map(m => {
                    const h = (Math.abs(m.v) / maxAbsM) * 100;
                    const positive = m.v >= 0;
                    return (
                      <div className="month-col" key={m.l}>
                        <div className="month-bar-track">
                          <div
                            className={`month-bar ${positive ? 'pos' : 'neg'}`}
                            style={{height: `${h}%`, alignSelf: positive ? 'flex-end' : 'flex-start'}}
                            data-tip={`${m.l}: ${m.v > 0 ? '+' : ''}${m.v}%`}
                          ></div>
                        </div>
                        <div className={`month-value mono ${positive ? 'win' : 'loss'}`}>{m.v > 0 ? '+' : ''}{m.v}%</div>
                        <div className="month-label">{m.l}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <Icon name="stats" className="ico"/>
                <h3>Performance nach Wochentag</h3>
                <div className="actions"><span className="dim small">in %</span></div>
              </div>
              <div className="card-body">
                <div className="lollipop-chart">
                  {weekdays.map(w => {
                    const len = (Math.abs(w.v) / maxAbsW) * 100;
                    const positive = w.v >= 0;
                    return (
                      <div className="lolli-row" key={w.l}>
                        <div className="lolli-label">{w.l}</div>
                        <div className="lolli-track">
                          <div className="lolli-axis"></div>
                          <div className={`lolli-line ${positive ? 'pos' : 'neg'}`} style={{width: `${len}%`}}></div>
                          <div className={`lolli-dot ${positive ? 'pos' : 'neg'}`} style={{left: `${len}%`}} data-tip={`${w.l}: ${w.v > 0 ? '+' : ''}${w.v}%`}></div>
                        </div>
                        <div className={`lolli-value mono ${positive ? 'win' : 'loss'}`}>{w.v > 0 ? '+' : ''}{w.v}%</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Row 4: Heatmap */}
          <div className="card">
            <div className="card-head">
              <Icon name="flame" className="ico"/>
              <h3>Performance nach Uhrzeit (UTC)</h3>
              <div className="actions">
                <div className="legend">
                  <span>Niedrig</span>
                  <div className="legend-bar"></div>
                  <span>Hoch</span>
                </div>
              </div>
            </div>
            <div className="card-body">
              <div className="heatmap">
                <div className="heat-corner"></div>
                {['00','03','06','09','12','15','18','21'].map(h => (
                  <div key={h} className="heat-col-label">{h}</div>
                ))}
                {['Mo','Di','Mi','Do','Fr','Sa','So'].map((d, di) => (
                  <React.Fragment key={d}>
                    <div className="heat-row-label">{d}</div>
                    {heat[di].map((v, hi) => (
                      <div
                        key={hi}
                        className="heat-cell"
                        style={{
                          backgroundColor: `rgba(125, 211, 252, ${0.05 + v * 0.65})`,
                          borderColor: `rgba(125, 211, 252, ${0.1 + v * 0.4})`
                        }}
                        data-tip={`${d} ${['00','03','06','09','12','15','18','21'][hi]}: ${(v * 100).toFixed(0)}% Win-Rate`}
                      ></div>
                    ))}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>

        </div>
      </main>
      <ShortcutsOverlay/>
      <HintChip/>
    </div>
  );
};

// ───── Donut card ─────
const DonutCard = ({ title, data }) => {
  const total = data.reduce((a, b) => a + b.v, 0);
  let acc = 0;
  const r = 38, c = 2 * Math.PI * r;
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="target" className="ico"/>
        <h3>{title}</h3>
      </div>
      <div className="card-body" style={{display:'flex', alignItems:'center', gap:18}}>
        <svg width="110" height="110" viewBox="0 0 110 110" style={{flexShrink: 0}}>
          <circle cx="55" cy="55" r={r} fill="none" stroke="var(--bg-2)" strokeWidth="14"/>
          {data.map((d, i) => {
            const len = (d.v / total) * c;
            const off = c - acc;
            acc += len;
            return (
              <circle
                key={i}
                cx="55" cy="55" r={r} fill="none"
                stroke={d.color} strokeWidth="14"
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={off}
                style={{transform: 'rotate(-90deg)', transformOrigin: '55px 55px'}}
              />
            );
          })}
          <text x="55" y="56" textAnchor="middle" dominantBaseline="middle" fill="#fff"
                style={{fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600}}>
            {total}
          </text>
          <text x="55" y="72" textAnchor="middle" fill="var(--text-tertiary)"
                style={{fontSize: 8, letterSpacing: '0.14em', textTransform: 'uppercase'}}>
            TOTAL
          </text>
        </svg>
        <div className="donut-legend">
          {data.map((d, i) => (
            <div key={i} className="donut-legend-row">
              <span className="donut-legend-dot" style={{background: d.color}}></span>
              <span className="donut-legend-label">{d.l}</span>
              <span className="donut-legend-value mono">{d.v}</span>
              <span className="donut-legend-pct">{((d.v / total) * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<Statistiken/>);
