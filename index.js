import express from "express";
import { google } from "googleapis";

// 1. Validação Antecipada de Segurança
const { PORT = 3000, BOT_TOKEN, GEMINI_API_KEY, GOOGLE_CONFIG } = process.env;

if (!BOT_TOKEN || !GEMINI_API_KEY || !GOOGLE_CONFIG) {
  console.error("❌ ERRO CRÍTICO: Faltam variáveis de ambiente no Railway.");
  process.exit(1);
}

const app = express();
app.use(express.json());

// 2. Configuração do Google Calendar
const configGoogle = JSON.parse(GOOGLE_CONFIG);
const auth = new google.auth.JWT(
  configGoogle.client_email,
  null,
  configGoogle.private_key.replace(/\\n/g, "\n"),
  ["https://www.googleapis.com/auth/calendar.readonly"] 
);
const calendar = google.calendar({ version: "v3", auth });
const CALENDAR_ID = "zmphoto@zmphoto.com.br";
const TIMEZONE = "America/Sao_Paulo";

// Função utilitária para formatar hora (Mais segura que toLocaleTimeString)
const formatarHora = (dataString) => {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit"
  }).format(new Date(dataString));
};

// 3. Funções Principais
async function obterStatusAgenda() {
  const agora = new Date();
  const inicio = new Date(agora.setHours(0, 0, 0, 0)).toISOString();
  const fim = new Date(agora.setHours(23, 59, 59, 999)).toISOString();

  try {
    const { data } = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: inicio,
      timeMax: fim,
      singleEvents: true,
      orderBy: "startTime",
      timeZone: TIMEZONE,
    });

    const eventos = data.items || [];
    const baseRegras = "Expediente de trabalho: 08:00 às 18:00.\n";

    if (eventos.length === 0) {
      return `${baseRegras}A agenda está TOTALMENTE LIVRE hoje. Informe o cliente que ele pode escolher qualquer horário no expediente.`;
    }

    const listaOcupados = eventos.map(e => 
      `- ${formatarHora(e.start.dateTime || e.start.date)} até ${formatarHora(e.end.dateTime || e.end.date)}: [OCUPADO]`
    ).join("\n");

    return `${baseRegras}Horários BLOQUEADOS hoje:\n${listaOcupados}\n\nREGRAS PARA A IA: Todo o tempo que NÃO estiver bloqueado acima, entre as 08:00 e 18:00, está DISPONÍVEL. Pode confirmar com o cliente!`;
  } catch (erro) {
    console.error("❌ Erro no Google Calendar:", erro.message);
    throw new Error("Falha ao ler o Google Calendar");
  }
}

async function conversarComGemini(contextoAgenda, mensagemCliente) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    systemInstruction: {
      parts: [{
        text: `Você é o assistente virtual do fotógrafo Dionizio.
        Seu tom: Simpático, educado e extremamente objetivo (máximo 3 linhas).
        
        SITUAÇÃO DA AGENDA:
        ${contextoAgenda}
        
        SUA TAREFA:
        1. Se o cliente pedir um horário livre, cruze os dados. Se não cruzar com os BLOQUEADOS e estiver no expediente, diga que ESTÁ DISPONÍVEL.
        2. Se o cliente perguntar "tem vaga hoje?", sugira 2 horários que estejam disponíveis.
        3. Para marcar algo, peça: Data, Horário exato e Nome completo.
        4. Nunca diga que você não tem acesso à agenda.`
      }]
    },
    contents: [{ role: "user", parts: [{ text: mensagemCliente }] }],
    generationConfig: { 
      temperature: 0.3, // Menos "criatividade", mais precisão analítica
      maxOutputTokens: 250 
    } 
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!res.ok) throw new Error(`Erro Gemini: ${res.statusText}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Desculpe, deu um branco aqui. Pode repetir?";
}

async function enviarParaTelegram(chatId, texto, tentativa = 1) {
  if (tentativa > 3) return console.error("❌ Telegram: Falha após 3 tentativas.");
  
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: texto })
    });
    if (!res.ok) throw new Error("Falha no fetch do Telegram");
  } catch (erro) {
    setTimeout(() => enviarParaTelegram(chatId, texto, tentativa + 1), 1000 * tentativa);
  }
}

// 4. Rota do Webhook (Otimizada para Alta Performance)
app.post("/webhook", (req, res) => {
  // Responde ao Telegram em milissegundos para evitar travamentos
  res.sendStatus(200);

  const msg = req.body?.message;
  if (!msg?.text || !msg?.chat?.id) return;

  // Roda a IA e o Google de forma assíncrona (Background)
  (async () => {
    try {
      const contexto = await obterStatusAgenda();
      const respostaIA = await conversarComGemini(contexto, msg.text);
      await enviarParaTelegram(msg.chat.id, respostaIA);
    } catch (erro) {
      console.error("❌ Erro no fluxo:", erro.message);
      await enviarParaTelegram(msg.chat.id, "Estou atualizando o sistema da agenda, pode me chamar novamente em 1 minutinho?");
    }
  })();
});

app.listen(PORT, () => console.log(`🚀 Servidor PRO rodando na porta ${PORT}`));
