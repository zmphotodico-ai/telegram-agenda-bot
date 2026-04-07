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
// FUNÇÃO PARA ENVIAR MENSAGEM (Telegram)
// =============================
async function sendMessage(chatId, text) {
  if (!chatId || !text) return;
  try {
    // O "ESCUDO": Impede que o Telegram quebre a mensagem por causa dos _ nos links
    const textoSeguro = text.replace(/_/g, "\\_");

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: textoSeguro,
        parse_mode: "Markdown",
        disable_web_page_preview: false, 
      }),
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem no Telegram:", error);
  }
}

// =============================
// PROMPT REAL DO GEMINI (Atualizado com Regra de Capacidade)
// =============================
const SYSTEM_PROMPT = `
Você é o assistente virtual oficial do Aluguel de Estúdio Fotográfico (Bela Vista e Aclimação).

⚠️ REGRAS DE OURO:
1. Respostas CURTAS e OBJETIVAS.
2. Use o WhatsApp 11 99554-0293 para fechar a reserva ou dúvidas complexas.
3. Se o cliente perguntar até quantas pessoas pode levar, qual o limite de pessoas ou o tamanho da equipe, responda EXATAMENTE: "Nossa tabela de valores vai somente até 8 pessoas, para mais pessoas por favor entre em contato via WhatsApp 11 99554-0293."

📸 DETALHES TÉCNICOS, FOTOS E PLANTAS (Use para responder sobre tamanhos):
⚠️ Quando o cliente perguntar o tamanho ou maior estúdio, forneça as medidas abaixo, o link da foto do estúdio específico e o link do PDF indicando a página da planta. Seja sempre curto.
🔗 Link do PDF Geral: https://drive.google.com/file/d/1J8FC6mzmfkOhlHbRrKVLN92jYj9LF1bb/view?usp=sharing

📍 Unidade Aclimação (Rua Gualaxo, 206)
- Estúdio A (~35m²): 6,3m de largura x 5,6m de profundidade. É o maior individual da unidade. Planta na Pág 3 do PDF.
  👉 Fotos A: https://drive.google.com/drive/folders/19SQObRdLLXiPw-3p3AfWWHRU0BHxG3BE?usp=drive_link
- Estúdio B (~26m²): 4,7m de largura x 5,6m de profundidade. Planta na Pág 3 do PDF.
  👉 Fotos B: https://drive.google.com/drive/folders/14IJ64PDgfBm-Z1cnB-vlDRxQ5j9NQXYm?usp=drive_link
- Estúdio AB (~61m²): Junção do A+B (11m de largura total). Planta na Pág 3 do PDF.
  👉 Fotos AB: https://drive.google.com/drive/folders/1vfQ4IU8TCvDyBjMge0xUBKUXNEKxHe8I?usp=drive_link
- Estúdio C (~29m² + Cozinha): 4,3m de largura x 6,7m de profundidade, com cozinha anexa. Planta na Pág 4 do PDF.
  👉 Fotos C: https://drive.google.com/drive/folders/12OHhx9-zh_zPfk8hRr1u8SU55CY3UVld?usp=drive_link
- Estúdio D (~29m² + Camarim): 4,3m de largura x 6,7m de profundidade, com camarim anexo. Planta na Pág 5 do PDF.
  👉 Fotos D: https://drive.google.com/drive/folders/1D3_KYy--SCczMhx9-qayd0j2v5v0rYwS?usp=drive_link
*Maior da Aclimação:* Estúdio A (individual) ou a opção AB (combinado).

📍 Unidade Bela Vista (Rua Santa Madalena, 46)
Todos os estúdios têm 7,2m de profundidade.
- Estúdio 1 (~37m²): 5,15m de largura x 7,2m de profundidade. É o maior estúdio desta unidade. Planta na Pág 2 do PDF.
  👉 Fotos 1: https://drive.google.com/drive/folders/1P0Z7xBCZ6gx1OJXZOR_6EWESv3QxIskA?usp=drive_link
- Estúdio 2 (~30m²): 4,2m de largura x 7,2m de profundidade. Planta na Pág 2 do PDF.
  👉 Fotos 2: https://drive.google.com/drive/folders/1LyhVa4Jbtjjgve30AIIuVFuK3GBI1Jzn?usp=drive_link
- Estúdio 3 (~30m²): 4,2m de largura x 7,2m de profundidade. Planta na Pág 2 do PDF.
  👉 Fotos 3: https://drive.google.com/drive/folders/1f0sG3_R6mUKbXBP0TaGNHg_mJ97L3POP?usp=drive_link
*Maior da Bela Vista:* Estúdio 1.

📅 AGENDAS ONLINE (Para ver horários livres):
- Bela Vista: https://www.alugueldeestudiofotografico.com/agenda-estudio-belavista/
- Aclimação: https://www.alugueldeestudiofotografico.com/agenda-aluguel-de-estudio/

💰 PREÇOS BASE (Seg-Sex):
Bela Vista: Est.1 R$70/h | Est.2 R$50/h | Est.3 R$60/h (mín. 2h)
Aclimação: Est. A, B, C ou D R$70/h | A+B R$100/h (mín. 2h)
*Valores sobem progressivamente até 8 pessoas. Para finais de semana, consulte o humano.

REGRAS: Reserva com 1/3 antecipado via PIX. Estacionamento R$10. Limpeza R$150 se sujar.

Se o cliente fechar os dados, gere o JSON:
\`\`\`json
{
  "nome": "João Silva",
  "telefone": "11987654321",
  "data": "2026-04-20",
  "hora_inicio": "14:00",
  "duracao_minutos": 120,
  "estudio": "Estúdio 1 - Bela Vista",
  "qtd_pessoas": 2
}
\`\`\`
`;

