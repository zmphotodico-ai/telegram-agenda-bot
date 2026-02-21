import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

console.log("🟢 Node version:", process.version);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// 🔎 Carregando GOOGLE_CONFIG com segurança
let GOOGLE_CONFIG;

try {
  GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);

  GOOGLE_CONFIG.private_key =
    GOOGLE_CONFIG.private_key.replace(/\\n/g, "\n");

  console.log("✅ GOOGLE_CONFIG carregado com sucesso");
} catch (err) {
  console.error("❌ Erro ao carregar GOOGLE_CONFIG:", err);
}

// 🔐 Autenticação Google
const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email,
  null,
  GOOGLE_CONFIG.private_key,
  ["https://www.googleapis.com/auth/calendar.readonly"]
);

const calendar = google.calendar({ version: "v3", auth });

// 📅 Buscar agenda de hoje
async function buscarAgendaHoje() {
  try {
    const inicio = new Date();
    inicio.setHours(0, 0, 0, 0);

    const fim = new Date();
    fim.setHours(23, 59, 59, 999);

    console.log("🔎 Buscando eventos entre:", inicio, "e", fim);

    const response = await calendar.events.list({
      calendarId: "zmphoto@zmphoto.com.br",
      timeMin: inicio.toISOString(),
      timeMax: fim.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const eventos = response.data.items || [];

    console.log("📌 Eventos retornados:", eventos.length);

    if (eventos.length === 0) {
      return "Agenda está livre hoje.";
    }

    return eventos
      .map((e) => {
        const data = new Date(e.start.dateTime || e.start.date);

        const hora = data.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Sao_Paulo",
        });

        return `${e.summary} às ${hora}`;
      })
      .join("\n");

  } catch (err) {
    console.error("❌ Erro Google Calendar:", err);
    return "Erro ao acessar a agenda.";
  }
}

// 🤖 Webhook Telegram
app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const textoUsuario = message.text;

  try {
    const agendaHoje = await buscarAgendaHoje();

    const promptSistema = `
Você é o assistente do Dionizio.
Agenda de hoje:
${agendaHoje}

Se perguntarem sobre horários ou agenda, use essas informações.
Seja curto e educado.
`;

    console.log("🧠 Enviando para Gemini...");

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: promptSistema + "\n\nCliente: " + textoUsuario }
              ],
            },
          ],
        }),
      }
    );

    const data = await geminiResponse.json();

    console.log("🧠 Resposta bruta Gemini:", JSON.stringify(data, null, 2));

    const respostaIA =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Não consegui gerar resposta agora.";

    await fetch(
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: respostaIA,
        }),
      }
    );

  } catch (err) {
    console.error("❌ Erro geral:", err);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
