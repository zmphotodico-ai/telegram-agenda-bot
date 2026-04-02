import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const CALENDAR_ID = "alugueldeestudiofotografico@gmail.com";

// ✅ MEMÓRIA DO BOT (Para ele não esquecer o que vocês estavam falando)
const memoriaConversas = {};

// =============================
// GOOGLE CALENDAR CONFIG
// =============================
let calendar;
try {
  const GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);
  
  // Tratamento blindado para a chave privada no servidor do Railway
  let privateKey = GOOGLE_CONFIG.private_key;
  if (privateKey.includes("\\n")) {
    privateKey = privateKey.split("\\n").join("\n");
  }

  // Usando o Padrão Ouro de autenticação do Google
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_CONFIG.client_email,
      private_key: privateKey,
    },
    projectId: GOOGLE_CONFIG.project_id,
    scopes: ["https://www.googleapis.com/auth/calendar"]
  });

  calendar = google.calendar({ version: "v3", auth });
  console.log("✅ Autenticação blindada do Google configurada com sucesso!");

} catch (err) {
  console.error("❌ Erro fatal na configuração do Google:", err);
  process.exit(1);
}

// =============================
// BUSCAR AGENDA HOJE
// =============================
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
      timeZone: "America/Sao_Paulo"
    });

    const eventos = res.data.items || [];

    if (eventos.length === 0) {
      return "Hoje a agenda está totalmente livre das 08:00 às 18:00.";
    }

    const lista = eventos.map(ev => {
      const start = new Date(ev.start.dateTime || ev.start.date);
      const hora = start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
      return `• Ocupado às ${hora} (${ev.summary})`;
    }).join("\n");

    return `Agenda de hoje:\n${lista}\n\nATENÇÃO: Qualquer horário não listado acima está DISPONÍVEL.`;

  } catch (err) {
    console.error("❌ Erro ao buscar agenda:", err.message);
    return "Não consegui consultar a agenda.";
  }
}

// =============================
// ENVIAR MENSAGEM TELEGRAM
// =============================
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text })
      });
      if (res.ok) return;
      await new Promise(r => setTimeout(r, 800));
    } catch (e) {
      console.error("⚠️ Falha ao enviar mensagem");
    }
  }
}

// =============================
// VERIFICAR DISPONIBILIDADE
// =============================
async function verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos) {
  try {
    const startDate = new Date(`${dataStr}T${horaInicio}:00`);
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60000);

    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      timeZone: "America/Sao_Paulo"
    });

    return res.data.items.length === 0;

  } catch (err) {
    console.error("❌ Erro ao verificar disponibilidade:", err.message);
    return false;
  }
}

// =============================
// CRIAR EVENTO (ATUALIZADO COM O VISUAL NOVO)
// =============================
async function criarEventoGoogleCalendar(nome, dataStr, horaInicio, duracaoMinutos, tipoSessao) {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) throw new Error("Formato de data inválido");
    if (!/^\d{2}:\d{2}$/.test(horaInicio)) throw new Error("Formato de hora inválido");

    duracaoMinutos = Number(duracaoMinutos) || 60;

    const disponivel = await verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos);

    if (!disponivel) {
      return { success: false, message: "Horário indisponível na agenda do fotógrafo." };
    }

    const startDate = new Date(`${dataStr}T${horaInicio}:00`);
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60000);

    // Formata a hora final para o título (ex: 12:00)
    const horaFim = endDate.toLocaleTimeString("pt-BR", { 
      hour: "2-digit", 
      minute: "2-digit", 
      timeZone: "America/Sao_Paulo" 
    });

    // Pega a primeira letra da sessão (ex: Corporativo -> C, Ensaio -> E)
    const sigla = tipoSessao ? tipoSessao.charAt(0).toUpperCase() : 'C';

    const event = {
      // O visual na agenda vai ficar: 10:00-12:00 /C
      summary: `${horaInicio}-${horaFim} /${sigla}`, 
      
      // Os detalhes do cliente ficam guardados na descrição do evento
      description: `Cliente: ${nome}\nTipo de Sessão: ${tipoSessao}\nDuração: ${duracaoMinutos} min`,
      
      start: { dateTime: startDate.toISOString(), timeZone: "America/Sao_Paulo" },
      end: { dateTime: endDate.toISOString(), timeZone: "America/Sao_Paulo" }
    };

    const response = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });

    console.log("✅ Evento criado com sucesso no Google Calendar!");
    return { success: true, link: response.data.htmlLink };

  } catch (err) {
    console.error("❌ Erro ao criar evento:", err.message);
    return { success: false, message: err.message };
  }
}

