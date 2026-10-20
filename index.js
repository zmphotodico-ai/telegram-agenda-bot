import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import cron from "node-cron";

const app = express();
app.use("/pedido", express.json({ limit: "2kb" })); // pedido do site: corpo pequeno
app.use(express.json());

const PORT = process.env.PORT || 3000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const CALENDAR_ID = process.env.CALENDAR_ID || "alugueldeestudiofotografico@gmail.com";

const CALENDAR_IDS = (process.env.CALENDAR_IDS || CALENDAR_ID)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";

const AGENDADORES = (process.env.AGENDADORES || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const CHAT_MATINAL = process.env.CHAT_MATINAL || ADMIN_CHAT_ID;

function podeAgendar(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID) || AGENDADORES.includes(String(chatId));
}

let botAtivo = false;

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

let peopleClient;
try {
  const googleContatosConfig = JSON.parse(process.env.GOOGLE_CONTATOS_CONFIG);
  const privateKeyContatos = googleContatosConfig.private_key.replace(/\\n/g, "\n");
  const authContatos = new google.auth.JWT({
    email: googleContatosConfig.client_email,
    key: privateKeyContatos,
    scopes: ["https://www.googleapis.com/auth/contacts.readonly"],
    subject: "zmphoto@zmphoto.com.br",
  });
  peopleClient = google.people({ version: "v1", auth: authContatos });
} catch (error) { console.error("Erro People API (contatos):", error); }

