// Utilitaire d'envoi d'emails via Brevo (principal) ou Resend (repli) + modèle HTML sobre Pran Nòt

function parseAddress(raw?: string): { email: string; name?: string } {
  const s = (raw || '').trim();
  const m = s.match(/^(?:"?([^"]*)"?\s*)?<([^>]+)>$/);
  if (m) {
    return { name: m[1]?.trim() || undefined, email: m[2].trim() };
  }
  return { email: s };
}

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ sent: boolean; id?: string; reason?: string }> {
  const brevoKey = Deno.env.get('BREVO_API_KEY');
  if (brevoKey) {
    const parsedFrom = parseAddress(Deno.env.get('PRAN_NOT_FROM_EMAIL') || Deno.env.get('FROM_EMAIL'));
    if (!parsedFrom.email) {
      return { sent: false, reason: 'FROM_EMAIL_not_configured' };
    }
    const senderName = Deno.env.get('PRAN_NOT_FROM_NAME') || 'Pran Not';
    const parsedReply = parseAddress(Deno.env.get('REPLY_TO'));

    const payload: Record<string, unknown> = {
      sender: { name: senderName, email: parsedFrom.email },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    };
    if (parsedReply.email) {
      payload.replyTo = { email: parsedReply.email };
    }

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'api-key': brevoKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errTxt = await res.text();
      console.warn('[email] Brevo error', res.status, errTxt.slice(0, 200));
      return { sent: false, reason: `brevo_${res.status}` };
    }
    const data = await res.json().catch(() => ({}));
    return { sent: true, id: data?.messageId };
  }

  const resendKey = Deno.env.get('RESEND_API_KEY');
  if (!resendKey) {
    return { sent: false, reason: 'email_provider_not_configured' };
  }
  const from = Deno.env.get('RESEND_FROM') || 'Pran Not <onboarding@resend.dev>';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!res.ok) {
    const errTxt = await res.text();
    console.warn('[email] Resend error', res.status, errTxt.slice(0, 200));
    return { sent: false, reason: `resend_${res.status}` };
  }
  const data = await res.json();
  return { sent: true, id: data?.id };
}

export function renderEmailLayout({
  title,
  greeting,
  bodyHtml,
  ctaUrl,
  ctaLabel,
  unsubscribeUrl,
  lang = 'ht',
}: {
  title: string;
  greeting: string;
  bodyHtml: string;
  ctaUrl: string;
  ctaLabel: string;
  unsubscribeUrl: string;
  lang?: string;
}) {
  const unsubText = lang === 'fr' ? 'Se désabonner en un clic' : 'Dezabòne nan yon sèl klik';
  return `<!DOCTYPE html>
<html lang="${lang === 'fr' ? 'fr' : 'ht'}">
<body style="margin:0;padding:24px;background:#FFFFFF;font-family:Arial,Helvetica,sans-serif;color:#1B2A4A;">
  <div style="max-width:580px;margin:0 auto;border:1px solid #E5E7EB;border-radius:16px;padding:28px;background:#FFFFFF;">
    <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:#C2410C;text-transform:uppercase;margin-bottom:8px;">PRAN NÒT</div>
    <h1 style="font-size:22px;margin:0 0 12px;color:#1B2A4A;">${title}</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 16px;color:#3A4866;">${greeting}</p>
    <div style="font-size:14px;line-height:1.6;color:#1B2A4A;">${bodyHtml}</div>
    <div style="margin:24px 0 16px;">
      <a href="${ctaUrl}" style="display:inline-block;background:#F97316;color:#FFFFFF;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:999px;">${ctaLabel}</a>
    </div>
    <hr style="border:0;border-top:1px solid #E5E7EB;margin:24px 0 14px;">
    <p style="font-size:12px;color:#6B7280;margin:0;">
      Pran Nòt — Designed by Cvisual &nbsp;|&nbsp;
      <a href="${unsubscribeUrl}" style="color:#5B6680;">${unsubText}</a>
    </p>
  </div>
</body>
</html>`;
}

export function unsubscribePageHtml(ok: boolean): Response {
  const html = `<!DOCTYPE html>
<html lang="ht">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pran Nòt</title></head>
<body style="margin:0;padding:40px 20px;background:#FFFFFF;font-family:system-ui,sans-serif;color:#1B2A4A;">
  <div style="max-width:480px;border:1px solid #E5E7EB;border-radius:16px;padding:28px;">
    <h1 style="font-size:20px;margin:0 0 10px;">Pran Nòt</h1>
    <p style="color:#5B6680;line-height:1.6;">
      ${ok ? 'Ou dezabòne ak rapèl imèl yo. / Vous êtes désabonné de ces rappels.' : 'Lyen sa a pa valab ankò. / Lien invalide ou expiré.'}
    </p>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