async function gerarRespostaGemini(chatId, pergunta, historico = []) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  
  const historicoTexto = historico.map(msg => 
    `${msg.role === 'user' ? 'Cliente' : 'Assistente'}: ${msg.content}`
  ).join('\n');

  const promptCompleto = `${SYSTEM_PROMPT}\n\n[HISTÓRICO]\n${historicoTexto}\n\nCliente: ${pergunta}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: [{ parts: [{ text: promptCompleto }] }],
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" }
        ]
      }),
    });

    const data = await res.json();
    
    if (data.error) {
      console.error("Erro da API Gemini:", data.error);
      if (ADMIN_CHAT_ID) {
        await sendMessage(ADMIN_CHAT_ID, `⚠️ *ERRO NA INTELIGÊNCIA ARTIFICIAL:*\n\`${data.error.message}\``);
      }
      return "Estou passando por uma pequena instabilidade de sistema. Pode tentar novamente em 1 minuto?";
    }

    if (!data.candidates || data.candidates.length === 0) {
      if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, `⚠️ *ALERTA:* O Google bloqueou a resposta por causa do Filtro de Segurança.`);
      return "Desculpe, não consegui formular a resposta para isso. Pode perguntar de outra forma?";
    }

    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error("Erro Gemini (Fetch):", error);
    return "⚠️ Minha conexão falhou. Tente novamente.";
  }
}

// =============================
// CRIAR EVENTO NO GOOGLE CALENDAR
// =============================
async function criarEvento(dados, chatId) {
  try {
    const start = new Date(`${dados.data}T${dados.hora_inicio}:00-03:00`);
    const end = new Date(start.getTime() + dados.duracao_minutos * 60000);
    const horaFim = end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: {
        summary: `${dados.hora_inicio}-${horaFim} / ${dados.estudio} PRE`,
        description: `Cliente: ${dados.nome}\nTelefone: ${dados.telefone}\nChatId: ${chatId}\nPessoas: ${dados.qtd_pessoas}\nEstúdio: ${dados.estudio}`,
        start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
        end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
      },
    });

    return response.data.id;
  } catch (error) {
    console.error("Erro ao criar evento:", error);
    return null;
  }
}

// =============================
// VERIFICAR PRÉ-RESERVAS (a cada 12h)
// =============================
async function verificarPreReservas() {
  const agora = new Date();
  try {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: new Date(agora.getTime() - 48 * 60 * 60 * 1000).toISOString(),
      timeMax: agora.toISOString(),
      singleEvents: true,
    });

    for (const ev of res.data.items || []) {
      if (!ev.summary?.includes("PRE")) continue;
      const desc = ev.description || "";
      const chatIdMatch = desc.match(/ChatId:\s*(.*)/);
      if (!chatIdMatch) continue;

      const chatId = chatIdMatch[1].trim();
      const criado = new Date(ev.created);
      const horasPassadas = (agora - criado) / 3600000;

      if (horasPassadas >= 12 && horasPassadas < 24) {
        await sendMessage(chatId, `Sua pré-reserva está pendente 😊 Precisamos do PIX para confirmar.`);
      }
      if (horasPassadas >= 24) {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id });
        await sendMessage(chatId, `⚠️ Pré-reserva cancelada por falta de pagamento.`);
      }
    }
  } catch (error) { console.error(error); }
}
setInterval(verificarPreReservas, 12 * 60 * 60 * 1000);

// =============================
// WEBHOOK
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
      await sendMessage(ADMIN_CHAT_ID, `👤 *${nomeUsuario}:* ${texto}`);
    }

    if (!conversationMemory.has(chatId)) conversationMemory.set(chatId, []);
    const historico = conversationMemory.get(chatId);

    const resposta = await gerarRespostaGemini(chatId, texto, historico);

    historico.push({ role: "user", content: texto });
    const respostaSemJson = resposta.replace(/```json[\s\S]*?```/i, "").trim();
    if(respostaSemJson) {
         historico.push({ role: "model", content: respostaSemJson });
    }
    
    if (historico.length > 10) conversationMemory.set(chatId, historico.slice(-10));

    const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/);

    if (jsonMatch) {
      const dados = JSON.parse(jsonMatch[1]);
      await sendMessage(chatId, "Verificando a agenda... ⏳");
      const eventId = await criarEvento(dados, chatId);

      if(eventId) {
          const msgSucesso = `✅ *Pré-reserva criada!*\nEstúdio: ${dados.estudio}\nData: ${dados.data} às ${dados.hora_inicio}\n\nPIX (1/3): 43.345.289/0001-93\nWhatsApp: 11 99554-0293`;
          await sendMessage(chatId, msgSucesso);
          if (String(chatId) !== ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, `🎉 *RESERVA:* ${msgSucesso}`);
          conversationMemory.set(chatId, []); 
      } else {
          await sendMessage(chatId, "Erro ao salvar na agenda.");
      }
    } else {
      await sendMessage(chatId, respostaSemJson);
      // 🕵️ MODO ESPIÃO - Bot respondeu
      if (String(chatId) !== ADMIN_CHAT_ID && respostaSemJson) {
        await sendMessage(ADMIN_CHAT_ID, `🤖 *Bot:* ${respostaSemJson}`);
      }
    }
  } catch (error) { console.error(error); }
});

app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
