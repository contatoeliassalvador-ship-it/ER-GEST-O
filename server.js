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
const GEMINI_API_KEY = "AQ.Ab8RN6KMlcP7FNhYBlIQ_MuD9FjSyV7x8RM57HaVRSxpkmBPig";

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
  // 1. Criar Lembrete Ativo
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

  // 5. Registrar Despesa Geral
  async registrar_despesa({ descricao, valor, categoria, fornecedor, ambiente }) {
    const amb = ambiente || 'pessoa_fisica';

    await supabase.from('gastos').insert({
      ambiente