async function sendMessage(chatId, text, semMarkdown = false) {
  if (!chatId || !text) return false;
  try {
    const body = { chat_id: chatId, text };
    if (!semMarkdown) body.parse_mode = "Markdown";
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
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

// envia a mensagem pronta pro cliente em DOIS blocos separados, sem markdown:
// 1) o texto puro (pra copiar/colar limpo)  2) a URL do WhatsApp pura (não quebra como o markdown)
// Se não houver telefone, envia só o texto.
async function enviarTextoELink(chatId, texto, telefone) {
  await sendMessage(chatId, texto, true); // texto limpo, sem markdown
  if (telefone) {
    await esperar(600);
    await sendMessage(chatId, `👉 Toque para enviar no WhatsApp:\n${linkWhatsApp(telefone, texto)}`, true);
  }
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function variantesTelefone(tel) {
  if (!tel || tel.length < 12) return [tel];
  const cc = tel.slice(0, 2);
  const ddd = tel.slice(2, 4);
  const resto = tel.slice(4);
  const variantes = new Set([tel]);
  if (resto.length === 9 && resto[0] === "9") {
    variantes.add(cc + ddd + resto.slice(1));
  } else if (resto.length === 8) {
    variantes.add(cc + ddd + "9" + resto);
  }
  return Array.from(variantes);
}

function linkWhatsApp(telefone, texto) {
  const numero = (telefone || "").replace(/\D/g, "");
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

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

function normalizar(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extrairTelefone(texto) {
  if (!texto) return null;
  const m = texto.match(/(?:\+?55\s?)?\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}/);
  if (!m) return null;
  let num = m[0].replace(/\D/g, "");
  if (num.length <= 11) num = "55" + num;
  return num;
}

function extrairNome(ev) {
  let desc = (ev.description || "").split("\n")[0].trim();
  if (!desc) return null;
  desc = desc.replace(/#/g, " ");
  desc = desc.replace(/\baluguel\b/gi, " ");
  desc = desc.replace(/\s*(\+?55)?[\s(]*\d{2}[\s).-]*\d.*$/, "");
  desc = desc.replace(/\s*R\$.*/i, "");
  desc = desc.replace(/\s+/g, " ").trim();
  return desc || null;
}

function extrairEstudio(ev) {
  let t = (ev.summary || "").toUpperCase();
  t = t.replace(/PR[EÉ]/g, " ");
  t = t.replace(/\d{1,2}\s*[:.]?\s*\d{0,2}\s*[-–/]\s*\d{1,2}\s*[:.]?\s*\d{0,2}/g, " ");
  t = t.replace(/[\/*#.\-–]/g, " ").replace(/\s+/g, " ").trim();
  const candidatos = ["AB", "A", "B", "C", "D", "1", "2", "3"];
  const tokens = t.split(" ").filter(Boolean);
  for (const c of candidatos) {
    if (tokens.includes(c)) return c;
  }
  return null;
}

function rotuloEstudioCodigo(est) {
  if (!est) return "Estúdio não identificado";
  const ag = agendaDoEstudio(est);
  return ag ? `Estúdio ${est} (${ag.unidade})` : `Estúdio ${est}`;
}

function rotuloEstudioEvento(ev) {
  return rotuloEstudioCodigo(extrairEstudio(ev));
}

function formatarAgendaPorDia(eventos) {
  const grupos = {};
  for (const ev of eventos) {
    const ini = new Date(ev.start.dateTime || ev.start.date);
    const chave = ini.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
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

function calcularValores(ev, ehAclimacao) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const horas = (fim - inicio) / (1000 * 60 * 60);
  if (!horas || horas <= 0) return null;
  const diaTxt = inicio.toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const ehFimDeSemana = (diaTxt === "Sat" || diaTxt === "Sun");
  const periodo = ehFimDeSemana ? "fds" : "semana";
  const unidade = ehAclimacao ? "aclimacao" : "belavista";
  const estudioBruto = extrairEstudio(ev).toUpperCase().replace(/\s/g, "");
  const valorHora = TABELA_PRECOS[unidade][periodo][estudioBruto];
  if (!valorHora) return null;
  const total = Math.round(horas * valorHora);
  let sinal = Math.floor((total / 3) / 10) * 10;
  if (sinal < 50) sinal = 50;
  return { total, sinal };
}

function montarMensagemConfirmacao(ev, calId) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const dataExtenso = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: 'numeric', month: 'long' });
  const horaInicio = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const horaFim = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const ehAclimacao = (CALENDAR_IDS[0] === calId);
  const endereco = ehAclimacao ? "Rua Gualaxo, 206 - Aclimação" : "Rua Santa Madalena, 46 - Bela Vista";
  const estudio = extrairEstudio(ev);
  const textoEstudio = estudio ? `, no Estúdio ${estudio}` : "";
  const nome = extrairNome(ev);
  const saudacao = nome ? `Olá ${nome}, tudo bem? 😊` : "Olá, tudo bem? 😊";
  const valores = calcularValores(ev, ehAclimacao);
  const linhaValor = valores ? `\n\nSinal para reservar: R$ ${valores.sinal}` : "";
  return `${saudacao}\nGostaria de confirmar o Aluguel de Estúdio ${dataExtenso}, das ${horaInicio} às ${horaFim}${textoEstudio}.\n${endereco}${linhaValor}\n\nPIX/CNPJ\nzmphoto@zmphoto.com.br\n43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
}

// true se a reserva é do tipo "confirmar presença" (zm2) — não cobra sinal, só confirma
function ehZm2(ev) {
  const alvo = normalizar((ev.summary || "") + " " + (ev.description || ""));
  return /\bzm2\b/.test(alvo);
}

// mensagem de CONFIRMAÇÃO DE PRESENÇA (zm2) — sem PIX, sem valor
function montarMensagemPresenca(ev, calId) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const dataExtenso = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: 'numeric', month: 'long' });
  const hi = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const hf = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const ehAclimacao = (CALENDAR_IDS[0] === calId);
  const endereco = ehAclimacao ? "Rua Gualaxo, 206 - Aclimação" : "Rua Santa Madalena, 46 - Bela Vista";
  const estudio = extrairEstudio(ev);
  const textoEstudio = estudio ? `, no Estúdio ${estudio}` : "";
  const nome = extrairNome(ev);
  const saudacao = nome ? `Olá ${nome}, tudo bem? 😊` : "Olá, tudo bem? 😊";
  return `${saudacao}\nPassando pra confirmar seu ensaio de ${dataExtenso}, das ${hi} às ${hf}${textoEstudio}.\n${endereco}\n\nEstá tudo certo pra esse dia?`;
}

// mensagem de CONFIRMAÇÃO 48h para quem JÁ PAGOU — tom simpático, sem cobrança
function montarMensagem48hPago(ev, calId) {
  const inicio = new Date(ev.start.dateTime || ev.start.date);
  const fim = new Date(ev.end.dateTime || ev.end.date);
  const dataExtenso = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: 'numeric', month: 'long' });
  const hi = inicio.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const hf = fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' }).replace(":", "h");
  const ehAclimacao = (CALENDAR_IDS[0] === calId);
  const endereco = ehAclimacao ? "Rua Gualaxo, 206 - Aclimação" : "Rua Santa Madalena, 46 - Bela Vista";
  const estudio = extrairEstudio(ev);
  const textoEstudio = estudio ? `, no Estúdio ${estudio}` : "";
  const nome = extrairNome(ev);
  const saudacao = nome ? `Olá ${nome}, tudo bem? 😊` : "Olá, tudo bem? 😊";
  return `${saudacao}\nPassando pra lembrar do seu ensaio de ${dataExtenso}, das ${hi} às ${hf}${textoEstudio}. Sua reserva está confirmada!\n${endereco}\nNos vemos lá 😊`;
}

async function coletarEventosPre(diasFrente = 360) {
  const agora = new Date();
  const limite = new Date(agora.getTime() + diasFrente * 24 * 60 * 60 * 1000);
  let achados = [];
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
        // "zm" puro = não cobrar (pula). "zm2" = confirmar presença (NÃO pula, entra na régua).
        if (/\bzm\b/.test(alvo) && !/\bzm2\b/.test(alvo)) continue;
        if (/\[pago\b/.test(alvo)) continue;
        if (/\bpre\b/.test(alvo)) {
          achados.push({ ev, calId });
        }
      }
    } catch (e) { console.error(`Erro ao ler a agenda ${calId}:`, e.message); }
  }
  return achados;
}

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

function escolherNome(eventos) {
  let melhor = "";
  for (const { ev } of eventos) {
    const nome = extrairNome(ev) || "";
    if (nome.length > melhor.length) melhor = nome;
  }
  return melhor || null;
}

function montarMensagemAgrupada(eventos) {
  eventos.sort((a, b) =>
    new Date(a.ev.start.dateTime || a.ev.start.date) - new Date(b.ev.start.dateTime || b.ev.start.date)
  );
  const nome = escolherNome(eventos);
  const saudacao = nome ? `Olá ${nome}, tudo bem? 😊` : "Olá, tudo bem? 😊";
  const ehAclimacao = (CALENDAR_IDS[0] === eventos[0].calId);
  const endereco = ehAclimacao ? "Rua Gualaxo, 206 - Aclimação" : "Rua Santa Madalena, 46 - Bela Vista";
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

async function resetarAvisosClientesReais(destino, executar = false) {
  const achados = await coletarEventosPre(360);
  const paraResetar = [];
  for (const { ev, calId } of achados) {
    if (!/\[cobrado\s+\d+x/i.test(ev.description || "")) continue;
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
  await sendMessage(destino, `🔍 ${encontrados.length} reserva(s) encontrada(s) para ${telReal}:`);
  await enviarTextoELink(destino, msg, telReal);
}

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

function contarAvisos(ev) {
  const desc = ev.description || "";
  const matches = desc.match(/\[cobrado \d+x/gi);
  return matches ? matches.length : 0;
}

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

async function moverParaCancelados(ev, calIdOrigem) {
  const calIdDestino = CALENDAR_IDS[2];
  if (!calIdDestino) throw new Error("Agenda Cancelados não configurada (falta o 3º ID em CALENDAR_IDS).");
  await calendar.events.insert({
    calendarId: calIdDestino,
    requestBody: {
      summary: ev.summary,
      description: (ev.description || "") + "\n[cancelado manualmente]",
      start: ev.start,
      end: ev.end,
      colorId: ev.colorId,
    },
  });
  await calendar.events.delete({ calendarId: calIdOrigem, eventId: ev.id });
}

// roda o ciclo diário. Se marcar=true, escreve [cobrado Nx] na descrição (1ª/2ª cobrança).
// IMPORTANTE: NUNCA manda mensagem direto pro cliente e NUNCA cancela sozinho.
// No 3º aviso, apenas ALERTA o admin (🔴) para decidir manualmente.
async function rodarEnsaioConfirmacoes(marcar = false, destino = ADMIN_CHAT_ID) {
  await sendMessage(destino, `🔎 ${marcar ? "Relatório automático das 8h" : "Consulta"}: procurando reservas 'pré'...`);
  const achados = await coletarEventosPre(360);
  if (achados.length === 0) {
    await sendMessage(destino, "Nenhuma reserva com 'pré' encontrada nos próximos 90 dias.");
    return;
  }

  const paraCobrar = [];
  const paraCancelar = [];
  const paraPresenca = []; // zm2 — confirma presença, não cobra sinal
  for (const item of achados) {
    if (ehZm2(item.ev)) { paraPresenca.push(item); continue; }
    if (contarAvisos(item.ev) >= 2) paraCancelar.push(item);
    else paraCobrar.push(item);
  }

  if (paraCobrar.length === 0 && paraCancelar.length === 0 && paraPresenca.length === 0) {
    await sendMessage(destino, "Nenhuma reserva a processar hoje.");
    return;
  }

  const grupos = {};
  const semTelefone = [];
  for (const item of paraCobrar) {
    const tel = extrairTelefone((item.ev.summary || "") + " " + (item.ev.description || ""));
    if (tel) { (grupos[tel] = grupos[tel] || []).push(item); }
    else semTelefone.push(item);
  }

  const totalClientes = Object.keys(grupos).length + semTelefone.length;
  if (paraCobrar.length > 0) {
    await sendMessage(destino, `Encontrei ${paraCobrar.length} reserva(s) a cobrar, agrupadas em ${totalClientes} cliente(s). Toque no link de cada uma pra enviar. 👇`);
  }

  let marc1 = 0, marc2 = 0;

  async function marcarLista(eventos) {
    if (!marcar) return;
    for (const { ev, calId } of eventos) {
      const proximo = contarAvisos(ev) + 1;
      const ok = await marcarCobranca(ev, calId, proximo);
      if (ok) { if (proximo === 1) marc1++; else marc2++; }
    }
  }

  for (const tel of Object.keys(grupos)) {
    const eventos = grupos[tel];
    try {
      const msg = montarMensagemAgrupada(eventos);
      const qtd = eventos.length > 1 ? ` (${eventos.length} datas)` : "";
      await sendMessage(destino, `━━━━━━━━━━\n📞 ${tel}${qtd}`);
      await enviarTextoELink(destino, msg, tel);
    } catch (e) {
      await sendMessage(destino, `⚠️ Erro ao processar o cliente ${tel}: ${e.message}`);
    }
    await marcarLista(eventos);
    await esperar(500);
  }

  for (const item of semTelefone) {
    try {
      const msg = montarMensagemAgrupada([item]);
      await sendMessage(destino, `━━━━━━━━━━\n📞 ⚠️ SEM telefone — ${item.ev.summary || "(sem título)"} — copie o texto abaixo:`);
      await enviarTextoELink(destino, msg, null);
    } catch (e) {
      await sendMessage(destino, `⚠️ Erro ao processar "${item.ev.summary || "(sem título)"}": ${e.message}`);
    }
    await marcarLista([item]);
    await esperar(500);
  }

  // ✋ CONFIRMAÇÃO DE PRESENÇA (zm2) — não cobra sinal, só confirma se o ensaio vai rolar
  if (paraPresenca.length > 0) {
    await sendMessage(destino, `✋ ${paraPresenca.length} reserva(s) de *confirmar presença* (sem cobrança de sinal): 👇`);
    for (const { ev, calId } of paraPresenca) {
      try {
        const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
        const msg = montarMensagemPresenca(ev, calId);
        const inicio = new Date(ev.start.dateTime || ev.start.date);
        const dataFmt = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'short', day: '2-digit', month: '2-digit' });
        await sendMessage(destino, `━━━━━━━━━━\n✋ ${dataFmt} · ${rotuloEstudioEvento(ev)}${tel ? "" : " · ⚠️ SEM telefone"}`);
        await enviarTextoELink(destino, msg, tel);
      } catch (e) {
        await sendMessage(destino, `⚠️ Erro na confirmação de "${ev.summary || "(sem título)"}": ${e.message}`);
      }
      await esperar(500);
    }
  }

  // 🔴 3º AVISO — reservas que já têm 2 avisos acumulados.
  // MUDANÇA DE SEGURANÇA: o bot NÃO move mais nada para Cancelados automaticamente.
  // Ele apenas ALERTA (sinal vermelho) para o admin decidir na mão.
  for (const { ev, calId } of paraCancelar) {
    try {
      const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
      const msgCliente = montarMensagemConfirmacao(ev, calId);
      const inicio = new Date(ev.start.dateTime || ev.start.date);
      const dataFmt = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: '2-digit', month: '2-digit' });
      const cabecalho = `🔴 *3º AVISO DE COBRANÇA — precisa da sua decisão*\n📌 ${dataFmt} · ${rotuloEstudioEvento(ev)}\n\nEsta reserva já recebeu 2 avisos e continua sem confirmação.\n⚠️ O bot NÃO cancelou nada. Você decide: cobrar de novo, ou cancelar manualmente.`;
      await sendMessage(destino, cabecalho);
      await enviarTextoELink(destino, msgCliente, tel);
    } catch (e) {
      await sendMessage(destino, `⚠️ Erro no 3º aviso de "${ev.summary || "(sem título)"}": ${e.message}`);
    }
    await esperar(500);
  }

  const resumoMarca = marcar
    ? `\n📌 ${marc1} marcada(s) como 1ª cobrança\n📌 ${marc2} marcada(s) como 2ª cobrança`
    : "\n(Modo consulta: nada foi marcado na agenda.)";
  const resumoCancel = paraCancelar.length
    ? `\n🔴 ${paraCancelar.length} reserva(s) no 3º aviso — precisam da sua decisão (NADA foi cancelado automaticamente).`
    : "";
  const resumoPresenca = paraPresenca.length
    ? `\n✋ ${paraPresenca.length} confirmação(ões) de presença (zm2 — sem cobrança).`
    : "";
  await sendMessage(destino, `✅ Fim do relatório.${resumoMarca}${resumoCancel}${resumoPresenca}`);
}

// CONFIRMAÇÃO 48h — para quem JÁ PAGOU e tem ensaio em ~2 dias.
// Roda às 9h. Não cobra nada: entrega mensagem simpática + link para o admin enviar (filtragem final é dele).
async function rodarConfirmacao48h(destino = ADMIN_CHAT_ID) {
  await sendMessage(destino, "🔎 Confirmação de presença (48h): procurando ensaios pagos para daqui a ~2 dias...");
  const agora = new Date();
  // janela: eventos que começam entre 36h e 60h a partir de agora (cobre "cerca de 48h", pega o dia todo do 2º dia)
  const inicioJanela = new Date(agora.getTime() + 36 * 3600000);
  const fimJanela = new Date(agora.getTime() + 60 * 3600000);
  const encontrados = [];
  for (const calId of CALENDAR_IDS.slice(0, 2)) {
    try {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: inicioJanela.toISOString(),
        timeMax: fimJanela.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });
      for (const ev of (res.data.items || [])) {
        const alvo = normalizar((ev.summary || "") + " " + (ev.description || ""));
        // só quem JÁ PAGOU (tem marca de pago). Ignora zm puro e zm2 (esses têm régua própria).
        const pago = /\[pago\b/.test(alvo) || /\bpago\b/.test(alvo);
        if (!pago) continue;
        if (/\bzm\b/.test(alvo) && !/\bzm2\b/.test(alvo)) continue; // zm puro fora
        if (/\bzm2\b/.test(alvo)) continue; // zm2 já foi confirmado na régua das 8h
        encontrados.push({ ev, calId });
      }
    } catch (e) { console.error(`Erro ao ler agenda (48h) ${calId}:`, e.message); }
  }

  if (encontrados.length === 0) {
    await sendMessage(destino, "Nenhum ensaio pago para confirmar (48h). 👍");
    return;
  }

  await sendMessage(destino, `✋ ${encontrados.length} ensaio(s) pago(s) para daqui a ~2 dias. Confira e envie os que fizerem sentido: 👇`);
  for (const { ev, calId } of encontrados) {
    try {
      const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
      const msg = montarMensagem48hPago(ev, calId);
      const inicio = new Date(ev.start.dateTime || ev.start.date);
      const dataFmt = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: '2-digit', month: '2-digit' });
      await sendMessage(destino, `━━━━━━━━━━\n✅ PAGO · ${dataFmt} · ${rotuloEstudioEvento(ev)}${tel ? "" : " · ⚠️ SEM telefone"}`);
      await enviarTextoELink(destino, msg, tel);
    } catch (e) {
      await sendMessage(destino, `⚠️ Erro na confirmação 48h de "${ev.summary || "(sem título)"}": ${e.message}`);
    }
    await esperar(500);
  }
  await sendMessage(destino, "✅ Fim da confirmação de presença (48h).");
}

async function gerarRespostaGemini(chatId, pergunta, nomeUsuario = "Cliente") {
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const ocupacaoAtual = await getAgendaOcupada();
  const SYSTEM_PROMPT = `
Você é o assistente virtual do Aluguel de Estúdio Fotográfico. Seu objetivo é fechar reservas e informar o cliente.
CLIENTE: ${nomeUsuario}.

🚨 REGRAS DE OURO (NUNCA IGNORE):
1. MÍNIMO: 2 horas de locação.
2. DISPONIBILIDADE: Consulte SEMPRE a agenda abaixo. Se estiver livre, ofereça.
3. PREÇOS: NÃO cite valores de memória. Para QUALQUER pergunta de preço, direcione ao PDF oficial.
4. GRUPOS 9-12 PESSOAS: Apenas Estúdio AB na Aclimação (consulte o PDF).
5. SINAL: sempre 1/3 do valor total, arredondado para baixo em múltiplos de R$10, mínimo R$50. PIX CNPJ: 43.345.289/0001-93.
6. TARIFA NOTURNA: Após as 21h os valores mudam. Avise e direcione ao PDF.

📄 PDF E FOTOS:
- PDF: https://drive.google.com/file/d/1J8FC6mzmfkOhlHbRrKVLN92jYj9LF1bb/view?usp=sharing
- FOTOS ACLIMAÇÃO: https://drive.google.com/drive/folders/100GPqd9sWFRtEE5YPZCYhyv_DkBNV_G9
- FOTOS BELA VISTA: https://drive.google.com/drive/folders/1Navk6o2Gy9cDlD9FKAuizH8hd3nTMLEW

⚠️ GATILHO HUMANO (11 99554-0293): Portão, Uber, visitas técnicas, equipamentos específicos ou exceções de pagamento -> encaminhe.

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

const conversasAgendamento = {};

function agendaDoEstudio(est) {
  const aclimacao = ["A", "B", "C", "D", "AB"];
  const belavista = ["1", "2", "3"];
  if (aclimacao.includes(est)) return { calId: CALENDAR_IDS[0], unidade: "Aclimação" };
  if (belavista.includes(est)) return { calId: CALENDAR_IDS[1], unidade: "Bela Vista" };
  return null;
}

function validarData(txt) {
  const md = (txt || "").trim().match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!md) return null;
  const dia = parseInt(md[1]), mes = parseInt(md[2]);
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return null;
  return { dia, mes };
}

function validarHorario(txt) {
  const mh = (txt || "").trim().match(/^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/);
  if (!mh) return null;
  const h1 = parseInt(mh[1]), m1 = parseInt(mh[2] || "0");
  const h2 = parseInt(mh[3]), m2 = parseInt(mh[4] || "0");
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null;
  return { h1, m1, h2, m2 };
}

function validarEstudio(txt) {
  const estudio = (txt || "").trim().toUpperCase();
  const ag = agendaDoEstudio(estudio);
  if (!ag) return null;
  return { estudio, ...ag };
}

// usa o Gemini para trocar datas em linguagem natural (amanhã, quinta, sábado) por DD/MM,
// mantendo o resto do texto igual. Retorna o texto com as datas já convertidas.
async function normalizarDatasNaturais(texto) {
  if (!texto || !texto.trim()) return texto;
  // se já não tem nada que pareça dia da semana / "amanha" / "hoje", nem chama o Gemini
  if (!/\b(hoje|amanha|amanhã|depois de amanha|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo)\b/i.test(texto)) return texto;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const hojeSP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const [hAno, hMes, hDia] = hojeSP.split("-");
  const diaSemHoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" });
  const prompt = `HOJE é ${hDia}/${hMes}/${hAno} (${diaSemHoje}).
No texto abaixo, troque QUALQUER referência a dia (hoje, amanhã, depois de amanhã, segunda, terça, quarta, quinta, sexta, sábado, domingo) pela data concreta no formato DD/MM. Um dia da semana sem indicação = a PRÓXIMA ocorrência dele a partir de hoje (mesmo que seja semana que vem). Mantenha todo o resto do texto EXATAMENTE igual, na mesma ordem. Se houver vários dias, troque todos.
Responda APENAS o texto resultante, sem aspas, sem explicação.

Exemplos (se hoje fosse 31/07/2026, quinta):
"amanhã 14-16 A João" -> "01/08 14-16 A João"
"quinta 10-12 1 Maria" -> "07/08 10-12 1 Maria"
"amanha quarta e quinta 10-12 A João" -> "01/08 05/08 06/08 10-12 A João"

TEXTO: "${texto}"
RESULTADO:`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json();
    const out = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return out || texto;
  } catch (e) {
    console.error("Erro ao normalizar datas naturais:", e.message);
    return texto;
  }
}

// extrai data(s), horário, estúdio, telefone e nome de um texto solto (em qualquer ordem).
// datas já devem estar em DD/MM (use normalizarDatasNaturais antes).
function extrairCamposAgendamento(texto) {
  const tokens = (texto || "").trim().split(/\s+/).filter(Boolean);
  const codigosEstudio = ["AB", "A", "B", "C", "D", "1", "2", "3"];
  const datas = [];
  let horario = null, estudio = null, telefone = null;
  const sobra = [];
  for (const tok of tokens) {
    if (/^\d{1,2}\/\d{1,2}$/.test(tok)) { const v = validarData(tok); if (v) { datas.push(v); continue; } }
    if (validarHorario(tok)) { horario = validarHorario(tok); continue; }
    if (!estudio && codigosEstudio.includes(tok.toUpperCase())) { estudio = tok.toUpperCase(); continue; }
    const digitos = tok.replace(/\D/g, "");
    if (digitos.length >= 10 && !telefone) { telefone = digitos; continue; }
    sobra.push(tok);
  }
  const nome = sobra.join(" ").trim() || null;
  return { datas, horario, estudio, telefone, nome };
}

// interpreta a frase inteira de agendamento com UMA chamada ao Gemini.
// devolve { datas:[{dia,mes}], horario:{h1,m1,h2,m2}|null, estudio, nome, telefone } — campos faltantes vêm null.
async function interpretarAgendamento(textoLivre) {
  const bruto = (textoLivre || "").trim();
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  const hojeSP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const [hAno, hMes, hDia] = hojeSP.split("-");
  const diaSemHoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" });
  const prompt = `Você extrai dados de um pedido de agendamento de estúdio fotográfico e devolve SÓ um JSON.

HOJE é ${hDia}/${hMes}/${hAno} (${diaSemHoje}). Use para calcular datas relativas (amanhã, quinta, sábado...). Um dia da semana sem indicação = a PRÓXIMA ocorrência a partir de hoje.

Estúdios válidos: A, B, C, D, AB (unidade Aclimação) e 1, 2, 3 (unidade Bela Vista).

Devolva um JSON com estes campos (use null quando não houver a informação):
{
  "datas": ["DD/MM", ...],        // uma ou mais datas concretas
  "horario": "HH:MM-HH:MM",       // início e fim; entenda "das 13h30 às 17h30", "14-16", "9 as 11" etc.
  "estudio": "A"|"B"|"C"|"D"|"AB"|"1"|"2"|"3",
  "nome": "só o nome da pessoa",  // NUNCA inclua horário, telefone, data, tipo ou a palavra estúdio aqui
  "telefone": "só dígitos",       // limpe +55, espaços, traços, parênteses. Ex.: 5512988147068
  "tipo": "pre"|"pago"|"zm"|"zm2"|null  // se o texto disser: zm (não cobrar), zm2 (confirmar presença), pago, ou pré
}

Regras:
- "nome" deve conter APENAS o nome do cliente, limpo. Nada de "estúdio", horário, números ou palavras como "zm", "zm2", "pago", "pré".
- Se o texto tiver "zm2" -> tipo "zm2". Se tiver "zm" (sem o 2) -> tipo "zm". Se disser "pago" -> "pago". Caso contrário deixe tipo null.
- Se o telefone vier com +55 ou DDD, mantenha só os dígitos (ex.: "+55 12 98814-7068" -> "5512988147068").
- Responda SOMENTE o JSON, sem texto antes ou depois, sem crases.

PEDIDO: "${bruto}"
JSON:`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const data = await res.json();
    let txt = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    txt = txt.replace(/```json/gi, "").replace(/```/g, "").trim();
    const obj = JSON.parse(txt);
    // normaliza para o formato interno
    const datas = [];
    for (const ds of (obj.datas || [])) {
      const v = validarData(String(ds).trim());
      if (v) datas.push(v);
    }
    let horario = null;
    if (obj.horario) {
      const h = validarHorario(String(obj.horario).replace(/\s/g, "").replace(/h/gi, ":").replace(/:(-|$)/g, "$1"));
      if (h) horario = h;
    }
    let estudio = null;
    if (obj.estudio && validarEstudio(String(obj.estudio))) estudio = String(obj.estudio).toUpperCase();
    let telefone = null;
    if (obj.telefone) {
      const dig = String(obj.telefone).replace(/\D/g, "");
      if (dig.length >= 10) telefone = dig.length <= 11 ? "55" + dig : dig;
    }
    const nome = obj.nome ? String(obj.nome).trim() : null;
    let tipo = null;
    if (obj.tipo) {
      const t = String(obj.tipo).toLowerCase().trim();
      if (["pre", "pré", "pago", "zm", "zm2"].includes(t)) tipo = t === "pré" ? "pre" : t;
    }
    return { datas, horario, estudio, telefone, nome, tipo, _ok: true };
  } catch (e) {
    console.error("Erro ao interpretar agendamento via Gemini:", e.message);
    return { datas: [], horario: null, estudio: null, telefone: null, nome: null, tipo: null, _ok: false };
  }
}

function montarDatas(dados) {
  const agora = new Date();
  let ano = dados.ano || agora.getFullYear();
  const p = (n) => String(n).padStart(2, "0");
  const montaISO = (a) =>
    `${a}-${p(dados.mes)}-${p(dados.dia)}T${p(dados.h1)}:${p(dados.m1)}:00-03:00`;
  let inicio = new Date(montaISO(ano));
  if (!dados.ano && inicio < agora && (agora - inicio) > 7 * 24 * 3600 * 1000) {
    ano = ano + 1;
    inicio = new Date(montaISO(ano));
  }
  const fim = new Date(`${ano}-${p(dados.mes)}-${p(dados.dia)}T${p(dados.h2)}:${p(dados.m2)}:00-03:00`);
  return { inicio, fim };
}

function estudiosConflitantes(estudio) {
  if (estudio === "A") return ["A", "AB"];
  if (estudio === "B") return ["B", "AB"];
  if (estudio === "AB") return ["A", "B", "AB"];
  return [estudio];
}

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
        if (inicio < ef && fim > ei) return ev;
      }
    }
    return null;
  } catch (e) {
    console.error("Erro ao checar conflito:", e.message);
    return null;
  }
}

// ===================== REGRAS DE ALUGUEL =====================
// Site (cliente): das 9h às 21h, em passos de 30 min; mínimo de 2h (sábado, domingo e feriado: 3h na Aclimação e 4h na Bela Vista);
// 30 min de intervalo entre aluguéis do mesmo estúdio (AB conta com A e com B); 15 a 29 min = "apertado"; menos de 15 min nunca.
// Telegram (equipe: !agendar, !alterar, mensagem do site colada): qualquer horário do dia (00:00 às 23:30), mínimo 2h em
// qualquer dia e sem intervalo obrigatório; só bloqueia sobreposição. Fora das 9h–21h, abaixo do mínimo do site ou
// colado/apertado vira aviso na confirmação.
// Bloqueios/fechamentos (BLOQ, FECHAD, MANUTEN) não exigem intervalo, só não podem sobrepor.
const ALUGUEL_MIN_MINUTOS = 120;
const ALUGUEL_MIN_FDS_FERIADO = { aclimacao: 180, belavista: 240 };
const INTERVALO_NORMAL_MIN = 30;
const INTERVALO_MINIMO_MIN = 15;
const HORA_ABRE_MIN = 9 * 60, HORA_FECHA_MIN = 21 * 60; // aluguéis das 9h às 21h, em passos de 30 min

// mesma lista do agenda.html
const FERIADOS = [
  "2026-01-01", "2026-01-25", "2026-02-16", "2026-02-17", "2026-04-03", "2026-04-21", "2026-05-01", "2026-06-04",
  "2026-07-09", "2026-09-07", "2026-10-12", "2026-11-02", "2026-11-15", "2026-11-20", "2026-12-25",
  "2027-01-01", "2027-01-25", "2027-02-08", "2027-02-09", "2027-03-26", "2027-04-21", "2027-05-01", "2027-05-27",
  "2027-07-09", "2027-09-07", "2027-10-12", "2027-11-02", "2027-11-15", "2027-11-20", "2027-12-25",
];

function dataISOemSP(d) {
  return new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

// "2026-10-17" → true se for sábado, domingo ou feriado
function ehFdsOuFeriado(dataISO) {
  const dw = new Date(`${dataISO}T12:00:00-03:00`).getUTCDay();
  return dw === 0 || dw === 6 || FERIADOS.includes(dataISO);
}

function unidadeDoEstudio(est) {
  if (["A", "B", "C", "D", "AB"].includes(est)) return "aclimacao";
  if (["1", "2", "3"].includes(est)) return "belavista";
  return null;
}

function duracaoMinimaMin(unidade, dataISO) {
  return ehFdsOuFeriado(dataISO) && ALUGUEL_MIN_FDS_FERIADO[unidade] ? ALUGUEL_MIN_FDS_FERIADO[unidade] : ALUGUEL_MIN_MINUTOS;
}

function formatarDuracao(min) {
  return `${Math.floor(min / 60)}h${min % 60 ? String(min % 60).padStart(2, "0") : ""}`;
}

function ehBloqueio(ev) {
  return /BLOQ|FECHAD|MANUTEN/i.test(ev.summary || "");
}

// regra pura (sem chamar a agenda): eventos = eventos do mesmo calendário perto do horário.
// ignorarId: evento que não conta (ex.: o "pré" do próprio pedido, ao virar pago).
// devolve { status: 'ok' | 'apertado' | 'recusa', motivo, ev, intervalo }
// equipe: regras do Telegram → { status: 'ok', avisos: { abaixoSite, colado, foraHorarioSite } } ou recusa (sobreposição, < 2h, passo, fim antes do início ou em outro dia)
function classificarRegrasAluguel(estudio, inicio, fim, eventos, ignorarId = null, { equipe = false } = {}) {
  const minutosSP = (d) => ((d.getUTCHours() + 21) % 24) * 60 + d.getUTCMinutes(); // São Paulo = UTC−3
  if (!(fim > inicio) || dataISOemSP(inicio) !== dataISOemSP(fim)) return { status: "recusa", motivo: "horario" };
  const foraHorarioSite = minutosSP(inicio) < HORA_ABRE_MIN || minutosSP(fim) > HORA_FECHA_MIN;
  if (!equipe && foraHorarioSite) return { status: "recusa", motivo: "horario" };
  if (inicio.getUTCMinutes() % 30 || fim.getUTCMinutes() % 30) return { status: "recusa", motivo: "passo" };
  const dur = Math.round((fim - inicio) / 60000);
  const minimoSite = duracaoMinimaMin(unidadeDoEstudio(estudio), dataISOemSP(inicio));
  const minimo = equipe ? ALUGUEL_MIN_MINUTOS : minimoSite;
  if (dur < minimo) return { status: "recusa", motivo: "duracao", duracao: dur, minimo };
  const conflitantes = estudiosConflitantes(estudio);
  let apertado = null, colado = null;
  for (const ev of (eventos || [])) {
    if (ev.status === "cancelled") continue;
    if (ignorarId && ev.id === ignorarId) continue;
    if (!conflitantes.includes(extrairEstudio(ev))) continue;
    const ei = new Date(ev.start.dateTime || ev.start.date);
    const ef = new Date(ev.end.dateTime || ev.end.date);
    if (inicio < ef && fim > ei) return { status: "recusa", motivo: "conflito", ev };
    if (ehBloqueio(ev)) continue;
    const intervalo = Math.round((ei >= fim ? ei - fim : inicio - ef) / 60000);
    if (equipe) {
      if (intervalo < INTERVALO_NORMAL_MIN && (!colado || intervalo < colado.intervalo)) colado = { ev, intervalo };
      continue;
    }
    if (intervalo < INTERVALO_MINIMO_MIN) return { status: "recusa", motivo: "intervalo", ev, intervalo };
    if (intervalo < INTERVALO_NORMAL_MIN && (!apertado || intervalo < apertado.intervalo)) apertado = { status: "apertado", ev, intervalo };
  }
  if (equipe) return { status: "ok", avisos: { abaixoSite: dur < minimoSite ? minimoSite : null, colado, foraHorarioSite } };
  return apertado || { status: "ok" };
}

// avisos da confirmação no Telegram (a equipe pode fugir das regras do site)
function avisosDaEquipe(regra) {
  const av = regra.avisos || {};
  return (av.foraHorarioSite ? "\nℹ️ Fora do horário do site (9h às 21h) — criado pela equipe." : "") +
    (av.abaixoSite ? `\nℹ️ Abaixo do mínimo do site para fim de semana (${formatarDuracao(av.abaixoSite)}) — criado pela equipe.` : "") +
    (av.colado ? `\nℹ️ Colado com outro aluguel no mesmo estúdio (intervalo de ${av.colado.intervalo} min).` : "");
}

async function checarRegrasAluguel(calId, estudio, inicio, fim, ignorarId = null, opcoes = {}) {
  const folga = INTERVALO_NORMAL_MIN * 60000;
  const res = await calendar.events.list({
    calendarId: calId,
    timeMin: new Date(inicio.getTime() - folga).toISOString(),
    timeMax: new Date(fim.getTime() + folga).toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });
  return classificarRegrasAluguel(estudio, inicio, fim, res.data.items || [], ignorarId, opcoes);
}

function descreverEventoCurto(ev) {
  const fmt = { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' };
  const ei = new Date(ev.start.dateTime || ev.start.date);
  const ef = new Date(ev.end.dateTime || ev.end.date);
  const dataFmt = ei.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  return `"${ev.summary}" em ${dataFmt}, das ${ei.toLocaleTimeString("pt-BR", fmt)} às ${ef.toLocaleTimeString("pt-BR", fmt)}`;
}

// ===================== MENSAGEM COLADA DO SITE =====================
// formato gerado pela agenda do site:
// "Olá! Gostaria de reservar o Estúdio C na unidade Aclimação (Rua Gualaxo, 206), quarta, 07/10, das 18:00 às 20:30 (2h30). Está disponível?"
// Extrai estúdio, data e horário sem IA. Devolve null se não for uma mensagem do site.
function interpretarMensagemSite(texto, hojeISO) {
  const t = (texto || "").replace(/\s+/g, " ");
  const mEst = t.match(/gostaria de reservar o est[úu]dio\s+(AB|[ABCD]|[123])\b/i);
  if (!mEst) return null;
  const depois = t.slice(mEst.index);
  const mData = depois.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  const mHora = depois.match(/das\s+(\d{1,2}):(\d{2})\s+[àa]s\s+(\d{1,2}):(\d{2})/i);
  const mUn = depois.match(/na unidade\s+(aclima[çc][ãa]o|bela vista)/i);
  let estudio = mEst[1].toUpperCase();
  const ag = agendaDoEstudio(estudio);
  let unidadeErrada = false;
  if (mUn && ag) {
    const unTexto = /bela/i.test(mUn[1]) ? "Bela Vista" : "Aclimação";
    if (unTexto !== ag.unidade) { unidadeErrada = true; estudio = null; }
  }
  const datas = [];
  if (mData) {
    const v = validarData(`${mData[1]}/${mData[2]}`);
    if (v) {
      // ano = o próximo em que a data ainda não passou (hoje conta como não passou)
      const hoje = hojeISO || new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
      const anoHoje = parseInt(hoje.slice(0, 4));
      const p = (n) => String(n).padStart(2, "0");
      const ano = `${anoHoje}-${p(v.mes)}-${p(v.dia)}` < hoje ? anoHoje + 1 : anoHoje;
      datas.push({ dia: v.dia, mes: v.mes, ano });
    }
  }
  let horario = null;
  if (mHora) horario = validarHorario(`${mHora[1]}:${mHora[2]}-${mHora[3]}:${mHora[4]}`);
  // o que vier depois de "Está disponível?" (formato antigo) ou depois do horário (formato novo:
  // "Seremos 3 pessoas. Quero reservar. Meu nome é Maria.") pode ser nome/telefone do cliente
  const mFim = t.match(/est[áa] dispon[íi]vel\?/i);
  let resto = "";
  if (mFim) resto = t.slice(mFim.index + mFim[0].length);
  else if (mHora) {
    resto = depois.slice(mHora.index + mHora[0].length).replace(/^\s*(\([^)]*\))?\s*\.?/, "")
      .replace(/seremos\s+[^.]*?pessoas?\.?/i, " ")
      .replace(/quero reservar\.?/i, " ")
      .replace(/s[óo] estou consultando\.?/i, " ")
      .replace(/meu nome [ée]\s*/i, " ");
  }
  resto = resto.replace(/\s+/g, " ").trim();
  return { datas, horario, estudio, unidadeErrada, resto };
}

// completa a mensagem do site com nome/telefone (IA só para isso, e só se houver texto extra)
async function camposDaMensagemSite(site) {
  const campos = { datas: site.datas, horario: site.horario, estudio: site.estudio, nome: null, telefone: null, tipo: null };
  if (site.resto) {
    const ia = await interpretarAgendamento(site.resto);
    if (ia._ok) { campos.nome = ia.nome; campos.telefone = ia.telefone; }
    else {
      const simples = extrairCamposAgendamento(site.resto);
      campos.nome = simples.nome;
      if (simples.telefone) campos.telefone = simples.telefone.length <= 11 ? "55" + simples.telefone : simples.telefone;
    }
  }
  return campos;
}

const ENDERECO_ACLIMACAO = "Rua Gualaxo, 206 - Aclimação/Liberdade - CEP 01533-020";
const ENDERECO_BELAVISTA = "Rua Santa Madalena, 46 - Bela Vista";

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

function montarMensagemParaClienteMulti(d, reservas, pagoFinal) {
  const primeiroNome = (d.nome || "").split(" ")[0];
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
  if (d.naoCobrar) {
    return `Obrigado ${primeiroNome}! 😊\nReserva confirmada:\n${linhas}\n${endereco}\n\nQualquer dúvida é só chamar. Até lá!`;
  }
  let sinalTotal = 0;
  for (const r of reservas) {
    const s = calcularSinalAgendamento({ unidade: r.unidade, estudio: r.estudio }, r.inicio, r.fim);
    sinalTotal += s || 50;
  }
  return `Obrigado ${primeiroNome}! 😊\nPré-marcado:\n${linhas}\n${endereco}\n\nPara fazer a reserva pedimos R$ ${sinalTotal} antecipado (total), ok?\n\nPIX: zmphoto@zmphoto.com.br\nou CNPJ 43.345.289/0001-93\nZemaria Produções Fotográficas LTDA`;
}

const COR_POR_ESTUDIO = { C: "1", D: "4", "2": "2", "3": "7" };

// dados.obs: linha extra na descrição; dados.antecipadoPago: "R$ 66,67" → reserva paga ("antecipado R$ 66,67 pago")
function montarEvento(dados) {
  const hTitulo = (h, m) => (m ? `${h}:${String(m).padStart(2, "0")}` : `${h}`);
  const pago = dados.pago || dados.antecipadoPago;
  const titulo = `${hTitulo(dados.h1, dados.m1)}-${hTitulo(dados.h2, dados.m2)}/${dados.estudio}${pago ? "" : " pré"}`;
  let descricao = dados.nome;
  if (dados.telefone) descricao += ` ${dados.telefone}`;
  if (dados.obs) descricao += `\n${dados.obs}`;
  if (dados.pago) descricao += `\npago R$${dados.pago}`;
  if (dados.antecipadoPago) descricao += `\nantecipado ${dados.antecipadoPago} pago`;
  if (dados.naoCobrar) descricao += ` zm`; // marca de não-cobrar
  if (dados.confirmarPresenca) descricao += ` zm2`; // marca de confirmar presença (não cobra sinal)
  const eventBody = {
    summary: titulo,
    description: descricao,
    start: { dateTime: dados.inicio.toISOString(), timeZone: "America/Sao_Paulo" },
    end: { dateTime: dados.fim.toISOString(), timeZone: "America/Sao_Paulo" },
  };
  const cor = COR_POR_ESTUDIO[dados.estudio];
  if (cor) eventBody.colorId = cor;
  return { titulo, descricao, eventBody };
}

async function criarEventoComId(dados) {
  const { titulo, descricao, eventBody } = montarEvento(dados);
  const criado = await calendar.events.insert({ calendarId: dados.calId, requestBody: eventBody });
  return { titulo, descricao, id: criado?.data?.id || null };
}

async function buscarTelefoneConhecido(nomeBuscado) {
  const alvo = normalizar(nomeBuscado);
  if (!alvo) return null;
  const agora = new Date();
  const limite = new Date(agora.getTime() - 180 * 24 * 60 * 60 * 1000);
  const futuro = new Date(agora.getTime() + 180 * 24 * 60 * 60 * 1000);
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
          if (nomeNorm === alvo || nomeNorm.includes(alvo) || alvo.includes(nomeNorm)) {
            return { nome: nomeEv, telefone: tel };
          }
        }
      }
    } catch (e) { console.error("Erro ao buscar telefone conhecido:", e.message); }
  }
  return null;
}

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

// =============================
// PREENCHIMENTO AUTOMÁTICO DE TELEFONE (!preencher)
// =============================

// classifica o match entre o nome da reserva e o nome do contato: "forte" | "fraco" | "nenhum"
// forte  = a reserva tem nome + sobrenome e TODAS as palavras aparecem no contato (seguro p/ auto-preencher)
// fraco  = só parte do nome bate, ou é nome de uma palavra só (vai para revisão manual)
// nenhum = nada em comum
function classificarMatch(nomeReserva, nomeContato) {
  const a = normalizar(nomeReserva);
  const b = normalizar(nomeContato);
  if (!a || !b) return "nenhum";
  const palavrasA = a.split(/\s+/).filter(p => p.length >= 2);
  const palavrasB = b.split(/\s+/).filter(p => p.length >= 2);
  if (palavrasA.length >= 2) {
    const todasPresentes = palavrasA.every(p => palavrasB.includes(p));
    if (todasPresentes) return "forte";
  }
  const algumaEmComum = palavrasA.some(p => palavrasB.includes(p));
  if (algumaEmComum) return "fraco";
  return "nenhum";
}

// procura o nome nos contatos do Google e devolve TODOS os candidatos com o tipo de match.
// Retorna { fortes: [{nome, telefone}], fracos: [{nome, telefone}] }
async function buscarCandidatosContato(nomeBuscado) {
  const alvo = normalizar(nomeBuscado);
  const fortes = [], fracos = [];
  if (!alvo || !peopleClient) return { fortes, fracos };
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
          const tipo = classificarMatch(nomeBuscado, nomeContato);
          if (tipo === "nenhum") continue;
          const digitos = (telefones[0].value || "").replace(/\D/g, "");
          if (!digitos) continue;
          const tel = digitos.length <= 11 ? "55" + digitos : digitos;
          const item = { nome: nomeContato, telefone: tel };
          if (tipo === "forte") fortes.push(item); else fracos.push(item);
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.error("Erro ao buscar candidatos no Google:", e.message);
  }
  return { fortes, fracos };
}

