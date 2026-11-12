// Edge Function : weekly-report
// Rapport hebdomadaire par email : temps d'étude, progression, points faibles, objectifs
import { handleOptions, jsonResponse, errorResponse } from '../_shared/cors.ts';
import { createAdminClient } from '../_shared/supabase.ts';
import { renderEmailLayout, sendEmail, unsubscribePageHtml } from '../_shared/email.ts';

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

  if (req.method === 'GET' && url.searchParams.has('unsubscribe')) {
    const token = url.searchParams.get('unsubscribe')!;
    const kind = url.searchParams.get('kind') || 'weekly';
    const { data } = await admin.rpc('pran_not_unsubscribe_by_token', { p_token: token, p_kind: kind });
    return unsubscribePageHtml(Boolean(data));
  }

  if (!isAuthorizedCron(req)) {
    return errorResponse('forbidden', 'Accès refusé', 403);
  }

  try {
    const appUrl = (Deno.env.get('APP_URL') || 'https://prannot.ht').replace(/\/$/, '');
    const fnBase = `${Deno.env.get('SUPABASE_URL')}/functions/v1/weekly-report`;
    const sinceIso = new Date(Date.now() - 7 * 86400000).toISOString();

    const { data: users } = await admin
      .from('pran_not_profiles')
      .select('id, email, full_name, language, daily_goal_minutes, notify_weekly, unsubscribe_token, is_banned')
      .eq('onboarded', true)
      .eq('notify_weekly', true)
      .eq('is_banned', false);

    let processed = 0;
    let emailed = 0;

    for (const u of users || []) {
      if (!u.email) continue;
      const lang = u.language === 'fr' ? 'fr' : 'ht';

      const [{ data: sessions }, { count: revCount }, { data: attempts }, { data: weakKws }] = await Promise.all([
        admin.from('pran_not_study_sessions').select('duration_minutes').eq('user_id', u.id).gte('started_at', sinceIso),
        admin.from('pran_not_card_reviews').select('id', { count: 'exact', head: true }).eq('user_id', u.id).gte('reviewed_at', sinceIso),
        admin.from('pran_not_test_attempts').select('percent').eq('user_id', u.id).not('finished_at', 'is', null).gte('created_at', sinceIso),
        admin.from('pran_not_keywords').select('term').eq('user_id', u.id).gte('weakness', 40).order('weakness', { ascending: false }).limit(3),
      ]);

      const totalMin = (sessions || []).reduce((acc, s) => acc + (s.duration_minutes || 0), 0);
      const testAvg = attempts?.length
        ? Math.round(attempts.reduce((a, b) => a + Number(b.percent || 0), 0) / attempts.length)
        : null;
      const weakList = (weakKws || []).map((k) => k.term).join(', ');
      const targetWeekMin = (u.daily_goal_minutes || 30) * 7;

      const subject = lang === 'fr'
        ? 'Pran Nòt — Votre bilan d’étude de la semaine'
        : 'Pran Nòt — Bilan etid semèn nan';

      const greeting = lang === 'fr'
        ? `Bonjour ${u.full_name || ''}, voici vos progrès des 7 derniers jours.`
        : `Bonjou ${u.full_name || ''}, men rezilta travay ou nan 7 dènye jou yo.`;

      const bodyHtml = lang === 'fr'
        ? `<ul style="padding-left:18px;margin:0;">
             <li><strong>Temps d'étude :</strong> ${totalMin} min (objectif semaine : ${targetWeekMin} min)</li>
             <li><strong>Flashcards révisées :</strong> ${revCount || 0}</li>
             <li><strong>Moyenne aux tests :</strong> ${testAvg !== null ? `${testAvg} %` : 'Aucun test cette semaine'}</li>
             <li><strong>Points faibles à revoir :</strong> ${weakList || 'Aucun point critique détecté'}</li>
             <li><strong>Objectif semaine prochaine :</strong> maintenir votre série et viser ${targetWeekMin} min.</li>
           </ul>`
        : `<ul style="padding-left:18px;margin:0;">
             <li><strong>Tan etid :</strong> ${totalMin} min (objektif semèn : ${targetWeekMin} min)</li>
             <li><strong>Kat memwa revize :</strong> ${revCount || 0}</li>
             <li><strong>Mwayèn tès yo :</strong> ${testAvg !== null ? `${testAvg} %` : 'Okenn tès semèn sa a'}</li>
             <li><strong>Pwen fèb pou travay :</strong> ${weakList || 'Okenn pwen kritik'}</li>
             <li><strong>Objektif semèn pwochèn :</strong> kenbe ritm lan epi rive nan ${targetWeekMin} min.</li>
           </ul>`;

      const html = renderEmailLayout({
        title: lang === 'fr' ? 'Rapport hebdomadaire' : 'Rapò chak semèn',
        greeting,
        bodyHtml,
        ctaUrl: `${appUrl}/pages/progress.html`,
        ctaLabel: lang === 'fr' ? 'Voir mes statistiques' : 'Gade pwogrè mwen',
        unsubscribeUrl: `${fnBase}?unsubscribe=${u.unsubscribe_token}&kind=weekly`,
        lang,
      });

      const sendRes = await sendEmail({ to: u.email, subject, html });
      if (sendRes.sent) emailed++;

      await admin.from('pran_not_notifications').insert({
        user_id: u.id,
        kind: 'report',
        title: subject,
        body: `${totalMin} min • ${revCount || 0} kat`,
        link: 'progress.html',
        sent_email_at: sendRes.sent ? new Date().toISOString() : null,
      });
      processed++;
    }

    return jsonResponse({ ok: true, processed, emailed });
  } catch (err) {
    console.error('[weekly-report]', err);
    return errorResponse('cron_error', (err as Error).message, 500);
  }
});
