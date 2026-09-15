/**
 * Dashboard REST API + statik frontend (spec §5).
 * DB'yi doğrudan okuyup yazan "view + control layer". Ajanlarla aynı DB'yi paylaşır.
 */
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getByStatus,
  getScheduledView,
  getTweet,
  updateStatus,
  markRejected,
  getAllSettings,
  setSetting,
  getSettingNumber,
  getTodayPostCount,
  incTodayPostCount,
  remainingDailyQuota,
  getEffectiveDailyLimit,
  getYesterdayPostCount,
  canShowYesterdayWarning,
  incWarnShownToday,
  countPlannedForDate,
  incAuthorReply,
  getAuthorReplyBook,
  getAuthorWindowInfo,
} from '../lib/db.js';
import { scrapeKeywords } from '../agents/scraping-agent.js';
import { runQaCycle, generateComicForApproved } from '../agents/qa-agent.js';
import { scheduleApproved } from '../agents/scheduling-agent.js';
import { checkAuth, proxyStatus, postReply } from '../lib/xactions-client.js';
import { stripPromoLinks } from '../lib/giggle-client.js';
import { log } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Arka planda Giggle ile çizgi-roman üretir; başarıda 'approved' yapıp planlar, hatada 'failed'.
 * Kayıt bu çağrıdan önce 'generating' statüsüne alınmış olmalı. Yanıtı bloklamaz.
 * @param {string} id
 */
function runComicGeneration(id) {
  generateComicForApproved(id)
    .then(() => {
      updateStatus(id, 'approved', { error_message: null });
      const sched = scheduleApproved();
      maybeWarnScheduleMatch(); // (B) bugünkü planlı+atılan toplam dünküne ulaştıysa uyar
      log('dashboard', `${id} Giggle üretimi tamam → planlandı (${sched.scheduled})`);
    })
    .catch((e) => {
      updateStatus(id, 'failed', { error_message: String(e.message).slice(0, 500) });
      log('dashboard', `${id} Giggle üretim hatası → failed: ${e.message}`, 'error');
    });
}

// --- "Hemen Paylaş" (direct-post) SERİ KUYRUĞU (art arda tıklamada burst/ban önlemi) ---
// Art arda tıklanan direct-post'lar aynı anda postlanmaz: tek bir worker sırayla işler ve iki
// post arasında EN AZ `direct_post_min_gap_seconds` (+ jitter) taban bekleme uygular. Bekleme
// post-to-post ölçülür ve Giggle üretim süresiyle (~105sn) örtüşür (ekstra gecikme minimum).
// Yalnız direct-post'lar arası (zamanlanmış postlar zaten scheduling-agent'te aralıklı).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _directQueue = [];
let _directWorking = false;
let _lastDirectPostAt = 0;

// --- Sunucu → dashboard bildirimleri (arka plan olayları için, ör. direct-post fallback) ---
// Bellek-içi halka tampon; frontend `/api/notifications?since=<ts>` ile yeni olanları çeker.
const _notifications = [];
let _notifId = 0;
function pushNotification(message, level = 'info') {
  _notifications.push({ id: ++_notifId, at: Date.now(), message, level });
  if (_notifications.length > 50) _notifications.shift();
  log('dashboard', `bildirim: ${message}`);
}

// (B) "Dün X post attın, bugün farklı olsun" uyarıları — günde en fazla yesterday_warn_max_per_day.
const todayStr = () => new Date().toISOString().slice(0, 10);

/** Direct-post sonrası: bugünkü postlanan sayı dünküne ULAŞTIYSA uyar (ör. "24. tweet postlanırken"). */
function maybeWarnYesterdayMatch(author) {
  const y = getYesterdayPostCount();
  if (y <= 0) return;
  if (getTodayPostCount() < y) return; // henüz dünküne ulaşmadı
  if (!canShowYesterdayWarning()) return;
  incWarnShownToday();
  pushNotification(
    `Dün ${y} tweet postladınız — bugün de ${y}'e ulaştınız${author ? ` (@${author})` : ''}. Ban riski için bugün sayıyı farklı tutun.`,
    'warn'
  );
}

