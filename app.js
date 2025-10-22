import 'dotenv/config';
import express from 'express';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import cors from 'cors';
import * as sqlite from 'sqlite';
import sqlite3 from 'sqlite3';

const app = express();
const port = process.env.PORT || 3000;
const VALOR_UNITARIO_RIFA = 3.00; 

let db; 
let paymentClient; 

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || "SEU_ACCESS_TOKEN_REAL_DE_TESTE_AQUI"; 

// =================================================================
// Configurações do Middleware
// =================================================================
app.use(cors()); 
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

async function initializeDatabase() {
    try {
        db = await sqlite.open({ filename: './rifas.db', driver: sqlite3.Database });
        console.log('Conectado ao banco de dados SQLite.');

        await db.run(`CREATE TABLE IF NOT EXISTS rifas (
            numero INTEGER PRIMARY KEY,
            status TEXT NOT NULL,       -- 'DISPONIVEL', 'RESERVADO', 'PAGO'
            comprador_nome TEXT,
            comprador_telefone TEXT,
            comprador_email TEXT,
            comprador_cpf TEXT,         
            external_reference TEXT,    
            payment_id INTEGER,
            reservado_em TEXT           -- Campo para guardar o timestamp da reserva
        )`);

        // Verifica se a tabela já existia e precisa da nova coluna
        const tableInfo = await db.all("PRAGMA table_info(rifas)");
        const columnExists = tableInfo.some(col => col.name === 'reservado_em');

        if (!columnExists) {
            console.log('Adicionando coluna "reservado_em" à tabela...');
            await db.run('ALTER TABLE rifas ADD COLUMN reservado_em TEXT');
        }

        const row = await db.get("SELECT COUNT(*) as count FROM rifas");
        
        if (row && row.count === 0) {
            console.log("Inicializando 100 números da rifa...");
            for (let i = 1; i <= 100; i++) {
                await db.run(`INSERT INTO rifas (numero, status) VALUES (?, 'DISPONIVEL')`, [i]);
            }
            console.log("Números inicializados.");
        }
        return true;

    } catch (err) {
        console.error("ERRO CRÍTICO NA INICIALIZAÇÃO DO BANCO DE DADOS:", err.message);
        return false;
    }
}

function initializeMercadoPago() {
    if (!ACCESS_TOKEN || ACCESS_TOKEN === "SEU_ACCESS_TOKEN_REAL_DE_TESTE_AQUI") {
        console.error("ERRO CRÍTICO: Por favor, configure o ACCESS_TOKEN no seu .env");
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
        const rows = await db.all("SELECT numero, status, comprador_nome, comprador_telefone, comprador_email FROM rifas ORDER BY numero");
        res.json(rows); 
    } catch (err) {
        res.status(500).json({ error: 'Erro ao buscar dados da rifa.' });
    }
});

