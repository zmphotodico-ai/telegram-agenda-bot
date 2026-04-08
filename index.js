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
// PROMPT REAL DO GEMINI (Dinâmico + Matemática de Preços)
// =============================
async function gerarRespostaGemini(chatId, pergunta, historico = []) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  
  const dataAtual = new Date();
  const dataHojeStr = dataAtual.toLocaleDateString("pt-BR", { timeZone: TIMEZONE });
  const diaSemana = dataAtual.toLocaleDateString("pt-BR", { weekday: 'long', timeZone: TIMEZONE });
  const anoAtual = dataAtual.getFullYear();

  const SYSTEM_PROMPT = `
Você é o assistente virtual oficial do Aluguel de Estúdio Fotográfico (Bela Vista e Aclimação).

⏳ INFORMAÇÃO DE TEMPO E REGRAS DE AGENDA:
- Hoje é ${diaSemana}, ${dataHojeStr}. O ano atual é ${anoAtual}.
- Se o cliente pedir "amanhã", "depois de amanhã" ou um dia da semana (ex: "sexta"), CALCULE A DATA VOCÊ MESMO com base no dia de hoje.
- NUNCA pergunte "qual é a data exata para amanhã". Calcule mentalmente.
- 🕒 HORAS QUEBRADAS: O cliente pode pedir horas quebradas (ex: 2 horas e meia).
- 🛑 REGRA DO INTERVALO: Sempre avise o cliente que é OBRIGATÓRIO ter 30 minutos (meia hora) de intervalo livre entre a reserva dele e qualquer outra que já exista na agenda do estúdio. Peça para ele checar isso nos links da agenda.

⚠️ REGRAS DE OURO DA SUA INTELIGÊNCIA:
1. Respostas CURTAS e OBJETIVAS. Pergunte as coisas de forma natural.
2. VOCÊ FAZ A PRÉ-RESERVA TODOS OS DIAS! Se o pedido for entre as 08:00 e as 21:00 e para ATÉ 8 PESSOAS, recolha os dados e agende.
3. MANDE PARA O WHATSAPP (11 99554-0293) EXCLUSIVAMENTE nestes 3 casos:
   - Mais de 8 pessoas (Responda EXATAMENTE: "Nossa tabela de valores vai somente até 8 pessoas, para mais pessoas por favor entre em contato via WhatsApp 11 99554-0293.").
   - Horários de início antes das 08h ou término depois das 21h.
   - Dúvidas complexas que você não saiba responder.

PASSO A PASSO PARA RESERVAR:
Se o cliente quiser reservar, pergunte o que faltar: Nome completo, Telefone, Data, Horário de Início, Qual Estúdio, Quantidade de Pessoas e Duração (pergunte por "quantidade de horas", "horas e meia" ou "horário de término", nunca peça minutos).
Assim que ele confirmar TUDO, calcule a duração pedida e converta para minutos (ex: 2h = 120). Calcule o VALOR TOTAL multiplicando o preço/hora (com as regras abaixo) pelas horas locadas. Não fale mais nada, apenas gere o JSON:
\`\`\`json
{
  "nome": "João Silva",
  "telefone": "11987654321",
  "data": "YYYY-MM-DD",
  "hora_inicio": "14:00",
  "duracao_minutos": 150,
  "estudio": "Estúdio 1 - Bela Vista",
  "qtd_pessoas": 2,
  "valor_total": 210
}
\`\`\`

📸 DETALHES TÉCNICOS, FOTOS E PLANTAS:
⚠️ Se perguntarem tamanho ou maior estúdio, forneça as medidas, link da foto específica e link do PDF indicando a página. Seja curto.
🔗 PDF Geral: https://drive.google.com/file/d/1J8FC6mzmfkOhlHbRrKVLN92jYj9LF1bb/view?usp=sharing

📍 Unidade Aclimação (Rua Gualaxo, 206)
- Estúdio A (~35m²): 6,3m x 5,6m. Maior individual. Pág 3 do PDF.
  👉 Fotos A: https://drive.google.com/drive/folders/19SQObRdLLXiPw-3p3AfWWHRU0BHxG3BE?usp=drive_link
- Estúdio B (~26m²): 4,7m x 5,6m. Pág 3 do PDF.
  👉 Fotos B: https://drive.google.com/drive/folders/14IJ64PDgfBm-Z1cnB-vlDRxQ5j9NQXYm?usp=drive_link
- Estúdio AB (~61m²): Junção do A+B. Pág 3 do PDF.
  👉 Fotos AB: https://drive.google.com/drive/folders/1vfQ4IU8TCvDyBjMge0xUBKUXNEKxHe8I?usp=drive_link
- Estúdio C (~29m² + Cozinha): 4,3m x 6,7m. Pág 4 do PDF.
  👉 Fotos C: https://drive.google.com/drive/folders/12OHhx9-zh_zPfk8hRr1u8SU55CY3UVld?usp=drive_link
- Estúdio D (~29m² + Camarim): 4,3m x 6,7m. Pág 5 do PDF.
  👉 Fotos D: https://drive.google.com/drive/folders/1D3_KYy--SCczMhx9-qayd0j2v5v0rYwS?usp=drive_link

📍 Unidade Bela Vista (Rua Santa Madalena, 46)
- Estúdio 1 (~37m²): 5,15m x 7,2m. Maior desta unidade. Pág 2 do PDF.
  👉 Fotos 1: https://drive.google.com/drive/folders/1P0Z7xBCZ6gx1OJXZOR_6EWESv3QxIskA?usp=drive_link
- Estúdio 2 (~30m²): 4,2m x 7,2m. Pág 2 do PDF.
  👉 Fotos 2: https://drive.google.com/drive/folders/1LyhVa4Jbtjjgve30AIIuVFuK3GBI1Jzn?usp=drive_link
- Estúdio 3 (~30m²): 4,2m x 7,2m. Pág 2 do PDF.
  👉 Fotos 3: https://drive.google.com/drive/folders/1f0sG3_R6mUKbXBP0TaGNHg_mJ97L3POP?usp=drive_link

📅 AGENDAS ONLINE:
- Bela Vista: https://www.alugueldeestudiofotografico.com/agenda-estudio-belavista/
- Aclimação: https://www.alugueldeestudiofotografico.com/agenda-aluguel-de-estudio/

💰 TABELA DE PREÇOS BASE (Por Hora, para 1-2 pessoas):
- Bela Vista (Seg-Sex, mín 2h): Est.1 R$70 | Est.2 R$50 | Est.3 R$60
- Bela Vista (Fim de semana, mín 4h): Est.1 R$80 | Est.2 R$70 | Est.3 R$80
- Aclimação (Seg-Sex, mín 2h): Est. A, B, C ou D R$70 | A+B R$100
- Aclimação (Fim de semana, mín 3h): Est. A, B, C ou D R$80 | A+B R$110
*REGRAS DE VALOR: Adicione +R$10/hora no valor base se for de 3 a 5 pessoas. Adicione +R$30/hora no valor base se for de 6 a 8 pessoas.

REGRAS GERAIS: Reserva confirmada com PIX de 1/3 do total antecipado. Estacionamento R$10. Limpeza R$150 se sujar.
`;

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
        description: `Cliente: ${dados.nome}\nTelefone: ${dados.telefone}\nChatId: ${chatId}\nPessoas: ${dados.qtd_pessoas}\nEstúdio: ${dados.estudio}\nValor Total: R$${dados.valor_total || 'Não calculado'}`,
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
          // Lógica de Formatação da Mensagem Final
          const start = new Date(`${dados.data}T${dados.hora_inicio}:00-03:00`);
          const end = new Date(start.getTime() + dados.duracao_minutos * 60000);

          const opcoesData = { weekday: 'long', day: 'numeric', month: 'short', timeZone: TIMEZONE };
          const dataFormatada = start.toLocaleDateString("pt-BR", opcoesData).replace(".", "");

          const horaInicioStr = start.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE });
          const horaFimStr = end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE });

          const valorTotal = dados.valor_total || 0;
          const valorSinal = Math.ceil(valorTotal / 3);

          const msgSucesso = `Pré marcado ${dados.estudio} ${dataFormatada} · ${horaInicioStr} – ${horaFimStr}\nreserva para ${dados.qtd_pessoas} pessoas valor total R$${valorTotal}\nPara fazer a reserva pedimos 1/3 r$${valorSinal} antecipado ok?\nPIX/CNPJ\nZmphoto@zmphoto.com.br\n43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
          
          await sendMessage(chatId, msgSucesso);
          if (String(chatId) !== ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID, `🎉 *NOVA RESERVA REGISTRADA NA AGENDA:* \n\n${msgSucesso}`);
          
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
