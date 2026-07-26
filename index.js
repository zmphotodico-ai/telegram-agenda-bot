import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import cron from "node-cron";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ID da agenda padrão (usado só se CALENDAR_IDS não estiver definido)
const CALENDAR_ID = process.env.CALENDAR_ID || "alugueldeestudiofotografico@gmail.com";

// ✅ lê UMA ou MAIS agendas.
// No Railway, defina a variável CALENDAR_IDS com os IDs separados por vírgula.
// Ex.: id-da-aclimacao@group.calendar.google.com, id-da-belavista@group.calendar.google.com
const CALENDAR_IDS = (process.env.CALENDAR_IDS || CALENDAR_ID)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Chat ID (numérico, do Telegram) do admin principal (Dionizio)
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";

// Chat IDs (numéricos, separados por vírgula) da equipe autorizada a usar TODOS os comandos.
// Esse bot é 100% interno — só a equipe fala com ele, nunca o cliente.
const AGENDADORES = (process.env.AGENDADORES || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Para onde vai o relatório diário automático das 8h
const CHAT_MATINAL = process.env.CHAT_MATINAL || ADMIN_CHAT_ID;

// no Telegram, TODO MUNDO que fala com o bot é equipe (ele não atende cliente) —
// então qualquer comando funciona pra admin ou agendadores
function podeAgendar(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID) || AGENDADORES.includes(String(chatId));
}

// 🎛️ VARIÁVEL DE CONTROLE
// Começa DESLIGADO de propósito: o robô sobe e lê a agenda, mas NÃO responde
// sozinho no chat livre. Para ligar o respondedor Gemini, mande "!ativar".
let botAtivo = false;

// =============================
// GOOGLE CALENDAR
// =============================
let calendar;
try {
  const googleConfig = JSON.parse(process.env.GOOGLE_CONFIG);
  const privateKey = googleConfig.private_key.replace(/\\n/g, "\n");
  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: googleConfig.client_email, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  calendar = google.calendar({ version: "v3", auth });
} catch (error) { console.error("Erro Calendar:", error); }

// =============================
// GOOGLE CONTATOS (People API) — busca telefone pelo nome nos contatos do zmphoto@zmphoto.com.br
// =============================
let peopleClient;
try {
  const googleContatosConfig = JSON.parse(process.env.GOOGLE_CONTATOS_CONFIG);
  const privateKeyContatos = googleContatosConfig.private_key.replace(/\\n/g, "\n");
  const authContatos = new google.auth.JWT({
    email: googleContatosConfig.client_email,
    key: privateKeyContatos,
    scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
    subject: "zmphoto@zmphoto.com.br", // delegação em todo o domínio: age como esse usuário
  });
  peopleClient = google.people({ version: "v1", auth: authContatos });
} catch (error) { console.error("Erro People API (contatos):", error); }

// =============================
// CONEXÃO TELEGRAM — via webhook (sem cliente, sem QR, sem Puppeteer)
// =============================
async function sendMessage(chatId, text) {
  if (!chatId || !text) return false;
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    const data = await res.json();
    if (!data.ok) {
      // tenta de novo sem Markdown (às vezes o texto tem caracteres que quebram a formatação)
      const res2 = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      const data2 = await res2.json();
      return !!data2.ok;
    }
    return true;
  } catch (e) {
    console.error(`Erro ao enviar para ${chatId}:`, e.message);
    return false;
  }
}

// pausa (em milissegundos) — usada para espaçar o envio de várias mensagens
function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// gera as variantes possíveis de um telefone brasileiro (com e sem o 9º dígito extra)
// resolve o caso de contatos com WhatsApp cadastrado no formato antigo (8 dígitos locais)
function variantesTelefone(tel) {
  if (!tel || tel.length < 12) return [tel];
  const cc = tel.slice(0, 2);   // "55"
  const ddd = tel.slice(2, 4);  // DDD
  const resto = tel.slice(4);   // número local
  const variantes = new Set([tel]);
  if (resto.length === 9 && resto[0] === "9") {
    variantes.add(cc + ddd + resto.slice(1)); // remove o 9 extra -> formato antigo (8 dígitos)
  } else if (resto.length === 8) {
    variantes.add(cc + ddd + "9" + resto); // adiciona o 9 -> formato novo (9 dígitos)
  }
  return Array.from(variantes);
}

// monta um link "clique para conversar" do WhatsApp, com a mensagem já preenchida.
// a equipe só precisa tocar, conferir e apertar Enviar — nada é mandado automaticamente.
function linkWhatsApp(telefone, texto) {
  const numero = (telefone || "").replace(/\D/g, "");
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

// ✅ NOVO: lê TODAS as agendas de CALENDAR_IDS, junta e ordena por horário
async function getAgendaOcupada() {
  try {
    const agora = new Date();
    const limite = new Date(agora.getTime() + 15 * 24 * 60 * 60 * 1000);
    let todos = [];

    for (const calId of CALENDAR_IDS) {
      try {
        const res = await calendar.events.list({
          calendarId: calId,
          timeMin: agora.toISOString(),
          timeMax: limite.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
        });
        if (res.data.items) todos = todos.concat(res.data.items);
      } catch (e) {
        console.error(`Erro ao ler a agenda ${calId}:`, e.message);
      }
    }

    if (todos.length === 0) return "Agenda livre.";

    todos.sort((a, b) =>
      new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date)
    );

    return todos.map(ev => {
      const inicio = new Date(ev.start.dateTime || ev.start.date);
      const fim = new Date(ev.end.dateTime || ev.end.date);
      return `- ${inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })} das ${inicio.toLocaleTimeString("pt-BR", {timeZone: "America/Sao_Paulo", hour:'2-digit', minute:'2-digit'})} às ${fim.toLocaleTimeString("pt-BR", {timeZone: "America/Sao_Paulo", hour:'2-digit', minute:'2-digit'})} (${ev.summary})`;
    }).join("\n");
  } catch (e) { return "Erro ao ler as agendas."; }
}

// =============================
// MODO ENSAIO — CONFIRMAÇÃO (manda só pro admin, nunca pro cliente)
// =============================

// tira acentos e deixa minúsculo, pra facilitar a busca
function normalizar(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// tenta achar um telefone brasileiro dentro do texto do evento
function extrairTelefone(texto) {
  if (!texto) return null;
  const m = texto.match(/(?:\+?55\s?)?\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}/);
  if (!m) return null;
  let num = m[0].replace(/\D/g, "");
  if (num.length <= 11) num = "55" + num; // adiciona o código do Brasil se faltar
  return num;
}

