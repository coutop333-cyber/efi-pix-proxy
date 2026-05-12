
require('dotenv').config();
 
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const EfiPay = require('sdk-node-apis-efi');
 
const app = express();
 
app.use(cors());
app.use(express.json({ limit: '2mb' }));
 
const PORT = process.env.PORT || 3000;
 
// FALLBACKS antigos (nao quebrar loja antiga se um dia main puxar daqui)
const DEFAULT_LOVABLE_RELAY_URL =
  'https://casacosmeticos.shop/api/public/efi-pago';
 
const PUBLIC_PROXY_URL =
  process.env.PUBLIC_PROXY_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  'https://efi-pix-proxy-1.onrender.com';
 
const WEBHOOK_URL =
  process.env.EFI_WEBHOOK_URL ||
  `${PUBLIC_PROXY_URL}/efi-webhook`;
 
// (2) Defesa: nunca enviar relay para www. — se a env vier com www, remove
const LOVABLE_RELAY_URL = (
  process.env.SITE_WEBHOOK_URL ||
  process.env.LOVABLE_RELAY_URL ||
  DEFAULT_LOVABLE_RELAY_URL
).replace('://www.', '://');
 
// Map em memoria: txid -> dadosPedido, e tambem locId -> dadosPedido
const pedidoMap = new Map();
 
function getCertificatePath() {
  if (process.env.EFI_CERT_BASE64) {
    const certPath = path.join('/tmp', 'efi-certificate.p12');
    fs.writeFileSync(certPath, Buffer.from(process.env.EFI_CERT_BASE64, 'base64'));
    return certPath;
  }
  return './certificate.p12';
}
 
const efipay = new EfiPay({
  client_id: process.env.EFI_CLIENT_ID,
  client_secret: process.env.EFI_CLIENT_SECRET,
  sandbox: false,
  certificate: getCertificatePath(),
});
 
function formatarValor(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero <= 0) {
    throw new Error('Valor invalido');
  }
  return numero.toFixed(2);
}
 
async function ensureEfiWebhook() {
  const chave = process.env.EFI_PIX_KEY;
  if (!chave) {
    console.error('[efi-webhook] EFI_PIX_KEY nao configurada');
    return;
  }
  try {
    try {
      const atual = await efipay.pixDetailWebhook({ chave });
      console.log('[efi-webhook] webhook atual:', atual && atual.webhookUrl);
      if (atual && atual.webhookUrl === WEBHOOK_URL) {
        console.log('[efi-webhook] webhook ja configurado');
        return atual;
      }
    } catch (err) {
      console.log('[efi-webhook] erro ao consultar webhook atual');
    }
    const res = await efipay.pixConfigWebhook(
      { chave },
      { webhookUrl: WEBHOOK_URL },
      { headers: { 'x-skip-mtls-checking': 'true' } }
    );
    console.log('[efi-webhook] configurado com sucesso:', res);
    return res;
  } catch (err) {
    console.error('[efi-webhook] erro:', (err && err.response && err.response.data) || err);
    throw err;
  }
}
 
async function avisarLovablePagamento(payload) {
  try {
    if (!process.env.EFI_RELAY_SECRET) {
      console.error('[lovable-relay] EFI_RELAY_SECRET ausente');
      return;
    }
 
    const body = {
      txid: payload.txid,
      valor: payload.valor,
      status: 'paid',
      secret: process.env.EFI_RELAY_SECRET,
      endToEndId: payload.endToEndId,
      locId: payload.locId,
    };
 
    if (payload.pedidoId) {
      body.pedidoId = payload.pedidoId;
      body.external_reference = payload.pedidoId;
    }
 
    console.log('[lovable-relay] enviando para:', LOVABLE_RELAY_URL);
    console.log('[lovable-relay] body:', JSON.stringify(body, null, 2));
 
    // (3) redirect: 'manual' — impede 302 de virar GET silencioso e devolver HTML React
    const response = await fetch(LOVABLE_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'manual',
    });
 
    if (response.status >= 300 && response.status < 400) {
      console.error(
        '[lovable-relay] REDIRECT detectado — RELAY_URL provavelmente com www. URL=',
        LOVABLE_RELAY_URL,
        'location=',
        response.headers.get('location')
      );
      return;
    }
 
    const text = await response.text();
    console.log('[lovable-relay] resposta:', response.status, text);
  } catch (err) {
    console.error('[lovable-relay] erro:', err);
  }
}
 
