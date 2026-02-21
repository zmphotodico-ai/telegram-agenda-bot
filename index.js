import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);

const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email, null, GOOGLE_CONFIG.private_key,
  ['https://www.googleapis.com/auth/calendar.readonly']
);
const calendar = google.calendar({ version: 'v3', auth });

async function buscarAgenda() {
  try {
    const agora = new Date();
    const inicio = new Date(agora.setHours(0, 0, 0, 0)).toISOString();
    const fim = new Date(agora.setHours(23, 59, 59, 999)).toISOString();

    const response = await calendar.events.list({
      calendarId: 'zmphoto@zmphoto.com.br', 
      timeMin: inicio,
      timeMax: fim,
      singleEvents: true,
    });
    
    const eventos = response.data.items || [];
    return eventos.length > 0 
      ? "Ocupado: " + eventos.map(e => e.summary).join(", ")
      : "Agenda livre hoje.";
  } catch (err) {
    return "ERRO DE PERMISSÃO NO GOOGLE";
  }
}

app.post("/webhook", async (req, res) => {
  const texto = req.body.message?.text || "";
  const chatId = req.body.message?.chat.id;

  if (chatId) {
    const status = await buscarAgenda();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    
    const gemini = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `Você é assistente do Dionizio. Agenda: ${status}. Responda ao cliente.` }] },
        contents: [{ parts: [{ text: texto }] }]
      })
    }).then(r => r.json());

    const resposta = gemini.candidates?.[0]?.content?.parts[0]?.text || "Oi!";
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: resposta })
    });
  }
  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000);
