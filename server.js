const express = require('express');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode');
const { createClient } = require('@supabase/supabase-js');
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  fetchLatestBaileysVersion,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ================= CREDENCIAIS DO SISTEMA =================
const SUPABASE_URL = "https://rlsjdmuufarfkjmyfanl.supabase.co";
const SUPABASE_KEY = "sb_publishable_O2NXNhKiw5ism295beG6aA_-UNynzkG";
const GEMINI_API_KEY = "AQ.Ab8RN6LL-_R41LrDa-E1WOik2_7oxrHumDnqbeEMFqfc78aNWQ";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let sock = null;
let lastQrDataUrl = null;
let connectionStatus = "Desconectado - Gerando QR Code...";
let ultimoNumeroConectado = null;

// ================= NORMALIZADOR DE PLACAS E VEÍCULOS =================
function normalizarPlaca(texto) {
  if (!texto) return "";
  return texto.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function cruzarVeiculoInteligente(termo) {
  if (!termo) return null;
  const termoLimpo = normalizarPlaca(termo);
  const { data: veiculos } = await supabase.from('veiculos').select('*');
  if (!veiculos || veiculos.length === 0) return null;

  // 1. Busca por placa limpa exata (ex: RVC1H35)
  const porPlaca = veiculos.find(v => normalizarPlaca(v.placa) === termoLimpo);
  if (porPlaca) return porPlaca;

  // 2. Busca por apelido, nome ou modelo (ex: "munck", "scania", "70t")
  const t = termo.toLowerCase();
  return veiculos.find(v => 
    v.nome.toLowerCase().includes(t) || 
    (v.modelo && v.modelo.toLowerCase().includes(t)) ||
    (v.marca && v.marca.toLowerCase().includes(t)) ||
    (v.tipo && v.tipo.toLowerCase().includes(t))
  ) || null;
}

// ================= FERRAMENTAS EXECUTORAS DO ASSISTENTE ER =================
const FERRAMENTAS = {
  // 1. Criar Lembrete Ativo (Dispara no WhatsApp na hora certa)
  async criar_lembrete({ descricao, data_hora_iso, ambiente = 'empresa', telefone }) {
    const dataAlvo = data_hora_iso ? new Date(data_hora_iso) : new Date(Date.now() + 60 * 60 * 1000);

    await supabase.from('lembretes').insert({
      ambiente,
      descricao,
      data_hora: dataAlvo.toISOString(),
      status: 'pendente',
      telefone_destino: telefone || ultimoNumeroConectado
    });

    const horarioBR = dataAlvo.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    return `⏰ *Lembrete agendado com sucesso!*\n\n` +
      `📌 *Compromisso:* ${descricao}\n` +
      `📅 *Quando:* ${horarioBR}\n` +
      `_Pode deixar comigo, vou te mandar mensagem aqui no WhatsApp exatamente no horário!_`;
  },

  // 2. Listar Lembretes
  async listar_lembretes() {
    const { data } = await supabase
      .from('lembretes')
      .select('descricao, data_hora')
      .eq('status', 'pendente')
      .order('data_hora', { ascending: true })
      .limit(5);

    if (!data || data.length === 0) return "Você não tem nenhum lembrete pendente no momento!";

    const lista = data.map(l => {
      const dt = new Date(l.data_hora).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      return `• ${dt}: ${l.descricao}`;
    }).join("\n");

    return `📋 *Seus Próximos Lembretes:*\n\n${lista}`;
  },

  // 3. Registrar Abastecimento
  async registrar_abastecimento({ veiculo_termo, valor, litros, km_horimetro, posto, ambiente }) {
    const veiculo = await cruzarVeiculoInteligente(veiculo_termo);
    const amb = ambiente || (veiculo?.ambiente) || 'empresa';
    const desc = `Abastecimento ${litros ? litros + 'L ' : ''}${veiculo ? '- ' + veiculo.nome : ''}`.trim();

    await supabase.from('gastos').insert({
      ambiente: amb,
      descricao: desc,
      valor: parseFloat(valor),
      categoria: 'Combustível',
      data: new Date().toISOString().slice(0, 10),
      veiculo_id: veiculo ? veiculo.id : null,
      fornecedor: posto || null,
      forma_pagamento: 'Pix'
    });

    await supabase.from('abastecimentos').insert({
      ambiente: amb,
      veiculo_id: veiculo ? veiculo.id : null,
      valor_total: parseFloat(valor),
      litros: litros ? parseFloat(litros) : null,
      km_horimetro: km_horimetro ? parseFloat(km_horimetro) : null,
      posto_fornecedor: posto || null,
      data: new Date().toISOString().slice(0, 10)
    });

    if (veiculo && km_horimetro && parseFloat(km_horimetro) > 0) {
      await supabase.from('veiculos').update({ km_horimetro_atual: parseFloat(km_horimetro) }).eq('id', veiculo.id);
    }

    return `⛽ *Abastecimento registrado com sucesso!*\n\n` +
      `• *Veículo:* ${veiculo ? veiculo.nome + ' (' + (veiculo.placa || 'S/P') + ')' : 'Geral'}\n` +
      `• *Valor:* R$ ${parseFloat(valor).toFixed(2)}\n` +
      (litros ? `• *Litros:* ${litros}L\n` : '') +
      (km_horimetro ? `• *KM/Horímetro atualizado:* ${km_horimetro}\n` : '') +
      `• *Ambiente:* ${amb === 'empresa' ? 'EMPRESA (ER GUINDASTES)' : 'PESSOA FÍSICA'}`;
  },

  // 4. Registrar Manutenção
  async registrar_manutencao({ veiculo_termo, servico, valor, oficina, km_horimetro, ambiente }) {
    const veiculo = await cruzarVeiculoInteligente(veiculo_termo);
    const amb = ambiente || (veiculo?.ambiente) || 'empresa';

    await supabase.from('manutencoes').insert({
      ambiente: amb,
      veiculo_id: veiculo ? veiculo.id : null,
      descricao_servico: servico,
      valor: parseFloat(valor || 0),
      oficina_fornecedor: oficina || null,
      km_horimetro: km_horimetro ? parseFloat(km_horimetro) : (veiculo?.km_horimetro_atual || 0),
      data_manutencao: new Date().toISOString().slice(0, 10)
    });

    return `🔧 *Manutenção registrada com sucesso!*\n\n` +
      `• *Veículo:* ${veiculo ? veiculo.nome + ' (' + (veiculo.placa || 'S/P') + ')' : 'Geral'}\n` +
      `• *Serviço:* ${servico}\n` +
      `• *Valor:* R$ ${parseFloat(valor || 0).toFixed(2)}\n` +
      (oficina ? `• *Oficina:* ${oficina}\n` : '') +
      `• *Ambiente:* ${amb === 'empresa' ? 'EMPRESA' : 'PESSOA FÍSICA'}`;
  },

  // 5. Registrar Despesa Geral (Mercado, Restaurante, Loja, Contas)
  async registrar_despesa({ descricao, valor, categoria, fornecedor, ambiente }) {
    const amb = ambiente || 'pessoa_fisica';

    await supabase.from('gastos').insert({
      ambiente: amb,
      descricao,
      valor: parseFloat(valor),
      categoria: categoria || 'Outros',
      fornecedor: fornecedor || null,
      data: new Date().toISOString().slice(0, 10),
      forma_pagamento: 'Pix'
    });

    return `✅ *Lançamento realizado no ER GESTÃO!*\n\n` +
      `• *Descrição:* ${descricao}\n` +
      `• *Valor:* R$ ${parseFloat(valor).toFixed(2)}\n` +
      `• *Tópico:* ${categoria || 'Geral'}\n` +
      `• *Ambiente:* ${amb === 'pessoa_fisica' ? 'PESSOA FÍSICA' : 'EMPRESA (ER GUINDASTES)'}`;
  },

  // 6. Registrar Ocorrência / Avaria
  async registrar_ocorrencia({ veiculo_termo, descricao, gravidade = 'media' }) {
    const veiculo = await cruzarVeiculoInteligente(veiculo_termo);

    await supabase.from('ocorrencias').insert({
      ambiente: 'empresa',
      veiculo_id: veiculo ? veiculo.id : null,
      descricao,
      gravidade,
      status: 'aberta',
      data_registro: new Date().toISOString().slice(0, 10)
    });

    return `🚨 *Alerta de Ocorrência registrado!*\n\n` +
      `• *Veículo:* ${veiculo ? veiculo.nome + ' (' + veiculo.placa + ')' : 'Geral'}\n` +
      `• *Problema:* ${descricao}\n` +
      `• *Gravidade:* ${gravidade.toUpperCase()}`;
  },

  // 7. Consultar Custos e Gastos
  async consultar_custos({ dias = 30, ambiente = 'empresa' }) {
    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - parseInt(dias));

    const { data: gastos } = await supabase
      .from('gastos')
      .select('valor, descricao, categoria, data')
      .eq('ambiente', ambiente)
      .gte('data', dataLimite.toISOString().slice(0, 10));

    if (!gastos || gastos.length === 0) {
      return `Não encontrei nenhum gasto nos últimos ${dias} dias no ambiente ${ambiente.toUpperCase()}.`;
    }

    const total = gastos.reduce((acc, g) => acc + Number(g.valor), 0);
    return `📊 *Resumo Financeiro (${ambiente === 'empresa' ? 'EMPRESA' : 'PESSOA FÍSICA'}):*\n\n` +
      `• *Total gasto nos últimos ${dias} dias:* R$ ${total.toFixed(2)}\n` +
      `• *Total de lançamentos:* ${gastos.length}`;
  }
};

