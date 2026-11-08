const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Endpoint de saúde para o UptimeRobot não deixar o servidor dormir
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    servico: 'ER GESTAO Server',
    timestamp: new Date().toISOString(),
    uptime_segundos: Math.floor(process.uptime())
  });
});

// Rota preparatória para a futura conexão do WhatsApp
app.post('/webhook/whatsapp', (req, res) => {
  res.status(200).json({ status: 'recebido' });
});

// Servir o frontend do ER GESTÃO (o seu index.html)
app.use(express.static(path.join(__dirname)));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`[ER GESTAO] Servidor rodando na porta ${PORT}`);
});
