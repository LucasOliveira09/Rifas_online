import 'dotenv/config';
import express from 'express';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import cors from 'cors';
import pg from 'pg'; 

const app = express();
const port = process.env.PORT || 3000;
const VALOR_UNITARIO_RIFA = 3.00; 

let paymentClient; 

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "SEU_ACCESS_TOKEN_REAL_DE_TESTE_AQUI"; 

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } 
});

console.log("Tentando conectar ao PostgreSQL...");

app.use(cors()); 
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

async function initializeDatabase() {
    try {
        // 3. Conecta e cria a tabela (Sintaxe limpa, sem espaços inválidos)
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

        // 5. Verifica se está vazia
        const res = await pool.query("SELECT COUNT(*) as count FROM rifas");
        const row = res.rows[0];
        
        // 6. 'count' do Postgres pode vir como string '0'
        if (row && row.count == 0) { 
            console.log("Inicializando 100 números da rifa...");
            
            // 7. Insere os números
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
// ROTAS DA RIFA
// =================================================================

app.get('/rifas', async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT numero, status, comprador_nome, comprador_telefone, comprador_email FROM rifas ORDER BY numero");
        res.json(rows); 
    } catch (err) {
        console.error("Erro em /rifas:", err.stack);
        res.status(500).json({ error: 'Erro ao buscar dados da rifa.' });
    }
});

// ******** ESTA É A ROTA CORRIGIDA ********
app.post('/reservar', async (req, res) => {
    // 1. RECEBE APENAS NOME E TELEFONE
    const { numeros, nome, telefone } = req.body; 

    // 2. DADOS FICTÍCIOS OBRIGATÓRIOS PARA O MERCADO PAGO
    const DUMMY_EMAIL = "pagamento@rifa.com"; // Pode ser qualquer email
    const DUMMY_CPF = "26188102092"; // CPF de TESTE

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
                email: DUMMY_EMAIL, 
                identification: { type: 'CPF', number: cleanCpf }
            }
        };

        const payment = await paymentClient.create({ body });
        
        const agoraISO = new Date(); 

        // 6. ATUALIZA O BANCO DE DADOS (QUERY LIMPA)
        // Esta query foi reescrita para remover espaços inválidos
        const updateQuery = `UPDATE rifas SET 
                                status = 'RESERVADO', 
                                comprador_nome = $1, 
                                comprador_telefone = $2, 
                                comprador_email = NULL, 
                                comprador_cpf = NULL, 
                                external_reference = $3, 
                                payment_id = $4,
                                reservado_em = $5 
                             WHERE numero = $6`;
                            
        const updatePromises = numerosRifa.map(numeroRifa => {
            return client.query(updateQuery, [nome, telefone, external_reference, payment.id, agoraISO, numeroRifa]);
        });
        await Promise.all(updatePromises);

        await client.query('COMMIT');

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
// ******** FIM DA ROTA CORRIGIDA ********


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


app.get('/status/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    
    try {
        const { rows } = await pool.query("SELECT status, payment_id FROM rifas WHERE external_reference = $1", [externalRef]);
        const row = rows[0];
        
        if (!row) {
            return res.status(404).json({ status: 'cancelled', message: 'Referência não encontrada ou expirada.' });
        }
        
        if (row.status === 'PAGO') return res.json({ status: 'approved', message: 'Pagamento confirmado!' });
        if (row.status === 'DISPONIVEL') return res.json({ status: 'cancelled', message: 'Pagamento expirou ou falhou.' });

        if (row.status === 'RESERVADO' && row.payment_id) {
            try {
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

app.get('/minhas-rifas/:telefone', async (req, res) => {
    const { telefone } = req.params;
    
    if (!telefone) {
        return res.status(400).json({ error: 'Telefone é obrigatório.' });
    }

    try {
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

app.get('/admin/approve/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    try {
        console.log(`[TESTE ADMIN] Forçando aprovação para: ${externalRef}`);
        const result = await pool.query(`UPDATE rifas SET status = 'PAGO', reservado_em = NULL 
                                         WHERE external_reference = $1 AND status = 'RESERVADO'`, 
                                         [externalRef]);

        if (result.rowCount > 0) { 
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
        
        if (result.rowCount > 0) {
            res.send(`Pagamento ${externalRef} REJEITADO com sucesso. Números liberados!`);
        } else {
            res.status(404).send(`Nenhuma rifa RESERVADA encontrada para ${externalRef}.`);
        }
    } catch (error) {
        res.status(500).send(`Erro ao rejeitar: ${error.message}`);
    }
});

async function limparReservasExpiradas() {
    try {
        // Query de limpeza reescrita para remover caracteres inválidos
        const result = await pool.query(
            `UPDATE rifas 
             SET status = 'DISPONIVEL', 
                 comprador_nome = NULL, 
                 comprador_telefone = NULL, 
                 comprador_email = NULL, 
                 comprador_cpf = NULL, 
                 external_reference = NULL, 
                 payment_id = NULL, 
                 reservado_em = NULL
             WHERE status = 'RESERVADO' 
               AND reservado_em IS NOT NULL 
               AND reservado_em <= (NOW() - INTERVAL '1 hour')`
        );

        if (result.rowCount > 0) {
            console.log(`[JANITOR] Limpou ${result.rowCount} reservas expiradas (mais de 1 hora).`);
        }

    } catch (err) {
        console.error('[JANITOR] Erro ao limpar reservas expiradas:', err.stack); // Mudei para .stack para mais detalhes
    }
}

async function startServer() {
    try {
        await pool.query('SELECT NOW()');
        console.log('✅ Conexão com PostgreSQL estabelecida.');
        await initializeDatabase();
        initializeMercadoPago();
        setInterval(limparReservasExpiradas, 5 * 60 * 1000);
        limparReservasExpiradas(); 
        app.listen(port, () => {
            console.log(`🚀 Servidor rodando na porta ${port}`);
        });
    } catch (err) {
        console.error("❌ Falha fatal ao inicializar o servidor:", err.stack);
        process.exit(1); 
    }
}

startServer();