// escreve o telefone na descrição do evento (acrescenta ao final, sem apagar nada)
async function gravarTelefoneNoEvento(ev, calId, telefone) {
  const desc = ev.description || "";
  const novaDesc = desc ? `${desc} ${telefone}` : `${extrairNome(ev) || ""} ${telefone}`.trim();
  await calendar.events.patch({ calendarId: calId, eventId: ev.id, requestBody: { description: novaDesc } });
}

// !preencher — busca telefone das reservas "pré" sem número nos contatos do Google.
// executar=false: só mostra a prévia (o que preencheria + o que precisa de revisão).
// executar=true : grava de verdade os matches FORTES; os fracos/ambíguos/não-achados ficam para revisão manual.
async function preencherTelefones(destino, executar = false) {
  const achados = await coletarEventosPre(360);
  const semTel = achados.filter(({ ev }) => {
    // pula clientes "zm" (combinado diferente — o bot não cobra nem mexe neles)
    const alvo = normalizar((ev.summary || "") + " " + (ev.description || ""));
    if (/#?\s*\bzm\b/.test(alvo)) return false;
    return !extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
  });
  if (semTel.length === 0) {
    await sendMessage(destino, "✅ Nenhuma reserva 'pré' sem telefone. Nada a preencher!");
    return;
  }
  if (!peopleClient) {
    await sendMessage(destino, "⚠️ A busca de contatos do Google não está configurada (GOOGLE_CONTATOS_CONFIG). Não dá para preencher automaticamente.");
    return;
  }

  const autoPreencher = []; // { ev, calId, nome, telefone }
  const revisar = [];       // { nomeReserva, motivo, opcoes:[{nome,telefone}] }

  for (const { ev, calId } of semTel) {
    const nomeReserva = extrairNome(ev);
    if (!nomeReserva) { revisar.push({ nomeReserva: ev.summary || "(sem nome)", motivo: "sem nome na reserva", opcoes: [] }); continue; }
    const { fortes, fracos } = await buscarCandidatosContato(nomeReserva);
    // remove duplicados de telefone dentro de cada grupo
    const uniq = (arr) => { const m = {}; arr.forEach(x => m[x.telefone] = x); return Object.values(m); };
    const F = uniq(fortes), W = uniq(fracos);
    if (F.length === 1) {
      autoPreencher.push({ ev, calId, nome: nomeReserva, telefone: F[0].telefone, contato: F[0].nome });
    } else if (F.length > 1) {
      revisar.push({ nomeReserva, motivo: "vários contatos batem forte", opcoes: F });
    } else if (W.length >= 1) {
      revisar.push({ nomeReserva, motivo: "match fraco (confira)", opcoes: W.slice(0, 4) });
    } else {
      revisar.push({ nomeReserva, motivo: "não encontrado nos contatos", opcoes: [] });
    }
  }

  // PRÉVIA
  if (!executar) {
    let msg = `🔎 *Prévia do preenchimento* (${semTel.length} reserva(s) sem telefone)\n\n`;
    if (autoPreencher.length > 0) {
      msg += `✅ *${autoPreencher.length} serão preenchidas automaticamente* (match forte):\n`;
      msg += autoPreencher.map(a => `• ${a.nome} → ${a.telefone}`).join("\n") + "\n\n";
    } else {
      msg += "✅ Nenhuma com match forte para preencher automaticamente.\n\n";
    }
    if (revisar.length > 0) {
      msg += `⚠️ *${revisar.length} precisam da sua atenção:*\n`;
      msg += revisar.map(r => {
        const ops = r.opcoes.length ? " → " + r.opcoes.map(o => `${o.nome} (${o.telefone})`).join(" ou ") : "";
        return `• ${r.nomeReserva} — ${r.motivo}${ops}`;
      }).join("\n") + "\n";
    }
    msg += `\nPara gravar as automáticas de verdade, mande: *!preencher confirmar*`;
    await sendMessage(destino, msg);
    return;
  }

  // EXECUTAR (grava só os fortes)
  let gravados = 0;
  for (const a of autoPreencher) {
    try {
      await gravarTelefoneNoEvento(a.ev, a.calId, a.telefone);
      gravados++;
    } catch (e) { console.error("Erro ao gravar telefone no evento", a.ev.id, e.message); }
  }
  let msg = `✅ *Preenchimento concluído!*\n${gravados} reserva(s) tiveram o telefone preenchido automaticamente.`;
  if (revisar.length > 0) {
    msg += `\n\n⚠️ *${revisar.length} ainda precisam de você* (preencha na mão no Google Calendar):\n`;
    msg += revisar.map(r => {
      const ops = r.opcoes.length ? " → " + r.opcoes.map(o => `${o.nome} (${o.telefone})`).join(" ou ") : "";
      return `• ${r.nomeReserva} — ${r.motivo}${ops}`;
    }).join("\n");
  }
  await sendMessage(destino, msg);
}

// =============================
// REVISÃO INTERATIVA DE TELEFONES (!revisar) — fila que pergunta um por um
// =============================

// estado das filas de revisão em andamento, por chatId
const filasRevisao = {};

// monta a fila: agrupa reservas "pré" sem telefone por nome do cliente (nome repetido = 1 item),
// junta as sugestões de contato de cada grupo. Ignora clientes "zm".
async function montarFilaRevisao() {
  const achados = await coletarEventosPre(360);
  const semTel = achados.filter(({ ev }) => {
    const alvo = normalizar((ev.summary || "") + " " + (ev.description || ""));
    if (/#?\s*\bzm\b/.test(alvo)) return false;
    return !extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
  });

  const grupos = {}; // chaveNome -> { nome, itens:[{ev,calId}], sugestoes:[{nome,telefone}] }
  for (const { ev, calId } of semTel) {
    const nome = extrairNome(ev) || (ev.summary || "(sem nome)");
    const chave = normalizar(nome);
    if (!grupos[chave]) grupos[chave] = { nome, itens: [], sugestoes: null };
    grupos[chave].itens.push({ ev, calId });
  }

  // busca sugestões de contato uma vez por grupo
  for (const chave of Object.keys(grupos)) {
    const g = grupos[chave];
    try {
      const { fortes, fracos } = await buscarCandidatosContato(g.nome);
      const uniq = (arr) => { const m = {}; arr.forEach(x => m[x.telefone] = x); return Object.values(m); };
      g.sugestoes = uniq([...fortes, ...fracos]).slice(0, 4);
    } catch (e) { g.sugestoes = []; }
  }

  return Object.values(grupos);
}

// texto da pergunta do item atual da fila
function textoPerguntaRevisao(fila) {
  const g = fila.grupos[fila.indice];
  const total = fila.grupos.length;
  const pos = fila.indice + 1;
  // detalhes das reservas desse cliente (datas/estúdios)
  const detalhes = g.itens.map(({ ev }) => {
    const ini = new Date(ev.start.dateTime || ev.start.date);
    const data = ini.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: '2-digit', month: '2-digit' });
    const hora = ini.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
    const est = extrairEstudio(ev);
    return `${data} ${hora}${est ? ` · Est. ${est}` : ""}`;
  }).join(" | ");
  const qtd = g.itens.length > 1 ? ` _(${g.itens.length} reservas — o número vale para todas)_` : "";
  let msg = `📋 *(${pos}/${total}) ${g.nome}*${qtd}\n🗓️ ${detalhes}\n`;
  if (g.sugestoes && g.sugestoes.length > 0) {
    msg += `\n💡 Sugestões dos contatos:\n` + g.sugestoes.map(s => `• ${s.telefone} (${s.nome})`).join("\n") + "\n";
  }
  msg += `\nMe manda o *telefone* (com DDD), ou escreve *pular* / *parar*.`;
  return msg;
}

// grava o telefone em todas as reservas do grupo atual
async function gravarTelefoneGrupo(g, telefone) {
  let ok = 0;
  for (const { ev, calId } of g.itens) {
    try {
      await gravarTelefoneNoEvento(ev, calId, telefone);
      ok++;
    } catch (e) { console.error("Erro ao gravar telefone (revisão) no evento", ev.id, e.message); }
  }
  return ok;
}

// avança a fila para o próximo item e envia a próxima pergunta (ou encerra)
async function avancarFilaRevisao(chatId) {
  const fila = filasRevisao[chatId];
  if (!fila) return;
  fila.indice++;
  if (fila.indice >= fila.grupos.length) {
    delete filasRevisao[chatId];
    await sendMessage(chatId, `✅ *Revisão concluída!*\n📞 ${fila.gravados} cliente(s) com telefone gravado\n⏭️ ${fila.pulados} pulado(s)`);
    return;
  }
  await sendMessage(chatId, textoPerguntaRevisao(fila));
}

// =============================
// MARCAR CLIENTE COMO "NÃO COBRAR" (!zm)
// =============================

// estado de confirmações !zm pendentes, por chatId
const zmPendente = {};

