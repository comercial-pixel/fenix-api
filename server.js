// server.js — Fênix API (CommonJS + Render-friendly)
const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const compression = require('compression');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ---------- Middlewares de performance/robustez ----------
app.set('trust proxy', 1);
app.use(cors());

// aceitar payloads maiores (caso envie filtros/JSON grandes)
const BODY_LIMIT = process.env.BODY_LIMIT || '25mb';
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

// compressão gzip nas respostas
app.use(compression());

// ---------- CONFIG DB (host + porta fixa; sem instanceName) ----------
const dbConfig = {
  server: process.env.DB_HOST || process.env.DB_SERVER || 'fenixsys.emartim.com.br',
  port: parseInt(process.env.DB_PORT || '20902', 10),
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'RemyntimaFenix',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: (process.env.DB_ENCRYPT || 'false') === 'true',
    trustServerCertificate: (process.env.DB_TRUST_SERVER_CERTIFICATE || 'true') === 'true',
    enableArithAbort: true
  },
  // timeouts do driver
  requestTimeout: parseInt(process.env.DB_REQUEST_TIMEOUT_MS || '600000', 10), // 10 min
  connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '15000', 10),

  // pool ajustável via env
  pool: {
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
    min: parseInt(process.env.DB_POOL_MIN || '0', 10),
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS || '30000', 10)
  }
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

// ---------- QUERIES (SUAS, inalteradas) ----------
const queries = {
  lancamentos_diarios: `SELECT cad_emp.EMP_NMR, 'Lançamento' AS Tipo, COUNT(DISTINCT cad_ped.REV_COD) as [QTDE REV], COUNT(cad_ipe.IPE_COD) AS Qtde, COUNT(DISTINCT cad_ipe.PED_COD) as [QTDE PEDIDOS], SUM(cad_ipe.IPE_VTL) AS Valor, SUM(cad_ipe.IPE_VLC) AS Custo FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and CONVERT(varchar,cad_ipe.IPE_DTL,112) = CONVERT(varchar,GETDATE(),112) and cad_ped.PED_TIP = 11 GROUP BY cad_emp.EMP_NMR ORDER BY Valor DESC`,
  devolucoes_diarias: `SELECT cad_emp.EMP_NMR, 'Devolução' AS Tipo, COUNT(DISTINCT cad_ped.REV_COD) as [QTDE REV], COUNT(cad_ipe.IPE_COD) AS Qtde, COUNT(DISTINCT cad_ipe.PED_COD) as [QTDE PEDIDOS], SUM(cad_ipe.IPE_VTL) AS Valor, SUM(cad_ipe.IPE_VLC) AS Custo FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and CONVERT(varchar,cad_ipe.IPE_DDV,112) = CONVERT(varchar,GETDATE(),112) and cad_ped.PED_TIP = 11 GROUP BY cad_emp.EMP_NMR ORDER BY Valor DESC`,
  lancamentos_acumulados: `SELECT cad_emp.EMP_NMR, 'Lançamento' AS Tipo, COUNT(DISTINCT cad_ped.REV_COD) as [QTDE REV], COUNT(cad_ipe.IPE_COD) AS Qtde, COUNT(DISTINCT cad_ipe.PED_COD) as [QTDE PEDIDOS], SUM(cad_ipe.IPE_VTL) AS Valor, SUM(cad_ipe.IPE_VLC) AS Custo FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and CONVERT(varchar,cad_ipe.IPE_DTL,112) >= CONVERT(varchar,DATEADD(DAY, 1, EOMONTH(GETDATE(), -1)),112) AND CONVERT(varchar,cad_ipe.IPE_DTL,112) <= CONVERT(varchar,GETDATE(),112) and cad_ped.PED_TIP = 11 GROUP BY cad_emp.EMP_NMR ORDER BY Valor DESC`,
  devolucoes_acumuladas: `SELECT cad_emp.EMP_NMR, 'Devolução' AS Tipo, COUNT(DISTINCT cad_ped.REV_COD) as [QTDE REV], COUNT(cad_ipe.IPE_COD) AS Qtde, COUNT(DISTINCT cad_ipe.PED_COD) as [QTDE PEDIDOS], SUM(cad_ipe.IPE_VTL) AS Valor, SUM(cad_ipe.IPE_VLC) AS Custo FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and CONVERT(varchar,cad_ipe.IPE_DDV,112) >= CONVERT(varchar,DATEADD(DAY, 1, EOMONTH(GETDATE(), -1)),112) AND CONVERT(varchar,cad_ipe.IPE_DDV,112) <= CONVERT(varchar,GETDATE(),112) and cad_ped.PED_TIP = 11 GROUP BY cad_emp.EMP_NMR ORDER BY Valor DESC`,
  lancamentos_historico: `SELECT CONVERT(varchar,cad_ipe.IPE_DTL,112) as data_ref, cad_emp.EMP_NMR, SUM(cad_ipe.IPE_VTL) as valor FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and cad_ipe.IPE_DTL >= DATEADD(day, -30, GETDATE()) and cad_ipe.IPE_DTL <= GETDATE() and cad_ped.PED_TIP = 11 GROUP BY CONVERT(varchar,cad_ipe.IPE_DTL,112), cad_emp.EMP_NMR`,
  devolucoes_historico: `SELECT CONVERT(varchar,cad_ipe.IPE_DDV,112) as data_ref, cad_emp.EMP_NMR, SUM(cad_ipe.IPE_VTL) as valor FROM cad_ipe JOIN cad_ped ON cad_ipe.ped_cod = cad_ped.ped_cod JOIN cad_emp ON cad_ped.emp_cod = cad_emp.emp_cod WHERE cad_ped.PED_STA IN('CON','ACE','DEV','PND','ESP','SPC') and cad_ipe.IPE_DDV >= DATEADD(day, -30, GETDATE()) and cad_ipe.IPE_DDV <= GETDATE() and cad_ped.PED_TIP = 11 GROUP BY CONVERT(varchar,cad_ipe.IPE_DDV,112), cad_emp.EMP_NMR`
};

