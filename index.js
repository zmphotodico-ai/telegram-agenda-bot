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
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: false, 
      }),
    });
  } catch (error) {
    console.error("Erro ao enviar mensagem no Telegram:", error);
  }
}

// =============================
// PROMPT REAL DO GEMINI (Atualizado com Fotos e Agendas)
// =============================
const SYSTEM_PROMPT = `
Você é o assistente virtual oficial do Aluguel de Estúdio Fotográfico (Bela Vista e Aclimação).

⚠️ REGRAS DE OURO:
1. Respostas CURTAS e OBJETIVAS.
2. Se o cliente pedir fotos, envie o link do estúdio específico que ele perguntou. Se for geral, mande os links gerais.
3. Use o WhatsApp 11 99554-0293 para fechar a reserva ou dúvidas complexas.

📸 LINKS DE FOTOS (Envie apenas o solicitado):
- Aclimação (Geral): https://drive.google.com/drive/folders/100GPqd9sWFRtEE5YPZCYhyv_DkBNV_G9?usp=drive_link
  • Estúdio A: https://drive.google.com/drive/folders/19SQObRdLLXiPw-3p3AfWWHRU0BHxG3BE?usp=drive_link
  • Estúdio B: https://drive.google.com/drive/folders/14IJ64PDgfBm-Z1cnB-vlDRxQ5j9NQXYm?usp=drive_link
  • Estúdio AB: https://drive.google.com/drive/folders/1vfQ4IU8TCvDyBjMge0xUBKUXNEKxHe8I?usp=drive_link
  • Estúdio C: https://drive.google.com/drive/folders/12OHhx9-zh_zPfk8hRr1u8SU55CY3UVld?usp=drive_link
  • Estúdio D: https://drive.google.com/drive/folders/1D3_KYy--SCczMhx9-qayd0j2v5v0rYwS?usp=drive_link

- Bela Vista (Geral): https://drive.google.com/drive/folders/1Navk6o2Gy9cDlD9FKAuizH8hd3nTMLEW?usp=drive_link
  • Estúdio 1: https://drive.google.com/drive/folders/1P0Z7xBCZ6gx1OJXZOR_6EWESv3QxIskA?usp=drive_link
  • Estúdio 2: https://drive.google.com/drive/folders/1LyhVa4Jbtjjgve30AIIuVFuK3GBI1Jzn?usp=drive_link
  • Estúdio 3: https://drive.google.com/drive/folders/1f0sG3_R6mUKbXBP0TaGNHg_mJ97L3POP?usp=drive_link

📅 AGENDAS ONLINE (Para ver horários livres):
- Bela Vista: https://www.alugueldeestudiofotografico.com/agenda-estudio-belavista/
- Aclimação: https://www.alugueldeestudiofotografico.com/agenda-aluguel-de-estudio/

📍 Endereços:
- Bela Vista: Rua Santa Madalena, 46.
- Aclimação: Rua Gualaxo, 206.

💰 PREÇOS BASE (Seg-Sex):
Bela Vista: Est.1 R$70/h | Est.2 R$50/h | Est.3 R$60/h (mín. 2h)
Aclimação: Est. A, B, C ou D R$70/h | A+B R$100/h (mín. 2h)
*Valores para 1-2 pessoas. Finais de semana e mais pessoas, consulte.

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
  
  // Monta a memória em formato de texto à prova de falhas
  const historicoTexto = historico.map(msg => 
    `${msg.role === 'user' ? 'Cliente' : 'Assistente'}: ${msg.content}`
  ).join('\n');

  const promptCompleto = `${SYSTEM_PROMPT}\n\n[HISTÓRICO]\n${historicoTexto}\n\nCliente: ${pergunta}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        contents: [{ parts: [{ text: promptCompleto }] }] 
      }),
    });

    const data = await res.json();
    
    if (data.error) {
      console.error("Erro da API Gemini:", data.error);
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Desculpe, não entendi. Pode repetir?";
  } catch (error) {
    console.error("Erro Gemini:", error);
    return "⚠️ Conexão falhou. Tente novamente.";
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
