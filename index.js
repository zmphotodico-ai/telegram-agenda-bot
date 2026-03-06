import express from "express";
import fetch from "node-fetch"; // Adicionado para suportar fetch no Node.js
import { google } from "googleapis";

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CALENDAR_ID = "zmphoto@zmphoto.com.br";

// =============================
// GOOGLE CALENDAR CONFIG
// =============================
let GOOGLE_CONFIG;
try {
  GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);
  GOOGLE_CONFIG.private_key = GOOGLE_CONFIG.private_key.replace(/\\n/g, "\n");
} catch (err) {
  console.error("Erro ao carregar GOOGLE_CONFIG", err);
  process.exit(1);
}

const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email,
  null,
  GOOGLE_CONFIG.private_key,
  ["https://www.googleapis.com/auth/calendar"]
);
const calendar = google.calendar({ version: "v3", auth });

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
    console.error("Erro ao buscar agenda", err);
    return "Não consegui consultar a agenda.";
  }
}

// =============================
// ENVIAR MENSAGEM TELEGRAM
// =============================
async function sendMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  // Tenta enviar até 3 vezes caso a internet oscile
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: text })
      });
      if (res.ok) return;
      await new Promise(r => setTimeout(r, 800)); // Espera quase 1 segundo para tentar de novo
    } catch (e) {}
  }
}

// =============================
// VERIFICAR DISPONIBILIDADE (Nova função para evitar sobreposições)
// =============================
async function verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos) {
  try {
    const startDate = new Date(`${dataStr}T${horaInicio}:00`);
    startDate.setMinutes(startDate.getMinutes() - 3 * 60); // Ajuste para fuso -03:00, mas usando timeZone no Google
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60000);
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      timeZone: "America/Sao_Paulo"
    });
    return res.data.items.length === 0; // True se disponível
  } catch (err) {
    console.error("Erro ao verificar disponibilidade", err);
    return false;
  }
}

// =============================
// CRIAR EVENTO
// =============================
async function criarEventoGoogleCalendar(nome, dataStr, horaInicio, duracaoMinutos, tipoSessao) {
  try {
    // Validações básicas
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) throw new Error("Formato de data inválido (deve ser AAAA-MM-DD)");
    if (!/^\d{2}:\d{2}$/.test(horaInicio)) throw new Error("Formato de hora inválido (deve ser HH:MM)");
    duracaoMinutos = Number(duracaoMinutos) || 60;
    if (duracaoMinutos <= 0) throw new Error("Duração inválida");

    // Verifica disponibilidade
    const disponivel = await verificarDisponibilidade(dataStr, horaInicio, duracaoMinutos);
    if (!disponivel) {
      return { success: false, message: "Horário indisponível (sobreposição detectada)" };
    }

    const startDate = new Date(`${dataStr}T${horaInicio}:00`);
    const endDate = new Date(startDate.getTime() + duracaoMinutos * 60000);
    const event = {
      summary: `${tipoSessao} - ${nome}`,
      start: { dateTime: startDate.toISOString(), timeZone: "America/Sao_Paulo" },
      end: { dateTime: endDate.toISOString(), timeZone: "America/Sao_Paulo" }
    };
    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event
    });
    return { success: true, link: response.data.htmlLink };
  } catch (err) {
    console.error("Erro ao criar evento", err);
    return { success: false, message: err.message };
  }
}

// =============================
// GEMINI IA
// =============================
async function gerarRespostaGemini(agendaHoje, pergunta) {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`; // Atualizado para v1
  const hoje = new Date().toLocaleDateString("pt-BR");
  const prompt = `Você é o assistente de agendamento do fotógrafo Dionizio.
Hoje é: ${hoje}
Agenda atual:
${agendaHoje}
REGRAS
- Sempre responda de forma amigável e profissional.
- Para agendar, confirme todos os detalhes com o cliente antes de prosseguir.
- Peça explicitamente:
  1. data (AAAA-MM-DD)
  2. hora inicial (HH:MM)
  3. nome completo
  4. tipo de sessão (ex: ensaio fotográfico, evento)
- Só envie o bloco JSON quando o cliente confirmar TODOS os dados e você tiver certeza de que está tudo correto.
- Nunca invente dados; use apenas o que o cliente forneceu.
- No FINAL da mensagem, se for para agendar, escreva EXATAMENTE o bloco abaixo com os dados preenchidos (sem texto extra depois):
\`\`\`json
{
 "nome":"Nome Cliente",
 "data":"AAAA-MM-DD",
 "hora_inicio":"HH:MM",
 "duracao_minutos":60,
 "tipo_sessao":"Tipo"
}
\`\`\``;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt + "\nCliente: " + pergunta }] }],
        generationConfig: { temperature: 0.1 }
      })
    });
    const data = await res.json();
    if (data.error) {
      console.error("Erro Gemini:", data.error);
      return "Tive um problema na minha inteligência agora. Pode repetir?";
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Pode repetir?";
  } catch (err) {
    console.error("Falha Gemini:", err);
    return "Minha conexão falhou agora.";
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
    let resposta = await gerarRespostaGemini(agenda, texto);

    // Procura o comando secreto de agendamento (regex mais robusta)
    const jsonMatch = resposta.match(/```json\s*([\s\S]*?)\s*```/i); // Ignora case e captura melhor
    if (jsonMatch) {
      try {
        const dados = JSON.parse(jsonMatch[1]);

        // Remove o bloco JSON da resposta que vai pro cliente
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
        } else {
          await sendMessage(chatId, `❌ Ops! Não consegui salvar na agenda. Motivo: ${resultado.message || "Erro desconhecido"}.`);
        }
        return; // Encerra para não mandar duplicado
      } catch (jsonError) {
        console.error("Erro ao ler os dados do Gemini:", jsonError);
        // Ignora o bloco e responde o texto normal
      }
    }
    await sendMessage(chatId, resposta);
  } catch (err) {
    console.error("Erro geral:", err);
    await sendMessage(chatId, "Tive um erro interno. Pode tentar de novo?");
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT} 🚀`);
});
