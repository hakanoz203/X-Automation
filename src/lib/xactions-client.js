/**
 * X merkezi client — TÜM X aksiyonları buradan geçer (spec §3).
 *
 * Kendi minimal GraphQL client'ımızı (`x-graphql.js`) sarar. XActions ve
 * agent-twitter-client bu ortamda çalışmadı (bkz. docs/xactions-notes.md); ham
 * authenticated GraphQL istekleri çalışıyor, queryId'ler X bundle'ından dinamik çekiliyor.
 *
 * Merkezi sorumluluklar (spec §3, §7):
 *  - Aksiyonlar arası minimum bekleme + jitter (ban riski)
 *  - Basit retry/backoff
 */
import {
  searchTweets,
  uploadImage,
  createReply,
  verifyAuth,
  proxyStatus,
  checkExitIp,
} from './x-graphql.js';

export { proxyStatus, checkExitIp };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Aksiyonlar arası bekleme (merkezi ban-riski önlemi) -------------------
let _lastActionAt = 0;
const MIN_ACTION_GAP_MS = 1500;

async function throttle() {
  const wait = _lastActionAt + MIN_ACTION_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait + Math.random() * 500); // + jitter
  _lastActionAt = Date.now();
}

async function withRetry(fn, { retries = 2, label = 'x-action' } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      await throttle();
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err?.status === 401 || err?.status === 403) break; // auth → retry anlamsız
      // Throttle/otomasyon/kota (boş tweet_results, 226, 344): hızlı retry hem işe yaramaz hem
      // spam sinyalini büyütür → hemen vazgeç, üst katman (direct-post fallback / kullanıcı retry)
      // zamanlayıp DAHA SONRA dener (gecikme throttle'ı temizler).
      if (err?.throttled || err?.noRetry) break;
      if (i < retries) await sleep(1000 * (i + 1));
    }
  }
  const e = new Error(`[${label}] başarısız: ${lastErr?.message || lastErr}`);
  e.cause = lastErr;
  e.status = lastErr?.status;
  // Sınıflandırma bayraklarını üst katmana taşı (direct-post fallback bunlara göre karar verir):
  // throttled = geçici (boş tweet_results, gecikmeyle geçer); noRetry = sert (226/344/auth).
  e.throttled = lastErr?.throttled;
  e.noRetry = lastErr?.noRetry;
  e.graphqlCode = lastErr?.graphqlCode;
  throw e;
}

/** Cookie'lerin geçerliliğini kontrol eder (dashboard health). */
export async function checkAuth() {
  return verifyAuth();
}

/**
 * Keyword ile POPÜLER tweetleri ara (spec §4.1).
 * @returns {Promise<Array>} { id, author, text, likes, retweets, replies, quotes, url, keyword }
 */
export async function search(keyword, limit, opts = {}) {
  return withRetry(
    async () => {
      const tweets = await searchTweets(keyword, {
        limit,
        product: opts.type ?? 'Top',
      });
      return tweets.map((t) => ({ ...t, keyword }));
    },
    { label: `search:${keyword}` }
  );
}

/**
 * Metin + (opsiyonel) görsel reply postla (spec §4.4).
 * @param {string} tweetId
 * @param {string} text
 * @param {string|Buffer|null} imagePathOrBuffer
 * @returns {Promise<{replyId:string|null}>}
 */
export async function postReply(tweetId, text, imagePathOrBuffer = null) {
  let mediaIds = [];
  if (imagePathOrBuffer) {
    const mediaId = await withRetry(() => uploadImage(imagePathOrBuffer), { label: 'uploadImage' });
    mediaIds = [mediaId];
  }
  return withRetry(() => createReply(tweetId, text, mediaIds), { label: `reply:${tweetId}` });
}

/** Tweet nesnesinden X permalink. */
export function tweetUrl(tweet) {
  if (tweet?.url) return tweet.url;
  const user = tweet?.author ?? tweet?.username;
  return user && tweet?.id ? `https://x.com/${user}/status/${tweet.id}` : null;
}
