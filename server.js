const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Endpoint de saúde para o UptimeRobot (mantém o servidor 24h ativo)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    servico: 'ER GESTAO - Servidor Leve',
    timestamp: new Date().toISOString(),
    uptime_segundos: Math.floor(process.uptime())
  });
});

// Serve o frontend completo do ER GESTÃO (index.html)
app.use(express.static(path.join(__dirname)));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`[ER GESTAO] Servidor rodando leve e veloz na porta ${PORT}`);
});
