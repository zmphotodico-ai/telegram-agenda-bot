import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
// Carrega as credenciais do Google que você colou no Railway
const GOOGLE_CONFIG = JSON.parse(process.env.GOOGLE_CONFIG);

app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const textoDoCliente = message.text || "";

  try {
    // Chamada ao Gemini para processar a conversa
    const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
    
    const geminiReq = await fetch(urlGemini, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "Você é o assistente do fotógrafo Dionizio. Se o cliente quiser agendar, peça o dia e hora. Você verificará a agenda dele no Google Calendar." }]
        },
        contents: [{ parts: [{ text: textoDoCliente }] }]
      })
    });
    
    const geminiRes = await geminiReq.json();
    const respostaDaIA = geminiRes.candidates?.[0].content.parts[0].text || "Estou com uma pequena instabilidade, tente novamente.";

    // Envia a resposta para o Telegram
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: respostaDaIA })
    });

  } catch (e) {
     console.error("❌ Erro no servidor:", e);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor ativo na porta ${PORT}`);
});
