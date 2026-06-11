# WAVESCOUT Score Optimizer

Kalibriert die WAVESCOUT-Score-Formel aus **echten Win-Rates**, bewertet Live-Signale
(**GO / NO-GO / CAUTION**), überwacht offene Positionen auf **Korrelations-Risiken**
und generiert **tägliche Reports** (JSON / HTML / CSV).

Läuft lokal als Express-API (Port 3000) **oder** als eigener Cloudflare Worker auf
derselben D1-Datenbank wie der Haupt-Worker (`wavescout_db`).

---

## Wichtigste Erkenntnisse aus den echten Daten (102 Trades, Stand 11.06.2026)

Die Kalibrierung lief gegen den Live-Export der `signals`-Tabelle
(`data/trades-2026-06-11.csv`, 79 W / 23 L = **77,5 % Baseline**):

| Befund | Daten | Konsequenz |
|---|---|---|
| **EMA200-Ausschluss-Paradox bestätigt** | Trades MIT dem Flag: **84,2 %** WR (n=38) | Regel invertiert: −12 → **+5** (oder Grenzwert 0,5 % → 0,1 % senken) |
| **Resistance-SHORT schwach** | 70,7 % WR (n=41) | +10 → **−5** |
| **RSI 55–65 Neutralzone schwach** | 70,4 % WR (n=27) | 0 → **−7** |
| **US-Open-Session schwach** | 55,6 % WR (n=9) | +5 → **−15** |
| **Score-Band 75–85 ist die Schwachstelle** | 72,4 % WR (n=76, die Masse!) | Zusatzfilter nötig (s. u.) |
| **Best-Combo** | EMA-Distanz 0,5–1,3 % + Alignment + **London-Session**: **100 %** (n=19) | Stark-Filter für das Schwach-Band |
| **Neue GO-Schwelle** | Score ≥ 56 (neue Skala): **92,3 %** WR bei 25,5 % der Signale; Score ≥ 54: 88,6 % bei 34,3 % | 77,5 % → **88–92 %** |

### Gefundene Bugs im Hauptsystem

