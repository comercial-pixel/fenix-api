// server.js (versão compatível com Render, reaproveitando seu código)
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Middlewares
app.use(cors());
app.use(express.json());

// Configuração do banco de dados
// -> Sem "instância nomeada"; usamos host + porta fixa
const config = {
  server: process.env.DB_HOST || process.env.DB_SERVER || 'fenixsys.emartim.com.br',
  port: parseInt(process.env.DB_PORT || '20902', 10), // ajuste aqui se sua porta fixa for outra
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'RemyntimaFenix',
  user: process.env.DB_USER || 'sa',
  // Evite valor padrão para senha em produção; deixe vazia para pegar das variáveis de ambiente
  password: process.env.DB_PASSWORD || '',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
    // NADA de instanceName aqui
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

// Pool de conexões
let pool = null;

// Conectar ao banco com tentativas (não derruba o processo)
async function connectWithRetry(retries = 10, delayMs = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      pool = await sql.connect(config);
      console.log('✅ DB conectado');
      return;
    } catch (err) {
      console.error(`❌ Tentativa ${i} falhou: ${err.message}`);
      if (i === retries) {
        console.warn('⚠️ Não conectou ao DB após várias tentativas; API segue online sem DB');
        return;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// Queries SQL (iguais às suas)
const queries = {
  lancamentos_diarios: `
    SELECT cad_emp.EMP_NMR, 'Lançamento' AS Tipo, COUNT(*) AS Qtde, SUM(cad_ipe.IPE_VTL) AS Valor 
    FROM cad_ipe 
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod 
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod 
    WHERE CAST(cad_ipe.IPE_DTL AS DATE) = CAST(GETDATE() AS DATE) 
    GROUP BY cad_emp.EMP_NMR 
    ORDER BY Valor DESC
  `,
  devolucoes_diarias: `
    SELECT cad_emp.EMP_NMR, 'Devolução' AS Tipo, COUNT(*) AS Qtde, SUM(cad_ipe.IPE_VTL) AS Valor 
    FROM cad_ipe 
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod 
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod 
    WHERE CAST(cad_ipe.IPE_DDV AS DATE) = CAST(GETDATE() AS DATE) 
    GROUP BY cad_emp.EMP_NMR 
    ORDER BY Valor DESC
  `,
  lancamentos_acumulados: `
    SELECT cad_emp.EMP_NMR, 'Lançamento' AS Tipo, COUNT(*) AS Qtde, SUM(cad_ipe.IPE_VTL) AS Valor 
    FROM cad_ipe 
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod 
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod 
    WHERE cad_ipe.IPE_DTL >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) 
    AND cad_ipe.IPE_DTL <= CONVERT(date, GETDATE()) 
    GROUP BY cad_emp.EMP_NMR 
    ORDER BY Valor DESC
  `,
  devolucoes_acumuladas: `
    SELECT cad_emp.EMP_NMR, 'Devolução' AS Tipo, COUNT(*) AS Qtde, SUM(cad_ipe.IPE_VTL) AS Valor 
    FROM cad_ipe 
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod 
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod 
    WHERE cad_ipe.IPE_DDV >= DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1) 
    AND cad_ipe.IPE_DDV <= CONVERT(date, GETDATE()) 
    GROUP BY cad_emp.EMP_NMR 
    ORDER BY Valor DESC
  `
};

// Rotas
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    server: config.server,
    database: config.database
  });
});

app.post('/api/query', async (req, res) => {
  try {
    const { queryType } = req.body;
    if (!queries[queryType]) {
      return res.status(400).json({ success: false, error: `Query não encontrada: ${queryType}` });
    }
    if (!pool) await connectWithRetry(1, 0); // tenta conectar 1x rápido se ainda não tem pool
    if (!pool) throw new Error('Sem conexão com o banco');
    const result = await pool.request().query(queries[queryType]);
    res.json({ success: true, data: result.recordset, type: queryType, count: result.recordset.length, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, queryType: req.body?.queryType });
  }
});

app.get('/api/test/:queryType', async (req, res) => {
  try {
    const { queryType } = req.params;
    if (!queries[queryType]) {
      return res.status(400).json({ success: false, error: `Query não encontrada: ${queryType}` });
    }
    if (!pool) await connectWithRetry(1, 0);
    if (!pool) throw new Error('Sem conexão com o banco');
    const result = await pool.request().query(queries[queryType]);
    res.json({ success: true, queryType, data: result.recordset, count: result.recordset.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message, queryType: req.params.queryType });
  }
});

app.get('/api/queries', (req, res) => {
  res.json({
    success: true,
    availableQueries: Object.keys(queries),
    endpoints: {
      health: '/api/health',
      query: '/api/query (POST)',
      test: '/api/test/:queryType (GET)'
    }
  });
});

// Sobe o HTTP primeiro e tenta o DB em background (não mata o processo se falhar)
app.listen(PORT, HOST, () => {
  console.log(`🚀 API Fenix rodando em http://${HOST}:${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/api/health`);
  connectWithRetry().catch(err => console.error('Conector DB erro:', err.message));
});

// Encerramento limpo
process.on('SIGINT', async () => {
  console.log('🛑 Encerrando servidor...');
  if (pool) await pool.close();
  process.exit(0);
});
