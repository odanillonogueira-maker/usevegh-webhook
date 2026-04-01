require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cron    = require('node-cron');

const app = express();
app.use(express.json());

const CLIENT_ID = '28960';
const CLIENT_SECRET = 'b999208d96fd491814a446f507d31edec0e1b6f4ff14aae3';
const LAILLA_WEBHOOK = 'https://api.lailla.io/v1/webhook/custom/ca99377e-6d7b-49c7-80b6-82ded8e41318';
const USER_AGENT    = 'UseVegh Abandoned Cart (contato@usevegh.com.br)';

const processedCheckouts = new Set();

// ── Rota de callback OAuth ────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const code    = req.query.code;
  const user_id = req.query.user_id || CLIENT_ID;

  console.log(`\n🔑 Callback recebido!`);
  console.log(`   user_id: ${user_id}`);
  console.log(`   code: ${code}`);

  if (!code) {
    return res.send('<h2>❌ Código não encontrado na URL.</h2>');
  }

  try {
    const response = await axios({
      method: 'post',
      url: 'https://www.nuvemshop.com.br/apps/authorize/token',
      data: `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=authorization_code&code=${code}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.log('📦 Resposta completa:', JSON.stringify(response.data));

    const token = response.data.access_token;
    const storeId = response.data.user_id || user_id;

    if (!token) {
      return res.send(`<h2>❌ Token não retornado.</h2><pre>${JSON.stringify(response.data, null, 2)}</pre>`);
    }

    console.log(`✅ SUCESSO!`);
    console.log(`   STORE_ID: ${storeId}`);
    console.log(`   ACCESS_TOKEN: ${token}`);

    return res.send(`
      <html>
        <body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
          <h2>✅ Token gerado com sucesso!</h2>
          <p>Copie esses valores e salve nas variáveis do Railway:</p>
          <p><strong>STORE_ID:</strong><br>
            <input style="width:100%;padding:8px;font-size:14px" value="${storeId}" readonly onclick="this.select()">
          </p>
          <p><strong>ACCESS_TOKEN:</strong><br>
            <input style="width:100%;padding:8px;font-size:14px" value="${token}" readonly onclick="this.select()">
          </p>
          <p style="color:gray;font-size:13px">Clique em cada campo para selecionar e copie com Cmd+C</p>
        </body>
      </html>
    `);
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error('❌ Erro:', JSON.stringify(errData));
    return res.send(`<h2>❌ Erro ao gerar token</h2><pre>${JSON.stringify(errData, null, 2)}</pre>`);
  }
});

// ── Funções da API Nuvemshop ──────────────────────────────────
function apiUrl() {
  return `https://api.nuvemshop.com.br/2025-03/${process.env.STORE_ID}`;
}

async function listAbandonedCheckouts() {
  const { data } = await axios.get(`${apiUrl()}/checkouts`, {
    headers: { 'Authentication': `bearer ${process.env.ACCESS_TOKEN}`, 'User-Agent': USER_AGENT },
    params: { per_page: 50 },
  });
  return data;
}

async function getAbandonedCheckout(id) {
  const { data } = await axios.get(`${apiUrl()}/checkouts/${id}`, {
    headers: { 'Authentication': `bearer ${process.env.ACCESS_TOKEN}`, 'User-Agent': USER_AGENT },
  });
  return data;
}

function buildPayload(checkout) {
  const products = (checkout.line_items || []).map(item => ({
    nome: item.name, quantidade: item.quantity, preco: item.price,
  }));
  return {
    evento: 'carrinho_abandonado',
    loja: 'usevegh.com.br',
    checkout_id: checkout.id,
    comprador: {
      nome:     checkout.contact_name  || null,
      email:    checkout.contact_email || null,
      telefone: checkout.contact_phone || null,
    },
    produtos: products,
    financeiro: { subtotal: checkout.subtotal, total: checkout.total, moeda: checkout.currency || 'BRL' },
    link_recuperacao: checkout.abandoned_checkout_url || null,
  };
}

async function sendToLailla(payload) {
  try {
    const res = await axios.post(LAILLA_WEBHOOK, payload, {
      headers: { 'Content-Type': 'application/json' }, timeout: 10000,
    });
    console.log(`✅ Enviado para Lailla | checkout ${payload.checkout_id} | status ${res.status}`);
    return true;
  } catch (err) {
    console.error(`❌ Erro ao enviar:`, err.message);
    return false;
  }
}

async function processCheckout(id) {
  if (processedCheckouts.has(String(id))) return;
  try {
    const checkout = await getAbandonedCheckout(id);
    if (!checkout.contact_email) return;
    const sent = await sendToLailla(buildPayload(checkout));
    if (sent) {
      processedCheckouts.add(String(id));
      setTimeout(() => processedCheckouts.delete(String(id)), 48 * 60 * 60 * 1000);
    }
  } catch (err) {
    console.error(`❌ Erro ao processar checkout ${id}:`, err.message);
  }
}

async function runPolling() {
  if (!process.env.ACCESS_TOKEN || !process.env.STORE_ID) {
    console.log('⚠️  ACCESS_TOKEN ou STORE_ID não configurados. Aguardando...');
    return;
  }
  console.log(`\n🔍 [${new Date().toLocaleString('pt-BR')}] Verificando carrinhos abandonados...`);
  try {
    const checkouts = await listAbandonedCheckouts();
    if (!checkouts || checkouts.length === 0) { console.log('📭 Nenhum carrinho.'); return; }
    console.log(`📦 ${checkouts.length} carrinho(s).`);
    for (const c of checkouts) await processCheckout(c.id);
  } catch (err) {
    console.error('❌ Erro no polling:', err.message);
  }
}

cron.schedule('*/30 * * * *', runPolling);

app.post('/webhook/nuvemshop', (req, res) => {
  res.status(200).json({ ok: true });
  console.log(`📨 Webhook | evento: ${req.body.event}`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', loja: 'usevegh.com.br', hora: new Date().toLocaleString('pt-BR') });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🏪 Loja: usevegh.com.br → Lailla`);
  console.log(`🔑 Callback em /auth/callback`);
  runPolling();
});
