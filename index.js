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

if (!process.env.GOOGLE_CONFIG) {
  console.error("❌ GOOGLE_CONFIG não encontrada");
} else {
  try {
    GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG.trim());
    if (GOOGLE_CONFIG.private_key) {
      GOOGLE_CONFIG.private_key = GOOGLE_CONFIG.private_key.replace(/\\n/g, "\n");
    }
  } catch (err) {
    console.error("❌ Erro ao parsear GOOGLE_CONFIG:", err.message);
  }
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
    console.error("ERRO GOOGLE CALENDAR COMPLETO:", err);
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
    } catch {}
  }
  return false;
}

// Gemini - com retry e log melhor
async function gerarRespostaGemini(agendaHoje, pergunta) {
  const MODEL = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  const systemPrompt = `
Você é assistente de agendamento do fotógrafo Dionizio.
- Quando o cliente confirmar o agendamento, você DEVE obrigatoriamente gerar o bloco:

CONFIRMAR AGENDAMENTO:
```json
{
 "nome": "...",
 "data": "...",
 "hora_inicio": "...",
 "duracao_minutos": 60,
 "tipo_sessao": "..."
}
Respostas: educadas, curtas, em português do Brasil.
Agenda hoje:
${agendaHoje}

Regras importantes:
- Perguntas sobre agenda → mostre horários ou diga se está livre
- Para agendar → peça data (DD/MM), hora aproximada (HH:MM), nome da pessoa e tipo de sessão (ex: ensaio newborn, família, gestante)
- NUNCA invente horários livres nem crie evento sem confirmação
- Quando o cliente fornecer TODAS as informações e confirmar que quer agendar → responda com uma mensagem amigável confirmando + no FINAL da resposta coloque EXATAMENTE isso:

CONFIRMAR AGENDAMENTO:
\`\`\`json
{
  "nome": "Nome Sobrenome",
  "data": "2026-02-28",
  "hora_inicio": "14:30",
  "duracao_minutos": 60,
  "tipo_sessao": "Ensaio newborn",
  "telefone": "(opcional)"
}
\`\`\`

- Se faltar alguma informação → pergunte gentilmente e NÃO coloque o bloco JSON
- Mantenha as respostas naturais, o JSON é só para o robô processar
`;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      console.log(`Gemini tentativa ${tentativa} | ${pergunta.substring(0, 60)}...`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: systemPrompt + "\nCliente: " + pergunta.trim() }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 400 },
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`Gemini HTTP ${res.status}: ${err}`);
        if (res.status === 429) return "Muitos pedidos agora. Tente novamente em 1 minuto.";
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const texto = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (texto) {
        console.log("Gemini OK");
        return texto;
      }
      console.warn("Gemini retornou vazio");
    } catch (err) {
      console.error("Gemini erro:", err.message);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return "Desculpe, não consegui processar agora. Pode repetir a pergunta?";
}

// Função para criar evento
async function criarEventoGoogleCalendar(nome, data, horaInicio, duracaoMinutos, tipoSessao, telefone = "") {
  console.log("Tentando criar evento com dados:", { nome, data, horaInicio, duracaoMinutos, tipoSessao });
  try {
    // Montar data/hora em ISO com timezone America/Sao_Paulo
    const [ano, mes, dia] = data.split("-");
    const [hora, minuto] = horaInicio.split(":");
    
    const startDate = new Date(Date.UTC(ano, mes-1, dia, hora, minuto, 0));
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60 * 1000);

    const event = {
      summary: `${tipoSessao} - ${nome}`,
      description: `Cliente: ${nome}\nTelefone: ${telefone || "não informado"}`,
      start: {
        dateTime: startDate.toISOString(),
        timeZone: "America/Sao_Paulo",
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: "America/Sao_Paulo",
      },
      // Opcional: adicionar lembretes
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 1440 }, // 1 dia antes
          { method: "popup", minutes: 60 },   // 1 hora antes
        ],
      },
    };

    console.log("Chamando calendar.events.insert com calendarId:", CALENDAR_ID);
    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
      sendUpdates: "none", // "none" para não enviar emails indesejados durante testes
    });
    
    console.log("SUCESSO! Evento criado - ID:", response.data.id, "Link:", response.data.htmlLink);
    return {
      success: true,
      link: response.data.htmlLink,
      id: response.data.id,
    };
  } catch (err) {
    console.error("ERRO AO CRIAR EVENTO:", {
      message: err.message,
      code: err.code,
      errors: err.errors,
      details: err.details || err.result?.error
    });
    return { success: false, error: err?.message || "Erro desconhecido" };
  }
}

// Webhook
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update?.message?.chat?.id || !update.message.text) return;
  const chatId = update.message.chat.id;
  const text = update.message.text.trim();
  if (text.length > 800) {
    await sendMessage(chatId, "Mensagem longa demais 😅 Pode ser mais curta?");
    return;
  }
  try {
    const agenda = await buscarAgendaHoje();
    let resposta = await gerarRespostaGemini(agenda, text);

    // ────────────────────────────────────────────────
    // Tenta extrair o bloco JSON de confirmação
    // ────────────────────────────────────────────────
    const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch && jsonMatch[1]) {
      console.log("Bloco JSON detectado no Gemini:", jsonMatch[1]);
      try {
        const dados = JSON.parse(jsonMatch[1].trim());
        console.log("Dados parseados:", dados);

        if (dados.nome && dados.data && dados.hora_inicio && dados.duracao_minutos) {
          const resultado = await criarEventoGoogleCalendar(
            dados.nome,
            dados.data,
            dados.hora_inicio,
            dados.duracao_minutos,
            dados.tipo_sessao || "Sessão",
            dados.telefone
          );

          if (resultado.success) {
            resposta = `Agendamento confirmado com sucesso! 🎉\n\n${dados.nome} - ${dados.tipo_sessao || "Sessão"}\nData: ${dados.data} às ${dados.hora_inicio}\n\nObrigado pela confiança!`;
            // Opcional: enviar o link do evento
            // resposta += `\nLink: ${resultado.link}`;
          } else {
            resposta = `Ops... deu algum problema ao salvar na agenda: ${resultado.error}\n\nPode tentar novamente ou me chamar no WhatsApp?`;
          }
        }
      } catch (e) {
        console.error("Falha ao parsear JSON do Gemini:", e.message, "Conteúdo bruto:", jsonMatch[1]);
        // continua com a resposta original se der erro no parse
      }
    }

    await sendMessage(chatId, resposta);
  } catch (err) {
    console.error("Erro principal:", err);
    await sendMessage(chatId, "Problema técnico. Tente novamente daqui a pouco.");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Rodando na porta ${PORT}`);
  console.log(`Webhook: https://api.telegram.org/bot${TOKEN}/setWebhook?url=${process.env.RAILWAY_PUBLIC_DOMAIN || "SEU-DOMINIO"}/webhook`);
});
