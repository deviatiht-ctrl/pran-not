// Lojik pataje pou rapèl WhatsApp otomatik (Slow Lane anti-ban) :
// 1. Etidyan ki pa monte sou sit la depi X jou (inactivity_days)
// 2. Echeyans devwa ki pwòch (J-2 ak J-7)
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  CvisualWaError,
  loadWaConfig,
  normalizePhone,
  renderSpintaxTemplate,
} from './whatsapp.ts';

export interface WaReminderSummary {
  enabled: boolean;
  queued: number;
  skipped: number;
  errors: number;
  stoppedReason?: string;
  items: Array<{
    userId: string;
    phone: string;
    kind: string;
    status: 'queued' | 'failed';
    messageId?: string;
    error?: string;
  }>;
}

function getLocalClock(nowMs: number, timeZone = 'America/Port-au-Prince') {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'America/Port-au-Prince',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
    const dayMap: Record<string, string> = {
      Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat',
    };
    const dayKey = dayMap[parts.weekday] || 'mon';
    const hour = Number(parts.hour) % 24;
    const minute = Number(parts.minute) || 0;
    return {
      dateStr: `${parts.year}-${parts.month}-${parts.day}`,
      dayKey,
      nowMinutes: hour * 60 + minute,
    };
  } catch {
    const d = new Date(nowMs);
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    return {
      dateStr: d.toISOString().slice(0, 10),
      dayKey: days[d.getUTCDay()],
      nowMinutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    };
  }
}

