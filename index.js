import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CALENDAR_ID = "zmphoto@zmphoto.com.br";

// ====================== Google Calendar Config ======================
let GOOGLE_CONFIG;
try {
  GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);
  GOOGLE_CONFIG.private_key = GOOGLE_CONFIG.private_key.replace(/\\n/g, "\n");
} catch (err) {
  console.error("❌ GOOGLE_CONFIG inválido ou mal formatado:", err.message);
  process.exit(1);
}

const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email,
  null,
  GOOGLE_CONFIG.private_key,
  ["https://www.googleapis.com/auth/calendar"]  // leitura + escrita
);

const calendar = google.calendar({ version: "v3", auth });

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

    if (eventos.length === 0) {
      return "Hoje a agenda está **completamente livre**!";
    }

    return eventos
      .map((e) => {
        const start = new Date(e.start.dateTime || e.start.date);
        const hora = start.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Sao_Paulo",
        });
        return `• ${e.summary || "Evento sem título"} às ${hora}`;
      })
      .join("\n");
  } catch (err) {
    console.error("Erro ao consultar agenda:", err?.message || err);
    return "Não consegui acessar a agenda agora. Tente novamente mais tarde.";
  }
}

async function criarEvento(summary, startDateTime, durationMinutes = 60, description = "") {
  try {
    const start = new Date(startDateTime);
    if (isNaN(start.getTime())) throw new Error("Data/hora inválida");

    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    const event = {
      summary: summary.trim(),
      description: description.trim() || undefined,
      start: { dateTime: start.toISOString(), timeZone: "America/Sao_Paulo" },
      end: { dateTime: end.toISOString(), timeZone: "America/Sao_Paulo" },
    };

    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
      sendUpdates: "all",  // envia email se tiver participantes
    });

    return {
      success: true,
      link: res.data.htmlLink,
      startFormatted: start.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
    };
  } catch (err) {
    console.error("Erro ao criar evento:", err?.response?.data || err.message);
    return { success: false, error: err.message || "Falha ao criar agendamento" };
  }
}

// ====================== Telegram Helper ======================
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) return true;

      const errText = await res.text();
      console.warn(`Telegram falhou (tentativa ${tentativa}): ${res.status} - ${errText}`);
      await new Promise(r => setTimeout(r, 700 * tentativa));
    } catch (err) {
      console.error("Erro ao tentar enviar mensagem:", err);
    }
  }

  console.error(`Falha definitiva ao enviar mensagem para chat ${chatId}`);
  return false;
}

// ====================== Gemini (atualizado 2026) ======================
async function gerarRespostaGemini(agendaHoje, perguntaUsuario) {
  const MODEL = "gemini-2.5-flash";  // estável e recomendado em fev/2026
  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;

  console.log(`→ Gemini chamado | Modelo: ${MODEL} | Pergunta: ${perguntaUsuario.substring(0, 80)}...`);

  const systemPrompt = `
Você é o assistente de agendamento do fotógrafo Dionizio.
Tom: educado, profissional, simpático, respostas curtas e claras (máximo 4-5 linhas).

Agenda de hoje:
${agendaHoje}

Regras importantes:
- Se for pergunta sobre AGENDAR / MARCAR / RESERVAR → peça data, horário desejado e nome completo do cliente
- Só sugira ou confirme agendamento se a agenda permitir (não invente horários livres)
- Sempre peça confirmação antes de criar: "Posso agendar [resumo] para [data/hora]?"
- Se for criar → use a função de criação e informe o link do Google Calendar
- Responda em português brasileiro natural
- Se não entender ou faltar informação → pergunte gentilmente
- NUNCA prometa horários sem consultar a agenda real
`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: systemPrompt + "\n\nMensagem do cliente: " + perguntaUsuario.trim() }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 350,
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`Gemini HTTP ${res.status}: ${errBody}`);
      throw new Error(`Gemini retornou ${res.status}`);
    }

    const data = await res.json();
    const resposta = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!resposta) {
      throw new Error("Resposta vazia do Gemini");
    }

    console.log("← Gemini respondeu OK");
    return resposta;
  } catch (err) {
    console.error("Gemini erro:", err.message || err);
    return "Desculpe, estou com um probleminha técnico agora. Pode tentar novamente em alguns instantes? 😅";
  }
}

// ====================== Webhook Principal ======================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Resposta rápida obrigatória pro Telegram

  const update = req.body;
  if (!update?.message?.chat?.id || !update.message.text) return;

  const chatId = update.message.chat.id;
  const text = update.message.text.trim();

  if (text.length > 1200) {
    await sendMessage(chatId, "Mensagem muito longa 😅 Pode resumir um pouco?");
    return;
  }

  try {
    const agenda = await buscarAgendaHoje();
    const resposta = await gerarRespostaGemini(agenda, text);

    await sendMessage(chatId, resposta);
  } catch (err) {
    console.error("Erro no fluxo principal:", err);
    await sendMessage(chatId, "Ocorreu um erro inesperado. Tente novamente mais tarde, por favor.");
  }
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`Configure o webhook no Telegram com:`);
  console.log(`https://api.telegram.org/bot${TOKEN}/setWebhook?url=https://SEU-DOMINIO-RAILWAY/webhook`);
  console.log("Dica: adicione &secret_token=SEU_SEGREDO para mais segurança depois");
});