// já tem a marca zm?
function jaTemZm(ev) {
  const alvo = normalizar((ev.summary || "") + " " + (ev.description || ""));
  return /#?\s*\bzm\b/.test(alvo);
}

// busca reservas "pré" cujo nome contém o termo (para o !zm). Não filtra zm aqui de propósito:
// queremos ver inclusive as que já estão marcadas, para não remarcar.
async function buscarReservasPorNomeParaZm(termo) {
  const alvo = normalizar(termo);
  const achados = await coletarEventosPre(360);
  const encontrados = [];
  for (const { ev, calId } of achados) {
    const nome = normalizar(extrairNome(ev) || ev.summary || "");
    if (nome.includes(alvo) || alvo.includes(nome)) encontrados.push({ ev, calId });
  }
  return encontrados;
}

// marca "zm" na descrição de uma reserva (não apaga nada; só acrescenta se ainda não tiver)
async function marcarZmNoEvento(ev, calId) {
  if (jaTemZm(ev)) return false; // já tem, não duplica
  const desc = (ev.description || "").trim();
  const novaDesc = desc ? `${desc} zm` : "zm";
  await calendar.events.patch({ calendarId: calId, eventId: ev.id, requestBody: { description: novaDesc } });
  return true;
}

function parseHorarioSimples(tok) {
  const m = (tok || "").trim().match(/^(\d{1,2})(?::(\d{2}))?h?$/i);
  if (!m) return null;
  const h = parseInt(m[1]), min = parseInt(m[2] || "0");
  if (h > 23 || min > 59) return null;
  return { h, min };
}

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

function dataHoraSP(ano, mes, dia, hora = 0, min = 0) {
  const p = (n) => String(n).padStart(2, "0");
  return new Date(`${ano}-${p(mes)}-${p(dia)}T${p(hora)}:${p(min)}:00-03:00`);
}

const BUFFER_IDEAL_MIN = 30;
const LEGENDA_AVISO = "\n\n⚠️ atenção: encaixe apertado entre reservas, sem margem para atraso";

// calcula as faixas OFERTÁVEIS de um estúdio num dia, já com a folga de troca entre clientes.
// folga ideal de 30 min de cada lado que encosta numa reserva; encolhe simetricamente se o vão
// não comporta (nunca abaixo de 2h de oferta). Se a folga aplicada < 30 min, marca aviso.
function calcularHorariosLivres(eventosDoEstudio, ano, mes, dia, horaOperInicio = 7, horaOperFim = 23, minHoras = 2) {
  const inicioOp = dataHoraSP(ano, mes, dia, horaOperInicio, 0);
  const fimOp = dataHoraSP(ano, mes, dia, horaOperFim, 0);
  const MIN_MS = minHoras * 3600000;
  const IDEAL_MS = BUFFER_IDEAL_MIN * 60000;

  const ocupados = eventosDoEstudio
    .map(ev => ({ ini: new Date(ev.start.dateTime || ev.start.date), fim: new Date(ev.end.dateTime || ev.end.date) }))
    .filter(o => o.fim > inicioOp && o.ini < fimOp)
    .sort((a, b) => a.ini - b.ini);

  const vaos = [];
  let cursor = inicioOp;
  let escReserva = false;
  for (const o of ocupados) {
    if (o.ini > cursor) vaos.push({ ini: cursor, fim: o.ini, esc: escReserva, dir: true });
    if (o.fim > cursor) { cursor = o.fim; escReserva = true; }
  }
  if (fimOp > cursor) vaos.push({ ini: cursor, fim: fimOp, esc: escReserva, dir: false });

  const faixas = [];
  for (const v of vaos) {
    const rawLen = v.fim - v.ini;
    if (rawLen < MIN_MS) continue;
    const lados = (v.esc ? 1 : 0) + (v.dir ? 1 : 0);
    let bufferPorLado = 0;
    if (lados > 0) {
      const folgaMax = lados * IDEAL_MS;
      const folgaSobra = rawLen - MIN_MS;
      const folgaTotal = Math.max(0, Math.min(folgaMax, folgaSobra));
      bufferPorLado = folgaTotal / lados;
    }
    const ini = new Date(v.ini.getTime() + (v.esc ? bufferPorLado : 0));
    const fim = new Date(v.fim.getTime() - (v.dir ? bufferPorLado : 0));
    const aviso = lados > 0 && bufferPorLado < IDEAL_MS;
    const aberto = !v.dir && v.fim.getTime() === fimOp.getTime();
    faixas.push({ ini, fim, aviso, aberto });
  }
  return faixas;
}

function formatarFaixaLivre(f) {
  const hi = f.ini.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
  const hf = f.fim.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
  const base = f.aberto ? `a partir das ${hi}` : `${hi}-${hf}`;
  return f.aviso ? `${base} ⚠️` : base;
}

// verifica se uma faixa livre "encosta" no período (manhã/tarde/noite) do dia.
// regra: a faixa entra se tiver QUALQUER sobreposição com a janela do período —
// assim nenhuma vaga aproveitável some (mostra a faixa inteira, do jeito real).
function faixaNoPeriodo(faixa, ano, mes, dia, periodo) {
  if (!periodo) return true;
  const pIni = dataHoraSP(ano, mes, dia, periodo.ini, 0);
  const pFim = dataHoraSP(ano, mes, dia, periodo.fim, 0);
  return faixa.ini < pFim && faixa.fim > pIni;
}

// true se a faixa comporta a duração mínima pedida (em horas)
function faixaComportaDuracao(faixa, duracaoMinHoras) {
  if (!duracaoMinHoras) return true;
  const horas = (faixa.fim - faixa.ini) / 3600000;
  return horas >= duracaoMinHoras;
}

// retorna os vãos livres CRUS (sem desconto de folga) — usado para avaliar janela específica
function calcularVaosCrus(eventosDoEstudio, ano, mes, dia, horaOperInicio = 7, horaOperFim = 23) {
  const inicioOp = dataHoraSP(ano, mes, dia, horaOperInicio, 0);
  const fimOp = dataHoraSP(ano, mes, dia, horaOperFim, 0);
  const ocupados = eventosDoEstudio
    .map(ev => ({ ini: new Date(ev.start.dateTime || ev.start.date), fim: new Date(ev.end.dateTime || ev.end.date) }))
    .filter(o => o.fim > inicioOp && o.ini < fimOp)
    .sort((a, b) => a.ini - b.ini);
  const vaos = [];
  let cursor = inicioOp;
  for (const o of ocupados) {
    if (o.ini > cursor) vaos.push({ ini: cursor, fim: o.ini });
    if (o.fim > cursor) cursor = o.fim;
  }
  if (fimOp > cursor) vaos.push({ ini: cursor, fim: fimOp });
  return vaos;
}

// avalia se o estúdio está livre numa janela específica (jIni-jFim), usando os vãos crus.
// Retorna { cobre: bool, justo: bool } — justo = cobre mas sem os 30min de folga de cada lado.
function estudioNaJanela(vaosCrus, ano, mes, dia, janela) {
  const jIni = dataHoraSP(ano, mes, dia, janela.h1, janela.m1);
  const jFim = dataHoraSP(ano, mes, dia, janela.h2, janela.m2);
  const FOLGA = 30 * 60000;
  for (const v of vaosCrus) {
    if (v.ini <= jIni && v.fim >= jFim) {
      const folgaAntes = (jIni - v.ini) >= FOLGA;
      const folgaDepois = (v.fim - jFim) >= FOLGA;
      const justo = !(folgaAntes && folgaDepois);
      return { cobre: true, justo };
    }
  }
  return { cobre: false, justo: false };
}

function estudiosParaAnaliseLivre(estudioFiltro, unidadeFiltro) {
  if (estudioFiltro) return [estudioFiltro];
  if (unidadeFiltro === "aclimacao") return ["A", "B", "C", "D", "AB"];
  if (unidadeFiltro === "belavista") return ["1", "2", "3"];
  return ["A", "B", "C", "D", "AB", "1", "2", "3"];
}

