import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// ====================== Google Calendar Config ======================
let GOOGLE_CONFIG;
try {
  GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);
  GOOGLE_CONFIG.private_key = GOOGLE_CONFIG.private_key.replace(/\\n/g, "\n");
} catch (err) {
  console.error("❌ GOOGLE_CONFIG inválido:", err);
  process.exit(1);
}

const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email,
  null,
  GOOGLE_CONFIG.private_key,
  ["https://www.googleapis.com/auth/calendar"]   // ← leitura + escrita
);

const calendar = google.calendar({ version: "v3", auth });
const CALENDAR_ID = "zmphoto@zmphoto.com.br";

// ====================== Funções Google Calendar ======================

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

    if (eventos.length === 0) return "Hoje a agenda está completamente livre.";

    return eventos
      .map((e) => {
        const start = new Date(e.start.dateTime || e.start.date);
        const hora = start.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Sao_Paulo",
        });
        return `• ${e.summary || "Sem título"} às ${hora}`;
      })
      .join("\n");
  } catch (err) {
    console.error("Erro ao ler agenda:", err?.message || err);
    return "Não consegui consultar a agenda agora. Tente novamente mais tarde.";
  }
}

async function criarEvento(summary, startDateTime, durationMinutes = 60, description = "") {
  try {
    const start = new Date(startDateTime);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    const event = {
      summary: summary.trim(),
      description: description.trim() || undefined,
      start: {
        dateTime: start.toISOString(),
        timeZone: "America/Sao_Paulo",
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: "America/Sao_Paulo",
      },
      // Opcional: reminders, attendees, conferenceData, etc.
    };

    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
      sendUpdates: "all",           // envia email se tiver attendees
      // conferenceDataVersion: 1,  // descomente se quiser Google Meet automático
    });

    return {
      success: true,
      link: res.data.htmlLink,
      start: start.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    };
  } catch (err) {
    console.error("Erro ao criar evento:", err?.response?.data || err);
    return { success: false, error: err?.message || "Erro desconhecido" };
  }
}

// ====================== Telegram helper ======================
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      });

      if (res.ok) return true;

      const errText = await res.text();
      console.warn(`Telegram falhou (tent ${tentativa}): ${errText}`);
      await new Promise(r => setTimeout(r, 800 * tentativa));
    } catch (err) {
      console.error("Falha total ao enviar msg:", err);
    }
  }
  return false;
}

// ====================== Gemini ======================
async function gerarRespostaComGemini(agendaHoje, perguntaUsuario, chatId) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

  const systemPrompt = `
Você é o assistente de agendamento do fotógrafo Dionizio.
Tom: educado, profissional, direto, simpático, respostas curtas (máximo 4 linhas).

Agenda de hoje:
${agendaHoje}

Instruções importantes:
- Se o cliente quer AGENDAR / MARCAR / RESERVAR → peça data, horário aproximado e nome completo
- Só crie evento se o usuário fornecer: data + horário + nome (ou algo muito claro)
- Formato de data/hora aceito: "dia/mês às hh:mm", "amanhã 14h", "próxima quarta 09:30"
- Sempre confirme antes de criar: "Posso agendar [resumo] para [data/hora]?"
- Se criar → informe o link do Google Calendar
- NUNCA invente horários ou prometa disponibilidade sem consultar a agenda
- Se dúvida → pergunte gentilmente mais detalhes
- Responda em português do Brasil
`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: systemPrompt + "\n\nMensagem do cliente: " + perguntaUsuario }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 300,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
           "Desculpe, não consegui gerar uma resposta agora.";
  } catch (err) {
    console.error("Gemini erro:", err);
    return "Opa, tive um probleminha técnico. Pode mandar novamente?";
  }
}

// ====================== Webhook principal ======================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Telegram exige resposta rápida

  const update = req.body;
  if (!update?.message?.chat?.id || !update.message.text) return;

  const chatId = update.message.chat.id;
  const text = update.message.text.trim();

  // Ignora comandos muito longos / spam
  if (text.length > 1200) {
    await sendMessage(chatId, "Mensagem muito longa 😅 Pode ser mais breve?");
    return;
  }

  try {
    const agenda = await buscarAgendaHoje();
    const resposta = await gerarRespostaComGemini(agenda, text, chatId);

    await sendMessage(chatId, resposta);
  } catch (err) {
    console.error("Erro no fluxo principal:", err);
    await sendMessage(chatId, "Desculpe, aconteceu algo inesperado. Tente novamente daqui a pouco?");
  }
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`🚀 Bot rodando na porta ${PORT}`);
  console.log("Não esqueça de configurar o webhook no Telegram:");
  console.log(`https://api.telegram.org/bot${TOKEN}/setWebhook?url=https://seu-dominio.com/webhook`);
});