export async function runAutomatedWhatsAppReminders(
  admin: SupabaseClient,
  opts: { maxPerRun?: number; appUrl?: string; dryRun?: boolean } = {},
): Promise<WaReminderSummary> {
  const { settings, effectiveApiKey, client } = await loadWaConfig(admin);
  const summary: WaReminderSummary = {
    enabled: Boolean(settings.enabled && effectiveApiKey),
    queued: 0,
    skipped: 0,
    errors: 0,
    items: [],
  };

  if (!settings.enabled || !effectiveApiKey) {
    summary.stoppedReason = !settings.enabled ? 'whatsapp_disabled' : 'missing_api_key';
    return summary;
  }

  const maxPerRun = Math.max(1, Math.min(100, opts.maxPerRun ?? 20));
  const appUrl = (opts.appUrl || Deno.env.get('APP_URL') || 'https://prannot.ht').replace(/\/$/, '');
  const nowMs = Date.now();
  const todayStr = new Date(nowMs).toISOString().slice(0, 10);
  const cooldownMs = (settings.reminder_cooldown_hours || 48) * 3600000;
  const inactivityThresholdMs = (settings.inactivity_days || 2) * 86400000;

  const { data: users, error: usersErr } = await admin
    .from('pran_not_profiles')
    .select('id, full_name, language, timezone, whatsapp_phone, notify_whatsapp, notify_deadlines, last_seen_at, last_wa_reminder_at, created_at')
    .eq('onboarded', true)
    .eq('is_banned', false)
    .eq('notify_whatsapp', true)
    .not('whatsapp_phone', 'is', null)
    .order('last_wa_reminder_at', { ascending: true, nullsFirst: true })
    .limit(200);

  if (usersErr) {
    throw usersErr;
  }

  for (const u of users || []) {
    if (summary.queued >= maxPerRun) {
      summary.stoppedReason = 'batch_limit_reached';
      break;
    }

    let phone: string;
    try {
      phone = normalizePhone(String(u.whatsapp_phone || ''));
    } catch {
      summary.skipped++;
      continue;
    }

    const lang = u.language === 'fr' ? 'fr' : 'ht';
    const firstName = (String(u.full_name || '').trim().split(/\s+/)[0]) || (lang === 'fr' ? 'Etudiant' : 'Etidyan');
    const lastSeenIso = u.last_seen_at || u.created_at;
    const daysInactive = Math.max(0, Math.floor((nowMs - new Date(lastSeenIso).getTime()) / 86400000));
    const cooldownActive = Boolean(
      u.last_wa_reminder_at && (nowMs - new Date(u.last_wa_reminder_at).getTime()) < cooldownMs,
    );

    const [{ count: dueCount }, { data: assignments }, coursesRes] = await Promise.all([
      admin
        .from('pran_not_flashcards')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', u.id)
        .eq('suspended', false)
        .lte('due_at', new Date(nowMs).toISOString()),
      admin
        .from('pran_not_assignments')
        .select('id, title, due_at, reminders_sent')
        .eq('user_id', u.id)
        .in('status', ['todo', 'in_progress'])
        .not('due_at', 'is', null),
      settings.class_reminder_enabled
        ? admin
            .from('pran_not_courses')
            .select('id, name, schedule_days, schedule_start_time, notify_before_minutes')
            .eq('user_id', u.id)
            .eq('archived', false)
            .not('schedule_start_time', 'is', null)
        : Promise.resolve({ data: [], error: null }),
    ]);

    // 0) Kou ki pral komanse oswa ki fenk komanse (Fast Lane pou rive a le)
    if (settings.class_reminder_enabled && !coursesRes?.error && Array.isArray(coursesRes?.data)) {
      const clk = getLocalClock(nowMs, (u as { timezone?: string }).timezone || 'America/Port-au-Prince');
      for (const c of coursesRes.data as Array<{
        id: string;
        name: string;
        schedule_days?: string[];
        schedule_start_time?: string;
        notify_before_minutes?: number;
      }>) {
        if (summary.queued >= maxPerRun) break;
        const m = /^(\d{1,2}):(\d{2})/.exec(String(c.schedule_start_time || ''));
        if (!m) continue;
        const days = Array.isArray(c.schedule_days) ? c.schedule_days : [];
        if (days.length > 0 && !days.includes(clk.dayKey)) continue;

        const startMin = Number(m[1]) * 60 + Number(m[2]);
        const diff = startMin - clk.nowMinutes;
        const winBefore = Math.max(5, Number(c.notify_before_minutes ?? 15));
        if (diff > winBefore || diff < -15) continue;

        const classKey = `prannot-wa-class-${u.id}-${c.id}-${clk.dateStr}`;
        const { data: existingLog } = await admin
          .from('pran_not_wa_logs')
          .select('id')
          .eq('user_id', u.id)
          .contains('payload', { idempotency_key: classKey })
          .limit(1);
        if (existingLog?.length) continue;

        const hhmm = `${m[1].padStart(2, '0')}:${m[2]}`;
        const classTpl = lang === 'fr' ? settings.class_template_fr : settings.class_template_ht;
        const classMsg = renderSpintaxTemplate(classTpl, {
          name: firstName,
          course: c.name,
          time: hhmm,
          url: `${appUrl}/pages/live-class.html?course=${c.id}`,
        });

        if (opts.dryRun) {
          summary.queued++;
          summary.items.push({ userId: u.id, phone, kind: 'manual_direct', status: 'queued' });
          continue;
        }

        try {
          const gwResp = await client.sendMessage({
            to: phone,
            message: classMsg,
            kind: 'manual_direct',
            mode: 'async',
            idempotencyKey: classKey,
          });
          const gwId = String(gwResp?.id || gwResp?.message_id || '') || null;
          await admin.from('pran_not_wa_logs').insert({
            user_id: u.id,
            phone,
            kind: 'manual_direct',
            lane: 'fast',
            mode: 'async',
            gateway_message_id: gwId,
            status: 'queued',
            payload: { course_id: c.id, course_name: c.name, start_time: hhmm, idempotency_key: classKey },
          });
          await admin.from('pran_not_notifications').insert({
            user_id: u.id,
            kind: 'reminder',
            title: lang === 'fr' ? `Cours imminent : ${c.name}` : `Kou ${c.name} ap komanse`,
            body: lang === 'fr' ? `Debut prevu a ${hhmm}` : `Le kou a : ${hhmm}`,
            link: `pages/live-class.html?course=${c.id}`,
          });
          summary.queued++;
          summary.items.push({
            userId: u.id,
            phone,
            kind: 'manual_direct',
            status: 'queued',
            messageId: gwId || undefined,
          });
        } catch (err) {
          summary.errors++;
          summary.items.push({
            userId: u.id,
            phone,
            kind: 'manual_direct',
            status: 'failed',
            error: err instanceof Error ? err.message : 'class_wa_error',
          });
        }
      }
    }

    // 1) Echeyans devwa J-2 oswa J-7
    const dueTitles: string[] = [];
    let deadlineKind: 'reminder_2d' | 'reminder_7d' | null = null;
    const pendingTagUpdates: Array<{ id: string; nextSent: string[] }> = [];

    if (settings.deadline_enabled && u.notify_deadlines !== false) {
      for (const a of assignments || []) {
        const diffDays = Math.ceil((new Date(a.due_at).getTime() - nowMs) / 86400000);
        const sent = Array.isArray(a.reminders_sent) ? a.reminders_sent : [];
        let waTag = '';
        if (diffDays <= 2 && diffDays >= 0 && !sent.includes('WA_J2')) {
          waTag = 'WA_J2';
          deadlineKind = 'reminder_2d';
        } else if (diffDays <= 7 && diffDays > 2 && !sent.includes('WA_J7')) {
          waTag = 'WA_J7';
          if (!deadlineKind) deadlineKind = 'reminder_7d';
        }
        if (waTag) {
          dueTitles.push(String(a.title));
          pendingTagUpdates.push({ id: a.id, nextSent: [...sent, waTag] });
        }
      }
    }

    let kindToSend: 'reminder' | 'reminder_2d' | 'reminder_7d' | null = null;
    let messageBody = '';
    let idempotencyKey = '';

    if (deadlineKind && dueTitles.length) {
      kindToSend = deadlineKind;
      const tpl = lang === 'fr' ? settings.deadline_template_fr : settings.deadline_template_ht;
      messageBody = renderSpintaxTemplate(tpl, {
        name: firstName,
        deadlines: dueTitles.slice(0, 3).join(', '),
        due: dueCount || 0,
        days: daysInactive,
        url: `${appUrl}/pages/assignments.html`,
      });
      idempotencyKey = `prannot-wa-${deadlineKind}-${u.id}-${todayStr}`;
    } else if (!cooldownActive && (nowMs - new Date(lastSeenIso).getTime()) >= inactivityThresholdMs) {
      kindToSend = 'reminder';
      const tpl = lang === 'fr' ? settings.inactive_template_fr : settings.inactive_template_ht;
      messageBody = renderSpintaxTemplate(tpl, {
        name: firstName,
        days: daysInactive,
        due: dueCount || 0,
        url: `${appUrl}/pages/dashboard.html`,
      });
      idempotencyKey = `prannot-wa-inactive-${u.id}-${todayStr}`;
    }

    if (!kindToSend || !messageBody) {
      summary.skipped++;
      continue;
    }

    if (opts.dryRun) {
      summary.queued++;
      summary.items.push({ userId: u.id, phone, kind: kindToSend, status: 'queued' });
      continue;
    }

    try {
      // Toujou Slow Lane + mode='async' (Anti-Ban Meta)
      const gwResp = await client.sendMessage({
        to: phone,
        message: messageBody,
        kind: kindToSend,
        mode: 'async',
        idempotencyKey,
      });

      const gwId = String(
        gwResp?.id ||
          gwResp?.message_id ||
          (gwResp?.message as Record<string, unknown> | undefined)?.id ||
          '',
      ) || null;

      await admin.from('pran_not_wa_logs').insert({
        user_id: u.id,
        phone,
        kind: kindToSend,
        lane: 'slow',
        mode: 'async',
        gateway_message_id: gwId,
        status: 'queued',
        payload: { days_inactive: daysInactive, due_cards: dueCount || 0, idempotency_key: idempotencyKey },
      });

      if (kindToSend === 'reminder') {
        await admin
          .from('pran_not_profiles')
          .update({ last_wa_reminder_at: new Date(nowMs).toISOString() })
          .eq('id', u.id);
      } else {
        for (const upd of pendingTagUpdates) {
          await admin.from('pran_not_assignments').update({ reminders_sent: upd.nextSent }).eq('id', upd.id);
        }
      }

      summary.queued++;
      summary.items.push({
        userId: u.id,
        phone,
        kind: kindToSend,
        status: 'queued',
        messageId: gwId || undefined,
      });
    } catch (err) {
      const waErr = err instanceof CvisualWaError
        ? err
        : new CvisualWaError(500, 'WA_SEND_ERROR', err instanceof Error ? err.message : 'unknown_error');

      await admin.from('pran_not_wa_logs').insert({
        user_id: u.id,
        phone,
        kind: kindToSend,
        lane: 'slow',
        mode: 'async',
        status: 'failed',
        error_code: waErr.code,
        error_message: waErr.message.slice(0, 300),
        payload: { http_status: waErr.status, days_inactive: daysInactive },
      });

      summary.errors++;
      summary.items.push({
        userId: u.id,
        phone,
        kind: kindToSend,
        status: 'failed',
        error: `${waErr.code}: ${waErr.message}`,
      });

      if (waErr.status === 401 || waErr.status === 429) {
        summary.stoppedReason = waErr.code;
        break;
      }
    }
  }

  return summary;
}