/** Schedule sonrası: bugünkü (planlı + postlanan) toplam dünküne ULAŞTIYSA uyar. */
function maybeWarnScheduleMatch() {
  const y = getYesterdayPostCount();
  if (y <= 0) return;
  const total = countPlannedForDate(todayStr()) + getTodayPostCount();
  if (total < y) return;
  if (!canShowYesterdayWarning()) return;
  incWarnShownToday();
  pushNotification(
    `Dün ${y} post attınız; bugün planlı+atılan toplam da ${y}'e ulaştı. Bugün farklı sayıda atmayı unutmayın (ban riski).`,
    'warn'
  );
}

/**
 * Bir failed/blocked kaydı yeniden dener. Metin varsa (post aşamasında düşmüş) yalnız yeniden
 * planlar; metin yoksa (Giggle aşamasında düşmüş) çizgi-romanı baştan üretir. /api/retry ve
 * /api/retry-all ortak kullanır.
 * @returns {{scheduled?:number, generating?:boolean}}
 */
function retryOne(t) {
  if (t.generated_reply_text) {
    updateStatus(t.id, 'approved', { error_message: null, scheduled_at: null });
    const sched = scheduleApproved();
    return { scheduled: sched.scheduled };
  }
  updateStatus(t.id, 'generating', { error_message: null, scheduled_at: null });
  runComicGeneration(t.id); // arka plan
  return { generating: true };
}

function enqueueDirectPost(id) {
  _directQueue.push(id);
  drainDirectQueue();
}

async function drainDirectQueue() {
  if (_directWorking) return;
  _directWorking = true;
  try {
    while (_directQueue.length) {
      await processDirectPost(_directQueue.shift());
    }
  } finally {
    _directWorking = false;
  }
}

