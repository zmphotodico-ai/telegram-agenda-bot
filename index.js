import express from "express";
import fetch from "node-fetch"; // Se usar Node 18+, pode remover essa linha
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CALENDAR_ID = "alugueldeestudiofotografico@gmail.com";
const TIMEZONE = "America/Sao_Paulo";
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "8132670973"; // ID do seu celular para o espião

const conversationMemory = new Map(); // Memória por chat

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
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem no Telegram:", error);
  }
}

// =============================
// PROMPT REAL DO GEMINI (Curto e Objetivo)
// =============================
const SYSTEM_PROMPT = `
Você é o assistente virtual oficial do Aluguel de Estúdio Fotográfico (Bela Vista e Aclimação).

⚠️ REGRAS DE OURO DA COMUNICAÇÃO (OBRIGATÓRIO):
1. Responda de forma EXTREMAMENTE CURTA e objetiva. Clientes não gostam de textos longos.
2. NUNCA envie a tabela de preços inteira de uma vez. Pergunte o que o cliente quer (qual estúdio ou quantas horas) e passe apenas o valor exato.
3. Vá direto ao ponto, como um atendente humano rápido.

INFORMAÇÕES IMPORTANTES:

📍 Endereços:
- Bela Vista: Rua Santa Madalena, 46 - Bela Vista/Liberdade (Estúdios 1, 2 e 3)
- Aclimação: Rua Gualaxo, 206 - Aclimação/Liberdade (Estúdios A, B, C e D)

💰 TABELAS DE PREÇO (por hora):
Bela Vista - Segunda a Sexta (mínimo 2h):
• Est. 1: 1-2p=R$70 | 3-5p=R$80 | 6-8p=R$100
• Est. 2: 1-2p=R$50 | 3-5p=R$60 | 6-8p=R$80
• Est. 3: 1-2p=R$60 | 3-5p=R$70 | 6-8p=R$90

Bela Vista - Fim de semana/Feriado (mínimo 4h):
• Est. 1: 1-2p=R$80 | 3-5p=R$90 | 6-8p=R$110
• Est. 2: 1-2p=R$70 | 3-5p=R$80 | 6-8p=R$100
• Est. 3: 1-2p=R$80 | 3-5p=R$80 | 6-8p=R$100

Aclimação - Segunda a Sexta (mínimo 2h):
• Est. A ou B: 1-2p=R$70 | 3-5p=R$80 | 6-8p=R$100
• A+B juntos: 1-2p=R$100 | 3-5p=R$110 | 6-8p=R$130
• Est. C ou D: 1-2p=R$70 | 3-5p=R$80 | 6-8p=R$100

Aclimação - Fim de semana/Feriado (mínimo 3h):
• Est. A ou B: 1-2p=R$80 | 3-5p=R$90 | 6-8p=R$110
• A+B juntos: 1-2p=R$110 | 3-5p=R$120 | 6-8p=R$140
• Est. C: 1-2p=R$80 | 3-5p=R$90 | 6-8p=R$110
• Est. D: 1-2p=R$80 | 3-5p=R$90 | 6-8p=R$100

REGRAS DO ESTÚDIO:
- Reserva só com pagamento de 1/3 antecipado via PIX.
- Acima de 8 pessoas = valor a combinar.
- Gravação com áudio = obrigatório alugar os 3 estúdios da Bela Vista OU os 2 da Aclimação.
- Estacionamento R$10 por período. Taxa de limpeza R$150 se entregar sujo.
- Não pisar na curva do fundo infinito. Não usar motor-drive.

ITENS INCLUSOS: Fundo branco infinito + 2 flashes ou 2 tochas LED + rádio flash.

Se o cliente confirmar TODOS os dados para agendar (nome, telefone, data, horário, estúdio, quantidade de pessoas e duração), responda APENAS com o JSON abaixo dentro de \`\`\`json ... \`\`\`:
\`\`\`json
{
  "nome": "João Silva",
  "telefone": "11987654321",
  "data": "2026-04-20",
  "hora_inicio": "14:00",
  "duracao_minutos": 180,
  "estudio": "Estúdio 1 - Bela Vista",
  "qtd_pessoas": 3
}
\`\`\`
`;

