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

// ✅ SEU ID DE ADMIN PARA O MODO ESPIÃO
const ADMIN_CHAT_ID = "8132670973";

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
// ENVIAR MENSAGEM (CLIENTE)
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
      console.error("⚠️ Falha de conexão ao enviar mensagem.");
    }
  }
}

// =============================
// ENVIAR NOTIFICAÇÃO (ADMIN) - O MODO ESPIÃO
// =============================
async function sendAdminNotification(text) {
  if (!ADMIN_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: text })
    });
  } catch (e) {
    console.error("⚠️ Falha ao notificar o Admin.");
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
async function criarEventoGoogleCalendar(nome, dataStr, horaInicio, duracaoMinutos, tipoSessao, estudio, qtdPessoas) {
  try {
    duracaoMinutos = Number(duracaoMinutos) || 120;

    const disponivel = await verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos, estudio);

    if (!disponivel) {
      return { success: false, message: `O Estúdio ${estudio} já está ocupado nesse horário.` };
    }

    const startISO = `${dataStr}T${horaInicio}:00-03:00`;
    const startDate = new Date(startISO);
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60000);

    const horaFim = endDate.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

    const mapeamentoCores = {
      'A': '1', 'B': '2', 'AB': '3', 'C': '4', 'D': '5', '1': '6', '2': '7', '3': '10'
    };

    const event = {
      summary: `${horaInicio}-${horaFim} /${estudio.toUpperCase()}`, 
      description: `Cliente: ${nome}\nEstúdio: ${estudio}\nProdução: ${tipoSessao}\nPessoas: ${qtdPessoas}\nDuração: ${duracaoMinutos} min`,
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
// GEMINI COM MEMÓRIA E REGRAS COMPLETAS DO ESTÚDIO
// =============================
async function gerarRespostaGemini(chatId, agendaHoje, pergunta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const hoje = new Date().toLocaleDateString("pt-BR", {timeZone: "America/Sao_Paulo"});
  
  const prompt = `Você é o assistente de atendimento da "Aluguel de Estúdio Fotográfico". Nós ALUGAMOS salas, não fotografamos.

=============================
📄 INFORMAÇÕES E VALORES:
- Aclimação Seg a Sex: 1-2 pessoas (R$70/h). 3-5 (R$80/h). 6-8 (R$100/h).
- Bela Vista Seg a Sex: Estúdio 1 (R$70/h), 2 (R$50/h), 3 (R$60/h) para 1-2 pessoas.
- Locação MÍNIMA: 2 horas. 
- Finais de semana os valores aumentam e o mínimo sobe para 3 ou 4 horas.
- VÍDEO COM ÁUDIO: Exige alugar todos os estúdios do endereço (A e B juntos, ou 1, 2 e 3 juntos).
- Equipamentos base já estão inclusos.
=============================

Hoje é: ${hoje}
${agendaHoje}

REGRAS:
1. Sempre seja cordial. 
2. Se o cliente quiser a grade completa de horários, envie: ${LINK_AGENDA}
3. PARA AGENDAR, você precisa confirmar 7 informações: Nome, Estúdio (A,B,AB,C,D,1,2 ou 3), Data, Hora, Duração, Produção e Quantidade de Pessoas.
4. Só mande o JSON abaixo se tiver certeza que o cliente informou todos os 7 dados e concordou.
\`\`\`json
{
 "nome":"Nome Cliente",
 "data":"AAAA-MM-DD",
 "hora_inicio":"HH:MM",
 "duracao_minutos":120,
 "tipo_sessao":"Produção",
 "estudio":"A",
 "qtd_pessoas": 4
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
        generationConfig: { temperature: 0.1 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
      })
    });
    
    const data = await res.json();
    
    if (data.error) {
      console.error("❌ ERRO DA API GEMINI:", data.error.message);
      return "Estou reiniciando meus sistemas. Pode tentar novamente em alguns minutos?";
    }

    let respostaBot = "Desculpe, me confundi. Pode repetir a última informação?";
    if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
      respostaBot = data.candidates[0].content.parts[0].text.trim();
    }
    
    const respostaLimpaParaMemoria = respostaBot.replace(/```json[\s\S]*?```/i, "").trim();
    if (respostaLimpaParaMemoria !== "") memoriaConversas[chatId].push(`Assistente: ${respostaLimpaParaMemoria}`);
    
    return respostaBot;
  } catch (err) {
    console.error("❌ Erro de Fetch no Gemini:", err.message);
    return "Minha conexão com a inteligência falhou agora. Pode tentar novamente?";
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
  const nomeUsuario = msg.from.first_name || "Alguém";

  console.log(`📩 Nova mensagem de ${nomeUsuario}: ${texto}`);

  // 🕵️‍♂️ MODO ESPIÃO: Avisa o Admin do que o cliente mandou (se não for o próprio Admin testando)
  if (String(chatId) !== ADMIN_CHAT_ID) {
    await sendAdminNotification(`👤 *${nomeUsuario}* mandou:\n"${texto}"`);
  }

  try {
    const agendaSemana = await buscarAgendaSemana();
    let resposta = await gerarRespostaGemini(chatId, agendaSemana, texto);
    
    const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/i); 
    
    if (jsonMatch) {
      try {
        const dados = JSON.parse(jsonMatch[1]);
        resposta = resposta.replace(/```json[\s\S]*?```/i, "").trim();
        
        if (resposta !== "") {
          await sendMessage(chatId, resposta);
          // 🕵️‍♂️ MODO ESPIÃO
          if (String(chatId) !== ADMIN_CHAT_ID) await sendAdminNotification(`🤖 *Bot respondeu:*\n"${resposta}"`);
        }
        
        await sendMessage(chatId, "Verificando disponibilidade do estúdio... 📅");
        
        const resultado = await criarEventoGoogleCalendar(
          dados.nome, dados.data, dados.hora_inicio, dados.duracao_minutos, dados.tipo_sessao, dados.estudio, dados.qtd_pessoas
        );
        
        if (resultado.success) {
          const msgSucesso = `✅ Sucesso! Estúdio ${dados.estudio} reservado para ${dados.data} às ${dados.hora_inicio}.`;
          await sendMessage(chatId, msgSucesso);
          
          const msgGuia = `Estou te enviando nosso guia informativo com as regras e dicas do estúdio! 👇\n\n📄 Clique aqui para acessar: https://drive.google.com/file/d/1J8FC6mzmfkOhlHbRrKVLN92jYj9LF1bb/view?usp=sharing`;
          await sendMessage(chatId, msgGuia);

          // 🕵️‍♂️ MODO ESPIÃO: Avisa o Admin que fechou negócio!
          if (String(chatId) !== ADMIN_CHAT_ID) {
             await sendAdminNotification(`🎉 *NOVO AGENDAMENTO FECHADO PELO BOT!* 🎉\nO cliente ${nomeUsuario} acabou de reservar o Estúdio ${dados.estudio}. Confira a sua agenda!`);
          }

          delete memoriaConversas[chatId];
        } else {
          await sendMessage(chatId, `❌ Indisponível: ${resultado.message}`);
        }
        return; 
      } catch (e) { console.error("Erro no JSON:", e); }
    }
    
    await sendMessage(chatId, resposta);
    
    // 🕵️‍♂️ MODO ESPIÃO: Mostra a resposta normal da IA
    if (String(chatId) !== ADMIN_CHAT_ID) {
      await sendAdminNotification(`🤖 *Bot respondeu:*\n"${resposta}"`);
    }

  } catch (err) { 
    console.error("❌ ERRO FATAL NO WEBHOOK:", err); 
    await sendMessage(chatId, "Opa, tive um pequeno curto-circuito aqui! 🤖⚡ Pode mandar a mensagem de novo?");
  }
});

app.listen(PORT, () => console.log(`🚀 Porta ${PORT} rodando com sucesso!`));