// Rota para GERAÇÃO DO PIX e RESERVA
app.post('/reservar', async (req, res) => {
    const { numeros, nome, telefone, email, cpf } = req.body; 

    if (!numeros || numeros.length === 0 || !nome || !telefone || !email || !cpf) {
        return res.status(400).json({ error: 'Dados obrigatórios faltando ou nenhum número selecionado.' });
    }

    const external_reference = `ORDEM-${Date.now()}`; 
    const cleanCpf = cpf.replace(/\D/g, '');
    const transaction_amount = VALOR_UNITARIO_RIFA * numeros.length; 
    const numerosRifa = numeros.map(n => parseInt(n));

    try {
        // 1. VERIFICAR A DISPONIBILIDADE
        const placeholders = numerosRifa.map(() => '?').join(',');
        const query = `SELECT numero, status FROM rifas WHERE numero IN (${placeholders})`;
        const rows = await db.all(query, numerosRifa);
        
        const indisponiveis = rows.filter(row => row.status !== 'DISPONIVEL');

        if (indisponiveis.length > 0) {
            return res.status(409).json({ 
                error: 'Alguns números não estão disponíveis.',
                numeros: indisponiveis.map(r => `Nº ${r.numero} (${r.status})`)
            });
        }
        
        // 2. CRIA O PAGAMENTO PIX
        const body = {
            transaction_amount: transaction_amount,
            description: `Rifa(s) - Total de ${numerosRifa.length} números`,
            payment_method_id: 'pix', 
            external_reference: external_reference, 
            payer: { email: email, identification: { type: 'CPF', number: cleanCpf } }
        };

        const payment = await paymentClient.create({ body });
        
        // 3. MARCA TODOS OS NÚMEROS COMO RESERVADOS NO BD
        const agoraISO = new Date().toISOString(); // Timestamp da reserva

        const updatePromises = numerosRifa.map(numeroRifa => {
            return db.run(`UPDATE rifas SET status = 'RESERVADO', comprador_nome = ?, comprador_telefone = ?, 
                            comprador_email = ?, comprador_cpf = ?, external_reference = ?, payment_id = ?,
                            reservado_em = ? 
                           WHERE numero = ?`,
                [nome, telefone, email, cleanCpf, external_reference, payment.id, agoraISO, numeroRifa]);
        });
        await Promise.all(updatePromises);


        // 4. Retorna os dados do PIX para a página 'pagamento.html'
        res.json({
            success: true,
            status: payment.status, 
            external_reference: external_reference,
            payment_id: payment.id,
            qr_code_base64: payment.point_of_interaction.transaction_data.qr_code_base64,
            qr_code: payment.point_of_interaction.transaction_data.qr_code,
            // Envia os dados do comprador de volta para salvar no localStorage
            comprador: { nome, telefone, email, cpf } 
        });

    } catch (error) {
        console.error('ERRO CRÍTICO no fluxo de reserva/pagamento:', error.message || error);
        
        // Tenta liberar reservas parciais em caso de falha
        if (external_reference.startsWith('ORDEM-')) {
             await db.run(`UPDATE rifas SET status = 'DISPONIVEL', comprador_nome = NULL, 
                             comprador_telefone = NULL, comprador_email = NULL, comprador_cpf = NULL, 
                             external_reference = NULL, payment_id = NULL, reservado_em = NULL 
                           WHERE external_reference = ?`, [external_reference]);
        }
        
        res.status(500).json({ error: 'Falha ao processar a compra. Tente novamente.' });
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

        console.log(`[WEBHOOK] Status Retornado: ${status}, Ref. Externa: ${externalRef}`);

        if (status === 'approved') {
            console.log(`--- SUCESSO: PAGAMENTO APROVADO! ---`);
            await db.run(`UPDATE rifas SET status = 'PAGO', reservado_em = NULL 
                          WHERE external_reference = ? AND status = 'RESERVADO'`, 
                [externalRef]);

        } else if (status === 'rejected' || status === 'cancelled' || status === 'refunded') {
             console.log(`--- ALERTA: PAGAMENTO RECUSADO/CANCELADO/DEVOLVIDO. ---`);
             await db.run(`UPDATE rifas SET status = 'DISPONIVEL', comprador_nome = NULL, 
                             comprador_telefone = NULL, comprador_email = NULL, comprador_cpf = NULL, 
                             external_reference = NULL, payment_id = NULL, reservado_em = NULL 
                           WHERE external_reference = ? AND status = 'RESERVADO'`, 
                           [externalRef]);
        }
        
        res.status(200).send('Notificação processada.');

    } catch (error) {
        console.error('ERRO NO PROCESSAMENTO DO WEBHOOK: Falha ao consultar MP API.', error);
        res.status(500).send('Erro no servidor.');
    }
});


