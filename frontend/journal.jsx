// WaveScout — Journal
const { useState } = React;

const TRADES = [
  { id: 1, date: '04.05.2026', asset: 'BTCUSDT', dir: 'LONG', entry: 67580, exit: 69120, pnl: 462.0, r: 2.4, tags: ['Trend', 'Breakout'], grade: 'A', note: 'Sauberer Breakout über Tageshoch, kein Druck am TP.', selected: true },
  { id: 2, date: '04.05.2026', asset: 'ETHUSDT', dir: 'SHORT', entry: 3162, exit: 3208, pnl: -138.0, r: -1.0, tags: ['Reversal'], grade: 'C', note: 'Zu früh gegen Trend gefadet.' },
  { id: 3, date: '03.05.2026', asset: 'SOLUSDT', dir: 'LONG', entry: 142.20, exit: 148.40, pnl: 217.5, r: 1.8, tags: ['Range', 'Support'], grade: 'B', note: 'Standard Range-Long, kontrolliert ausgestiegen.' },
  { id: 4, date: '02.05.2026', asset: 'BTCUSDT', dir: 'LONG', entry: 66120, exit: 67400, pnl: 384.0, r: 2.0, tags: ['Trend'], grade: 'A', note: 'Trend-Continuation, perfektes R:R erreicht.' },
  { id: 5, date: '02.05.2026', asset: 'XRPUSDT', dir: 'LONG', entry: 0.5240, exit: 0.5180, pnl: -120.0, r: -1.0, tags: ['Range'], grade: 'C', note: 'Range gebrochen, SL gehit.' },
  { id: 6, date: '01.05.2026', asset: 'BTCUSDT', dir: 'SHORT', entry: 68420, exit: 67800, pnl: 186.0, r: 1.2, tags: ['Reversal'], grade: 'B' },
  { id: 7, date: '30.04.2026', asset: 'ETHUSDT', dir: 'LONG', entry: 3088, exit: 3142, pnl: 162.0, r: 1.5, tags: ['Breakout'], grade: 'B' },
  { id: 8, date: '29.04.2026', asset: 'BTCUSDT', dir: 'LONG', entry: 65820, exit: 65420, pnl: -200.0, r: -1.0, tags: ['Trend'], grade: 'C' },
  { id: 9, date: '28.04.2026', asset: 'SOLUSDT', dir: 'SHORT', entry: 138.80, exit: 134.20, pnl: 230.0, r: 2.3, tags: ['Reversal'], grade: 'A' },
  { id: 10, date: '27.04.2026', asset: 'BTCUSDT', dir: 'LONG', entry: 64800, exit: 66100, pnl: 390.0, r: 2.1, tags: ['Trend', 'Breakout'], grade: 'A' },
];

