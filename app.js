import 'dotenv/config';
import express from 'express';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import cors from 'cors';
import pg from 'pg'; // 1. Importa o 'pg' (node-postgres)

const app = express();
const port = process.env.PORT || 3000;
const VALOR_UNITARIO_RIFA = 3.00; 

let paymentClient; 

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "SEU_ACCESS_TOKEN_REAL_DE_TESTE_AQUI"; 

// 2. Configura o "Pool" de conexões do PostgreSQL
// Ele usará automaticamente a variável de ambiente DATABASE_URL que você configurou no Render
const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Se estiver rodando no Render, o SSL interno pode não ser necessário.
    // Se o Render exigir, descomente a linha abaixo.
     ssl: { rejectUnauthorized: false } 
});

console.log("Tentando conectar ao PostgreSQL...");

// =================================================================
// Configurações do Middleware
// =================================================================
app.use(cors()); 
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

async function initializeDatabase() {
    try {
        // 3. Conecta e cria a tabela se não existir (Sintaxe do Postgres)
        // Usamos "SERIAL PRIMARY KEY" para auto-incremento (opcional, mas bom)
        // Usamos "BIGINT" para o payment_id (IDs do MP são grandes)
        // Usamos "TIMESTAMPTZ" para datas com fuso horário
        await pool.query(`CREATE TABLE IF NOT EXISTS rifas (
            numero INTEGER PRIMARY KEY,
            status TEXT NOT NULL,
            comprador_nome TEXT,
            comprador_telefone TEXT,
            comprador_email TEXT,
            comprador_cpf TEXT,
            external_reference TEXT,
            payment_id BIGINT,  
            reservado_em TIMESTAMPTZ   
        )`);

        console.log('Tabela "rifas" verificada/criada.');

        // 4. Adiciona a coluna (Postgres tem "ADD COLUMN IF NOT EXISTS")
        await pool.query('ALTER TABLE rifas ADD COLUMN IF NOT EXISTS reservado_em TIMESTAMPTZ');

        // 5. Verifica se está vazia (Sintaxe de query do 'pg' é diferente)
        const res = await pool.query("SELECT COUNT(*) as count FROM rifas");
        const row = res.rows[0];
        
        // 6. 'count' do Postgres pode vir como string '0'
        if (row && row.count == 0) { 
            console.log("Inicializando 100 números da rifa...");
            
            // 7. Insere os números (Postgres usa $1, $2... em vez de ?)
            // Usamos 'BEGIN' e 'COMMIT' para rodar tudo em uma transação (muito mais rápido)
            await pool.query('BEGIN');
            for (let i = 1; i <= 100; i++) {
                await pool.query(`INSERT INTO rifas (numero, status) VALUES ($1, 'DISPONIVEL')`, [i]);
            }
            await pool.query('COMMIT');
            console.log("Números inicializados.");
        }
        return true;

    } catch (err) {
        console.error("ERRO CRÍTICO NA INICIALIZAÇÃO DO BANCO DE DADOS:", err.stack); // .stack dá mais detalhes
        return false;
    }
}

function initializeMercadoPago() {
    if (!ACCESS_TOKEN || ACCESS_TOKEN === "SEU_ACCESS_TOKEN_REAL_DE_TESTE_AQUI") {
        console.error("ERRO CRÍTICO: Por favor, configure o ACCESS_TOKEN no seu .env ou nas variáveis de ambiente");
        process.exit(1);
    }
    const client = new MercadoPagoConfig({
        accessToken: ACCESS_TOKEN,
        options: { timeout: 5000 },
    });
    paymentClient = new Payment(client);
    console.log("Mercado Pago configurado.");
}


// =================================================================
// 3. ROTAS DA RIFA
// =================================================================

// Rota para listar todas as rifas e status
app.get('/rifas', async (req, res) => {
    try {
        // 8. db.all() vira pool.query()
        // O resultado vem em 'rows'
        const { rows } = await pool.query("SELECT numero, status, comprador_nome, comprador_telefone, comprador_email FROM rifas ORDER BY numero");
        res.json(rows); 
    } catch (err) {
        console.error("Erro em /rifas:", err.stack);
        res.status(500).json({ error: 'Erro ao buscar dados da rifa.' });
    }
});

