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
      // Agora a descrição salva a quantidade de pessoas!
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
📄 INFORMAÇÕES, REGRAS E VALORES DO ESTÚDIO:

💰 VALORES POR HORA:
- Aclimação Seg a Sex (Mínimo 2 horas):
  - 1 a 2 pessoas: Estúdios A, B, C, D (R$70/h). Estúdio A e B juntos (R$100/h).
  - 3 a 5 pessoas: Estúdios A, B, C, D (R$80/h). Estúdio A e B juntos (R$110/h).
  - 6 a 8 pessoas: Estúdios A, B, C, D (R$100/h). Estúdio A e B juntos (R$130/h).
- Aclimação Fim de Semana/Feriado (Mínimo 3 horas):
  - 1 a 2 pessoas: Estúdios A, B, C, D (R$80/h). Estúdio A e B juntos (R$110/h).
  - 3 a 5 pessoas: Estúdios A, B, C, D (R$90/h). Estúdio A e B juntos (R$120/h).
  - 6 a 8 pessoas: Estúdios A, B, C (R$110/h). Estúdio D (R$100/h). Estúdio A e B juntos (R$140/h).
- Bela Vista Seg a Sex (Mínimo 2 horas):
  - 1 a 2 pessoas: Estúdio 1 (R$70/h), Estúdio 2 (R$50/h), Estúdio 3 (R$60/h).
  - 3 a 5 pessoas: Estúdio 1 (R$80/h), Estúdio 2 (R$60/h), Estúdio 3 (R$70/h).
  - 6 a 8 pessoas: Estúdio 1 (R$100/h), Estúdio 2 (R$80/h), Estúdio 3 (R$90/h).
- Bela Vista Fim de Semana/Feriado (Mínimo 4 horas):
  - 1 a 2 pessoas: Estúdio 1 (R$80/h), Estúdio 2 (R$70/h), Estúdio 3 (R$80/h).
  - 3 a 5 pessoas: Estúdio 1 (R$90/h), Estúdio 2 (R$80/h), Estúdio 3 (R$80/h).
  - 6 a 8 pessoas: Estúdio 1 (R$110/h), Estúdio 2 (R$100/h), Estúdio 3 (R$100/h).
* Acima de 8 pessoas: valor a combinar. Diária de 12h é cobrada como 10h. 
* Estacionamento: R$10 o período (precisa pedir antes).

🎬 REGRAS IMPORTANTES (ÁUDIO E SUJEIRA):
- Gravação de VÍDEO COM ÁUDIO: É obrigatório alugar TODOS os estúdios do endereço (os três da Bela Vista ou A e B da Aclimação) devido ao som ambiente.
- O tempo de montagem/desmontagem conta na locação.
- Proibido pisar na curva do fundo infinito. Taxa de R$150 se entregue muito sujo.
- Fundo de papel cobrado à parte se sujar/pisar (R$100/metro).

📸 EQUIPAMENTOS:
- INCLUSO: Fundo branco infinito, 2 flashs 400w c/ softbox OU 2 tochas led, rádio flash. Auxiliamos na montagem e sincronização.
- PAGO À PARTE: Câmeras (5D R$200, 6D R$100), Luz Contínua Godox (R$120), Tripé Manfrotto (R$40), etc.

💳 PAGAMENTO E RESERVA:
- Confirmação mediante pagamento antecipado de 1/3 do valor via PIX.
- PIX CPF: 299.201.788-45 ou PIX Celular: 11941666756 (Dionizio Felippe e Silva - Bradesco/Itaú).
- Reagendamento/Cancelamento: Só com mais de 48h de antecedência para ter devolução do sinal.

🔗 LINKS ÚTEIS (Envie se pedirem fotos):
- Fotos Bela Vista: https://drive.google.com/drive/folders/1Navk6o2Gy9cDlD9FKAuizH8hd3nTMLEW?usp=sharing
- Fotos Aclimação: https://drive.google.com/drive/folders/100GPqd9sWFRtEE5YPZCYhyvDkBNV__G9?usp=sharing
=============================

Hoje é: ${hoje} (Horário de Brasília)
${agendaHoje}

REGRAS DE ATENDIMENTO E RESERVA:
- Faça o orçamento para o cliente baseando-se no dia da semana, quantidade de pessoas e horas.
- 🚨 SE o cliente quiser ver a grade completa de horários, mande este link: ${LINK_AGENDA}
- Para fechar a reserva, você DEVE coletar 7 informações: Nome, Estúdio, Data, Hora Início, Duração (minutos), Tipo de Produção e QUANTIDADE DE PESSOAS.
- No FINAL da confirmação, envie o JSON EXATAMENTE como abaixo:
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
        
        // Passando a quantidade de pessoas para a função salvar na agenda
        const resultado = await criarEventoGoogleCalendar(
          dados.nome, dados.data, dados.hora_inicio, dados.duracao_minutos, dados.tipo_sessao, dados.estudio, dados.qtd_pessoas
        );
        
        if (resultado.success) {
          await sendMessage(chatId, `✅ Sucesso! Estúdio ${dados.estudio} reservado para ${dados.data} às ${dados.hora_inicio}.`);
          
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
