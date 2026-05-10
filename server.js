require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const EfiPay = require('sdk-node-apis-efi');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

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

app.post('/efi-webhook', async (req, res) => {
  try {
    console.log('Webhook Efí recebido:', JSON.stringify(req.body, null, 2));

    const pixList = req.body?.pix || [];

    for (const pix of pixList) {
      const txid = pix.txid;
      const endToEndId = pix.endToEndId;
      const valor = pix.valor;
      const horario = pix.horario;

      console.log('Pagamento Pix confirmado:', {
        txid,
        endToEndId,
        valor,
        horario,
      });

      // AQUI você deve chamar seu banco/site para:
      // 1. localizar pedido pelo txid
      // 2. impedir pedido órfão
      // 3. impedir duplicidade
      // 4. marcar pedido como pago
      // 5. disparar Meta CAPI / UTMify / página de obrigado
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook Efí:', err);
    return res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Efí Pix rodando na porta ${PORT}`);
});
