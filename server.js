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

// ================= CÉREBRO CONVERSACIONAL INTELIGENTE =================
async function processarIA(texto, audioBase64 = null) {
  try {
    const { data: veics } = await supabase.from('veiculos').select('nome, placa');
    const frota = (veics || []).map(v => `${v.nome} (${v.placa || 'S/P'})`).join(', ');

    const promptSistema = `
Você é o ASSISTENTE ER, assistente executivo e operacional inteligente da ER GUINDASTES.
Frota cadastrada no sistema: ${frota || 'Munck, Scania, Guindastes, Hilux'}.
Data e hora de hoje: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.

REGRAS DE RESPOSTA:
1. SE O USUÁRIO FIZER PERGUNTAS, CÁLCULOS, DÚVIDAS OU CONVERSA (Ex: "quanto é 25 x 4", "que dia é hoje", "olá", "como funciona"):
   -> RESPONDA DIRETAMENTE como uma pessoa inteligente, simpática e prestativa! Sem códigos.

2. SE FOR REGISTRO DE GASTO OU COMBUSTÍVEL (Ex: "abasteci 300 de diesel no scania", "gastei 50 no almoço"):
   -> Inclua no início da resposta a tag oculta [REGISTRAR_GASTO: valor | categoria | ambiente | descricao]
   Exemplo: [REGISTRAR_GASTO: 300.00 | Combustível | empresa | Abastecimento Scania]
   E na linha de baixo escreva a confirmação educada para o usuário.

3. SE FOR MANUTENÇÃO (Ex: "troquei o óleo 400 reais"):
   -> Inclua no início [REGISTRAR_MANUTENCAO: valor | empresa | descricao]
   E na linha de baixo escreva a confirmação.

4. SE FOR LEMBRETE (Ex: "me lembra amanhã às 8h de ligar..."):
   -> Inclua no início [REGISTRAR_LEMBRETE: tarefa | ISO_DATA_HORA]
   E na linha de baixo confirme que vai avisar no horário.
`;

    const parts = [
      { text: promptSistema },
      { text: `Mensagem recebida: "${texto}"` }
    ];

    if (audioBase64) {
      parts.push({ inline_data: { mime_type: "audio/ogg", data: audioBase64 } });
      parts.push({ text: "Transcreva o áudio acima e responda de acordo com as regras." });
    }

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body: JSON.stringify({ contents: [{ parts }] })
    });

    const json = await res.json();

    if (json.error) {
      console.error("[Erro Google API]", json.error);
      return `Olá! Recebi sua mensagem, mas ocorreu uma falha de conexão com a IA do Google: ${json.error.message}`;
    }

    let respostaTexto = json.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!respostaTexto.trim()) {
      return "Olá! Como posso te ajudar com os veículos ou despesas da ER Guindastes?";
    }

    // 1. Processa Ação de Gasto
    if (respostaTexto.includes('[REGISTRAR_GASTO:')) {
      const match = respostaTexto.match(/\[REGISTRAR_GASTO:\s*([\d\.]+)\s*\|\s*([^\|]+)\s*\|\s*([^\|]+)\s*\|\s*([^\]]+)\]/);
      if (match) {
        const [, valor, cat, amb, desc] = match;
        await supabase.from('gastos').insert({
          ambiente: amb.trim() || 'empresa',
          descricao: desc.trim(),
          valor: parseFloat(valor || 0),
          categoria: cat.trim() || 'Outros',
          data: new Date().toISOString().slice(0, 10),
          forma_pagamento: 'Pix'
        });
      }
      respostaTexto = respostaTexto.replace(/\[REGISTRAR_GASTO:[^\]]+\]/, '').trim();
    }

    // 2. Processa Ação de Manutenção
    else if (respostaTexto.includes('[REGISTRAR_MANUTENCAO:')) {
      const match = respostaTexto.match(/\[REGISTRAR_MANUTENCAO:\s*([\d\.]+)\s*\|\s*([^\|]+)\s*\|\s*([^\]]+)\]/);
      if (match) {
        const [, valor, amb, desc] = match;
        await supabase.from('manutencoes').insert({
          ambiente: amb.trim() || 'empresa',
          descricao_servico: desc.trim(),
          valor: parseFloat(valor || 0),
          data_manutencao: new Date().toISOString().slice(0, 10)
        });
      }
      respostaTexto = respostaTexto.replace(/\[REGISTRAR_MANUTENCAO:[^\]]+\]/, '').trim();
    }

    // 3. Processa Ação de Lembrete
    else if (respostaTexto.includes('[REGISTRAR_LEMBRETE:')) {
      const match = respostaTexto.match(/\[REGISTRAR_LEMBRETE:\s*([^\|]+)\s*\|\s*([^\]]+)\]/);
      if (match) {
        const [, desc, iso] = match;
        const dataAlvo = new Date(iso.trim());
        await supabase.from('lembretes').insert({
          descricao: desc.trim(),
          data_hora: isNaN(dataAlvo) ? new Date(Date.now() + 3600000).toISOString() : dataAlvo.toISOString(),
          status: 'pendente',
          telefone_destino: ultimoNumeroConectado
        });
      }
      respostaTexto = respostaTexto.replace(/\[REGISTRAR_LEMBRETE:[^\]]+\]/, '').trim();
    }

    return respostaTexto;

  } catch (err) {
    console.error("[Erro Interno]", err);
    return "Olá! Tive um problema temporário para processar sua mensagem. Pode repetir?";
  }
}

// DISPARADOR DE LEMBRETES NO WHATSAPP (A CADA 30 SEGUNDOS)
setInterval(async () => {
  if (!sock || connectionStatus !== "CONECTADO COM SUCESSO!") return;
  try {
    const agora = new Date().toISOString();
    const { data: pendentes } = await supabase
      .from('lembretes')
      .select('*')
      .eq('status', 'pendente')
      .lte('data_hora', agora)
      .limit(5);

    if (pendentes && pendentes.length > 0) {
      for (const l of pendentes) {
        const dest = l.telefone_destino || ultimoNumeroConectado;
        if (dest) {
          await sock.sendMessage(dest, { 
            text: `🔔 *LEMBRETE DO ASSISTENTE ER!*\n\n📌 *Compromisso:* ${l.descricao}\n⏰ *Horário:* ${new Date(l.data_hora).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` 
          });
          await supabase.from('lembretes').update({ status: 'notificado' }).eq('id', l.id);
        }
      }
    }
  } catch (e) {}
}, 30000);

// CONEXÃO BAILEYS WHATSAPP
async function initWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info');
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, logger: pino({ level: 'silent' }), printQRInTerminal: false, auth: state, browser: ['ASSISTENTE ER', 'Chrome', '1.0'] });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) { 
        lastQrDataUrl = await qrcode.toDataURL(qr); 
        connectionStatus = "Aguardando leitura do QR Code..."; 
      }
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
          try { 
            const b = await downloadMediaMessage(msg, 'buffer', {}); 
            audio = b.toString('base64'); 
          } catch (e) {}
        }

        if (texto.trim() || audio) {
          const resp = await processarIA(texto, audio);
          await sock.sendMessage(from, { text: resp });
        }
      }
    });
  } catch (e) {
    console.error("[Erro Baileys]", e);
  }
}
initWhatsApp();

// ROTAS DO SERVIDOR
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', servico: 'ASSISTENTE ER', whatsapp: connectionStatus }));
app.get('/qrcode', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>QR Code</title><script src="https://cdn.tailwindcss.com"></script><meta http-equiv
