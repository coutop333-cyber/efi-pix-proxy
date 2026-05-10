export async function ensureEfiWebhook(efi) {
  const chave = process.env.EFI_PIX_KEY;

  const webhookUrl =
    'https://efi-pix-proxy-ec0d.onrender.com/efi-webhook';

  try {
    try {
      const atual = await efi.pixDetailWebhook({ chave });

      if (atual?.webhookUrl === webhookUrl) {
        console.log('[efi-webhook] já configurado');
        return;
      }
    } catch (_) {}

    const res = await efi.pixConfigWebhook(
      { chave },
      { webhookUrl },
      {
        headers: {
          'x-skip-mtls-checking': 'true',
        },
      }
    );

    console.log('[efi-webhook] configurado', res);
  } catch (err) {
    console.error(
      '[efi-webhook] erro:',
      err?.response?.data || err
    );
  }
}
