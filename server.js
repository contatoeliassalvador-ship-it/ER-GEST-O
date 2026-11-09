const express = require('express');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// CREDENCIAIS
const SUPABASE_URL = "https://rlsjdmuufarfkjmyfanl.supabase.co";
const SUPABASE_KEY = "sb_publishable_O2NXNhKiw5ism295beG6aA_-UNynzkG";
const GEMINI_API_KEY = "AQ.Ab8RN6KMlcP7FNhYBlIQ_MuD9FjSyV7x8RM57HaVRSxpkmBPig";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock = null;
let lastQrDataUrl = null;
let connectionStatus = "Desconectado - Gerando QR Code...";
let ultimoNumeroConectado = null;

// CÉREBRO DA IA (GEMINI 1.5 FLASH)
async function processarIA(texto, audioBase64 = null) {
  try {
    const { data: veics } = await supabase.from('veiculos').select('nome, placa');
    const frota = (veics || []).map(v => `${v.nome} (${v.placa || 'S/P'})`).join(', ');

    const prompt = `Você é o ASSISTENTE ER da ER GUINDASTES. Frota: ${frota}.
Hoje: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.
MENSAGEM: "${texto}".
Se for gasto/diesel/manutenção/mercado, retorne JSON: {"acao":"gasto"|"manutencao", "desc":"resumo", "valor":0.00, "cat":"Combustível"|"Manutenção"|"Supermercado"|"Outros", "amb":"empresa"|"pessoa_fisica", "resp":"texto confirmação com emoji"}
Se for lembrete ("me lembra amanhã às 8h"): {"acao":"lembrete", "desc":"tarefa", "iso":"AAAA-MM-DDTHH:mm:ssZ", "resp":"texto amigável confirmando o horário"}
Se for pergunta/conversa: {"acao":"conversa", "resp":"resposta inteligente, direta e simpática"}`;

    const parts = [{ text: prompt }];
    if (audioBase64) parts.unshift({ inline_data: { mime_type: "audio/ogg", data: audioBase64 } });

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts }] })
    });

    const json = await res.json();
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (parsed.acao === 'gasto') {
      await supabase.from('gastos').insert({ ambiente: parsed.amb || 'empresa', descricao: parsed.desc, valor: parseFloat(parsed.valor || 0), categoria: parsed.cat || 'Outros', data: new Date().toISOString().slice(0, 10) });
    } else if (parsed.acao === 'manutencao') {
      await supabase.from('manutencoes').insert({ ambiente: parsed.amb || 'empresa', descricao_servico: parsed.desc, valor: parseFloat(parsed.valor || 0), data_manutencao: new Date().toISOString().slice(0, 10) });
    } else if (parsed.acao === 'lembrete') {
      await supabase.from('lembretes').insert({ descricao: parsed.desc, data_hora: parsed.iso || new Date(Date.now() + 3600000).toISOString(), status: 'pendente', telefone_destino: ultimoNumeroConectado });
    }

    return parsed.resp || "Entendido! Lançamento processado no ER GESTÃO.";
  } catch (err) {
    return "Olá! Sou o Assistente ER. Como posso te ajudar com os registros da ER Guindastes?";
  }
}

// DISPARADOR DE LEMBRETES NO WHATSAPP
setInterval(async () => {
  if (!sock || connectionStatus !== "CONECTADO COM SUCESSO!") return;
  try {
    const { data: pendentes } = await supabase.from('lembretes').select('*').eq('status', 'pendente').lte('data_hora', new Date().toISOString()).limit(5);
    for (const l of (pendentes || [])) {
      const dest = l.telefone_destino || ultimoNumeroConectado;
      if (dest) {
        await sock.sendMessage(dest, { text: `🔔 *LEMBRETE DO ASSISTENTE ER!*\n\n📌 *Compromisso:* ${l.descricao}` });
        await supabase.from('lembretes').update({ status: 'notificado' }).eq('id', l.id);
      }
    }
  } catch (e) {}
}, 30000);

// BAILEYS WHATSAPP
async function initWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info');
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, logger: pino({ level: 'silent' }), printQRInTerminal: false, auth: state, browser: ['ASSISTENTE ER', 'Chrome', '1.0'] });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) { lastQrDataUrl = await qrcode.toDataURL(qr); connectionStatus = "Aguardando leitura do QR Code..."; }
      if (connection === 'close') {
        connectionStatus = "Desconectado. Reconectando...";
        lastQrDataUrl = null;
        if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) setTimeout(initWhatsApp, 5000);
      } else if (connection === 'open') {
        connectionStatus = "CONECTADO COM SUCESSO!";
        lastQrDataUrl = null;
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const from = msg.key.remoteJid;
        ultimoNumeroConectado = from;
        const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
        let audio = null;
        if (msg.message.audioMessage) {
          try { const b = await downloadMediaMessage(msg, 'buffer', {}); audio = b.toString('base64'); } catch (e) {}
        }
        if (texto.trim() || audio) {
          const resp = await processarIA(texto, audio);
          await sock.sendMessage(from, { text: resp });
        }
      }
    });
  } catch (e) {}
}
initWhatsApp();

// ROTAS DO SERVIDOR
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', servico: 'ASSISTENTE ER', whatsapp: connectionStatus }));
app.get('/qrcode', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QR Code</title><script src="https://cdn.tailwindcss.com"></script><meta http-equiv="refresh" content="5"></head><body class="bg-slate-50 min-h-screen flex items-center justify-center p-4"><div class="bg-white border rounded-3xl p-8 max-w-sm w-full text-center shadow-sm space-y-4"><h1 class="text-xl font-bold">ASSISTENTE ER</h1><div class="p-3 bg-slate-50 border rounded-2xl text-xs font-semibold text-blue-600">${connectionStatus}</div>${lastQrDataUrl ? `<img src="${lastQrDataUrl}" class="w-64 h-64 mx-auto rounded-xl border p-2" />` : '<p class="text-xs text-slate-400 py-8">Carregando QR Code ou já conectado...</p>'}</div></body></html>`);
});
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`[ASSISTENTE ER] Rodando na porta ${PORT}`));
