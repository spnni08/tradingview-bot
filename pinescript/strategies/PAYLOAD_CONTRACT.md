# WAVESCOUT — Webhook Payload-Vertrag (Multi-Strategie)

Alle 4 Strategie-Pine-Scripts posten an **dieselbe** Webhook-URL:

```
https://tradingview-bot.spnn08.workers.dev/webhook
```

Es werden **keine** mehreren Webhook-URLs benötigt. Die Strategie wird über das
`strategy`-Feld im JSON-Body unterschieden. Fehlt das Feld, fällt der Worker
rückwärtskompatibel auf `crypto_baseline` zurück.

## Pflichtfelder (alle Strategien)

| Feld         | Typ    | Beispiel              | Bedeutung |
|--------------|--------|-----------------------|-----------|
| `strategy`   | string | `"crypto_sr_volume"`  | Routing-Key (siehe Registry unten). |
| `symbol`     | string | `"BTCUSDT"`/`"EURUSD"` | Bestimmt Asset-Klasse (crypto/forex) automatisch im Worker. |
| `direction`  | string | `"LONG"` / `"SHORT"`  | Trade-Richtung. |
| `price`      | number | `64250.5`             | Entry-Referenzpreis (`close`). |
| `rsi`        | number | `57.3`                | für Scoring/Telemetrie. |
| `ema50`      | number | `64100`               | |
| `ema200`     | number | `63000`               | Trendfilter. |
| `timeframe`  | string | `"15"`                | Entry-Timeframe. |

## Optionale / strategie-spezifische Felder

Die **Entry-Logik liegt in Pine** — der Worker rechnet sie nicht nach. Diese
Felder sind daher v. a. Telemetrie/Audit (der Worker ignoriert unbekannte Felder):

| Strategie                    | Zusatzfelder |
|------------------------------|--------------|
| `crypto_sr_volume`           | `poc`, `vah`, `val`, `vp_zone` |
| `crypto_orderflow_breakout`  | `range_high`, `range_low`, `candle_volume`, `avg_volume`, `range_n` |
| `forex_sr_fib_rsi`           | `support`, `resistance`, `fib_382`, `fib_500`, `fib_618` |

## Strategie-Registry (Worker)

| `strategy`                   | Asset-Klasse | Score-Gate        | Session-Gate (hart) |
|------------------------------|--------------|-------------------|---------------------|
| `crypto_baseline`            | crypto       | ja (Score ≥ 75)   | nein |
| `crypto_sr_volume`           | crypto       | nein (Pine-Entry) | nein |
| `crypto_orderflow_breakout`  | crypto       | nein (Pine-Entry) | nein |
| `forex_sr_fib_rsi`           | forex        | nein (Pine-Entry) | **ja** (London-Open / NY-Overlap) |

- **Asset-Klasse** wird im Worker aus `symbol` erkannt (`detectAssetClass`):
  USDT/USDC/BTC/ETH… ⇒ crypto · 6-stellige Fiat-Paare ⇒ forex · XAU/XAG ⇒ forex
  (Metalle) · unbekannt ⇒ crypto.
- **Forex-Session (hart):** Außerhalb 08:00–09:00 UTC (London-Open, 09–10 MEZ)
  bzw. 13:00–16:00 UTC (LDN/NY-Overlap, 14–17 MEZ) generiert der Worker **kein**
  handelbares Signal (Status `SKIPPED`). Das Pine-Script gated zusätzlich.

## Gemeinsame Exit-Logik

Alle Strategien nutzen die gemeinsame **TP1 → Breakeven → TP2**-Logik im Worker.
TP1/TP2/SL-Prozentwerte sind **pro Strategie** über `STRATEGIES[<key>].exit`
konfigurierbar (überschreibt `EXIT_CONFIG`). Beispiel: `forex_sr_fib_rsi` nutzt
eine engere SL-Distanz (`SL_DISTANCE_PCT: 0.30`).

## TradingView-Alert einrichten

1. Indikator aufs Chart legen (passendes Symbol/Timeframe).
2. Alert erstellen → Condition: der Indikator, „Any alert() function call“.
3. Webhook-URL eintragen (siehe oben). Die `alert()`-Nachricht ist bereits das
   fertige JSON — **kein** zusätzlicher Message-Text nötig.
