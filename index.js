import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);

const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email, null, GOOGLE_CONFIG.private_key,
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({ version: 'v3', auth });

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
  return res.data.items || [];
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const texto = message.text || "";

  try {
    const eventos = await listarEventos();
    // Criamos um texto claro para a IA entender o que está ocupado
    const resumoAgenda = eventos.length > 0 
      ? "Horários já OCUPADOS hoje: " + eventos.map(e => `${new Date(e.start.dateTime).getHours()}:${new Date(e.start.dateTime).getMinutes().toString().padStart(2, '0')}`).join(', ')
      : "A agenda está totalmente LIVRE para hoje.";

    const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    
    await fetch(urlGemini, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `Você é o assistente do fotógrafo Dionizio. STATUS DA AGENDA AGORA: ${resumoAgenda}. Responda se há horários livres de forma simpática.` }]
        },
        contents: [{ parts: [{ text: texto }] }]
      })
    }).then(r => r.json()).then(async (data) => {
        const respostaIA = data.candidates?.[0]?.content?.parts[0]?.text || "Não consegui ver a agenda agora, mas o Dionizio já te responde!";
        
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: respostaIA })
        });
    });

  } catch (e) {
    console.error("❌ Erro:", e);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Assistente de Agenda Ativo!"));
