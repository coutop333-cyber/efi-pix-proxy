require('dotenv').config();

const express = require('express');
const cors = require('cors');
const EfiPay = require('sdk-node-apis-efi');

const app = express();

app.use(cors());
app.use(express.json());

const options = {
  client_id: process.env.EFI_CLIENT_ID,
  client_secret: process.env.EFI_CLIENT_SECRET,
  sandbox: false,
  certificate: './certificate.p12'
};

const efipay = new EfiPay(options);

app.post('/create-pix', async (req, res) => {
  try {
    const { valor, pedidoId } = req.body;

    const body = {
      calendario: {
        expiracao: 3600
      },
      valor: {
        original: valor
      },
      chave: process.env.EFI_PIX_KEY,
      solicitacaoPagador: `Pedido ${pedidoId}`
    };

    const response = await efipay.pixCreateImmediateCharge([], body);

    const qr = await efipay.pixGenerateQRCode({
      id: response.loc.id
    });

    res.json({
      txid: response.txid,
      qrCode: qr.imagemQrcode,
      copiaecola: qr.qrcode
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: true,
      message: err.message
    });
  }
});

app.post('/efi-webhook', async (req, res) => {
  console.log('Webhook recebido:', req.body);

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
