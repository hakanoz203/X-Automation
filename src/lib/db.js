/**
 * DB katmanı — Node 24 yerleşik `node:sqlite` (better-sqlite3 native derleme gerektirmez).
 * WAL modu + repository/DAO fonksiyonları. Tüm ajanlar ve dashboard bu tek modülü kullanır.
 *
 * Not: `node:sqlite` deneysel; import'ta ExperimentalWarning basar (zararsız).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, '../../data/app.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Eşzamanlı 4 ajan + dashboard için WAL zorunlu (spec §6).
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA busy_timeout = 5000');

// --- Şema (spec §6) — idempotent ------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS tweets (
    id TEXT PRIMARY KEY,
    author TEXT,
    text TEXT,
    likes INTEGER,
    retweets INTEGER,
    replies INTEGER,
    quotes INTEGER,
    url TEXT,
    keyword TEXT,
    score REAL,
    generated_reply_text TEXT,
    image_prompt TEXT,
    generated_image_url TEXT,
    generated_image_path TEXT,
    status TEXT,
    scheduled_at DATETIME,
    posted_reply_id TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rejected_tweets (
    tweet_id TEXT PRIMARY KEY,
    rejected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reason TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS daily_post_counts (
    date TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0
  );

  -- (E) Hesap basina reply sayaci — son X gunde bir hesaba kac kez reply atildigi (asiri hedefleme
  -- = spam/reply-guy sinyali). Pencere author_cap_window_days ayarinda bir sifirlanir.
  CREATE TABLE IF NOT EXISTS author_reply_counts (
    author TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    last_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tweets_status ON tweets(status);
  CREATE INDEX IF NOT EXISTS idx_tweets_scheduled ON tweets(scheduled_at);
`);

// Migration: image_prompt kolonu (DEPRECATED — eski fal.ai akışından; Giggle entegrasyonuyla
// kullanılmıyor ama şema uyumu için kalır).
try {
  db.exec('ALTER TABLE tweets ADD COLUMN image_prompt TEXT');
} catch {
  /* kolon zaten var — sorun değil */
}

// Migration: tweet_media kolonu — orijinal tweetin medya URL'leri (JSON dizi). Giggle isteğinde
// `media` alanı olarak gönderilir; onay kuyruğunda önizleme için de kullanılır.
try {
  db.exec('ALTER TABLE tweets ADD COLUMN tweet_media TEXT');
} catch {
  /* kolon zaten var — sorun değil */
}

// Migration: views kolonu — tweetin görüntülenme sayısı (kalite filtresi için, §4.1/§4.2).
try {
  db.exec('ALTER TABLE tweets ADD COLUMN views INTEGER DEFAULT 0');
} catch {
  /* kolon zaten var — sorun değil */
}

// Migration (B): daily_post_counts.effective_limit — o gün için rastgele belirlenen etkin limit
// (daily_post_limit'ten 0..daily_limit_jitter düşülür; sabit günlük hacim parmak izini kırar).
try {
  db.exec('ALTER TABLE daily_post_counts ADD COLUMN effective_limit INTEGER');
} catch {
  /* kolon zaten var */
}
// Migration (B): daily_post_counts.warn_shown — "dün X post attın" uyarısının o gün kaç kez
// gösterildiği (günlük üst sınır: yesterday_warn_max_per_day).
try {
  db.exec('ALTER TABLE daily_post_counts ADD COLUMN warn_shown INTEGER DEFAULT 0');
} catch {
  /* kolon zaten var */
}