// Rota para GERAÇÃO DO PIX e RESERVA
// Rota para GERAÇÃO DO PIX e RESERVA
app.post('/reservar', async (req, res) => {
    // 1. RECEBE APENAS NOME E TELEFONE
    const { numeros, nome, telefone } = req.body; 

    // 2. DADOS FICTÍCIOS OBRIGATÓRIOS PARA O MERCADO PAGO
    // O MP exige e-mail e CPF para PIX. Usaremos dados genéricos.
    const DUMMY_EMAIL = "pagamento@rifa.com"; // Pode ser qualquer email
    const DUMMY_CPF = "26188102092"; // Use um CPF de TESTE válido

    // 3. VALIDA OS DADOS QUE CHEGARAM
    if (!numeros || numeros.length === 0 || !nome || !telefone) {
        return res.status(400).json({ error: 'Dados obrigatórios faltando ou nenhum número selecionado.' });
    }

    const external_reference = `ORDEM-${Date.now()}`; 
    const cleanCpf = DUMMY_CPF; // 4. USA O CPF FICTÍCIO
    const transaction_amount = VALOR_UNITARIO_RIFA * numeros.length; 
    const numerosRifa = numeros.map(n => parseInt(n));

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Lógica de verificação de disponibilidade (continua igual)
        const placeholders = numerosRifa.map((_, i) => `$${i + 1}`).join(',');
        const query = `SELECT numero, status FROM rifas WHERE numero IN (${placeholders}) FOR UPDATE`;
        const { rows } = await client.query(query, numerosRifa);
        
        const indisponiveis = rows.filter(row => row.status !== 'DISPONIVEL');

        if (indisponiveis.length > 0) {
            await client.query('ROLLBACK'); 
            return res.status(409).json({ 
                error: 'Alguns números não estão disponíveis.',
                numeros: indisponiveis.map(r => `Nº ${r.numero} (${r.status})`)
            });
        }
        
        // 5. CRIA O PAGAMENTO PIX COM DADOS FICTÍCIOS
        const body = {
            transaction_amount: transaction_amount,
            description: `Rifa(s) - Total de ${numerosRifa.length} números`,
            payment_method_id: 'pix', 
            external_reference: external_reference, 
            payer: { 
                email: DUMMY_EMAIL, // Usa o e-mail fictício
                identification: { type: 'CPF', number: cleanCpf } // Usa o CPF fictício
            }
        };

        const payment = await paymentClient.create({ body });
        
        const agoraISO = new Date(); 

        // 6. ATUALIZA O BANCO DE DADOS, SALVANDO NULL PARA EMAIL E CPF
        const updateQuery = `UPDATE rifas SET status = 'RESERVADO', comprador_nome = $1, comprador_telefone = $2, 
                             comprador_email = NULL, comprador_cpf = NULL, external_reference = $3, payment_id = $4,
                             reservado_em = $5 
                             WHERE numero = $6`; // Placeholders reajustados
                            
        const updatePromises = numerosRifa.map(numeroRifa => {
            // 7. Passa os dados corretos para a query (sem email e cpf)
            return client.query(updateQuery, [nome, telefone, external_reference, payment.id, agoraISO, numeroRifa]);
        });
        await Promise.all(updatePromises);

        await client.query('COMMIT');

        // 8. Retorna os dados do PIX
        res.json({
            success: true,
            status: payment.status, 
            external_reference: external_reference,
            payment_id: payment.id,
            qr_code_base64: payment.point_of_interaction.transaction_data.qr_code_base64,
            qr_code: payment.point_of_interaction.transaction_data.qr_code,
            comprador: { nome, telefone } 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('ERRO CRÍTICO no fluxo de reserva/pagamento:', error.stack);
        res.status(500).json({ error: 'Falha ao processar a compra. Tente novamente.' });
    } finally {
        client.release();
    }
});

app.get('/admin/reset-all', async (req, res) => {
    // CUIDADO: Esta rota é pública. 
    // Em um app real, você deve protegê-la com senha.
    try {
        console.log(`[TESTE ADMIN] Forçando RESET TOTAL DA RIFA...`);
        
        const result = await pool.query(`
            UPDATE rifas SET 
                status = 'DISPONIVEL', 
                comprador_nome = NULL, 
                comprador_telefone = NULL, 
                comprador_email = NULL, 
                comprador_cpf = NULL, 
                external_reference = NULL, 
                payment_id = NULL, 
                reservado_em = NULL
        `);

        res.send(`RIFA RESETADA! ${result.rowCount} números foram liberados.`);

    } catch (error) {
        console.error("Erro ao resetar rifa:", error.stack);
        res.status(500).send(`Erro ao resetar: ${error.message}`);
    }
});

// Rota /notificar (Webhook) - Processa pagamentos
app.post('/notificar', async (req, res) => {
    const resourceId = req.query.id || req.body.data?.id; 
    const topic = req.query.topic || req.query.type;

    if (topic !== 'payment' || !resourceId) return res.status(200).send('Notificação ignorada.'); 

    try {
        console.log(`[WEBHOOK] Consultando payment_id: ${resourceId}`);
        const paymentInfo = await paymentClient.get({ id: resourceId });

        const status = paymentInfo.status;
        const externalRef = paymentInfo.external_reference; 

        if (!externalRef) {
             console.warn(`[WEBHOOK] Pagamento ${resourceId} sem external_reference. Ignorando.`);
             return res.status(200).send('Notificação ignorada (sem external_ref).');
        }

        console.log(`[WEBHOOK] Status Retornado: ${status}, Ref. Externa: ${externalRef}`);

        // 11. Todas as queries do DB atualizadas para $1
        if (status === 'approved') {
            console.log(`--- SUCESSO: PAGAMENTO APROVADO! ---`);
            await pool.query(`UPDATE rifas SET status = 'PAGO', reservado_em = NULL 
                              WHERE external_reference = $1 AND status = 'RESERVADO'`, 
                              [externalRef]);

        } else if (status === 'rejected' || status === 'cancelled' || status === 'refunded') {
            console.log(`--- ALERTA: PAGAMENTO RECUSADO/CANCELADO/DEVOLVIDO. ---`);
            await pool.query(`UPDATE rifas SET status = 'DISPONIVEL', comprador_nome = NULL, 
                                comprador_telefone = NULL, comprador_email = NULL, comprador_cpf = NULL, 
                                external_reference = NULL, payment_id = NULL, reservado_em = NULL 
                                WHERE external_reference = $1 AND status = 'RESERVADO'`, 
                                [externalRef]);
        }
        
        res.status(200).send('Notificação processada.');

    } catch (error) {
        console.error('ERRO NO PROCESSAMENTO DO WEBHOOK:', error.message);
        res.status(500).send('Erro no servidor.');
    }
});


// Rota /status/:externalRef (Polling do frontend)
app.get('/status/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    
    try {
        // 12. db.get() vira pool.query()
        // O resultado vem em 'rows[0]'
        const { rows } = await pool.query("SELECT status, payment_id FROM rifas WHERE external_reference = $1", [externalRef]);
        const row = rows[0]; // Pega a primeira (e única) linha
        
        if (!row) {
            return res.status(404).json({ status: 'cancelled', message: 'Referência não encontrada ou expirada.' });
        }
        
        if (row.status === 'PAGO') return res.json({ status: 'approved', message: 'Pagamento confirmado!' });
        if (row.status === 'DISPONIVEL') return res.json({ status: 'cancelled', message: 'Pagamento expirou ou falhou.' });

        if (row.status === 'RESERVADO' && row.payment_id) {
            try {
                // Converte payment_id (bigint) para string
                const paymentInfo = await paymentClient.get({ id: String(row.payment_id) }); 
                return res.json({ status: paymentInfo.status, message: 'Aguardando pagamento...' });
            } catch (mpError) {
                console.error("Erro ao consultar MP no polling:", mpError.message);
                return res.json({ status: 'RESERVADO', message: 'Aguardando pagamento (MP consulta falhou)...' });
            }
        }

        return res.json({ status: row.status });

    } catch (error) {
        console.error("Erro em /status:", error.stack);
        res.status(500).json({ status: 'error', message: 'Erro interno ao verificar status.' });
    }
});

