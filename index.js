import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

// =============================
// VALIDAÇÃO DE VARIÁVEIS
// =============================
const REQUIRED_ENV = ["BOT_TOKEN", "GEMINI_API_KEY", "GOOGLE_CONFIG"];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`❌ Variáveis obrigatórias ausentes: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CALENDAR_ID = "alugueldeestudiofotografico@gmail.com";
const LINK_AGENDA = "https://calendar.google.com/calendar/embed?src=alugueldeestudiofotografico%40gmail.com&ctz=America%2FSao_Paulo";
const PDF_INFORMATIVO = "https://drive.google.com/file/d/1J8FC6mzmfkOhlHbRrKVLN92jYj9LF1bb/view?usp=sharing";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8132670973";
const TIMEZONE = "America/Sao_Paulo";

const MEMORY_LIMIT = 10;

// =============================
// MEMÓRIA E TIMERS
// =============================
const conversationMemory = new Map();
const timersCobranca = new Map();

// =============================
// GOOGLE CALENDAR
// =============================
let calendar;
try {
  const googleConfig = JSON.parse(process.env.GOOGLE_CONFIG);
  const privateKey = googleConfig.private_key?.replace(/\\n/g, "\n");

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: googleConfig.client_email, private_key: privateKey },
    projectId: googleConfig.project_id,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  calendar = google.calendar({ version: "v3", auth });
  console.log("✅ Google Calendar conectado com sucesso");
} catch (err) {
  console.error("❌ Erro ao configurar Google Calendar:", err);
  process.exit(1);
}

// =============================
// FUNÇÕES TELEGRAM
// =============================
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postTelegram(method, payload, retries = 2) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
    } catch (error) {
      console.error(`Telegram erro (tentativa ${attempt}):`, error.message);
    }
    if (attempt <= retries) await delay(600 * attempt);
  }
  return false;
}

async function sendMessage(chatId, text) {
  if (!text?.trim()) return;
  await postTelegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });
}

async function sendAdminNotification(text) {
  if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, `🕵️ *MODO ESPIÃO*\n${text}`);
}

// =============================
// COBRANÇA E CANCELAMENTO AUTOMÁTICO
// =============================
function gerenciarReguaDeCobranca(chatId, acao, eventId = null) {
  if (acao === "PARAR") {
    const timers = timersCobranca.get(chatId);
    if (timers) {
      clearTimeout(timers.t6);
      clearTimeout(timers.t12);
      clearTimeout(timers.t24);
      timersCobranca.delete(chatId);
    }
    return;
  }

  gerenciarReguaDeCobranca(chatId, "PARAR");

  timersCobranca.set(chatId, {
    t6: setTimeout(() => sendMessage(chatId, "Olá! Ainda não recebemos o sinal da sua reserva. O horário segue pré-reservado por enquanto. 👍"), 6 * 3600 * 1000),
    t12: setTimeout(() => sendMessage(chatId, "Ainda tem interesse no horário? Precisamos do sinal para não liberar a data para outro cliente."), 12 * 3600 * 1000),
    t24: setTimeout(async () => {
      await sendMessage(chatId, "⚠️ O prazo para o sinal expirou e sua pré-reserva foi cancelada automaticamente.\nCaso queira reagendar, é só me chamar!");

      if (eventId) {
        try {
          await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
          console.log(`Evento ${eventId} cancelado automaticamente.`);
          await sendAdminNotification(`🗑️ Cancelamento automático: Evento removido da agenda por falta de pagamento em 24h.`);
        } catch (err) {
          console.error("Erro ao deletar evento automaticamente:", err.message);
        }
      }
      timersCobranca.delete(chatId);
    }, 24 * 3600 * 1000),
  });
}

// =============================
// VALIDAÇÃO
// =============================
function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(new Date(`${date}T00:00:00-03:00`).getTime());
}

function isValidHour(hour) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(hour);
}

function normalizeBookingPayload(raw) {
  if (!raw || typeof raw !== "object") return null;

  const data = {
    nome: String(raw.nome || "").trim(),
    data: String(raw.data || "").trim(),
    hora_inicio: String(raw.hora_inicio || "").trim(),
    duracao_minutos: Number(raw.duracao_minutos),
    tipo_sessao: String(raw.tipo_sessao || "").trim(),
    estudio: String(raw.estudio || "").trim().toUpperCase(),
    qtd_pessoas: Number(raw.qtd_pessoas || 2),
  };

  if (!data.nome || !data.data || !data.hora_inicio || !data.tipo_sessao || !data.estudio) return null;
  if (!isValidDate(data.data) || !isValidHour(data.hora_inicio)) return null;
  if (!Number.isInteger(data.duracao_minutos) || data.duracao_minutos < 60) return null;

  return data;
}

// =============================
// AGENDA E EVENTOS
// =============================
async function buscarAgendaSemana() {
  try {
    const inicio = new Date();
    inicio.setHours(0, 0, 0, 0);
    const fim = new Date(inicio.getTime() + 7 * 24 * 60 * 60 * 1000);
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
    if (eventos.length === 0) return "A agenda dos próximos 7 dias está totalmente livre.";

    const lista = eventos.map((ev) => {
      const start = new Date(ev.start.dateTime || ev.start.date);
      return `• ${start.toLocaleDateString("pt-BR")} às ${start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} → ${ev.summary}`;
    }).join("\n");

    return `Ocupações dos próximos 7 dias:\n${lista}\n\nO que não aparece na lista está LIVRE.`;
  } catch (err) {
    console.error("Erro ao buscar agenda:", err);
    return "Não consegui consultar a agenda no momento.";
  }
}

async function verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos, estudioAlvo) {
  try {
    const start = new Date(`${dataStr}T${horaInicio}:00-03:00`);
    const end = new Date(start.getTime() + duracaoMinutos * 60000);

    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      timeZone: TIMEZONE,
    });

    return !(res.data.items || []).some(ev => (ev.summary || "").includes(`/${estudioAlvo}`));
  } catch {
    return false;
  }
}

async function criarEventoGoogleCalendar(dados) {
  try {
    const disponivel = await verificarDisponibilidade(dados.data, dados.hora_inicio, dados.duracao_minutos, dados.estudio);
    if (!disponivel) return { success: false, message: `Estúdio ${dados.estudio} ocupado nesse horário.` };

    const start = new Date(`${dados.data}T${dados.hora_inicio}:00-03:00`);
    const end = new Date(start.getTime() + dados.duracao_minutos * 60000);
    const horaFim = end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    const cores = { A: "1", B: "2", AB: "3", C: "4", D: "5", "1": "6", "2": "7", "3": "10" };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: {
        summary: `${dados.hora_inicio}-${horaFim} /${dados.estudio}`,
        description: `Cliente: ${dados.nome}\nEstúdio: ${dados.estudio}\nProdução: ${dados.tipo_sessao}\nPessoas: ${dados.qtd_pessoas}`,
        colorId: cores[dados.estudio] || "8",
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      },
    });

    return { success: true, eventId: response.data.id };
  } catch (err) {
    console.error("Erro criar evento:", err);
    return { success: false, message: "Erro interno ao salvar na agenda." };
  }
}

// =============================
// GEMINI (O "CÉREBRO")
// =============================
async function gerarRespostaGemini(chatId, agendaSemana, pergunta) {
  const model = "gemini-2.5-flash"; 
  const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_KEY}`;

  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: TIMEZONE });

  const promptSistema = `Você é o assistente da Zemaria Produções Fotográficas. Responda de forma CURTA, clara e profissional.

Endereços: Aclimação (Rua Gualaxos 206) | Bela Vista (Rua Santa Madalena 46).

PREÇOS (mín. 2h seg-sex / 3-4h fins de semana):
- Aclimação: 1-2p R$70/h | 3-5p R$80/h | 6-8p R$100/h (A+B +R$30/h)
- Bela Vista: Est.1 R$70/h | Est.2 R$50/h | Est.3 R$60/h
- Diária 12h: cobre 10h efetivas
- >8 pessoas ou madrugadas: Sob consulta (WhatsApp 11 995540293)

Peça 1/3 de sinal via PIX CNPJ 43.345.289/0001-93.

Hoje: ${hoje}
Agenda próxima semana:\n${agendaSemana}
PDF informativo: ${PDF_INFORMATIVO}
Agenda completa: ${LINK_AGENDA}

Só gere o bloco JSON no FINAL quando o cliente confirmar TODOS os dados (nome, estúdio, data, hora, duração, tipo e pessoas).
Use EXATAMENTE este formato abaixo para o JSON:
\`\`\`json
{
  "nome": "Nome do Cliente",
  "data": "2026-05-20",
  "hora_inicio": "14:00",
  "duracao_minutos": 120,
  "tipo_sessao": "Ensaio Fotográfico",
  "estudio": "A",
  "qtd_pessoas": 3
}
\`\`\``;

  let history = conversationMemory.get(chatId) || [];
  history.push(`Cliente: ${pergunta}`);
  if (history.length > MEMORY_LIMIT) history = history.slice(-MEMORY_LIMIT);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${promptSistema}\n\nHistórico:\n${history.join("\n")}` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
      }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      console.error("Erro Gemini:", data.error);
      return "Desculpe, estou com dificuldade agora. Pode repetir?";
    }

    let resposta = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Não entendi, pode repetir?";

    const cleanReply = resposta.replace(/```json[\s\S]*?```/i, "").trim();
    if (cleanReply) {
      history.push(`Assistente: ${cleanReply}`);
      conversationMemory.set(chatId, history);
    }

    return resposta;
  } catch (err) {
    console.error("Falha Gemini:", err);
    return "Minha conexão com a IA falhou. Tente novamente em alguns segundos.";
  }
}

// =============================
// WEBHOOK
// =============================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const texto = (msg.text || msg.caption || "").trim();
  const nomeUsuario = msg.from?.first_name || "Cliente";

  // 1. Detecção de pagamento/comprovante
  if (msg.photo || msg.document || /pago|comprovante|pix|transferência/i.test(texto)) {
    gerenciarReguaDeCobranca(chatId, "PARAR");
    await sendMessage(chatId, "✅ Recebido! Vou conferir o comprovante e confirmar sua reserva.");
    if (String(chatId) !== ADMIN_CHAT_ID) {
      await sendAdminNotification(`💰 *${nomeUsuario}* enviou comprovante!`);
    }
    return;
  }

  if (!texto) return;

  if (String(chatId) !== ADMIN_CHAT_ID) {
    await sendAdminNotification(`👤 *${nomeUsuario}*: ${texto}`);
  }

  const agendaSemana = await buscarAgendaSemana();
  let resposta = await gerarRespostaGemini(chatId, agendaSemana, texto);

  const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!jsonMatch) {
    await sendMessage(chatId, resposta);
    return;
  }

  resposta = resposta.replace(/```json[\s\S]*?```/i, "").trim();
  if (resposta) await sendMessage(chatId, resposta);

  let dados;
  try {
    dados = normalizeBookingPayload(JSON.parse(jsonMatch[1]));
  } catch {
    await sendMessage(chatId, "Não consegui ler os dados. Pode confirmar novamente?");
    return;
  }

  if (!dados) {
    await sendMessage(chatId, "Algum dado está incorreto ou incompleto. Pode confirmar data, hora e estúdio?");
    return;
  }

  await sendMessage(chatId, "Verificando disponibilidade... ⏳");

  const resultado = await criarEventoGoogleCalendar(dados);

  if (!resultado.success) {
    await sendMessage(chatId, `❌ ${resultado.message}`);
    return;
  }

  await sendMessage(chatId, `✅ *Pré-reserva realizada com sucesso!*\n\nEstúdio: ${dados.estudio}\nData: ${dados.data}\nHorário: ${dados.hora_inicio}\n\nAguardamos o sinal de 1/3 via PIX para confirmar definitivamente.`);

  gerenciarReguaDeCobranca(chatId, "INICIAR", resultado.eventId);
  conversationMemory.delete(chatId);

  if (String(chatId) !== ADMIN_CHAT_ID) {
    await sendAdminNotification(`🎉 *PRÉ-RESERVA:* ${dados.nome} - ${dados.estudio} - ${dados.data} ${dados.hora_inicio}`);
  }
});

// A LINHA SALVADORA!
app.listen(PORT, () => {
  console.log(`🚀 Bot Zemaria rodando na porta ${PORT}`);
});
