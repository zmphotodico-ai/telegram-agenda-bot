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
  console.error("❌ Erro no GOOGLE_CONFIG.");
  process.exit(1);
}

const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email, null, GOOGLE_CONFIG.private_key,
  ["https://www.googleapis.com/auth/calendar"]
);
const calendar = google.calendar({ version: "v3", auth });

// 2. Buscar Agenda Hoje
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
    
    return `Horários ocupados:\n${ocupados}\n\nATENÇÃO: Qualquer horário comercial não listado acima está LIVRE.`;
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
    // Ex: "2026-03-10" e "12:00"
    const [ano, mes, dia] = dataStr.split("-");
    const [hora, minuto] = horaInicio.split(":");
    
    const startDate = new Date(`${ano}-${mes}-${dia}T${hora}:${minuto}:00-03:00`);
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60 * 1000);

    // Proteção contra data inválida gerada pela IA
    if (isNaN(startDate.getTime())) throw new Error("Data inválida recebida");

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

// 5. Inteligência Artificial (Com Tratamento de Erros)
async function gerarRespostaGemini(agendaHoje, pergunta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  
  // Agora a IA sabe exatamente o dia de hoje, evitando errar o ano/mês
  const hoje = new Date().toLocaleDateString('pt-BR');
  
  const systemPrompt = `Você é o assistente de agendamento do fotógrafo Dionizio. Responda de forma educada e bem curta.
  DATA DE HOJE: ${hoje}. Use isso como base para o ano e o mês se o cliente pedir um dia solto.
  
  AGENDA DE HOJE:
  ${agendaHoje}
  
  REGRAS:
  1. Para agendar, peça todos os dados: Data (AAAA-MM-DD), Hora exata, Nome e Tipo de Sessão.
  2. QUANDO O CLIENTE CONFIRMAR OS DADOS, você deve AVISAR que está marcando o ensaio e inserir NO FINAL da resposta exatamente este bloco de código (substituindo pelos dados reais):
  
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
        systemInstruction: { parts: [{ text: systemPrompt }] }, // Instrução nativa! Mais estável.
        contents: [{ role: "user", parts: [{ text: pergunta }] }],
        generationConfig: { temperature: 0.1 } // Temperatura quase zero (sem invenções)
      }),
    });
    
    const data = await res.json();
    
    // O Detetive de Erros: Descobrindo por que o Google barrou a gente
    if (data.error) {
       console.error("Erro Gemini API:", data.error);
       if (data.error.code === 429) return "Estou recebendo muitas mensagens juntas! 😅 Pode aguardar uns 10 segundos e tentar de novo?";
       return "Opa, deu uma falha na minha inteligência. Pode tentar escrever de outra forma?";
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Pode repetir?";
  } catch (err) {
    console.error("Falha de rede Gemini:", err);
    return "Minha conexão oscilou, me chame novamente em 1 minuto.";
  }
}

// 6. Webhook e "Pulo do Gato" da Marcação
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Não deixa o Telegram travar
  
  const msg = req.body?.message;
  if (!msg?.text || !msg?.chat?.id) return;
  
  const chatId = msg.chat.id;

  try {
    const agenda = await buscarAgendaHoje();
    let resposta = await gerarRespostaGemini(agenda, msg.text);

    // Detetive aprimorado: pega o JSON mesmo se a IA esquecer de escrever "json" na caixinha
    const jsonMatch = resposta.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    
    if (jsonMatch && jsonMatch[1]) {
      try {
        const dados = JSON.parse(jsonMatch[1].trim());
        
        // Retiramos a parte feia do código da resposta pro cliente não ver
        resposta = resposta.replace(/```(?:json)?\s*([\s\S]*?)\s*```/, "").trim();
        
        // Se a resposta ficar vazia, não deixamos dar erro no Telegram
        if(resposta === "") { resposta = "⏳ Entendido! Aguarde um instante..."; }
        
        await sendMessage(chatId, resposta);
        await sendMessage(chatId, "Salvando na agenda do Dionizio... 📅");

        const resultado = await criarEventoGoogleCalendar(dados.nome, dados.data, dados.hora_inicio, dados.duracao_minutos || 60, dados.tipo_sessao);

        if (resultado.success) {
          await sendMessage(chatId, `✅ Tudo certo, ${dados.nome}! Seu agendamento para o dia ${dados.data} às ${dados.hora_inicio} foi marcado com sucesso!`);
        } else {
          await sendMessage(chatId, "❌ Ops... tive um problema ao conectar com a agenda do Google. A data pode estar em um formato que não entendi. Pode tentar de novo?");
        }
        return; // Encerra aqui pois já respondemos
      } catch (e) {
        console.error("Erro ao ler JSON da IA:", e);
      }
    }

    await sendMessage(chatId, resposta);
  } catch (err) {
    console.error("Erro Fluxo:", err);
    await sendMessage(chatId, "Tive um probleminha técnico. Tente novamente daqui a pouco.");
  }
});

app.listen(PORT, () => console.log(`🚀 Servidor ATIVO na porta ${PORT}`));
