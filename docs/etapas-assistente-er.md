# ASSISTENTE ER — entrega incremental

Esta entrega recupera a sintaxe do servidor e prepara a interpretação e a identificação segura de veículos. Preserva o painel, Baileys e os cadastros existentes; não cria banco, tabela ou migração. Não representa a conclusão dos oito módulos de implementação nem uma validação em produção.

## Diagnóstico antes da alteração

A análise identificou servidor truncado dentro do tratamento de áudio, quatro importações ausentes, credenciais embutidas no servidor, autorização ausente, erros do Supabase ignorados, registros parciais possíveis, identificação por primeiro resultado, memória inexistente e consulta financeira sem filtros suficientes. O diagnóstico inicial completo está em `diagnostico-inicial.md`. As configurações efetivas do Render, do UptimeRobot e as políticas do Supabase não estavam disponíveis para validação autenticada.

## Estado por etapa

| Etapa | Implementado nesta entrega | Pendente |
| --- | --- | --- |
| 1 — diagnóstico | Análise dos três arquivos próprios do projeto, arquitetura e falhas documentadas | Inspeção autenticada do esquema real, políticas RLS e configuração dos serviços externos |
| 2 — conversação | Prompt executor em português, sem frota fictícia; Gemini por SDK oficial; timeout; respostas de ferramentas confiáveis; dados faltantes geram esclarecimento | Testes reais de interpretação; múltiplas ferramentas por tarefa e ciclo functionResponse; continuidade entre mensagens |
| 3 — veículos | Normalização de placa; placa desconhecida bloqueada; nomes e apelidos existentes; múltiplos candidatos exigem placa completa; nomes nulos não quebram a busca | Confirmar nomes/tipos reais das colunas de apelidos; validar frota real |
| 4 — ferramentas e banco | Consultar/listar veículos, lembretes e custos com escopo do administrador; falhas não se tornam “sem registros”; custos por categoria, veículo, mês civil ou dias | Esquema real, transações, idempotência e auditoria duráveis; habilitação de escritas; histórico, pendências e relatórios |
| 5 — módulos | Executores existentes preservados no código, inacessíveis para gravação nesta fase | Operações/horas, preventiva/corretiva completas, documentos no WhatsApp e relatórios; escrituras administrativas validadas |
| 6 — memória | Nenhuma persistência nova criada | Decisão de arquitetura: novas persistências exigem primitivas Netlify neste ambiente; não foi presumida autorização para memória híbrida |
| 7 — áudio | Recuperação do handler; MIME recebido, limites de 10 MB/5 minutos, transcrição explícita antes da interpretação e resposta em texto | Validação com arquivos reais e formatos do aparelho; transcrição persistente e áudios inaudíveis; controle de recursos durante download |
| 8 — segurança e testes | Número exato no servidor; bloqueio de grupos/LID; status/QR autenticado via Supabase; credenciais do servidor por ambiente; 18 testes e smoke HTTP | RLS real, segurança do painel existente, auditoria, testes de concorrência/reentrega após habilitar escrita, testes reais de integração |

## Comportamento seguro desta revisão

Gravações permanecem bloqueadas no dispatcher, sem opção de ambiente para contornar o bloqueio. O envio automático de lembretes também fica suspenso até haver reivindicação atômica e proteção durável contra duplicidade. Mensagens repetidas podem gerar novas consultas/respostas e consumo de IA, mas não gravações; isso não equivale a idempotência implementada.

As operações destrutivas, pagamentos e transferências não são oferecidas. Não existe mecanismo de confirmação persistente nesta entrega. Não há memória entre mensagens: é preciso reenviar uma solicitação completa; o assistente não afirma lembrar de tarefas anteriores.

A busca é limitada a 500 veículos, sem retornar uma frota truncada silenciosamente. Os custos usam apenas `gastos` e não alegam incluir valores existentes exclusivamente em outras tabelas. Acima de 1.000 lançamentos, o assistente pede um período menor em vez de apresentar um total incompleto. Colunas `user_id` precisam existir nas consultas: se o esquema divergir, a consulta falha de forma segura, sem remover o filtro de acesso.

## Configuração e infraestrutura

O servidor lê `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (ou a variável existente `SUPABASE_KEY`), `ADMIN_USER_ID`, `ADMIN_PHONE` e `PORT`. Nenhum valor é documentado ou registrado em logs. Sem configuração administrativa válida, o servidor HTTP inicia, mas não conecta o WhatsApp. O cliente Gemini usa as variáveis reconhecidas pelo SDK e o modelo `gemini-3-flash-preview`, substituindo a referência antiga a `gemini-1.5-flash`. A disponibilidade real e o provisionamento de credenciais no Render não foram verificados. A credencial Gemini que constava no código anterior requer substituição no provedor.

`GET /health` permite verificar o processo HTTP; não comprova conexão do WhatsApp ou funcionamento do banco/IA. `GET /api/whatsapp/status` exige token de sessão Supabase do usuário cujo ID corresponde a `ADMIN_USER_ID`, impede cache e fornece QR somente após autenticação. Nenhum endpoint genérico de execução foi exposto.

O processo Baileys continua exigindo servidor persistente e a autenticação local existente em `baileys_auth_info`. Não foi movido para funções efêmeras. O painel original foi preservado. Nenhuma configuração do Render ou monitor do UptimeRobot foi alterada, e nenhum deploy foi realizado por esta execução.

## Verificação

`npm test`: 18 testes passaram. Os testes executam o núcleo real e o dispatcher do servidor com Supabase e Gemini simulados. Os seis exemplos da especificação são cobertos por chamadas de ferramenta simuladas; isso valida o tratamento depois da classificação, não a capacidade do modelo real de entender cada frase. Há casos para número não autorizado, placa desconhecida, prefixo ambíguo, nome nulo, valor inválido, campos incompletos, duplicatas sem escrita, mês civil em São Paulo, janela de 30 dias, erro de banco, excesso de registros e erro do provedor.

`node --check server.js` e `node --check lib/assistant-core.js` passaram. O smoke HTTP local, sem conectar WhatsApp, retornou 200 em `/health`, 401 no status sem autenticação e 200 no painel. A instalação do SDK reportou zero vulnerabilidades naquele momento. Nenhum build, escrita no banco, mensagem real ou pagamento foi executado.