// --- Varsayılan ayar seed'i (yoksa) ---------------------------------------
const DEFAULT_SETTINGS = {
  daily_post_limit: '30', // günlük post tavanı (üst sınır)
  daily_limit_jitter: '6', // (B) her gün tavandan 0..bu kadar rastgele DÜŞÜLÜR (30, jitter 6 → 24-30) — sabit hacim parmak izini kırar
  yesterday_warn_max_per_day: '2', // (B) "dün X post attın, bugün farklı olsun" uyarısı günde en fazla bu kadar gösterilir
  min_post_interval_minutes: '15', // A = iki post arası TABAN dakika
  post_interval_jitter_minutes: '9', // üstüne 0..bu kadar rastgele TAM dakika (tek basamak → A + 0-9 dk)
  scrape_target_per_keyword: '200',
  scraped_ttl_hours: '48', // bu süreden eski, işlenmemiş 'scraped' tweetler temizlenir
  approval_queue_max: '100', // onay kuyruğunda (pending_approval) aynı anda en fazla bu kadar kayıt
  approval_ttl_hours: '12', // bu süreden fazla onaylanmadan bekleyen kayıtlar SİLİNİR (rejected'a girmez)
  // engagement skor ağırlıkları (spec §4.2)
  score_w_likes: '1',
  score_w_retweets: '2',
  score_w_replies: '1.5',
  score_w_quotes: '1.5',
  // --- Kalite filtresi (§4.1 Katman 1 = X operatörü, §4.2 Katman 2 = kod) ---
  filter_min_faves: '500', // X min_faves: (scrape anında sunucu tarafı) — düşük etkileşim çöpünü keser
  filter_within_days: '3', // X since: (son N gün)
  filter_exclude_replies: '1', // 1=yanıt tweetlerini hariç tut (kod, t.isReply), 0=tutma
  filter_min_views: '50000', // kod: minimum görüntülenme / erişim tabanı (0=kapalı)
  filter_max_replies: '2000', // kod: yorum üst tavanı (gömülme koruması, 0=kapalı)
  filter_max_reply_view_ratio: '0.0015', // kod: yorum/görüntülenme oranı tavanı — asıl "gömülme" filtresi (0=kapalı)
  filter_max_age_hours: '72', // kod: en fazla bu kadar eski (0=kapalı)
  // --- "Hemen Paylaş" (direct-post) aralığı — art arda tıklamada burst/ban önlemi ---
  direct_post_min_gap_seconds: '120', // iki direct-post arası MİN saniye (post-to-post taban)
  direct_post_gap_jitter_seconds: '60', // üstüne 0..bu kadar rastgele jitter → 120-180sn (2-3 dk)
  // Direct-post GEÇİCİ throttle (boş tweet_results, dakikalar içinde temizlenir) için beklet-tekrar-dene:
  direct_post_throttle_retries: '3', // throttle'da kaç kez beklenip tekrar denensin (bitince zamanlamaya düşer)
  direct_post_throttle_wait_seconds: '90', // her throttle denemesi arası bekleme (sn)
  // --- Ban riski: reply metnindeki Giggle app-store link bloğunu POST anında kaldır ---
  strip_promo_links: '1', // 1=postlarken "Download Giggle / App Store / Google Play" linklerini temizle, 0=aynen postla
  // --- (A) Aktif-saat penceresi: gece post atmak klasik bot sinyali → yalnız uyanık saatlerde postla ---
  active_hours_enabled: '1',
  active_hours_start: '8', // yerel saat, DAHİL — bu saatten önce post yok
  active_hours_end: '23', // yerel saat, HARİÇ — bu saatten sonra post yok
  active_hours_tz_offset: '3', // yerel saatin UTC'den farkı (saat); VPS UTC çalışır, Türkiye=+3
  // --- (E) Hesap başına reply sıklığı sınırı (aşırı hedefleme = spam/reply-guy sinyali) ---
  author_cap_window_days: '7', // kayıt defteri penceresi: bu kadar günde bir sıfırlanır (haftalık)
  author_cap_max_replies: '2', // pencere içinde bir hesaba en fazla bu kadar reply; aşınca yeni tweetleri scrape'te elenir (0=kapalı)
  author_cap_window_start: '', // (runtime) pencerenin başladığı ISO zaman; boş=ilk kullanımda set edilir
};
{
  const seed = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) seed.run(k, v);
}

// ==========================================================================
// Settings
// ==========================================================================
const _getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const _setSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSetting(key, fallback = null) {
  const row = _getSetting.get(key);
  return row ? row.value : fallback;
}
export function getSettingNumber(key, fallback = 0) {
  const v = getSetting(key);
  return v == null ? fallback : Number(v);
}
export function setSetting(key, value) {
  _setSetting.run(key, String(value));
}
export function getAllSettings() {
  return db.prepare('SELECT key, value FROM settings').all();
}