async function normalizarComandoAgenda(textoLivre) {
  if (!textoLivre || !textoLivre.trim()) return textoLivre;
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
  // data de hoje (fuso SP) para o Gemini calcular datas relativas
  const hojeSP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
  const [hAno, hMes, hDia] = hojeSP.split("-");
  const diaSemHoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long" });
  const prompt = `Você converte um pedido em português (sobre a agenda de um estúdio fotográfico) em um comando curto.

HOJE é ${hDia}/${hMes}/${hAno} (${diaSemHoje}). Use isso para calcular qualquer data relativa.

Peças possíveis do comando:
- Estúdio: A, B, C, D, AB (Aclimação) ou 1, 2, 3 (Bela Vista)
- Unidade inteira: "aclimacao" ou "belavista"
- "livre" (se o pedido é sobre horários vagos/livres)
- Período do dia: "manha", "tarde" ou "noite"
- Horário exato: HH:MM
- Duração mínima: se o cliente cita quanto tempo quer ("2h", "2-3h", "3 horas", "umas 2 horas"), devolva "dur:N" onde N é o MENOR número de horas. Ex.: "2-3h" -> dur:2 ; "3 horas" -> dur:3
- DATAS: sempre no formato DD/MM, várias separadas por vírgula SEM espaço (ex.: 02/08,09/08,16/08)

REGRA IMPORTANTE sobre datas: se o pedido mencionar dia(s) da semana ("sábados", "domingo"), um mês ("agosto"), "quinzena", "próximos N ...", ou qualquer intervalo, VOCÊ MESMO calcula as datas concretas e devolve a lista em DD/MM. Não invente palavras como "agosto" ou "sabados" no comando — devolva as datas já calculadas.

- "hoje" continua valendo como "hoje". "semana" = próximos 7 dias; "semana que vem" = a próxima semana. Esses três pode manter como palavra.
- Para meses/dias da semana, calcule as datas reais a partir de HOJE.

Responda APENAS o comando em uma linha, sem explicação nem aspas. Ordem: [estúdio/unidade] [livre] [datas ou semana] [período] [horário].

Exemplos (assumindo que hoje seja 31/07/2026):
"horários vagos do estúdio A essa semana" -> A livre semana
"o estúdio 1 está livre dia 2 de agosto às 14h?" -> 1 belavista livre 02/08 14:00
"como está a bela vista hoje" -> belavista hoje
"o que tem livre dia 01/08 de manhã" -> livre 01/08 manha
"todos os sábados de agosto no estúdio AB" -> AB livre 01/08,08/08,15/08,22/08,29/08
"agosto inteiro estúdio C" -> C livre 01/08,02/08,03/08,04/08,05/08,06/08,07/08,08/08,09/08,10/08,11/08,12/08,13/08,14/08,15/08,16/08,17/08,18/08,19/08,20/08,21/08,22/08,23/08,24/08,25/08,26/08,27/08,28/08,29/08,30/08,31/08
"próximos 3 domingos bela vista" -> belavista livre 03/08,10/08,17/08
"vagos estúdio 2 à tarde nas segundas de agosto" -> 2 livre 03/08,10/08,17/08,24/08,31/08 tarde
"tem estúdio B dia 13 à tarde por umas 2-3h" -> B livre 13/08 tarde dur:2
"sábado que vem preciso de 3 horas na bela vista" -> belavista livre SABADO dur:3

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
    return textoLivre;
  }
}

async function consultarAgenda(argsTexto, destino) {
  const argsNormalizado = argsTexto
    .replace(/bela\s+vista/gi, "belavista")
    .replace(/semana\s+que\s+vem/gi, "semanaquevem")
    .replace(/proxima\s+semana|próxima\s+semana/gi, "semanaquevem");
  const tokens = argsNormalizado.trim().split(/\s+/).filter(Boolean);
  const codigosEstudio = ["AB", "A", "B", "C", "D", "1", "2", "3"];
  let estudioFiltro = null, unidadeFiltro = null, semana = false, proximaSemana = false, apenasLivre = false, datas = [], horario = null, periodo = null, duracaoMin = null, janela = null;
  const hojeInfo = new Date();
  const hojeStr = hojeInfo.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const [hojeAno, hojeMes, hojeDia] = hojeStr.split("-").map(Number);

  for (const tok of tokens) {
    const tokNorm = normalizar(tok);
    if (tokNorm === "semana") { semana = true; continue; }
    if (tokNorm === "semanaquevem") { semana = true; proximaSemana = true; continue; }
    if (tokNorm === "livre" || tokNorm === "livres") { apenasLivre = true; continue; }
    if (tokNorm === "manha" || tokNorm === "manhas") { periodo = { nome: "manhã", ini: 7, fim: 13 }; continue; }
    if (tokNorm === "tarde" || tokNorm === "tardes") { periodo = { nome: "tarde", ini: 13, fim: 18 }; continue; }
    if (tokNorm === "noite" || tokNorm === "noites") { periodo = { nome: "noite", ini: 18, fim: 23 }; continue; }
    const mDur = tokNorm.match(/^dur:(\d{1,2})$/);
    if (mDur) { duracaoMin = Math.max(2, parseInt(mDur[1])); continue; }
    if (tokNorm === "hoje") { datas.push({ dia: hojeDia, mes: hojeMes }); continue; }
    if (tokNorm === "aclimacao") { unidadeFiltro = "aclimacao"; continue; }
    if (tokNorm === "belavista") { unidadeFiltro = "belavista"; continue; }
    const tokUpper = tok.toUpperCase();
    if (!estudioFiltro && codigosEstudio.includes(tokUpper)) { estudioFiltro = tokUpper; continue; }
    if (/\d{1,2}\/\d{1,2}/.test(tok)) {
      for (const p of tok.split(",")) { const v = validarData(p); if (v) datas.push(v); }
      continue;
    }
    // janela de horário: HH:MM-HH:MM (ex.: 10:00-13:00, 10-13)
    const vj = validarHorario(tok);
    if (vj) { janela = vj; continue; }
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

  const nomeUnidade = { aclimacao: "Aclimação", belavista: "Bela Vista" };
  const rotuloFiltro = estudioFiltro ? ` — ${rotuloEstudioCodigo(estudioFiltro)}` : (unidadeFiltro ? ` — ${nomeUnidade[unidadeFiltro]}` : "");

  // MODO JANELA: data(s) + janela de horário -> mostra só os estúdios livres NAQUELA janela
  if (datas.length > 0 && janela) {
    const estudiosParaLivres = estudiosParaAnaliseLivre(estudioFiltro, unidadeFiltro);
    datas.sort((a, b) => (a.mes - b.mes) || (a.dia - b.dia));
    const jTxt = `${String(janela.h1).padStart(2,"0")}:${String(janela.m1).padStart(2,"0")}-${String(janela.h2).padStart(2,"0")}:${String(janela.m2).padStart(2,"0")}`;
    const blocos = [];
    let temJusto = false;
    for (const d of datas) {
      const inicio = dataHoraSP(ano, d.mes, d.dia, 0, 0);
      const fim = dataHoraSP(ano, d.mes, d.dia, 23, 59);
      const eventosTodos = await listarAgendaFiltrada(calIds, null, inicio, fim);
      const dataFmt = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: '2-digit', month: '2-digit' });
      const disponiveis = [];
      for (const est of estudiosParaLivres) {
        const conflitantes = estudiosConflitantes(est);
        const eventosDoEstudio = eventosTodos.filter(ev => conflitantes.includes(extrairEstudio(ev)));
        const vaos = calcularVaosCrus(eventosDoEstudio, ano, d.mes, d.dia);
        const r = estudioNaJanela(vaos, ano, d.mes, d.dia, janela);
        if (r.cobre) {
          if (r.justo) temJusto = true;
          disponiveis.push(`  ${rotuloEstudioCodigo(est)}${r.justo ? " ⚠️" : ""}`);
        }
      }
      let bloco = `📅 *${dataFmt}* · ${jTxt}${rotuloFiltro}:\n`;
      bloco += disponiveis.length > 0 ? disponiveis.join("\n") : "  (nenhum estúdio livre nesse horário)";
      blocos.push(bloco);
    }
    let msg = blocos.join("\n\n");
    if (temJusto) msg += "\n\n⚠️ horário justo — livre nesse intervalo, mas sem os 30 min de folga de troca";
    await sendMessage(destino, msg.trim());
    return;
  }

  if (datas.length > 0) {
    const estudiosParaLivres = estudiosParaAnaliseLivre(estudioFiltro, unidadeFiltro);
    // ordena as datas e limita a um teto de segurança (evita consulta gigante)
    datas.sort((a, b) => (a.mes - b.mes) || (a.dia - b.dia));
    if (datas.length > 40) {
      await sendMessage(destino, `⚠️ Você pediu ${datas.length} dias — vou mostrar os primeiros 40 para não sobrecarregar. Refine o período se precisar.`);
      datas = datas.slice(0, 40);
    }

    const blocos = [];        // cada dia vira um bloco de texto
    let temAviso = false;
    for (const d of datas) {
      const inicio = dataHoraSP(ano, d.mes, d.dia, 0, 0);
      const fim = dataHoraSP(ano, d.mes, d.dia, 23, 59);
      const eventos = await listarAgendaFiltrada(calIds, estudioFiltro, inicio, fim);
      const eventosParaLivres = estudioFiltro ? await listarAgendaFiltrada(calIds, null, inicio, fim) : eventos;
      const dataFmt = inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: 'long', day: '2-digit', month: '2-digit' });

      let bloco = `📅 *${dataFmt}*${rotuloFiltro}:`;
      if (!apenasLivre) {
        if (eventos.length === 0) {
          bloco += `\nNenhuma reserva marcada.`;
        } else {
          bloco += "\n" + eventos.map(ev => {
            const ei = new Date(ev.start.dateTime || ev.start.date);
            const ef = new Date(ev.end.dateTime || ev.end.date);
            const hi = ei.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
            const hf = ef.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
            return `  ${hi}–${hf} · ${rotuloEstudioEvento(ev)}`;
          }).join("\n");
        }
      }

      if (estudiosParaLivres.length > 0) {
        const linhasEst = [];
        for (const est of estudiosParaLivres) {
          const conflitantes = estudiosConflitantes(est);
          const eventosDoEstudio = eventosParaLivres.filter(ev => conflitantes.includes(extrairEstudio(ev)));
          let livres = calcularHorariosLivres(eventosDoEstudio, ano, d.mes, d.dia);
          if (periodo) livres = livres.filter(l => faixaNoPeriodo(l, ano, d.mes, d.dia, periodo));
          if (duracaoMin) livres = livres.filter(l => faixaComportaDuracao(l, duracaoMin));
          if (livres.length > 0) {
            const linhasLivres = livres.map(l => formatarFaixaLivre(l)).join(" ou ");
            if (linhasLivres.includes("⚠️")) temAviso = true;
            linhasEst.push(`  ${rotuloEstudioCodigo(est)}: ${linhasLivres}`);
          }
        }
        if (linhasEst.length > 0) bloco += "\n🟢 " + (periodo ? `livres (${periodo.nome}):\n` : "livres:\n") + linhasEst.join("\n");
        else bloco += periodo ? `\n(sem horário livre de 2h+ de ${periodo.nome})` : `\n(sem horário livre de 2h+)`;
      }
      blocos.push(bloco);
    }

    // envia os blocos agrupados em poucas mensagens (respeitando ~3500 chars por mensagem)
    let buffer = "";
    for (const bloco of blocos) {
      if ((buffer + "\n\n" + bloco).length > 3500 && buffer) {
        await sendMessage(destino, buffer.trim());
        buffer = "";
      }
      buffer += (buffer ? "\n\n" : "") + bloco;
    }
    if (buffer.trim()) {
      let msgFinal = buffer.trim();
      if (temAviso) msgFinal += LEGENDA_AVISO;
      await sendMessage(destino, msgFinal);
    } else if (temAviso) {
      await sendMessage(destino, LEGENDA_AVISO.trim());
    }
    return;
  }

  const diaSemanaTxt = new Date().toLocaleDateString("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  const mapaDow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hojeDow = mapaDow[diaSemanaTxt];
  let diasAteProximaSegunda = ((1 - hojeDow) + 7) % 7;
  if (diasAteProximaSegunda === 0) diasAteProximaSegunda = 7;
  const offsetDias = proximaSemana ? diasAteProximaSegunda : 0;
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
    const estudiosParaLivres = estudiosParaAnaliseLivre(estudioFiltro, unidadeFiltro);
    const eventosPeriodo = await listarAgendaFiltrada(calIds, null, agora, limite);
    let msg = `🟢 HORÁRIOS LIVRES (${rotulo}${periodo ? ` · ${periodo.nome}` : ""}, mín. 2h):\n`;
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
        let livres = calcularHorariosLivres(eventosDoDiaEstudio, a, m, dd);
        if (periodo) livres = livres.filter(l => faixaNoPeriodo(l, a, m, dd, periodo));
        if (duracaoMin) livres = livres.filter(l => faixaComportaDuracao(l, duracaoMin));
        if (livres.length > 0) {
          const faixas = livres.map(l => formatarFaixaLivre(l)).join(" ou ");
          linhasDia.push(`  ${rotuloEstudioCodigo(est)}: ${faixas}`);
        }
      }
      if (linhasDia.length > 0) msg += `\n📅 *${diaFmt}*\n${linhasDia.join("\n")}\n`;
    }
    let msgFinal = msg.trim();
    if (msgFinal.includes("⚠️")) msgFinal += LEGENDA_AVISO;
    await sendMessage(destino, msgFinal);
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
  res.sendStatus(200);
  try {
    // toque nos botões (aviso de pedido do site; confirmação do !agendar)
    if (req.body.callback_query) {
      if (String(req.body.callback_query.data || "").startsWith("ag:")) await tratarBotaoAgendamento(req.body.callback_query);
      else await tratarBotaoPedido(req.body.callback_query);
      return;
    }
    const message = req.body.message;
    if (!message || !message.chat || typeof message.text !== "string") return;

    const chatId = String(message.chat.id);
    const nomeUsuario = message.from?.first_name || "Equipe";
    const textoMensagem = message.text.trim().toLowerCase();

    if (textoMensagem === '!meuid') {
      await sendMessage(chatId, `Seu ID é:\n${chatId}\n\nÉ esse valor exato que deve ir no ADMIN_CHAT_ID.`);
      return;
    }

    if (podeAgendar(chatId)) {
      const textoOriginal = message.text.trim();

      // 🔁 REVISÃO INTERATIVA DE TELEFONES — prioridade quando há fila ativa (respostas não-comando)
      if (filasRevisao[chatId] && !textoMensagem.startsWith('!')) {
        const fila = filasRevisao[chatId];
        const g = fila.grupos[fila.indice];
        if (textoMensagem === 'parar') {
          delete filasRevisao[chatId];
          await sendMessage(chatId, `⏹️ Revisão encerrada.\n📞 ${fila.gravados} gravado(s) · ⏭️ ${fila.pulados} pulado(s). O que já foi gravado está salvo.`);
          return;
        }
        if (textoMensagem === 'pular') {
          fila.pulados++;
          await avancarFilaRevisao(chatId);
          return;
        }
        const num = textoOriginal.replace(/\D/g, "");
        if (num.length < 10) {
          await sendMessage(chatId, "⚠️ Telefone inválido. Digite com DDD (ex: 11999998888), ou escreva *pular* / *parar*:");
          return;
        }
        const tel = num.length <= 11 ? "55" + num : num;
        const gravou = await gravarTelefoneGrupo(g, tel);
        fila.gravados++;
        const extra = g.itens.length > 1 ? ` (em ${gravou} reservas)` : "";
        await sendMessage(chatId, `✅ ${tel} gravado para ${g.nome}${extra}.`);
        await avancarFilaRevisao(chatId);
        return;
      }

      // ✅ confirmação de um !zm pendente
      if (zmPendente[chatId] && !textoMensagem.startsWith('!')) {
        if (textoMensagem === 'sim') {
          const pend = zmPendente[chatId];
          delete zmPendente[chatId];
          let marcadas = 0;
          for (const { ev, calId } of pend.reservas) {
            try { if (await marcarZmNoEvento(ev, calId)) marcadas++; } catch (e) { console.error("Erro ao marcar zm:", e.message); }
          }
          await sendMessage(chatId, `✅ Pronto! ${marcadas} reserva(s) de "${pend.termo}" marcada(s) com *zm*. O bot não vai mais cobrar esse cliente.`);
          return;
        }
        if (textoMensagem === 'nao' || textoMensagem === 'não') {
          delete zmPendente[chatId];
          await sendMessage(chatId, "Ok, não marquei nada. 👍");
          return;
        }
        await sendMessage(chatId, "Responda *SIM* para marcar como não-cobrar, ou *NÃO* para desistir:");
        return;
      }

      // !agendar, !alterar, mensagem do site colada e respostas às perguntas do agendamento
      if (await tratarMensagemAgendamento(message)) return;
    }

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
      if (textoMensagem.startsWith('!agenda')) {
        let argsTexto = message.text.trim().slice(7).trim();
        await sendMessage(chatId, '🔎 Consultando a agenda, um instante...');
        if (argsTexto) argsTexto = await normalizarComandoAgenda(argsTexto);
        await consultarAgenda(argsTexto, chatId);
        return;
      }
      if (textoMensagem.startsWith('!vagos')) {
        let argsTexto = message.text.trim().slice(6).trim();
        await sendMessage(chatId, '🔎 Calculando horários livres, um instante...');
        if (argsTexto) argsTexto = await normalizarComandoAgenda(argsTexto);
        await consultarAgenda((argsTexto + " livre").trim(), chatId);
        return;
      }
      if (textoMensagem === '!testar') {
        await rodarEnsaioConfirmacoes(false, chatId);
        return;
      }
      if (textoMensagem === '!confirmar48h' || textoMensagem === '!confirmar48') {
        await rodarConfirmacao48h(chatId);
        return;
      }
      if (textoMensagem === '!rodarciclo') {
        await sendMessage(chatId, "⏰ Rodando o ciclo real agora (marca avisos + alerta 3º aviso). ⚠️ NÃO cancela nada automaticamente.");
        await rodarEnsaioConfirmacoes(true, chatId);
        return;
      }
      if (textoMensagem === '!semtelefone') {
        await listarSemTelefone(chatId);
        return;
      }
      if (textoMensagem.startsWith('!preencher')) {
        const confirmar = textoMensagem.includes('confirmar');
        await sendMessage(chatId, confirmar ? '⏳ Preenchendo os telefones (match forte), um instante...' : '🔎 Procurando telefones nos contatos, um instante...');
        await preencherTelefones(chatId, confirmar);
        return;
      }
      if (textoMensagem === '!revisar') {
        await sendMessage(chatId, '🔎 Montando a fila de revisão, um instante...');
        const grupos = await montarFilaRevisao();
        if (grupos.length === 0) {
          await sendMessage(chatId, "✅ Nenhuma reserva 'pré' sem telefone. Nada a revisar!");
          return;
        }
        filasRevisao[chatId] = { grupos, indice: 0, gravados: 0, pulados: 0 };
        await sendMessage(chatId, `📋 *Revisão de telefones* — ${grupos.length} cliente(s) sem número.\nVou perguntar um por um. A cada nome, mande o telefone, ou *pular* / *parar*.`);
        await sendMessage(chatId, textoPerguntaRevisao(filasRevisao[chatId]));
        return;
      }
      if (textoMensagem.startsWith('!zm')) {
        const termo = message.text.trim().slice(3).trim();
        if (!termo) {
          await sendMessage(chatId, "Escreva o nome depois do comando. Ex.: !zm new star");
          return;
        }
        await sendMessage(chatId, '🔎 Procurando as reservas, um instante...');
        const reservas = await buscarReservasPorNomeParaZm(termo);
        if (reservas.length === 0) {
          await sendMessage(chatId, `🔍 Nenhuma reserva 'pré' encontrada para "${termo}".`);
          return;
        }
        const naoMarcadas = reservas.filter(({ ev }) => !jaTemZm(ev));
        const jaMarcadas = reservas.length - naoMarcadas.length;
        if (naoMarcadas.length === 0) {
          await sendMessage(chatId, `ℹ️ As ${reservas.length} reserva(s) de "${termo}" já estão marcadas com *zm*. Nada a fazer.`);
          return;
        }
        const lista = naoMarcadas.map(({ ev }) => {
          const ini = new Date(ev.start.dateTime || ev.start.date);
          const data = ini.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: '2-digit', month: '2-digit' });
          const hora = ini.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: '2-digit', minute: '2-digit' });
          return `• ${data} ${hora} — ${ev.summary || "(sem título)"}`;
        }).join("\n");
        const extraJa = jaMarcadas > 0 ? `\n_(${jaMarcadas} já estava(m) marcada(s) e serão ignoradas)_` : "";
        zmPendente[chatId] = { termo, reservas: naoMarcadas };
        await sendMessage(chatId, `Vou marcar *zm* (não cobrar) nestas ${naoMarcadas.length} reserva(s) de "${termo}":\n${lista}${extraJa}\n\nConfirma? Responda *SIM* ou *NÃO*.`);
        return;
      }
      if (textoMensagem.startsWith('!buscar')) {
        const termo = message.text.trim().slice(7).trim();
        if (!termo) await sendMessage(chatId, "Escreva o nome depois do comando. Ex.: !buscar new star");
        else await buscarPorNome(termo, chatId);
        return;
      }
      if (textoMensagem.startsWith('!testarnumero')) {
        const tel = message.text.trim().slice(13).trim();
        if (!tel) await sendMessage(chatId, "Escreva o telefone depois do comando. Ex.: !testarnumero 553291590828");
        else await testarUmNumero(tel, chatId);
        return;
      }
      if (textoMensagem.startsWith('!confirmarpagamento')) {
        const partes = message.text.trim().slice(20).trim().split(/\s+/);
        const tel = partes[0];
        const valor = partes[1];
        if (!tel || !valor) await sendMessage(chatId, "Use: !confirmarpagamento [telefone] [valor]\nEx.: !confirmarpagamento 11999998888 210");
        else await confirmarPagamento(tel, valor, chatId);
        return;
      }
      if (textoMensagem.startsWith('!resetaravisos')) {
        const confirmar = textoMensagem.includes('confirmar');
        await resetarAvisosClientesReais(chatId, confirmar);
        return;
      }
      if (textoMensagem === '!conferir') {
        await sendMessage(chatId, '🔎 Conferindo a agenda dos próximos 60 dias, um instante...');
        await rodarConferencia(chatId, true);
        return;
      }
      if (textoMensagem === '!ajuda') {
        await sendMessage(chatId,
          "🤖 *Comandos disponíveis:*\n\n" +
          "!testar — mostra as cobranças de hoje (não marca nada na agenda)\n" +
          "!rodarciclo — roda o ciclo real AGORA (marca avisos + alerta 3º aviso; NÃO cancela nada)\n" +
          "!semtelefone — lista reservas sem telefone\n" +
          "!preencher — busca telefone nos contatos e preenche (prévia; !preencher confirmar grava)\n" +
          "!revisar — pergunta o telefone de cada cliente sem número, um por um, e grava na hora\n" +
          "!zm [nome] — marca o cliente como NÃO cobrar (ex.: !zm new star)\n" +
          "!buscar [nome] — busca reservas de um cliente\n" +
          "!testarnumero [telefone] — mostra a mensagem + link pronto para um número específico\n" +
          "!confirmarpagamento [telefone] [valor] — marca reservas como pagas (para de cobrar)\n" +
          "!resetaravisos — mostra quantas reservas seriam resetadas (!resetaravisos confirmar executa)\n" +
          "!agenda [estúdio/unidade] [semana/data] — mostra a agenda (ex.: !agenda A semana)\n" +
          "!conferir — confere a agenda (estúdio errado, sem estúdio ou horário em conflito); só avisa, não muda nada\n" +
          "!vagos [estúdio/unidade] [semana/data] — mostra só os horários livres (ex.: !vagos bela vista hoje)\n" +
          "!status — diz se o respondedor está ligado\n" +
          "!ativar / !desativar — liga/desliga o respondedor\n" +
          "!agendar — cria direto, numa linha só (ex.: !agendar amanhã 14-16 C Maria 11999998888). Sem tipo = pré; acrescente pago 150, zm ou zm2. Várias datas: !agendar 20/10 e 27/10 14-16 C Maria\n" +
          "!alterar — muda o último agendamento seu (ou responda à confirmação): !alterar 15-17 · !alterar sábado · !alterar estúdio D · !alterar pago 150 · !alterar tel 11999998888 · !alterar nome Ana\n" +
          "Cole a mensagem do site (Gostaria de reservar o Estúdio...) para agendar direto\n" +
          "!meuid — mostra seu ID\n\n" +
          "_Lembrete: este bot nunca manda mensagem direto pro cliente — ele sempre entrega o texto + um link pronto do WhatsApp, pra vocês conferirem e apertarem Enviar._"
        );
        return;
      }
    }

    if (!podeAgendar(chatId)) {
      await sendMessage(chatId, "Este bot é de uso interno da equipe ZM Photo.");
      return;
    }

    if (!botAtivo) return;

    const resposta = await gerarRespostaGemini(chatId, message.text, nomeUsuario);
    await sendMessage(chatId, resposta);
  } catch (e) { console.error(e); }
});

// =====================================================================
// AGENDA DO SITE — disponibilidade pública (SÓ LEITURA)
// Devolve, para cada estúdio, os intervalos ocupados. NUNCA devolve
// nome, telefone ou descrição do cliente. Não cria, não altera e não
// cancela nada no Google Agenda.
// Uso: GET /disponibilidade?inicio=2026-10-12&dias=61
// Cada ocupação: { ini, fim, status, est } — "est" é o estúdio do evento
// (A, B, C, D, AB, 1, 2, 3 ou null), usado só para pintar a cor do estúdio.
// =====================================================================
const SITE_ESTUDIOS = { aclimacao: ["A", "B", "C", "D", "AB"], belavista: ["1", "2", "3"] };
const siteCache = new Map();

function siteStatusDoEvento(ev) {
  const t = (ev.summary || "").toUpperCase();
  if (/BLOQ|FECHAD|MANUTEN/.test(t)) return "bloqueado";
  if (/(^|[^A-ZÀ-Ú])PR[EÉ]([^A-ZÀ-Ú]|$)/.test(t)) return "pre";
  return "reservado";
}

// Estúdio do evento, só se ele pertencer a esta unidade. Se o título tiver um
// estúdio de outra unidade (ex.: "B" na agenda da Bela Vista) ou não tiver
// estúdio, devolve null — e aí a unidade inteira fica ocupada (por segurança).
function siteEstudioDaUnidade(ev, unidade) {
  const est = extrairEstudio(ev);
  return est && SITE_ESTUDIOS[unidade].includes(est) ? est : null;
}

function siteEstudiosAfetados(est, unidade) {
  if (!est) return SITE_ESTUDIOS[unidade].slice();
  if (est === "A") return ["A", "AB"];
  if (est === "B") return ["B", "AB"];
  if (est === "AB") return ["A", "B", "AB"];
  return [est];
}

async function siteMontarDisponibilidade(inicioISO, dias) {
  const inicio = new Date(`${inicioISO}T00:00:00-03:00`);
  const fim = new Date(inicio.getTime() + dias * 24 * 60 * 60 * 1000);
  const saida = { aclimacao: {}, belavista: {} };
  for (const u of Object.keys(SITE_ESTUDIOS)) for (const e of SITE_ESTUDIOS[u]) saida[u][e] = [];

  const agendas = [["aclimacao", CALENDAR_IDS[0]], ["belavista", CALENDAR_IDS[1]]];
  for (const [unidade, calId] of agendas) {
    if (!calId) continue;
    let pageToken;
    do {
      const res = await calendar.events.list({
        calendarId: calId,
        timeMin: inicio.toISOString(),
        timeMax: fim.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 2500,
        pageToken,
      });
      for (const ev of (res.data.items || [])) {
        if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
        if (!ev.start || !ev.start.dateTime) continue; // eventos de dia inteiro são anotações, não reservas
        const est = siteEstudioDaUnidade(ev, unidade);
        const ocupado = { ini: ev.start.dateTime, fim: ev.end.dateTime, status: siteStatusDoEvento(ev), est };
        for (const e of siteEstudiosAfetados(est, unidade)) {
          if (saida[unidade][e]) saida[unidade][e].push(ocupado);
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }
  return saida;
}

app.get("/disponibilidade", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const inicioISO = /^\d{4}-\d{2}-\d{2}$/.test(req.query.inicio || "")
      ? req.query.inicio
      : new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const dias = Math.min(Math.max(parseInt(req.query.dias, 10) || 7, 1), 62);
    const chave = `${inicioISO}|${dias}`;
    const emCache = siteCache.get(chave);
    if (emCache && Date.now() - emCache.em < 2 * 60 * 1000) return res.json(emCache.dados);
    const dados = {
      gerado: new Date().toISOString(),
      inicio: inicioISO,
      dias,
      horario: { abre: 9, fecha: 21 },
      feriados: FERIADOS,
      ocupado: await siteMontarDisponibilidade(inicioISO, dias),
    };
    siteCache.set(chave, { em: Date.now(), dados });
    if (siteCache.size > 50) siteCache.delete(siteCache.keys().next().value);
    res.set("Cache-Control", "public, max-age=60");
    res.json(dados);
  } catch (e) {
    console.error("Erro /disponibilidade:", e.message);
    res.status(500).json({ erro: "Não foi possível carregar a agenda agora." });
  }
});
// ===================== fim do bloco da agenda do site =====================

// =====================================================================
// PEDIDO PELO SITE — POST /pedido → aviso no Telegram com botões
// O formulário da agenda manda o pedido; o bot confere a agenda e avisa a
// equipe (CHAT_MATINAL) com botões. Regras fixas:
//   • nunca manda mensagem ao cliente (só entrega links wa.me prontos);
//   • nunca cancela nada;
//   • nada entra no Google Agenda sem um toque da equipe.
// Os pedidos ficam em memória (7 dias); se o bot reiniciar, somem.
// =====================================================================
import { randomBytes } from "crypto";

// valor POR HORA, por faixa de pessoas: [1–2, 3–5, 6–8]. total = valor/hora × horas.
// "fds" vale para sábado, domingo e feriado.
const PRECOS_SITE = {
  aclimacao: {
    semana: { A: [70, 80, 100], B: [70, 80, 100], AB: [100, 110, 130], C: [70, 80, 100], D: [70, 80, 100] },
    fds:    { A: [80, 90, 110], B: [80, 90, 110], AB: [110, 120, 140], C: [80, 90, 110], D: [80, 90, 100] },
  },
  belavista: {
    semana: { "1": [70, 80, 100], "2": [60, 70, 90], "3": [70, 80, 100] },
    fds:    { "1": [80, 90, 110], "2": [70, 80, 100], "3": [80, 80, 100] },
  },
};
const FAIXAS_PESSOAS = [[1, 2], [3, 5], [6, 8]]; // 9 = "9 ou mais": combinar valor
// segunda-feira (exceto feriado), Estúdio 2 da Bela Vista, 1–2 pessoas: R$50/h; as outras faixas seguem o dia útil
const PRECO_SEGUNDA_BV2 = 50;
// e-mail sozinho na linha: o WhatsApp vira link e o cliente copia com um toque
const PIX_TEXTO = "Chave Pix (CNPJ): 43.345.289/0001-93\nou e-mail:\nzmphoto@zmphoto.com.br\nFavorecido: Zemaria Produções Fotográficas LTDA";
const UNIDADES_PEDIDO = {
  aclimacao: { nome: "Aclimação", endereco: "Rua Gualaxo, 206", agenda: 0 },
  belavista: { nome: "Bela Vista", endereco: "Rua Santa Madalena, 46", agenda: 1 },
};
const PEDIDO_VALIDADE_MS = 7 * 24 * 3600 * 1000;
const PEDIDO_SEGURAR_MS = 6 * 3600 * 1000;
const PEDIDO_ABERTO_MS = 6 * 3600 * 1000; // um pedido em aberto por telefone/IP; libera ao reservar, ignorar ou depois de 6h
const DIAS_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

const pedidosSite = new Map();     // id → pedido

async function telegram(metodo, corpo) {
  try {
    const r = await fetch(`${TELEGRAM_API}/${metodo}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    const d = await r.json();
    if (!d.ok) console.error(`Telegram ${metodo}:`, d.description);
    return d;
  } catch (e) {
    console.error(`Telegram ${metodo}:`, e.message);
    return { ok: false };
  }
}

