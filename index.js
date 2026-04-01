import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN não configurado.");
  process.exit(1);
}

if (!GEMINI_KEY) {
  console.error("❌ GEMINI_API_KEY não configurado.");
  process.exit(1);
}

// ✅ CORREÇÃO PRINCIPAL AQUI (email correto)
const CALENDAR_ID = "alugueldeestudiofotografico@gmail.com";

// =============================
// GOOGLE CALENDAR CONFIG
// =============================
let GOOGLE_CONFIG;
try {
  GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);
  GOOGLE_CONFIG.private_key = GOOGLE_CONFIG.private_key.replace(/\\n/g, "\n");
} catch (err) {
  console.error("❌ Erro ao carregar GOOGLE_CONFIG", err);
  process.exit(1);
}

const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email,
  null,
  GOOGLE_CONFIG.private_key,
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

// =============================
@@ -151,60 +161,73 @@ async function criarEventoGoogleCalendar(nome, dataStr, horaInicio, duracaoMinut
      end: { dateTime: endDate.toISOString(), timeZone: "America/Sao_Paulo" }
    };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event
    });

    console.log("✅ Evento criado com sucesso!");

    return { success: true, link: response.data.htmlLink };

  } catch (err) {
    console.error("❌ Erro ao criar evento:", err.message);
    return { success: false, message: err.message };
  }
}

// =============================
// GEMINI
// =============================
async function gerarRespostaGemini(agendaHoje, pergunta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  try {
    const prompt = [
      "Você é um assistente de agendamento para um estúdio fotográfico.",
      "Responda sempre em português do Brasil.",
      "Use a agenda abaixo como fonte da disponibilidade de hoje:",
      agendaHoje,
      "Pergunta do cliente:",
      pergunta
    ].join("\n\n");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: pergunta }] }]
        contents: [{ role: "user", parts: [{ text: prompt }] }]
      })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("❌ Gemini retornou erro:", data);
      return "Tive um problema na minha inteligência agora. Pode repetir?";
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Pode repetir?";

  } catch (err) {
    console.error("❌ Erro Gemini:", err.message);
    return "Erro na IA.";
  }
}

// =============================
// WEBHOOK TELEGRAM
// =============================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const msg = req.body?.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const texto = msg.text;

  try {
    const agenda = await buscarAgendaHoje();
    const resposta = await gerarRespostaGemini(agenda, texto);

    await sendMessage(chatId, resposta);
