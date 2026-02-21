import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);

// Configuração da Autenticação com a sua conta específica
const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email, null, GOOGLE_CONFIG.private_key,
  ['https://www.googleapis.com/auth/calendar.readonly']
);
const calendar = google.calendar({ version: 'v3', auth });

async function buscarAgenda() {
  try {
    const agora = new Date();
    // Define o início e o fim do dia de hoje para a busca
    const inicio = new Date(agora.setHours(0, 0, 0, 0)).toISOString();
    const fim = new Date(agora.setHours(23, 59, 59, 999)).toISOString();

    const response = await calendar.events.list({
      calendarId: 'zmphoto@zmphoto.com.br', // Seu ID da agenda atualizado
      timeMin: inicio,
      timeMax: fim,
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    const eventos = response.data.items || [];
    if (eventos.length === 0) return "A agenda está livre hoje.";

    return "Horários ocupados hoje: " + eventos.map(e => {
      const d = new Date(e.start.dateTime || e.start.date);
      return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }).join(', ');
  } catch (err) {
    console.error("Erro ao acessar a agenda:", err);
    return "Não consegui ler a agenda agora.";
  }
}

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  try {
    const statusAgenda = await buscarAgenda();
    const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    
    const geminiReq = await fetch(urlGemini, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `Você é o assistente do fotógrafo Dionizio. A agenda dele hoje está assim: ${statusAgenda}. Informe os horários ocupados de forma simpática e breve.` }]
        },
        contents: [{ parts: [{ text: message.text || "" }] }]
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
app.listen(PORT, () => console.log("🚀 Assistente ZM Photo Online!"));
