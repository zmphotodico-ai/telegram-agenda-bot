import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CALENDAR_ID = "zmphoto@zmphoto.com.br";

// Google Calendar Config
let GOOGLE_CONFIG;
try {
  if (!process.env.GOOGLE_CONFIG) throw new Error("GOOGLE_CONFIG não definida");
  GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG.trim());
  if (GOOGLE_CONFIG.private_key) {
    GOOGLE_CONFIG.private_key = GOOGLE_CONFIG.private_key.replace(/\\n/g, "\n");
  }
} catch (err) {
  console.error("❌ Erro fatal no GOOGLE_CONFIG:", err.message);
  process.exit(1);
}

const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email,
  null,
  GOOGLE_CONFIG.private_key,
  ["https://www.googleapis.com/auth/calendar"]
);

const calendar = google.calendar({ version: "v3", auth });

// Buscar agenda de hoje
async function buscarAgendaHoje() {
  try {
    const inicio = new Date();
    inicio.setHours(0, 0, 0, 0);
    const fim = new Date();
    fim.setHours(23, 59, 59, 999);
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: inicio.toISOString(),
      timeMax: fim.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      timeZone: "America/Sao_Paulo",
    });
    const eventos = res.data.items || [];
    if (eventos.length === 0) return "Hoje a agenda está **livre**!";
    return eventos
      .map(e => {
        const start = new Date(e.start.dateTime || e.start.date);
        const hora = start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
        return `• ${e.summary || "Sem título"} às ${hora}`;
      })
      .join("\n");
  } catch (err) {
    console.error("ERRO GOOGLE CALENDAR:", err.message, err.stack);
    return "Não consegui consultar a agenda agora.";
  }
}

// Enviar mensagem Telegram com retry
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      });
      if (res.ok) return true;
      console.warn(`Telegram falhou tentativa ${i}: ${await res.text()}`);
      await new Promise(r => setTimeout(r, 800 * i));
    } catch (err) {
      console.error("Erro sendMessage:", err);
    }
  }
  return false;
}

// Gemini - prompt corrigido sem backticks internos
async function gerarRespostaGemini(agendaHoje, pergunta) {
  const MODEL = "gemini-1.5-flash"; // Use 1.5-flash para mais estabilidade (2.5 pode ser instável ou não existir)
  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  
  const systemPrompt = `
Você é assistente de agendamento do fotógrafo Dionizio.
Respostas: educadas, curtas, em português do Brasil.
Agenda hoje:
${agendaHoje}

Regras importantes:
- Perguntas sobre agenda → mostre horários ou diga se está livre
- Para agendar → peça data (DD/MM), hora aproximada (HH:MM), nome da pessoa e tipo de sessão (ex: ensaio newborn, família, gestante)
- NUNCA invente horários livres nem crie evento sem confirmação
- Quando o cliente fornecer TODAS as informações e confirmar que quer agendar → responda com uma mensagem amigável confirmando + no FINAL da resposta coloque EXATAMENTE isso:

CONFIRMAR AGENDAMENTO:
```json
{
  "nome": "Nome Sobrenome",
  "data": "2026-02-28",
  "hora_inicio": "14:30",
  "duracao_minutos": 60,
  "tipo_sessao": "Ensaio newborn",
  "telefone": "(opcional)"
}
