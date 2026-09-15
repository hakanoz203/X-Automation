# HANDOFF — X (Twitter) Otomatik Reply Sistemi

> README değil. Amaç: başka bir oturumun minimum bağlam kaybıyla geliştirmeye devam etmesi.
> Tam tarif `CLAUDE.md`; burası devam için gereken öz.

## Sistem
Keyword içeren popüler X tweetlerini çeker → dashboard'da onaya sunar (kuyrukta yalnız hedef
tweet) → onaylanan için Giggle ile reply metni + çizgi-roman görseli tek çağrıda üretilir →
aktif-saat penceresine rastgele dağıtılır → zamanı gelince medyalı reply olarak postlanır.
**Onaysız post yok.** Hetzner VPS'te systemd ile canlı; gerçek postlama uçtan uca doğrulandı.

## Mimari
- **Tek orchestrator** `src/index.js`: dashboard + 4 döngü aynı process (`safeLoop`):
  scheduling 1 dk `promoteDue`, post 1 dk `runPostCycle`, qa 2 dk `runQaCycle`, cleanup 6 saat
  `purgeStaleScraped` + `purgeStalePendingApproval`. Başlangıçta `resetGeneratingToPending`.
- **State machine, tek gerçek kaynak `tweets.status`:**
  `scraped → pending_approval → generating → approved → scheduled → ready_to_post → posted`
  (+ `failed | blocked_daily_limit | cancelled`; ret `rejected_tweets` tablosu). RPC yok.
