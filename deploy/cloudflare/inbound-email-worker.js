/**
 * Deskzo One — tickets by email: the Cloudflare Email Worker for tickets.deskzo.com.
 *
 * Cloudflare Email Routing hands this worker every email for a workspace's helpdesk address,
 * <workspace>@tickets.deskzo.com: one "Send to a Worker" rule per address, since Cloudflare allows a
 * catch-all only on the apex domain (docs/deploy-coolify.md, "Tickets by email"). It posts the email,
 * whole and untouched, to Deskzo, signed with the secret the two share. Deskzo decides which workspace it is for and what it becomes
 * (src/lib/support-mail).
 *
 * Settings → Variables and Secrets on the worker:
 *   DESKZO_INBOUND_URL     https://deskzo.com/api/platform/inbound-email
 *   DESKZO_INBOUND_SECRET  the same value as INBOUND_MAIL_SECRET on the Deskzo application (a secret)
 *
 * Sender authentication (security audit, Nov 2026): Cloudflare checks SPF, DKIM and DMARC on receipt and adds the
 * results to the message as the topmost ARC-Authentication-Results header, from mx.cloudflare.net. This worker reads
 * that one header — the topmost only, since anything below it came with the message and anybody can write it — and
 * sends what it says as `auth`, inside the signed body. Deskzo believes an email is from its From address only when
 * DMARC passed for that domain or an aligned DKIM signature did (src/lib/support-mail/sender-auth.ts); otherwise the
 * email waits in the Support inbox, flagged. When the topmost results aren't Cloudflare's, no `auth` is sent.
 *
 * What the sender sees:
 *   - Deskzo has no helpdesk at that address (404): the email bounces, saying so.
 *   - Deskzo answered anything else that isn't OK: the worker fails, and the sender's mail server tries
 *     again later. An email is never silently lost.
 */

const encoder = new TextEncoder();

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function sign(secret, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The message's header block, folded lines joined, in the order they appear. */
function headerLines(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 256 * 1024)));
  const end = head.search(/\r?\n\r?\n/);
  return (end < 0 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
}

/**
 * What Cloudflare found, from the topmost ARC-Authentication-Results (else Authentication-Results) header:
 *   i=1; mx.cloudflare.net; dkim=pass header.d=example.com header.s=…; spf=pass smtp.mailfrom=…; dmarc=pass header.from=example.com
 * Null when there is none, or the topmost isn't Cloudflare's.
 */
function authResults(bytes) {
  const lines = headerLines(bytes);
  const pick = (name) => lines.find((l) => l.toLowerCase().startsWith(`${name}:`));
  const line = pick("arc-authentication-results") ?? pick("authentication-results");
  if (!line) return null;
  const parts = line.slice(line.indexOf(":") + 1).split(";").map((p) => p.trim()).filter(Boolean);
  if (parts[0] && /^i=\d+$/i.test(parts[0])) parts.shift();
  const authservId = (parts.shift() ?? "").split(/\s+/)[0].toLowerCase();
  if (authservId !== "mx.cloudflare.net") return null;
  const auth = { authservId, dmarc: null, dmarcDomain: null, dkim: [], spf: null };
  for (const part of parts) {
    const method = /^(dkim|spf|dmarc)=([a-z]+)/i.exec(part);
    if (!method) continue;
    const result = method[2].toLowerCase();
    const prop = (name) => (new RegExp(`${name.replace(".", "\\.")}=([^\\s;]+)`, "i").exec(part)?.[1] ?? "").toLowerCase();
    if (method[1].toLowerCase() === "dkim") auth.dkim.push({ result, domain: prop("header.d") });
    else if (method[1].toLowerCase() === "spf") auth.spf = result;
    else {
      auth.dmarc = result;
      auth.dmarcDomain = prop("header.from") || null;
    }
  }
  return auth;
}

const worker = {
  async email(message, env) {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const body = JSON.stringify({ recipient: message.to, sender: message.from, raw: base64(raw), auth: authResults(raw) });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(env.DESKZO_INBOUND_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-deskzo-timestamp": timestamp,
        "x-deskzo-signature": await sign(env.DESKZO_INBOUND_SECRET, `${timestamp}.${body}`),
      },
      body,
    });
    if (response.status === 404) {
      message.setReject("No helpdesk answers at this address.");
      return;
    }
    if (!response.ok) throw new Error(`Deskzo answered ${response.status}`);
  },
};

export default worker;