// ==========================================================================
// Tweets — dedup-farkında ekleme (spec §4.1)
// ==========================================================================
const _existsRejected = db.prepare('SELECT 1 FROM rejected_tweets WHERE tweet_id = ?');
const _getTweetStatus = db.prepare('SELECT status FROM tweets WHERE id = ?');
const _insertScraped = db.prepare(`
  INSERT OR IGNORE INTO tweets
    (id, author, text, likes, retweets, replies, quotes, views, url, keyword, tweet_media, status)
  VALUES (@id, @author, @text, @likes, @retweets, @replies, @quotes, @views, @url, @keyword, @tweet_media, 'scraped')
`);

/**
 * Ham tweeti dedup kurallarıyla ekler.
 * @returns {'inserted'|'skipped_rejected'|'skipped_processed'|'skipped_pending'|'skipped_author_cap'}
 */
export function insertScrapedTweet(t) {
  if (_existsRejected.get(t.id)) return 'skipped_rejected';
  const existing = _getTweetStatus.get(t.id);
  if (existing) {
    if (existing.status === 'scraped' || existing.status === 'pending_approval') {
      return 'skipped_pending';
    }
    return 'skipped_processed'; // approved/scheduled/ready_to_post/posted vb.
  }
  // (E) Hesap bu pencerede zaten yeterince reply aldıysa, yeni popüler tweetini alma (aşırı hedefleme önlemi).
  if (isAuthorCapped(t.author)) return 'skipped_author_cap';
  _insertScraped.run({
    id: t.id,
    author: t.author ?? null,
    text: t.text ?? null,
    likes: t.likes ?? 0,
    retweets: t.retweets ?? 0,
    replies: t.replies ?? 0,
    quotes: t.quotes ?? 0,
    views: t.views ?? 0,
    url: t.url ?? null,
    keyword: t.keyword ?? null,
    tweet_media: JSON.stringify(Array.isArray(t.media) ? t.media : []),
  });
  return 'inserted';
}

export function getByStatus(status) {
  return db.prepare('SELECT * FROM tweets WHERE status = ? ORDER BY created_at ASC').all(status);
}
export function getScheduledView() {
  // Schedule/takvim görünümü (spec §5.3) — en yeniden en eskiye (kullanıcı kararı, 2026-09-11)
  return db
    .prepare(
      `SELECT * FROM tweets
       WHERE status IN ('generating','scheduled','ready_to_post','posted','failed','blocked_daily_limit','cancelled')
       ORDER BY scheduled_at DESC`
    )
    .all();
}
export function getTweet(id) {
  return db.prepare('SELECT * FROM tweets WHERE id = ?').get(id);
}

const _touch = 'updated_at = CURRENT_TIMESTAMP';

export function updateStatus(id, status, extra = {}) {
  const sets = [`status = @status`, _touch];
  const params = { id, status };
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  db.prepare(`UPDATE tweets SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function setScore(id, score) {
  db.prepare(`UPDATE tweets SET score = ?, ${_touch} WHERE id = ?`).run(score, id);
}

// Giggle çıktısı: üretilen reply metnini saklar. Statüyü DEĞİŞTİRMEZ — akış (generating→approved)
// çağıran tarafça yönetilir (üretim onaydan sonra Giggle ile yapılır).
export function setGeneratedText(id, { replyText, imagePrompt }) {
  db.prepare(
    `UPDATE tweets SET generated_reply_text = ?, image_prompt = ?, ${_touch} WHERE id = ?`
  ).run(replyText, imagePrompt ?? null, id);
}

// Onaydan sonra üretilen görseli kaydeder (statüyü değiştirmez — kayıt zaten
// approved/scheduled durumundadır).
export function setImage(id, { imageUrl, imagePath }) {
  db.prepare(
    `UPDATE tweets SET generated_image_url = ?, generated_image_path = ?, ${_touch} WHERE id = ?`
  ).run(imageUrl ?? null, imagePath ?? null, id);
}

export function setReplyText(id, replyText) {
  db.prepare(`UPDATE tweets SET generated_reply_text = ?, ${_touch} WHERE id = ?`).run(replyText, id);
}

export function setScheduled(id, scheduledAtISO) {
  db.prepare(
    `UPDATE tweets SET scheduled_at = ?, status = 'scheduled', ${_touch} WHERE id = ?`
  ).run(scheduledAtISO, id);
}

// scheduling-agent döngüsü: zamanı gelenleri ready_to_post yap
export function promoteDueScheduled(nowISO) {
  return db
    .prepare(
      `UPDATE tweets SET status = 'ready_to_post', ${_touch}
       WHERE status = 'scheduled' AND scheduled_at <= ?`
    )
    .run(nowISO).changes;
}

// Statü sayacı (dashboard özet / limit hesapları)
export function countByStatusToday(status) {
  return db.prepare('SELECT COUNT(*) AS n FROM tweets WHERE status = ?').get(status).n;
}
export function countScheduledForDate(dateStr) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM tweets WHERE status='scheduled' AND date(scheduled_at)=?`)
    .get(dateStr).n;
}

