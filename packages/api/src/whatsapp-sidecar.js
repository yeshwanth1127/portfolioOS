import QRCode from 'qrcode';

const WA_SERVICE_URL = (process.env.WA_SERVICE_URL ?? '').replace(/\/$/, '');
const WA_CONNECTOR_ID = (process.env.WA_CONNECTOR_ID ?? '').trim();
const WA_SERVICE_SECRET =
  process.env.WA_SERVICE_SECRET ?? process.env.SERVICE_SECRET ?? process.env.AGENT_RUNNER_SECRET ?? '';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configSummary() {
  return {
    sidecar_url: WA_SERVICE_URL || null,
    connector_id: WA_CONNECTOR_ID || null,
    gateway_url: process.env.WA_PORT ? `http://127.0.0.1:${process.env.WA_PORT}` : 'http://127.0.0.1:3938',
    configured: Boolean(WA_SERVICE_URL && WA_SERVICE_SECRET && WA_CONNECTOR_ID && UUID_RE.test(WA_CONNECTOR_ID)),
  };
}

async function sidecarFetch(path, { method = 'GET' } = {}) {
  const res = await fetch(`${WA_SERVICE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Secret': WA_SERVICE_SECRET,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Sidecar ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function qrDataUrl(pairingString) {
  if (!pairingString) return null;
  return QRCode.toDataURL(pairingString, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 280,
  });
}

export async function getWhatsAppSettings() {
  const summary = configSummary();
  if (!summary.configured) {
    return {
      ...summary,
      ready: false,
      message: !WA_SERVICE_URL
        ? 'Set WA_SERVICE_URL in .env (Qlix WhatsApp sidecar, usually http://127.0.0.1:3939).'
        : !WA_CONNECTOR_ID
          ? 'Set WA_CONNECTOR_ID to a UUID for this WhatsApp session.'
          : !UUID_RE.test(WA_CONNECTOR_ID)
            ? 'WA_CONNECTOR_ID must be a valid UUID.'
            : 'Set WA_SERVICE_SECRET to match the sidecar SERVICE_SECRET.',
    };
  }

  let health = null;
  let status = null;
  let sidecarError = null;
  try {
    health = await sidecarFetch('/health');
  } catch (e) {
    sidecarError = e.message;
  }
  if (!sidecarError) {
    try {
      status = await sidecarFetch(`/sessions/${WA_CONNECTOR_ID}/status`);
    } catch (e) {
      sidecarError = e.message;
    }
  }

  const qr = status?.qr ?? null;
  const qr_image = await qrDataUrl(qr);

  return {
    ...summary,
    ready: Boolean(health?.qr_linking_ready ?? health?.ok),
    health,
    connected: Boolean(status?.connected),
    state: status?.state ?? (status?.connected ? 'connected' : 'connecting'),
    owner_jid: status?.ownerJid ?? null,
    qr_image,
    has_qr: Boolean(qr),
    sidecar_error: sidecarError,
    message: status?.connected
      ? 'WhatsApp is linked. Registered numbers can message the portfolio agent.'
      : qr
        ? 'Scan this QR with WhatsApp → Linked devices → Link a device.'
        : health && !health.qr_linking_ready
          ? 'Sidecar is up but QR linking is not ready yet (Baileys version). Wait and refresh.'
          : sidecarError
            ? `Could not reach the sidecar at ${WA_SERVICE_URL}. Start qlix-whatsapp-service on port 3939, then click Generate QR. (${sidecarError})`
            : 'Click Generate QR below. Keep this page open — the code refreshes until you scan it.',
  };
}

export async function startWhatsAppSession() {
  const summary = configSummary();
  if (!summary.configured) {
    return { ok: false, error: 'WhatsApp sidecar is not configured.' };
  }
  await sidecarFetch(`/sessions/${WA_CONNECTOR_ID}/start`, { method: 'POST' });
  return getWhatsAppSettings();
}
