// Edge Function : whatsapp-webhook
// Resevwa evènman CVISUAL WhatsApp Gateway epi verifye siyati HMAC-SHA256 ak timingSafeEqual.
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createAdminClient } from '../_shared/supabase.ts';
import { loadWaConfig, verifyCvisualWebhook } from '../_shared/whatsapp.ts';

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  if (req.method !== 'POST') {
    return errorResponse('METHOD_NOT_ALLOWED', 'Metòd POST sèlman', 405);
  }

  try {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get('x-cvisual-signature') || '';
    const timestampHeader = req.headers.get('x-cvisual-timestamp') || req.headers.get('x-timestamp') || '';

    const admin = createAdminClient();
    const { webhookSecret } = await loadWaConfig(admin);

    const check = await verifyCvisualWebhook({
      secret: webhookSecret,
      timestamp: timestampHeader,
      signatureHeader,
      rawBody,
      maxAgeSeconds: 600,
    });

    if (!check.valid) {
      return errorResponse(check.reason || 'invalid_signature', 'Siyati HMAC webhook la pa valab', 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
    } catch {
      return errorResponse('INVALID_JSON', 'Payload JSON pa valab', 400);
    }

    const eventName = String(payload.event || payload.type || 'unknown');
    const data = (payload.data || payload.message || payload) as Record<string, unknown>;
    const gwMessageId = String(
      data?.message_id ||
        data?.id ||
        payload.message_id ||
        '',
    ).trim();

    if (gwMessageId) {
      if (eventName === 'message.sent' || eventName === 'message.delivered') {
        await admin
          .from('pran_not_wa_logs')
          .update({
            status: 'sent',
            error_code: null,
            error_message: null,
            payload: { last_webhook_event: eventName, data },
          })
          .eq('gateway_message_id', gwMessageId);
      } else if (eventName === 'message.failed') {
        await admin
          .from('pran_not_wa_logs')
          .update({
            status: 'failed',
            error_code: String(data?.code || data?.error_code || 'DELIVERY_FAILED'),
            error_message: String(data?.error || data?.reason || 'Echec envoi WhatsApp').slice(0, 300),
            payload: { last_webhook_event: eventName, data },
          })
          .eq('gateway_message_id', gwMessageId);
      } else if (eventName === 'message.cancelled') {
        await admin
          .from('pran_not_wa_logs')
          .update({ status: 'cancelled' })
          .eq('gateway_message_id', gwMessageId);
      }
    }

    return jsonResponse({ ok: true, received: eventName, message_id: gwMessageId || null });
  } catch (err) {
    console.error('[whatsapp-webhook]', err);
    return errorResponse('WEBHOOK_ERROR', (err as Error).message || 'Erreur webhook', 500);
  }
});
