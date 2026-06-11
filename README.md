# WAVESCOUT

**Automatisiertes Trading-Signal-System auf Basis von TradingView-Webhooks, KI-Analyse und Cloudflare Workers.**  
WAVESCOUT empfängt Signale von TradingView, bewertet sie mit regelbasierter Logik und Claude AI, speichert sie in einer Datenbank und sendet qualifizierte Alerts per Telegram.

---

## Zweck & Ziel

WAVESCOUT richtet sich an aktive Trader, die ihre TradingView-Alerts automatisiert auswerten und dokumentieren wollen. Das System übernimmt:

- die Filterung von schwachen Signalen (Score-basiert)
- die KI-gestützte Bewertung jedes Signals (Entry, TP, SL, Risiko)
- die Archivierung aller Signale zur späteren Auswertung (Backtesting, Journal)
- den Versand relevanter Alerts per Telegram

---

## Tech-Stack

| Schicht | Technologie |
|--------|-------------|
| Backend / Worker | [Cloudflare Workers](https://workers.cloudflare.com/) (JavaScript) |
| Datenbank | Cloudflare D1 (SQLite-kompatibel) |
| KI-Analyse | Anthropic Claude API (`claude-sonnet-4-5`) |
| Frontend | React (Babel-CDN, keine Build-Pipeline) |
| Deployment | Cloudflare Pages (Frontend) + Workers (API) |
| Alerts | Telegram Bot API |
| Signal-Quelle | TradingView Webhook-Alerts |
| Konfiguration | `wrangler.toml` (Cloudflare) |

---

## Projektstruktur

```
tradingview-bot/
├── worker.js               # Haupt-Worker: Webhook, API-Endpunkte, Signal-Verarbeitung
├── wrangler.toml           # Cloudflare-Konfiguration (D1, Cron, Routes)
├── score-optimizer/        # Score-Kalibrierung aus echten Win-Rates, Live-Evaluator
│                           # (GO/NO-GO), Position-Monitor, Tagesreports → eigenes README
└── frontend/
    ├── index.html          # SPA-Einstiegspunkt (React via Babel-CDN)
    ├── app.jsx             # Router, Session-Management
    ├── shell.jsx           # Navigation & Sidebar
    ├── dashboard.jsx       # Live-Dashboard (30s-Polling)
    ├── backtest.jsx        # Signalhistorie & Backtest-Auswertung
    ├── journal.jsx         # Trading-Journal (Morgenroutine, Checkliste, Review)
    ├── statistiken.jsx     # Analytics & Bias-Statistiken
    ├── admin.jsx           # Admin-Panel (DB, AI-Test, Telegram-Test)
    ├── einstellungen.jsx   # Strategieverwaltung & Einstellungen
    ├── news.jsx            # Market Radar (Crypto-News via RSS)
    └── shared.css / styles.css
```

---

## Installation & Setup

### Voraussetzungen

- [Node.js](https://nodejs.org/) ≥ 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
- Cloudflare-Account mit aktiviertem D1 und Workers

### Lokale Entwicklung

```bash
# Repository klonen
git clone https://github.com/spnni08/tradingview-bot.git
cd tradingview-bot

# Wrangler einloggen
wrangler login

# Lokalen Worker starten (mit D1 remote binding)
wrangler dev --remote
```

### Umgebungsvariablen (Cloudflare Worker Secrets)

```bash
wrangler secret put WEBHOOK_SECRET       # Geheimnis für TradingView-Webhook
wrangler secret put TELEGRAM_BOT_TOKEN   # Telegram-Bot-Token
wrangler secret put TELEGRAM_CHAT_ID     # Telegram Chat-ID
wrangler secret put ANTHROPIC_API_KEY    # Claude API-Key
```

### Datenbank initialisieren

Nach dem ersten Deployment im Admin-Panel aufrufen:  
`Admin → Setup DB` — führt alle Tabellen-Migrationen aus.

### Deployment

```bash
wrangler deploy
```

Das Frontend wird über Cloudflare Pages aus dem `frontend/`-Ordner bereitgestellt (via Git-Integration).

---

## Verwendung

### TradingView-Webhook konfigurieren

Alert-URL:
```
https://<your-worker>.workers.dev/webhook?secret=<WEBHOOK_SECRET>
```

Erwartetes JSON-Payload (Mindestanforderung):
```json
{
  "event_type": "SIGNAL",
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "price": 80000,
  "timeframe": "15",
  "rsi": 42,
  "ema50": 79500,
  "ema200": 78000,
  "trend": "bullish"
}
```

Unterstützte `event_type`-Werte: `SIGNAL`, `SIGNAL_NEW`, `SNAPSHOT`, `PRICE_UPDATE`

### Dashboard aufrufen

```
https://<pages-domain>.pages.dev
```

Standard-Login wird beim ersten `POST /admin/setup-db` + `POST /admin/create-user` angelegt.

### Automatische Cron-Jobs

| Zeit | Aufgabe |
|------|---------|
| 07:00 UTC täglich | Tagesbericht per Telegram |
| Alle 4 Stunden | Offene Trades gegen Live-Kurs prüfen (TP/SL) |

---

## Aktueller Status

### ✅ Funktioniert

- Webhook-Empfang und Signal-Verarbeitung (SIGNAL, SNAPSHOT, PRICE_UPDATE)
- Regelbasierte Analyse mit konfigurierbaren Gewichtungen (RSI, EMA, Trend, Wave-Bias, S/R)
- KI-Analyse via Claude API mit automatischem Fallback auf Regelanalyse
- Score-basiertes Telegram-Alerting (Schwellenwert konfigurierbar, Standard: 55)
- Signale werden vollständig in D1 gespeichert (inkl. Matched/Failed Rules, Score-Breakdown)
- Live-Dashboard mit 30-Sekunden-Polling
- Practice Trades (virtuelle Positionen mit automatischem TP/SL-Check)
- Trading-Journal: Morgenroutine → Pre-Trade-Checkliste → Trade-Review (symbol-basiert)
- Market Radar: 17 RSS-Feeds aggregiert (CoinDesk, Cointelegraph, Google News, Exchanges)
- Strategieverwaltung mit A/B-Backtest-Vergleich
- Rollenbasiertes Benutzer-Management (admin, trader, viewer, extern)
- Automatischer Tagesbericht und offene Positionen per Cron

### 🔧 Kürzlich behoben

- `tryParseJSON` war nicht definiert → Signal-Verarbeitung crashte bei Score ≥ 55 (Signale wurden silent gedroppt)
- 24 fehlende DB-Spalten in der Auto-Migration → INSERT schlug fehl
- Kein Schutz gegen leere AI-Prompts → `requireNonEmptyPrompt()` Guard eingebaut

### 🚧 In Arbeit / Bekannte Einschränkungen

- Passwort-Hashing ist Base64 (btoa) — nicht produktionsreif, sollte durch bcrypt/Argon2 ersetzt werden
- Webhook-Authentifizierung via URL-Parameter (besser wäre ein Header-basierter HMAC)
- Kein automatisches Redeployment des Frontends bei Worker-Änderungen (manuell)

---

## Nächste Schritte

- [ ] Passwort-Hashing auf bcrypt/Argon2 umstellen
- [ ] Webhook-Auth auf HMAC-Signatur (Header-basiert) umstellen
- [ ] Multi-Symbol-Unterstützung im Journal ausbauen
- [ ] Erweiterte Backtest-Metriken (Sharpe Ratio, Max Drawdown)
- [ ] Push-Benachrichtigungen (Web Push API) als Telegram-Alternative
- [ ] Unit-Tests für Regelanalyse und Score-Berechnung

---

## Lizenz

Privates Projekt — kein öffentliches Deployment ohne Genehmigung.
