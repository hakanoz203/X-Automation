/**
 * scraping-agent (spec §4.1)
 * Dashboard'dan gelen keyword'ler için popüler tweetleri çeker, dedup'layarak
 * DB'ye status='scraped' olarak yazar. Tetik: dashboard "Scrape Et" (manuel).
 */
import { search } from '../lib/xactions-client.js';
import { insertScrapedTweet, getSettingNumber, getSetting } from '../lib/db.js';
import { log } from '../lib/logger.js';

/**
 * Keyword'e Katman 1 kalite filtresi operatörlerini ekler (X sunucu tarafında eler, §4.1).
 * Orijinal keyword aramada kullanılır; DB'ye orijinal keyword yazılır (operatörler değil).
 * @param {string} kw
 * @returns {string} X arama sorgusu
 */
export function buildSearchQuery(kw) {
  const parts = [kw];
  const minFaves = getSettingNumber('filter_min_faves', 0);
  if (minFaves > 0) parts.push(`min_faves:${Math.round(minFaves)}`);
  const withinDays = getSettingNumber('filter_within_days', 0);
  if (withinDays > 0) {
    const since = new Date(Date.now() - withinDays * 86400_000).toISOString().slice(0, 10);
    parts.push(`since:${since}`);
  }
  // Not: `-filter:replies` X SearchTimeline'da 0 sonuç döndürüyor (desteklenmiyor) → yanıt
  // hariç tutma Katman 2'de kod ile yapılır (passesQualityFilter, t.isReply).
  return parts.join(' ');
}

/**
 * Katman 2 kalite filtresi (kod, §4.2): X operatörleriyle ifade edilemeyen kuralları uygular —
 * minimum görüntülenme, yorum üst tavanı, yorum/görüntülenme oranı ("gömülme" koruması), tazelik.
 * views bilinmiyorsa (0) view tabanlı kontroller ATLANIR (min_faves Katman 1'de zaten uygulandı).
 * @param {object} t parse edilmiş tweet (views, replies, createdAt içerir)
 * @returns {{ok:boolean, reason?:string}}
 */
export function passesQualityFilter(t) {
  const minViews = getSettingNumber('filter_min_views', 0);
  const maxReplies = getSettingNumber('filter_max_replies', 0);
  const maxRatio = getSettingNumber('filter_max_reply_view_ratio', 0);
  const maxAgeH = getSettingNumber('filter_max_age_hours', 0);

  const views = t.views ?? 0;
  const replies = t.replies ?? 0;

  if (String(getSetting('filter_exclude_replies', '0')) === '1' && t.isReply)
    return { ok: false, reason: 'yanıt tweeti' };
  if (maxReplies > 0 && replies > maxReplies) return { ok: false, reason: `replies>${maxReplies}` };
  if (views > 0) {
    if (minViews > 0 && views < minViews) return { ok: false, reason: `views<${minViews}` };
    if (maxRatio > 0 && replies / views > maxRatio)
      return { ok: false, reason: `reply/view>${maxRatio}` };
  }
  if (maxAgeH > 0 && t.createdAt) {
    const ageH = (Date.now() - new Date(t.createdAt).getTime()) / 3600_000;
    if (Number.isFinite(ageH) && ageH > maxAgeH) return { ok: false, reason: `age>${maxAgeH}h` };
  }
  return { ok: true };
}

/**
 * Bir veya birden fazla keyword'ü scrape eder.
 * @param {string[]} keywords
 * @param {object} [opts] { targetPerKeyword?, type? }
 * @returns {Promise<{total:{found,inserted,skipped}, perKeyword:object}>}
 */
export async function scrapeKeywords(keywords, opts = {}) {
  const target = opts.targetPerKeyword ?? getSettingNumber('scrape_target_per_keyword', 200);
  const type = opts.type ?? 'Top';
  const perKeyword = {};
  const total = { found: 0, inserted: 0, skipped: 0, filtered: 0, authorCapped: 0 };

  for (const rawKw of keywords) {
    const kw = String(rawKw).trim();
    if (!kw) continue;
    const stat = { found: 0, inserted: 0, skipped: 0, filtered: 0, authorCapped: 0 };
    try {
      const query = buildSearchQuery(kw); // Katman 1 kalite filtresi (min_faves, since, -filter:replies)
      const tweets = await search(query, target, { type });
      stat.found = tweets.length;
      for (const t of tweets) {
        // Katman 2 kalite filtresi (views/oran/tazelik) — geçmeyeni DB'ye hiç yazma.
        const q = passesQualityFilter(t);
        if (!q.ok) {
          stat.filtered++;
          continue;
        }
        t.keyword = kw; // DB'ye orijinal keyword yaz (operatörler değil)
        const res = insertScrapedTweet(t);
        if (res === 'inserted') stat.inserted++;
        else if (res === 'skipped_author_cap') {
          stat.authorCapped++; // (E) hesap pencere içi reply sınırını doldurmuş
          stat.skipped++;
        } else stat.skipped++; // skipped_pending | skipped_processed | skipped_rejected
      }
      log(
        'scraping',
        `"${kw}" (sorgu: ${query}): ${stat.found} bulundu, ${stat.inserted} yeni, ${stat.filtered} kalite-elendi, ${stat.authorCapped} hesap-limiti-elendi, ${stat.skipped} atlandı`
      );
    } catch (err) {
      stat.error = err.message;
      log('scraping', `"${kw}" HATA: ${err.message}`, 'error');
    }
    perKeyword[kw] = stat;
    total.found += stat.found;
    total.inserted += stat.inserted;
    total.skipped += stat.skipped;
    total.filtered += stat.filtered;
    total.authorCapped += stat.authorCapped;
  }

  return { total, perKeyword };
}
