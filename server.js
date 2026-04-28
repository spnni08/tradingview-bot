import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.get("/", (req, res) => {
  res.send("TradingView bot läuft");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
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

Antworte kurz als JSON mit:
decision, risk, confidence, reason.`,
        },
      ],
    });

    res.json({
      status: "ok",
      received: signal,
      analysis: msg.content[0].text,
    });
  } catch (err) {
    console.error("Fehler:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