// =============================
// GEMINI COM MEMÓRIA
// =============================
async function gerarRespostaGemini(chatId, agendaHoje, pergunta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const hoje = new Date().toLocaleDateString("pt-BR");
  
  const prompt = `Você é o assistente de agendamento do fotógrafo Dionizio.
Hoje é: ${hoje}
Agenda atual:
${agendaHoje}

REGRAS:
- Sempre responda de forma amigável e profissional.
- Para agendar, confirme todos os detalhes com o cliente antes de prosseguir.
- Peça explicitamente:
  1. data (AAAA-MM-DD)
  2. hora inicial (HH:MM)
  3. nome completo
  4. tipo de sessão
- Só envie o bloco JSON quando o cliente confirmar TODOS os dados e você tiver certeza de que a pessoa disse que aprova/confirma/pode prosseguir.
- No FINAL da mensagem, se for para confirmar o agendamento, escreva EXATAMENTE o bloco abaixo com os dados preenchidos:
\`\`\`json
{
 "nome":"Nome Cliente",
 "data":"AAAA-MM-DD",
 "hora_inicio":"HH:MM",
 "duracao_minutos":60,
 "tipo_sessao":"Tipo de Sessão"
}
\`\`\``;

  // ✅ 1. Inicia a memória para o cliente, se não existir
  if (!memoriaConversas[chatId]) {
    memoriaConversas[chatId] = [];
  }

  // ✅ 2. Salva a nova mensagem do cliente na memória
  memoriaConversas[chatId].push(`Cliente: ${pergunta}`);

  // Mantém apenas as últimas 8 mensagens para não bugar a IA
  if (memoriaConversas[chatId].length > 8) {
    memoriaConversas[chatId].shift();
  }

  // ✅ 3. Junta todo o histórico num texto só
  const historicoTexto = memoriaConversas[chatId].join("\n");
  const promptCompleto = `${prompt}\n\n[HISTÓRICO DA CONVERSA]\n${historicoTexto}\nAssistente:`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptCompleto }] }],
        generationConfig: { temperature: 0.1 }
      })
    });

    const data = await res.json();
    
    if (data.error) {
      memoriaConversas[chatId].pop(); // Remove a última mensagem falha
      console.error("❌ Erro da API Gemini:", data.error.message);
      return "Tive um problema na minha inteligência agora. Pode repetir?";
    }

    const respostaBot = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Pode repetir?";

    // ✅ 4. Salva a resposta do bot na memória (limpando códigos JSON ocultos)
    const respostaLimpaParaMemoria = respostaBot.replace(/```json[\s\S]*?```/i, "").trim();
    if (respostaLimpaParaMemoria !== "") {
      memoriaConversas[chatId].push(`Assistente: ${respostaLimpaParaMemoria}`);
    }

    return respostaBot;

  } catch (err) {
    console.error("❌ Erro de conexão com Gemini:", err.message);
    return "Minha conexão com a IA falhou agora. Pode tentar novamente?";
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
    // ✅ Passamos o chatId para a função saber qual memória buscar
    let resposta = await gerarRespostaGemini(chatId, agenda, texto);

    const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/i); 
    
    if (jsonMatch) {
      try {
        const dados = JSON.parse(jsonMatch[1]);
        resposta = resposta.replace(/```json[\s\S]*?```/i, "").trim();
        
        if (resposta !== "") {
          await sendMessage(chatId, resposta);
        }
        
        await sendMessage(chatId, "Salvando na agenda... 📅");
        
        const resultado = await criarEventoGoogleCalendar(
          dados.nome,
          dados.data,
          dados.hora_inicio,
          dados.duracao_minutos,
          dados.tipo_sessao
        );
        
        if (resultado.success) {
          await sendMessage(chatId, `✅ Agendamento confirmado para o dia ${dados.data} às ${dados.hora_inicio}!`);
          
          // ✅ APAGA A MEMÓRIA! O Agendamento terminou, a próxima mensagem será um novo assunto.
          delete memoriaConversas[chatId];
        } else {
          await sendMessage(chatId, `❌ Ops! Não consegui salvar na agenda. Motivo: ${resultado.message}`);
        }
        return; 
      } catch (jsonError) {
        console.error("❌ Erro ao ler os dados do Gemini:", jsonError.message);
      }
    }

    await sendMessage(chatId, resposta);

  } catch (err) {
    console.error("❌ Erro geral no Webhook:", err.message);
    await sendMessage(chatId, "Tive um erro interno. Pode tentar de novo?");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
