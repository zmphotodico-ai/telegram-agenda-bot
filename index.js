import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);

// Configuração de Autenticação com a Agenda
const auth = new google.auth.JWT(
  GOOGLE_CONFIG.client_email,
  null,
  GOOGLE_CONFIG.private_key,
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({ version: 'v3', auth });

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const textoDoCliente = message.text || "";

  try {
    // Chamando o Gemini 1.5 Flash (Versão Estável)
    const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    
    const geminiReq = await fetch(urlGemini, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "Você é o assistente do Dionizio. Ajude a marcar ensaios. Se o cliente pedir horário, responda que você vai verificar a disponibilidade." }]
        },
        contents: [{ parts: [{ text: textoDoCliente }] }]
      })
    });
    
    const geminiRes = await geminiReq.json();
    const respostaDaIA = geminiRes.candidates?.[0].content.parts[0].text || "Só um instante, estou verificando...";

    // Enviar resposta para o Telegram
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: respostaDaIA })
    });

  } catch (e) {
     console.error("❌ Erro:", e);
  }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor pronto na porta ${PORT}`));