/** Tek bir direct-post: Giggle üret → (gerekirse taban aralığı bekle) → hemen postla. */
async function processDirectPost(id) {
  // 1) Üretim aşaması — burada hata olursa metin/görsel yok, gerçek 'failed' (zamanlanacak bir şey yok).
  try {
    await generateComicForApproved(id); // ~105sn
  } catch (e) {
    updateStatus(id, 'failed', { error_message: String(e.message).slice(0, 500) });
    log('dashboard', `${id} hemen-paylaş üretim hatası → failed: ${e.message}`, 'error');
    return;
  }

  if (remainingDailyQuota() <= 0) {
    updateStatus(id, 'blocked_daily_limit');
    log('dashboard', `${id} hemen-paylaş: günlük limit doldu → blocked_daily_limit`, 'warn');
    return;
  }
  const t = getTweet(id);
  if (!t?.generated_reply_text) {
    updateStatus(id, 'failed', { error_message: 'reply metni yok (üretim tamamlanmadı)' });
    return;
  }

  // Post-to-post taban aralığı: son direct-post'tan bu yana yeterli süre geçmediyse bekle.
  const gapMs =
    (getSettingNumber('direct_post_min_gap_seconds', 120) +
      Math.random() * getSettingNumber('direct_post_gap_jitter_seconds', 60)) *
    1000;
  const waitMs = _lastDirectPostAt + gapMs - Date.now();
  if (waitMs > 0) {
    log('dashboard', `${id} hemen-paylaş: ban önlemi, ${Math.round(waitMs / 1000)}sn bekleniyor`);
    await sleep(waitMs);
  }

  // 2) Postlama aşaması — metin+görsel HAZIR.
  const imagePath =
    t.generated_image_path && existsSync(t.generated_image_path) ? t.generated_image_path : null;
  const finalText = getSettingNumber('strip_promo_links', 1)
    ? stripPromoLinks(t.generated_reply_text)
    : t.generated_reply_text;

  // GEÇİCİ throttle (boş tweet_results — X spam/tekrar koruması) DAKİKALAR İÇİNDE temizlenir:
  // gözlemlendi ki aynı içerik ~3 dk sonra sorunsuz geçiyor. Bu yüzden hemen pes edip zamanlamak
  // yerine, birkaç kez BEKLEYİP TEKRAR DENE (elle "biraz sonra tekrar dene" davranışının otomatiği).
  // Worker arka planda çalıştığı için HTTP yanıtı bloklanmaz. Denemeler bitince zamanlamaya düşer.
  const throttleRetries = getSettingNumber('direct_post_throttle_retries', 3);
  const throttleWaitMs = getSettingNumber('direct_post_throttle_wait_seconds', 90) * 1000;
  let lastErr = null;
  for (let attempt = 0; attempt <= throttleRetries; attempt++) {
    try {
      const { replyId } = await postReply(t.id, finalText, imagePath);
      _lastDirectPostAt = Date.now();
      updateStatus(id, 'posted', {
        posted_reply_id: replyId,
        scheduled_at: new Date().toISOString(),
        error_message: null,
      });
      incTodayPostCount();
      incAuthorReply(t.author); // (E) hesap başına reply sayacı
      maybeWarnYesterdayMatch(t.author); // (B) bugünkü sayı dünküne ulaştıysa uyar
      log(
        'dashboard',
        `${id} hemen-paylaş → postlandı${replyId ? ` (reply ${replyId})` : ''}${attempt ? ` (${attempt}. tekrarda)` : ''}`
      );
      return;
    } catch (e) {
      lastErr = e;
      // Yalnız GEÇİCİ throttle'da beklet-tekrar-dene. Sert hata (226/344/auth) → anında çık.
      if (e.throttled && attempt < throttleRetries) {
        log(
          'dashboard',
          `${id} hemen-paylaş geçici throttle — ${throttleWaitMs / 1000}sn sonra tekrar (deneme ${attempt + 1}/${throttleRetries})`,
          'warn'
        );
        await sleep(throttleWaitMs);
        continue;
      }
      break; // sert hata VEYA throttle denemeleri tükendi
    }
  }

  // Buraya gelindiyse tüm denemeler başarısız oldu. Hata sınıfına göre karar:
  //  • GEÇİCİ throttle (denemeler tükendi) → daha sonraya ZAMANLA; gecikme throttle'ı temizler
  //    (bugün yine gider). Planlı sekmesinde temiz görünsün diye error temizlenir.
  //  • SERT hata (226 otomasyon, 344 X günlük kotası, auth) → bugün retry futile → 'failed'
  //    (Başarısız sekmesi), error_message korunur; kullanıcı sonra "Yeniden dene" ile tekrarlar.
  {
    const e = lastErr;
    const msg = String(e.message).slice(0, 500);
    if (e.throttled) {
      updateStatus(id, 'approved', { error_message: null, scheduled_at: null });
      const sched = scheduleApproved();
      const when = getTweet(id)?.scheduled_at;
      log('dashboard', `${id} hemen-paylaş geçici throttle → zamanlandı (${sched.scheduled})`, 'warn');
      pushNotification(
        `@${t.author} için hemen paylaşım birkaç kez denendi ama X geçici olarak düşürdü (spam/tekrar koruması) — içerik hazır, otomatik olarak zamanlanmış kuyruğa alındı${when ? ` (${new Date(when).toLocaleString('tr-TR', { hour: '2-digit', minute: '2-digit' })})` : ''}. Schedule sekmesinden görebilirsin.`,
        'warn'
      );
    } else {
      updateStatus(id, 'failed', { error_message: msg });
      log('dashboard', `${id} hemen-paylaş X reddetti (sert hata) → failed: ${e.message}`, 'error');
      pushNotification(
        `@${t.author} için hemen paylaşım başarısız oldu — X isteği reddetti (ör. hesabın günlük gönderim limiti / otomasyon flag'i). "Başarısız" sekmesinde; kota/limit düzelince "Yeniden dene" ile tekrarlayabilirsin.`,
        'warn'
      );
    }
  }
}