const Journal = () => {
  const [selectedId, setSelectedId] = useState(1);
  const [filter, setFilter] = useState('Alle');
  const filters = ['Alle', 'Gewonnen', 'Verloren', 'Long', 'Short', 'Markiert'];
  const trade = TRADES.find(t => t.id === selectedId);

  const kpis = [
    { label: 'Einträge', value: <CountUp to={501}/>, color: 'var(--text-primary)', tip: 'Gesamtzahl Journal-Einträge' },
    { label: 'Win-Rate', value: <CountUp to={61.2} suffix="%" decimals={1}/>, color: 'var(--win)' },
    { label: 'Avg. R', value: <CountUp to={1.84} decimals={2}/>, color: 'var(--text-primary)' },
  ];

  return (
    <div className="app">
      <Sidebar active="journal" />
      <main className="main">
        <Topbar title="Journal" subtitle="501 Einträge · 7 in dieser Woche" kpis={kpis}/>
        <div className="content page-enter">
          <div className="journal-layout">
            {/* LEFT: list */}
            <div className="card journal-list-card">
              <div className="card-head">
                <Icon name="book" className="ico"/>
                <h3>Alle Trades</h3>
                <div className="actions">
                  <button className="btn btn-sm" data-tip="Neuer Eintrag (N)"><Icon name="plus" size={12}/> Neu</button>
                  <button className="btn btn-sm btn-ghost" data-tip="Exportieren als CSV"><Icon name="download" size={12}/></button>
                </div>
              </div>

              <div className="journal-toolbar">
                <div className="search-input">
                  <Icon name="filter" size={12}/>
                  <input placeholder="Suchen nach Asset, Tag, Notiz…"/>
                </div>
                <div className="filter-pills">
                  {filters.map(f => (
                    <button key={f}
                            className={`pill ${filter === f ? 'pill-active' : ''}`}
                            onClick={() => setFilter(f)}>
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div className="journal-table">
                <div className="journal-row journal-row-head">
                  <span>Datum</span>
                  <span>Asset</span>
                  <span>Richtung</span>
                  <span>R</span>
                  <span>PnL</span>
                  <span>Tags</span>
                  <span></span>
                </div>
                {TRADES.map(t => (
                  <div key={t.id}
                       className={`journal-row ${selectedId === t.id ? 'journal-row-active' : ''}`}
                       onClick={() => setSelectedId(t.id)}>
                    <span className="mono dim">{t.date}</span>
                    <span><AssetChip symbol={t.asset}/></span>
                    <span>
                      <span className={`badge ${t.dir === 'LONG' ? 'badge-long' : 'badge-short'}`}>{t.dir}</span>
                    </span>
                    <span className={`mono ${t.r > 0 ? 'win' : 'loss'}`}>{t.r > 0 ? '+' : ''}{t.r.toFixed(1)}R</span>
                    <span className={`mono ${t.pnl > 0 ? 'win' : 'loss'}`}>{t.pnl > 0 ? '+' : ''}${Math.abs(t.pnl).toFixed(0)}</span>
                    <span className="tag-row">
                      {t.tags.slice(0, 2).map(tag => <span key={tag} className="badge badge-tag">{tag}</span>)}
                    </span>
                    <span className={`grade grade-${t.grade.toLowerCase()}`}>{t.grade}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* RIGHT: detail */}
            <div className="card journal-detail-card">
              <div className="card-head">
                <Icon name="receipt" className="ico"/>
                <h3>Trade Detail</h3>
                <div className="actions">
                  <button className="btn btn-sm btn-ghost" data-tip="Bearbeiten"><Icon name="edit" size={12}/></button>
                  <button className="btn btn-sm btn-ghost" data-tip="Schließen"><Icon name="x" size={12}/></button>
                </div>
              </div>

              <div className="card-body">
                <div className="trade-detail-head">
                  <AssetChip symbol={trade.asset}/>
                  <span className={`badge ${trade.dir === 'LONG' ? 'badge-long' : 'badge-short'}`}>{trade.dir}</span>
                  <span className="dim small">{trade.date}</span>
                  <div className="topbar-spacer"></div>
                  <span className={`grade grade-${trade.grade.toLowerCase()}`} data-tip={`Setup-Note: ${trade.grade}`}>{trade.grade}</span>
                </div>

                <div className="kpi-grid-3">
                  <div className="kpi-tile">
                    <div className="l">Entry</div>
                    <div className="v mono">${trade.entry.toLocaleString('de-DE')}</div>
                  </div>
                  <div className="kpi-tile">
                    <div className="l">Exit</div>
                    <div className="v mono">${trade.exit.toLocaleString('de-DE')}</div>
                  </div>
                  <div className="kpi-tile">
                    <div className="l">PnL</div>
                    <div className={`v mono ${trade.pnl > 0 ? 'win' : 'loss'}`}>{trade.pnl > 0 ? '+' : ''}${Math.abs(trade.pnl).toFixed(2)}</div>
                  </div>
                  <div className="kpi-tile">
                    <div className="l">R-Multiple</div>
                    <div className={`v mono ${trade.r > 0 ? 'win' : 'loss'}`}>{trade.r > 0 ? '+' : ''}{trade.r.toFixed(1)}R</div>
                  </div>
                  <div className="kpi-tile">
                    <div className="l">Hold-Zeit</div>
                    <div className="v mono">2h 14m</div>
                  </div>
                  <div className="kpi-tile">
                    <div className="l">Risk</div>
                    <div className="v mono dim">0.8%</div>
                  </div>
                </div>

                <div className="section-label">Chart</div>
                <ChartPlaceholder title="Trade Chart wird angebunden" sub="Live-Chart in Vorbereitung" height={170}/>

                <div className="section-label">Setup-Checkliste</div>
                <ul className="reasons-list">
                  <li><span className="check"><Icon name="check" size={11}/></span><span>Trend in Richtung des höheren TF</span></li>
                  <li><span className="check"><Icon name="check" size={11}/></span><span>Volumen-Bestätigung auf Entry</span></li>
                  <li><span className="check"><Icon name="check" size={11}/></span><span>R:R mindestens 1.5</span></li>
                  <li><span className="check check-off"></span><span className="dim">News-Risk geprüft (vergessen)</span></li>
                </ul>

                <div className="section-label">Tags</div>
                <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
                  {trade.tags.map(t => <span key={t} className="badge badge-tag">{t}</span>)}
                  <button className="badge badge-tag badge-ghost" data-tip="Tag hinzufügen"><Icon name="plus" size={10}/> Tag</button>
                </div>

                <div className="section-label">Notiz</div>
                <div className="note-box">
                  {trade.note || 'Keine Notiz hinzugefügt.'}
                </div>

                <div className="section-label">Anhänge</div>
                <div className="attachments">
                  <div className="attachment" data-tip="entry_chart.png">
                    <Icon name="folder" size={14}/>
                    <span>entry_chart.png</span>
                  </div>
                  <div className="attachment" data-tip="exit_chart.png">
                    <Icon name="folder" size={14}/>
                    <span>exit_chart.png</span>
                  </div>
                  <button className="attachment attachment-add" data-tip="Datei anhängen">
                    <Icon name="upload" size={14}/>
                    <span>Hochladen</span>
                  </button>
                </div>
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

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<Journal/>);
