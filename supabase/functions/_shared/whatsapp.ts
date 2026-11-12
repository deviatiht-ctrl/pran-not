// Client HTTP backend konplè pou API REST CVISUAL WhatsApp Gateway
// Règle sékirité : kle API CVISUAL_WA_API_KEY (oswa pran_not_wa_settings.api_key) rete 100 % sou sèvè a.
import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export const DEFAULT_CVISUAL_WA_BASE_URL = 'https://cvisual-whatsapp-gateway.onrender.com';

export const FAST_LANE_KINDS = ['receipt', 'welcome', 'otp', 'test', 'manual_direct'] as const;
export const SLOW_LANE_KINDS = ['reminder', 'reminder_7d', 'reminder_2d', 'marketing', 'manual'] as const;

export type FastLaneKind = (typeof FAST_LANE_KINDS)[number];
export type SlowLaneKind = (typeof SLOW_LANE_KINDS)[number];
export type MessageKind = FastLaneKind | SlowLaneKind;
export type MessageLane = 'fast' | 'slow';
export type SendMode = 'async' | 'sync';

export interface WaSettingsRow {
  id: string;
  base_url: string;
  api_key: string | null;
  webhook_secret: string | null;
  enabled: boolean;
  welcome_enabled: boolean;
  inactivity_days: number;
  reminder_cooldown_hours: number;
  deadline_enabled: boolean;
  inactive_template_ht: string;
  inactive_template_fr: string;
  deadline_template_ht: string;
  deadline_template_fr: string;
  updated_at?: string;
}

export interface SendMessagePayload {
  to: string;
  message: string;
  kind?: MessageKind | string;
  mode?: SendMode;
  accountIndex?: number;
  pdfBase64?: string;
  pdfFileName?: string;
  idempotencyKey?: string;
}

export interface ListMessagesParams {
  limit?: number;
  offset?: number;
  status?: string;
  kind?: string;
}

export class CvisualWaError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'CvisualWaError';
    this.status = status;
    this.code = code;
    this.retryable = status === 429 || status === 502 || status === 503 || status === 504;
    this.details = details;
  }
}

export function resolveLane(kind: string): MessageLane {
  if ((FAST_LANE_KINDS as readonly string[]).includes(kind)) return 'fast';
  if ((SLOW_LANE_KINDS as readonly string[]).includes(kind)) return 'slow';
  throw new CvisualWaError(400, 'INVALID_KIND', `Tip mesaj enkoni : ${kind}`);
}

/**
 * Nòmalize nimewo telefòn selon règle CVISUAL :
 * - 8 chif lokal (ex: 31234567) -> 50931234567
 * - E.164 san '+' ant 8 ak 15 chif (ex: 50931234567)
 */
export function normalizePhone(raw: string): string {
  const cleaned = String(raw || '').trim().replace(/[\s+().-]+/g, '');
  if (/^\d{8}$/.test(cleaned)) {
    return `509${cleaned}`;
  }
  if (/^\d{8,15}$/.test(cleaned)) {
    return cleaned;
  }
  throw new CvisualWaError(
    400,
    'INVALID_PHONE',
    'Fòma telefòn lan pa valab. Antre 8 chif (ex: 31234567) oswa 509XXXXXXXX (8 a 15 chif).',
  );
}

/** Netwaye PDF Base64 epi verifye limit 10 MB. */
export function sanitizePdfBase64(rawBase64: string): string {
  const b64 = String(rawBase64 || '').replace(/^data:application\/pdf;base64,/i, '').replace(/\s+/g, '');
  if (!b64) {
    throw new CvisualWaError(400, 'INVALID_PDF', 'Kontni PDF Base64 la vid.');
  }
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const approxBytes = Math.floor((b64.length * 3) / 4) - padding;
  const MAX_BYTES = 10 * 1024 * 1024;
  if (approxBytes > MAX_BYTES) {
    throw new CvisualWaError(413, 'PDF_TOO_LARGE', 'Fichye PDF la depase limit 10 MB la.');
  }
  return b64;
}

