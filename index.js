import express from "express";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;

  try {
    const respostaTelegram = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: "Bot funcionando."
      })
    });

    // Aqui está o segredo: vamos ler o que o Telegram respondeu!
    const dados = await respostaTelegram.json();

    if (!respostaTelegram.ok) {
      console.error("❌ ERRO DO TELEGRAM:", dados);
    } else {
      console.log("✅ Mensagem enviada com sucesso!");
    }

  } catch (erro) {
    console.error("❌ ERRO NO SERVIDOR:", erro);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Servidor rodando na porta " + PORT);
});