// =================================================================
// 4. ROTA "MINHAS RIFAS"
// =================================================================

app.get('/minhas-rifas/:telefone', async (req, res) => {
    const { telefone } = req.params;
    
    if (!telefone) {
        return res.status(400).json({ error: 'Telefone é obrigatório.' });
    }

    try {
        // 13. Query atualizada para $1
        const { rows } = await pool.query(
            `SELECT numero, status FROM rifas WHERE comprador_telefone = $1 AND status IN ('PAGO', 'RESERVADO') ORDER BY numero`,
            [telefone]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ error: 'Nenhum número encontrado para este telefone.' });
        }
        
        res.json(rows);

    } catch (err) {
        console.error("Erro ao buscar rifas do comprador:", err.stack);
        res.status(500).json({ error: 'Erro ao buscar dados da rifa.' });
    }
});


// =================================================================
// 5. ROTAS DE TESTE (ADMIN)
// =================================================================

app.get('/admin/approve/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    try {
        console.log(`[TESTE ADMIN] Forçando aprovação para: ${externalRef}`);
        
        // 14. db.run() vira pool.query()
        // result.changes vira result.rowCount
        const result = await pool.query(`UPDATE rifas SET status = 'PAGO', reservado_em = NULL 
                                         WHERE external_reference = $1 AND status = 'RESERVADO'`, 
                                         [externalRef]);

        if (result.rowCount > 0) { // 15. Mudança de 'changes' para 'rowCount'
            res.send(`Pagamento ${externalRef} APROVADO com sucesso no banco de dados!`);
        } else {
            res.status(404).send(`Nenhuma rifa RESERVADA encontrada para ${externalRef}.`);
        }

    } catch (error) {
        res.status(500).send(`Erro ao aprovar: ${error.message}`);
    }
});

