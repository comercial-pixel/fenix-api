// server.js — Fênix API (CommonJS + Render-friendly)
const express = require('express');
const sql = require('mssql');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(cors());
app.use(express.json());

// ---- CONFIG DB (host + porta fixa; sem instanceName) ----
const dbConfig = {
  server: process.env.DB_HOST || process.env.DB_SERVER || 'fenixsys.emartim.com.br',
  port: parseInt(process.env.DB_PORT || '20902', 10), // <- importante para seu ambiente
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'RemyntimaFenix',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: (process.env.DB_ENCRYPT || 'false') === 'true',
    trustServerCertificate: (process.env.DB_TRUST_SERVER_CERTIFICATE || 'true') === 'true',
    enableArithAbort: true
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
};

// Mantém um pool global (não feche em cada requisição)
let pool = null;

// Conectar com tentativas, sem derrubar o processo
async function connectWithRetry(retries = 10, delayMs = 5000) {
  for (let i = 1; i <= retries; i++) {
    try {
      pool = await sql.connect(dbConfig);
      console.log('✅ DB conectado');
      return pool;
    } catch (err) {
      console.error(`❌ Tentativa ${i} falhou: ${err.message}`);
      if (i === retries) {
        console.warn('⚠️ Não conectou ao DB; API segue online sem DB');
        return null;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// Garante um pool pronto (1 tentativa rápida on-demand)
async function getPool() {
  if (pool && pool.connected) return pool;
  try {
    pool = await sql.connect(dbConfig);
    return pool;
  } catch {
    return null;
  }
}

// ---- QUERIES (as suas, sem alterações) ----
const queries = {
  lancamentos_diarios: `
    SELECT cad_emp.EMP_NMR
    , 'Lançamento' AS Tipo
    , COUNT(cad_ipe.IPE_COD) AS Qtde
    , COUNT(DISTINCT cad_ipe.PED_COD) AS [QTDE PEDIDOS]
    , SUM(cad_ipe.IPE_VTL) AS Valor 
    , SUM(cad_ipe.IPE_VLC) AS Custo 
    FROM cad_ipe 
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod 
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod 
    WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC')
      AND CONVERT(varchar,cad_ipe.IPE_DTL,112) = CONVERT(varchar,GETDATE(),112)
      AND cad_ped.PED_TIP = 11
    GROUP BY cad_emp.EMP_NMR
    ORDER BY Valor DESC
  `,
  devolucoes_diarias: `
    SELECT cad_emp.EMP_NMR
    , 'Devolução' AS Tipo
    , COUNT(cad_ipe.IPE_COD) AS Qtde
    , COUNT(DISTINCT cad_ipe.PED_COD) AS [QTDE PEDIDOS]
    , SUM(cad_ipe.IPE_VTL) AS Valor 
    , SUM(cad_ipe.IPE_VLC) AS Custo 
    FROM cad_ipe 
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod 
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod 
    WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC')
      AND CONVERT(varchar,cad_ipe.IPE_DDV,112) = CONVERT(varchar,GETDATE(),112)
      AND cad_ped.PED_TIP = 11
    GROUP BY cad_emp.EMP_NMR
    ORDER BY Valor DESC
  `,
  lancamentos_acumulados: `
    SELECT cad_emp.EMP_NMR
    , 'Lançamento' AS Tipo
    , COUNT(cad_ipe.IPE_COD) AS Qtde
    , COUNT(DISTINCT cad_ipe.PED_COD) AS [QTDE PEDIDOS]
    , SUM(cad_ipe.IPE_VTL) AS Valor 
    , SUM(cad_ipe.IPE_VLC) AS Custo 
    FROM cad_ipe 
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod 
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod 
    WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC')
      AND CONVERT(varchar,cad_ipe.IPE_DTL,112) >= CONVERT(varchar,DATEADD(DAY, 1, EOMONTH(GETDATE(), -1)),112)
      AND CONVERT(varchar,cad_ipe.IPE_DTL,112) <= CONVERT(varchar,EOMONTH(GETDATE()),112)
      AND cad_ped.PED_TIP = 11
    GROUP BY cad_emp.EMP_NMR
    ORDER BY Valor DESC
  `,
  devolucoes_acumuladas: `
    SELECT cad_emp.EMP_NMR
    , 'Devolução' AS Tipo
    , COUNT(cad_ipe.PED_COD) AS Qtde
    , COUNT(DISTINCT cad_ipe.PED_COD) AS [QTDE PEDIDOS]
    , SUM(cad_ipe.IPE_VTL) AS Valor 
    , SUM(cad_ipe.IPE_VLC) AS Custo 
    FROM cad_ipe 
    JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod 
    JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod 
    WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC')
      AND CONVERT(varchar,cad_ipe.IPE_DDV,112) >= CONVERT(varchar,DATEADD(DAY, 1, EOMONTH(GETDATE(), -1)),112)
      AND CONVERT(varchar,cad_ipe.IPE_DDV,112) <= CONVERT(varchar,EOMONTH(GETDATE()),112)
      AND cad_ped.PED_TIP = 11
    GROUP BY cad_emp.EMP_NMR
    ORDER BY Valor DESC
  `
};

// ---- ROTAS ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.post('/api/query', async (req, res) => {
  const { queryType } = req.body;
  console.log(`Recebida requisição para query: ${queryType}`);

  const sqlQuery = queries[queryType];
  if (!sqlQuery) {
    console.error(`Query type inválido: ${queryType}`);
    return res.status(400).json({ success: false, message: 'Query type inválido' });
  }

  try {
    const p = await getPool();
    if (!p) throw new Error('Sem conexão com o banco');
    const result = await p.request().query(sqlQuery);
    console.log(`Query ${queryType} executada. Registros: ${result.recordset.length}`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('Erro na execução da query SQL:', err.message);
    res.status(500).json({ success: false, message: 'Erro ao processar a query', error: err.message });
  }
});

// Status do DB: hora do SQL + contagens/valores do dia (para acompanhar atualização)
app.get('/api/db-status', async (req, res) => {
  try {
    const p = await getPool();
    if (!p) return res.status(503).json({ success: false, error: 'Sem conexão com o banco' });
    const q = `
      SELECT
        SYSDATETIME() AS dbTime,
        CONVERT(date, GETDATE()) AS hoje,
        (SELECT COUNT(*)              FROM cad_ipe WHERE CAST(IPE_DTL AS date) = CAST(GETDATE() AS date)) AS lancamentosHoje,
        (SELECT ISNULL(SUM(IPE_VTL),0) FROM cad_ipe WHERE CAST(IPE_DTL AS date) = CAST(GETDATE() AS date)) AS valorLancamentosHoje,
        (SELECT COUNT(*)              FROM cad_ipe WHERE CAST(IPE_DDV AS date) = CAST(GETDATE() AS date)) AS devolucoesHoje,
        (SELECT ISNULL(SUM(IPE_VTL),0) FROM cad_ipe WHERE CAST(IPE_DDV AS date) = CAST(GETDATE() AS date)) AS valorDevolucoesHoje
    `;
    const r = await p.request().query(q);
    res.json({ success: true, ...r.recordset[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sobe HTTP primeiro e tenta o DB em background (não mata o processo se falhar)
app.listen(PORT, HOST, () => {
  console.log(`🚀 API Fenix rodando em http://${HOST}:${PORT}`);
  connectWithRetry().catch(err => console.error('Conector DB erro:', err.message));
});

// Encerramento limpo
process.on('SIGINT', async () => {
  console.log('🛑 Encerrando servidor...');
  try { if (pool) await pool.close(); } catch {}
  process.exit(0);
});
