import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("TradingView bot läuft");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get("/test-telegram", async (req, res) => {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: "✅ Telegram Test: Dein Trading Bot funktioniert."
      })
    });

    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const signal = req.body;
    console.log("Signal erhalten:", signal);

    const msg = await anthropic.messages.create({
      model: "claude-3-5-haiku-latest",
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: `Analysiere dieses TradingView Signal für 5-Minuten-Trading:
${JSON.stringify(signal, null, 2)}

Antworte kurz mit:
- Entscheidung: CONFIRM / REJECT
- Risiko: LOW / MEDIUM / HIGH
- Confidence: 0-100%
- Grund: kurz`
        }
      ]
    });

    const analysisText = msg.content[0].text;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: `📊 ${signal.symbol} (${signal.timeframe})
💰 Preis: ${signal.price}
⚡ Aktion: ${signal.action}
🕒 Zeit: ${signal.time}

🤖 KI Analyse:
${analysisText}`
      })
    });

    res.json({
      status: "ok",
      received: signal,
      analysis: analysisText
    });
  } catch (err) {
    console.error("Fehler:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