/**
 * Tazelik temizliği: TTL'den eski, işlenmemiş 'scraped' tweetleri siler (bayat havuz).
 * SADECE status='scraped' hedeflenir — posted/scheduled/rejected vb. dedup hafızası korunur.
 * @param {number} [ttlHours] varsayılan settings'ten
 * @returns {number} silinen kayıt sayısı
 */
export function purgeStaleScraped(ttlHours) {
  const hours = ttlHours ?? getSettingNumber('scraped_ttl_hours', 48);
  return db
    .prepare(
      `DELETE FROM tweets WHERE status = 'scraped' AND created_at < datetime('now', ?)`
    )
    .run(`-${hours} hours`).changes;
}

/**
 * Onay kuyruğu tazeliği: TTL'den fazla onaylanmadan bekleyen 'pending_approval' kayıtları SİLER.
 * Kullanıcı kararı: bunlar reddedilmiş sayılmaz — `rejected_tweets`'e YAZILMAZ, sadece silinir
 * (ileride yeniden scrape edilebilir). Süre `updated_at`'e göre ölçülür (pending_approval'a geçiş
 * anı; qa updateStatus ile updated_at'i tazeler). Orchestrator cleanup döngüsünde çağrılır.
 * @param {number} [ttlHours] varsayılan settings'ten
 * @returns {number} silinen kayıt sayısı
 */
export function purgeStalePendingApproval(ttlHours) {
  const hours = ttlHours ?? getSettingNumber('approval_ttl_hours', 12);
  if (hours <= 0) return 0; // 0 = kapalı (sonsuza kadar bekletme)
  return db
    .prepare(
      `DELETE FROM tweets WHERE status = 'pending_approval' AND updated_at < datetime('now', ?)`
    )
    .run(`-${hours} hours`).changes;
}

// ==========================================================================
// Rejected (dedup hafızası)
// ==========================================================================
export function markRejected(tweetId, reason = 'user_rejected') {
  db.prepare('INSERT OR IGNORE INTO rejected_tweets (tweet_id, reason) VALUES (?, ?)').run(
    tweetId,
    reason
  );
  updateStatus(tweetId, 'rejected');
}

// ==========================================================================
// Günlük post sayacı (spec §7)
// ==========================================================================
function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
function yesterday() {
  return new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
}
export function getTodayPostCount() {
  const row = db.prepare('SELECT count FROM daily_post_counts WHERE date = ?').get(today());
  return row ? row.count : 0;
}
export function getYesterdayPostCount() {
  const row = db.prepare('SELECT count FROM daily_post_counts WHERE date = ?').get(yesterday());
  return row ? row.count : 0;
}
export function incTodayPostCount() {
  db.prepare(
    `INSERT INTO daily_post_counts (date, count) VALUES (?, 1)
     ON CONFLICT(date) DO UPDATE SET count = count + 1`
  ).run(today());
}

/**
 * (B) O günün etkin post limiti. `daily_post_limit` (tavan) − rastgele 0..`daily_limit_jitter`.
 * Gün içinde SABİT kalması için ilk hesaplandığında daily_post_counts.effective_limit'e yazılır.
 * @returns {number}
 */
export function getEffectiveDailyLimit() {
  const base = getSettingNumber('daily_post_limit', 30);
  const jitter = getSettingNumber('daily_limit_jitter', 0);
  const d = today();
  let row = db.prepare('SELECT effective_limit FROM daily_post_counts WHERE date = ?').get(d);
  if (!row) {
    db.prepare('INSERT INTO daily_post_counts (date, count) VALUES (?, 0)').run(d);
    row = { effective_limit: null };
  }
  if (row.effective_limit == null) {
    const eff = jitter > 0 ? Math.max(1, base - Math.floor(Math.random() * (jitter + 1))) : base;
    db.prepare('UPDATE daily_post_counts SET effective_limit = ? WHERE date = ?').run(eff, d);
    return eff;
  }
  return row.effective_limit;
}
export function remainingDailyQuota() {
  return Math.max(0, getEffectiveDailyLimit() - getTodayPostCount());
}

