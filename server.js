const express = require('express');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ================= CONFIGURAÇÕES SUPABASE E IA =================
const SUPABASE_URL = "https://rlsjdmuufarfkjmyfanl.supabase.co";
const SUPABASE_KEY = "sb_publishable_O2NXNhKiw5ism295beG6aA_-UNynzkG";
const GEMINI_API_KEY = "AQ.Ab8RN6LL-_R41LrDa-E1WOik2_7oxrHumDnqbeEMFqfc78aNWQ";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Variáveis de Estado do WhatsApp
let sock = null;
let lastQrDataUrl = null;
let connectionStatus = "Desconectado - Gerando QR Code...";

// ================= 1. INICIALIZAR BAILEYS WHATSAPP =================
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['ER GESTÃO', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQrDataUrl = await qrcode.toDataURL(qr);
        connectionStatus = "Aguardando leitura do QR Code...";
        console.log("[WhatsApp] Novo QR Code gerado!");
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = "Desconectado. Tentando reconectar...";
        lastQrDataUrl = null;

        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000);
        }
      } else if (connection === 'open') {
        connectionStatus = "CONECTADO COM SUCESSO!";
        lastQrDataUrl = null;
        console.log("[WhatsApp] Conexão estabelecida com sucesso!");
      }
    });

    // ================= 2. PROCESSAMENTO DE MENSAGENS E IA =================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const from = msg.key.remoteJid;
        const texto = msg.message.conversation || 
                      msg.message.extendedTextMessage?.text || 
                      msg.message.imageMessage?.caption || "";

        if (!texto.trim()) continue;

        console.log(`[WhatsApp] Mensagem recebida de ${from}: ${texto}`);

        // Interpreta com a Inteligência Artificial do Google Gemini
        try {
          const resultadoIA = await interpretarComIA(texto);

          if (resultadoIA && resultadoIA.sucesso) {
            // Grava no Supabase (Gastos ou Manutenção)
            if (resultadoIA.tipo === 'manutencao') {
              await supabase.from('manutencoes').insert({
                ambiente: resultadoIA.ambiente || 'empresa',
                descricao_servico: resultadoIA.descricao,
                valor: resultadoIA.valor || 0,
                data_manutencao: resultadoIA.data || new Date().toISOString().slice(0, 10),
                km_horimetro: resultadoIA.km_horimetro || 0,
                oficina_fornecedor: resultadoIA.fornecedor || null
              });
            } else {
              await supabase.from('gastos').insert({
                ambiente: resultadoIA.ambiente || 'empresa',
                descricao: resultadoIA.descricao,
                valor: resultadoIA.valor || 0,
                data: resultadoIA.data || new Date().toISOString().slice(0, 10),
                categoria: resultadoIA.categoria || 'Outros',
                fornecedor: resultadoIA.fornecedor || null,
                forma_pagamento: resultadoIA.forma_pagamento || 'Pix'
              });
            }

            // Responde no WhatsApp confirmando
            const msgConfirmacao = `✅ *Registrado no ER GESTÃO!*\n\n` +
              `📝 *Descrição:* ${resultadoIA.descricao}\n` +
              `💰 *Valor:* R$ ${Number(resultadoIA.valor).toFixed(2)}\n` +
              `🏷 *Categoria:* ${resultadoIA.categoria || 'Geral'}\n` +
              `🚜 *Ambiente:* ${resultadoIA.ambiente === 'pessoa_fisica' ? 'PESSOA FÍSICA' : 'EMPRESA (ER GUINDASTES)'}`;

            await sock.sendMessage(from, { text: msgConfirmacao });

          } else {
            await sock.sendMessage(from, { 
              text: `⚠️ *Não entendi completamente o lançamento.*\n\nPor favor, informe a descrição e o valor. Exemplo:\n_"Abasteci R$ 400 no Munck"_` 
            });
          }
        } catch (err) {
          console.error("[Erro ao processar mensagem]", err);
        }
      }
    });

  } catch (error) {
    console.error("[Erro Baileys]", error);
  }
}

// Inicia o Baileys
connectToWhatsApp();

// ================= 3. FUNÇÃO DE IA (GEMINI) =================
async function interpretarComIA(textoUsuario) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  const prompt = `
Você é o assistente de cadastros do ER GESTÃO (ER Guindastes).
Extraia os dados financeiros da mensagem: "${textoUsuario}".

Retorne EXCLUSIVAMENTE um JSON sem markdown:
{
  "sucesso": true,
  "tipo": "gasto" ou "manutencao",
  "descricao": "resumo do gasto ou serviço",
  "valor": 0.00,
  "categoria": "Combustível" ou "Manutenção" ou "Peças" ou "Contas" ou "Alimentação" ou "Outros",
  "fornecedor": "nome do local ou null",
  "forma_pagamento": "Pix" ou "Dinheiro" ou "Boleto" ou "Cartão",
  "km_horimetro": 0,
  "ambiente": "empresa" ou "pessoa_fisica"
}
`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });

  const data = await response.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const clean = raw.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(clean);
}

// ================= 4. ROTAS DO SERVIDOR =================

// Endpoint de Saúde para o UptimeRobot (Nunca deixar o servidor dormir)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    servico: 'ER GESTAO + WhatsApp Baileys',
    whatsapp: connectionStatus,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime())
  });
});

// PÁGINA VISUAL PARA ESCANEAR O QR CODE DO WHATSAPP
app.get('/qrcode', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Conectar WhatsApp - ER GESTÃO</title>
      <script src="https://cdn.tailwindcss.com"></script>
      <meta http-equiv="refresh" content="5">
    </head>
    <body class="bg-slate-50 min-h-screen flex items-center justify-center p-4">
      <div class="bg-white border border-slate-200 rounded-3xl p-8 max-w-sm w-full text-center shadow-sm space-y-4">
        <h1 class="text-xl font-bold text-slate-900">ER GESTÃO</h1>
        <p class="text-xs uppercase tracking-wider text-emerald-600 font-semibold">Conexão WhatsApp</p>
        
        <div class="p-3 rounded-2xl bg-slate-50 border border-slate-200 text-xs font-medium text-slate-700">
          Status: <span class="font-bold text-blue-600">${connectionStatus}</span>
        </div>

        ${lastQrDataUrl ? `
          <div class="flex justify-center p-2 bg-white rounded-2xl border border-slate-200">
            <img src="${lastQrDataUrl}" alt="QR Code WhatsApp" class="w-64 h-64 rounded-xl" />
          </div>
          <p class="text-[11px] text-slate-500">Abra o WhatsApp no celular > Aparelhos conectados > Conectar um aparelho e aponte para a tela.</p>
        ` : `
          <div class="py-8 space-y-2">
            <div class="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
            <p class="text-xs text-slate-500">Carregando QR Code ou já conectado...</p>
          </div>
        `}
        <div class="text-[10px] text-slate-400">Esta tela atualiza automaticamente a cada 5 segundos.</div>
      </div>
    </body>
    </html>
  `);
});

// Servir o Frontend existente do ER GESTÃO
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Inicia servidor Express
app.listen(PORT, () => {
  console.log(`[ER GESTAO] Servidor rodando na porta ${PORT}`);
});
