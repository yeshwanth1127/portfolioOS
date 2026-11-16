/*
 * Who sent an inbound WhatsApp message (docs/BUILD.md § 4.10).
 *
 * The sidecar only forwards a message WITHOUT `from_contact` after checking it is the linked
 * account's own chat. Everything else is a contact message, and the sender is trusted only when
 * the chat id is a phone JID. Contacts that appear only as a LID (…@lid) are rejected: the sidecar
 * does not send a verified LID→phone mapping, and guessing (e.g. "it must be the owner") would let
 * any contact act as the owner.
 */

export function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** Phone digits from a phone JID — strip the device suffix (`:61`). */
export function phoneDigitsFromJid(jid) {
  const local = String(jid ?? '').split('@')[0].split(':')[0];
  return digits(local);
}

/**
 * @param {{ from_contact?: boolean, remote_jid?: string }} payload  what the sidecar sent
 * @param {string|null} linkedJid  the linked account's JID, reported by the sidecar on link
 * @returns {{ ok: true, phone: string, selfChat: boolean } | { ok: false, reason: string }}
 */
export function resolveSender(payload, linkedJid) {
  const fromContact = Boolean(payload?.from_contact);
  const remoteJid = String(payload?.remote_jid ?? '');

  if (!fromContact) {
    const linked = phoneDigitsFromJid(linkedJid);
    if (!linked) return { ok: false, reason: 'link_unknown' };
    return { ok: true, phone: `+${linked}`, selfChat: true };
  }
  if (remoteJid.endsWith('@s.whatsapp.net')) {
    const d = phoneDigitsFromJid(remoteJid);
    if (d.length < 8) return { ok: false, reason: 'unverified_sender' };
    return { ok: true, phone: `+${d}`, selfChat: false };
  }
  if (remoteJid.endsWith('@lid')) return { ok: false, reason: 'unverified_sender' };
  return { ok: false, reason: 'unsupported_chat' }; // groups, broadcasts, empty
}