/** Maske yon kle API pou afichaj Admin sèlman (jamè retounen kle konplè a bay navigatè). */
export function maskApiKey(key?: string | null): string {
  const k = (key || '').trim();
  if (!k) return '';
  if (k.length <= 12) return `${k.slice(0, 4)}••••`;
  return `${k.slice(0, 8)}••••${k.slice(-4)}`;
}

/** Ranplase varyab yo nan modèl la san kraze spintax {A|B}. */
export function renderSpintaxTemplate(
  template: string,
  vars: Record<string, string | number | undefined>,
): string {
  let out = String(template || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(v ?? ''));
  }
  return out.trim();
}

function defaultErrorCode(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 413: return 'PAYLOAD_TOO_LARGE';
    case 422: return 'UNPROCESSABLE_ENTITY';
    case 429: return 'RATE_LIMITED';
    case 503: return 'WHATSAPP_OFFLINE';
    default: return `HTTP_${status}`;
  }
}

function timingSafeEqualUtf8(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

/** Verifye siyati X-CVISUAL-Signature = "sha256=" + HMAC_SHA256(secret, timestamp + "." + rawBody). */
export async function verifyCvisualWebhook(opts: {
  secret: string;
  timestamp: string;
  signatureHeader: string;
  rawBody: string;
  maxAgeSeconds?: number;
}): Promise<{ valid: boolean; reason?: string }> {
  const secret = (opts.secret || '').trim();
  const timestamp = (opts.timestamp || '').trim();
  const sig = (opts.signatureHeader || '').trim().toLowerCase();

  if (!secret) return { valid: false, reason: 'webhook_secret_missing' };
  if (!timestamp || !sig) return { valid: false, reason: 'missing_signature_headers' };
  if (!sig.startsWith('sha256=')) return { valid: false, reason: 'invalid_signature_format' };

  if (opts.maxAgeSeconds && opts.maxAgeSeconds > 0 && /^\d+$/.test(timestamp)) {
    const num = Number(timestamp);
    const tsSec = num > 1e12 ? Math.floor(num / 1000) : num;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsSec) > opts.maxAgeSeconds) {
      return { valid: false, reason: 'timestamp_expired' };
    }
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signedBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${opts.rawBody}`),
  );
  const expectedHex = Array.from(new Uint8Array(signedBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const expectedHeader = `sha256=${expectedHex}`;

  return timingSafeEqualUtf8(sig, expectedHeader)
    ? { valid: true }
    : { valid: false, reason: 'signature_mismatch' };
}

export class CvisualWhatsAppClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  readonly timeoutMs: number;

  constructor(opts: { apiKey: string; baseUrl?: string; timeoutMs?: number }) {
    this.apiKey = (opts.apiKey || '').trim();
    this.baseUrl = (opts.baseUrl || DEFAULT_CVISUAL_WA_BASE_URL).trim().replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 25000;
  }

  private assertKey() {
    if (!this.apiKey) {
      throw new CvisualWaError(401, 'MISSING_API_KEY', 'Kle API CVISUAL WhatsApp lan pa konfigire sou sèvè a.');
    }
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    init: {
      method?: 'GET' | 'POST' | 'DELETE';
      body?: unknown;
      idempotencyKey?: string;
      requiresAuth?: boolean;
    } = {},
  ): Promise<T> {
    const method = init.method || 'GET';
    const requiresAuth = init.requiresAuth !== false;
    if (requiresAuth) this.assertKey();

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (requiresAuth) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (init.idempotencyKey) {
      headers['Idempotency-Key'] = init.idempotencyKey;
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'network_error';
      throw new CvisualWaError(
        503,
        'WHATSAPP_GATEWAY_UNREACHABLE',
        `Gateway CVISUAL WhatsApp lan pa reponn (${msg}).`,
      );
    }

    const rawText = await res.text();
    let parsed: Record<string, unknown> | null = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      const code = String(parsed?.code || defaultErrorCode(res.status));
      const msg = String(
        parsed?.error || parsed?.message || rawText.slice(0, 240) || `Gateway error HTTP ${res.status}`,
      );
      throw new CvisualWaError(res.status, code, msg, parsed ?? undefined);
    }

    return (parsed ?? ({ ok: true } as Record<string, unknown>)) as T;
  }

  // ---- Sante ak idantite ----
  health() {
    return this.request('/health', { requiresAuth: false });
  }

  me() {
    return this.request('/api/v1/me');
  }

  status() {
    return this.request('/api/v1/status');
  }

  // ---- Verifikasyon nimewo ----
  checkNumbers(phones: string[]) {
    if (!Array.isArray(phones) || phones.length === 0 || phones.length > 50) {
      throw new CvisualWaError(400, 'INVALID_PHONES_LIST', 'Bay ant 1 ak 50 nimewo pou verifye.');
    }
    const normalized = phones.map((p) => normalizePhone(p));
    return this.request('/api/v1/numbers/check', {
      method: 'POST',
      body: { phones: normalized },
    });
  }

  // ---- Voye mesaj (respekte Dual-Lane Fast vs Slow) ----
  sendMessage(input: SendMessagePayload) {
    const kind = String(input.kind || 'manual').trim() as MessageKind;
    const lane = resolveLane(kind);
    const mode: SendMode = input.mode || 'async';

    if (lane === 'slow' && mode === 'sync') {
      throw new CvisualWaError(
        422,
        'SYNC_NOT_ALLOWED_FOR_SLOW_LANE',
        `Kalite mesaj "${kind}" la nan Slow Lane epi li egzije mode="async".`,
      );
    }

    const to = normalizePhone(input.to);
    const message = String(input.message || '').trim();
    if (!message) {
      throw new CvisualWaError(400, 'EMPTY_MESSAGE', 'Tèks mesaj la pa ka vid.');
    }

    const body: Record<string, unknown> = {
      to,
      message,
      kind,
      mode,
    };

    if (typeof input.accountIndex === 'number' && Number.isInteger(input.accountIndex) && input.accountIndex >= 0) {
      body.account_index = input.accountIndex;
    }

    if (input.pdfBase64) {
      body.pdf_base64 = sanitizePdfBase64(input.pdfBase64);
      body.pdf_file_name = (input.pdfFileName || 'Dokiman.pdf').trim().slice(0, 120);
    }

    return this.request('/api/v1/messages/send', {
      method: 'POST',
      body,
      idempotencyKey: input.idempotencyKey,
    });
  }

  sendBulk(messages: SendMessagePayload[], idempotencyKey?: string) {
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) {
      throw new CvisualWaError(400, 'INVALID_BULK_LIST', 'send-bulk aksepte ant 1 ak 100 mesaj.');
    }
    const prepared = messages.map((m) => {
      const kind = String(m.kind || 'manual').trim();
      const lane = resolveLane(kind);
      const mode: SendMode = m.mode || 'async';
      if (lane === 'slow' && mode === 'sync') {
        throw new CvisualWaError(
          422,
          'SYNC_NOT_ALLOWED_FOR_SLOW_LANE',
          `Kalite mesaj "${kind}" la nan Slow Lane epi li egzije mode="async".`,
        );
      }
      const message = String(m.message || '').trim();
      if (!message) throw new CvisualWaError(400, 'EMPTY_MESSAGE', 'Tout mesaj nan lis la dwe gen tèks.');

      const item: Record<string, unknown> = {
        to: normalizePhone(m.to),
        message,
        kind,
        mode,
      };
      if (typeof m.accountIndex === 'number' && Number.isInteger(m.accountIndex) && m.accountIndex >= 0) {
        item.account_index = m.accountIndex;
      }
      if (m.pdfBase64) {
        item.pdf_base64 = sanitizePdfBase64(m.pdfBase64);
        item.pdf_file_name = (m.pdfFileName || 'Dokiman.pdf').trim().slice(0, 120);
      }
      return item;
    });

    return this.request('/api/v1/messages/send-bulk', {
      method: 'POST',
      body: { messages: prepared },
      idempotencyKey,
    });
  }

  listMessages(params: ListMessagesParams = {}) {
    const qs = new URLSearchParams();
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    if (params.status) qs.set('status', params.status);
    if (params.kind) qs.set('kind', params.kind);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request(`/api/v1/messages${suffix}`);
  }

  getMessageStatus(id: string) {
    return this.request(`/api/v1/messages/${encodeURIComponent(id)}/status`);
  }

  cancelMessage(id: string) {
    return this.request(`/api/v1/messages/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
  }

  retryMessage(id: string) {
    return this.request(`/api/v1/messages/${encodeURIComponent(id)}/retry`, { method: 'POST' });
  }

  // ---- Webhooks ----
  listWebhooks() {
    return this.request('/api/v1/webhooks');
  }

  registerWebhook(input: { url: string; events: string[] }) {
    return this.request('/api/v1/webhooks/register', {
      method: 'POST',
      body: input,
    });
  }

  testWebhook(id: string) {
    return this.request(`/api/v1/webhooks/${encodeURIComponent(id)}/test`, { method: 'POST' });
  }

  deleteWebhook(id: string) {
    return this.request(`/api/v1/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

export async function loadWaConfig(admin: SupabaseClient): Promise<{
  settings: WaSettingsRow;
  effectiveApiKey: string;
  keySource: 'database' | 'env' | 'none';
  webhookSecret: string;
  client: CvisualWhatsAppClient;
}> {
  const { data } = await admin
    .from('pran_not_wa_settings')
    .select('*')
    .eq('id', 'default')
    .maybeSingle();

  const defaults: WaSettingsRow = {
    id: 'default',
    base_url: Deno.env.get('CVISUAL_WA_BASE_URL') || DEFAULT_CVISUAL_WA_BASE_URL,
    api_key: null,
    webhook_secret: null,
    enabled: true,
    welcome_enabled: false,
    inactivity_days: 2,
    reminder_cooldown_hours: 48,
    deadline_enabled: true,
    inactive_template_ht:
      '{Bonjou|Alo|Koman ou ye} {name}, sa fe {days} jou nou pa we w sou Pran Not. Ou gen {due} kat memwa ki ap tann ou. Tounen etidye : {url}',
    inactive_template_fr:
      "{Bonjour|Salut} {name}, cela fait {days} jour(s) que vous n'etes pas passe sur Pran Not. Vous avez {due} carte(s) a reviser : {url}",
    deadline_template_ht:
      '{Rapel|Atansyon} {name} : devwa ou yo ({deadlines}) ap rive talè. Louvri Pran Not : {url}',
    deadline_template_fr:
      '{Rappel|Attention} {name} : vos echeances ({deadlines}) approchent. Ouvrez Pran Not : {url}',
  };

  const settings: WaSettingsRow = data ? { ...defaults, ...data } : defaults;
  const dbKey = (settings.api_key || '').trim();
  const envKey = (Deno.env.get('CVISUAL_WA_API_KEY') || '').trim();
  const effectiveApiKey = dbKey || envKey;
  const keySource = dbKey ? 'database' : envKey ? 'env' : 'none';
  const webhookSecret = (settings.webhook_secret || Deno.env.get('CVISUAL_WA_WEBHOOK_SECRET') || '').trim();

  return {
    settings,
    effectiveApiKey,
    keySource,
    webhookSecret,
    client: new CvisualWhatsAppClient({
      apiKey: effectiveApiKey,
      baseUrl: settings.base_url || DEFAULT_CVISUAL_WA_BASE_URL,
    }),
  };
}
