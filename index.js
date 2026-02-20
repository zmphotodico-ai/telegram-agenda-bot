import express from "express";

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (message) {
    const chatId = message.chat.id;
    const text = message.text;

    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Você disse: ${text}`
      })
    });
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
