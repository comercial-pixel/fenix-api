const express = require('express');
const sql = require('mssql');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Configuração do banco de dados
const config = {
    server: process.env.DB_SERVER || 'fenixsys.emartim.com.br',
    port: parseInt(process.env.DB_PORT) || 20902,
    database: process.env.DB_DATABASE || 'RemyntimaFenix',
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || 'ZpTuTNMkcHTxRfhQUNQA5BuD',
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        instanceName: 'SQLFenix'
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// Pool de conexões
let pool = null;

// Conectar ao banco
async function connectToDatabase() {
    try {
        pool = await sql.connect(config);
        console.log('✅ Conectado ao banco SQL Server');
        return pool;
    } catch (error) {
        console.error('❌ Erro ao conectar ao banco:', error.message);
        throw error;
    }
}

// Queries SQL
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

// Endpoint de saúde
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        server: config.server,
        database: config.database
    });
});

// Endpoint principal para queries
app.post('/api/query', async (req, res) => {
    try {
        const { queryType, type } = req.body;
        
        console.log(`📊 Executando query: ${queryType}`);
        
        // Verificar se a query existe
        if (!queries[queryType]) {
            return res.status(400).json({
                success: false,
                error: `Query não encontrada: ${queryType}`
            });
        }
        
        // Garantir que temos uma conexão
        if (!pool) {
            await connectToDatabase();
        }
        
        // Executar a query
        const result = await pool.request().query(queries[queryType]);
        
        console.log(`✅ Query ${queryType} executada com sucesso. Registros: ${result.recordset.length}`);
        
        res.json({
            success: true,
            data: result.recordset,
            type: queryType,
            count: result.recordset.length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`❌ Erro na query ${req.body.queryType}:`, error.message);
        
        res.status(500).json({
            success: false,
            error: error.message,
            queryType: req.body.queryType
        });
    }
});

// Endpoint para testar uma query específica
app.get('/api/test/:queryType', async (req, res) => {
    try {
        const { queryType } = req.params;
        
        if (!queries[queryType]) {
            return res.status(400).json({
                success: false,
                error: `Query não encontrada: ${queryType}`
            });
        }
        
        if (!pool) {
            await connectToDatabase();
        }
        
        const result = await pool.request().query(queries[queryType]);
        
        res.json({
            success: true,
            queryType,
            data: result.recordset,
            count: result.recordset.length
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            queryType: req.params.queryType
        });
    }
});

// Listar todas as queries disponíveis
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

// Iniciar servidor
async function startServer() {
    try {
        // Conectar ao banco primeiro
        await connectToDatabase();
        
        // Iniciar o servidor
        app.listen(PORT, () => {
            console.log(`🚀 API Fenix rodando na porta ${PORT}`);
            console.log(`📍 Health check: http://localhost:${PORT}/api/health`);
            console.log(`📍 Queries disponíveis: http://localhost:${PORT}/api/queries`);
        });
        
    } catch (error) {
        console.error('❌ Erro ao iniciar servidor:', error.message);
        process.exit(1);
    }
}

// Tratamento de erros de conexão
process.on('SIGINT', async () => {
    console.log('🛑 Encerrando servidor...');
    if (pool) {
        await pool.close();
    }
    process.exit(0);
});

// Iniciar
startServer();