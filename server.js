const express = require('express');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const SUPABASE_URL = "https://rlsjdmuufarfkjmyfanl.supabase.co";
const SUPABASE_KEY = "sb_publishable_O2NXNhKiw5ism295beG6aA_-UNynzkG";
const GEMINI_API_KEY = "AQ.Ab8RN6KMlcP7FNhYBlIQ_MuD9FjSyV7x8RM57HaVRSxpkmBPig";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock = null, lastQrDataUrl = null, connectionStatus = "Desconectado - Gerando QR Code...", ultimoNumeroConectado = null;

// CÉREBRO DA IA (RESPONDE QUALQUER PERGUNTA OU REGISTRA GASTOS)
async function processarIA(texto, audioBase64 = null) {
  try {
    const { data: veics } = await supabase.from('veiculos').select('nome, placa');
    const frota = (veics || []).map(v => `${v.nome} (${v.placa || 'S/P'})`).join(', ');

    const prompt = `Você é o ASSISTENTE ER da ER GUINDASTES. Frota: ${frota}.
Hoje: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.
MENSAGEM: "${texto}".
1. SE FOR PERGUNTA, CONVERSA OU CONTA (ex: "quanto é 25x4", "que dia é hoje", "olá"): RESPONDA DIRETAMENTE a pergunta com inteligência e clareza!
2. SE FOR GASTO/DIESEL/MERCADO: escreva na primeira linha "[GASTO: valor | categoria | ambiente | descricao]" e na linha seguinte confirme com emoji.
3. SE FOR MANUTENÇÃO: escreva na primeira linha "[MANUTENCAO: valor | ambiente | descricao]" e confirme na linha seguinte.
4. SE FOR LEMBRETE: escreva "[LEMBRETE: tarefa | ISO_DATA_HORA]" e confirme o horário.`;

    const parts = [{ text: prompt }];
    if (audioBase64) parts.unshift({ inline_data: { mime_type: "audio/ogg", data: audioBase64 } });

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ parts }] })
    });

    const json = await res.json();
    if (json.error) return `Olá! Tive uma falha no Google: ${json.error.message}`;

    let resp = json.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (!resp) return "Olá! Como posso te ajudar na ER Guindastes?";

    if (resp.includes('[GASTO:')) {
      const m = resp.match(/\[GASTO:\s*([\d\.]+)\s*\|\s*([^\|]+)\s*\|\s*([^\|]+)\s*\|\s*([^\]]+)\]/);
      if (m) await supabase.from('gastos').insert({ valor: parseFloat(m[1]), categoria: m[2].trim(), ambiente: m[3].trim(), descricao: m[4].trim(), data: new Date().toISOString().slice(0, 10) });
      resp = resp.replace(/\[GASTO:[^\]]+\]/, '').trim();
    } else if (resp.includes('[MANUTENCAO:')) {
      const m = resp.match(/\[MANUTENCAO:\s*([\d\.]+)\s*\|\s*([^\|]+)\s*\|\s*([^\]]+)\]/);
      if (m) await supabase.from('manutencoes').insert({ valor: parseFloat(m[1]), ambiente: m[2].trim(), descricao_servico: m[3].trim(), data_manutencao: new Date().toISOString().slice(0, 10) });
      resp = resp.replace(/\[MANUTENCAO:[^\]]+\]/, '').trim();
    } else if (resp.includes('[LEMBRETE:')) {
      const m = resp.match(/\[LEMBRETE:\s*([^\|]+)\s*\|\s*([^\]]+)\]/);
      if (m) await supabase.from('lembretes').insert({ descricao: m[1].trim(), data_hora: new Date(m[2].trim()).toISOString(), status: 'pendente', telefone_destino: ultimoNumeroConectado });
      resp = resp.replace(/\[LEMBRETE:[^\]]+\]/, '').trim();
    }
    return resp;
  } catch (err) {
    return "Olá! Tive uma falha temporária. Pode repetir?";
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
      } else if (connection === 'open') { connectionStatus = "CONECTADO COM SUCESSO!"; lastQrDataUrl = null; }
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

// ROTAS HTTP
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', servico: 'ASSISTENTE ER', whatsapp: connectionStatus }));
app.get('/qrcode', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QR Code</title><script src="https://cdn.tailwindcss.com"></script><meta http-equiv="refresh" content="5"></head><body class="bg-slate-50 min-h-screen flex items-center justify-center p-4"><div class="bg-white border rounded-3xl p-8 max-w-sm w-full text-center shadow-sm space-y-4"><h1 class="text-xl font-bold">ASSISTENTE ER</h1><div class="p-3 bg-slate-50 border rounded-2xl text-xs font-semibold text-blue-600">${connectionStatus}</div>${lastQrDataUrl ? `<img src="${lastQrDataUrl}" class="w-64 h-64 mx-auto rounded-xl border p-2" />` : '<p class="text-xs text-slate-400 py-8">Carregando QR Code ou já conectado...</p>'}</div></body></html>`);
});
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.listen(PORT, () => console.log(`[ASSISTENTE ER] Rodando na porta ${PORT}`));
