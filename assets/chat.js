'use strict';
let chatBusy = false;
let chatGeneration = 0;
let chatAbort = null;
function acessarConta() {
  if (usuarioAtual) { desconectar(); return; }
  document.getElementById('tela-login').classList.remove('hidden');
  document.getElementById('auth-email').focus();
}
function ajustarComposer(input) {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 150) + 'px';
}
function prepararMensagem(texto) {
  trocarAba('chat');
  const input = document.getElementById('chat-input');
  input.value = texto;
  ajustarComposer(input);
  input.focus();
}
function alternarAtalhos() {
  const tray = document.getElementById('chat-action-tray');
  tray.classList.toggle('hidden');
  document.getElementById('composer-add').setAttribute('aria-expanded', String(!tray.classList.contains('hidden')));
}
function limparConversa() {
  chatGeneration++;
  chatAbort?.abort();
  chatBusy = false;
  document.getElementById('chat-send').disabled = false;
  document.getElementById('chat-input').disabled = false;
  document.getElementById('chat-messages').replaceChildren();
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('chat-welcome').classList.remove('hidden');
  document.getElementById('chat-input').value = '';
  ajustarComposer(document.getElementById('chat-input'));
}
function novaConversa() { limparConversa(); trocarAba('chat'); document.getElementById('chat-input').focus(); }
function adicionarMensagem(role, texto, actions = []) {
  document.getElementById('chat-welcome').classList.add('hidden');
  const log = document.getElementById('chat-messages');
  log.classList.remove('hidden');
  const row = document.createElement('div');
  row.className = 'message' + (role === 'user' ? ' message-user' : '');
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = role === 'user' ? 'EU' : 'ER';
  const content = document.createElement('div'); content.className = 'message-content';
  const name = document.createElement('p'); name.className = 'message-name'; name.textContent = role === 'user' ? 'Você' : 'Assistente ER';
  const body = document.createElement('div'); body.className = 'message-text'; body.textContent = texto;
  content.append(name, body);
  if (actions.length) {
    const buttons = document.createElement('div'); buttons.className = 'message-actions';
    for (const action of actions) { const button = document.createElement('button'); button.textContent = action.label; button.onclick = action.run; buttons.append(button); }
    content.append(buttons);
  }
  row.append(avatar, content); log.append(row); log.scrollTop = log.scrollHeight;
  return row;
}
function mostrarCapacidades() {
  trocarAba('chat');
  adicionarMensagem('assistant', 'Posso ajudar você a localizar veículos e consultar gastos. Para novos registros, abra os formulários de despesas, manutenção, documentos ou frota.\n\nO registro automático por conversa ainda está em validação. Nenhum lançamento é feito apenas ao enviar uma mensagem.', [
    { label:'Novo registro', run:alternarAtalhos }, { label:'Ver a frota', run:() => trocarAba('veiculos') }
  ]);
}
function abrirRegistroChat(tipo) {
  if (!usuarioAtual) {
    adicionarMensagem('assistant', 'Entre na sua conta para acessar os registros da empresa.', [{label:'Entrar na conta',run:acessarConta}]);
    acessarConta(); return;
  }
  const actions = { gasto:abrirModalGasto, manutencao:abrirModalManutencao, documento:abrirModalDoc, veiculo:abrirModalVeiculo };
  actions[tipo]?.();
}
function ajudaLocal() {
  adicionarMensagem('assistant', 'O atendimento inteligente não está disponível nesta conexão. Você pode continuar pelos formulários e consultar as áreas do sistema. Nenhum registro foi realizado por esta mensagem.', [
    {label:'Registrar despesa',run:() => abrirRegistroChat('gasto')},
    {label:'Registrar manutenção',run:() => abrirRegistroChat('manutencao')},
    {label:'Consultar frota',run:() => trocarAba('veiculos')},
    {label:'Ver despesas',run:() => trocarAba('gastos')}
  ]);
}
async function enviarChat(event) {
  event.preventDefault();
  if (chatBusy) return;
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) return;
  adicionarMensagem('user', message);
  input.value = ''; ajustarComposer(input);
  if (!usuarioAtual) {
    adicionarMensagem('assistant', 'Olá! Sou o Assistente ER. Para consultar os dados da empresa e começar seus registros, entre na sua conta administrativa.', [{label:'Entrar na conta',run:acessarConta}, {label:'Conhecer os recursos',run:mostrarCapacidades}]);
    return;
  }
  chatBusy = true;
  const generation = chatGeneration;
  const pending = adicionarMensagem('assistant', 'Consultando sua solicitação…');
  document.getElementById('chat-send').disabled = true;
  input.disabled = true;
  chatAbort = new AbortController();
  const timer = setTimeout(() => chatAbort?.abort(), 55000);
  try {
    const { data, error } = await sbClient.auth.getSession();
    if (error || !data.session) throw new Error('session');
    const response = await fetch('/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${data.session.access_token}`},
      body:JSON.stringify({message, ambiente:ambienteAtual}), signal:chatAbort.signal
    });
    if (generation !== chatGeneration) return;
    pending.remove();
    if (response.status === 401 || response.status === 403) {
      adicionarMensagem('assistant', 'Sua sessão não tem autorização para usar o chat administrativo. Confira a conta conectada.', [{label:'Sair e entrar novamente',run:acessarConta}]); return;
    }
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) { ajudaLocal(); return; }
    const result = await response.json();
    if (generation !== chatGeneration) return;
    if (typeof result.reply !== 'string') { ajudaLocal(); return; }
    adicionarMensagem('assistant', result.reply, [{label:'Abrir formulário de registro',run:alternarAtalhos}]);
  } catch {
    if (generation !== chatGeneration) return;
    pending.remove(); ajudaLocal();
  } finally {
    clearTimeout(timer);
    if (generation === chatGeneration) {
      chatBusy = false; input.disabled = false; document.getElementById('chat-send').disabled = false; input.focus();
    }
  }
}
document.getElementById('chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); document.getElementById('chat-form').requestSubmit(); }
});
trocarAba('chat');
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    document.getElementById('tela-login').classList.add('hidden');
    document.getElementById('scope-menu').classList.add('hidden');
    document.getElementById('chat-action-tray').classList.add('hidden');
    document.getElementById('composer-add').setAttribute('aria-expanded', 'false');
    fecharModal();
  }
});