// Rota /status/:externalRef (Polling do frontend)
app.get('/status/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    
    try {
        // Busca o status diretamente do nosso banco de dados
        const row = await db.get("SELECT status, payment_id FROM rifas WHERE external_reference = ?", [externalRef]);
        
        if (!row) {
            // Se não encontrou, pode ter sido limpo pelo Janitor (expirou)
            return res.status(404).json({ status: 'cancelled', message: 'Referência não encontrada ou expirada.' });
        }
        
        // Se o webhook já processou, retorna o status final
        if (row.status === 'PAGO') return res.json({ status: 'approved', message: 'Pagamento confirmado!' });
        if (row.status === 'DISPONIVEL') return res.json({ status: 'cancelled', message: 'Pagamento expirou ou falhou.' });

        // Se ainda está RESERVADO, consulta o MP para um status em tempo real
        if (row.status === 'RESERVADO' && row.payment_id) {
            try {
                const paymentInfo = await paymentClient.get({ id: row.payment_id });
                // Retorna o status atualizado do MP
                return res.json({ status: paymentInfo.status, message: 'Aguardando pagamento...' });
            } catch (mpError) {
                console.error("Erro ao consultar MP no polling:", mpError.message);
                return res.json({ status: 'RESERVADO', message: 'Aguardando pagamento (MP consulta falhou)...' });
            }
        }

        return res.json({ status: row.status });

    } catch (error) {
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
        // Busca por números PAGOS ou RESERVADOS (para o caso de ainda estar pendente)
        const rows = await db.all(
            `SELECT numero, status FROM rifas WHERE comprador_telefone = ? AND status IN ('PAGO', 'RESERVADO') ORDER BY numero`,
            [telefone]
        );

        if (!rows || rows.length === 0) {
            return res.status(404).json({ error: 'Nenhum número encontrado para este telefone.' });
        }
        
        res.json(rows);

    } catch (err) {
        console.error("Erro ao buscar rifas do comprador:", err.message);
        res.status(500).json({ error: 'Erro ao buscar dados da rifa.' });
    }
});


// =================================================================
// 5. ROTAS DE TESTE (ADMIN)
// =================================================================

// Rota para APROVAR um pagamento manualmente (para testes)
app.get('/admin/approve/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    try {
        console.log(`[TESTE ADMIN] Forçando aprovação para: ${externalRef}`);
        
        const result = await db.run(`UPDATE rifas SET status = 'PAGO', reservado_em = NULL 
                                     WHERE external_reference = ? AND status = 'RESERVADO'`, 
            [externalRef]);

        if (result.changes > 0) {
            res.send(`Pagamento ${externalRef} APROVADO com sucesso no banco de dados! A página de pagamento deve atualizar.`);
        } else {
            res.status(404).send(`Nenhuma rifa RESERVADA encontrada para ${externalRef}. (Já pode ter sido PAGA ou não existe).`);
        }

    } catch (error) {
        res.status(500).send(`Erro ao aprovar: ${error.message}`);
    }
});

// Rota para REJEITAR um pagamento manualmente (para testes)
app.get('/admin/reject/:externalRef', async (req, res) => {
    const externalRef = req.params.externalRef;
    try {
        console.log(`[TESTE ADMIN] Forçando rejeição para: ${externalRef}`);

        const result = await db.run(`UPDATE rifas SET status = 'DISPONIVEL', comprador_nome = NULL, 
                                        comprador_telefone = NULL, comprador_email = NULL, comprador_cpf = NULL, 
                                        external_reference = NULL, payment_id = NULL, reservado_em = NULL 
                                    WHERE external_reference = ? AND status = 'RESERVADO'`, 
                                    [externalRef]);
        
        if (result.changes > 0) {
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
    // Define o tempo limite (1 hora em milissegundos)
    const HORA_EM_MS = 1 * 60 * 60 * 1000; 
    // const HORA_EM_MS = 60 * 1000; // (Para TESTAR: 1 minuto)
    
    // Calcula o timestamp de 1 hora atrás
    const umaHoraAtrasISO = new Date(Date.now() - HORA_EM_MS).toISOString();

    try {
        // Busca e atualiza todas as rifas que estão:
        // 1. Com status "RESERVADO"
        // 2. Não estão nulas (segurança)
        // 3. Foram reservadas ANTES do timestamp de 1 hora atrás
        const result = await db.run(
            `UPDATE rifas 
             SET status = 'DISPONIVEL', comprador_nome = NULL, 
                 comprador_telefone = NULL, comprador_email = NULL, comprador_cpf = NULL, 
                 external_reference = NULL, payment_id = NULL, reservado_em = NULL
             WHERE status = 'RESERVADO' 
               AND reservado_em IS NOT NULL 
               AND reservado_em <= ?`,
            [umaHoraAtrasISO]
        );

        if (result.changes > 0) {
            console.log(`[JANITOR] Limpou ${result.changes} reservas expiradas (mais de 1 hora).`);
        }

    } catch (err) {
        console.error('[JANITOR] Erro ao limpar reservas expiradas:', err.message);
    }
}


await initializeDatabase();
initializeMercadoPago();
setInterval(limparReservasExpiradas, 5 * 60 * 1000);

app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
});