// (B) "dün X post attın, bugün farklı olsun" uyarısının günlük gösterim sayacı.
export function getWarnShownToday() {
  const row = db.prepare('SELECT warn_shown FROM daily_post_counts WHERE date = ?').get(today());
  return row?.warn_shown ?? 0;
}
export function canShowYesterdayWarning() {
  const max = getSettingNumber('yesterday_warn_max_per_day', 2);
  if (max <= 0) return false;
  return getWarnShownToday() < max;
}
export function incWarnShownToday() {
  db.prepare(
    `INSERT INTO daily_post_counts (date, count, warn_shown) VALUES (?, 0, 1)
     ON CONFLICT(date) DO UPDATE SET warn_shown = warn_shown + 1`
  ).run(today());
}

// ==========================================================================
// (E) Hesap başına reply sıklığı — kayıt defteri + pencere sıfırlama + cap.
// ==========================================================================
/** Pencere (author_cap_window_days) dolduysa sayaçları sıfırlar ve pencereyi baştan başlatır. */
function maybeResetAuthorWindow() {
  const days = getSettingNumber('author_cap_window_days', 7);
  if (days <= 0) return;
  const now = Date.now();
  const start = getSetting('author_cap_window_start');
  if (!start) {
    setSetting('author_cap_window_start', new Date(now).toISOString());
    return;
  }
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs) || now - startMs >= days * 86400_000) {
    db.prepare('DELETE FROM author_reply_counts').run();
    setSetting('author_cap_window_start', new Date(now).toISOString());
  }
}
/** Başarılı reply sonrası çağrılır — hesabın pencere içi sayacını artırır. */
export function incAuthorReply(author) {
  if (!author) return;
  maybeResetAuthorWindow();
  db.prepare(
    `INSERT INTO author_reply_counts (author, count, last_at) VALUES (?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(author) DO UPDATE SET count = count + 1, last_at = CURRENT_TIMESTAMP`
  ).run(author);
}
export function getAuthorReplyCount(author) {
  if (!author) return 0;
  maybeResetAuthorWindow();
  const row = db.prepare('SELECT count FROM author_reply_counts WHERE author = ?').get(author);
  return row ? row.count : 0;
}
export function isAuthorCapped(author) {
  const max = getSettingNumber('author_cap_max_replies', 0);
  if (max <= 0) return false;
  return getAuthorReplyCount(author) >= max;
}
export function getAuthorReplyBook() {
  maybeResetAuthorWindow();
  return db
    .prepare('SELECT author, count, last_at FROM author_reply_counts ORDER BY count DESC, last_at DESC')
    .all();
}
export function getAuthorWindowInfo() {
  maybeResetAuthorWindow();
  return {
    windowDays: getSettingNumber('author_cap_window_days', 7),
    maxReplies: getSettingNumber('author_cap_max_replies', 2),
    windowStart: getSetting('author_cap_window_start') || null,
  };
}

/** (B) Bugünkü planlı (scheduled+ready_to_post) kayıt sayısı — belirtilen tarih için. */
export function countPlannedForDate(dateStr) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM tweets WHERE status IN ('scheduled','ready_to_post') AND date(scheduled_at)=?`
    )
    .get(dateStr).n;
}

/**
 * Restart kurtarma: yarıda kalmış 'generating' kayıtları 'pending_approval'a döndürür.
 * 'generating' yalnız bellek-içi süreçlerde (Giggle üretimi / direct-post kuyruğu) geçici bir
 * durumdur; orchestrator yeniden başladığında o süreçler kaybolur → kayıt onay kuyruğuna döner.
 * Orchestrator başlangıcında bir kez çağrılır (src/index.js).
 * @returns {number} kurtarılan kayıt sayısı
 */
export function resetGeneratingToPending() {
  return db
    .prepare(`UPDATE tweets SET status = 'pending_approval', ${_touch} WHERE status = 'generating'`)
    .run().changes;
}

export { db };

