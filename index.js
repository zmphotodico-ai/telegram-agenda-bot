import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const CALENDAR_ID = "alugueldeestudiofotografico@gmail.com";

// ✅ MEMÓRIA DO BOT
const memoriaConversas = {};

// =============================
// GOOGLE CALENDAR CONFIG
// =============================
let calendar;
try {
  const GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);
  
  let privateKey = GOOGLE_CONFIG.private_key;
  if (privateKey.includes("\\n")) {
    privateKey = privateKey.split("\\n").join("\n");
  }

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
// VERIFICAR DISPONIBILIDADE (POR ESTÚDIO ESPECÍFICO)
// =============================
async function verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos, estudioAlvo) {
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

    const eventosConflitantes = res.data.items || [];
    
    // 🧠 A MÁGICA: Ele filtra para ver se o conflito é no MESMO estúdio
    // Procura no título (summary) se termina com a sigla do estúdio (ex: "/A")
    const ocupadoNoMesmoEstudio = eventosConflitantes.some(ev => {
        const titulo = ev.summary || "";
        return titulo.endsWith(`/${estudioAlvo.toUpperCase()}`);
    });

    return !ocupadoNoMesmoEstudio; // Retorna true se o estúdio específico estiver livre

  } catch (err) {
    console.error("❌ Erro ao verificar disponibilidade:", err.message);
    return false;
  }
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
        return "Hoje a agenda de todos os estúdios está livre.";
      }
  
      const lista = eventos.map(ev => {
        const start = new Date(ev.start.dateTime || ev.start.date);
        const hora = start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
        return `• ${ev.summary} (Ocupado)`;
      }).join("\n");
  
      return `Ocupações de hoje:\n${lista}\n\nLembre-se: Se um estúdio não aparece na lista acima, ele está DISPONÍVEL.`;
  
    } catch (err) {
      console.error("❌ Erro ao buscar agenda:", err.message);
      return "Não consegui consultar a agenda.";
    }
  }

// =============================
// CRIAR EVENTO
// =============================
async function criarEventoGoogleCalendar(nome, dataStr, horaInicio, duracaoMinutos, tipoSessao, estudio) {
  try {
    duracaoMinutos = Number(duracaoMinutos) || 120;

    if (duracaoMinutos < 120) {
      return { success: false, message: "A locação mínima é de 2 horas (120 minutos)." };
    }

    // Passamos o 'estudio' para a verificação ser inteligente
    const disponivel = await verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos, estudio);

    if (!disponivel) {
      return { success: false, message: `O Estúdio ${estudio} já está ocupado nesse horário.` };
    }

    const startDate = new Date(`${dataStr}T${horaInicio}:00`);
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60000);

    const horaFim = endDate.toLocaleTimeString("pt-BR", { 
      hour: "2-digit", 
      minute: "2-digit", 
      timeZone: "America/Sao_Paulo" 
    });

    const mapeamentoCores = {
      'A': '1', 'B': '2', 'AB': '3', 'C': '4', 'D': '5', '1': '6', '2': '7', '3': '10'
    };

    const event = {
      summary: `${horaInicio}-${horaFim} /${estudio.toUpperCase()}`, 
      description: `Cliente: ${nome}\nEstúdio: ${estudio}\nProdução: ${tipoSessao}\nDuração: ${duracaoMinutos} min`,
      colorId: mapeamentoCores[estudio.toUpperCase()] || '8',
      start: { dateTime: startDate.toISOString(), timeZone: "America/Sao_Paulo" },
      end: { dateTime: endDate.toISOString(), timeZone: "America/Sao_Paulo" }
    };

    const response = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });

    console.log("✅ Evento criado!");
    return { success: true, link: response.data.htmlLink };

  } catch (err) {
    console.error("❌ Erro:", err.message);
    return { success: false, message: err.message };
  }
}

// =============================
// GEMINI COM MEMÓRIA
// =============================
async function gerarRespostaGemini(chatId, agendaHoje, pergunta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const hoje = new Date().toLocaleDateString("pt-BR");
  
  const prompt = `Você é o assistente da empresa "Aluguel de Estúdio Fotográfico".
Nós ALUGAMOS salas para produtores. Não fotografamos.

Estúdios Aclimação: A, B, AB, C e D.
Estúdios Bela Vista: 1, 2 e 3.

Hoje é: ${hoje}
Ocupações hoje:
${agendaHoje}

REGRAS:
- Locação MÍNIMA de 2 horas (120 minutos).
- É possível ter vários agendamentos no mesmo horário, desde que sejam em ESTÚDIOS DIFERENTES.
- Informe ao cliente que o horário está livre se o estúdio específico que ele quer não estiver na lista de ocupados.
- Colete: Nome, Estúdio (A, B, AB, C, D, 1, 2 ou 3), Data, Hora de Início, Duração (mínimo 120) e Tipo de Produção.
- No FINAL da confirmação, envie o JSON:
\`\`\`json
{
 "nome":"Nome Cliente",
 "data":"AAAA-MM-DD",
 "hora_inicio":"HH:MM",
 "duracao_minutos":120,
 "tipo_sessao":"Produção",
 "estudio":"A"
}
\`\`\``;

  if (!memoriaConversas[chatId]) memoriaConversas[chatId] = [];
  memoriaConversas[chatId].push(`Cliente: ${pergunta}`);
  if (memoriaConversas[chatId].length > 8) memoriaConversas[chatId].shift();

  const historicoTexto = memoriaConversas[chatId].join("\n");
  const promptCompleto = `${prompt}\n\n[HISTÓRICO]\n${historicoTexto}\nAssistente:`;

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
    const respostaBot = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Pode repetir?";
    const respostaLimpaParaMemoria = respostaBot.replace(/```json[\s\S]*?```/i, "").trim();
    if (respostaLimpaParaMemoria !== "") memoriaConversas[chatId].push(`Assistente: ${respostaLimpaParaMemoria}`);
    return respostaBot;
  } catch (err) {
    return "Minha conexão falhou. Tente de novo.";
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
    let resposta = await gerarRespostaGemini(chatId, agenda, texto);
    const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/i); 
    
    if (jsonMatch) {
      try {
        const dados = JSON.parse(jsonMatch[1]);
        resposta = resposta.replace(/```json[\s\S]*?```/i, "").trim();
        if (resposta !== "") await sendMessage(chatId, resposta);
        await sendMessage(chatId, "Verificando disponibilidade do estúdio... 📅");
        
        const resultado = await criarEventoGoogleCalendar(
          dados.nome, dados.data, dados.hora_inicio, dados.duracao_minutos, dados.tipo_sessao, dados.estudio 
        );
        
        if (resultado.success) {
          await sendMessage(chatId, `✅ Sucesso! Estúdio ${dados.estudio} reservado para ${dados.data} às ${dados.hora_inicio}.`);
          delete memoriaConversas[chatId];
        } else {
          await sendMessage(chatId, `❌ Indisponível: ${resultado.message}`);
        }
        return; 
      } catch (e) { console.error(e); }
    }
    await sendMessage(chatId, resposta);
  } catch (err) { console.error(err); }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT}`));