async function gerarRespostaGemini(chatId, pergunta, historico = []) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  const contentsArray = [{ role: "user", parts: [{ text: SYSTEM_PROMPT }] }];
  
  historico.forEach(msg => {
     contentsArray.push({
         role: msg.role === "user" ? "user" : "model",
         parts: [{ text: msg.content }]
     });
  });

  contentsArray.push({ role: "user", parts: [{ text: `Cliente: ${pergunta}` }] });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: contentsArray }),
    });

    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Desculpe, não entendi. Pode repetir?";
  } catch (error) {
    console.error("Erro Gemini:", error);
    return "⚠️ Minha conexão falhou. Tente novamente em alguns segundos.";
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
        description: `Cliente: ${dados.nome}\nTelefone: ${dados.telefone}\nChatId: ${chatId}\nPessoas: ${dados.qtd_pessoas}\nEstúdio: ${dados.estudio}\nDuração: ${dados.duracao_minutos} min`,
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
// VERIFICAR PRÉ-RESERVAS PENDENTES (a cada 12h)
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
      const nomeMatch = desc.match(/Cliente:\s*(.*)/);

      if (!chatIdMatch) continue;

      const chatId = chatIdMatch[1].trim();
      const nome = nomeMatch ? nomeMatch[1].trim() : "Cliente";

      const criado = new Date(ev.created);
      const horasPassadas = (agora - criado) / 3600000;

      if (horasPassadas >= 12 && horasPassadas < 24) {
        await sendMessage(chatId, `Olá ${nome}, sua pré-reserva ainda está pendente 😊\n\nPara confirmar a data, precisamos do envio do comprovante do PIX.`);
      }

      if (horasPassadas >= 24) {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id });
        await sendMessage(chatId, `⚠️ ${nome}, sua pré-reserva foi cancelada automaticamente por falta do comprovante de pagamento do sinal. Se desejar uma nova data, estou à disposição!`);
      }
    }
  } catch (error) {
    console.error("Erro ao verificar pré-reservas:", error);
  }
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

    // 🕵️ MODO ESPIÃO - Cliente enviou mensagem
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
          const msgSucesso = `✅ *Pré-reserva criada com sucesso!*\nEstúdio: ${dados.estudio}\nData: ${dados.data} às ${dados.hora_inicio}\n\nPara oficializarmos na agenda, faça o pagamento do sinal (1/3 do valor) e envie o comprovante para nosso atendimento humano.\n\n📱 *WhatsApp:* 11 99554-0293\n🔑 *PIX CNPJ:* 43.345.289/0001-93`;
          
          await sendMessage(chatId, msgSucesso);
          
          // 🕵️ MODO ESPIÃO - Bot (Confirmação de Reserva)
          if (String(chatId) !== ADMIN_CHAT_ID) {
            await sendMessage(ADMIN_CHAT_ID, `🎉 *RESERVA FEITA PELO BOT:*\n${msgSucesso}`);
          }

          conversationMemory.set(chatId, []); // Limpa histórico
      } else {
          const msgErro = "❌ Ops! Tive um problema ao salvar na agenda. Pode confirmar o horário de novo?";
          await sendMessage(chatId, msgErro);
          if (String(chatId) !== ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, `🤖 *Bot:* ${msgErro}`);
      }
    } else {
      await sendMessage(chatId, respostaSemJson);
      
      // 🕵️ MODO ESPIÃO - Bot (Conversa Normal)
      if (String(chatId) !== ADMIN_CHAT_ID && respostaSemJson) {
        await sendMessage(ADMIN_CHAT_ID, `🤖 *Bot:* ${respostaSemJson}`);
      }
    }
  } catch (error) {
    console.error("Erro no webhook:", error);
  }
});

// =============================
app.listen(PORT, () => {
  console.log(`🚀 Bot Zemaria rodando na porta ${PORT}`);
});
