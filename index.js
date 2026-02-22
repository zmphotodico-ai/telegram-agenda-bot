import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CALENDAR_ID = "zmphoto@zmphoto.com.br";
const TIMEZONE = "America/Sao_Paulo";

// Google Config
let GOOGLE_CONFIG;
try {
  GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);
  GOOGLE_CONFIG.private_key = GOOGLE_CONFIG.private_key.replace(/\\n/g, "\n");
} catch (err) {
  console.error("❌ GOOGLE_CONFIG inválido:", err.message);
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
      timeZone: TIMEZONE,
    });
    const eventos = res.data.items || [];
    if (eventos.length === 0) return "Hoje a agenda está **livre** (das 08:00 às 18:00 assumindo horário comercial)!";
    return eventos
      .map(e => {
        const start = new Date(e.start.dateTime || e.start.date);
        const end = new Date(e.end.dateTime || e.end.date);
        const horaInicio = start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE });
        const horaFim = end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE });
        return `• ${e.summary || "Sem título"} das ${horaInicio} às ${horaFim}`;
      })
      .join("\n");
  } catch (err) {
    console.error("Erro ao buscar agenda:", err?.message || err);
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
    } catch (err) {}
  }
  return false;
}

// Gemini
async function gerarRespostaGemini(agendaHoje, pergunta) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  const systemPrompt = `
Você é assistente de agendamento do fotógrafo Dionizio.
Respostas: educadas, curtas, em português do Brasil.
Agenda hoje:
${agendaHoje}

Regras:
- Perguntas sobre agenda → mostre horários ocupados ou diga se livre.
- Para agendar: peça data (DD/MM/AAAA), hora exata (HH:MM), nome completo, tipo de ensaio (ex: newborn, família, corporativo).
- NUNCA invente horários.
- Quando o cliente fornecer TODOS os dados e **confirmar** (ex: "sim", "confirma", "pode marcar") → responda com mensagem amigável + NO FINAL EXATAMENTE:

[CRIAR_EVENTO]
{
  "data_hora_iso": "2026-02-23T14:30:00",
  "nome": "Maria Silva",
  "tipo": "Ensaio newborn",
  "duracao_min": 90
}

- Se faltar info ou sem confirmação → pergunte e NÃO inclua o bloco acima.
- Use temperatura baixa para precisão.`;
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: systemPrompt + "\nCliente: " + pergunta.trim() }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 400 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Desculpe, erro na IA. Repita?";
  } catch (err) {
    console.error("Gemini erro:", err.message);
    return "Problema com a IA agora. Tente novamente.";
  }
}

// Criar evento com verificação de conflito
async function criarEventoGoogleCalendar(dataHoraIso, nome, tipo = "Ensaio", duracaoMin = 60) {
  console.log("Tentando criar:", { dataHoraIso, nome, tipo, duracaoMin });
  try {
    const start = new Date(dataHoraIso);
    if (isNaN(start)) throw new Error("Data/hora inválida");
    const end = new Date(start.getTime() + duracaoMin * 60 * 1000);

    // Verifica conflito
    const check = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
    });
    if (check.data.items?.length > 0) {
      return { success: false, error: "Horário já ocupado!" };
    }

    const event = {
      summary: `${tipo} - ${nome}`,
      start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
      end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
    };

    const res = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
      sendUpdates: "none",
    });

    console.log("Criado! ID:", res.data.id);
    return { success: true, link: res.data.htmlLink };
  } catch (err) {
    console.error("Erro criar evento:", err?.errors || err.message);
    return { success: false, error: err?.message || "Erro desconhecido (verifique permissões)" };
  }
}

// Webhook
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update?.message?.text || !update.message.chat?.id) return;

  const chatId = update.message.chat.id;
  const text = update.message.text.trim();

  try {
    const agenda = await buscarAgendaHoje();
    let resposta = await gerarRespostaGemini(agenda, text);

    // Intercepta comando
    const match = resposta.match(/\[CRIAR_EVENTO\]\s*([\s\S]*)/);
    if (match && match[1]) {
      try {
        const jsonStr = match[1].trim();
        const dados = JSON.parse(jsonStr);
        console.log("Dados para criar:", dados);

        if (dados.data_hora_iso && dados.nome) {
          await sendMessage(chatId, "⏳ Registrando na agenda do Dionizio...");
          const resultado = await criarEventoGoogleCalendar(
            dados.data_hora_iso,
            dados.nome,
            dados.tipo,
            dados.duracao_min || 60
          );

          if (resultado.success) {
            await sendMessage(chatId, `✅ Agendado com sucesso!\n${dados.nome} - ${dados.tipo || "Ensaio"}\n${new Date(dados.data_hora_iso).toLocaleString("pt-BR", { timeZone: TIMEZONE })}\n\nObrigado!`);
          } else {
            await sendMessage(chatId, `❌ Problema: ${resultado.error}\nTente outro horário ou me avise.`);
          }
          return;
        }
      } catch (e) {
        console.error("Parse JSON falhou:", e);
      }
    }

    // Resposta normal
    await sendMessage(chatId, resposta);
  } catch (err) {
    console.error("Erro webhook:", err);
    await sendMessage(chatId, "Problema técnico. Tente novamente.");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
});