async function processarWebhookEfi(req, res) {
  // (4) Responde 200 ANTES de processar — EFI nao reenfileira
  res.sendStatus(200);
 
  try {
    console.log('[efi-webhook] payload recebido:', JSON.stringify(req.body, null, 2));
 
    const pixList = (req.body && req.body.pix) || [];
    if (!pixList.length) {
      console.log('[efi-webhook] payload sem pix (provavelmente validacao)');
      return;
    }
 
    for (const pix of pixList) {
      const txid = pix.txid;
      const locId = pix.loc && pix.loc.id ? String(pix.loc.id) : null;
 
      console.log('[efi-webhook] txid recebido no webhook:', txid, 'locId:', locId);
 
      // (5) Fallback locId quando o Map nao tem o txid
      let dadosPedido = pedidoMap.get(txid);
      if (!dadosPedido && locId) {
        dadosPedido = pedidoMap.get(locId);
        if (dadosPedido) {
          console.log('[efi-webhook] pedidoId achado por fallback locId');
        }
      }
 
      if (dadosPedido) {
        console.log('[efi-webhook] pedidoId encontrado:', dadosPedido.pedidoId);
      } else {
        console.warn(
          '[efi-webhook] pedidoId NAO encontrado nos Maps. Vai relayar mesmo assim — Lovable tenta por efi_txid no banco.'
        );
      }
 
      const payload = {
        txid,
        endToEndId: pix.endToEndId,
        valor: pix.valor,
        horario: pix.horario,
        status: 'paid',
        pedidoId: dadosPedido && dadosPedido.pedidoId,
        locId,
      };
 
      console.log('[efi-webhook] pagamento confirmado:', payload);
      await avisarLovablePagamento(payload);
    }
  } catch (err) {
    console.error('[efi-webhook] erro:', err);
  }
}
 
app.get('/', (req, res) => {
  res.json({
    online: true,
    service: 'efi-pix-proxy',
    webhookUrl: WEBHOOK_URL,
    relayUrl: LOVABLE_RELAY_URL,
  });
});
 
app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});
 
app.get('/efi-webhook', (req, res) => {
  console.log('[efi-webhook] GET validacao recebido:', req.query);
  return res.status(200).json({ ok: true, method: 'GET' });
});
 
app.get('/efi-webhook/pix', (req, res) => {
  console.log('[efi-webhook/pix] GET validacao recebido:', req.query);
  return res.status(200).json({ ok: true, method: 'GET' });
});
 
app.post('/efi-webhook', processarWebhookEfi);
app.post('/efi-webhook/pix', processarWebhookEfi);
 
app.get('/admin/register-webhook', async (req, res) => {
  try {
    const result = await ensureEfiWebhook();
    return res.json({ ok: true, webhookUrl: WEBHOOK_URL, result });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: (err && err.response && err.response.data) || (err && err.message) || err,
    });
  }
});
 
app.post('/admin/register-webhook', async (req, res) => {
  try {
    const result = await ensureEfiWebhook();
    return res.json({ ok: true, webhookUrl: WEBHOOK_URL, result });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: (err && err.response && err.response.data) || (err && err.message) || err,
    });
  }
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
 
    if (!valor) return res.status(400).json({ error: true, message: 'Valor obrigatorio' });
    if (!pedidoId) return res.status(400).json({ error: true, message: 'pedidoId obrigatorio' });
 
    const valorFormatado = formatarValor(valor);
 
    const body = {
      calendario: { expiracao: 3600 },
      valor: { original: valorFormatado },
      chave: process.env.EFI_PIX_KEY,
      solicitacaoPagador: 'Pedido ' + pedidoId,
      infoAdicionais: [
        { nome: 'pedidoId', valor: String(pedidoId).slice(0, 72) },
        { nome: 'produto', valor: String(produto || 'Produto').slice(0, 72) },
      ],
    };
 
    // (1) POST /v2/cob (sem txid no path) — EFI gera o txid e devolve.
    // Elimina o "txid proprio vs txid da EFI" que estava causando 404 na Lovable.
    const cobranca = await efipay.pixCreateImmediateCharge([], body);
 
    const txidFinal = cobranca && cobranca.txid;
    if (!txidFinal) {
      throw new Error('EFI nao retornou txid em pixCreateImmediateCharge');
    }
 
    console.log('[create-pix] txid retornado pela EFI:', txidFinal);
 
    pedidoMap.set(txidFinal, {
      pedidoId,
      produto: produto || 'Produto',
      email,
      nome,
      telefone,
    });
    console.log('[create-pix] pedidoId salvo no Map para txid:', txidFinal);
 
    if (cobranca.loc && cobranca.loc.id) {
      pedidoMap.set(String(cobranca.loc.id), {
        pedidoId,
        produto: produto || 'Produto',
        email,
        nome,
        telefone,
      });
      console.log('[create-pix] pedidoId salvo no Map para locId:', cobranca.loc.id);
    }
 
    ensureEfiWebhook().catch(console.error);
 
    const qr = await efipay.pixGenerateQRCode({ id: cobranca.loc.id });
 
    return res.json({
      success: true,
      provider: 'efi',
      status: 'pending',
      pedidoId,
      txid: txidFinal,
      locId: cobranca.loc.id,
      valor: valorFormatado,
      qrCodeImage: qr.imagemQrcode,
      pixCopiaECola: qr.qrcode,
      expiresIn: 3600,
      tracking: { utms, fbclid, fbp, fbc, event_id },
      customer: { nome, email, telefone },
    });
  } catch (err) {
    console.error('[create-pix] erro:', err);
    return res.status(500).json({
      error: true,
      message: (err && err.message) || 'Erro ao criar Pix',
      details: (err && err.response && err.response.data) || null,
    });
  }
});
 
app.listen(PORT, () => {
  console.log('Servidor Efi Pix rodando na porta ' + PORT);
  console.log('[config] WEBHOOK_URL:', WEBHOOK_URL);
  console.log('[config] LOVABLE_RELAY_URL:', LOVABLE_RELAY_URL);
  ensureEfiWebhook().catch(console.error);
});
 