// ================= FERRAMENTAS GEMINI =================
const DECLARACOES_IA = [
  {
    function_declarations: [
      {
        name: "criar_lembrete",
        description: "Agenda um lembrete com alarme no WhatsApp para data ou hora futura.",
        parameters: {
          type: "OBJECT",
          required: ["descricao", "data_hora_iso"],
          properties: {
            descricao: { type: "STRING" },
            data_hora_iso: { type: "STRING" },
            ambiente: { type: "STRING", enum: ["empresa", "pessoa_fisica"] }
          }
        }
      },
      {
        name: "listar_lembretes",
        description: "Consulta os lembretes pendentes já agendados.",
        parameters: { type: "OBJECT", properties: {} }
      },
      {
        name: "registrar_abastecimento",
        description: "Registra combustível informando valor, litros, posto e veículo.",
        parameters: {
          type: "OBJECT",
          required: ["valor"],
          properties: {
            veiculo_termo: { type: "STRING" },
            valor: { type: "NUMBER" },
            litros: { type: "NUMBER" },
            km_horimetro: { type: "NUMBER" },
            posto: { type: "STRING" },
            ambiente: { type: "STRING", enum: ["empresa", "pessoa_fisica"] }
          }
        }
      },
      {
        name: "registrar_manutencao",
        description: "Registra consertos, oficina, troca de peças, pneus ou óleos.",
        parameters: {
          type: "OBJECT",
          required: ["servico", "valor"],
          properties: {
            veiculo_termo: { type: "STRING" },
            servico: { type: "STRING" },
            valor: { type: "NUMBER" },
            oficina: { type: "STRING" },
            ambiente: { type: "STRING", enum: ["empresa", "pessoa_fisica"] }
          }
        }
      },
      {
        name: "registrar_despesa",
        description: "Registra compras de mercado, restaurante, lojas, contas e despesas avulsas.",
        parameters: {
          type: "OBJECT",
          required: ["descricao", "valor"],
          properties: {
            descricao: { type: "STRING" },
            valor: { type: "NUMBER" },
            categoria: { type: "STRING", enum: ["Supermercado", "Restaurante", "Loja", "Combustível", "Contas", "Saúde", "Outros"] },
            fornecedor: { type: "STRING" },
            ambiente: { type: "STRING", enum: ["empresa", "pessoa_fisica"] }
          }
        }
      },
      {
        name: "registrar_ocorrencia",
        description: "Registra quebras, pneus furados, avarias ou problemas mecânicos que precisam de atenção.",
        parameters: {
          type: "OBJECT",
          required: ["descricao"],
          properties: {
            veiculo_termo: { type: "STRING" },
            descricao: { type: "STRING" },
            gravidade: { type: "STRING", enum: ["baixa", "media", "alta", "urgente"] }
          }
        }
      },
      {
        name: "consultar_custos",
        description: "Consulta total gasto no mês, semana ou período.",
        parameters: {
          type: "OBJECT",
          properties: {
            dias: { type: "NUMBER" },
            ambiente: { type: "STRING", enum: ["empresa", "pessoa_fisica"] }
          }
        }
      }
    ]
  }
];

