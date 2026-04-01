require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cron    = require('node-cron');

const app = express();
app.use(express.json());

const CONFIG = {
  CLIENT_ID:      process.env.CLIENT_ID     || '28831',
  CLIENT_SECRET:  process.env.CLIENT_SECRET || '32cb626130c1c3597f55621fbe05871bd3a49e4a5f4397d1',
  STORE_ID:       process.env.STORE_ID,
  ACCESS_TOKEN:   process.env.ACCESS_TOKEN,
  PORT:           process.env.PORT || 3000,
  LAILLA_WEBHOOK: 'https://api.lailla.io/v1/webhook/custom/ca99377e-6d7b-49c7-80b6-82ded8e41318',
  API_URL:        () => `https://api.nuvemshop.com.br/2025-03/${process.env.STORE_ID}`,
  USER_AGENT:     'UseVegh Abandoned Cart (contato@usevegh.com.br)',
};

const processedCheckouts = new Set();

app.get('/auth/callback', async (req, res) => {
  const { code, user_id } = req.query;

  console.log(`\n🔑 Callback recebido!`);
  console.log(`   user_id (store_id): ${user_id}`);
  console.log(`   code: ${code}`);

  if (!code || !user_id) {
    return res.send('❌ Parâmetros ausentes. Tente reinstalar o app.');
  }

  try {
    const { data } = await axios.post(
      'https://www.nuvemshop.com.br/apps/authorize/token',
      {
        client_id:     CONFIG.CLIENT_ID,
        client_secret: CONFIG.CLIENT_SECRET,
        grant_type:    'authorization_code',
        code:          code,
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const token = data.access_token || data.token || JSON.stringify(data);;

    console.log(`\n✅ ACCESS_TOKEN GERADO!`);
    console.log(`   STORE_ID:     ${user_id}`);
    console.log(`   ACCESS_TOKEN: ${token}`);

    return res.send(`
      <html>
        <body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
          <h2>✅ Token gerado com sucesso!</h2>
          <p>Copie esses valores e salve nas variáveis do Railway:</p>
          <p><strong>STORE_ID:</strong><br>
            <input style="width:100%;padding:8px;font-size:14px" value="${user_id}" readonly onclick="this.select()">
          </p>
          <p><strong>ACCESS_TOKEN:</strong><br>
            <input style="width:100%;padding:8px;font-size:14px" value="${token}" readonly onclick="this.select()">
          </p>
          <p style="color:gray;font-size:13px">Clique em cada campo para selecionar e copie com Cmd+C</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Erro ao gerar token:', err.response?.data || err.message);
    return res.send(`❌ Erro: ${JSON.stringify(err.response?.data || err.message)}`);
  }
});

async function listAbandonedCheckouts() {
  const { data } = await axios.get(`${CONFIG.API_URL()}/checkouts`, {
    headers: {
      'Authentication': `bearer ${process.env.ACCESS_TOKEN}`,
      'User-Agent':     CONFIG.USER_AGENT,
    },
    params: { per_page: 50 },
  });
  return data;
}

async function getAbandonedCheckout(id) {
  const { data } = await axios.get(`${CONFIG.API_URL()}/checkouts/${id}`, {
    headers: {
      'Authentication': `bearer ${process.env.ACCESS_TOKEN}`,
      'User-Agent':     CONFIG.USER_AGENT,
    },
  });
  return data;
}

function buildPayload(checkout) {
  const products = (checkout.line_items || []).map(item => ({
    nome:       item.name,
    quantidade: item.quantity,
    preco:      item.price,
  }));
  return {
    evento:           'carrinho_abandonado',
    loja:             'usevegh.com.br',
    checkout_id:      checkout.id,
    comprador: {
      nome:     checkout.contact_name  || null,
      email:    checkout.contact_email || null,
      telefone: checkout.contact_phone || null,
    },
    produtos:         products,
    financeiro: {
      subtotal: checkout.subtotal,
      total:    checkout.total,
      moeda:    checkout.currency || 'BRL',
    },
    link_recuperacao: checkout.abandoned_checkout_url || null,
  };
}

async function sendToLailla(payload) {
  try {
    const res = await axios.post(CONFIG.LAILLA_WEBHOOK, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
    console.log(`✅ Enviado para Lailla | checkout ${payload.checkout_id} | status ${res.status}`);
    return true;
  } catch (err) {
    console.error(`❌ Erro ao enviar | checkout ${payload.checkout_id}:`, err.message);
    return false;
  }
}

async function processCheckout(id) {
  if (processedCheckouts.has(String(id))) return;
  try {
    const checkout = await getAbandonedCheckout(id);
    if (!checkout.contact_email) return;
    const payload = buildPayload(checkout);
    const sent    = await sendToLailla(payload);
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
    if (!checkouts || checkouts.length === 0) {
      console.log('📭 Nenhum carrinho abandonado.');
      return;
    }
    console.log(`📦 ${checkouts.length} carrinho(s) encontrado(s).`);
    for (const c of checkouts) await processCheckout(c.id);
  } catch (err) {
    console.error('❌ Erro no polling:', err.message);
  }
}

cron.schedule('*/30 * * * *', runPolling);

app.post('/webhook/nuvemshop', (req, res) => {
  res.status(200).json({ ok: true });
  console.log(`📨 Webhook recebido | evento: ${req.body.event}`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', loja: 'usevegh.com.br', hora: new Date().toLocaleString('pt-BR') });
});

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${CONFIG.PORT}`);
  console.log(`🏪 Loja: usevegh.com.br → Lailla`);
  console.log(`🔑 Aguardando autenticação em /auth/callback`);
  runPolling();
});