// extrai o nome do cliente da descrição (primeira palavra/nome, ignorando "Aluguel", hashtags e telefone)
function extrairNome(ev) {
  let desc = (ev.description || "").split("\n")[0].trim();
  if (!desc) return null;
  desc = desc.replace(/#/g, " ");                 // remove hashtags
  desc = desc.replace(/\baluguel\b/gi, " ");      // remove a palavra "Aluguel" em qualquer lugar
  desc = desc.replace(/\s*(\+?55)?[\s(]*\d{2}[\s).-]*\d.*$/, ""); // corta a partir do telefone
  desc = desc.replace(/\s*R\$.*/i, "");           // tira preço, se estiver junto
  desc = desc.replace(/\s+/g, " ").trim();
  return desc || null;
}

// extrai o estúdio do título, mesmo com bagunça (pré, barras, espaços).
// Estúdios válidos: AB, A, B, C, D (Aclimação) e 1, 2, 3 (Bela Vista).
function extrairEstudio(ev) {
  let t = (ev.summary || "").toUpperCase();
  // remove qualquer variação de "pré/pre/pré pré"
  t = t.replace(/PR[EÉ]/g, " ");
  // remove tudo que parece horário (ex.: 19:30-22:30, 10/18, 08-20)
  t = t.replace(/\d{1,2}\s*[:.]?\s*\d{0,2}\s*[-–/]\s*\d{1,2}\s*[:.]?\s*\d{0,2}/g, " ");
  // troca barras, asteriscos e outros símbolos por espaço e limpa
  t = t.replace(/[\/*#.\-–]/g, " ").replace(/\s+/g, " ").trim();
  // procura o estúdio como palavra isolada, na ordem (AB antes de A/B)
  const candidatos = ["AB", "A", "B", "C", "D", "1", "2", "3"];
  const tokens = t.split(" ").filter(Boolean);
  for (const c of candidatos) {
    if (tokens.includes(c)) return c;
  }
  return null; // não reconhecido
}

// ============================================================
// 🆕 FORMATADORES DE EXIBIÇÃO (agenda/vagos legíveis)
// ============================================================

// transforma o código do estúdio em algo legível: "Estúdio B (Aclimação)"
function rotuloEstudioCodigo(est) {
  if (!est) return "Estúdio não identificado";
  const ag = agendaDoEstudio(est);
  return ag ? `Estúdio ${est} (${ag.unidade})` : `Estúdio ${est}`;
}

// mesmo rótulo, mas a partir do evento (extrai o estúdio do título)
function rotuloEstudioEvento(ev) {
  return rotuloEstudioCodigo(extrairEstudio(ev));
}

// formata uma lista de eventos agrupada por dia:
// 📅 sábado, 26/07
//   08:30–17:00 · Estúdio 1 (Bela Vista)
function formatarAgendaPorDia(eventos) {
  const grupos = {};
  for (const ev of eventos) {
    const ini = new Date(ev.start.dateTime || ev.start.date);
    const chave = ini.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
    (grupos[chave] = grupos[chave] || []).push(ev);
  }
  return Object.keys(grupos).sort().map(chave => {
    const doDia = grupos[chave].sort((a, b) =>
      new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date));
    const ini0 = new Date(doDia[0].start.dateTime || doDia[0].start.date);
    const cabecalho = ini0.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit" });
    const linhas = doDia.map(ev => {
      const ei = new Date(ev.start.dateTime || ev.start.date);
      const ef = new Date(ev.end.dateTime || ev.end.date);
      const hi = ei.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
      const hf = ef.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
      return `  ${hi}–${hf} · ${rotuloEstudioEvento(ev)}`;
    }).join("\n");
    return `📅 *${cabecalho}*\n${linhas}`;
  }).join("\n\n");
}

// TABELA DE VALORES POR HORA — faixa fixa de 3 a 5 pessoas
// (o restante é cobrado no dia). semana = seg-sex | fds = sáb, dom e feriado
const TABELA_PRECOS = {
  aclimacao: {
    semana: { A: 80, B: 80, C: 80, D: 80, AB: 110 },
    fds:    { A: 90, B: 90, C: 90, D: 90, AB: 120 },
  },
  belavista: {
    semana: { "1": 80, "2": 60, "3": 70 },
    fds:    { "1": 90, "2": 80, "3": 80 },
  },
};

// calcula total e sinal a partir do evento. Retorna null se não achar o preço.
function calcularValores(ev, ehAclimacao) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const horas = (fim - inicio) / (1000 * 60 * 60);
  if (!horas || horas <= 0) return null;

  // dia da semana no fuso de SP
  const diaTxt = inicio.toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const ehFimDeSemana = (diaTxt === "Sat" || diaTxt === "Sun");
  const periodo = ehFimDeSemana ? "fds" : "semana";

  const unidade = ehAclimacao ? "aclimacao" : "belavista";
  const estudioBruto = extrairEstudio(ev).toUpperCase().replace(/\s/g, "");
  const valorHora = TABELA_PRECOS[unidade][periodo][estudioBruto];
  if (!valorHora) return null; // estúdio não reconhecido na tabela

  const total = Math.round(horas * valorHora);
  let sinal = Math.floor((total / 3) / 10) * 10; // arredonda pra baixo, múltiplo de 10
  if (sinal < 50) sinal = 50; // sinal mínimo
  return { total, sinal };
}

// monta a mensagem que seria enviada ao cliente
// calId indica de qual agenda o evento veio (para escolher o endereço da unidade)
function montarMensagemConfirmacao(ev, calId) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const dataExtenso = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: 'numeric', month: 'long' });
  const horaInicio = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const horaFim = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");

  // a PRIMEIRA agenda de CALENDAR_IDS é a Aclimação; a segunda é a Bela Vista
  const ehAclimacao = (CALENDAR_IDS[0] === calId);
  const endereco = ehAclimacao ? "Rua Gualaxo, 206 - Aclimação" : "Rua Santa Madalena, 46 - Bela Vista";
  const estudio = extrairEstudio(ev);
  const textoEstudio = estudio ? `, no Estúdio ${estudio}` : "";
  const nome = extrairNome(ev);
  const saudacao = nome ? `Olá ${nome}, tudo bem? 😊` : "Olá, tudo bem? 😊";

  const valores = calcularValores(ev, ehAclimacao);
  const linhaValor = valores
    ? `\n\nSinal para reservar: R$ ${valores.sinal}`
    : "";

  return `${saudacao}\nGostaria de confirmar o Aluguel de Estúdio ${dataExtenso}, das ${horaInicio} às ${horaFim}${textoEstudio}.\n${endereco}${linhaValor}\n\nPIX/CNPJ\nzmphoto@zmphoto.com.br\n43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
}

// procura eventos marcados como "pré" nas agendas de COBRANÇA
// (ignora a agenda de Cancelados, que é a 3ª em CALENDAR_IDS)
async function coletarEventosPre(diasFrente = 360) {
  const agora = new Date();
  const limite = new Date(agora.getTime() + diasFrente * 24 * 60 * 60 * 1000);
  let achados = [];
  // só as duas primeiras agendas (Aclimação e Bela Vista). A 3ª (Cancelados) é ignorada.
  const agendasCobranca = CALENDAR_IDS.slice(0, 2);
  for (const calId of agendasCobranca) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: agora.toISOString(),
        timeMax: limite.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      for (const ev of (res.data.items || [])) {
        const alvo = normalizar((ev.summary || "") + " " + (ev.description || ""));
        // pula clientes com combinado diferente (marcados com zm, #zm, # zm, ZM...)
        if (/#?\s*\bzm\b/.test(alvo)) continue;
        // pula reservas já confirmadas como pagas via !confirmarpagamento
        if (/\[pago\b/.test(alvo)) continue;
        if (/\bpre\b/.test(alvo)) { // considera "pré" quando aparece como palavra
          achados.push({ ev, calId });
        }
      }
    } catch (e) { console.error(`Erro ao ler a agenda ${calId}:`, e.message); }
  }
  return achados;
}

// lista as reservas "pré" que estão SEM telefone, pra facilitar o preenchimento
async function listarSemTelefone(destino = ADMIN_CHAT_ID) {
  const achados = await coletarEventosPre(360);
  const semTel = [];
  for (const { ev } of achados) {
    const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
    if (!tel) semTel.push(ev);
  }
  if (semTel.length === 0) {
    await sendMessage(destino, "✅ Todas as reservas 'pré' já têm telefone. Nada a preencher!");
    return;
  }
  let msg = `📵 ${semTel.length} reserva(s) 'pré' SEM telefone (preencher na descrição):\n`;
  for (const ev of semTel) {
    const inicio = new Date(ev.start.dateTime || ev.start.date);
    const data = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const hora = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
    msg += `\n━━━━━━\n📌 ${ev.summary || "(sem título)"}\n🗓️ ${data} às ${hora}\n👤 ${extrairNome(ev) || "(sem nome)"}`;
  }
  await sendMessage(destino, msg);
}

// monta uma linha curta de uma reserva (para a lista dentro da mensagem agrupada)
function montarLinhaReserva(ev) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const data = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: '2-digit', month: '2-digit' });
  const hi = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const hf = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const est = extrairEstudio(ev);
  const textoEst = est ? `, Estúdio ${est}` : "";
  return `• ${data}, das ${hi} às ${hf}${textoEst}`;
}

// escolhe o nome mais completo entre as reservas do mesmo cliente
function escolherNome(eventos) {
  let melhor = "";
  for (const { ev } of eventos) {
    const nome = extrairNome(ev) || "";
    if (nome.length > melhor.length) melhor = nome;
  }
  return melhor || null;
}

// monta a mensagem AGRUPADA (uma ou várias datas do mesmo cliente)
function montarMensagemAgrupada(eventos) {
  // ordena as reservas por data
  eventos.sort((a, b) =>
    new Date(a.ev.start.dateTime || a.ev.start.date) - new Date(b.ev.start.dateTime || b.ev.start.date)
  );
  const nome = escolherNome(eventos);
  const saudacao = nome ? `Olá ${nome}, tudo bem? 😊` : "Olá, tudo bem? 😊";

  // endereço: usa o da unidade da primeira reserva
  const ehAclimacao = (CALENDAR_IDS[0] === eventos[0].calId);
  const endereco = ehAclimacao ? "Rua Gualaxo, 206 - Aclimação" : "Rua Santa Madalena, 46 - Bela Vista";

  // soma os sinais
  let sinalTotal = 0;
  let temValor = false;
  for (const { ev, calId } of eventos) {
    const acl = (CALENDAR_IDS[0] === calId);
    const v = calcularValores(ev, acl);
    if (v) { sinalTotal += v.sinal; temValor = true; }
  }

  const linhas = eventos.map(({ ev }) => montarLinhaReserva(ev)).join("\n");
  const abertura = eventos.length > 1
    ? `${saudacao}\nGostaria de confirmar o Aluguel de Estúdio nas seguintes datas:`
    : `${saudacao}\nGostaria de confirmar o Aluguel de Estúdio:`;
  const linhaValor = temValor ? `\n\nSinal para reservar: R$ ${sinalTotal}` : "";

  return `${abertura}\n\n${linhas}\n${endereco}${linhaValor}\n\nPIX/CNPJ\nzmphoto@zmphoto.com.br\n43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
}

// testa o envio de verdade para UM telefone específico (útil para depurar sem mexer nos outros)
// confirma pagamento de todas as reservas "pré" de um telefone: marca [pago] na descrição
// (não apaga nada; a partir daí o robô para de cobrar essas reservas)
// remove as marcações [cobrado Nx] de todas as reservas com marca (útil pra "zerar" o histórico de avisos)
// executar=false só mostra quantas seriam afetadas; executar=true faz de verdade
async function resetarAvisosClientesReais(destino, executar = false) {
  const achados = await coletarEventosPre(360);
  const paraResetar = [];
  for (const { ev, calId } of achados) {
    if (!/\[cobrado\s+\d+x/i.test(ev.description || "")) continue; // não tem marca nenhuma
    paraResetar.push({ ev, calId });
  }

  if (paraResetar.length === 0) {
    await sendMessage(destino, "✅ Nenhuma reserva está com marcação de aviso. Nada a resetar.");
    return;
  }

  if (!executar) {
    const linhas = paraResetar.slice(0, 15).map(({ ev }) => `📌 ${ev.summary || "(sem título)"}`).join("\n");
    const extra = paraResetar.length > 15 ? `\n... e mais ${paraResetar.length - 15}` : "";
    await sendMessage(destino, `🔍 ${paraResetar.length} reserva(s) têm marcação de aviso e seriam resetadas:\n${linhas}${extra}\n\nPara executar de verdade, mande: !resetaravisos confirmar`);
    return;
  }

  let resetados = 0;
  for (const { ev, calId } of paraResetar) {
    try {
      const novaDesc = (ev.description || "").replace(/\n?\[cobrado\s+\d+x[^\]]*\]/gi, "").trim();
      await calendar.events.patch({ calendarId: calId, eventId: ev.id, requestBody: { description: novaDesc } });
      resetados++;
    } catch (e) { console.error("Erro ao resetar aviso do evento", ev.id, e.message); }
  }
  await sendMessage(destino, `✅ Reset concluído! ${resetados} reserva(s) voltaram a "zero avisos". Todos começam do zero no próximo ciclo.`);
}

async function confirmarPagamento(telBusca, valor, destino = ADMIN_CHAT_ID) {
  const alvo = telBusca.replace(/\D/g, "");
  const variantesAlvo = variantesTelefone(alvo);
  const achados = await coletarEventosPre(360);
  const encontrados = achados.filter(({ ev }) => {
    const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
    return tel && variantesAlvo.includes(tel);
  });

  if (encontrados.length === 0) {
    await sendMessage(destino, `🔍 Nenhuma reserva "pré" encontrada para o telefone "${telBusca}". Nada foi confirmado.`);
    return;
  }

  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  let confirmadas = 0;
  const linhas = [];
  for (const { ev, calId } of encontrados) {
    try {
      const novaDesc = (ev.description || "") + `\n[pago R$${valor} - ${hoje}]`;
      await calendar.events.patch({
        calendarId: calId,
        eventId: ev.id,
        requestBody: { description: novaDesc },
      });
      confirmadas++;
      linhas.push(`📌 ${ev.summary || "(sem título)"}`);
    } catch (e) {
      console.error("Erro ao confirmar pagamento no evento", ev.id, e.message);
    }
  }

  await sendMessage(destino, `✅ *Pagamento confirmado!*\n${confirmadas} reserva(s) marcada(s) como paga (R$${valor}):\n${linhas.join("\n")}\n\nO robô não vai mais cobrar essas reservas.`);
}

async function testarUmNumero(telBusca, destino = ADMIN_CHAT_ID) {
  const alvo = telBusca.replace(/\D/g, "");
  const variantesAlvo = variantesTelefone(alvo);
  const achados = await coletarEventosPre(360);
  const encontrados = achados.filter(({ ev }) => {
    const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
    return tel && variantesAlvo.includes(tel);
  });

  if (encontrados.length === 0) {
    await sendMessage(destino, `🔍 Nenhuma reserva "pré" encontrada com o telefone "${telBusca}".`);
    return;
  }

  const telReal = extrairTelefone((encontrados[0].ev.summary || "") + " " + (encontrados[0].ev.description || ""));
  const msg = montarMensagemAgrupada(encontrados);
  const link = linkWhatsApp(telReal, msg);

  await sendMessage(destino, `🔍 ${encontrados.length} reserva(s) encontrada(s) para ${telReal}:\n\n✉️ Mensagem:\n${msg}\n\n👉 [Tocar para enviar no WhatsApp](${link})`);
}

// busca reservas "pré" cujo nome/descrição contém o texto pesquisado
async function buscarPorNome(termo, destino = ADMIN_CHAT_ID) {
  const alvo = normalizar(termo);
  const achados = await coletarEventosPre(360);
  const encontrados = achados.filter(({ ev }) => {
    const texto = normalizar((ev.summary || "") + " " + (ev.description || ""));
    return texto.includes(alvo);
  });
  if (encontrados.length === 0) {
    await sendMessage(destino, `🔍 Nenhuma reserva "pré" encontrada para "${termo}".`);
    return;
  }
  let msg = `🔍 ${encontrados.length} reserva(s) para "${termo}":\n`;
  for (const { ev } of encontrados) {
    const inicio = new Date(ev.start.dateTime || ev.start.date);
    const data = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'short', day: '2-digit', month: '2-digit' });
    const hora = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
    const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
    const est = extrairEstudio(ev);
    msg += `\n━━━━━━\n📌 ${ev.summary || "(sem título)"}\n🗓️ ${data} às ${hora}${est ? ` · Estúdio ${est}` : ""}\n📞 ${tel || "⚠️ SEM telefone"}`;
  }
  await sendMessage(destino, msg);
}

// conta quantas vezes já foi cobrado, lendo as marcas na descrição
function contarAvisos(ev) {
  const desc = ev.description || "";
  const matches = desc.match(/\[cobrado \d+x/gi);
  return matches ? matches.length : 0;
}

// acrescenta a marca de cobrança na descrição do evento (sem apagar nada)
async function marcarCobranca(ev, calId, numeroAviso) {
  try {
    const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
    const novaDesc = (ev.description || "") + `\n[cobrado ${numeroAviso}x - ${hoje}]`;
    await calendar.events.patch({
      calendarId: calId,
      eventId: ev.id,
      requestBody: { description: novaDesc },
    });
    return true;
  } catch (e) {
    console.error("Erro ao marcar cobrança no evento", ev.id, e.message);
    return false;
  }
}

// monta a mensagem de cancelamento que seria enviada ao cliente (reserva liberada)
function montarMensagemCancelamento(ev, calId) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const dataExtenso = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: 'numeric', month: 'long' });
  const hi = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const hf = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const est = extrairEstudio(ev);
  const textoEst = est ? `, no Estúdio ${est}` : "";
  const nome = extrairNome(ev);
  const saudacao = nome ? `Olá ${nome},` : "Olá,";
  return `${saudacao} como não recebemos a confirmação, sua reserva de ${dataExtenso}, das ${hi} às ${hf}${textoEst}, foi liberada. 😊\nSe ainda tiver interesse, é só nos chamar que verificamos a disponibilidade!`;
}

// move um evento de verdade para a agenda Cancelados (3ª posição em CALENDAR_IDS)
async function moverParaCancelados(ev, calIdOrigem) {
  const calIdDestino = CALENDAR_IDS[2];
  if (!calIdDestino) throw new Error("Agenda Cancelados não configurada (falta o 3º ID em CALENDAR_IDS).");
  // cria uma cópia na agenda Cancelados
  await calendar.events.insert({
    calendarId: calIdDestino,
    requestBody: {
      summary: ev.summary,
      description: (ev.description || "") + "\n[cancelado automaticamente - sem confirmação em 2 avisos]",
      start: ev.start,
      end: ev.end,
      colorId: ev.colorId,
    },
  });
  // apaga da agenda de origem
  await calendar.events.delete({ calendarId: calIdOrigem, eventId: ev.id });
}

// detecta se um evento "sem telefone" tem um número parecido com um de teste,
// só faltando o DDD (ex.: "973776098" quando o de teste é "5511973776098")
// roda o ciclo diário. Se marcar=true, escreve [cobrado Nx] na descrição (só no automático das 8h).
// IMPORTANTE: este bot NUNCA manda mensagem direto pro cliente — ele sempre entrega o texto pronto
// + um link "clique para conversar" (wa.me), pra equipe conferir e apertar Enviar manualmente.
async function rodarEnsaioConfirmacoes(marcar = false, destino = ADMIN_CHAT_ID) {
  await sendMessage(destino, `🔎 ${marcar ? "Relatório automático das 8h" : "Consulta"}: procurando reservas 'pré'...`);
  const achados = await coletarEventosPre(360);
  if (achados.length === 0) {
    await sendMessage(destino, "Nenhuma reserva com 'pré' encontrada nos próximos 90 dias.");
    return;
  }

  // separa por estágio de aviso
  const paraCobrar = [];       // 0 ou 1 aviso -> cobra
  const paraCancelar = [];     // 2 avisos -> cancelamento
  for (const item of achados) {
    if (contarAvisos(item.ev) >= 2) paraCancelar.push(item);
    else paraCobrar.push(item);
  }

  if (paraCobrar.length === 0 && paraCancelar.length === 0) {
    await sendMessage(destino, "Nenhuma reserva a processar hoje.");
    return;
  }

  // agrupa por telefone: mesmo número = mesmo cliente
  const grupos = {};
  const semTelefone = [];
  for (const item of paraCobrar) {
    const tel = extrairTelefone((item.ev.summary || "") + " " + (item.ev.description || ""));
    if (tel) { (grupos[tel] = grupos[tel] || []).push(item); }
    else semTelefone.push(item);
  }

  const totalClientes = Object.keys(grupos).length + semTelefone.length;
  await sendMessage(destino, `Encontrei ${paraCobrar.length} reserva(s) a cobrar, agrupadas em ${totalClientes} cliente(s). Toque no link de cada uma pra enviar. 👇`);

  let marc1 = 0, marc2 = 0;

  // marca uma lista de eventos (só se marcar=true)
  async function marcarLista(eventos) {
    if (!marcar) return;
    for (const { ev, calId } of eventos) {
      const proximo = contarAvisos(ev) + 1;
      const ok = await marcarCobranca(ev, calId, proximo);
      if (ok) { if (proximo === 1) marc1++; else marc2++; }
    }
  }

  // clientes COM telefone (agrupados)
  for (const tel of Object.keys(grupos)) {
    const eventos = grupos[tel];
    try {
      const msg = montarMensagemAgrupada(eventos);
      const qtd = eventos.length > 1 ? ` (${eventos.length} datas)` : "";
      const link = linkWhatsApp(tel, msg);
      await sendMessage(destino, `━━━━━━━━━━\n📞 ${tel}${qtd}\n\n✉️ Mensagem:\n${msg}\n\n👉 [Tocar para enviar no WhatsApp](${link})`);
    } catch (e) {
      await sendMessage(destino, `⚠️ Erro ao processar o cliente ${tel}: ${e.message}`);
    }
    await marcarLista(eventos);
    await esperar(500);
  }

  // clientes SEM telefone (separados, um a um)
  for (const item of semTelefone) {
    try {
      const msg = montarMensagemAgrupada([item]);
      await sendMessage(destino, `━━━━━━━━━━\n📞 ⚠️ SEM telefone — ${item.ev.summary || "(sem título)"}\n\n✉️ Mensagem (preencha o telefone antes de mandar):\n${msg}`);
    } catch (e) {
      await sendMessage(destino, `⚠️ Erro ao processar "${item.ev.summary || "(sem título)"}": ${e.message}`);
    }
    await marcarLista([item]);
    await esperar(500);
  }

  // CANCELAMENTO — reservas com 2 avisos (3º dia): move para Cancelados (só se marcar=true) e entrega o link de aviso
  for (const { ev, calId } of paraCancelar) {
    try {
      const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
      const msgCliente = montarMensagemCancelamento(ev, calId);
      if (marcar) await moverParaCancelados(ev, calId);
      const statusMovido = marcar ? "e foi movida para Cancelados" : "(modo consulta: NÃO foi movida ainda — isso só acontece no automático das 8h)";
      const bloco = tel
        ? `🛑 CANCELAMENTO\n📌 ${ev.summary || "(sem título)"}\n\nEsta reserva atingiu 2 avisos ${statusMovido}.\n\n✉️ Mensagem para avisar o cliente:\n${msgCliente}\n\n👉 [Tocar para enviar no WhatsApp](${linkWhatsApp(tel, msgCliente)})`
        : `🛑 CANCELAMENTO\n📌 ${ev.summary || "(sem título)"}\n\n${statusMovido}, mas SEM telefone pra avisar o cliente.\n\n✉️ Mensagem:\n${msgCliente}`;
      await sendMessage(destino, bloco);
    } catch (e) {
      await sendMessage(destino, `⚠️ Erro no cancelamento de "${ev.summary || "(sem título)"}": ${e.message}`);
    }
    await esperar(500);
  }

  const resumoMarca = marcar
    ? `\n📌 ${marc1} marcada(s) como 1ª cobrança\n📌 ${marc2} marcada(s) como 2ª cobrança`
    : "\n(Modo consulta: nada foi marcado na agenda.)";
  const resumoCancel = paraCancelar.length
    ? `\n🛑 ${paraCancelar.length} reserva(s) canceladas e movidas hoje.`
    : "";
  await sendMessage(destino, `✅ Fim do relatório.${resumoMarca}${resumoCancel}`);
}

// =============================
// CÉREBRO DO ROBÔ
// =============================
async function gerarRespostaGemini(chatId, pergunta, nomeUsuario = "Cliente") {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const ocupacaoAtual = await getAgendaOcupada();

  const SYSTEM_PROMPT = `
Você é o assistente virtual do Aluguel de Estúdio Fotográfico. Seu objetivo é fechar reservas e informar o cliente.
CLIENTE: ${nomeUsuario}.

🚨 REGRAS DE OURO (NUNCA IGNORE):
1. MÍNIMO: 2 horas de locação.
2. DISPONIBILIDADE: Consulte SEMPRE a agenda abaixo. Se estiver livre, ofereça.
3. PREÇOS: NÃO cite valores de memória — os preços podem mudar. Para QUALQUER pergunta de preço, direcione ao PDF oficial (link abaixo). Só depois de o cliente ver o PDF, se ele já souber estúdio/horário/data, você pode calcular o SINAL usando a fórmula da regra 6.
4. GRUPOS 9-12 PESSOAS: Apenas Estúdio AB na Aclimação (consulte o PDF para o valor).
5. SINAL: sempre 1/3 do valor total da locação, arredondado para baixo em múltiplos de R$10, com mínimo de R$50. PIX CNPJ: 43.345.289/0001-93.
6. TARIFA NOTURNA: Após as 21h os valores mudam. Sempre avise isso se o cliente quiser horários tarde da noite, e direcione ao PDF para o valor exato.

📄 INFORMAÇÕES E PDF (REGRA CRUCIAL):
- SEMPRE que o cliente pedir valores, fotos, informações gerais ou perguntar "como funciona", você DEVE dizer que temos um PDF completo e enviar os links abaixo:
- PDF GERAL COM TODOS OS VALORES: https://drive.google.com/file/d/1J8FC6mzmfkOhlHbRrKVLN92jYj9LF1bb/view?usp=sharing
- FOTOS UNIDADE ACLIMAÇÃO: https://drive.google.com/drive/folders/100GPqd9sWFRtEE5YPZCYhyv_DkBNV_G9
- FOTOS UNIDADE BELA VISTA: https://drive.google.com/drive/folders/1Navk6o2Gy9cDlD9FKAuizH8hd3nTMLEW

⚠️ GATILHO HUMANO (11 99554-0293):
- NÃO tente resolver: Assuntos logísticos (Portão, Uber), Visitas Técnicas agendadas, Equipamentos Específicos (Lentes, Snoot, Projetor) ou Exceções de Pagamento. Encaminhe para o número acima.

AGENDA REAL ATUALIZADA:
${ocupacaoAtual}
`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nCliente: ${pergunta}` }] }] }),
    });
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  } catch (e) { return "Um momento, vou conferir com a recepção."; }
}

// =============================
// AGENDAMENTO (!agendar) — cria evento na agenda certa
// =============================

// guarda conversas de agendamento em andamento (por chatId)
// cada conversa tem: { passo, dados }
const conversasAgendamento = {};

// mapa estúdio -> qual agenda (índice em CALENDAR_IDS): Aclimação=0, Bela Vista=1
function agendaDoEstudio(est) {
  const aclimacao = ["A", "B", "C", "D", "AB"];
  const belavista = ["1", "2", "3"];
  if (aclimacao.includes(est)) return { calId: CALENDAR_IDS[0], unidade: "Aclimação" };
  if (belavista.includes(est)) return { calId: CALENDAR_IDS[1], unidade: "Bela Vista" };
  return null;
}

// valida uma DATA no formato DD/MM. Retorna {dia, mes} ou null
function validarData(txt) {
  const md = (txt || "").trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!md) return null;
  const dia = parseInt(md[1]), mes = parseInt(md[2]);
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return null;
  return { dia, mes };
}

// valida um HORÁRIO no formato HH-HH (ou HH:MM-HH:MM). Retorna {h1,m1,h2,m2} ou null
function validarHorario(txt) {
  const mh = (txt || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!mh) return null;
  const h1 = parseInt(mh[1]), m1 = parseInt(mh[2] || "0");
  const h2 = parseInt(mh[3]), m2 = parseInt(mh[4] || "0");
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  return { h1, m1, h2, m2 };
}

// valida o ESTÚDIO. Retorna {estudio, calId, unidade} ou null
function validarEstudio(txt) {
  const estudio = (txt || "").trim().toUpperCase();
  const ag = agendaDoEstudio(estudio);
  if (!ag) return null;
  return { estudio, ...ag };
}

// monta as datas de início e fim a partir dos dados coletados
// IMPORTANTE: cria já no fuso de São Paulo (-03:00), senão o servidor (UTC) grava 3h a menos
function montarDatas(dados) {
  const agora = new Date();
  let ano = agora.getFullYear();
  const p = (n) => String(n).padStart(2, "0");
  const montaISO = (a) =>
    `${a}-${p(dados.mes)}-${p(dados.dia)}T${p(dados.h1)}:${p(dados.m1)}:00-03:00`;

  let inicio = new Date(montaISO(ano));
  // se a data ficou muito no passado, provavelmente é do ano que vem
  if (inicio < agora && (agora - inicio) > 7 * 24 * 3600 * 1000) {
    ano = ano + 1;
    inicio = new Date(montaISO(ano));
  }
  const fim = new Date(`${ano}-${p(dados.mes)}-${p(dados.dia)}T${p(dados.h2)}:${p(dados.m2)}:00-03:00`);
  return { inicio, fim };
}

// retorna quais estúdios ocupam fisicamente o mesmo espaço (AB = A+B combinados)
function estudiosConflitantes(estudio) {
  if (estudio === "A") return ["A", "AB"];
  if (estudio === "B") return ["B", "AB"];
  if (estudio === "AB") return ["A", "B", "AB"];
  return [estudio]; // C, D, 1, 2, 3 não têm sobreposição com outros
}

// checa se o estúdio já está ocupado no horário (nas agendas de cobrança)
// considera A/B/AB como o mesmo espaço físico: reservar AB bloqueia A e B, e vice-versa
async function horarioOcupado(calId, estudio, inicio, fim) {
  try {
    const res = await calendar.events.list({
      calendarId: calId,
      timeMin: new Date(inicio.getTime() - 60000).toISOString(),
      timeMax: new Date(fim.getTime() + 60000).toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });
    const conflitantes = estudiosConflitantes(estudio);
    for (const ev of (res.data.items || [])) {
      if (conflitantes.includes(extrairEstudio(ev))) {
        const ei = new Date(ev.start.dateTime || ev.start.date);
        const ef = new Date(ev.end.dateTime || ev.end.date);
        // há sobreposição?
        if (inicio < ef && fim > ei) return ev;
      }
    }
    return null;
  } catch (e) {
    console.error("Erro ao checar conflito:", e.message);
    return null;
  }
}

// cria o evento de verdade na agenda
// endereços completos das unidades (usados na mensagem pronta para o cliente)
const ENDERECO_ACLIMACAO = "Rua Gualaxo, 206 - Aclimação/Liberdade - CEP 01533-020";
const ENDERECO_BELAVISTA = "Rua Santa Madalena, 46 - Bela Vista";

// calcula o sinal para um agendamento novo (mesma regra da cobrança)
function calcularSinalAgendamento(d, inicio, fim) {
  const horas = (fim - inicio) / (1000 * 60 * 60);
  if (!horas || horas <= 0) return null;
  const diaTxt = inicio.toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const periodo = (diaTxt === "Sat" || diaTxt === "Sun") ? "fds" : "semana";
  const unidade = (d.unidade === "Aclimação") ? "aclimacao" : "belavista";
  const valorHora = TABELA_PRECOS[unidade][periodo][d.estudio];
  if (!valorHora) return null;
  const total = Math.round(horas * valorHora);
  let sinal = Math.floor((total / 3) / 10) * 10;
  if (sinal < 50) sinal = 50;
  return sinal;
}

// monta a mensagem PRONTA para a equipe encaminhar ao cliente
function montarMensagemParaCliente(d, inicio, fim) {
  const dataExtenso = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: 'numeric', month: 'long' });
  const hi = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const hf = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const endereco = (d.unidade === "Aclimação") ? ENDERECO_ACLIMACAO : ENDERECO_BELAVISTA;
  const primeiroNome = (d.nome || "").split(" ")[0];

  // se já foi pago, confirma a reserva. Se não, pede o sinal.
  if (d.pago) {
    return `Obrigado ${primeiroNome}! 😊\nReserva confirmada: Estúdio ${d.estudio}, ${dataExtenso}, das ${hi} às ${hf}.\n${endereco}\n\nPagamento de R$ ${d.pago} recebido. Até lá!`;
  }

  const sinal = calcularSinalAgendamento(d, inicio, fim);
  const linhaSinal = sinal
    ? `\n\nPara fazer a reserva pedimos R$ ${sinal} antecipado, ok?`
    : `\n\nPara fazer a reserva pedimos o sinal antecipado, ok?`;

  return `Obrigado ${primeiroNome}! 😊\nPré-marcado Estúdio ${d.estudio}, ${dataExtenso}, das ${hi} às ${hf}.\n${endereco}${linhaSinal}\n\nPIX: zmphoto@zmphoto.com.br\nou CNPJ 43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
}

// monta a mensagem PRONTA para o cliente quando há VÁRIAS datas (mesmo cliente)
function montarMensagemParaClienteMulti(d, reservas, pagoFinal) {
  const primeiroNome = (d.nome || "").split(" ")[0];
  const unidades = new Set(reservas.map(r => r.unidade));
  // usa o endereço da 1ª reserva (geralmente todas são da mesma unidade)
  const endereco = (reservas[0].unidade === "Aclimação") ? ENDERECO_ACLIMACAO : ENDERECO_BELAVISTA;

  const linhas = reservas.map(r => {
    const dataExtenso = r.inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: 'numeric', month: 'long' });
    const hi = r.inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
    const hf = r.fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
    return `• Estúdio ${r.estudio}, ${dataExtenso}, das ${hi} às ${hf}`;
  }).join("\n");

  if (pagoFinal) {
    return `Obrigado ${primeiroNome}! 😊\nReserva confirmada:\n${linhas}\n${endereco}\n\nPagamento de R$ ${pagoFinal} recebido. Até lá!`;
  }

  // soma o sinal mínimo de todas as datas (mesma regra: min R$50/dia, calculado por data)
  let sinalTotal = 0;
  for (const r of reservas) {
    const s = calcularSinalAgendamento({ unidade: r.unidade, estudio: r.estudio }, r.inicio, r.fim);
    sinalTotal += s || 50;
  }
  return `Obrigado ${primeiroNome}! 😊\nPré-marcado:\n${linhas}\n${endereco}\n\nPara fazer a reserva pedimos R$ ${sinalTotal} antecipado (total), ok?\n\nPIX: zmphoto@zmphoto.com.br\nou CNPJ 43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
}

// envia o resumo do agendamento (uma ou várias reservas) para confirmação
async function enviarResumoAgendamento(chatId, conversa) {
  const d = conversa.dados;
  let linhas = "";
  for (const r of conversa.reservas) {
    const { inicio, fim } = montarDatas(r);
    const dataFmt = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'short', day: '2-digit', month: '2-digit' });
    const hi = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
    const hf = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
    linhas += `\n📅 ${dataFmt} · ${hi} às ${hf} · Estúdio ${r.estudio} (${r.unidade})`;
  }
  await sendMessage(chatId,
    `📋 *Confirma este agendamento?*\n${linhas}\n\n👤 ${d.nome}\n📞 ${d.telefone}\n${d.pago ? `💰 pago R$${d.pago} (total)` : "🔖 pré-reserva"}\n\n` +
    `Responda *SIM* para confirmar ou *NÃO* para cancelar.`
  );
}

// cores do Google Calendar por estúdio (colorId oficial da API)
// Lavanda=1, Sálvia=2, Uva=3, Flamingo=4, Banana=5, Tangerina=6, Pavão=7, Grafite=8, Mirtilo=9, Tomate=11
const COR_POR_ESTUDIO = {
  C: "1",  // Lavanda
  D: "4",  // Flamingo
  "2": "2", // Sálvia
  "3": "7", // Pavão
  // A, B, AB, 1 -> sem entrada = cor padrão da agenda
};

// cria o evento de verdade na agenda
async function criarEvento(dados) {
  const hTitulo = (h, m) => (m ? `${h}:${String(m).padStart(2, "0")}` : `${h}`);
  const titulo = `${hTitulo(dados.h1, dados.m1)}-${hTitulo(dados.h2, dados.m2)}/${dados.estudio}${dados.pago ? "" : " pré"}`;
  let descricao = dados.nome;
  if (dados.telefone) descricao += ` ${dados.telefone}`;
  if (dados.pago) descricao += `\npago R$${dados.pago}`;
  const eventBody = {
    summary: titulo,
    description: descricao,
    start: { dateTime: dados.inicio.toISOString(), timeZone: "America/Sao_Paulo" },
    end: { dateTime: dados.fim.toISOString(), timeZone: "America/Sao_Paulo" },
  };
  const cor = COR_POR_ESTUDIO[dados.estudio];
  if (cor) eventBody.colorId = cor;
  await calendar.events.insert({
    calendarId: dados.calId,
    requestBody: eventBody,
  });
  return titulo;
}

// =============================
// PROCESSAMENTO DE MENSAGENS
// =============================
// MEMÓRIA DE CLIENTES — varre as agendas e monta um dicionário nome -> telefone
// (não é um banco separado; usa a própria agenda como fonte, sempre atualizada)
async function buscarTelefoneConhecido(nomeBuscado) {
  const alvo = normalizar(nomeBuscado);
  if (!alvo) return null;
  const agora = new Date();
  const limite = new Date(agora.getTime() - 180 * 24 * 60 * 60 * 1000); // últimos 180 dias pra trás
  const futuro = new Date(agora.getTime() + 180 * 24 * 60 * 60 * 1000); // e 180 dias pra frente

  for (const calId of CALENDAR_IDS.slice(0, 2)) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: limite.toISOString(),
        timeMax: futuro.toISOString(),
        singleEvents: true,
      });
      for (const ev of (res.data.items || [])) {
        const nomeEv = extrairNome(ev);
        const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
        if (nomeEv && tel) {
          const nomeNorm = normalizar(nomeEv);
          // considera "conhecido" se o nome bate exatamente ou um contém o outro
          if (nomeNorm === alvo || nomeNorm.includes(alvo) || alvo.includes(nomeNorm)) {
            return { nome: nomeEv, telefone: tel };
          }
        }
      }
    } catch (e) { console.error("Erro ao buscar telefone conhecido:", e.message); }
  }
  return null;
}

// segunda e última tentativa: busca nos CONTATOS DO GOOGLE (zmphoto@zmphoto.com.br, ~7.180 contatos, paginado)
// (no Telegram não existe uma "agenda de contatos do celular" pra consultar, diferente do WhatsApp)
async function buscarContatoGoogle(nomeBuscado) {
  const alvo = normalizar(nomeBuscado);
  if (!alvo || !peopleClient) return null;
  try {
    let pageToken;
    do {
      const res = await peopleClient.people.connections.list({
        resourceName: "people/me",
        pageSize: 1000,
        personFields: "names,phoneNumbers",
        pageToken,
      });
      for (const pessoa of (res.data.connections || [])) {
        const telefones = pessoa.phoneNumbers || [];
        if (telefones.length === 0) continue;
        for (const n of (pessoa.names || [])) {
          const nomeContato = n.displayName || "";
          if (!nomeContato) continue;
          const nomeNorm = normalizar(nomeContato);
          if (nomeNorm === alvo || nomeNorm.includes(alvo) || alvo.includes(nomeNorm)) {
            const digitos = (telefones[0].value || "").replace(/\D/g, "");
            if (digitos) {
              const tel = digitos.length <= 11 ? "55" + digitos : digitos;
              return { nome: nomeContato, telefone: tel, origem: "contatos do Google" };
            }
          }
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.error("Erro ao buscar contato no Google:", e.message);
  }
  return null;
}

      // parseia um horário simples (não intervalo), ex: "14:00", "14h", "14"
function parseHorarioSimples(tok) {
  const m = (tok || "").trim().match(/^(\d{1,2})(?::(\d{2}))?h?$/i);
  if (!m) return null;
  const h = parseInt(m[1]), min = parseInt(m[2] || "0");
  if (h > 23 || min > 59) return null;
  return { h, min };
}

// lista eventos de um período, opcionalmente filtrado por estúdio
async function listarAgendaFiltrada(calIds, estudioFiltro, timeMin, timeMax) {
  let todos = [];
  for (const calId of calIds) {
    try {
      const res = await calendar.events.list({
        calendarId: calId, timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
        singleEvents: true, orderBy: 'startTime',
      });
      for (const ev of (res.data.items || [])) {
        if (estudioFiltro && extrairEstudio(ev) !== estudioFiltro) continue;
        todos.push(ev);
      }
    } catch (e) { console.error(`Erro ao ler a agenda ${calId}:`, e.message); }
  }
  todos.sort((a, b) => new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date));
  return todos;
}

// comando !agenda flexível: aceita estúdio, "semana", data(s) DD/MM (separadas por vírgula) e horário
// Ex.: "!agenda", "!agenda semana", "!agenda A semana", "!agenda 1 02/08,10/08 14:00"
// constrói uma Date exatamente no fuso de São Paulo (evita o bug de "meia-noite UTC" virar dia anterior)
function dataHoraSP(ano, mes, dia, hora = 0, min = 0) {
  const p = (n) => String(n).padStart(2, "0");
  return new Date(`${ano}-${p(mes)}-${p(dia)}T${p(hora)}:${p(min)}:00-03:00`);
}

// calcula os intervalos LIVRES (>= duração mínima) de um estúdio num dia, dentro do horário de operação
function calcularHorariosLivres(eventosDoEstudio, ano, mes, dia, horaOperInicio = 7, horaOperFim = 23, minHoras = 2) {
  const inicioOp = dataHoraSP(ano, mes, dia, horaOperInicio, 0);
  const fimOp = dataHoraSP(ano, mes, dia, horaOperFim, 0);
  const ocupados = eventosDoEstudio
    .map(ev => ({ ini: new Date(ev.start.dateTime || ev.start.date), fim: new Date(ev.end.dateTime || ev.end.date) }))
    .filter(o => o.fim > inicioOp && o.ini < fimOp)
    .sort((a, b) => a.ini - b.ini);

  const livres = [];
  let cursor = inicioOp;
  for (const o of ocupados) {
    if (o.ini > cursor) {
      const gap = o.ini - cursor;
      if (gap >= minHoras * 3600000) livres.push({ ini: cursor, fim: o.ini });
    }
    if (o.fim > cursor) cursor = o.fim;
  }
  if (fimOp - cursor >= minHoras * 3600000) livres.push({ ini: cursor, fim: fimOp });
  return livres;
}

// decide quais estúdios entram no cálculo de horários livres (AB fica de fora: é composto de A+B)
function estudiosParaAnaliseLivre(estudioFiltro, unidadeFiltro) {
  if (estudioFiltro) return [estudioFiltro];
  if (unidadeFiltro === "aclimacao") return ["A", "B", "C", "D", "AB"];
  if (unidadeFiltro === "belavista") return ["1", "2", "3"];
  return ["A", "B", "C", "D", "AB", "1", "2", "3"];
}

// usa o Gemini para traduzir uma frase livre para o formato estruturado que consultarAgenda entende
// (só usado em consultas de leitura — !agenda/!vagos — nunca em ações que gravam algo)
async function normalizarComandoAgenda(textoLivre) {
  if (!textoLivre || !textoLivre.trim()) return textoLivre;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const prompt = `Converta o pedido abaixo (em português, sobre agenda de estúdio fotográfico) num comando curto, usando só estas peças possíveis:

- Estúdio específico: A, B, C, D, AB (unidade Aclimação) ou 1, 2, 3 (unidade Bela Vista)
- Unidade inteira (sem estúdio específico): "aclimacao" ou "belavista"
- "livre" — se o pedido for sobre horários vagos/disponíveis/livres
- "hoje", "semana" (esta semana) ou "semana que vem" (próxima semana)
- Data(s) no formato DD/MM (várias datas separadas por vírgula, sem espaço)
- Horário no formato HH:MM

Responda APENAS com o comando resultante em uma linha, sem explicação, sem aspas. Combine as peças que fizerem sentido, nesta ordem: [estúdio/unidade] [livre] [semana/data] [horário].

Exemplos:
"quero saber os horários vagos do estúdio A essa semana" -> A livre semana
"o estúdio 1 da bela vista está livre dia 2 de agosto às 14h?" -> 1 belavista livre 02/08 14:00
"como está a bela vista hoje" -> belavista hoje
"livre semana que vem no D" -> D livre semana que vem

PEDIDO: "${textoLivre}"
COMANDO:`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return texto || textoLivre;
  } catch (e) {
    console.error("Erro ao normalizar comando via Gemini:", e.message);
    return textoLivre; // se a IA falhar, usa o texto original (o parser tenta mesmo assim)
  }
}

async function consultarAgenda(argsTexto, destino) {
  // normaliza expressões de duas/três palavras para um único token antes de dividir
  const argsNormalizado = argsTexto
    .replace(/bela\s+vista/gi, "belavista")
    .replace(/semana\s+que\s+vem/gi, "semanaquevem")
    .replace(/proxima\s+semana|próxima\s+semana/gi, "semanaquevem");
  const tokens = argsNormalizado.trim().split(/\s+/).filter(Boolean);
  const codigosEstudio = ["AB", "A", "B", "C", "D", "1", "2", "3"];
  let estudioFiltro = null, unidadeFiltro = null, semana = false, proximaSemana = false, apenasLivre = false, datas = [], horario = null;
  const hojeInfo = new Date();
  const hojeStr = hojeInfo.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // "YYYY-MM-DD", sem ambiguidade
  const [hojeAno, hojeMes, hojeDia] = hojeStr.split("-").map(Number);

  for (const tok of tokens) {
    const tokNorm = normalizar(tok);
    if (tokNorm === "semana") { semana = true; continue; }
    if (tokNorm === "semanaquevem") { semana = true; proximaSemana = true; continue; }
    if (tokNorm === "livre" || tokNorm === "livres") { apenasLivre = true; continue; }
    if (tokNorm === "hoje") { datas.push({ dia: hojeDia, mes: hojeMes }); continue; }
    if (tokNorm === "aclimacao") { unidadeFiltro = "aclimacao"; continue; }
    if (tokNorm === "belavista") { unidadeFiltro = "belavista"; continue; }
    const tokUpper = tok.toUpperCase();
    if (!estudioFiltro && codigosEstudio.includes(tokUpper)) { estudioFiltro = tokUpper; continue; }
    if (/\d{1,2}\/\d{1,2}/.test(tok)) {
      for (const p of tok.split(",")) { const v = validarData(p); if (v) datas.push(v); }
      continue;
    }
    const vh = parseHorarioSimples(tok);
    if (vh) { horario = vh; continue; }
  }

  const ag = estudioFiltro ? agendaDoEstudio(estudioFiltro) : null;
  let calIds;
  if (ag) calIds = [ag.calId];
  else if (unidadeFiltro === "aclimacao") calIds = [CALENDAR_IDS[0]];
  else if (unidadeFiltro === "belavista") calIds = [CALENDAR_IDS[1]];
  else calIds = CALENDAR_IDS.slice(0, 2);
  const ano = hojeAno;

  // MODO 1: data(s) + horário + estúdio -> checa livre/ocupado exato
  if (datas.length > 0 && horario && estudioFiltro) {
    for (const d of datas) {
      const inicio = dataHoraSP(ano, d.mes, d.dia, horario.h, horario.min);
      const fim = new Date(inicio.getTime() + 60000);
      const conflito = await horarioOcupado(ag.calId, estudioFiltro, inicio, fim);
      const dataFmt = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
      const horaFmt = `${String(horario.h).padStart(2, "0")}:${String(horario.min).padStart(2, "0")}`;
      if (conflito) {
        const ci = new Date(conflito.start.dateTime || conflito.start.date);
        const cf = new Date(conflito.end.dateTime || conflito.end.date);
        const hi = ci.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
        const hf = cf.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
        await sendMessage(destino, `❌ ${rotuloEstudioCodigo(estudioFiltro)} está OCUPADO às ${horaFmt} do dia ${dataFmt}.\n(Reserva das ${hi} às ${hf})`);
      } else {
        await sendMessage(destino, `✅ ${rotuloEstudioCodigo(estudioFiltro)} está LIVRE às ${horaFmt} do dia ${dataFmt}.`);
      }
    }
    return;
  }

  // rótulo do filtro (estúdio específico, ou unidade inteira, ou nada)
  const nomeUnidade = { aclimacao: "Aclimação", belavista: "Bela Vista" };
  const rotuloFiltro = estudioFiltro ? ` — ${rotuloEstudioCodigo(estudioFiltro)}` : (unidadeFiltro ? ` — ${nomeUnidade[unidadeFiltro]}` : "");

  // MODO 2: data(s) sem horário -> lista o dia inteiro + horários livres (mín. 2h) por estúdio
  if (datas.length > 0) {
    const estudiosParaLivres = estudiosParaAnaliseLivre(estudioFiltro, unidadeFiltro);

    for (const d of datas) {
      const inicio = dataHoraSP(ano, d.mes, d.dia, 0, 0);
      const fim = dataHoraSP(ano, d.mes, d.dia, 23, 59);
      const eventos = await listarAgendaFiltrada(calIds, estudioFiltro, inicio, fim);
      // busca ampla (todos os estúdios), usada só para o cálculo de conflito A/B/AB nos horários livres
      const eventosParaLivres = estudioFiltro ? await listarAgendaFiltrada(calIds, null, inicio, fim) : eventos;
      const dataFmt = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: '2-digit', month: '2-digit' });

      let msg = `📅 *${dataFmt}*${rotuloFiltro}:\n`;
      if (!apenasLivre) {
        if (eventos.length === 0) {
          msg += "Nenhuma reserva marcada.\n";
        } else {
          msg += eventos.map(ev => {
            const ei = new Date(ev.start.dateTime || ev.start.date);
            const ef = new Date(ev.end.dateTime || ev.end.date);
            const hi = ei.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
            const hf = ef.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
            return `  ${hi}–${hf} · ${rotuloEstudioEvento(ev)}`;
          }).join("\n") + "\n";
        }
      }

      if (estudiosParaLivres.length > 0) {
        msg += "\n🟢 *Horários livres (mín. 2h, 07h-23h):*\n";
        let algumLivre = false;
        for (const est of estudiosParaLivres) {
          const conflitantes = estudiosConflitantes(est);
          const eventosDoEstudio = eventosParaLivres.filter(ev => conflitantes.includes(extrairEstudio(ev)));
          const livres = calcularHorariosLivres(eventosDoEstudio, ano, d.mes, d.dia);
          if (livres.length > 0) {
            algumLivre = true;
            const linhasLivres = livres.map(l => {
              const hi = l.ini.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
              const hf = l.fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
              return `${hi}-${hf}`;
            }).join(" ou ");
            msg += `${rotuloEstudioCodigo(est)}: ${linhasLivres}\n`;
          }
        }
        if (!algumLivre) msg += "(nenhum horário livre de 2h ou mais)\n";
      }

      await sendMessage(destino, msg.trim());
    }
    return;
  }

  // MODO 3: período (semana, semana que vem, ou padrão 15 dias), com ou sem estúdio/unidade
  // "semana que vem" = da PRÓXIMA segunda-feira até o domingo seguinte (semana civil), não um deslocamento fixo de 7 dias
  const diaSemanaTxt = new Date().toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const mapaDow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hojeDow = mapaDow[diaSemanaTxt];
  let diasAteProximaSegunda = ((1 - hojeDow) + 7) % 7;
  if (diasAteProximaSegunda === 0) diasAteProximaSegunda = 7; // se hoje já é segunda, "semana que vem" é a próxima
  const offsetDias = proximaSemana ? diasAteProximaSegunda : 0;
  // ancora o início do período em MEIA-NOITE do dia certo (evita perder eventos que já passaram
  // no horário atual, tipo buscar às 19h e perder reserva das 13h do mesmo dia)
  const hojeMeiaNoite = dataHoraSP(hojeAno, hojeMes, hojeDia, 0, 0);
  const inicioBruto = new Date(hojeMeiaNoite.getTime() + offsetDias * 24 * 60 * 60 * 1000);
  const inicioStr = inicioBruto.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const [anoP, mesP, diaP] = inicioStr.split("-").map(Number);
  const agora = dataHoraSP(anoP, mesP, diaP, 0, 0);
  const dias = semana ? 7 : 15;
  const limite = new Date(agora.getTime() + dias * 24 * 60 * 60 * 1000);
  const fimPeriodoParaRotulo = new Date(agora.getTime() + (dias - 1) * 24 * 60 * 60 * 1000);
  const fmtCurto = (dt) => dt.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: '2-digit', month: '2-digit' });
  const rotuloPeriodo = proximaSemana
    ? `semana que vem (${fmtCurto(agora)} a ${fmtCurto(fimPeriodoParaRotulo)})`
    : (semana ? `próximos 7 dias (${fmtCurto(agora)} a ${fmtCurto(fimPeriodoParaRotulo)})` : `próximos ${dias} dias`);
  const rotulo = `${rotuloPeriodo}${rotuloFiltro}`;

  if (apenasLivre) {
    // calcula horários livres dia a dia, para os estúdios em escopo
    const estudiosParaLivres = estudiosParaAnaliseLivre(estudioFiltro, unidadeFiltro);
    const eventosPeriodo = await listarAgendaFiltrada(calIds, null, agora, limite);
    let msg = `🟢 HORÁRIOS LIVRES (${rotulo}, mín. 2h, 07h-23h):\n`;
    for (let i = 0; i < dias; i++) {
      const diaRef = new Date(agora.getTime() + i * 24 * 60 * 60 * 1000);
      const diaStr = diaRef.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
      const [a, m, dd] = diaStr.split("-").map(Number);
      const diaFmt = diaRef.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: '2-digit', month: '2-digit' });

      const linhasDia = [];
      for (const est of estudiosParaLivres) {
        const conflitantes = estudiosConflitantes(est);
        const eventosDoDiaEstudio = eventosPeriodo.filter(ev => {
          if (!conflitantes.includes(extrairEstudio(ev))) return false;
          const evDataStr = new Date(ev.start.dateTime || ev.start.date).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
          return evDataStr === diaStr;
        });
        const livres = calcularHorariosLivres(eventosDoDiaEstudio, a, m, dd);
        if (livres.length > 0) {
          const faixas = livres.map(l => {
            const hi = l.ini.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
            const hf = l.fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
            return `${hi}-${hf}`;
          }).join(" ou ");
          linhasDia.push(`  ${rotuloEstudioCodigo(est)}: ${faixas}`);
        }
      }
      if (linhasDia.length > 0) msg += `\n📅 *${diaFmt}*\n${linhasDia.join("\n")}\n`;
    }
    await sendMessage(destino, msg.trim());
    return;
  }

  const eventos = await listarAgendaFiltrada(calIds, estudioFiltro, agora, limite);
  if (eventos.length === 0) {
    await sendMessage(destino, `📅 AGENDA (${rotulo}): livre, nenhuma reserva encontrada.`);
    return;
  }
  await sendMessage(destino, `📅 AGENDA (${rotulo}):\n\n${formatarAgendaPorDia(eventos)}`);
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // responde rápido ao Telegram; o processamento continua depois
  try {
    const message = req.body.message;
    if (!message || !message.chat || typeof message.text !== "string") return;

    const chatId = String(message.chat.id);
    const nomeUsuario = message.from?.first_name || "Equipe";

    const textoMensagem = message.text.trim().toLowerCase();

    // 🆔 DIAGNÓSTICO: responde a QUALQUER número com o próprio ID.
    // Serve para descobrir o valor exato do ADMIN_CHAT_ID.
    if (textoMensagem === '!meuid') {
      await sendMessage(chatId, `Seu ID é:\n${chatId}\n\nÉ esse valor exato que deve ir no ADMIN_CHAT_ID.`);
      return;
    }

    // 📅 AGENDAMENTO GUIADO — quem pode agendar (admin + estúdio)
    if (podeAgendar(chatId)) {
      const textoOriginal = message.text.trim();

      // cancelar a qualquer momento
      if (conversasAgendamento[chatId] && textoMensagem === 'cancelar') {
        delete conversasAgendamento[chatId];
        await sendMessage(chatId, "Agendamento cancelado. 👍");
        return;
      }

      // inicia o fluxo — !agendar (1 data) ou !agendar N (N datas do mesmo cliente)
      if (textoMensagem === '!agendar' || /^!agendar\s+\d+$/.test(textoMensagem)) {
        const mQtd = textoMensagem.match(/^!agendar\s+(\d+)$/);
        const qtd = mQtd ? Math.max(1, Math.min(10, parseInt(mQtd[1]))) : 1;
        conversasAgendamento[chatId] = {
          passo: 'data',
          qtd,
          reservas: [],       // vai guardando {dia,mes,h1,m1,h2,m2,estudio,calId,unidade}
          dados: {},          // dados comuns: nome, telefone, pago
        };
        const rotulo = qtd > 1 ? ` (data 1 de ${qtd})` : "";
        await sendMessage(chatId, `📅 *Novo agendamento*${rotulo}\n\nQual a *data*? (ex: 25/07)\n\n_(escreva 'cancelar' a qualquer momento para desistir)_`);
        return;
      }

      // se há uma conversa em andamento, trata a resposta do passo atual
      if (conversasAgendamento[chatId]) {
        const conversa = conversasAgendamento[chatId];
        const d = conversa.dados;
        const reservaAtual = conversa.reservas.length; // índice da reserva sendo preenchida (0-based)

        if (conversa.passo === 'data') {
          const v = validarData(textoOriginal);
          if (!v) { await sendMessage(chatId, "⚠️ Data inválida. Use o formato DD/MM (ex: 25/07). Tente de novo:"); return; }
          conversa._temp = { dia: v.dia, mes: v.mes };
          conversa.passo = 'horario';
          await sendMessage(chatId, "🕐 Qual o *horário*? (ex: 14-16 ou 14:30-16:30)");
          return;
        }

        if (conversa.passo === 'horario') {
          const v = validarHorario(textoOriginal);
          if (!v) { await sendMessage(chatId, "⚠️ Horário inválido. Use HH-HH (ex: 14-16). Tente de novo:"); return; }
          conversa._temp.h1 = v.h1; conversa._temp.m1 = v.m1; conversa._temp.h2 = v.h2; conversa._temp.m2 = v.m2;
          conversa.passo = 'estudio';
          await sendMessage(chatId, "📸 Qual o *estúdio*?\n\nAclimação: A, B, C, D, AB\nBela Vista: 1, 2, 3");
          return;
        }

        if (conversa.passo === 'estudio') {
          const v = validarEstudio(textoOriginal);
          if (!v) { await sendMessage(chatId, "⚠️ Estúdio inválido. Escreva A, B, C, D, AB, 1, 2 ou 3. Tente de novo:"); return; }
          conversa._temp.estudio = v.estudio; conversa._temp.calId = v.calId; conversa._temp.unidade = v.unidade;
          conversa.reservas.push(conversa._temp);
          delete conversa._temp;

          // ainda faltam datas? repete o ciclo data/horário/estúdio
          if (conversa.reservas.length < conversa.qtd) {
            const proxima = conversa.reservas.length + 1;
            conversa.passo = 'data';
            await sendMessage(chatId, `📅 Data ${proxima} de ${conversa.qtd}: qual a *data*? (ex: 25/07)`);
            return;
          }

          // todas as datas coletadas, segue para os dados do cliente
          conversa.passo = 'nome';
          await sendMessage(chatId, "👤 Qual o *nome* do cliente?");
          return;
        }

        if (conversa.passo === 'nome') {
          if (!textoOriginal || textoOriginal.length < 2) { await sendMessage(chatId, "⚠️ Escreva o nome do cliente:"); return; }
          d.nome = textoOriginal;

          // 1ª tentativa: telefone conhecido de reservas anteriores na agenda
          let conhecido = await buscarTelefoneConhecido(textoOriginal);
          // 2ª tentativa: contatos do Google (zmphoto@zmphoto.com.br) — seguro aqui no Telegram,
          // já que não depende do Puppeteer/whatsapp-web.js que causou a instabilidade anterior
          if (!conhecido) conhecido = await buscarContatoGoogle(textoOriginal);

          if (conhecido) {
            d._telefoneSugerido = conhecido.telefone;
            conversa.passo = 'confirmarTelefoneConhecido';
            const origemTxt = conhecido.origem ? ` (${conhecido.origem})` : " em outra reserva";
            await sendMessage(chatId, `📱 Já tenho o telefone *${conhecido.telefone}* de "${conhecido.nome}"${origemTxt}.\nÉ esse mesmo? Responda *SIM* ou digite o telefone correto.`);
            return;
          }

          conversa.passo = 'telefone';
          await sendMessage(chatId, "📞 Qual o *telefone*? (com DDD, ex: 11999998888)");
          return;
        }

        if (conversa.passo === 'confirmarTelefoneConhecido') {
          if (textoMensagem === 'sim') {
            d.telefone = d._telefoneSugerido;
            delete d._telefoneSugerido;
            conversa.passo = 'pagamento';
            await sendMessage(chatId, "💰 É *pré-reserva* ou já foi *pago*?\n\nEscreva 'pré' ou 'pago'");
            return;
          }
          // se não digitou "sim", tenta usar o que ela mandou como o telefone certo
          const num = textoOriginal.replace(/\D/g, "");
          if (num.length < 10) { await sendMessage(chatId, "⚠️ Responda *SIM* para usar o telefone sugerido, ou digite o telefone correto (com DDD):"); return; }
          d.telefone = num;
          delete d._telefoneSugerido;
          conversa.passo = 'pagamento';
          await sendMessage(chatId, "💰 É *pré-reserva* ou já foi *pago*?\n\nEscreva 'pré' ou 'pago'");
          return;
        }

        if (conversa.passo === 'telefone') {
          const num = textoOriginal.replace(/\D/g, "");
          if (num.length < 10) { await sendMessage(chatId, "⚠️ Telefone inválido. Digite com DDD (ex: 11999998888):"); return; }
          d.telefone = num;
          conversa.passo = 'pagamento';
          await sendMessage(chatId, "💰 É *pré-reserva* ou já foi *pago*?\n\nEscreva 'pré' ou 'pago'");
          return;
        }

        if (conversa.passo === 'pagamento') {
          if (textoMensagem === 'pre' || textoMensagem === 'pré') {
            d.pago = null;
            conversa.passo = 'confirmar';
            await enviarResumoAgendamento(chatId, conversa);
            return;
          }
          if (textoMensagem === 'pago') {
            conversa.passo = 'valor';
            await sendMessage(chatId, "💵 Qual o *valor pago*? (ex: 210)");
            return;
          }
          await sendMessage(chatId, "⚠️ Escreva 'pré' ou 'pago':");
          return;
        }

        if (conversa.passo === 'valor') {
          const valor = textoOriginal.replace(/[^\d.,]/g, "").replace(",", ".");
          if (!valor) { await sendMessage(chatId, "⚠️ Valor inválido. Digite só o número (ex: 210):"); return; }
          d.pago = valor;
          conversa.passo = 'confirmar';
          await enviarResumoAgendamento(chatId, conversa);
          return;
        }

        if (conversa.passo === 'confirmar') {
          if (textoMensagem === 'sim') {
            // checa conflito em TODAS as reservas antes de criar qualquer uma
            for (const r of conversa.reservas) {
              const { inicio, fim } = montarDatas(r);
              r.inicio = inicio; r.fim = fim;
              const conflito = await horarioOcupado(r.calId, r.estudio, inicio, fim);
              if (conflito) {
                const ci = new Date(conflito.start.dateTime || conflito.start.date);
                const cf = new Date(conflito.end.dateTime || conflito.end.date);
                const hi = ci.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
                const hf = cf.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
                const dataFmt = ci.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
                await sendMessage(chatId, `❌ O estúdio ${r.estudio} já está ocupado em ${dataFmt}!\nJá existe: "${conflito.summary}" das ${hi} às ${hf}.\n\nNenhuma reserva foi criada. Tente novamente.`);
                delete conversasAgendamento[chatId];
                return;
              }
            }

            // mínimo de R$50 por dia, se pago (garante mesmo que o valor total informado seja baixo)
            let pagoFinal = d.pago;
            if (pagoFinal) {
              const minimoTotal = conversa.reservas.length * 50;
              if (parseFloat(pagoFinal) < minimoTotal) {
                pagoFinal = String(minimoTotal);
                await sendMessage(chatId, `ℹ️ O valor informado é menor que o mínimo (R$50/dia). Ajustei para R$${minimoTotal} (${conversa.reservas.length} dia(s)).`);
              }
            }

            // cria todas as reservas
            const titulos = [];
            try {
              for (const r of conversa.reservas) {
                const titulo = await criarEvento({ ...r, nome: d.nome, telefone: d.telefone, pago: pagoFinal });
                titulos.push(titulo);
              }
              const lista = titulos.map(t => `📌 ${t}`).join("\n");
              await sendMessage(chatId, `✅ *Agendado com sucesso!* (${titulos.length} data${titulos.length > 1 ? "s" : ""})\n${lista}\n👤 ${d.nome} · ${d.telefone}${pagoFinal ? `\n💰 pago R$${pagoFinal} (total)` : "\n🔖 pré-reserva"}\n\n👇 Abaixo, a mensagem pronta para encaminhar ao cliente:`);
              await esperar(1500);
              await sendMessage(chatId, montarMensagemParaClienteMulti(d, conversa.reservas, pagoFinal));
            } catch (e) {
              await sendMessage(chatId, `❌ Erro ao criar o(s) evento(s): ${e.message}`);
            }
            delete conversasAgendamento[chatId];
            return;
          }
          if (textoMensagem === 'nao' || textoMensagem === 'não') {
            delete conversasAgendamento[chatId];
            await sendMessage(chatId, "Agendamento cancelado. 👍");
            return;
          }
          await sendMessage(chatId, "Responda *SIM* para confirmar ou *NÃO* para cancelar:");
          return;
        }
      }
    }

    // 🔒 COMANDOS DE ADMIN — liberado para o admin E para os números autorizados (estúdio)
    if (chatId === ADMIN_CHAT_ID || AGENDADORES.includes(chatId)) {
      if (textoMensagem === '!desativar' || textoMensagem === '!bot off') {
        botAtivo = false;
        await sendMessage(chatId, "❌ O robô foi DESATIVADO. Pode responder manualmente de forma tranquila!");
        return;
      }
      if (textoMensagem === '!ativar' || textoMensagem === '!bot on') {
        botAtivo = true;
        await sendMessage(chatId, "✅ O robô foi ATIVADO! Voltei a atender os clientes.");
        return;
      }
      if (textoMensagem === '!status') {
        await sendMessage(chatId, `🤖 O robô está atualmente: ${botAtivo ? "LIGADO ✅" : "DESLIGADO ❌"}`);
        return;
      }
      // 🔎 CONSULTA DE AGENDA — aceita filtros exatos OU frases livres (traduzidas pelo Gemini)
      // Ex.: !agenda A semana | !agenda quero saber como está o estúdio A essa semana
      if (textoMensagem.startsWith('!agenda')) {
        let argsTexto = message.text.trim().slice(7).trim();
        await sendMessage(chatId, '🔎 Consultando a agenda, um instante...');
        if (argsTexto) argsTexto = await normalizarComandoAgenda(argsTexto);
        await consultarAgenda(argsTexto, chatId);
        return;
      }
      // 🟢 HORÁRIOS VAGOS — igual ao !agenda, mas já mostra só os horários livres. Aceita frase livre também.
      // Ex.: !vagos A semana | !vagos quero saber os horários livres do estúdio 1 dia 2 e 10 de agosto às 14h
      if (textoMensagem.startsWith('!vagos')) {
        let argsTexto = message.text.trim().slice(6).trim();
        await sendMessage(chatId, '🔎 Calculando horários livres, um instante...');
        if (argsTexto) argsTexto = await normalizarComandoAgenda(argsTexto);
        await consultarAgenda((argsTexto + " livre").trim(), chatId);
        return;
      }
      // 🧪 ENSAIO: monta as confirmações "pré" e manda para quem pediu (nada vai pro cliente)
      if (textoMensagem === '!testar') {
        await rodarEnsaioConfirmacoes(false, chatId);
        return;
      }
      // ⏰ Roda o ciclo REAL agora (igual ao automático das 8h): marca [cobrado Nx] na agenda
      // e envia de verdade para números de teste. Útil para testar sem esperar até amanhã.
      if (textoMensagem === '!rodarciclo') {
        await sendMessage(chatId, "⏰ Rodando o ciclo real agora (marca avisos + envia para números de teste)...");
        await rodarEnsaioConfirmacoes(true, chatId);
        return;
      }
      // 📵 lista as reservas "pré" que estão sem telefone
      if (textoMensagem === '!semtelefone') {
        await listarSemTelefone(chatId);
        return;
      }
      // 🔍 busca reservas por nome do cliente. Ex.: !buscar new star
      if (textoMensagem.startsWith('!buscar')) {
        const termo = message.text.trim().slice(7).trim(); // texto depois de "!buscar"
        if (!termo) {
          await sendMessage(chatId, "Escreva o nome depois do comando. Ex.: !buscar new star");
        } else {
          await buscarPorNome(termo, chatId);
        }
        return;
      }
      // 🧪 testa o envio real para UM telefone específico. Ex.: !testarnumero 553291590828
      if (textoMensagem.startsWith('!testarnumero')) {
        const tel = message.text.trim().slice(13).trim();
        if (!tel) {
          await sendMessage(chatId, "Escreva o telefone depois do comando. Ex.: !testarnumero 553291590828");
        } else {
          await testarUmNumero(tel, chatId);
        }
        return;
      }
      // 💰 confirma pagamento de todas as reservas "pré" de um telefone. Ex.: !confirmarpagamento 11999998888 210
      if (textoMensagem.startsWith('!confirmarpagamento')) {
        const partes = message.text.trim().slice(20).trim().split(/\s+/);
        const tel = partes[0];
        const valor = partes[1];
        if (!tel || !valor) {
          await sendMessage(chatId, "Use: !confirmarpagamento [telefone] [valor]\nEx.: !confirmarpagamento 11999998888 210");
        } else {
          await confirmarPagamento(tel, valor, chatId);
        }
        return;
      }
      // 🔄 reseta as marcações [cobrado Nx] de clientes reais (necessário antes de ligar o envio real)
      // !resetaravisos mostra a prévia; !resetaravisos confirmar executa de verdade
      if (textoMensagem.startsWith('!resetaravisos')) {
        const confirmar = textoMensagem.includes('confirmar');
        await resetarAvisosClientesReais(chatId, confirmar);
        return;
      }
      // ❓ lista os comandos disponíveis
      if (textoMensagem === '!ajuda') {
        await sendMessage(chatId,
          "🤖 *Comandos disponíveis:*\n\n" +
          "!testar — mostra as cobranças de hoje (não marca nada na agenda)\n" +
          "!rodarciclo — roda o ciclo real AGORA (marca avisos + gera os links prontos)\n" +
          "!semtelefone — lista reservas sem telefone\n" +
          "!buscar [nome] — busca reservas de um cliente\n" +
          "!testarnumero [telefone] — mostra a mensagem + link pronto para um número específico\n" +
          "!confirmarpagamento [telefone] [valor] — marca reservas como pagas (para de cobrar)\n" +
          "!resetaravisos — mostra quantas reservas seriam resetadas (!resetaravisos confirmar executa)\n" +
          "!agenda [estúdio/unidade] [semana/data] — mostra a agenda (ex.: !agenda A semana)\n" +
          "!vagos [estúdio/unidade] [semana/data] — mostra só os horários livres (ex.: !vagos bela vista hoje)\n" +
          "!status — diz se o respondedor está ligado\n" +
          "!ativar / !desativar — liga/desliga o respondedor\n" +
          "!agendar — cria uma nova reserva (passo a passo)\n" +
          "!meuid — mostra seu ID\n\n" +
          "_Lembrete: este bot nunca manda mensagem direto pro cliente — ele sempre entrega o texto + um link pronto do WhatsApp, pra vocês conferirem e apertarem Enviar._"
        );
        return;
      }
    }

    // 🔒 Este bot é de uso 100% interno — só a equipe (admin + agendadores) tem acesso.
    // Diferente do WhatsApp, aqui nunca é o cliente quem fala direto com o bot.
    if (!podeAgendar(chatId)) {
      await sendMessage(chatId, "Este bot é de uso interno da equipe ZM Photo.");
      return;
    }

    // Se o bot estiver pausado/desativado, os comandos "!" acima já funcionaram normalmente;
    // só a resposta livre (Gemini) abaixo fica em espera
    if (!botAtivo) return;

    // Resposta livre (Gemini) para perguntas soltas da equipe, fora dos comandos "!"
    const resposta = await gerarRespostaGemini(chatId, message.text, nomeUsuario);
    await sendMessage(chatId, resposta);
  } catch (e) { console.error(e); }
});

app.get('/', (req, res) => res.send('Bot Telegram ZM Photo — Online'));

// Registra o webhook do Telegram automaticamente ao subir (aponta pro próprio endereço do Railway).
// Também pode ser chamado manualmente visitando /setup no navegador, se precisar registrar de novo.
app.get('/setup', async (req, res) => {
  try {
    const url = `${req.protocol}://${req.get('host')}/webhook`;
    const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(url)}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// =============================
// AGENDADOR — roda o ENSAIO automaticamente todo dia às 8h (fuso de São Paulo)
// =============================
cron.schedule('0 8 * * *', async () => {
  console.log("⏰ Rodando o ensaio automático das 8h...");
  try {
    await rodarEnsaioConfirmacoes(true, CHAT_MATINAL); // automático das 8h: marca [cobrado Nx] na agenda
  } catch (e) {
    console.error("Erro no ensaio automático:", e.message);
  }
}, { timezone: "America/Sao_Paulo" });

app.listen(PORT, async () => {
  console.log(`🚀 Bot Telegram rodando na porta ${PORT}`);
  // registra o webhook automaticamente ao iniciar
  try {
    const url = `${process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : ""}/webhook`;
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      const r = await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(url)}`);
      const data = await r.json();
      console.log("Registro do webhook:", data.ok ? "✅ OK" : `⚠️ ${JSON.stringify(data)}`);
    }
  } catch (e) {
    console.error("Erro ao registrar webhook automaticamente:", e.message);
  }
});