// ================= CÉREBRO COMPLETO (EXECUTOR + RESPOSTAS A PERGUNTAS GERAIS) =================
async function processarMensagemAssistente(textoUsuario, telefoneRemetente, audioBase64 = null) {
  const agora = new Date();
  const agoraISO = agora.toISOString();

  const { data: veiculos } = await supabase.from('veiculos').select('nome, placa, tipo, ambiente');
  const frotaContexto = (veiculos || []).map(v => `${v.nome} (Placa: ${v.placa || 'S/P'}, Ambiente: ${v.ambiente})`).join('; ');

  const systemInstruction = `
Você é o ASSISTENTE ER, assistente executivo inteligente e parceiro de operações da ER GUINDASTES.
Horário atual de referência: ${agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} (ISO: ${agoraISO}).

FROTA CONHECIDA NO SISTEMA:
${frotaContexto || 'Munck, Guindastes, Caminhões Scania, Hilux, Carros particulares'}

SUAS DUAS FUNÇÕES PRINCIPAIS:

1. EXECUTOR ADMINISTRATIVO:
   - Se o usuário falar sobre dinheiro, compras, abastecimento, diesel, oficina, manutenções, peças ou pedir para lembrá-lo de algo:
     -> CHAME A FERRAMENTA ADEQUADA IMEDIATAMENTE para registrar no sistema.
   - Ambiente automático: guindastes/caminhões = "empresa"; compras/mercado/restaurante/farmácia = "pessoa_fisica".

2. CONSULTOR E ASSISTENTE INTELIGENTE PARA QUALQUER PERGUNTA:
   - Se o usuário fizer PERGUNTAS BÁSICAS, dúvidas do dia a dia, cálculos matemáticos (ex: "quanto é 250 x 4"), perguntas sobre trânsito, caminhões, mecânica pesada, óleos ou perguntas gerais ("que dia é hoje?", "como funciona tal coisa?"):
     -> RESPONDA DIRETAMENTE com inteligência, simpatia, clareza e objetividade!
   - Nunca diga que não entendeu se for uma pergunta comum ou curiosidade. Você tem conhecimento geral completo.
`;

  const contents = [];
  const parts = [];

  if (audioBase64) {
    parts.push({ inline_data: { mime_type: "audio/ogg", data: audioBase64 } });
    parts.push({ text: "Entenda o que eu disse neste áudio, identifique se é um comando ou uma pergunta e responda de acordo." });
  } else {
    parts.push({ text: textoUsuario });
  }

  contents.push({ role: "user", parts });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      system_instruction: { parts: [{ text: systemInstruction }] },
      tools: DECLARACOES_IA
    })
  });

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const call = candidate?.content?.parts?.find(p => p.functionCall)?.functionCall;

  if (call) {
    const nome = call.name;
    const args = call.args || {};
    args.telefone = telefoneRemetente;

    if (FERRAMENTAS[nome]) {
      return await FERRAMENTAS[nome](args);
    }
  }

  return candidate?.content?.parts?.[0]?.text || "Olá! Como posso te ajudar agora?";
}

