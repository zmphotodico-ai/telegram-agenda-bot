import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const CALENDAR_ID = "alugueldeestudiofotografico@gmail.com";

const LINK_AGENDA = "https://calendar.google.com/calendar/embed?src=alugueldeestudiofotografico%40gmail.com&ctz=America%2FSao_Paulo";

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
  console.log("✅ Autenticação blindada configurada com sucesso!");

} catch (err) {
  console.error("❌ Erro fatal na configuração do Google:", err);
  process.exit(1);
}

// =============================
// ENVIAR MENSAGEM (TEXTO)
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
async function verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos, estudioAlvo) {
  try {
    const startISO = `${dataStr}T${horaInicio}:00-03:00`;
    const startDate = new Date(startISO);
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60000);

    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      timeZone: "America/Sao_Paulo"
    });

    const eventosConflitantes = res.data.items || [];
    const ocupadoNoMesmoEstudio = eventosConflitantes.some(ev => {
        const titulo = ev.summary || "";
        return titulo.endsWith(`/${estudioAlvo.toUpperCase()}`);
    });

    return !ocupadoNoMesmoEstudio;

  } catch (err) {
    console.error("❌ Erro ao verificar disponibilidade:", err.message);
    return false;
  }
}

// =============================
// BUSCAR AGENDA (LÊ 7 DIAS)
// =============================
async function buscarAgendaSemana() {
    try {
      const hoje = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Sao_Paulo"}));
      hoje.setHours(0, 0, 0, 0);
  
      const daquiA7Dias = new Date(hoje.getTime());
      daquiA7Dias.setDate(daquiA7Dias.getDate() + 7);
      daquiA7Dias.setHours(23, 59, 59, 999);
  
      const res = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: hoje.toISOString(),
        timeMax: daquiA7Dias.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        timeZone: "America/Sao_Paulo"
      });
  
      const eventos = res.data.items || [];
  
      if (eventos.length === 0) {
        return "A agenda dos próximos 7 dias está totalmente livre.";
      }
  
      const lista = eventos.map(ev => {
        const start = new Date(ev.start.dateTime || ev.start.date);
        const dataFormatada = start.toLocaleDateString("pt-BR", { day: '2-digit', month: '2-digit' });
        const hora = start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
        return `• Dia ${dataFormatada} às ${hora} -> ${ev.summary} (Ocupado)`;
      }).join("\n");
  
      return `Ocupações dos próximos 7 dias:\n${lista}\n\nLembre-se: O que não está na lista, está LIVRE.`;
  
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

    const disponivel = await verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos, estudio);

    if (!disponivel) {
      return { success: false, message: `O Estúdio ${estudio} já está ocupado nesse horário.` };
    }

    const startISO = `${dataStr}T${horaInicio}:00-03:00`;
    const startDate = new Date(startISO);
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

    return { success: true, link: response.data.htmlLink };

  } catch (err) {
    return { success: false, message: err.message };
  }
}

// =============================
// GEMINI COM MEMÓRIA
// =============================
async function gerarRespostaGemini(chatId, agendaHoje, pergunta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const hoje = new Date().toLocaleDateString("pt-BR", {timeZone: "America/Sao_Paulo"});
  
  const prompt = `Você é o assistente da "Aluguel de Estúdio Fotográfico". Nós ALUGAMOS salas para produções.

Unidade Aclimação: A, B, AB, C e D.
Unidade Bela Vista: 1, 2 e 3.

Hoje é: ${hoje} (Horário de Brasília)
${agendaHoje}

REGRAS:
- Locação MÍNIMA de 2 horas (120 min).
- Se o cliente perguntar disponibilidades, use a lista acima.
- 🚨 SE o cliente estiver muito indeciso ou quiser ver a grade completa, mande este link: ${LINK_AGENDA}
- Coletar: Nome, Estúdio, Data, Hora de Início, Duração (min 120) e Tipo de Produção.
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
    const agendaSemana = await buscarAgendaSemana();
    let resposta = await gerarRespostaGemini(chatId, agendaSemana, texto);
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
          
          // ✅ SOLUÇÃO DO PDF: Envia a mensagem com o link direto e clicável!
          const msgGuia = `Estou te enviando nosso guia informativo com as regras e dicas do estúdio! 👇\n\n📄 Clique aqui para acessar: https://drive.google.com/file/d/1J8FC6mzmfkOhlHbRrKVLN92jYj9LF1bb/view?usp=sharing`;
          await sendMessage(chatId, msgGuia);

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