// pedido ainda em aberto (nem reservado nem ignorado, com menos de 6h) do mesmo telefone ou do mesmo IP
function temPedidoEmAberto(telefone, ip) {
  const agora = Date.now();
  for (const p of pedidosSite.values()) {
    if (p.reservado || p.ignorado || agora - p.criado >= PEDIDO_ABERTO_MS) continue;
    if (p.telefoneChave === telefone || p.ip === ip) return true;
  }
  return false;
}

function somarDiasISO(dataISO, n) {
  return new Date(new Date(`${dataISO}T12:00:00-03:00`).getTime() + n * 86400000).toISOString().slice(0, 10);
}

function minutosDeHHMM(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(typeof s === "string" ? s : "");
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 23 || (min !== 0 && min !== 30)) return null;
  return h * 60 + min;
}

// devolve o pedido limpo, ou null se algo não bater
function validarPedidoSite(b, hojeISO) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const { estudio, unidade, data, inicio, fim, duracaoMin, nome, telefone, pessoas, querReservar } = b;
  if (typeof unidade !== "string" || !Object.hasOwn(UNIDADES_PEDIDO, unidade)) return null;
  if (typeof estudio !== "string" || !SITE_ESTUDIOS[unidade].includes(estudio)) return null;
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) return null;
  const dt = new Date(`${data}T12:00:00-03:00`);
  if (isNaN(dt) || dt.toISOString().slice(0, 10) !== data) return null; // data que existe
  if (data < hojeISO || data > somarDiasISO(hojeISO, 62)) return null;
  const a = minutosDeHHMM(inicio), z = minutosDeHHMM(fim);
  if (a === null || z === null || a < 9 * 60 || z > 21 * 60) return null;
  if (!Number.isInteger(duracaoMin) || duracaoMin % 30 !== 0 || duracaoMin !== z - a) return null;
  if (duracaoMin < duracaoMinimaMin(unidade, data)) return null;
  if (typeof nome !== "string") return null;
  const nomeLimpo = nome.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (nomeLimpo.length < 2 || nomeLimpo.length > 60) return null;
  if (typeof telefone !== "string" || !/^\d{10,13}$/.test(telefone)) return null;
  if (!Number.isInteger(pessoas) || pessoas < 1 || pessoas > 9) return null;
  if (typeof querReservar !== "boolean") return null;
  return { estudio, unidade, data, inicio, fim, duracaoMin, nome: nomeLimpo, telefone, pessoas, querReservar };
}

// telefone para wa.me e para a descrição do evento (com 55)
function telefoneInternacional(tel) {
  return tel.length <= 11 ? "55" + tel : tel;
}