1. **Dashboard zeigt 96,3 % statt 78 %** — Ursache gefunden: Die Zahl stammt aus
   `practice_trades` (79 W / **3 L** = 96,3 %), nicht aus `signals` (79 W / 22 L).
   Die `practice_trades`-Tabelle ist nicht synchron:
   - **8 Positionen stehen auf OPEN**, obwohl ihre Signale längst als LOSS
     geschlossen wurden (die „8 offenen Positionen" sind Geister).
   - **14 Status-Inversionen** (practice WIN vs. signal LOSS und umgekehrt).
   - Gründe im Worker-Code:
     - `checkPracticeTrades()` läuft nur bei eingehenden PRICE_UPDATEs für das
       jeweilige Symbol — der TP/SL-Cron (`evaluateOpenTrades`) aktualisiert nur
       `signals` über Live-Preise. Zwei Bewertungspfade, nie abgeglichen.
     - Der 3h-Profit-Close schließt practice_trades **nur als WIN** (nie als LOSS)
       → systematische Schönfärbung der practice-Statistik.
   - Der Position-Monitor dieses Tools erkennt alle 8 Geister-Positionen
     (`STALE_POSITION`-Alerts) und meldet sie zum Schließen.
2. **Session-Bonus zur Verarbeitungszeit:** Der Worker bewertet London/US-Session
   mit `new Date()` (Auswertezeitpunkt), nicht mit der Signal-Zeit. Der Optimizer
   leitet die Session immer aus dem Signal-Timestamp ab.
3. **Korrelations-Blindheit:** SUIUSDT + VIRTUALUSDT SHORT um exakt 00:20 → beide
   −1 %. Der Evaluator vetot jetzt parallele Entries gleicher Richtung (<5 min)
   und >2 offene Positionen pro Symbol.

> Hinweis zur Spec: Die „13,2 % Baseline" und Regel-Win-Raten wie „RSI 55–65 = 7,8 %"
> stammen aus den 500 Backtesting-Signalen (anderes Universum). Dieses Tool
> kalibriert gegen die **echten 102 Trades** (Baseline 77,5 %) — die Richtung der
> Befunde (RSI 55–65 schwach, Resistance-SHORT schwach, EMA200-Paradox) bestätigt
> sich auch dort. Seit dem CSV-Export ist außerdem ein 23. Loss dazugekommen
> (RIVERUSDT LONG, 11.06. 05:05).

---

## Architektur

```
score-optimizer/
├── index.js        Express-API (lokal, Port 3000)
├── worker.js       Cloudflare-Worker-Variante (gleiche Endpoints)
├── api.js          Endpoint-Logik (geteilt zwischen Express & Worker)
├── optimizer.js    Kalibrierung, Regel-Ranking, Kombos, Backtest
├── scoring.js      Live-Evaluator (Score + GO/NO-GO/CAUTION)
├── rules.js        Regel-Normalisierung (DE-Strings → Keys) + Regel-Engine
├── monitor.js      Position-Monitor (Korrelation, Geister, Exposure)
├── reports.js      Tagesreport (JSON / HTML / CSV)
├── storage.js      D1 (REST oder Worker-Binding) + In-Memory-Fallback
├── csv.js          CSV-Parser/-Serializer (RFC 4180)
├── cli.js          Offline-Nutzung ohne Server
├── schema.sql      D1-Schema (optimizer_*-Tabellen)
├── wrangler.toml   Worker-Config (nutzt bestehende wavescout_db)
├── data/
│   ├── trades-2026-06-11.csv   Echte 102 Trades (Live-Export aus D1)
│   ├── open-positions.csv      Die 8 offenen practice_trades
│   └── formula.json            Kalibrierte Score-Formel (Output)
├── reports/                    Generierte Tagesreports
└── test/optimizer.test.js      15 Tests (node --test)
```

---

## Setup & Nutzung

```bash
cd score-optimizer
npm install
npm test            # 15 Tests
npm run dev         # API auf http://localhost:3000
```

Beim ersten Start werden die mitgelieferten CSVs automatisch importiert.
Ohne Cloudflare-Credentials läuft alles in-memory mit Snapshot in `data/store.json`;
mit `CF_*`-Variablen in `.env` (siehe `.env.example`) wird direkt in D1 gespeichert.

### Offline (ohne Server)

```bash
npm run calibrate   # Regel-Ranking + neue Formel → data/formula.json
npm run report      # Tagesreport → reports/report-<datum>.{json,html,csv}
node cli.js evaluate '{"symbol":"SOLUSDT","direction":"LONG","rsi":44,"ema50":65.1,"ema200":64.57,"price":65.09,"timeframe":"5m"}'
```

### API-Endpoints

| Endpoint | Beschreibung |
|---|---|
| `POST /api/import-csv` | CSV importieren (Body: `text/csv` roh, oder JSON `{csv}` / `{path}`; `?type=trades\|positions`) |
| `POST /api/calibrate-score` | Formel aus importierten Trades neu kalibrieren → `{newWeights, improvement, deadRules, …}` |
| `POST /api/evaluate-signal` | Signal bewerten → `{score, recommendation: GO\|NO-GO\|CAUTION, reasons, warnings, vetoes}` |
| `GET /api/positions-monitor` | `{open, correlations, exposure, alerts}` |
| `GET /api/report-daily` | `?format=json\|html\|csv&date=YYYY-MM-DD` |
| `GET /api/rules` | aktive / tote / invertierte Regeln + Empfehlungen |

Beispiel — das Verlierer-Setup vom 11.06. 00:20 wird jetzt blockiert:

```bash
curl -s -X POST localhost:3000/api/evaluate-signal -H 'Content-Type: application/json' \
  -d '{"symbol":"VIRTUALUSDT","direction":"SHORT","rsi":70.2,"ema50":0.5429,"ema200":0.5534,"price":0.5491,"timeframe":"5m"}'
# → NO-GO: Score 42 + Vetoes "KORRELATION: 3 offene Positionen auf VIRTUALUSDT"
#   und "DUPLIKAT-SETUP: VIRTUALUSDT SHORT wurde in den letzten 24h bereits verloren"
```

---

## Kalibrierungs-Methodik

1. Regel-Strings aus `matched_rules` ∪ `failed_rules` werden auf kanonische Keys
   normalisiert (`rules.js`), plus abgeleitete Features (RSI-Buckets,
   EMA200-Distanz, Session aus Signal-Zeit).
2. Pro Key: Wins/Losses → Win-Rate, geglättet mit Laplace `(w+1)/(n+2)`.
3. **Neues Gewicht** = `(geglättete WR − Baseline) × 80`, geclampt auf **[−15, +25]**
   (Spec: Stark-Rules max ±25, Dead-Rules max −15). Keys mit n < 5 behalten ihr
   altes Gewicht (`INSUFFICIENT`).
4. **EMA200-Spezialfall:** Performt die Ausschluss-Regel über Baseline, wird sie
   invertiert (mind. +5).
5. **Schwellen aus Backtest:** Die neue Formel wird auf die Historie angewendet;
   die GO-Schwelle ist der kleinste Score mit ≥85 % Ziel-WR bei ≥30 % behaltenen
   Signalen. Signale knapp über GO ohne Stark-Filter (London / EMA-Sweet-Spot)
   werden auf CAUTION heruntergestuft.

**Achtung Interpretierbarkeit:** Die neue Skala ist baseline-relativ — Score 50 =
durchschnittliches Signal (77,5 % WR). Die Schwellen kommen aus der Kalibrierung
(`formula.thresholds`), nicht mehr fix 75/85. Der Backtest ist in-sample bei n=102;
die 100 %-Kombos (n=19) sind vielversprechend, aber statistisch noch dünn —
nach ~100 weiteren Trades neu kalibrieren (`POST /api/calibrate-score`).

---

## Cloudflare-Deployment (optional)

```bash
cd score-optimizer
wrangler login
wrangler deploy            # eigener Worker: wavescout-score-optimizer
```

Der Worker nutzt **dieselbe D1-Datenbank** (`wavescout_db`) mit eigenen Tabellen
(`optimizer_*`, siehe `schema.sql`) und kann die Trades **direkt aus der
bestehenden `signals`-Tabelle übernehmen** — ohne CSV:

```bash
curl -X POST https://wavescout-score-optimizer.<subdomain>.workers.dev/api/import-from-signals
curl -X POST https://wavescout-score-optimizer.<subdomain>.workers.dev/api/calibrate-score
```

Optional KV-Cache für die Formel: `wrangler kv namespace create RULES_KV`,
dann das Binding in `wrangler.toml` einkommentieren.

### Integration in den Haupt-Worker

Im Haupt-Worker vor dem Practice-Trade-Anlegen den Evaluator fragen:

```js
const res = await fetch('https://wavescout-score-optimizer.<subdomain>.workers.dev/api/evaluate-signal', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ symbol, direction, rsi, ema50, ema200, price, timeframe, created_at: Date.now() }),
});
const { recommendation, vetoes } = await res.json();
if (recommendation === 'NO-GO') { /* Trade blocken, Grund loggen */ }
```

---

## Empfohlene Fixes im Hauptsystem (worker.js)

1. `practice_trades` mit `signals` synchronisieren: beim Schließen eines Signals
   (TP/SL-Cron) auch die zugehörige practice_trade-Zeile (via `signal_id`) schließen.
2. 3h-Profit-Close: practice_trades nicht nur als WIN schließen — oder die
   practice-Statistik aus `signals` ableiten statt doppelt zu führen.
3. Session-Bonus aus der Signal-Zeit statt `new Date()` berechnen.
4. Einmalige Daten-Reparatur: die 8 OPEN-Geister und 14 Status-Inversionen in
   `practice_trades` aus `signals` korrigieren.