app.get('/admin/reject/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    try {
        console.log(`[TESTE ADMIN] Forçando rejeição para: ${externalRef}`);

        const result = await pool.query(`UPDATE rifas SET status = 'DISPONIVEL', comprador_nome = NULL, 
                                            comprador_telefone = NULL, comprador_email = NULL, comprador_cpf = NULL, 
                                            external_reference = NULL, payment_id = NULL, reservado_em = NULL 
                                            WHERE external_reference = $1 AND status = 'RESERVADO'`, 
                                            [externalRef]);
        
        if (result.rowCount > 0) { // 16. Mudança de 'changes' para 'rowCount'
            res.send(`Pagamento ${externalRef} REJEITADO com sucesso. Números liberados!`);
        } else {
            res.status(404).send(`Nenhuma rifa RESERVADA encontrada para ${externalRef}.`);
        }

    } catch (error) {
        res.status(500).send(`Erro ao rejeitar: ${error.message}`);
    }
});


// =================================================================
// 6. FUNÇÃO "JANITOR" PARA LIMPAR RESERVAS EXPIRADAS
// =================================================================

async function limparReservasExpiradas() {
    // 17. A sintaxe de data/hora do Postgres é mais robusta
    // '1 hour' é um intervalo entendido pelo Postgres
    
    try {
        // 18. Query de limpeza atualizada
        // Compara reservado_em com o tempo atual MENOS 1 hora
        const result = await pool.query(
            `UPDATE rifas 
             SET status = 'DISPONIVEL', comprador_nome = NULL, 
                 comprador_telefone = NULL, comprador_email = NULL, comprador_cpf = NULL, 
                 external_reference = NULL, payment_id = NULL, reservado_em = NULL
             WHERE status = 'RESERVADO' 
               AND reservado_em IS NOT NULL 
               AND reservado_em <= (NOW() - INTERVAL '1 hour')`
        );

        if (result.rowCount > 0) {
            console.log(`[JANITOR] Limpou ${result.rowCount} reservas expiradas (mais de 1 hora).`);
        }

    } catch (err) {
        console.error('[JANITOR] Erro ao limpar reservas expiradas:', err.stack);
    }
}


// =================================================================
// INICIALIZAÇÃO DO SERVIDOR
// =================================================================
async function startServer() {
    try {
        // Tenta conectar ao banco de dados primeiro
        await pool.query('SELECT NOW()'); // Query simples para testar a conexão
        console.log('✅ Conexão com PostgreSQL estabelecida.');

        // Se conectar, inicializa o banco/tabelas
        await initializeDatabase();
        
        // Inicializa o Mercado Pago
        initializeMercadoPago();
        
        // Inicia o "Janitor" para rodar a cada 5 minutos
        setInterval(limparReservasExpiradas, 5 * 60 * 1000);
        limparReservasExpiradas(); // Roda uma vez na inicialização

        // Inicia o servidor Express
        app.listen(port, () => {
            console.log(`🚀 Servidor rodando na porta ${port}`);
        });

    } catch (err) {
        console.error("❌ Falha fatal ao inicializar o servidor:", err.stack);
        process.exit(1); // Encerra o processo se não conseguir conectar ao BD
    }
}

startServer();