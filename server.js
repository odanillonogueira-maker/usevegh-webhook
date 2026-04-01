require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const cron    = require('node-cron');

const app  = express();
app.use(express.json());

const CONFIG = {
  STORE_ID:       process.env.STORE_ID,
  ACCESS_TOKEN:   process.env.ACCESS_TOKEN,
  APP_SECRET:     process.env.APP_SECRET,
  PORT:           process.env.PORT || 3000,
  LAILLA_WEBHOOK: 'https://api.lailla.io/v1/webhook/custom/ca99377e-6d7b-49c7-80b6-82ded8e41318',
  API_URL:        () => `https://api.nuvemshop.com.br/2025-03/${process.env.STORE_ID}`,
  USER_AGENT:     'UseVegh Abandoned Cart (contato@usevegh.com.br)',
};

const processedCheckouts = new Set();

async function listAbandonedCheckouts() {
  const { data } = await axios.get(`${CONFIG.API_URL()}/checkouts`, {
    headers: {
      'Authentication': `bearer ${CONFIG.ACCESS_TOKEN}`,
      'User-Agent':     CONFIG.USER_AGENT,
      'Content-Type':   'application/json',
    },
    params: { per_page: 50 },
  });
  return data;
}

async function getAbandonedCheckout(id) {
  const { data } = await axios.get(`${CONFIG.API_URL()}/checkouts/${id}`, {
    headers: {
      'Authentication': `bearer ${CONFIG.ACCESS_TOKEN}`,
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
  runPolling();
});
