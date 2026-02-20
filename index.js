import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);

// Configura o acesso à agenda
const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email, null, GOOGLE_CONFIG.private_key,
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({ version: 'v3', auth });

// Função para listar eventos do dia
async function listarEventos() {
  const agora = new Date();
  const fimDoDia = new Date();
  fimDoDia.setHours(23, 59, 59);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: agora.toISOString(),
    timeMax: fimDoDia.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items;
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const texto = message.text || "";

  try {
    // 1. Busca eventos reais na sua agenda
    const eventos = await listarEventos();
    const agendaHoje = eventos.length > 0 
      ? eventos.map(e => `- ${e.summary} (${new Date(e.start.dateTime).toLocaleTimeString()})`).join('\n')
      : "Nenhum compromisso para hoje.";

    // 2. Passa essa informação para o Gemini responder ao cliente
    const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    
    const geminiReq = await fetch(urlGemini, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `Você é o assistente do Dionizio. Agenda de hoje:\n${agendaHoje}\nAjude o cliente a marcar um ensaio nos horários vagos.` }]
        },
        contents: [{ parts: [{ text: texto }] }]
      })
    });
    
    const geminiRes = await geminiReq.json();
    const resposta = geminiRes.candidates?.[0].content.parts[0].text || "Pode repetir?";

    // 3. Responde no Telegram
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: resposta })
    });

  } catch (e) {
    console.error("❌ Erro:", e);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Bot da Agenda Online!"));
