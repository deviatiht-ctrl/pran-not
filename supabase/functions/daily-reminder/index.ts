// Edge Function : daily-reminder
// Planifiée via pg_cron : plan du jour, cartes dues, série en danger, échéances J-7/J-3/J-1
// + Rapèl otomatik WhatsApp (Slow Lane CVISUAL Gateway) pou etidyan ki pa monte sou sit la
// + GET ?unsubscribe=<token>&kind=daily pou désabonnement en 1 clic
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createAdminClient } from '../_shared/supabase.ts';
import { renderEmailLayout, sendEmail, unsubscribePageHtml } from '../_shared/email.ts';
import { runAutomatedWhatsAppReminders } from '../_shared/reminders.ts';

function isAuthorizedCron(req: Request): boolean {
  const secret = Deno.env.get('CRON_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const auth = req.headers.get('Authorization') || '';
  const hdr = req.headers.get('x-cron-secret') || '';
  if (!secret) return false;
  return auth === `Bearer ${secret}` || hdr === secret;
}

Deno.serve(async (req) => {
  const opt = handleOptions(req);
  if (opt) return opt;

  const admin = createAdminClient();
  const url = new URL(req.url);

  // Désabonnement en 1 clic
  if (req.method === 'GET' && url.searchParams.has('unsubscribe')) {
    const token = url.searchParams.get('unsubscribe')!;
    const kind = url.searchParams.get('kind') || 'daily';
    const { data } = await admin.rpc('pran_not_unsubscribe_by_token', { p_token: token, p_kind: kind });
    return unsubscribePageHtml(Boolean(data));
  }

  if (!isAuthorizedCron(req)) {
    return errorResponse('forbidden', 'Accès refusé', 403);
  }

  try {
    const appUrl = (Deno.env.get('APP_URL') || 'https://prannot.ht').replace(/\/$/, '');
    const fnBase = `${Deno.env.get('SUPABASE_URL')}/functions/v1/daily-reminder`;
    const todayStr = new Date().toISOString().slice(0, 10);

    const { data: users } = await admin
      .from('pran_not_profiles')
      .select('id, email, full_name, language, notify_email, notify_deadlines, unsubscribe_token, is_banned')
      .eq('onboarded', true)
      .eq('is_banned', false);

    let processed = 0;
    let emailed = 0;

    for (const u of users || []) {
      if (!u.email) continue;
      const lang = u.language === 'fr' ? 'fr' : 'ht';

      // Cartes dues + série
      const [{ count: dueCount }, { data: streak }, { data: assignments }] = await Promise.all([
        admin.from('pran_not_flashcards').select('id', { count: 'exact', head: true })
          .eq('user_id', u.id).eq('suspended', false).lte('due_at', new Date().toISOString()),
        admin.from('pran_not_streaks').select('current, last_active_date').eq('user_id', u.id).maybeSingle(),
        admin.from('pran_not_assignments').select('id, title, due_at, reminders_sent')
          .eq('user_id', u.id).in('status', ['todo', 'in_progress']).not('due_at', 'is', null),
      ]);

      // Vérifier les échéances J-7, J-3, J-1
      const deadlineAlerts: string[] = [];
      for (const a of assignments || []) {
        const diffDays = Math.ceil((new Date(a.due_at).getTime() - Date.now()) / 86400000);
        const sent = Array.isArray(a.reminders_sent) ? a.reminders_sent : [];
        let tag = '';
        if (diffDays === 1 && !sent.includes('J1')) tag = 'J1';
        else if (diffDays <= 3 && diffDays > 1 && !sent.includes('J3')) tag = 'J3';
        else if (diffDays <= 7 && diffDays > 3 && !sent.includes('J7')) tag = 'J7';

        if (tag && u.notify_deadlines) {
          deadlineAlerts.push(`${a.title} (${tag === 'J1' ? 'demen' : `${diffDays} j`})`);
          await admin.from('pran_not_assignments').update({ reminders_sent: [...sent, tag] }).eq('id', a.id);
        }
      }

      if (!u.notify_email && !deadlineAlerts.length) continue;

      const streakDanger = (streak?.current || 0) > 0 && streak?.last_active_date !== todayStr;
      const name = u.full_name || '';

      const subject = lang === 'fr'
        ? `Pran Nòt — Votre plan du jour (${dueCount || 0} cartes dues)`
        : `Pran Nòt — Plan jounen ou an (${dueCount || 0} kat pou revize)`;

      const greeting = lang === 'fr'
        ? `Bonjour ${name}, voici votre résumé du jour sur Pran Nòt.`
        : `Bonjou ${name}, men plan etid ou pou jodi a sou Pran Nòt.`;

      const items: string[] = [];
      items.push(lang === 'fr'
        ? `<li><strong>Cartes à réviser :</strong> ${dueCount || 0}</li>`
        : `<li><strong>Kat pou revize :</strong> ${dueCount || 0}</li>`);
      if (streakDanger) {
        items.push(lang === 'fr'
          ? `<li><strong>Série en danger :</strong> connectez-vous aujourd'hui pour garder votre série de ${streak?.current} jours.</li>`
          : `<li><strong>Seri an danje :</strong> etidye jodi a pou w pa pèdi seri ${streak?.current} jou ou a.</li>`);
      }
      if (deadlineAlerts.length) {
        items.push(lang === 'fr'
          ? `<li><strong>Échéances proches :</strong> ${deadlineAlerts.join(', ')}</li>`
          : `<li><strong>Devwa ki pwòch :</strong> ${deadlineAlerts.join(', ')}</li>`);
      }

      const html = renderEmailLayout({
        title: lang === 'fr' ? 'Votre plan d’étude du jour' : 'Plan etid ou pou jodi a',
        greeting,
        bodyHtml: `<ul style="padding-left:18px;margin:0;">${items.join('')}</ul>`,
        ctaUrl: `${appUrl}/pages/dashboard.html`,
        ctaLabel: lang === 'fr' ? 'Ouvrir mon plan du jour' : 'Louvri plan jounen mwen',
        unsubscribeUrl: `${fnBase}?unsubscribe=${u.unsubscribe_token}&kind=daily`,
        lang,
      });

      const sendRes = await sendEmail({ to: u.email, subject, html });
      if (sendRes.sent) emailed++;

      await admin.from('pran_not_notifications').insert({
        user_id: u.id,
        kind: deadlineAlerts.length ? 'deadline' : (streakDanger ? 'streak' : 'reminder'),
        title: subject,
        body: deadlineAlerts.length ? deadlineAlerts.join(', ') : `${dueCount || 0} kat pou revize`,
        link: 'dashboard.html',
        sent_email_at: sendRes.sent ? new Date().toISOString() : null,
      });
      processed++;
    }

    const waSummary = await runAutomatedWhatsAppReminders(admin, {
      maxPerRun: 20,
      appUrl,
    });

    return jsonResponse({ ok: true, processed, emailed, whatsapp: waSummary });
  } catch (err) {
    console.error('[daily-reminder]', err);
    return errorResponse('cron_error', (err as Error).message, 500);
  }
});
