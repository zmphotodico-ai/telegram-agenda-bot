import express from "express";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const textoDoCliente = message.text || "";

  let respostaDaIA = "Desculpe, estou processando...";

  // 1. Enviando a mensagem do cliente para o Gemini pensar
  try {
    const geminiReq = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "Você é o assistente virtual do estúdio fotográfico do Dionizio. Seja muito educado, simpático e prestativo. Ajude a tirar dúvidas sobre ensaios. Responda de forma curta, natural e amigável." }]
        },
        contents: [
          {
            parts: [{ text: textoDoCliente }]
          }
        ]
      })
    });
    
    const geminiRes = await geminiReq.json();
    
    // Capturando a resposta do Gemini
    if (geminiRes.candidates && geminiRes.candidates.length > 0) {
        respostaDaIA = geminiRes.candidates[0].content.parts[0].text;
    } else {
        console.error("❌ Erro Gemini:", geminiRes);
        respostaDaIA = "Deu um errinho aqui na minha inteligência, tente de novo!";
    }
  } catch (e) {
     console.error("❌ Falha na comunicação com a IA:", e);
  }

  // 2. Enviando a resposta inteligente de volta para o Telegram
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: respostaDaIA
      })
    });
  } catch (erro) {
    console.error("❌ ERRO AO ENVIAR PARA O TELEGRAM:", erro);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta " + PORT);
});