// ---------- ROTAS (inalteradas, só com proteções/telemetria) ----------
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.post('/api/query', async (req, res) => {
  const start = Date.now();
  const { queryType } = req.body;
  console.log(`📥 /api/query -> ${queryType}`);

  const sqlQuery = queries[queryType];
  if (!sqlQuery) {
    console.error(`Query type inválido: ${queryType}`);
    return res.status(400).json({ success: false, message: 'Query type inválido' });
  }

  try {
    const p = await getPool();
    if (!p) throw new Error('Sem conexão com o banco');
    const result = await p.request().query(sqlQuery);
    const ms = Date.now() - start;
    console.log(`✅ ${queryType} OK — registros: ${result.recordset.length} — ${ms}ms`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    const ms = Date.now() - start;
    console.error(`❌ ${queryType} FAIL — ${ms}ms — ${err.message}`);
    res.status(500).json({ success: false, message: 'Erro ao processar a query', error: err.message });
  }
});

// Stored Procedure de Análise de Revendedoras
app.post('/api/sp-rev-comissao', async (req, res) => {
  const start = Date.now();
  const { whereClause } = req.body;

  if (!whereClause) {
    return res.status(400).json({ success: false, error: 'Parâmetro "whereClause" é obrigatório.' });
  }

  try {
    const p = await getPool();
    if (!p) {
      console.error('[API Render] Sem conexão com o banco para sp-rev-comissao');
      return res.status(503).json({ success: false, error: 'Serviço indisponível: Sem conexão com o banco de dados.' });
    }

    const request = p.request();
    request.input('Where', sql.NVarChar(4000), whereClause); // ajuste de tamanho se necessário
    console.log(`[API Render] Executando SP 'sp_returnConsultaRevComissao' com WHERE: ${whereClause}`);

    const result = await request.execute('sp_returnConsultaRevComissao');
    const ms = Date.now() - start;
    console.log(`✅ sp-rev-comissao OK — registros: ${result.recordset.length} — ${ms}ms`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    const ms = Date.now() - start;
    console.error(`[API Render] Erro SP sp_returnConsultaRevComissao — ${ms}ms — ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Stored Procedure sp_CobrancaAcerto
app.post('/api/sp-cobranca-acerto', async (req, res) => {
  const start = Date.now();
  try {
    const { emp_cod, atrasado = 0, revCod = 0, tipo = 1, endCompleto = 0 } = req.body;

    if (!emp_cod) {
      return res.status(400).json({ success: false, error: 'Parâmetro emp_cod é obrigatório' });
    }

    const pool = await getPool();
    if (!pool) {
      return res.status(500).json({ success: false, error: 'Não foi possível conectar ao banco de dados' });
    }

    console.log('📊 Executando SP com parâmetros:', { emp_cod, atrasado, revCod, tipo, endCompleto });

    const request = pool.request();
    request.input('EMP_COD', sql.Int, parseInt(emp_cod));
    request.input('ATRASADO', sql.Bit, atrasado ? 1 : 0);
    request.input('RevCod', sql.Int, parseInt(revCod));
    request.input('TIPO', sql.Int, parseInt(tipo));
    request.input('EndCompleto', sql.Bit, endCompleto ? 1 : 0);

    const result = await request.execute('sp_CobrancaAcerto');
    const ms = Date.now() - start;
    console.log(`✅ sp-cobranca-acerto OK — registros: ${result.recordset.length} — ${ms}ms`);

    res.json({ success: true, data: result.recordset });
  } catch (error) {
    const ms = Date.now() - start;
    console.error(`❌ sp-cobranca-acerto FAIL — ${ms}ms — ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Status do DB (inalterado; só trata erros)
app.get('/api/db-status', async (req, res) => {
  try {
    const p = await getPool();
    if (!p) return res.status(503).json({ success: false, error: 'Sem conexão com o banco' });
    const q = `
      SELECT
        SYSDATETIME() AS dbTime,
        CONVERT(date, GETDATE()) AS hoje,
        (SELECT COUNT(*)               FROM cad_ipe WHERE CAST(IPE_DTL AS date) = CAST(GETDATE() AS date)) AS lancamentosHoje,
        (SELECT ISNULL(SUM(IPE_VTL),0) FROM cad_ipe WHERE CAST(IPE_DTL AS date) = CAST(GETDATE() AS date)) AS valorLancamentosHoje,
        (SELECT COUNT(*)               FROM cad_ipe WHERE CAST(IPE_DDV AS date) = CAST(GETDATE() AS date)) AS devolucoesHoje,
        (SELECT ISNULL(SUM(IPE_VTL),0) FROM cad_ipe WHERE CAST(IPE_DDV AS date) = CAST(GETDATE() AS date)) AS valorDevolucoesHoje
    `;
    const r = await p.request().query(q);
    res.json({ success: true, ...r.recordset[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- Start HTTP + DB retry em background ----------
const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 API Fenix rodando em http://${HOST}:${PORT}`);
  connectWithRetry().catch(err => console.error('Conector DB erro:', err.message));
});

// ---------- Timeouts do servidor (Node 18+) ----------
server.requestTimeout = parseInt(process.env.HTTP_REQUEST_TIMEOUT_MS || '0', 10); // 0 = sem limite
server.headersTimeout = parseInt(process.env.HTTP_HEADERS_TIMEOUT_MS || '65000', 10);
server.keepAliveTimeout = parseInt(process.env.HTTP_KEEPALIVE_TIMEOUT_MS || '5000', 10);

// ---------- Encerramento limpo ----------
const shutdown = async (signal) => {
  console.log(`🛑 Recebido ${signal}, encerrando servidor...`);
  try { server.close(); } catch {}
  try { if (pool) await pool.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- Hardening mínimo de erros não tratados ----------
process.on('unhandledRejection', (reason) => {
  console.error('🚨 UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('🚨 UncaughtException:', err);
});
