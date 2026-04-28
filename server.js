import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let lastSignal = null;

function getPriority(score, decision, risk) {
  if (decision === "REJECT" || score < 50) return "❌ IGNORE";
  if (score >= 75 && risk !== "HIGH") return "🔥 HIGH QUALITY";
  return "⚠️ MEDIUM";
}

async function sendTelegram(text) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    }
  );

  return response.json();
}

app.get("/", (req, res) => {
  res.send("TradingView AI Bot läuft");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
  });
});

app.get("/last-signal", (req, res) => {
  res.json({
    lastSignal,
  });
});

app.get("/test-telegram", async (req, res) => {
  try {
    const result = await sendTelegram(
      "✅ Telegram Test: Dein Trading Bot funktioniert."
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/webhook", async (req, res) => {
  const receivedAt = new Date().toISOString();

  try {
    const signal = req.body;

    lastSignal = {
      receivedAt,
      signal,
    };

    console.log("Signal erhalten:", signal);

    const prompt = `
Du bist ein vorsichtiger Trading-Signal-Analyst für 5-Minuten-Charts.

Analysiere dieses TradingView Signal:

${JSON.stringify(signal, null, 2)}

Bewerte das Signal nach:
- RSI / Momentum
- Trendrichtung
- Volatilität
- Risiko
- Wahrscheinlichkeit
- Entry / Take Profit / Stop Loss

WICHTIG:
Antworte NUR als gültiges JSON.
Keine Erklärung außerhalb vom JSON.

JSON Format:
{
  "decision": "CONFIRM" oder "REJECT",
  "score": Zahl von 0 bis 100,
  "risk": "LOW" oder "MEDIUM" oder "HIGH",
  "confidence": Zahl von 0 bis 100,
  "reason": "kurze Begründung auf Deutsch",
  "entry": Zahl,
  "take_profit": Zahl,
  "stop_loss": Zahl,
  "timeframe": "5m",
  "priority_note": "kurzer Hinweis"
}
`;

    const msg = await anthropic.messages.create({
      model: "claude-3-5-haiku-latest",
      max_tokens: 700,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const rawText = msg.content[0].text;

    let ai;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      ai = JSON.parse(jsonMatch[0]);
    } catch (err) {
      ai = {
        decision: "REJECT",
        score: 0,
        risk: "HIGH",
        confidence: 0,
        reason: "KI-Antwort konnte nicht sauber gelesen werden.",
        entry: Number(signal.price) || 0,
        take_profit: 0,
        stop_loss: 0,
        timeframe: signal.timeframe || "5m",
        priority_note: rawText,
      };
    }

    const score = Number(ai.score) || 0;
    const priority = getPriority(score, ai.decision, ai.risk);

    const telegramText = `
${priority}

📊 <b>${signal.symbol || "Unknown"}</b> (${signal.timeframe || "5m"})
⚡ Aktion: <b>${signal.action || "N/A"}</b>
💰 Preis: ${signal.price || "N/A"}
🕒 Zeit: ${signal.time || receivedAt}

🧠 <b>KI Bewertung</b>
Entscheidung: <b>${ai.decision}</b>
Score: <b>${score}/100</b>
Risiko: <b>${ai.risk}</b>
Confidence: <b>${ai.confidence}%</b>

🎯 <b>Trade Plan</b>
Entry: ${ai.entry}
TP: ${ai.take_profit}
SL: ${ai.stop_loss}

📝 Grund:
${ai.reason}

⚠️ Keine Finanzberatung.
`;

    const telegramResult = await sendTelegram(telegramText);

    res.json({
      status: "ok",
      receivedAt,
      signal,
      ai,
      priority,
      telegram: telegramResult,
    });
  } catch (err) {
    console.error("Fehler:", err);

    res.status(500).json({
      status: "error",
      message: err.message,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
