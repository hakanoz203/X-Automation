/**
 * Giggle client — çizgi-roman reply üretimi (OpenAI + fal.ai YERİNE tek servis).
 *
 * Giggle Supabase Edge Function'ı, hedef tweetin görselini/videosunu bir çizgi-roman paneline
 * çevirip HEM reply metnini HEM üretilen görseli döndürür. Böylece ayrı metin (OpenAI) ve
 * görsel (fal.ai) adımlarına gerek kalmaz.
 *
 * Auth: `x-api-key: <GIGGLE_API_KEY>` (endpoint probe'u ile doğrulandı; Authorization/apikey
 * header'ları 401 verir). Yapılandırılabilir: GIGGLE_AUTH_SCHEME = x-api-key | bearer | apikey.
 *
 * Görsel imzalı Supabase storage URL'i olarak döner ve ~1 saat geçerlidir; post saatler sonra
 * olabileceğinden görsel ÜRETİM ANINDA data/images/'e indirilir (fal.ai deseninin aynısı).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = resolve(__dirname, '../../data/images');

const DEFAULT_TIMEOUT_MS = 180_000; // çizgi-roman üretimi yavaş (gözlemlenen ~105sn) — geniş pay
// Giggle Edge Function'ın kendi "idle timeout"u 150s: üretim uzarsa Supabase 504 IDLE_TIMEOUT
// döndürüp isteği düşürür (bizim client timeout'umuzdan bağımsız, sunucu tarafı). Bu GEÇİCİdir —
// üretim süresi değişkendir, taze bir istek çoğu zaman geçer → sınırlı sayıda otomatik retry.
const MAX_ATTEMPTS = Number(process.env.GIGGLE_MAX_RETRIES ?? 2) + 1; // toplam deneme (retry + ilk)
const RETRY_BASE_DELAY_MS = 3_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Yanıtın/hatanın geçici (retry edilebilir) olup olmadığını söyler. */
function isTransientGiggleError({ status, bodyText, aborted }) {
  if (aborted) return true; // client timeout (üretim çok uzadı) — taze istek geçebilir
  if (status === 502 || status === 503 || status === 504) return true;
  if (bodyText && /IDLE_TIMEOUT|idle timeout|timeout/i.test(bodyText)) return true;
  return false;
}

/**
 * Giggle tanıtım/link bloğunu reply metninden temizler (ban riski azaltma — X, tekrar eden +
 * app-store linkli reply'ları agresif spam/otomasyon sinyali sayar). `strip_promo_links` ayarı
 * açıkken POST ANINDA uygulanır; DB'deki tam metin (dashboard önizlemesi) değişmez.
 * "<gerçek cevap> — Giggle" kısmı korunur; "Download Giggle 👇 / App Store: … / Google Play: …"
 * bloğu ve app-store URL'leri atılır.
 * @param {string} text
 * @returns {string}
 */
export function stripPromoLinks(text) {
  if (!text) return text;
  let s = String(text);
  s = s.replace(/\n*\s*Download Giggle[\s\S]*$/i, ''); // "Download Giggle 👇" ve sonrası (link bloğu)
  s = s.replace(/^\s*(App Store|Google Play)\s*:.*$/gim, ''); // artık kalan link satırları
  s = s.replace(/https?:\/\/(?:apps\.apple\.com|play\.google\.com)\/\S*/gi, ''); // güvenlik ağı
  s = s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function extFromContentType(ct = '') {
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return 'png';
}

/** Seçilen auth şemasına göre header nesnesi. Varsayılan: x-api-key. */
function authHeader(key) {
  const scheme = (process.env.GIGGLE_AUTH_SCHEME || 'x-api-key').toLowerCase();
  if (scheme === 'bearer') return { Authorization: `Bearer ${key}` };
  if (scheme === 'apikey') return { apikey: key };
  return { 'x-api-key': key }; // varsayılan (doğrulanmış)
}

/**
 * Hedef tweet için çizgi-roman reply (metin + görsel) üretir.
 * @param {{id:string, text:string, author:string, media?:string[]}} tweet
 * @returns {Promise<{replyText:string, imagePath:string|null, imageUrl:string|null, raw:object}>}
 */
export async function generateComicReply({ id, text, author, media }) {
  const url = process.env.GIGGLE_API_URL;
  const key = process.env.GIGGLE_API_KEY;
  if (!url) throw new Error('GIGGLE_API_URL tanımlı değil');
  if (!key) throw new Error('GIGGLE_API_KEY tanımlı değil');

  const body = {
    id: String(id),
    text: text ?? '',
    author: author ?? '',
    platform: 'twitter',
    media: Array.isArray(media) ? media : [],
  };

  // Geçici hatalarda (504 IDLE_TIMEOUT, 502/503, client timeout) sınırlı otomatik retry.
  let data;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader(key) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err.name === 'AbortError';
      lastErr = new Error(`Giggle isteği başarısız: ${aborted ? 'zaman aşımı' : err.message}`);
      if (attempt < MAX_ATTEMPTS && isTransientGiggleError({ aborted })) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw lastErr;
    }
    clearTimeout(timer);

    const respText = await resp.text();
    if (!resp.ok) {
      lastErr = new Error(`Giggle hata ${resp.status}: ${respText.slice(0, 300)}`);
      if (attempt < MAX_ATTEMPTS && isTransientGiggleError({ status: resp.status, bodyText: respText })) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw lastErr;
    }

    try {
      data = JSON.parse(respText);
    } catch {
      throw new Error(`Giggle JSON parse edilemedi: ${respText.slice(0, 200)}`);
    }
    break; // başarılı yanıt
  }

  const replyText = String(data.text ?? '').trim();
  if (!replyText) throw new Error('Giggle reply metni (text) döndürmedi');
  const imageUrl = Array.isArray(data.media) ? data.media[0] : null;

  // Görseli hemen indir (imzalı URL süreli) — yerelden serve edilir + reply'a iliştirilir.
  let imagePath = null;
  if (imageUrl) {
    try {
      const imgResp = await fetch(imageUrl);
      if (!imgResp.ok) throw new Error(`HTTP ${imgResp.status}`);
      const buf = Buffer.from(await imgResp.arrayBuffer());
      mkdirSync(IMAGES_DIR, { recursive: true });
      const ext = extFromContentType(imgResp.headers.get('content-type'));
      imagePath = resolve(IMAGES_DIR, `${id}.${ext}`);
      writeFileSync(imagePath, buf);
    } catch (err) {
      // Görsel indirilemezse metinle devam (post-agent görselsiz de postlar).
      imagePath = null;
    }
  }

  return { replyText: replyText.slice(0, 280), imagePath, imageUrl, raw: data };
}
