// =============================
// GEMINI (Atualizado com JSON de Gabarito)
// =============================
async function gerarRespostaGemini(chatId, agendaSemana, pergunta) {
  const model = "gemini-2.5-flash"; 
  const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_KEY}`;

  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: TIMEZONE });

  const promptSistema = `Você é o assistente da Zemaria Produções Fotográficas. Responda de forma CURTA, clara e profissional.

Endereços: Aclimação (Rua Gualaxos 206) | Bela Vista (Rua Santa Madalena 46).

PREÇOS (mín. 2h seg-sex / 3-4h fins de semana):
- Aclimação: 1-2p R$70/h | 3-5p R$80/h | 6-8p R$100/h (A+B +R$30/h)
- Bela Vista: Est.1 R$70/h | Est.2 R$50/h | Est.3 R$60/h
- Diária 12h: cobre 10h efetivas
- >8 pessoas ou madrugadas: Sob consulta (WhatsApp 11 995540293)

Peça 1/3 de sinal via PIX CNPJ 43.345.289/0001-93.

Hoje: ${hoje}
Agenda próxima semana:\n${agendaSemana}
PDF informativo: ${PDF_INFORMATIVO}
Agenda completa: ${LINK_AGENDA}

Só gere o bloco JSON no FINAL quando o cliente confirmar TODOS os dados (nome, estúdio, data, hora, duração, tipo e pessoas).
Use EXATAMENTE este formato abaixo para o JSON:
\`\`\`json
{
  "nome": "Nome do Cliente",
  "data": "2026-05-20",
  "hora_inicio": "14:00",
  "duracao_minutos": 120,
  "tipo_sessao": "Ensaio Fotográfico",
  "estudio": "A",
  "qtd_pessoas": 3
}
\`\`\``;

  let history = conversationMemory.get(chatId) || [];
  history.push(`Cliente: ${pergunta}`);
  if (history.length > MEMORY_LIMIT) history = history.slice(-MEMORY_LIMIT);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${promptSistema}\n\nHistórico:\n${history.join("\n")}` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
      }),
    });

    const data = await res.json();

    if (!res.ok || data.error) {
      console.error("Erro Gemini:", data.error);
      return "Desculpe, estou com dificuldade agora. Pode repetir?";
    }

    let resposta = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Não entendi, pode repetir?";

    // Atualiza memória apenas com texto limpo (sem JSON)
    const cleanReply = resposta.replace(/```json[\s\S]*?```/i, "").trim();
    if (cleanReply) {
      history.push(`Assistente: ${cleanReply}`);
      conversationMemory.set(chatId, history);
    }

    return resposta;
  } catch (err) {
    console.error("Falha Gemini:", err);
    return "Minha conexão com a IA falhou. Tente novamente em alguns segundos.";
  }
}
