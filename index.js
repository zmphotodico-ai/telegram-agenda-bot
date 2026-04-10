import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CALENDAR_ID = "alugueldeestudiofotografico@gmail.com";
const TIMEZONE = "America/Sao_Paulo";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8132670973"; 

const conversationMemory = new Map(); 
const userProfiles = new Map(); // Caderneta de Clientes (CRM)

// =============================
// GOOGLE CALENDAR
// =============================
let calendar;
try {
  const googleConfig = JSON.parse(process.env.GOOGLE_CONFIG);
  const privateKey = googleConfig.private_key.replace(/\\n/g, "\n");

  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: googleConfig.client_email,
      private_key: privateKey,
    },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  calendar = google.calendar({ version: "v3", auth });
  console.log("✅ Google Calendar conectado com sucesso.");
} catch (error) {
  console.error("❌ Erro ao conectar Google Calendar:", error);
}

// =============================
// FUNÇÕES DE APOIO (TEXTO PURO)
// =============================
async function sendMessage(chatId, text) {
  if (!chatId || !text) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        chat_id: chatId, 
        text: text 
      }),
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem no Telegram:", error);
  }
}

async function getAgendaOcupada() {
  try {
    const agora = new Date();
    const limite = new Date(agora.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 dias
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: agora.toISOString(),
      timeMax: limite.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    
    if (!res.data.items || res.data.items.length === 0) return "Nenhuma reserva encontrada. Todos os estúdios estão livres.";

    return res.data.items.map(ev => {
      const inicio = new Date(ev.start.dateTime || ev.start.date);
      const fim = new Date(ev.end.dateTime || ev.end.date);
      return `- ${inicio.toLocaleDateString("pt-BR", { day: '2-digit', month: '2-digit' })} das ${inicio.toLocaleTimeString("pt-BR", { hour: '2-digit', minute: '2-digit' })} às ${fim.toLocaleTimeString("pt-BR", { hour: '2-digit', minute: '2-digit' })} (${ev.summary})`;
    }).join("\n");
  } catch (e) { return "Erro ao consultar agenda."; }
}

// =============================
// CÉREBRO DO ROBÔ (GEMINI)
// =============================
async function gerarRespostaGemini(chatId, pergunta, historico = [], nomeUsuario = "Cliente") {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  
  const dataAtual = new Date();
  const diaSemana = dataAtual.toLocaleDateString("pt-BR", { weekday: 'long' });
  const dataHojeStr = dataAtual.toLocaleDateString("pt-BR");
  const anoAtual = dataAtual.getFullYear();
  const ocupacaoAtual = await getAgendaOcupada();

  const perfil = userProfiles.get(chatId);
  const infoPerfil = perfil 
    ? `\nVocê já tem o cadastro deste cliente! Nome completo: ${perfil.nome} | Telefone: ${perfil.telefone}. NÃO pergunte nome e telefone para fazer a reserva, puxe da sua memória e use no JSON.` 
    : ``;

  const SYSTEM_PROMPT = `
Você é o assistente oficial do Aluguel de Estúdio Fotográfico (Aclimação e Bela Vista).

👤 CLIENTE ATUAL: O nome dele no Telegram é ${nomeUsuario}. Se for uma saudação, diga "Oi ${nomeUsuario}, como posso te ajudar hoje?".${infoPerfil}

⏳ TEMPO E AGENDA:
- Hoje é ${diaSemana}, ${dataHojeStr}. Ano ${anoAtual}. Calcule as datas mentalmente.
- HORÁRIOS JÁ OCUPADOS (Próximos 7 dias):
${ocupacaoAtual}

⚠️ REGRAS DE OURO:
1. OS ESTÚDIOS SÃO INDEPENDENTES! Vários estúdios podem ser alugados no mesmo horário. Só diga que está ocupado se o cliente pedir EXATAMENTE o mesmo estúdio que já consta como ocupado na lista acima.
2. Obrigatório 30 min de intervalo livre entre reservas do MESMO estúdio.
3. Respostas CURTAS. Não use formatações como asteriscos.
4. WHATSAPP (11 99554-0293) SÓ PARA: Mais de 8 pessoas, madrugadas/antes das 8h, ou dúvidas complexas.

PASSO A PASSO DA RESERVA:
Pergunte o que faltar: Data, Início, Duração (horas), Estúdio e Pessoas. (Se você não tiver na memória, peça Nome Completo e Telefone).
Confirmado tudo, calcule o valor total e gere SOMENTE o JSON:
\`\`\`json
{
  "nome": "João Silva",
  "telefone": "11987654321",
  "data": "YYYY-MM-DD",
  "hora_inicio": "14:00",
  "duracao_minutos": 120,
  "estudio": "Estúdio 1 - Bela Vista",
  "qtd_pessoas": 2,
  "valor_total": 140
}
\`\`\`

📸 FOTOS E TAMANHOS (Envie o link quando pedirem):
🔗 PDF Geral com Plantas: https://drive.google.com/file/d/1J8FC6mzmfkOhlHbRrKVLN92jYj9LF1bb/view?usp=sharing

📍 Aclimação:
- Estúdio A (~35m²): Maior individual. Fotos: https://drive.google.com/drive/folders/19SQObRdLLXiPw-3p3AfWWHRU0BHxG3BE?usp=drive_link
- Estúdio B (~26m²): Fotos: https://drive.google.com/drive/folders/14IJ64PDgfBm-Z1cnB-vlDRxQ5j9NQXYm?usp=drive_link
- Estúdio AB (~61m²): A+B. Fotos: https://drive.google.com/drive/folders/1vfQ4IU8TCvDyBjMge0xUBKUXNEKxHe8I?usp=drive_link
- Estúdio C (~29m²): Fotos: https://drive.google.com/drive/folders/12OHhx9-zh_zPfk8hRr1u8SU55CY3UVld?usp=drive_link
- Estúdio D (~29m²): Fotos: https://drive.google.com/drive/folders/1D3_KYy--SCczMhx9-qayd0j2v5v0rYwS?usp=drive_link

📍 Bela Vista:
- Estúdio 1 (~37m²): Maior da unidade. Fotos: https://drive.google.com/drive/folders/1P0Z7xBCZ6gx1OJXZOR_6EWESv3QxIskA?usp=drive_link
- Estúdio 2 (~30m²): Fotos: https://drive.google.com/drive/folders/1LyhVa4Jbtjjgve30AIIuVFuK3GBI1Jzn?usp=drive_link
- Estúdio 3 (~30m²): Fotos: https://drive.google.com/drive/folders/1f0sG3_R6mUKbXBP0TaGNHg_mJ97L3POP?usp=drive_link

💰 PREÇOS (Base 1-2 pessoas):
- Bela Vista (Seg-Sex, mín 2h): Est.1 R$70/h | Est.2 R$50/h | Est.3 R$60/h
- Bela Vista (Fim semana, mín 4h): Est.1 R$80/h | Est.2 R$70/h | Est.3 R$80/h
- Aclimação (Seg-Sex, mín 2h): A, B, C, D R$70/h | A+B R$100/h
- Aclimação (Fim semana, mín 3h): A, B, C, D R$80/h | A+B R$110/h
*Para 3-5 pessoas: +R$10/h no valor base. Para 6-8 pessoas: +R$30/h no valor base.
`;

  const historicoTexto = historico.map(msg => 
    `${msg.role === 'user' ? 'Cliente' : 'Assistente'}: ${msg.content}`
  ).join('\n');

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\n[HISTÓRICO]\n${historicoTexto}\n\nCliente: ${pergunta}` }] }],
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
        ]
      }),
    });

    const data = await res.json();
    
    if (data.error) return "Estou com uma instabilidade. Tente em 1 minuto.";
    if (!data.candidates || data.candidates.length === 0) return "Desculpe, não entendi.";

    return data.candidates[0].content.parts[0].text;
  } catch (error) { return "Erro de conexão. Tente novamente."; }
}

// =============================
// GESTÃO DE EVENTOS (CRIAR E COBRAR)
// =============================
async function criarEvento(dados, chatId) {
  try {
    const start = new Date(`${dados.data}T${dados.hora_inicio}:00-03:00`);
    const end = new Date(start.getTime() + dados.duracao_minutos * 60000);

    const conflito = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
    });

    // 👇 NOVA REGRA: Verifica se a reserva que já existe é para o MESMO estúdio
    const temConflitoNoMesmoEstudio = conflito.data.items.some(ev => {
      const resumo = (ev.summary || "").toLowerCase();
      const desc = (ev.description || "").toLowerCase();
      const textoEvento = resumo + " " + desc;
      const estudioDesejado = (dados.estudio || "").toLowerCase();

      // Impede sobreposição entre os Estúdios A, B e AB
      if (estudioDesejado.includes("estúdio ab")) {
         return textoEvento.includes("estúdio a") || textoEvento.includes("estúdio b");
      }
      if (estudioDesejado.includes("estúdio a") && textoEvento.includes("estúdio ab")) return true;
      if (estudioDesejado.includes("estúdio b") && textoEvento.includes("estúdio ab")) return true;

      return textoEvento.includes(estudioDesejado);
    });

    if (temConflitoNoMesmoEstudio) return { erro: "conflito" };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: {
        summary: `${dados.hora_inicio} / ${dados.estudio} PRE`,
        description: `Cliente: ${dados.nome}\nTelefone: ${dados.telefone}\nChatId: ${chatId}\nPessoas: ${dados.qtd_pessoas}\nValor Total: R$${dados.valor_total}`,
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      },
    });

    return response.data;
  } catch (e) { return null; }
}

async function verificarPreReservas() {
  const agora = new Date();
  try {
    const res = await calendar.events.list({ calendarId: CALENDAR_ID, singleEvents: true });
    for (const ev of res.data.items || []) {
      if (!ev.summary?.includes("PRE")) continue;

      const criado = new Date(ev.created);
      const horasPassadas = (agora - criado) / (1000 * 60 * 60);
      const chatId = ev.description?.match(/ChatId:\s*(\d+)/)?.[1];

      if (chatId) {
        if (horasPassadas >= 12 && horasPassadas < 24) {
          await sendMessage(chatId, "Olá! Notamos que sua pré-reserva ainda não foi confirmada. Precisamos do comprovante do PIX (1/3) para garantir o horário! 😊");
        } else if (horasPassadas >= 24) {
          await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id });
          await sendMessage(chatId, "Sua pré-reserva foi cancelada automaticamente por falta de pagamento. Se ainda tiver interesse, consulte novas datas!");
          await sendMessage(ADMIN_CHAT_ID, `🗑️ Reserva de ${ev.summary} cancelada por falta de PIX.`);
        }
      }
    }
  } catch (e) { console.error(e); }
}
setInterval(verificarPreReservas, 6 * 60 * 60 * 1000);

// =============================
// WEBHOOK PRINCIPAL (COM MODO ESPIÃO)
// =============================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const chatId = req.body.message?.chat?.id;
    const texto = req.body.message?.text;
    const nomeUsuario = req.body.message?.from?.first_name || "Cliente";

    if (!chatId || !texto) return;

    // 🕵️ MODO ESPIÃO - Cliente enviou
    if (String(chatId) !== ADMIN_CHAT_ID) {
      await sendMessage(ADMIN_CHAT_ID, `👤 ${nomeUsuario}: ${texto}`);
    }

    // 🧠 MEMÓRIA DA CONVERSA
    if (!conversationMemory.has(chatId)) conversationMemory.set(chatId, []);
    const historico = conversationMemory.get(chatId);

    const resposta = await gerarRespostaGemini(chatId, texto, historico, nomeUsuario);

    // ATUALIZA A MEMÓRIA
    historico.push({ role: "user", content: texto });
    const respostaSemJson = resposta.replace(/```json[\s\S]*?```/i, "").trim();
    if (respostaSemJson) historico.push({ role: "model", content: respostaSemJson });
    if (historico.length > 10) conversationMemory.set(chatId, historico.slice(-10));

    const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/);

    if (jsonMatch) {
      const dados = JSON.parse(jsonMatch[1]);
      await sendMessage(chatId, "Verificando a agenda ao vivo... ⏳");
      
      const resultado = await criarEvento(dados, chatId);

      if (resultado?.erro === "conflito") {
        const msgConflito = "⚠️ Poxa, acabei de checar e esse horário já está ocupado neste estúdio (ou não tem o intervalo necessário)! Poderia escolher outro horário ou outro estúdio livre?";
        await sendMessage(chatId, msgConflito);
        if (String(chatId) !== ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, `🤖 Bot: ${msgConflito}`);
      } else if (resultado) {
        
        userProfiles.set(chatId, { nome: dados.nome, telefone: dados.telefone });

        const start = new Date(`${dados.data}T${dados.hora_inicio}:00-03:00`);
        const end = new Date(start.getTime() + dados.duracao_minutos * 60000);

        const dataFmt = start.toLocaleDateString("pt-BR", { weekday: 'long', day: 'numeric', month: 'short' }).replace(".", "");
        const horaIn = start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        const horaFim = end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        const valorTotal = dados.valor_total || 0;
        const valorSinal = Math.ceil(valorTotal / 3);

        const msgSucesso = `Pré marcado ${dados.estudio} ${dataFmt} · ${horaIn} – ${horaFim}\nreserva para ${dados.qtd_pessoas} pessoas valor total R$${valorTotal}\nPara fazer a reserva pedimos 1/3 r$${valorSinal} antecipado ok?\nPIX/CNPJ\nZmphoto@zmphoto.com.br\n43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
        
        await sendMessage(chatId, msgSucesso);
        if (String(chatId) !== ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, `🎉 NOVA RESERVA REGISTRADA:\n${msgSucesso}`);
        
        conversationMemory.set(chatId, []); // Limpa a memória após fechar a venda
      }
    } else {
      await sendMessage(chatId, respostaSemJson);
      // 🕵️ MODO ESPIÃO - Bot respondeu
      if (String(chatId) !== ADMIN_CHAT_ID && respostaSemJson) {
        await sendMessage(ADMIN_CHAT_ID, `🤖 Bot: ${respostaSemJson}`);
      }
    }
  } catch (error) { console.error(error); }
});

app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
