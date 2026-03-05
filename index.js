import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CALENDAR_ID = "zmphoto@zmphoto.com.br";

// 1. Configuração Segura do Google
let GOOGLE_CONFIG;
try {
  GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);
  GOOGLE_CONFIG.private_key = GOOGLE_CONFIG.private_key.replace(/\\n/g, "\n");
} catch (err) {
  console.error("❌ Erro no GOOGLE_CONFIG. Verifique as variáveis no Railway.");
  process.exit(1);
}

const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email, null, GOOGLE_CONFIG.private_key,
  ["https://www.googleapis.com/auth/calendar"]
);
const calendar = google.calendar({ version: "v3", auth });

// 2. Buscar Agenda
async function buscarAgendaHoje() {
  try {
    const inicio = new Date(); inicio.setHours(0, 0, 0, 0);
    const fim = new Date(); fim.setHours(23, 59, 59, 999);
    
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID, timeMin: inicio.toISOString(), timeMax: fim.toISOString(),
      singleEvents: true, orderBy: "startTime", timeZone: "America/Sao_Paulo",
    });
    
    const eventos = res.data.items || [];
    if (eventos.length === 0) return "Hoje a agenda está TOTALMENTE LIVRE das 08h às 18h.";
    
    const ocupados = eventos.map(e => {
      const start = new Date(e.start.dateTime || e.start.date);
      const hora = start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
      return `• Ocupado às ${hora} (${e.summary || "Ensaio"})`;
    }).join("\n");
    
    return `Horários ocupados:\n${ocupados}\n\nATENÇÃO: Qualquer horário comercial que não estiver listado acima está LIVRE.`;
  } catch (err) {
    return "Não consegui consultar a agenda agora.";
  }
}

// 3. Enviar Mensagem Telegram
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      });
      if (res.ok) return true;
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {}
  }
  return false;
}

// 4. Criar Evento no Google Calendar
async function criarEventoGoogleCalendar(nome, dataStr, horaInicio, duracaoMinutos, tipoSessao) {
  try {
    const [ano, mes, dia] = dataStr.split("-");
    const [hora, minuto] = horaInicio.split(":");
    
    // Configura o fuso horário de São Paulo corretamente
    const startDate = new Date(`${ano}-${mes}-${dia}T${hora}:${minuto}:00-03:00`);
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60 * 1000);

    const event = {
      summary: `${tipoSessao} - ${nome}`,
      start: { dateTime: startDate.toISOString(), timeZone: "America/Sao_Paulo" },
      end: { dateTime: endDate.toISOString(), timeZone: "America/Sao_Paulo" },
    };

    const response = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
    return { success: true, link: response.data.htmlLink };
  } catch (err) {
    console.error("ERRO AO CRIAR EVENTO:", err);
    return { success: false };
  }
}

// 5. Inteligência Artificial
async function gerarRespostaGemini(agendaHoje, pergunta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  
  // O prompt agora está totalmente limpo, sem conversas extras
  const systemPrompt = `Você é o assistente de agendamento do fotógrafo Dionizio.
Responda de forma curta, educada e direta.

AGENDA DE HOJE:
${agendaHoje}

REGRAS OBRIGATÓRIAS:
1. Responda dúvidas sobre horários baseando-se na agenda acima.
2. Para agendar, peça: Data (AAAA-MM-DD), Hora exata, Nome e Tipo de Sessão.
3. QUANDO O CLIENTE CONFIRMAR ESTES 4 DADOS, adicione OBRIGATORIAMENTE o bloco de código abaixo no final da sua resposta para o sistema processar.

\`\`\`json
{
  "nome": "Nome do Cliente",
  "data": "AAAA-MM-DD",
  "hora_inicio": "HH:MM",
  "duracao_minutos": 60,
  "tipo_sessao": "Tipo do Ensaio"
}
\`\`\``;

  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\nCliente diz: " + pergunta }] }],
        generationConfig: { temperature: 0.2 } // Baixa temperatura para ele não errar o formato do JSON
      }),
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Pode repetir?";
  } catch (err) {
    return "Estou com instabilidade, me chame em um minuto.";
  }
}

// 6. Webhook
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  
  const msg = req.body?.message;
  if (!msg?.text || !msg?.chat?.id) return;
  
  const chatId = msg.chat.id;

  try {
    const agenda = await buscarAgendaHoje();
    let resposta = await gerarRespostaGemini(agenda, msg.text);

    // O "Detetive" que procura a ordem de agendamento na resposta da IA
    const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/);
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        const dados = JSON.parse(jsonMatch[1].trim());
        
        // Removemos o bloco JSON de código da resposta para o cliente não ver
        resposta = resposta.replace(/```json\s*([\s\S]*?)\s*```/, "").trim();
        await sendMessage(chatId, "⏳ Entendido! Estou registrando seu horário na agenda do Dionizio...");

        const resultado = await criarEventoGoogleCalendar(dados.nome, dados.data, dados.hora_inicio, dados.duracao_minutos, dados.tipo_sessao);

        if (resultado.success) {
          resposta += `\n\n✅ Agendamento salvo com sucesso para o dia ${dados.data} às ${dados.hora_inicio}!`;
        } else {
          resposta = "❌ Tive um problema técnico ao conectar com a agenda. Pode tentar novamente mais tarde?";
        }
      } catch (e) {
        console.error("Erro ao ler JSON da IA:", e);
      }
    }

    await sendMessage(chatId, resposta);
  } catch (err) {
    await sendMessage(chatId, "Problema técnico. Tente novamente.");
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor ATIVO na porta ${PORT}`));
