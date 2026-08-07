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
  return `${saudacao}\nPassando só pra confirmar seu ensaio de ${dataExtenso}, das ${hi} às ${hf}${textoEstudio}. Está tudo certinho e pago do nosso lado — te esperamos!\n${endereco}`;
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
  let ano = agora.getFullYear();
  const p = (n) => String(n).padStart(2, "0");
  const montaISO = (a) =>
    `${a}-${p(dados.mes)}-${p(dados.dia)}T${p(dados.h1)}:${p(dados.m1)}:00-03:00`;
  let inicio = new Date(montaISO(ano));
  if (inicio < agora && (agora - inicio) > 7 * 24 * 3600 * 1000) {
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
    `📋 *Confirma este agendamento?*\n${linhas}\n\n👤 ${d.nome}\n📞 ${d.telefone}\n${d.pago ? `💰 pago R$${d.pago} (total)` : (d.naoCobrar ? "🔕 não cobrar (marcado zm)" : (d.confirmarPresenca ? "✋ confirmar presença (não cobra sinal)" : "🔖 pré-reserva"))}\n\n` +
    `Responda *SIM* para confirmar ou *NÃO* para cancelar.`
  );
}

// decide o próximo campo faltante no agendamento rápido e pergunta só ele.
// ordem: data(s) -> horário -> estúdio -> nome -> telefone -> tipo -> confirmação final
async function avancarAgendamentoRapido(chatId, conversa) {
  const d = conversa.dados;
  if (!conversa.reservas || conversa.reservas.length === 0) {
    conversa.qtd = 1; conversa.passo = 'data';
    await sendMessage(chatId, "📅 Qual a *data*? (ex: 25/07)");
    return;
  }
  if (conversa.reservas.some(r => r.h1 === undefined)) {
    conversa.passo = 'faltaHorario';
    await sendMessage(chatId, "🕐 Qual o *horário*? (ex: 14-16 ou 14:30-16:30)");
    return;
  }
  if (conversa.reservas.some(r => !r.estudio)) {
    conversa.passo = 'faltaEstudio';
    await sendMessage(chatId, "📸 Qual o *estúdio*?\n\nAclimação: A, B, C, D, AB\nBela Vista: 1, 2, 3");
    return;
  }
  if (!d.nome) {
    conversa.passo = 'nome';
    await sendMessage(chatId, "👤 Qual o *nome* do cliente?");
    return;
  }
  if (!d.telefone) {
    let conhecido = await buscarTelefoneConhecido(d.nome);
    if (!conhecido) conhecido = await buscarContatoGoogle(d.nome);
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
  // 6) falta o tipo (pré/pago/não cobrar/confirmar)? Se já veio no texto (zm/zm2/pré), vai direto ao resumo
  if (d.naoCobrar || d.confirmarPresenca || (d.pago === null && conversa._tipoDefinido)) {
    conversa.passo = 'confirmar';
    await enviarResumoAgendamento(chatId, conversa);
    return;
  }
  conversa.passo = 'pagamento';
  await sendMessage(chatId, "💰 É *pré-reserva*, já foi *pago*, é pra *não cobrar* ou só *confirmar*?\n\nEscreva 'pré', 'pago', 'não cobrar' ou 'confirmar'");
}

const COR_POR_ESTUDIO = { C: "1", D: "4", "2": "2", "3": "7" };

async function criarEvento(dados) {
  const hTitulo = (h, m) => (m ? `${h}:${String(m).padStart(2, "0")}` : `${h}`);
  const titulo = `${hTitulo(dados.h1, dados.m1)}-${hTitulo(dados.h2, dados.m2)}/${dados.estudio}${dados.pago ? "" : " pré"}`;
  let descricao = dados.nome;
  if (dados.telefone) descricao += ` ${dados.telefone}`;
  if (dados.pago) descricao += `\npago R$${dados.pago}`;
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
  await calendar.events.insert({ calendarId: dados.calId, requestBody: eventBody });
  return titulo;
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
  let estudioFiltro = null, unidadeFiltro = null, semana = false, proximaSemana = false, apenasLivre = false, datas = [], horario = null, periodo = null, duracaoMin = null;
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

      if (conversasAgendamento[chatId] && textoMensagem === 'cancelar') {
        delete conversasAgendamento[chatId];
        await sendMessage(chatId, "Agendamento cancelado. 👍");
        return;
      }

      // !agendar COM dados soltos (ex.: "!agendar amanhã 14-16 A João 11999998888")
      if (/^!agendar\s+\S/.test(textoOriginal) && !/^!agendar\s+\d+$/.test(textoMensagem)) {
        const bruto = textoOriginal.replace(/^!agendar\s+/i, "").trim();
        await sendMessage(chatId, "🔎 Entendendo os dados, um instante...");
        const campos = await interpretarAgendamento(bruto);

        if (campos.datas.length === 0 && !campos.horario && !campos.estudio && !campos.nome && !campos.telefone) {
          // não deu pra extrair nada útil — cai no passo a passo normal
          conversasAgendamento[chatId] = { passo: 'data', qtd: 1, reservas: [], dados: {} };
          await sendMessage(chatId, "Não consegui entender os dados soltos. Vamos passo a passo. 😊\n\nQual a *data*? (ex: 25/07)");
          return;
        }

        // monta as reservas a partir das datas (todas com o mesmo horário/estúdio, se informados)
        const conversa = { passo: null, qtd: Math.max(1, campos.datas.length), reservas: [], dados: {}, rapido: true, penduraHorEst: {} };
        const est = campos.estudio ? validarEstudio(campos.estudio) : null;
        if (campos.datas.length > 0) {
          for (const dt of campos.datas) {
            const r = { dia: dt.dia, mes: dt.mes };
            if (campos.horario) { r.h1 = campos.horario.h1; r.m1 = campos.horario.m1; r.h2 = campos.horario.h2; r.m2 = campos.horario.m2; }
            if (est) { r.estudio = est.estudio; r.calId = est.calId; r.unidade = est.unidade; }
            conversa.reservas.push(r);
          }
        }
        conversa.penduraHorEst = { horario: campos.horario || null, est: est || null };
        if (campos.nome) conversa.dados.nome = campos.nome;
        if (campos.telefone) conversa.dados.telefone = campos.telefone;
        // tipo veio no texto? (zm/zm2/pago/pre) já preenche pra pular a pergunta depois
        if (campos.tipo === 'zm') { conversa.dados.naoCobrar = true; conversa.dados.confirmarPresenca = false; conversa.dados.pago = null; }
        else if (campos.tipo === 'zm2') { conversa.dados.confirmarPresenca = true; conversa.dados.naoCobrar = false; conversa.dados.pago = null; }
        else if (campos.tipo === 'pre') { conversa.dados.pago = null; conversa.dados.naoCobrar = false; conversa.dados.confirmarPresenca = false; conversa._tipoDefinido = true; }
        // "pago" precisa do valor, então não pré-preenche aqui (deixa perguntar o valor)

        // resumo do que entendeu
        const linhas = [];
        if (campos.datas.length) linhas.push(`📅 ${campos.datas.map(d => `${String(d.dia).padStart(2,"0")}/${String(d.mes).padStart(2,"0")}`).join(", ")}`);
        else linhas.push("📅 (faltando)");
        linhas.push(campos.horario ? `🕐 ${campos.horario.h1}${campos.horario.m1?":"+String(campos.horario.m1).padStart(2,"0"):""}-${campos.horario.h2}${campos.horario.m2?":"+String(campos.horario.m2).padStart(2,"0"):""}` : "🕐 (faltando)");
        linhas.push(est ? `📸 Estúdio ${est.estudio} (${est.unidade})` : "📸 (faltando)");
        linhas.push(campos.nome ? `👤 ${campos.nome}` : "👤 (faltando)");
        linhas.push(campos.telefone ? `📞 ${campos.telefone}` : "📞 (faltando)");
        if (campos.tipo === 'zm') linhas.push("🔕 não cobrar (zm)");
        else if (campos.tipo === 'zm2') linhas.push("✋ confirmar presença (zm2)");
        else if (campos.tipo === 'pre') linhas.push("🔖 pré-reserva");
        conversasAgendamento[chatId] = conversa;

        await sendMessage(chatId, `📋 Entendi assim:\n${linhas.join("\n")}\n\nSe estiver certo, responda *ok* para continuar. Se algo ficou errado, escreva *cancelar* e faça de novo.`);
        conversa.passo = 'confirmarRapido';
        return;
      }

      if (textoMensagem === '!agendar' || /^!agendar\s+\d+$/.test(textoMensagem)) {
        const mQtd = textoMensagem.match(/^!agendar\s+(\d+)$/);
        const qtd = mQtd ? Math.max(1, Math.min(10, parseInt(mQtd[1]))) : 1;
        conversasAgendamento[chatId] = { passo: 'data', qtd, reservas: [], dados: {} };
        const rotulo = qtd > 1 ? ` (data 1 de ${qtd})` : "";
        await sendMessage(chatId, `📅 *Novo agendamento*${rotulo}\n\nQual a *data*? (ex: 25/07)\n\n_(escreva 'cancelar' a qualquer momento para desistir)_`);
        return;
      }

      if (conversasAgendamento[chatId]) {
        const conversa = conversasAgendamento[chatId];
        const d = conversa.dados;

        // fluxo do agendamento rápido: confirma o que entendeu, depois pergunta só o que falta
        if (conversa.passo === 'confirmarRapido') {
          if (textoMensagem !== 'ok' && textoMensagem !== 'sim') {
            await sendMessage(chatId, "Se estiver certo, responda *ok*. Para recomeçar, *cancelar*.");
            return;
          }
          // decide o que falta e encaminha
          await avancarAgendamentoRapido(chatId, conversa);
          return;
        }

        // completa horário que faltava (vale para todas as reservas)
        if (conversa.passo === 'faltaHorario') {
          const v = validarHorario(textoOriginal);
          if (!v) { await sendMessage(chatId, "⚠️ Horário inválido. Use HH-HH (ex: 14-16). Tente de novo:"); return; }
          for (const r of conversa.reservas) { r.h1 = v.h1; r.m1 = v.m1; r.h2 = v.h2; r.m2 = v.m2; }
          await avancarAgendamentoRapido(chatId, conversa);
          return;
        }
        // completa estúdio que faltava
        if (conversa.passo === 'faltaEstudio') {
          const v = validarEstudio(textoOriginal);
          if (!v) { await sendMessage(chatId, "⚠️ Estúdio inválido. A, B, C, D, AB, 1, 2 ou 3. Tente de novo:"); return; }
          for (const r of conversa.reservas) { r.estudio = v.estudio; r.calId = v.calId; r.unidade = v.unidade; }
          await avancarAgendamentoRapido(chatId, conversa);
          return;
        }

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
          if (conversa.reservas.length < conversa.qtd) {
            const proxima = conversa.reservas.length + 1;
            conversa.passo = 'data';
            await sendMessage(chatId, `📅 Data ${proxima} de ${conversa.qtd}: qual a *data*? (ex: 25/07)`);
            return;
          }
          conversa.passo = 'nome';
          await sendMessage(chatId, "👤 Qual o *nome* do cliente?");
          return;
        }

        if (conversa.passo === 'nome') {
          if (!textoOriginal || textoOriginal.length < 2) { await sendMessage(chatId, "⚠️ Escreva o nome do cliente:"); return; }
          d.nome = textoOriginal;
          let conhecido = await buscarTelefoneConhecido(textoOriginal);
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
            await sendMessage(chatId, "💰 É *pré-reserva*, já foi *pago* ou é pra *não cobrar*?\n\nEscreva 'pré', 'pago', 'não cobrar' ou 'confirmar'");
            return;
          }
          const num = textoOriginal.replace(/\D/g, "");
          if (num.length < 10) { await sendMessage(chatId, "⚠️ Responda *SIM* para usar o telefone sugerido, ou digite o telefone correto (com DDD):"); return; }
          d.telefone = num;
          delete d._telefoneSugerido;
          conversa.passo = 'pagamento';
          await sendMessage(chatId, "💰 É *pré-reserva*, já foi *pago* ou é pra *não cobrar*?\n\nEscreva 'pré', 'pago', 'não cobrar' ou 'confirmar'");
          return;
        }

        if (conversa.passo === 'telefone') {
          const num = textoOriginal.replace(/\D/g, "");
          if (num.length < 10) { await sendMessage(chatId, "⚠️ Telefone inválido. Digite com DDD (ex: 11999998888):"); return; }
          d.telefone = num;
          conversa.passo = 'pagamento';
          await sendMessage(chatId, "💰 É *pré-reserva*, já foi *pago* ou é pra *não cobrar*?\n\nEscreva 'pré', 'pago', 'não cobrar' ou 'confirmar'");
          return;
        }

        if (conversa.passo === 'pagamento') {
          if (textoMensagem === 'pre' || textoMensagem === 'pré') {
            d.pago = null;
            d.naoCobrar = false;
            conversa.passo = 'confirmar';
            await enviarResumoAgendamento(chatId, conversa);
            return;
          }
          if (textoMensagem === 'pago') {
            conversa.passo = 'valor';
            await sendMessage(chatId, "💵 Qual o *valor pago*? (ex: 210)");
            return;
          }
          if (textoMensagem === 'nao cobrar' || textoMensagem === 'não cobrar' || textoMensagem === 'naocobrar' || textoMensagem === 'nao' || textoMensagem === 'não' || textoMensagem === 'zm') {
            d.pago = null;
            d.naoCobrar = true;
            d.confirmarPresenca = false;
            conversa.passo = 'confirmar';
            await enviarResumoAgendamento(chatId, conversa);
            return;
          }
          if (textoMensagem === 'confirmar' || textoMensagem === 'confirma' || textoMensagem === 'presenca' || textoMensagem === 'presença' || textoMensagem === 'zm2') {
            d.pago = null;
            d.naoCobrar = false;
            d.confirmarPresenca = true;
            conversa.passo = 'confirmar';
            await enviarResumoAgendamento(chatId, conversa);
            return;
          }
          await sendMessage(chatId, "⚠️ Escreva 'pré', 'pago', 'não cobrar' ou 'confirmar':");
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
            let pagoFinal = d.pago;
            if (pagoFinal) {
              const minimoTotal = conversa.reservas.length * 50;
              if (parseFloat(pagoFinal) < minimoTotal) {
                pagoFinal = String(minimoTotal);
                await sendMessage(chatId, `ℹ️ O valor informado é menor que o mínimo (R$50/dia). Ajustei para R$${minimoTotal} (${conversa.reservas.length} dia(s)).`);
              }
            }
            const titulos = [];
            try {
              for (const r of conversa.reservas) {
                const titulo = await criarEvento({ ...r, nome: d.nome, telefone: d.telefone, pago: pagoFinal, naoCobrar: d.naoCobrar, confirmarPresenca: d.confirmarPresenca });
                titulos.push(titulo);
              }
              const lista = titulos.map(t => `📌 ${t}`).join("\n");
              const statusTxt = pagoFinal ? `\n💰 pago R$${pagoFinal} (total)` : (d.naoCobrar ? "\n🔕 não cobrar (marcado zm)" : (d.confirmarPresenca ? "\n✋ confirmar presença (não cobra sinal)" : "\n🔖 pré-reserva"));
              await sendMessage(chatId, `✅ *Agendado com sucesso!* (${titulos.length} data${titulos.length > 1 ? "s" : ""})\n${lista}\n👤 ${d.nome} · ${d.telefone}${statusTxt}\n\n👇 Abaixo, a mensagem pronta para encaminhar ao cliente:`);
              await esperar(1500);
              const msgCliente = montarMensagemParaClienteMulti(d, conversa.reservas, pagoFinal);
              await enviarTextoELink(chatId, msgCliente, d.telefone);
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

    if (!podeAgendar(chatId)) {
      await sendMessage(chatId, "Este bot é de uso interno da equipe ZM Photo.");
      return;
    }

    if (!botAtivo) return;

    const resposta = await gerarRespostaGemini(chatId, message.text, nomeUsuario);
    await sendMessage(chatId, resposta);
  } catch (e) { console.error(e); }
});

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