// ================= DISPARADOR DE LEMBRETES NO WHATSAPP =================
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
        const destino = l.telefone_destino || ultimoNumeroConectado;
        if (destino) {
          const alerta = `🔔 *LEMBRETE DO ASSISTENTE ER!*\n\n` +
            `📌 *Compromisso:* ${l.descricao}\n` +
            `⏰ *Horário:* ${new Date(l.data_hora).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;

          await sock.sendMessage(destino, { text: alerta });
          await supabase.from('lembretes').update({ status: 'notificado' }).eq('id', l.id);
        }
      }
    }
  } catch (err) {
    console.error("[Erro lembretes]", err);
  }
}, 30000);

// ================= CONEXÃO BAILEYS =================
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: ['ASSISTENTE ER', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQrDataUrl = await qrcode.toDataURL(qr);
        connectionStatus = "Aguardando leitura do QR Code...";
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = "Desconectado. Reconectando...";
        lastQrDataUrl = null;
        if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
      } else if (connection === 'open') {
        connectionStatus = "CONECTADO COM SUCESSO!";
        lastQrDataUrl = null;
        console.log("[ASSISTENTE ER] WhatsApp Conectado!");
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const from = msg.key.remoteJid;
        ultimoNumeroConectado = from;

        let texto = msg.message.conversation || 
                    msg.message.extendedTextMessage?.text || 
                    msg.message.imageMessage?.caption || "";
        
        let audioBase64 = null;

        if (msg.message.audioMessage) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            audioBase64 = buffer.toString('base64');
          } catch (err) {
            console.error("[Erro áud