// "5511999998888" → "11 99999-8888"
function telefoneLegivel(tel) {
  const n = tel.length >= 12 && tel.startsWith("55") ? tel.slice(2) : tel;
  if (n.length === 11) return `${n.slice(0, 2)} ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `${n.slice(0, 2)} ${n.slice(2, 6)}-${n.slice(6)}`;
  return tel;
}

function reais(v) {
  const centavos = Number.isInteger(v) ? 0 : 2;
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: centavos, maximumFractionDigits: centavos });
}

// null quando passa de 8 pessoas (combinar valor)
function calcularValorPedido(p) {
  const i = FAIXAS_PESSOAS.findIndex(([de, ate]) => p.pessoas >= de && p.pessoas <= ate);
  if (i < 0) return null;
  const fds = ehFdsOuFeriado(p.data);
  const segunda = new Date(`${p.data}T12:00:00-03:00`).getUTCDay() === 1;
  const porHora = (!fds && segunda && p.unidade === "belavista" && p.estudio === "2" && i === 0)
    ? PRECO_SEGUNDA_BV2
    : PRECOS_SITE[p.unidade][fds ? "fds" : "semana"][p.estudio][i];
  const total = Math.round(porHora * p.duracaoMin / 60 * 100) / 100;
  // mesma regra do sinal no resto do bot: 1/3 arredondado para baixo em múltiplos de R$10, mínimo R$50
  const antecipado = Math.min(total, Math.max(50, Math.floor(total / 3 / 10) * 10));
  const restante = Math.round((total - antecipado) * 100) / 100;
  return { porHora, faixa: FAIXAS_PESSOAS[i], limite: FAIXAS_PESSOAS[i][1], total, antecipado, restante };
}

function diaDoPedido(p) {
  const d = new Date(`${p.data}T12:00:00-03:00`);
  return `${DIAS_SEMANA[d.getUTCDay()]}, ${p.data.slice(8, 10)}/${p.data.slice(5, 7)}`;
}

function tipoDeDia(dataISO) {
  if (FERIADOS.includes(dataISO)) return "feriado";
  return ehFdsOuFeriado(dataISO) ? "fim de semana" : "dia útil";
}

function primeiroNome(nome) {
  return (nome || "").split(" ")[0];
}

async function conferirPedido(p) {
  try {
    return await checarRegrasAluguel(p.calId, p.estudio, p.ini, p.fimData, p.segurado?.eventoId || null);
  } catch (e) {
    console.error("Erro ao conferir pedido do site:", e.message);
    return { status: "erro", erro: e.message };
  }
}

function linhaDaRegra(regra) {
  if (regra.status === "ok") return "✅ Horário livre (com 30 min de intervalo)";
  if (regra.status === "erro") return `⚠️ Não consegui conferir a agenda agora (${regra.erro}).`;
  if (regra.motivo === "duracao") return `⚠️ Abaixo do mínimo do dia (${formatarDuracao(regra.minimo)})`;
  if (regra.motivo === "horario") return "⚠️ Fora do horário (9h às 21h)";
  if (regra.motivo === "passo") return "⚠️ Horário fora dos passos de 30 min";
  if (regra.motivo === "conflito") return `⚠️ Conflito: já existe ${descreverEventoCurto(regra.ev)}`;
  if (regra.motivo === "intervalo") return `⚠️ Conflito: intervalo de só ${regra.intervalo} min com ${descreverEventoCurto(regra.ev)}`;
  return `⚠️ Conflito: intervalo de ${regra.intervalo} min com ${descreverEventoCurto(regra.ev)} (o site exige 30)`;
}

function montarAvisoPedido(p) {
  const un = UNIDADES_PEDIDO[p.unidade];
  const v = calcularValorPedido(p);
  const linhas = [
    "📩 Pedido pelo site",
    `📸 Estúdio ${p.estudio} · ${un.nome}`,
    `📅 ${diaDoPedido(p)} · ${p.inicio}–${p.fim} (${formatarDuracao(p.duracaoMin)}) · ${tipoDeDia(p.data)}`,
    `👤 ${p.nome} · 📞 ${telefoneLegivel(p.telefone)}`,
    v ? `👥 ${p.pessoas} ${p.pessoas === 1 ? "pessoa" : "pessoas"} (faixa ${v.faixa[0]}–${v.faixa[1]})` : "👥 9 ou mais pessoas · ⚠️ mais de 8 pessoas: combinar valor",
    p.querReservar ? "🔖 Quer reservar" : "❔ Só consultando",
  ];
  if (v) linhas.push(`💰 R$ ${v.porHora}/h × ${formatarDuracao(p.duracaoMin)} = ${reais(v.total)} · antecipado ${reais(v.antecipado)} · restante no dia ${reais(v.restante)}`);
  linhas.push(linhaDaRegra(p.regraInicial));
  return linhas.join("\n");
}

function montarTextoDisponibilidade(p) {
  const un = UNIDADES_PEDIDO[p.unidade];
  const v = calcularValorPedido(p);
  const topo = `Olá, ${primeiroNome(p.nome)}! Temos disponível:\n\n` +
    `📸 Estúdio ${p.estudio} – ${un.nome} (${un.endereco})\n` +
    `📅 ${diaDoPedido(p)}, das ${p.inicio} às ${p.fim} (${formatarDuracao(p.duracaoMin)})\n\n`;
  if (!v) {
    return topo + "Como serão mais de 8 pessoas, o valor é combinado à parte — já te passamos por aqui.\n" +
      "Para fazer a reserva, pedimos um valor antecipado via Pix:\n" + PIX_TEXTO + "\n\n" +
      "A reserva só é feita após o envio do comprovante, ok? 😊";
  }
  return topo +
    `O valor para até ${v.limite} pessoas fica ${reais(v.total)}.\n` +
    `Para fazer a reserva, pedimos ${reais(v.antecipado)} antecipado via Pix:\n` + PIX_TEXTO + "\n\n" +
    "A reserva só é feita após o envio do comprovante, ok? 😊";
}

function montarTextoConfirmacao(p) {
  const un = UNIDADES_PEDIDO[p.unidade];
  const v = calcularValorPedido(p);
  return `Comprovante recebido, ${primeiroNome(p.nome)}! ✅ Reserva feita:\n` +
    `📸 Estúdio ${p.estudio} – ${un.nome} (${un.endereco})\n` +
    `📅 ${diaDoPedido(p)}, das ${p.inicio} às ${p.fim}\n` +
    (v ? `O restante (${reais(v.restante)}) é pago no dia. Até lá!` : "O restante é pago no dia. Até lá!");
}

function tecladoPedido(id, p) {
  const b = (texto, acao) => ({ text: texto, callback_data: `pd:${acao}:${id}` });
  if (p.ignorado) return [[b("❌ Ignorado", "x")]];
  if (p.reservado) return [[b(`✅ Reservado (pago) · ${p.reservado.titulo}`, "x")]];
  return [
    [b(p.enviado ? "📲 Disponibilidade enviada ✓" : "📲 Enviar disponibilidade e valor", "env"), b("🧾 Comprovante recebido → reservar", "pag")],
    p.segurado
      ? [b("⏸ Segurado como pré ✓", "x")]
      : [b("⏸ Segurar horário (opcional)", "seg"), b("❌ Ignorar", "ign")],
  ];
}

async function atualizarBotoesPedido(id, p) {
  if (!p.messageId) return;
  await telegram("editMessageReplyMarkup", {
    chat_id: p.chatId, message_id: p.messageId,
    reply_markup: { inline_keyboard: tecladoPedido(id, p) },
  });
}

function dadosDoEvento(p) {
  const [h1, m1] = p.inicio.split(":").map(Number);
  const [h2, m2] = p.fim.split(":").map(Number);
  return {
    h1, m1, h2, m2, estudio: p.estudio, calId: p.calId, inicio: p.ini, fim: p.fimData,
    nome: p.nome, telefone: telefoneInternacional(p.telefone),
    obs: `${p.pessoas === 9 ? "9 ou mais" : p.pessoas} ${p.pessoas === 1 ? "pessoa" : "pessoas"} · pedido pelo site`,
  };
}

app.post("/pedido", async (req, res) => {
  // IP real do visitante: a borda da Railway sobrescreve X-Real-IP e X-Forwarded-For (o cliente não
  // consegue forjar). O fim do X-Forwarded-For pode ser um salto interno da Railway, igual para todos.
  const ip = String(req.headers["x-real-ip"] || "").trim()
    || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket.remoteAddress || "?";
  const hoje = dataISOemSP(new Date());
  const pedido = validarPedidoSite(req.body, hoje);
  if (!pedido) return res.status(400).json({ ok: false });
  const telefoneChave = telefoneInternacional(pedido.telefone);
  if (temPedidoEmAberto(telefoneChave, ip)) return res.status(429).json({ ok: false });

  // entra na lista já agora (antes de qualquer espera), para dois envios seguidos não passarem juntos
  const id = randomBytes(5).toString("hex");
  const p = { ...pedido, telefoneChave, ip, criado: Date.now() };
  pedidosSite.set(id, p);
  res.json({ ok: true });

  try {
    Object.assign(p, {
      chatId: CHAT_MATINAL,
      calId: CALENDAR_IDS[UNIDADES_PEDIDO[pedido.unidade].agenda],
      ini: new Date(`${pedido.data}T${pedido.inicio}:00-03:00`),
      fimData: new Date(`${pedido.data}T${pedido.fim}:00-03:00`),
    });
    p.regraInicial = await conferirPedido(p);
    const r = await telegram("sendMessage", {
      chat_id: p.chatId,
      text: montarAvisoPedido(p),
      reply_markup: { inline_keyboard: tecladoPedido(id, p) },
    });
    p.messageId = r?.result?.message_id || null;
    if (!p.messageId) pedidosSite.delete(id); // o aviso não chegou na equipe: não prende o cliente
  } catch (e) {
    console.error("Erro ao avisar pedido do site:", e.message);
    pedidosSite.delete(id);
  }
});

// JSON inválido ou grande demais no /pedido → 400, sem avisar ninguém
app.use("/pedido", (err, req, res, next) => {
  res.status(400).json({ ok: false });
});

async function tratarBotaoPedido(cq) {
  const responder = (text, show_alert = false) => telegram("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert });
  const [prefixo, acao, id] = String(cq.data || "").split(":");
  if (prefixo !== "pd") return responder();
  const chatId = String(cq.message?.chat?.id || "");
  if (!podeAgendar(cq.from?.id) && !podeAgendar(chatId)) return responder("Só a equipe autorizada pode usar estes botões.", true);

  const p = pedidosSite.get(id);
  if (!p || Date.now() - p.criado > PEDIDO_VALIDADE_MS) {
    pedidosSite.delete(id);
    await responder("Esse pedido expirou.");
    await sendMessage(chatId, "Esse pedido expirou. Use !agendar com os dados.", true);
    return;
  }
  if (acao === "x") return responder("Já feito ✓");
  if (p.ignorado) return responder("Esse pedido foi ignorado.");
  if (p.reservado) return responder("Esse pedido já virou reserva ✓");
  if (p.ocupado) return responder("Um instante, ainda estou cuidando do toque anterior…");
  p.ocupado = true;
  try {
    const resumo = `Estúdio ${p.estudio} · ${UNIDADES_PEDIDO[p.unidade].nome} · ${diaDoPedido(p)} · ${p.inicio}–${p.fim} · ${p.nome}`;

    if (acao === "ign") {
      if (p.segurado) return await responder("Esse horário já está seguro como pré. Para desistir, apague o evento na agenda.", true);
      p.ignorado = true;
      await atualizarBotoesPedido(id, p);
      await responder("Pedido ignorado. Nada foi criado.");
      return;
    }

    if (acao === "pag" && !p.enviado) return await responder("Primeiro toque em 📲 Enviar disponibilidade e valor.", true);
    if (acao === "seg" && p.segurado) return await responder("Já está seguro como pré ✓");
    if (!["env", "pag", "seg"].includes(acao)) return await responder();

    // confere de novo a agenda antes de qualquer coisa (o pré do próprio pedido não conta)
    const regra = await conferirPedido(p);
    if (regra.status !== "ok") {
      await responder("Não dá: veja o aviso no chat.", false);
      await sendMessage(chatId, `${linhaDaRegra(regra)}\n${resumo}\nNada foi ${acao === "env" ? "enviado" : "criado"}.`, true);
      return;
    }

    if (acao === "env") {
      await responder("Mensagem pronta 👇");
      await sendMessage(chatId, `📲 Disponibilidade e valor para ${p.nome} (${telefoneLegivel(p.telefone)}):`, true);
      await enviarTextoELink(chatId, montarTextoDisponibilidade(p), telefoneInternacional(p.telefone));
      p.enviado = true;
      await atualizarBotoesPedido(id, p);
      return;
    }

    if (acao === "seg") {
      const { titulo, id: eventoId } = await criarEventoComId(dadosDoEvento(p));
      p.segurado = { eventoId, titulo, em: Date.now(), lembrado: false };
      await responder("Horário seguro ✓");
      await sendMessage(chatId, `⏸ ${titulo} · ${p.nome}\nHorário seguro como pré por 6h. Se não vier o comprovante, aviso vocês (não cancelo sozinho).`, true);
      await atualizarBotoesPedido(id, p);
      return;
    }

    // acao === "pag": comprovante recebido → reserva paga
    const v = calcularValorPedido(p);
    const antecipado = v ? reais(v.antecipado) : "(valor combinado)";
    let titulo = null;
    if (p.segurado) {
      // já existe o "pré" deste pedido: vira pago (se ainda estiver na agenda)
      let ev = null;
      try { ev = (await calendar.events.get({ calendarId: p.calId, eventId: p.segurado.eventoId })).data; } catch (e) { ev = null; }
      if (ev && ev.status !== "cancelled") {
        titulo = (ev.summary || p.segurado.titulo).replace(/\s+pr[eé](?=\s|$)/i, "").trim();
        await calendar.events.patch({
          calendarId: p.calId, eventId: ev.id,
          requestBody: { summary: titulo, description: `${ev.description || ""}\nantecipado ${antecipado} pago` },
        });
      }
    }
    if (!titulo) titulo = (await criarEventoComId({ ...dadosDoEvento(p), antecipadoPago: antecipado })).titulo;
    p.reservado = { titulo };
    await responder("Reserva criada ✓");
    await sendMessage(chatId, `🧾 Reserva paga na agenda: ${titulo} · ${p.nome} · antecipado ${antecipado} pago\n👇 Confirmação para o cliente:`, true);
    await enviarTextoELink(chatId, montarTextoConfirmacao(p), telefoneInternacional(p.telefone));
    await atualizarBotoesPedido(id, p);
  } catch (e) {
    console.error("Erro no botão do pedido:", e.message);
    await responder("Deu erro, veja o chat.");
    await sendMessage(chatId, `❌ Erro: ${e.message}`, true);
  } finally {
    p.ocupado = false;
  }
}

// a cada 10 min: lembrete de "pré" segurado há 6h sem comprovante (nunca cancela) + limpeza dos pedidos vencidos
setInterval(async () => {
  const agora = Date.now();
  for (const [id, p] of pedidosSite) {
    if (agora - p.criado > PEDIDO_VALIDADE_MS) { pedidosSite.delete(id); continue; }
    if (p.segurado && !p.reservado && !p.segurado.lembrado && agora - p.segurado.em >= PEDIDO_SEGURAR_MS) {
      p.segurado.lembrado = true;
      await sendMessage(p.chatId,
        `⏰ Pedido do site seguro há 6h e ainda sem comprovante:\n📌 ${p.segurado.titulo} · ${diaDoPedido(p)}\n👤 ${p.nome} · 📞 ${telefoneLegivel(p.telefone)}\n\nO evento continua como pré na agenda. Não cancelei nada — vocês decidem.`, true);
    }
  }
}, 10 * 60 * 1000);
// ===================== fim do pedido pelo site =====================

// =====================================================================
// AGENDAMENTO PELO TELEGRAM (!agendar e !alterar) — sem etapa de confirmação
// "!agendar amanhã 14-16 C Maria 11999998888" confere as regras e cria direto.
// Falta data, horário, estúdio ou nome? Pergunta só o que falta, um por vez.
// Tipo: pré (padrão), "pago 150", "zm" (não cobrar) ou "zm2" (confirmar presença).
// Depois de criar: botões ✏️ Alterar e ↩️ Desfazer (10 min, só quem é autorizado).
// O bot só apaga um evento quando alguém da equipe toca em Desfazer.
// =====================================================================
const DESFAZER_PRAZO_MS = 10 * 60 * 1000;
const ALTERAR_ULTIMO_MS = 24 * 3600 * 1000;
const AGENDAMENTO_MEMORIA_MS = 7 * 24 * 3600 * 1000;
const DIAS_CURTOS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const DIAS_POR_NOME = { domingo: 0, dom: 0, segunda: 1, seg: 1, terca: 2, ter: 2, quarta: 3, qua: 3, quinta: 4, qui: 4, sexta: 5, sex: 5, sabado: 6, sab: 6 };
const EXEMPLO_ALTERAR = "O que muda? Ex.: 15-17 · sábado · estúdio D · pago 150 · tel 11999998888 · nome Ana";

const agendamentosBot = new Map(); // rid → { eventoId, calId, chatId, userId, criado, r, c, descricaoGerada }
const confirmacoesBot = new Map(); // "chat:mensagem" → rid (para !alterar respondendo à confirmação)
const alterarPendente = {};        // "chat:pessoa" → rid (depois do botão ✏️ Alterar)

// fronteiras de palavra que entendem acento (o \b do JS não entende "pré")
const SEM_LETRA_ANTES = "(?<![\\p{L}\\d])", SEM_LETRA_DEPOIS = "(?![\\p{L}\\d])";
const re = (corpo, flags = "") => new RegExp(SEM_LETRA_ANTES + corpo + SEM_LETRA_DEPOIS, "iu" + flags);
const PALAVRAS_DE_LIGACAO = new Set(["e", "de", "das", "do", "dia", "as", "às", "a", "ate", "até", "no", "na", "para", "pra", "com", "o", "estudio", "estúdio", "est", "tel", "telefone"]);

function hojeEmSP() {
  return dataISOemSP(Date.now());
}

// "20/10" → "2026-10-20" (ano que vem se a data já passou há mais de 7 dias); null se a data não existe
function dataDeDiaMes(dia, mes, ano, hojeISO) {
  const p = (n) => String(n).padStart(2, "0");
  let a = ano ? (ano < 100 ? 2000 + ano : ano) : parseInt(hojeISO.slice(0, 4));
  let iso = `${a}-${p(mes)}-${p(dia)}`;
  if (!ano && iso < somarDiasISO(hojeISO, -7)) iso = `${++a}-${p(mes)}-${p(dia)}`;
  const d = new Date(`${iso}T12:00:00-03:00`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

// próxima ocorrência do dia da semana (hoje conta)
function proximoDiaDaSemana(hojeISO, dw) {
  const hoje = new Date(`${hojeISO}T12:00:00-03:00`).getUTCDay();
  return somarDiasISO(hojeISO, (dw - hoje + 7) % 7);
}

// lê um texto solto de agendamento/alteração. Cada pedaço reconhecido sai do texto; o que sobra é o nome.
// devolve { datas, horario, estudio, telefone, tipo, pago, nome, sobra }
function lerTextoAgendamento(texto, { nomeComPalavra = false } = {}) {
  const hoje = hojeEmSP();
  let t = ` ${String(texto || "").replace(/\s+/g, " ")} `;
  const out = { datas: [], horario: null, estudio: null, telefone: null, tipo: null, pago: null, nome: null, sobra: "" };
  const tirar = (regex, fn) => { t = t.replace(regex, (...m) => { fn(m); return " ¦ "; }); };

  // "nome Ana Paula" (no !alterar): vai até o fim da linha
  if (nomeComPalavra) tirar(re("nome\\s*:?\\s+(.+)$"), m => { out.nome = m[1].trim(); });
  tirar(re("ok15", "g"), () => {}); // ok15 não é mais preciso; se alguém escrever por hábito, não vira nome
  tirar(re("pago\\s*(?:r\\$\\s*)?(\\d+(?:[.,]\\d{1,2})?)"), m => { out.tipo = "pago"; out.pago = m[1].replace(",", "."); });
  tirar(re("pago"), () => { if (!out.tipo) out.tipo = "pago"; });
  tirar(re("zm2"), () => { out.tipo = "zm2"; });
  tirar(re("zm"), () => { out.tipo = out.tipo || "zm"; });
  tirar(re("pr[eé](?:-reserva)?"), () => { out.tipo = out.tipo || "pre"; });
  tirar(re("(?:sem\\s+telefone|tel(?:efone)?\\.?\\s*:?\\s*sem)"), () => { out.telefone = ""; });
  tirar(/(?:tel(?:efone)?\.?\s*:?\s*)?(?<!\d)(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?\d{4,5}[\s.-]?\d{4}(?!\d)/giu, m => {
    if (out.telefone === null) out.telefone = telefoneInternacional(m[0].replace(/^\D+/, "").replace(/\D/g, ""));
  });
  tirar(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g, m => {
    const iso = dataDeDiaMes(parseInt(m[1]), parseInt(m[2]), m[3] ? parseInt(m[3]) : null, hoje);
    if (iso) out.datas.push(iso); else out.sobra += ` ${m[0]}`;
  });
  tirar(re("depois\\s+de\\s+amanh[ãa]", "g"), () => out.datas.push(somarDiasISO(hoje, 2)));
  tirar(re("amanh[ãa]", "g"), () => out.datas.push(somarDiasISO(hoje, 1)));
  tirar(re("hoje", "g"), () => out.datas.push(hoje));
  tirar(re("(domingo|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|dom|seg|ter|qua|qui|sex|s[áa]b)(?:-feira)?", "g"), m => {
    out.datas.push(proximoDiaDaSemana(hoje, DIAS_POR_NOME[normalizar(m[1])]));
  });
  tirar(re("(?:das\\s+)?(\\d{1,2})(?:[:h](\\d{2}))?h?\\s*(?:-|–|às|as|a|até|ate)\\s*(\\d{1,2})(?:[:h](\\d{2}))?h?"), m => {
    const v = validarHorario(`${m[1]}:${m[2] || "00"}-${m[3]}:${m[4] || "00"}`);
    if (v) out.horario = v; else out.sobra += ` ${m[0].trim()}`;
  });
  tirar(re("(?:est[úu]dio|est\\.?)\\s*(ab|[abcd]|[123])"), m => { out.estudio = m[1].toUpperCase(); });
  if (!out.estudio) tirar(/(?<![\p{L}\d])(AB|ab|[ABCD]|[bcd]|[123])(?![\p{L}\d])/u, m => { out.estudio = m[1].toUpperCase(); });

  // o que sobrou: pedaços entre os marcadores, sem palavras de ligação nas pontas
  const pedacos = t.split("¦").map(s => {
    const palavras = s.replace(/[,;·]/g, " ").trim().split(/\s+/).filter(Boolean);
    while (palavras.length && PALAVRAS_DE_LIGACAO.has(palavras[0].toLowerCase())) palavras.shift();
    while (palavras.length && PALAVRAS_DE_LIGACAO.has(palavras.at(-1).toLowerCase())) palavras.pop();
    return palavras.join(" ").replace(/^[.:\-–]+|[.:\-–]+$/g, "").trim();
  }).filter(Boolean);
  const resto = pedacos.join(" ");
  if (nomeComPalavra) out.sobra = (out.sobra + " " + resto).trim();
  else { out.nome = resto || null; out.sobra = out.sobra.trim(); }
  return out;
}

// telefone de um nome conhecido, só quando não há dúvida: nome igual (ou nome e sobrenome todos presentes)
// e um único telefone entre todos os achados na agenda e nos contatos do Google
async function buscarTelefoneSeguro(nome) {
  const alvo = normalizar(nome).replace(/\s+/g, " ").trim();
  if (!alvo) return null;
  const bate = (outro) => normalizar(outro).replace(/\s+/g, " ").trim() === alvo || classificarMatch(nome, outro) === "forte";
  const achados = [];
  const agora = Date.now(), janela = 180 * 24 * 3600 * 1000;
  for (const calId of CALENDAR_IDS.slice(0, 2)) {
    try {
      const res = await calendar.events.list({ calendarId: calId, timeMin: new Date(agora - janela).toISOString(), timeMax: new Date(agora + janela).toISOString(), singleEvents: true });
      for (const ev of (res.data.items || [])) {
        const nomeEv = extrairNome(ev);
        const tel = extrairTelefone((ev.summary || "") + " " + (ev.description || ""));
        if (nomeEv && tel && bate(nomeEv)) achados.push({ nome: nomeEv, telefone: tel, origem: "em outra reserva" });
      }
    } catch (e) { console.error("Erro ao buscar telefone conhecido:", e.message); }
  }
  const { fortes, fracos } = await buscarCandidatosContato(nome);
  for (const c of [...fortes, ...fracos]) if (bate(c.nome)) achados.push({ ...c, origem: "nos contatos do Google" });
  // mesmo número com ou sem o 9 / com ou sem 55 conta como um só
  const numeros = new Set(achados.map(a => a.telefone.slice(-8)));
  return numeros.size === 1 ? achados[0] : null;
}

function rotuloTipo(c) {
  if (c.tipo === "pago") return `pago R$${c.pago}`;
  if (c.tipo === "zm") return "zm (não cobrar)";
  if (c.tipo === "zm2") return "zm2 (confirmar presença)";
  return "pré";
}

function horaTexto(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// "sex 17/10 · 14:00–16:00 · Estúdio C (Aclimação) · Maria · 11 99999-8888 · pré"
function resumoAgendamento(r, c) {
  const dw = new Date(`${r.dataISO}T12:00:00-03:00`).getUTCDay();
  return [
    `${DIAS_CURTOS[dw]} ${r.dataISO.slice(8, 10)}/${r.dataISO.slice(5, 7)}`,
    `${horaTexto(r.h1, r.m1)}–${horaTexto(r.h2, r.m2)}`,
    `Estúdio ${r.estudio} (${agendaDoEstudio(r.estudio).unidade})`,
    c.nome,
    c.telefone ? telefoneLegivel(c.telefone) : "sem telefone",
    rotuloTipo(c),
  ].join(" · ");
}

// reserva = data + horário + estúdio; devolve também início/fim e a agenda certa
function montarReserva(dataISO, horario, estudio) {
  const ag = agendaDoEstudio(estudio);
  return {
    dataISO, estudio, calId: ag.calId, unidade: ag.unidade, ...horario,
    inicio: new Date(`${dataISO}T${horaTexto(horario.h1, horario.m1)}:00-03:00`),
    fim: new Date(`${dataISO}T${horaTexto(horario.h2, horario.m2)}:00-03:00`),
  };
}

function dadosDoEventoBot(r, c) {
  return { ...r, nome: c.nome, telefone: c.telefone || "", pago: c.tipo === "pago" ? c.pago : null, naoCobrar: c.tipo === "zm", confirmarPresenca: c.tipo === "zm2" };
}

function motivoDaRecusa(regra, r) {
  const data = r.inicio.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  if (regra.motivo === "duracao") return `A duração mínima em ${data} é de ${formatarDuracao(regra.minimo)} (este pedido tem ${formatarDuracao(Math.max(0, regra.duracao))}).`;
  if (regra.motivo === "horario") return "O fim tem de ser depois do início e no mesmo dia (até 23:30).";
  if (regra.motivo === "passo") return "Use horários de 30 em 30 min (ex.: 14:00 ou 14:30).";
  if (regra.motivo === "conflito") return `O estúdio ${r.estudio} já está ocupado.\nAluguel que bate: ${descreverEventoCurto(regra.ev)}.`;
  return `Intervalo de só ${regra.intervalo} min com outro aluguel (mínimo 15, o normal é 30).\nAluguel que bate: ${descreverEventoCurto(regra.ev)}.`;
}

function tecladoAgendamento(rid) {
  return { inline_keyboard: [[{ text: "✏️ Alterar", callback_data: `ag:alt:${rid}` }, { text: "↩️ Desfazer", callback_data: `ag:des:${rid}` }]] };
}

async function enviarConfirmacaoAgendamento(rid, prefixo, extra = "") {
  const a = agendamentosBot.get(rid);
  const resp = await telegram("sendMessage", { chat_id: a.chatId, text: `${prefixo} ${resumoAgendamento(a.r, a.c)}${extra}`, reply_markup: tecladoAgendamento(rid) });
  if (resp?.result?.message_id) confirmacoesBot.set(`${a.chatId}:${resp.result.message_id}`, rid);
}

// pergunta só o que falta; com tudo em mãos, confere as regras e cria
async function seguirAgendamento(chave, conv) {
  const perguntar = async (passo, texto) => { conv.passo = passo; conversasAgendamento[chave] = conv; await sendMessage(conv.chatId, texto, true); };
  if (!conv.datas.length) return perguntar("data", "📅 Qual a data? (ex.: 20/10, amanhã ou sábado)");
  if (!conv.horario) return perguntar("horario", "🕐 Qual o horário? (ex.: 14-16 ou 14:30-16:30)");
  if (!conv.estudio) return perguntar("estudio", "📸 Qual o estúdio?\nAclimação: A, B, C, D, AB\nBela Vista: 1, 2, 3");
  if (!conv.nome) return perguntar("nome", "👤 Qual o nome do cliente?");
  if (conv.tipo === "pago" && !conv.pago) return perguntar("valor", "💵 Qual o valor pago? (ex.: 150)");
  if (conv.telefone === null && !conv.telefoneBuscado) {
    conv.telefoneBuscado = true;
    const achado = await buscarTelefoneSeguro(conv.nome);
    if (achado) { conv.telefone = achado.telefone; conv.telefoneAchado = achado; }
  }
  if (conv.telefone === null) return perguntar("telefone", `📞 Qual o telefone da ${primeiroNome(conv.nome)}? (ou "sem")`);
  delete conversasAgendamento[chave];
  await criarAgendamentos(chave, conv);
}

// cada data é conferida e criada por conta própria; o resultado de cada uma vai numa mensagem
async function criarAgendamentos(chave, conv) {
  const c = { nome: conv.nome, telefone: conv.telefone, tipo: conv.tipo || "pre", pago: conv.pago || null };
  const criadas = [];
  for (const dataISO of conv.datas) {
    const r = montarReserva(dataISO, conv.horario, conv.estudio);
    const dm = `${dataISO.slice(8, 10)}/${dataISO.slice(5, 7)}`;
    let regra;
    try {
      regra = await checarRegrasAluguel(r.calId, r.estudio, r.inicio, r.fim, null, { equipe: true });
    } catch (e) {
      console.error("Erro ao checar regras de aluguel:", e.message);
      await sendMessage(conv.chatId, `❌ ${dm}: não criei. Não consegui conferir a agenda agora (${e.message}). Tente de novo em instantes.`, true);
      continue;
    }
    if (regra.status === "recusa") {
      await sendMessage(conv.chatId, `❌ ${dm}: não criei. ${motivoDaRecusa(regra, r)}`, true);
      continue;
    }
    try {
      const dados = dadosDoEventoBot(r, c);
      const { id, descricao } = await criarEventoComId(dados);
      const rid = randomBytes(5).toString("hex");
      agendamentosBot.set(rid, { eventoId: id, calId: r.calId, chatId: conv.chatId, userId: conv.userId, criado: Date.now(), r, c: { ...c }, descricaoGerada: descricao });
      const achado = conv.telefoneAchado ? `\n📞 Telefone achado ${conv.telefoneAchado.origem} ("${conv.telefoneAchado.nome}"). Se não for esse: !alterar tel 11999998888` : "";
      await enviarConfirmacaoAgendamento(rid, "✅ Criado:", avisosDaEquipe(regra) + achado);
      criadas.push(r);
    } catch (e) {
      await sendMessage(conv.chatId, `❌ ${dm}: erro ao criar o evento (${e.message}).`, true);
    }
  }
  if (criadas.length) {
    await esperar(1500);
    const d = { nome: c.nome, naoCobrar: c.tipo === "zm" };
    await enviarTextoELink(conv.chatId, montarMensagemParaClienteMulti(d, criadas, c.tipo === "pago" ? c.pago : null), c.telefone);
  }
}

async function iniciarAgendamento(chave, chatId, userId, bruto) {
  const site = interpretarMensagemSite(bruto, hojeEmSP());
  let conv;
  if (site) {
    // mensagem do site: estúdio, data e horário lidos direto do texto (IA só para nome/telefone)
    const campos = await camposDaMensagemSite(site);
    if (site.unidadeErrada) await sendMessage(chatId, "⚠️ O estúdio da mensagem não é da unidade citada. Vou perguntar o estúdio.", true);
    const p = (n) => String(n).padStart(2, "0");
    conv = {
      datas: campos.datas.map(d => `${d.ano}-${p(d.mes)}-${p(d.dia)}`), horario: campos.horario, estudio: campos.estudio,
      nome: campos.nome, telefone: campos.telefone ? telefoneInternacional(campos.telefone) : null, tipo: null, pago: null,
    };
  } else {
    const lido = lerTextoAgendamento(bruto);
    conv = { ...lido };
    // sobrou número ou hora no nome: a leitura simples não entendeu tudo, pede ajuda à IA
    if (lido.sobra || (lido.nome && /\d/.test(lido.nome))) {
      const ia = await interpretarAgendamento(bruto);
      if (ia._ok) {
        if (!conv.datas.length) conv.datas = ia.datas.map(d => dataDeDiaMes(d.dia, d.mes, null, hojeEmSP())).filter(Boolean);
        conv.horario = conv.horario || ia.horario;
        conv.estudio = conv.estudio || ia.estudio;
        if (conv.telefone === null && ia.telefone) conv.telefone = telefoneInternacional(ia.telefone);
        if (ia.nome) conv.nome = ia.nome;
      }
    }
    if (conv.nome && /\d/.test(conv.nome)) conv.nome = null;
  }
  conv.datas = [...new Set(conv.datas)].sort();
  Object.assign(conv, { chatId, userId, passo: null });
  await seguirAgendamento(chave, conv);
}

// resposta a uma pergunta do !agendar (data, horário, estúdio, nome, valor ou telefone)
async function responderAgendamento(chave, conv, texto) {
  const t = texto.trim(), tn = normalizar(t);
  if (conv.passo === "telefone") {
    if (["sem", "sem telefone", "nao tem", "nao"].includes(tn)) conv.telefone = "";
    else {
      const dig = t.replace(/\D/g, "");
      if (dig.length < 10 || dig.length > 13) return sendMessage(conv.chatId, `⚠️ Telefone com DDD (ex.: 11999998888), ou "sem":`, true);
      conv.telefone = telefoneInternacional(dig);
    }
    return seguirAgendamento(chave, conv);
  }
  if (conv.passo === "nome") {
    if (t.length < 2) return sendMessage(conv.chatId, "⚠️ Escreva o nome do cliente:", true);
    conv.nome = t;
    return seguirAgendamento(chave, conv);
  }
  if (conv.passo === "valor") {
    const v = t.replace(/[^\d.,]/g, "").replace(",", ".");
    if (!v || !parseFloat(v)) return sendMessage(conv.chatId, "⚠️ Escreva só o número (ex.: 150):", true);
    conv.pago = v;
    return seguirAgendamento(chave, conv);
  }
  const lido = lerTextoAgendamento(t);
  if (conv.passo === "estudio" && !lido.estudio && /^a$/i.test(t)) lido.estudio = "A";
  const faltou = {
    data: [!lido.datas.length, "⚠️ Não entendi a data. Ex.: 20/10, amanhã ou sábado:"],
    horario: [!lido.horario, "⚠️ Não entendi o horário. Ex.: 14-16 ou 14:30-16:30:"],
    estudio: [!lido.estudio, "⚠️ Estúdio inválido. A, B, C, D, AB, 1, 2 ou 3:"],
  }[conv.passo];
  if (faltou && faltou[0]) return sendMessage(conv.chatId, faltou[1], true);
  if (lido.datas.length && !conv.datas.length) conv.datas = [...new Set(lido.datas)].sort();
  if (lido.horario && !conv.horario) conv.horario = lido.horario;
  if (lido.estudio && !conv.estudio) conv.estudio = lido.estudio;
  return seguirAgendamento(chave, conv);
}

// qual agendamento o !alterar muda: resposta à confirmação → aquele; senão o último dessa pessoa em 24h
function agendamentoParaAlterar(chatId, userId, respondida) {
  if (respondida) {
    const rid = confirmacoesBot.get(`${chatId}:${respondida}`);
    if (rid && agendamentosBot.has(rid)) return rid;
  }
  let melhor = null;
  for (const [rid, a] of agendamentosBot) {
    if (a.desfeito || String(a.userId) !== String(userId) || Date.now() - a.criado > ALTERAR_ULTIMO_MS) continue;
    if (!melhor || a.criado > agendamentosBot.get(melhor).criado) melhor = rid;
  }
  return melhor;
}

// linhas da descrição que não foram escritas pelo bot na criação (ex.: [cobrado 1x ...]) continuam lá
function novaDescricao(atual, geradaAntes, geradaAgora) {
  const nossas = new Set((geradaAntes || "").split("\n"));
  const extras = (atual || "").split("\n").filter(l => l.trim() && !nossas.has(l));
  return [geradaAgora, ...extras].join("\n");
}

async function alterarAgendamento(chatId, userId, texto, rid) {
  const responder = (t) => sendMessage(chatId, t, true);
  const mud = lerTextoAgendamento(texto, { nomeComPalavra: true });
  if (mud.sobra) return responder(`⚠️ Não entendi: "${mud.sobra}". Nada foi alterado.\n${EXEMPLO_ALTERAR}`);
  if (mud.datas.length > 1) return responder("⚠️ Uma data por vez no !alterar. Nada foi alterado.");
  const temMudanca = mud.datas.length || mud.horario || mud.estudio || mud.tipo || mud.telefone !== null || mud.nome;
  if (!temMudanca) return responder(EXEMPLO_ALTERAR);
  if (mud.tipo === "pago" && !mud.pago) return responder("⚠️ Escreva o valor: pago 150. Nada foi alterado.");
  const a = agendamentosBot.get(rid);
  if (!a) return responder("Não achei o agendamento. Responda à mensagem de confirmação dele com !alterar.");
  if (a.desfeito) return responder("Esse agendamento foi desfeito. Nada foi alterado.");
  if (a.ocupado) return responder("Um instante, ainda estou cuidando da alteração anterior…");
  a.ocupado = true;
  try {
    let ev;
    try {
      ev = (await calendar.events.get({ calendarId: a.calId, eventId: a.eventoId })).data;
    } catch (e) {
      return responder(`Não achei esse evento no Google Agenda (${e.message}). Nada foi alterado.`);
    }
    const horario = mud.horario || { h1: a.r.h1, m1: a.r.m1, h2: a.r.h2, m2: a.r.m2 };
    const r = montarReserva(mud.datas[0] || a.r.dataISO, horario, mud.estudio || a.r.estudio);
    const c = { ...a.c };
    if (mud.nome) c.nome = mud.nome;
    if (mud.telefone !== null) c.telefone = mud.telefone;
    if (mud.tipo) { c.tipo = mud.tipo; c.pago = mud.tipo === "pago" ? mud.pago : null; }

    let regra;
    try {
      regra = await checarRegrasAluguel(r.calId, r.estudio, r.inicio, r.fim, r.calId === a.calId ? a.eventoId : null, { equipe: true });
    } catch (e) {
      return responder(`❌ Não consegui conferir a agenda agora (${e.message}). Nada foi alterado.`);
    }
    if (regra.status === "recusa") return responder(`❌ Não alterei. ${motivoDaRecusa(regra, r)}`);

    const { titulo, descricao, eventBody } = montarEvento(dadosDoEventoBot(r, c));
    eventBody.description = novaDescricao(ev.description, a.descricaoGerada, descricao);
    if (r.calId === a.calId) {
      await calendar.events.patch({ calendarId: a.calId, eventId: a.eventoId, requestBody: { ...eventBody, colorId: eventBody.colorId || null } });
    } else {
      // outra unidade: cria na agenda certa e só então apaga da antiga
      const novo = await calendar.events.insert({ calendarId: r.calId, requestBody: eventBody });
      try {
        await calendar.events.delete({ calendarId: a.calId, eventId: a.eventoId });
      } catch (e) {
        await calendar.events.delete({ calendarId: r.calId, eventId: novo.data.id }).catch(() => {});
        throw e;
      }
      a.eventoId = novo.data.id;
      a.calId = r.calId;
    }
    Object.assign(a, { r, c, descricaoGerada: descricao, titulo });
    await enviarConfirmacaoAgendamento(rid, "✏️ Alterado:", avisosDaEquipe(regra));
  } catch (e) {
    await responder(`❌ Erro ao alterar o evento (${e.message}).`);
  } finally {
    a.ocupado = false;
  }
}

async function tratarBotaoAgendamento(cq) {
  const responder = (text, show_alert = false) => telegram("answerCallbackQuery", { callback_query_id: cq.id, text, show_alert });
  const [, acao, rid] = String(cq.data || "").split(":");
  const chatId = String(cq.message?.chat?.id || "");
  const userId = String(cq.from?.id || "");
  if (!podeAgendar(userId) && !podeAgendar(chatId)) return responder("Só a equipe autorizada pode usar estes botões.", true);
  const a = agendamentosBot.get(rid);
  if (!a) {
    await responder("Esse agendamento não está mais na memória do bot.", true);
    return;
  }
  if (a.desfeito) return responder("Esse agendamento já foi desfeito.");

  if (acao === "alt") {
    alterarPendente[`${chatId}:${userId}`] = rid;
    await responder();
    await sendMessage(chatId, EXEMPLO_ALTERAR, true);
    return;
  }
  if (acao !== "des") return responder();
  if (Date.now() - a.criado > DESFAZER_PRAZO_MS) {
    await responder("Passou o prazo do desfazer.");
    await sendMessage(chatId, "Passou o prazo do desfazer. Se precisar, apague direto no Google Agenda.", true);
    return;
  }
  if (a.ocupado) return responder("Um instante, ainda estou cuidando do toque anterior…");
  a.ocupado = true;
  try {
    // apaga só o evento criado por esta ação (pelo id guardado)
    await calendar.events.delete({ calendarId: a.calId, eventId: a.eventoId });
    a.desfeito = true;
    await telegram("editMessageText", { chat_id: chatId, message_id: cq.message.message_id, text: `↩️ Desfeito: ${resumoAgendamento(a.r, a.c)}`, reply_markup: { inline_keyboard: [] } });
    await responder("Desfeito: o evento foi apagado da agenda.");
  } catch (e) {
    await responder(`Não consegui apagar (${e.message}). Confira no Google Agenda.`, true);
  } finally {
    a.ocupado = false;
  }
}

// mensagens do !agendar / !alterar. Devolve true quando a mensagem foi tratada aqui.
async function tratarMensagemAgendamento(message) {
  const chatId = String(message.chat.id);
  const userId = String(message.from?.id || chatId);
  const chave = `${chatId}:${userId}`;
  const texto = message.text.trim();
  const tn = texto.toLowerCase();
  const ehComando = tn.startsWith("!");

  // depois do botão ✏️: a próxima mensagem dessa pessoa é o !alterar daquele agendamento
  if (alterarPendente[chave]) {
    const rid = alterarPendente[chave];
    delete alterarPendente[chave];
    if (!ehComando || /^!alterar\b/.test(tn)) {
      await alterarAgendamento(chatId, userId, texto.replace(/^!alterar\s*/i, ""), rid);
      return true;
    }
  }

  const conv = conversasAgendamento[chave];
  if (conv && !ehComando) {
    if (tn === "cancelar") { delete conversasAgendamento[chave]; await sendMessage(chatId, "Ok, cancelado. Nada foi criado. 👍", true); return true; }
    await responderAgendamento(chave, conv, texto);
    return true;
  }
  if (conv && ehComando) delete conversasAgendamento[chave]; // outro comando: larga a pergunta pendente

  if (/^!alterar\b/.test(tn)) {
    const rid = agendamentoParaAlterar(chatId, userId, message.reply_to_message?.message_id);
    if (!rid) {
      await sendMessage(chatId, "Não achei agendamento seu nas últimas 24h. Responda à mensagem de confirmação (✅ Criado) com o !alterar.", true);
      return true;
    }
    await alterarAgendamento(chatId, userId, texto.replace(/^!alterar\s*/i, ""), rid);
    return true;
  }

  // mensagem do site colada (sem comando) = "!agendar " + mensagem
  const ehMensagemSite = !ehComando && /gostaria de reservar o est[úu]dio/i.test(texto);
  if (/^!agendar\b/.test(tn) || ehMensagemSite) {
    const bruto = texto.replace(/^!agendar\s*/i, "").trim();
    if (!bruto) {
      await sendMessage(chatId, "Escreva tudo numa linha, ex.: !agendar amanhã 14-16 C Maria 11999998888", true);
      return true;
    }
    await iniciarAgendamento(chave, chatId, userId, bruto);
    return true;
  }
  return false;
}

// esquece agendamentos antigos (a memória serve para desfazer, alterar e responder à confirmação)
setInterval(() => {
  for (const [rid, a] of agendamentosBot) if (Date.now() - a.criado > AGENDAMENTO_MEMORIA_MS) agendamentosBot.delete(rid);
  for (const [k, rid] of confirmacoesBot) if (!agendamentosBot.has(rid)) confirmacoesBot.delete(k);
}, 3600 * 1000);
// ===================== fim do !agendar / !alterar =====================

// =====================================================================
// CONFERÊNCIA DA AGENDA — SÓ AVISA A EQUIPE NO TELEGRAM
// Procura, nos próximos 60 dias das agendas Aclimação e Bela Vista:
//   • evento sem estúdio no título (que não seja bloqueio/fechamento);
//   • estúdio que não é daquela unidade (ex.: "B" na agenda da Bela Vista);
//   • dois agendamentos no mesmo estúdio e horário (AB conta com A e com B).
// Nunca altera, move ou cancela eventos. Nunca manda mensagem a clientes.
// Roda sozinha todo dia às 8h05 (horário de São Paulo) e pelo comando !conferir.
// =====================================================================
const CONF_UNIDADES = [["aclimacao", "Aclimação", 0], ["belavista", "Bela Vista", 1]];

function confQuando(t) {
  return new Date(t).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

async function conferirAgenda(dias = 60) {
  const inicio = new Date();
  const fim = new Date(inicio.getTime() + dias * 24 * 60 * 60 * 1000);
  const problemas = [];
  for (const [unidade, nomeUn, idx] of CONF_UNIDADES) {
    const calId = CALENDAR_IDS[idx];
    if (!calId) continue;
    const eventos = [];
    let pageToken;
    do {
      const res = await calendar.events.list({
        calendarId: calId, timeMin: inicio.toISOString(), timeMax: fim.toISOString(),
        singleEvents: true, orderBy: "startTime", maxResults: 2500, pageToken,
      });
      for (const ev of (res.data.items || [])) {
        if (ev.status === "cancelled" || ev.transparency === "transparent") continue;
        if (!ev.start || !ev.start.dateTime) continue;
        eventos.push(ev);
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);

    const comEstudio = [];
    for (const ev of eventos) {
      const titulo = (ev.summary || "(sem título)").trim();
      const quando = confQuando(ev.start.dateTime);
      const est = extrairEstudio(ev);
      const bloqueio = /BLOQ|FECHAD|MANUTEN/i.test(titulo);
      if (!est) {
        if (!bloqueio) problemas.push(`❓ ${nomeUn} · ${quando} · "${titulo}"\n   sem estúdio no título (no site, a unidade inteira aparece ocupada)`);
        continue;
      }
      if (!SITE_ESTUDIOS[unidade].includes(est)) {
        problemas.push(`⚠️ ${nomeUn} · ${quando} · "${titulo}"\n   o estúdio ${est} não é desta unidade — está na agenda errada ou com o número errado?`);
        continue;
      }
      comEstudio.push({ titulo, est, bloqueio, ini: Date.parse(ev.start.dateTime), fim: Date.parse(ev.end.dateTime) });
    }
    for (let i = 0; i < comEstudio.length; i++) {
      for (let j = i + 1; j < comEstudio.length; j++) {
        const a = comEstudio[i], b = comEstudio[j];
        if (!siteEstudiosAfetados(a.est, unidade).includes(b.est)) continue;
        if (a.ini < b.fim && b.ini < a.fim) {
          problemas.push(`🔴 ${nomeUn} · conflito no mesmo horário:\n   "${a.titulo}" (${confQuando(a.ini)})\n   "${b.titulo}" (${confQuando(b.ini)})`);
          continue;
        }
        // intervalo curto: menos de 15 min entre dois aluguéis do mesmo estúdio (bloqueios não contam)
        if (a.bloqueio || b.bloqueio) continue;
        const intervalo = Math.round((a.ini >= b.fim ? a.ini - b.fim : b.ini - a.fim) / 60000);
        if (intervalo < INTERVALO_MINIMO_MIN) {
          problemas.push(`⏱️ ${nomeUn} · intervalo curto (${intervalo} min, o mínimo é 15):\n   "${a.titulo}" (${confQuando(a.ini)})\n   "${b.titulo}" (${confQuando(b.ini)})`);
        }
      }
    }
  }
  return problemas;
}

function confMontarMensagens(problemas) {
  if (!problemas.length) return ["✅ Conferência da agenda: nenhum problema nos próximos 60 dias."];
  const cab = `🔎 Conferência da agenda — ${problemas.length} ${problemas.length === 1 ? "ponto" : "pontos"} para revisar (próximos 60 dias).\nNada foi alterado; só estou avisando.\n\n`;
  const msgs = [];
  let atual = cab;
  for (const p of problemas) {
    if ((atual + p + "\n\n").length > 3800) { msgs.push(atual); atual = ""; }
    atual += p + "\n\n";
  }
  if (atual.trim()) msgs.push(atual);
  return msgs;
}

async function rodarConferencia(destino = CHAT_MATINAL, sempre = true) {
  const problemas = await conferirAgenda(60);
  if (!problemas.length && !sempre) return;
  for (const m of confMontarMensagens(problemas)) await sendMessage(destino, m, true);
}

// 8h05 — conferência automática (só manda mensagem se achar algum problema)
cron.schedule('5 8 * * *', async () => {
  console.log("⏰ Rodando a conferência da agenda das 8h05...");
  try {
    await rodarConferencia(CHAT_MATINAL, false);
  } catch (e) {
    console.error("Erro na conferência da agenda:", e.message);
  }
}, { timezone: "America/Sao_Paulo" });
// ===================== fim da conferência da agenda =====================

// ===================== página da agenda do site (para o iframe) =====================
import { readFileSync } from "fs";
app.get("/agenda", (req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=300");
    res.type("html").send(readFileSync(new URL("./agenda.html", import.meta.url), "utf8"));
  } catch (e) {
    console.error("Erro /agenda:", e.message);
    res.status(500).send("Agenda indisponível no momento.");
  }
});
// ===================== fim da página da agenda =====================

app.get('/', (req, res) => res.send('Bot Telegram ZM Photo — Online'));

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

// AGENDADOR — ciclo automático das 8h (marca avisos + alerta 3º aviso; NÃO cancela)
cron.schedule('0 8 * * *', async () => {
  console.log("⏰ Rodando o ciclo automático das 8h...");
  try {
    await rodarEnsaioConfirmacoes(true, CHAT_MATINAL);
  } catch (e) {
    console.error("Erro no ciclo automático:", e.message);
  }
}, { timezone: "America/Sao_Paulo" });

// 9h — confirmação de presença (48h) para quem já pagou
cron.schedule('0 9 * * *', async () => {
  console.log("⏰ Rodando a confirmação de presença das 9h...");
  try {
    await rodarConfirmacao48h(CHAT_MATINAL);
  } catch (e) {
    console.error("Erro na confirmação 48h:", e.message);
  }
}, { timezone: "America/Sao_Paulo" });

app.listen(PORT, async () => {
  console.log(`🚀 Bot Telegram rodando na porta ${PORT}`);
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
