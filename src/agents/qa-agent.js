/**
 * qa-agent (spec §4.2) — ön-eleme + seçim (ÜRETİM ARTIK ONAYDAN SONRA)
 * scraped tweetleri engagement'a göre skorlar, günlük kotaya göre en yüksek skorluları seçip
 * 'pending_approval' yapar. Metin/görsel ÜRETMEZ — onay kuyruğunda yalnız hedef tweet görünür.
 * Kullanıcı onaylayınca (server /api/approve) Giggle çağrılır: bkz. generateComicForApproved.
 */
import {
  getByStatus,
  getTweet,
  setScore,
  setGeneratedText,
  setImage,
  getSettingNumber,
  updateStatus,
  remainingDailyQuota,
} from '../lib/db.js';
import { generateComicReply } from '../lib/giggle-client.js';
import { log } from '../lib/logger.js';

/** Engagement skoru (spec §4.2) — ağırlıklar settings'ten, sabit kod değil. */
export function scoreTweet(t) {
  const wL = getSettingNumber('score_w_likes', 1);
  const wR = getSettingNumber('score_w_retweets', 2);
  const wRe = getSettingNumber('score_w_replies', 1.5);
  const wQ = getSettingNumber('score_w_quotes', 1.5);
  return (t.likes ?? 0) * wL + (t.retweets ?? 0) * wR + (t.replies ?? 0) * wRe + (t.quotes ?? 0) * wQ;
}

/**
 * scraped tweetleri skorlar, günlük kota kadar en yüksek skorluyu 'pending_approval' yapar.
 * Üretim YOK — Giggle çağrısı onaydan sonra (generateComicForApproved) yapılır.
 * @returns {Promise<{processed:number, selected:number, skipped:number}>}
 */
export async function runQaCycle() {
  const scraped = getByStatus('scraped');
  const result = { processed: 0, selected: 0, skipped: 0 };
  if (scraped.length === 0) return result;

  // Skorla + kaydet
  for (const t of scraped) setScore(t.id, scoreTweet(t));

  // Skora göre sırala (en yüksek önce)
  const ranked = scraped
    .map((t) => ({ ...t, _score: scoreTweet(t) }))
    .sort((a, b) => b._score - a._score);

  const quota = remainingDailyQuota();
  if (quota <= 0) {
    log('qa', `Günlük kota dolu — seçim atlandı (${scraped.length} scraped bekliyor)`);
    return result;
  }

  // Onay kuyruğu üst sınırı: pending_approval zamanla birikip şişmesin (kullanıcı isteği).
  // Boş slot = min(günlük kota, kuyruk üst sınırı - mevcut bekleyen sayısı).
  const queueMax = getSettingNumber('approval_queue_max', 100);
  const pendingNow = getByStatus('pending_approval').length;
  const queueSlots = queueMax > 0 ? Math.max(0, queueMax - pendingNow) : quota;
  const slots = Math.min(quota, queueSlots);
  if (slots <= 0) {
    log('qa', `Onay kuyruğu dolu (${pendingNow}/${queueMax}) — seçim atlandı (${scraped.length} scraped bekliyor)`);
    return result;
  }

  const candidates = ranked.slice(0, slots);
  log('qa', `${scraped.length} scraped, kota ${quota}, kuyruk boş slot ${queueSlots}, ${candidates.length} aday onaya alınıyor`);

  for (const t of candidates) {
    result.processed++;
    // İkinci katman dedup (spec §4.2): statü hâlâ 'scraped' mi?
    const fresh = getTweet(t.id);
    if (!fresh || fresh.status !== 'scraped') {
      result.skipped++;
      continue;
    }
    updateStatus(t.id, 'pending_approval');
    result.selected++;
  }
  log('qa', `${result.selected} tweet onay kuyruğuna alındı`);
  return result;
}

/**
 * Onaydan SONRA çağrılır: hedef tweet için Giggle ile çizgi-roman reply (metin + görsel) üretir,
 * DB'ye yazar. server /api/approve ve /api/retry tarafından kullanılır. Hata olursa fırlatır
 * (çağıran status'ü 'failed' yapar). Görsel Giggle içinde data/images'e indirilir.
 * @param {string} tweetId
 * @returns {Promise<{ok:true}>}
 */
export async function generateComicForApproved(tweetId) {
  const t = getTweet(tweetId);
  if (!t) throw new Error('tweet bulunamadı');
  let media = [];
  try {
    media = t.tweet_media ? JSON.parse(t.tweet_media) : [];
  } catch {
    media = [];
  }

  const gen = await generateComicReply({
    id: t.id,
    text: t.text,
    author: t.author,
    media,
  });

  setGeneratedText(t.id, { replyText: gen.replyText });
  setImage(t.id, { imageUrl: gen.imageUrl, imagePath: gen.imagePath });
  log('qa', `${tweetId} Giggle çizgi-roman üretildi (@${t.author}${gen.imagePath ? ', görselli' : ', metin'})`);
  return { ok: true };
}
