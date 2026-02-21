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
    // Início e fim do dia de hoje no fuso de Brasília
    const inicio = new Date(agora.setHours(0, 0, 0, 0)).toISOString();
    const fim = new Date(agora.setHours(23, 59, 59, 999)).toISOString();

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: inicio,
      timeMax: fim,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    const eventos = response.data.items || [];
    if (eventos.length === 0) return "A agenda está totalmente livre para hoje.";

    return "Horários ocupados hoje: " + eventos.map(e => {
      const inicioEv = new Date(e.start.dateTime || e.start.date);
      return inicioEv.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }).join(', ');
  } catch (err) {
    console.error("Erro Google:", err);
    return "Erro ao acessar a agenda.";
  }
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const textoCliente = message.text || "";

  try {
    const statusAgenda = await buscarAgenda();

    const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    const geminiReq = await fetch(urlGemini, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `Você é o assistente do Dionizio. Info da agenda: ${statusAgenda}. Se o cliente quiser saber horários, use essa info. Seja curto e simpático.` }]
        },
        contents: [{ parts: [{ text: textoCliente }] }]
      })
    });

    const data = await geminiReq.json();
    const respostaIA = data.candidates?.[0]?.content?.parts[0]?.text || "Como posso ajudar?";

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: respostaIA })
    });
  } catch (e) {
    console.error("Erro Geral:", e);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Sistema de Agenda Ativado!"));
