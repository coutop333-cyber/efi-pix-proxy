require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const EfiPay = require('sdk-node-apis-efi');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = 'https://efi-pix-proxy-ec0d.onrender.com/efi-webhook?ignorar=';

const efipay = new EfiPay({
  client_id: process.env.EFI_CLIENT_ID,
  client_secret: process.env.EFI_CLIENT_SECRET,
  sandbox: false,
  certificate: './certificate.p12',
});

function gerarTxid() {
  return crypto.randomBytes(16).toString('hex');
}

function formatarValor(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new Error('Valor inválido');
  }
  return numero.toFixed(2);
}

async function ensureEfiWebhook() {
  const chave = process.env.EFI_PIX_KEY;

  if (!chave) {
    console.error('[efi-webhook] EFI_PIX_KEY não configurada');
    return;
  }

  try {
    try {
      const atual = await efipay.pixDetailWebhook({ chave });

      if (atual?.webhookUrl === WEBHOOK_URL) {
        console.log('[efi-webhook] já configurado:', WEBHOOK_URL);
        return;
      }
    } catch (_) {}

    const res = await efipay.pixConfigWebhook(
      { chave },
      { webhookUrl: WEBHOOK_URL },
      {
        headers: {
          'x-skip-mtls-checking': 'true',
        },
      }
    );

    console.log('[efi-webhook] configurado com sucesso:', res);
  } catch (err) {
    console.error('[efi-webhook] erro ao configurar:', err?.response?.data || err);
  }
}

async function processarWebhookEfi(req, res) {
  try {
    console.log('Webhook Efí recebido:', JSON.stringify(req.body, null, 2));

    const pixList = req.body?.pix || [];

    for (const pix of pixList) {
      const payload = {
        txid: pix.txid,
        endToEndId: pix.endToEndId,
        valor: pix.valor,
        horario: pix.horario,
        status: 'paid',
      };

      console.log('Pagamento Pix confirmado:', payload);

      // Futuro: aqui você pode avisar a Lovable/checkout:
      // await fetch('SUA_URL_DA_LOVABLE/api/confirmar-pagamento-efi', {
      //   method: 'POST',
      //   headers: { 'Content-Type': 'application/json' },
      //   body: JSON.stringify(payload),
      // });
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook Efí:', err);
    return res.sendStatus(500);
  }
}

app.get('/', (req, res) => {
  res.json({
    online: true,
    service: 'efi-pix-proxy',
    message: 'Backend Efí Pix online',
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post('/admin/setup-webhook', async (req, res) => {
  await ensureEfiWebhook();

  res.json({
    ok: true,
    webhookUrl: WEBHOOK_URL,
  });
});

app.post('/create-pix', async (req, res) => {
  try {
    const {
      valor,
      pedidoId,
      nome,
      email,
      telefone,
      produto,
      utms,
      fbclid,
      fbp,
      fbc,
      event_id,
    } = req.body;

    if (!valor) {
      return res.status(400).json({ error: true, message: 'Valor obrigatório' });
    }

    if (!pedidoId) {
      return res.status(400).json({ error: true, message: 'pedidoId obrigatório' });
    }

    if (!process.env.EFI_PIX_KEY) {
      return res.status(500).json({ error: true, message: 'EFI_PIX_KEY não configurada' });
    }

    const txid = gerarTxid();
    const valorFormatado = formatarValor(valor);

    const body = {
      calendario: {
        expiracao: 3600,
      },
      valor: {
        original: valorFormatado,
      },
      chave: process.env.EFI_PIX_KEY,
      solicitacaoPagador: `Pedido ${pedidoId}`,
      infoAdicionais: [
        {
          nome: 'pedidoId',
          valor: String(pedidoId).slice(0, 72),
        },
        {
          nome: 'produto',
          valor: String(produto || 'Produto').slice(0, 72),
        },
      ],
    };

    const params = { txid };

    const cobranca = await efipay.pixCreateCharge(params, body);

    if (!cobranca.loc || !cobranca.loc.id) {
      throw new Error('Efí não retornou loc.id da cobrança');
    }

    ensureEfiWebhook().catch(console.error);

    const qr = await efipay.pixGenerateQRCode({ id: cobranca.loc.id });

    return res.json({
      success: true,
      provider: 'efi',
      status: 'pending',
      pedidoId,
      txid: cobranca.txid || txid,
      locId: cobranca.loc.id,
      valor: valorFormatado,
      qrCodeImage: qr.imagemQrcode,
      pixCopiaECola: qr.qrcode,
      expiresIn: 3600,
      tracking: {
        utms,
        fbclid,
        fbp,
        fbc,
        event_id,
      },
      customer: {
        nome,
        email,
        telefone,
      },
    });
  } catch (err) {
    console.error('Erro ao criar Pix Efí:', err);

    return res.status(500).json({
      error: true,
      message: err.message || 'Erro interno ao criar Pix',
      details: err.response?.data || null,
    });
  }
});

app.post('/efi-webhook', processarWebhookEfi);
app.post('/efi-webhook/pix', processarWebhookEfi);

app.listen(PORT, () => {
  console.log(`Servidor Efí Pix rodando na porta ${PORT}`);
  ensureEfiWebhook().catch(console.error);
});
