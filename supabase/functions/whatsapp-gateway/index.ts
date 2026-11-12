// Edge Function : whatsapp-gateway
// Passerelle serveur sécurisée pour CVISUAL WhatsApp Gateway REST API.
// Tout kle API yo rete 100 % sou sèvè a (Supabase Secrets / pran_not_wa_settings).
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { authenticateUser, createAdminClient } from '../_shared/supabase.ts';
import {
  CvisualWaError,
  DEFAULT_CVISUAL_WA_BASE_URL,
  loadWaConfig,
  maskApiKey,
  normalizePhone,
  resolveLane,
} from '../_shared/whatsapp.ts';
import { runAutomatedWhatsAppReminders } from '../_shared/reminders.ts';

function sanitizeSettingsForAdmin(opts: {
  settings: Awaited<ReturnType<typeof loadWaConfig>>['settings'];
  effectiveApiKey: string;
  keySource: string;
  webhookSecret: string;
  supabaseUrl: string;
}) {
  const { settings, effectiveApiKey, keySource, webhookSecret, supabaseUrl } = opts;
  return {
    base_url: settings.base_url || DEFAULT_CVISUAL_WA_BASE_URL,
    enabled: Boolean(settings.enabled),
    welcome_enabled: Boolean(settings.welcome_enabled),
    inactivity_days: settings.inactivity_days,
    reminder_cooldown_hours: settings.reminder_cooldown_hours,
    deadline_enabled: Boolean(settings.deadline_enabled),
    inactive_template_ht: settings.inactive_template_ht,
    inactive_template_fr: settings.inactive_template_fr,
    deadline_template_ht: settings.deadline_template_ht,
    deadline_template_fr: settings.deadline_template_fr,
    updated_at: settings.updated_at || null,
    // Enfòmasyon maske sèlman — pa janm voye kle reyèl bay navigatè a
    has_api_key: Boolean(effectiveApiKey),
    api_key_masked: maskApiKey(effectiveApiKey),
    key_source: keySource,
    has_webhook_secret: Boolean(webhookSecret),
    webhook_url: `${supabaseUrl.replace(/\/$/, '')}/functions/v1/whatsapp-webhook`,
  };
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  try {
    const auth = await authenticateUser(req);
    if ('error' in auth) {
      return errorResponse(auth.error, auth.error, auth.status);
    }

    const { user, admin } = auth;
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const action = String(body.action || 'overview');
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';

    // Aksyon etidyan ki senp : voye mesaj byenvini Fast Lane si etidyan an fenk mete nimewo l
    if (action === 'send_welcome') {
      const cfg = await loadWaConfig(admin);
      if (!cfg.settings.enabled || !cfg.settings.welcome_enabled || !cfg.effectiveApiKey) {
        return jsonResponse({ ok: true, sent: false, reason: 'welcome_disabled' });
      }
      const { data: prof } = await admin
        .from('pran_not_profiles')
        .select('id, full_name, language, whatsapp_phone, notify_whatsapp')
        .eq('id', user.id)
        .maybeSingle();

      if (!prof?.whatsapp_phone || prof.notify_whatsapp === false) {
        return jsonResponse({ ok: true, sent: false, reason: 'no_phone_or_opted_out' });
      }

      const phone = normalizePhone(prof.whatsapp_phone);
      const firstName = (prof.full_name || '').trim().split(/\s+/)[0] || '';
      const lang = prof.language === 'fr' ? 'fr' : 'ht';
      const appUrl = (Deno.env.get('APP_URL') || 'https://prannot.ht').replace(/\/$/, '');
      const msg = lang === 'fr'
        ? `{Bonjour|Bienvenue} ${firstName}, votre compte Pran Not est pret. Activez vos notes et flashcards ici : ${appUrl}/pages/dashboard.html`
        : `{Bonjou|Byenveni} ${firstName}, espas Pran Not ou a pare. Komanse pran not ak revize kat ou yo : ${appUrl}/pages/dashboard.html`;

      const res = await cfg.client.sendMessage({
        to: phone,
        message: msg,
        kind: 'welcome',
        mode: 'async',
        idempotencyKey: `prannot-welcome-${user.id}`,
      });

      const gwId = String(res?.id || res?.message_id || '') || null;
      await admin.from('pran_not_wa_logs').insert({
        user_id: user.id,
        phone,
        kind: 'welcome',
        lane: 'fast',
        mode: 'async',
        gateway_message_id: gwId,
        status: 'queued',
      });

      return jsonResponse({ ok: true, sent: true, gateway: res });
    }

    // TOUT LÒT AKSYON REZÈVE POU ADMINISTRATÈ YO
    const email = (user.email || '').toLowerCase();
    const { data: adminRow } = await admin
      .from('pran_not_admin_users')
      .select('email')
      .ilike('email', email)
      .maybeSingle();

    if (!adminRow) {
      return errorResponse('forbidden', 'Aksè rezève pou administratè Pran Nòt yo sèlman.', 403);
    }

    const cfg = await loadWaConfig(admin);

    if (action === 'overview' || action === 'test_connection') {
      const [healthRes, meRes, statusRes] = await Promise.allSettled([
        cfg.client.health(),
        cfg.effectiveApiKey ? cfg.client.me() : Promise.reject(new CvisualWaError(401, 'MISSING_API_KEY', 'Pa gen kle API konfigire.')),
        cfg.effectiveApiKey ? cfg.client.status() : Promise.reject(new CvisualWaError(401, 'MISSING_API_KEY', 'Pa gen kle API konfigire.')),
      ]);

      const formatSettled = (r: PromiseSettledResult<unknown>) => {
        if (r.status === 'fulfilled') return { ok: true, data: r.value };
        const e = r.reason;
        if (e instanceof CvisualWaError) {
          return { ok: false, status: e.status, code: e.code, error: e.message };
        }
        return { ok: false, status: 500, code: 'ERROR', error: String(e?.message || e) };
      };

      let extra = {};
      if (action === 'overview') {
        const cutoffIso = new Date(Date.now() - (cfg.settings.inactivity_days || 2) * 86400000).toISOString();
        const [{ count: optedInCount }, { count: inactiveCount }, { data: recentLogs }] = await Promise.all([
          admin
            .from('pran_not_profiles')
            .select('id', { count: 'exact', head: true })
            .eq('notify_whatsapp', true)
            .not('whatsapp_phone', 'is', null),
          admin
            .from('pran_not_profiles')
            .select('id', { count: 'exact', head: true })
            .eq('onboarded', true)
            .eq('is_banned', false)
            .eq('notify_whatsapp', true)
            .not('whatsapp_phone', 'is', null)
            .or(`last_seen_at.lte.${cutoffIso},last_seen_at.is.null`),
          admin
            .from('pran_not_wa_logs')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(40),
        ]);
        extra = {
          stats: {
            students_with_whatsapp: optedInCount || 0,
            inactive_candidates: inactiveCount || 0,
          },
          logs: recentLogs || [],
        };
      }

      return jsonResponse({
        ok: true,
        settings: sanitizeSettingsForAdmin({ ...cfg, supabaseUrl }),
        health: formatSettled(healthRes),
        me: formatSettled(meRes),
        status: formatSettled(statusRes),
        ...extra,
      });
    }

    if (action === 'save_settings') {
      const baseUrlRaw = String(body.base_url || cfg.settings.base_url || DEFAULT_CVISUAL_WA_BASE_URL).trim();
      let cleanUrl: string;
      try {
        const parsed = new URL(baseUrlRaw);
        if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('protocol');
        cleanUrl = baseUrlRaw.replace(/\/+$/, '');
      } catch {
        return errorResponse('INVALID_BASE_URL', 'URL gateway la pa valab (https://...)', 400);
      }

      const inactivityDays = Math.max(1, Math.min(30, Number.parseInt(String(body.inactivity_days ?? cfg.settings.inactivity_days), 10) || 2));
      const cooldownHours = Math.max(12, Math.min(168, Number.parseInt(String(body.reminder_cooldown_hours ?? cfg.settings.reminder_cooldown_hours), 10) || 48));

      const patch: Record<string, unknown> = {
        id: 'default',
        base_url: cleanUrl,
        enabled: body.enabled !== undefined ? Boolean(body.enabled) : cfg.settings.enabled,
        welcome_enabled: body.welcome_enabled !== undefined ? Boolean(body.welcome_enabled) : cfg.settings.welcome_enabled,
        inactivity_days: inactivityDays,
        reminder_cooldown_hours: cooldownHours,
        deadline_enabled: body.deadline_enabled !== undefined ? Boolean(body.deadline_enabled) : cfg.settings.deadline_enabled,
        updated_by: user.id,
      };

      if (typeof body.inactive_template_ht === 'string' && body.inactive_template_ht.trim()) {
        patch.inactive_template_ht = body.inactive_template_ht.trim();
      }
      if (typeof body.inactive_template_fr === 'string' && body.inactive_template_fr.trim()) {
        patch.inactive_template_fr = body.inactive_template_fr.trim();
      }
      if (typeof body.deadline_template_ht === 'string' && body.deadline_template_ht.trim()) {
        patch.deadline_template_ht = body.deadline_template_ht.trim();
      }
      if (typeof body.deadline_template_fr === 'string' && body.deadline_template_fr.trim()) {
        patch.deadline_template_fr = body.deadline_template_fr.trim();
      }

      // Kle API : sèlman mete ajou si administratè a ekri yon nouvo kle oswa si li mande efase kle DB a pou repli sou .env
      if (body.clear_db_api_key === true) {
        patch.api_key = null;
      } else if (typeof body.new_api_key === 'string' && body.new_api_key.trim()) {
        patch.api_key = body.new_api_key.trim();
      }

      if (body.clear_webhook_secret === true) {
        patch.webhook_secret = null;
      } else if (typeof body.new_webhook_secret === 'string' && body.new_webhook_secret.trim()) {
        patch.webhook_secret = body.new_webhook_secret.trim();
      }

      const { error: upErr } = await admin
        .from('pran_not_wa_settings')
        .upsert(patch, { onConflict: 'id' });
      if (upErr) throw upErr;

      // Re-chaje epi verifye koneksyon GET /api/v1/me touswit
      const updatedCfg = await loadWaConfig(admin);
      let meVerification: Record<string, unknown>;
      try {
        const me = await updatedCfg.client.me();
        meVerification = { ok: true, data: me };
      } catch (err) {
        const e = err instanceof CvisualWaError
          ? err
          : new CvisualWaError(500, 'ME_CHECK_FAILED', String((err as Error)?.message || err));
        meVerification = { ok: false, status: e.status, code: e.code, error: e.message };
      }

      return jsonResponse({
        ok: true,
        settings: sanitizeSettingsForAdmin({ ...updatedCfg, supabaseUrl }),
        me: meVerification,
      });
    }

    if (action === 'check_numbers') {
      const phones = Array.isArray(body.phones) ? body.phones.map((x: unknown) => String(x)) : [];
      const data = await cfg.client.checkNumbers(phones);
      return jsonResponse({ ok: true, result: data });
    }

    if (action === 'send_message') {
      const kind = String(body.kind || 'manual').trim();
      const lane = resolveLane(kind);
      const mode = (body.mode === 'sync' ? 'sync' : 'async') as 'async' | 'sync';
      const phone = normalizePhone(String(body.to || ''));
      const res = await cfg.client.sendMessage({
        to: phone,
        message: String(body.message || ''),
        kind,
        mode,
        accountIndex: typeof body.account_index === 'number' ? body.account_index : undefined,
        pdfBase64: typeof body.pdf_base64 === 'string' && body.pdf_base64 ? body.pdf_base64 : undefined,
        pdfFileName: typeof body.pdf_file_name === 'string' ? body.pdf_file_name : undefined,
        idempotencyKey: typeof body.idempotency_key === 'string' && body.idempotency_key ? body.idempotency_key : undefined,
      });

      const gwId = String(
        res?.id ||
          res?.message_id ||
          (res?.message as Record<string, unknown> | undefined)?.id ||
          '',
      ) || null;

      await admin.from('pran_not_wa_logs').insert({
        user_id: typeof body.user_id === 'string' ? body.user_id : null,
        phone,
        kind,
        lane,
        mode,
        gateway_message_id: gwId,
        status: mode === 'sync' ? 'sent' : 'queued',
        payload: { sent_by_admin: user.email, manual: true },
      });

      return jsonResponse({ ok: true, result: res });
    }

    if (action === 'send_bulk') {
      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const res = await cfg.client.sendBulk(
        rawMessages.map((m: Record<string, unknown>) => ({
          to: String(m.to || ''),
          message: String(m.message || ''),
          kind: String(m.kind || 'manual'),
          mode: (m.mode === 'sync' ? 'sync' : 'async') as 'async' | 'sync',
          accountIndex: typeof m.account_index === 'number' ? m.account_index : undefined,
        })),
        typeof body.idempotency_key === 'string' && body.idempotency_key ? body.idempotency_key : undefined,
      );
      return jsonResponse({ ok: true, result: res });
    }

    if (action === 'list_messages') {
      const [gwRes, localLogsRes] = await Promise.allSettled([
        cfg.client.listMessages({
          limit: Number(body.limit || 40),
          offset: Number(body.offset || 0),
          status: body.status ? String(body.status) : undefined,
          kind: body.kind ? String(body.kind) : undefined,
        }),
        admin
          .from('pran_not_wa_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(50),
      ]);

      const gateway = gwRes.status === 'fulfilled'
        ? { ok: true, data: gwRes.value }
        : {
            ok: false,
            error: gwRes.reason instanceof CvisualWaError ? gwRes.reason.message : String(gwRes.reason),
            code: gwRes.reason instanceof CvisualWaError ? gwRes.reason.code : 'ERROR',
          };

      const localLogs = localLogsRes.status === 'fulfilled' ? (localLogsRes.value.data || []) : [];
      return jsonResponse({ ok: true, gateway, local_logs: localLogs });
    }

    if (action === 'message_status') {
      const data = await cfg.client.getMessageStatus(String(body.id || ''));
      return jsonResponse({ ok: true, result: data });
    }

    if (action === 'cancel_message') {
      const id = String(body.id || '');
      const data = await cfg.client.cancelMessage(id);
      await admin
        .from('pran_not_wa_logs')
        .update({ status: 'cancelled' })
        .eq('gateway_message_id', id);
      return jsonResponse({ ok: true, result: data });
    }

    if (action === 'retry_message') {
      const id = String(body.id || '');
      const data = await cfg.client.retryMessage(id);
      await admin
        .from('pran_not_wa_logs')
        .update({ status: 'queued', error_code: null, error_message: null })
        .eq('gateway_message_id', id);
      return jsonResponse({ ok: true, result: data });
    }

    if (action === 'list_webhooks') {
      const data = await cfg.client.listWebhooks();
      return jsonResponse({ ok: true, result: data });
    }

    if (action === 'register_webhook') {
      const targetUrl = String(body.url || `${supabaseUrl.replace(/\/$/, '')}/functions/v1/whatsapp-webhook`).trim();
      const events = Array.isArray(body.events) && body.events.length
        ? body.events.map((e: unknown) => String(e))
        : ['message.sent', 'message.failed'];

      const data = await cfg.client.registerWebhook({ url: targetUrl, events }) as Record<string, unknown>;
      const returnedSecret = String(
        data?.secret ||
          (data?.webhook as Record<string, unknown> | undefined)?.secret ||
          '',
      ).trim();

      let secretSaved = false;
      if (returnedSecret) {
        await admin
          .from('pran_not_wa_settings')
          .upsert({ id: 'default', webhook_secret: returnedSecret, updated_by: user.id }, { onConflict: 'id' });
        secretSaved = true;
      }

      // Retounen repons san re-ekspoze secret lan si nou sove l deja sou sèvè a
      const safeResult = { ...data };
      if (secretSaved && 'secret' in safeResult) safeResult.secret = 'saved_server_side';
      if (secretSaved && safeResult.webhook && typeof safeResult.webhook === 'object') {
        safeResult.webhook = { ...(safeResult.webhook as Record<string, unknown>), secret: 'saved_server_side' };
      }

      return jsonResponse({ ok: true, result: safeResult, secret_saved: secretSaved });
    }

    if (action === 'test_webhook') {
      const data = await cfg.client.testWebhook(String(body.id || ''));
      return jsonResponse({ ok: true, result: data });
    }

    if (action === 'delete_webhook') {
      const data = await cfg.client.deleteWebhook(String(body.id || ''));
      return jsonResponse({ ok: true, result: data });
    }

    if (action === 'run_reminders') {
      const summary = await runAutomatedWhatsAppReminders(admin, {
        maxPerRun: Number(body.max_per_run || 20),
        dryRun: Boolean(body.dry_run),
      });
      return jsonResponse({ ok: true, summary });
    }

    return errorResponse('UNKNOWN_ACTION', `Aksyon enkoni : ${action}`, 400);
  } catch (err) {
    if (err instanceof CvisualWaError) {
      return jsonResponse(
        {
          ok: false,
          error: err.code,
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          details: err.details,
        },
        err.status,
      );
    }
    console.error('[whatsapp-gateway]', err);
    return errorResponse('INTERNAL_ERROR', (err as Error).message || 'Erreur interne', 500);
  }
});