- **X = kendi GraphQL client'ı** `src/lib/x-graphql.js` (cookie auth, queryId'ler canlı bundle'dan
  dinamik + fallback, SearchTimeline POST, chunked media upload → CreateTweet). Tüm X istekleri
  `xfetch` → `xactions-client.js` `withRetry` üzerinden. Proxy `X_PROXY_URL` set ise yalnız X
  trafiği (undici `ProxyAgent`; `fetch`/`FormData`/`ProxyAgent` hepsi `undici`'den). Şu an proxy
  kapalı, `.env`'de satır yorumda.
- **Giggle** `src/lib/giggle-client.js`: `generateComicReply({id,text,author,media})` →
  `{replyText, imagePath, imageUrl}`; görsel `data/images/`'e indirilir (imzalı URL ~1 saat).
  Auth `x-api-key`. Yalnız görsel kabul eder → video/GIF için poster karesi gönderilir.
  504 IDLE_TIMEOUT/502/503 geçici → 3 deneme. `stripPromoLinks(text)` post anında app-store link
  bloğunu kaldırır (`strip_promo_links`).
- **Dashboard** `src/dashboard/server.js` (Express REST) + `public/` vanilla, build yok. 5 sekme:
  Keyword & Scrape, Onay Kuyruğu, Schedule, Hesaplar, Ayarlar.
- **DB** `node:sqlite` (DatabaseSync), WAL + `synchronous=NORMAL` + `busy_timeout=5000`,
  `data/app.db`. Tüm SQL `src/lib/db.js`. Migration'lar idempotent. Node ≥ 22.5 (kurulu 24).

## Dosyalar
- `src/lib/db.js` — şema, `DEFAULT_SETTINGS`, tüm repository fonksiyonları, dedup
  (`insertScrapedTweet`), TTL purge, günlük limit (`getEffectiveDailyLimit`, `remainingDailyQuota`),
  hesap defteri (`incAuthorReply`, `isAuthorCapped`, `maybeResetAuthorWindow`). İlk okunacak yer.
- `src/agents/scraping-agent.js` — `buildSearchQuery` (Katman 1: `min_faves:`, `since:`),
  `passesQualityFilter` (Katman 2: min_views, max_replies, max_reply_view_ratio, exclude_replies,
  max_age_hours), `scrapeKeywords`.
- `src/agents/qa-agent.js` — skor (`score_w_*`), `min(kalan kota, approval_queue_max − pending)`
  aday → `pending_approval`. Üretim yok.
- `src/agents/scheduling-agent.js` — `scheduleApproved`, `nextSlot` (taban dk + rastgele tam dk,
  saniye/salise bağımsız random), `clampToActiveHours`, `promoteDue`.
- `src/agents/post-agent.js` — `runPostCycle`: limit → metin boşsa failed → stripPromoLinks →
  `postReply` → `posted` + `incAuthorReply`; hata `failed`, otomatik retry yok.
- `src/dashboard/server.js` — tüm endpoint'ler, `generateComicForApproved`, direct-post kuyruğu
  (`enqueueDirectPost`/`drainDirectQueue`/`processDirectPost`), `retryOne`, `pushNotification`,
  `maybeWarnYesterdayMatch`/`maybeWarnScheduleMatch`.
- `src/dashboard/public/app.js` — `SETTING_META` (Ayarlar etiket/açıklamaları), sekmeler, toast,
  bildirim polling. `style.css` — `[hidden]{display:none!important}` zorunlu.
- `scripts/auth-test.js` (`npm run auth-test`), `scripts/retry-post.js`.
- `docs/xactions-notes.md` — X client ayrıntıları.

## Akışlar
- **Scrape:** "Scrape Et" → `/api/scrape` → `scrapeKeywords` → filtre + dedup + hesap-cap eleme →
  `scraped` → arka planda `runQaCycle`.
- **Onay:** `/api/approve` → `generating` → Giggle → `approved` + `scheduleApproved()` →
  `scheduled`; hata `failed`.
- **Hemen Paylaş:** `/api/post-now` → `generating` → seri kuyruk → Giggle → `postReply` →
  `posted`. Direct-post'lar arası `direct_post_min_gap_seconds` + jitter. Post hatası:
  throttle (`err.throttled`) → `direct_post_throttle_retries` × `direct_post_throttle_wait_seconds`
  tekrar, tükenirse `approved` + zamanla (`error_message` temizlenir); sert (`err.noRetry`:
  226/344/auth) → `failed`; Giggle hatası → `failed`. Her dalda toast bildirimi
  (`/api/notifications`, bellek-içi, son 50).
- **Reddet:** `/api/reject` → `rejected_tweets`.
- **Schedule:** `scheduled_at DESC` liste, 24h ray, `/api/cancel`, `/api/retry`, `/api/retry-all`.
  `retryOne`: metin varsa yeniden planla, yoksa Giggle'ı baştan çağır.
- **Post:** her dk `ready_to_post` → reply → `posted`.
- **Cleanup:** `scraped_ttl_hours` (48) eski scraped'ler ve `approval_ttl_hours` (12) bekleyen
  pending'ler silinir; pending silinirken `rejected_tweets`'e yazılmaz.

## Ban-riski önlemleri (hepsi `settings`, Ayarlar sekmesinden)
- Günlük etkin limit = `daily_post_limit` − rastgele `0..daily_limit_jitter`, gün içinde sabit
  (`daily_post_counts.effective_limit`).
- Slot = taban dk + rastgele tam dk; saniye/salise her kayıtta bağımsız random.
- Aktif-saat penceresi `active_hours_*` (VPS UTC, tz offset 3).
- Hesap başına reply sınırı `author_cap_max_replies` / `author_cap_window_days`
  (`author_reply_counts`, "Hesaplar" sekmesi).
- "Dünkü sayıya ulaştın" uyarısı, günde en fazla `yesterday_warn_max_per_day`.
- `strip_promo_links` post anında link bloğunu temizler.
- Hemen Paylaş seri kuyruk + taban bekleme.
- Circuit breaker / adaptif geri-çekilme yok; tek hata sinyali sistemi durdurmaz.

## X hata kodları (bizim limitten ayrı)
344 = hesabın X günlük gönderim kotası; 226 = "might be automated"; boş `tweet_results` = geçici
throttle (dakikalar sonra geçer). `withRetry` bunlarda hızlı retry yapmaz. Hepsi `failed`; tekrar
elle. 226/344 sürekli geliyorsa sorun hesap itibarıdır, art arda deneme flag'i besler.

## Ortam
- `.env`: `XACTIONS_AUTH_TOKEN`, `XACTIONS_CT0`, `GIGGLE_API_URL`, `GIGGLE_API_KEY`,
  `GIGGLE_AUTH_SCHEME=x-api-key`, opsiyonel `X_PROXY_URL`, `PORT`, `HOST`, `GIGGLE_MAX_RETRIES`.
  Tümden yeniden yazılmaz, yalnız ilgili satır değişir. Repoya girmez.
- Bağımlılıklar: express, dotenv, undici. `npm install` native derleme yapmaz.
- systemd `x-automation.service` (içerik `CLAUDE.md` §10). Backend değişince
  `sudo systemctl restart x-automation` (passwordless sudo yok); frontend için tarayıcı yenile.
- Dashboard `0.0.0.0:3000`, auth yok, port dışarı kapalı; erişim SSH port-forward.
- Cookie yenileme: x.com tam çıkış-giriş → `auth_token`+`ct0` → `.env` → restart → `npm run auth-test`.
- Aynı DB'ye ikinci orchestrator çalıştırılmaz (çift post riski).

## Kurallar
- Onaysız post yok; gerçek reply postlayan test öncesi içerik gösterilip açık onay alınır.
- Ayarlanabilir değerler `settings`'ten okunur.
- Her yeni X isteği `xfetch`'ten geçer.
- Mimari değişiklikte `CLAUDE.md` + bu dosya aynı commit'te güncellenir; dosyalar geçmişi değil
  mevcut durumu anlatır.

## Yok (kapsam dışı)
İçerik-benzerliği dedup, otomatik scrape cron, dashboard auth, sessiz-hata watchdog / dış bildirim.