export function createApp() {
  const app = express();
  app.use(express.json());

  // Statik frontend + üretilen görseller (önizleme)
  app.use(express.static(resolve(__dirname, 'public')));
  app.use('/images', express.static(resolve(__dirname, '../../data/images')));

  const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      log('dashboard', `API hata: ${err.message}`, 'error');
      res.status(500).json({ error: err.message });
    });

  // --- Scrape tetikleme (+ arkasından qa üretimi) ---
  app.post(
    '/api/scrape',
    wrap(async (req, res) => {
      const raw = String(req.body?.keywords ?? '');
      const keywords = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (keywords.length === 0) return res.status(400).json({ error: 'keyword gerekli' });

      const summary = await scrapeKeywords(keywords);
      res.json({ summary });

      // Üretimi arka planda başlat (dashboard'ı bloklamadan)
      runQaCycle().catch((e) => log('dashboard', `qa cycle hata: ${e.message}`, 'error'));
    })
  );

  // --- Manuel qa tetikleme (opsiyonel) ---
  app.post(
    '/api/generate',
    wrap(async (_req, res) => {
      const result = await runQaCycle();
      res.json({ result });
    })
  );

  // --- Onay kuyruğu ---
  app.get('/api/queue', wrap((_req, res) => res.json(getByStatus('pending_approval'))));

  // --- Genel liste (status filtreli) ---
  app.get(
    '/api/tweets',
    wrap((req, res) => {
      const status = req.query.status;
      res.json(status ? getByStatus(String(status)) : getScheduledView());
    })
  );

  // --- Schedule/takvim görünümü ---
  app.get('/api/schedule', wrap((_req, res) => res.json(getScheduledView())));

  // --- Onayla → generating → (arka planda) Giggle üret → approved → planla ---
  // Onay kuyruğunda yalnız hedef tweet görünür; üretim (metin+çizgi-roman) onaydan SONRA
  // Giggle ile yapılır. Kayıt 'generating' olur, Giggle bitince otomatik planlanır.
  app.post(
    '/api/approve',
    wrap((req, res) => {
      const { id } = req.body ?? {};
      const t = getTweet(id);
      if (!t) return res.status(404).json({ error: 'tweet bulunamadı' });
      if (t.status !== 'pending_approval') {
        return res.status(400).json({ error: 'sadece onay bekleyen kayıt onaylanabilir' });
      }
      updateStatus(id, 'generating', { error_message: null });
      res.json({ ok: true, generating: true });
      runComicGeneration(id); // arka plan
    })
  );

  // --- Hemen Paylaş → generating → (arka planda) Giggle üret → ZAMANLAMADAN hemen postla ---
  app.post(
    '/api/post-now',
    wrap((req, res) => {
      const { id } = req.body ?? {};
      const t = getTweet(id);
      if (!t) return res.status(404).json({ error: 'tweet bulunamadı' });
      if (t.status !== 'pending_approval') {
        return res.status(400).json({ error: 'sadece onay bekleyen kayıt paylaşılabilir' });
      }
      updateStatus(id, 'generating', { error_message: null });
      res.json({ ok: true, posting: true, queued: _directQueue.length });
      enqueueDirectPost(id); // seri kuyruk: üret + aralıklı postla (burst önlemi)
    })
  );

  // --- Reddet → rejected_tweets (dedup) ---
  app.post(
    '/api/reject',
    wrap((req, res) => {
      const { id, reason } = req.body ?? {};
      if (!getTweet(id)) return res.status(404).json({ error: 'tweet bulunamadı' });
      markRejected(id, reason || 'user_rejected');
      res.json({ ok: true });
    })
  );

  // --- İptal (scheduled → cancelled) ---
  app.post(
    '/api/cancel',
    wrap((req, res) => {
      const { id } = req.body ?? {};
      const t = getTweet(id);
      if (!t) return res.status(404).json({ error: 'tweet bulunamadı' });
      if (t.status !== 'scheduled')
        return res.status(400).json({ error: 'sadece scheduled kayıt iptal edilebilir' });
      updateStatus(id, 'cancelled');
      res.json({ ok: true });
    })
  );

  // --- Manuel retry (failed | blocked_daily_limit → yeniden planla) ---
  // Otomatik retry YOK (spec §4.4); kullanıcı tetikler. Kayıt 'approved'a döndürülüp
  // scheduling-agent'e bırakılır — böylece min. interval ve günlük limit yeniden uygulanır.
  app.post(
    '/api/retry',
    wrap((req, res) => {
      const { id } = req.body ?? {};
      const t = getTweet(id);
      if (!t) return res.status(404).json({ error: 'tweet bulunamadı' });
      if (t.status !== 'failed' && t.status !== 'blocked_daily_limit') {
        return res
          .status(400)
          .json({ error: 'sadece failed / blocked_daily_limit kayıt yeniden denenebilir' });
      }
      const r = retryOne(t);
      res.json({ ok: true, ...r });
    })
  );

  // --- "Hepsini Yeniden Dene": tüm failed + blocked_daily_limit kayıtları toplu yeniden planla ---
  app.post(
    '/api/retry-all',
    wrap((_req, res) => {
      const items = [...getByStatus('failed'), ...getByStatus('blocked_daily_limit')];
      let scheduled = 0;
      let generating = 0;
      for (const t of items) {
        const r = retryOne(t);
        if (r.generating) generating++;
        else scheduled++;
      }
      if (scheduled + generating > 0) maybeWarnScheduleMatch();
      res.json({ ok: true, total: items.length, scheduled, generating });
    })
  );

  // --- (E) Hesap reply kayıt defteri (dashboard "Hesaplar" sekmesi) ---
  app.get(
    '/api/author-replies',
    wrap((_req, res) => {
      res.json({ ...getAuthorWindowInfo(), book: getAuthorReplyBook() });
    })
  );

  // --- Sunucu bildirimleri (arka plan olayları; frontend periyodik çeker) ---
  app.get(
    '/api/notifications',
    wrap((req, res) => {
      const since = Number(req.query.since) || 0;
      res.json(_notifications.filter((n) => n.id > since));
    })
  );

  // --- Ayarlar ---
  app.get('/api/settings', wrap((_req, res) => res.json(getAllSettings())));
  app.post(
    '/api/settings',
    wrap((req, res) => {
      const entries = req.body ?? {};
      for (const [k, v] of Object.entries(entries)) setSetting(k, v);
      res.json({ ok: true, settings: getAllSettings() });
    })
  );

  // --- Sağlık / özet ---
  app.get(
    '/api/health',
    wrap(async (_req, res) => {
      const auth = await checkAuth();
      res.json({
        auth,
        proxy: proxyStatus(),
        dailyPostLimit: getEffectiveDailyLimit(), // (B) bugünün rastgele etkin limiti
        dailyPostLimitBase: getSettingNumber('daily_post_limit', 30),
        postedToday: getTodayPostCount(),
        yesterdayPostCount: getYesterdayPostCount(), // (B) uyarı için
        plannedToday: countPlannedForDate(new Date().toISOString().slice(0, 10)),
        remainingQuota: remainingDailyQuota(),
        stripPromoLinks: getSettingNumber('strip_promo_links', 1) === 1,
        counts: {
          scraped: getByStatus('scraped').length,
          pending_approval: getByStatus('pending_approval').length,
          generating: getByStatus('generating').length,
          scheduled: getByStatus('scheduled').length,
          posted: getByStatus('posted').length,
          failed: getByStatus('failed').length,
        },
      });
    })
  );

  return app;
}

export function startServer(port = Number(process.env.PORT) || 3000) {
  const app = createApp();
  // 0.0.0.0 = tüm arayüzler (VPS'te public IP üzerinden erişim için şart).
  // HOST=127.0.0.1 ile sadece yerele kısıtlanabilir.
  const host = process.env.HOST || '0.0.0.0';
  return app.listen(port, host, () =>
    log('dashboard', `dinleniyor: http://${host}:${port}  (VPS dışından: http://<sunucu-ip>:${port})`)
  );
}

