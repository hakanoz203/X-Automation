# CLAUDE.md — X (Twitter) Otomatik Reply Sistemi

Bu dosya, bu repoda çalışan Claude Code için proje talimatıdır. Sistemin şu anki hali burada
tarif edildiği gibidir; kodda bir karar değişirse bu dosya da aynı commit'te güncellenir.

## 1. Sistemin Amacı

Dashboard'dan girilen **keyword'leri içeren popüler X tweetlerini** bulan, bunları **onaya sunan**,
onaylanan her tweet için **Giggle servisiyle cevap metnini ve çizgi-roman görselini tek çağrıda
üreten**, üretilenleri **aktif saat penceresine rastgele zamanlarla dağıtan** ve zamanı geldiğinde
**X'e metin+görsel reply olarak postlayan** yarı otonom, 4 ajanlı bir sistem.

**Değişmez ilke: Hiçbir tweet onay olmadan postlanmaz.** Otomasyon keşif → onay → üretim →
zamanlama → postlama akışını yürütür; onay adımı her zaman dashboard üzerinden elle verilir.

Sistem Hetzner VPS üzerinde systemd ile canlı çalışıyor; arama, medya yükleme ve gerçek medyalı
reply postlama uçtan uca doğrulanmış durumda.

## 2. Mimari

```
┌─────────────────┐
│   Dashboard      │  keyword girişi, onay kuyruğu, schedule, hesaplar, ayarlar
└────────┬─────────┘
         │ keyword
         ▼
┌─────────────────┐
│ scraping-agent   │──▶ X GraphQL (SearchTimeline) + iki katmanlı kalite filtresi
└────────┬─────────┘
         │ status='scraped'
         ▼
┌─────────────────┐
│   qa-agent       │  engagement skoru + aday seçimi (üretim yok)
└────────┬─────────┘
         │ status='pending_approval'
         ▼
┌─────────────────┐
│   Dashboard      │  Onayla / Hemen Paylaş / Reddet
└────────┬─────────┘
         │ status='generating' → Giggle (metin + görsel) → 'approved'
         ▼
┌─────────────────┐
│ scheduling-agent │  aktif-saat penceresine rastgele dağıtım, zamanı geleni ready_to_post yapar
└────────┬─────────┘
         │ status='ready_to_post'
         ▼
┌─────────────────┐
│  post-agent      │──▶ X GraphQL (medya upload + CreateTweet reply)
└──────────────────┘
```

**Koordinasyon:** paylaşılan SQLite veritabanı + durum makinesi. Tek gerçek kaynak
`tweets.status` kolonu. Ajanlar arasında doğrudan RPC yok; her ajan kendi state'indeki kayıtları
çeker, işler, sonraki state'e geçirir.

**Process modeli:** tek orchestrator (`src/index.js`), pm2 yok. Dashboard ve 4 ajan aynı süreçte
`safeLoop` interval'leri olarak çalışır:

| Döngü | Fonksiyon | Aralık |
|---|---|---|
| scheduling | `promoteDue` | 1 dk |
| post | `runPostCycle` | 1 dk |
| qa | `runQaCycle` (scrape sonrası dashboard'dan da tetiklenir) | 2 dk |
| cleanup | `purgeStaleScraped` + `purgeStalePendingApproval` | 6 saat |

Başlangıçta `resetGeneratingToPending()` yarıda kalmış `generating` kayıtları `pending_approval`'a
geri alır (Giggle/direct-post kuyruğu bellek-içi, restart'ta kaybolur).

**Durum makinesi:**
`scraped → pending_approval → generating → approved → scheduled → ready_to_post → posted`
(+ `failed | blocked_daily_limit | cancelled`; reddedilenler `rejected_tweets` tablosuna gider.)

## 3. X Entegrasyonu (kendi GraphQL client'ı)

Harici X kütüphanesi yok. `src/lib/x-graphql.js` saf `fetch` ile X'in internal GraphQL API'sine
authenticated istek atar.

- **Auth:** `.env`'deki `XACTIONS_AUTH_TOKEN` (`auth_token` cookie) + `XACTIONS_CT0` (`ct0` cookie),
  public web bearer, `x-csrf-token: <ct0>`, `x-twitter-auth-type: OAuth2Session`.
- **queryId'ler dinamik:** X'in canlı web bundle'ından (`main.<hash>.js`) regex ile çekilir; bundle
  okunamazsa `FALLBACK_QUERY_IDS` kullanılır. X queryId değiştirdiğinde kod kendini günceller.
- **SearchTimeline POST'tur** (GET 404 döner). Body: `{variables, features}`.
- **Reply:** chunked media upload (`upload.x.com/i/media/upload.json`, INIT→APPEND→FINALIZE→STATUS)
  → `media_id_string` → `CreateTweet` POST (`reply.in_reply_to_tweet_id` + `media.media_entities`).
- **Media çıkarımı:** `parseTweetResult` tweetin `extended_entities.media` alanından her medya için
  `media_url_https` alır (fotoğrafta görselin kendisi, video/GIF'te poster karesi). Ayrıca `views`
  ve `isReply` çıkarır.
- **Tek giriş noktası:** tüm X aksiyonları `src/lib/xactions-client.js` wrapper'ından
  (`withRetry`, throttle) ve `x-graphql.js` içindeki tek `xfetch` sarmalayıcısından geçer. Yeni bir
  X isteği eklenecekse `xfetch` kullanılır; rate-limit ve proxy mantığı bu noktada merkezidir.
- **Proxy:** `.env`'de `X_PROXY_URL` set edilirse **yalnızca X trafiği** undici `ProxyAgent`
  üzerinden gider (`fetch`/`FormData`/`ProxyAgent` üçü de `undici` paketinden import edilir; Node'un
  global `fetch`'i ProxyAgent ile uyumsuz). Giggle proxy'siz. Yönlendirme **post anında** belirlenir;
  DB'de IP bilgisi tutulmaz. Şu an `X_PROXY_URL` yorumda, X trafiği doğrudan VPS IP'sinden gidiyor;
  `/api/health` `proxy.enabled=false` gösterir.
- Detaylı notlar: `docs/xactions-notes.md`.

### 3.1 X tarafı hata kodları (bizim günlük limitimizden bağımsız)

X, `CreateTweet`'i kendi kodlarıyla reddedebilir:

- **344** `AuthorizationError` "daily limit for sending Tweets" → hesabın kendi X gönderim kotası
  (~24 saat kayan pencere).
- **226** "might be automated" → anti-otomasyon flag'i.
- **Boş `tweet_results` `{}`** → spam/duplicate throttle. Saniyeler içinde kalkmaz, dakikalar sonra
  aynı içerik geçer. `createReply` bunu `err.throttled=true` ile fırlatır.

`withRetry` throttle/226/344'te hızlı retry yapmaz (`err.noRetry`); 401/403'te hemen vazgeçer.
Bizim limit yerel kontroldür (`blocked_daily_limit`, ağ isteği atılmaz); X limitleri sunucu
yanıtındaki GraphQL hata kodudur. Hepsi `status='failed'` üretir, otomatik retry yok; kullanıcı
`/api/retry` veya `/api/retry-all` ile tekrarlar.

Hesap 226/344 veriyorsa sorun hesap itibarıdır: art arda deneme flag'i besler. Uygulanan kaldıraçlar
`strip_promo_links` (§5.4) ve kadans ayarları (`daily_post_limit`, `min_post_interval_minutes`).

## 4. Ajanlar

### 4.1 scraping-agent (`src/agents/scraping-agent.js`)

**Girdi:** dashboard'dan gelen keyword(ler), virgülle ayrılmış.

1. `buildSearchQuery` ile keyword'e X operatörleri eklenir (Katman 1) ve `top` modunda
   `SearchTimeline` sayfalanarak `scrape_target_per_keyword` hedefine kadar tweet çekilir.
2. Her tweet `passesQualityFilter` (Katman 2) ile elenir.
3. Geçenler `insertScrapedTweet` ile `status='scraped'` olarak yazılır. Dönüş değerleri:
   `inserted | skipped_rejected | skipped_processed | skipped_pending | skipped_author_cap`.
4. Bitince arka planda `runQaCycle` tetiklenir.

**Dedup (scrape aşaması):**
- id `rejected_tweets`'te → `skipped_rejected`.
- id `tweets`'te `scraped`/`pending_approval` → `skipped_pending` (zaten süreçte).
- id `tweets`'te `approved/scheduled/ready_to_post/posted` → `skipped_processed`.
- yazar `isAuthorCapped` → `skipped_author_cap` (§7, madde E).

#### 4.1.1 İki katmanlı kalite filtresi

Amaç: hedef tweet belli bir erişim eşiğinin üstünde olsun ve reply yorum yığınında gömülmesin.
Filtre insert'ten önce uygulanır; eşikler `settings`'te `filter_*` anahtarlarıdır.

**Katman 1 — X arama operatörleri (`buildSearchQuery`):**
- `min_faves:<filter_min_faves>`
- `since:<bugün − filter_within_days>`
- `-filter:replies` X SearchTimeline'da 0 sonuç döndürdüğü için kullanılmaz; yanıt eleme Katman 2'de.

**Katman 2 — kod (`passesQualityFilter`):**
- `filter_min_views` — minimum görüntülenme.
- `filter_max_replies` — yorum üst tavanı.
- `filter_max_reply_view_ratio` — `replies/views` bu oranı geçerse elenir (asıl gömülme filtresi).
- `filter_exclude_replies` — tweet başka birine yanıtsa ele (`t.isReply`).
- `filter_max_age_hours` — tweetin yaşı.
- views bilinmiyorsa (0) view tabanlı kontroller atlanır.

Varsayılanlar: `min_faves=500, within_days=3, exclude_replies=1, min_views=50000,
max_replies=2000, max_reply_view_ratio=0.0015, max_age_hours=72`.

**Tetiklenme:** yalnız manuel ("Scrape Et" butonu). Periyodik cron yok.

### 4.2 qa-agent (`src/agents/qa-agent.js`)

**Girdi:** `status='scraped'`.

1. Engagement skoru: `score = likes*w_likes + retweets*w_retweets + replies*w_replies +
   quotes*w_quotes`; ağırlıklar `settings`'te (`score_w_*`).
2. Boş slot = `min(kalan günlük kota, approval_queue_max − mevcut pending_approval)`. Skora göre
   sıralanır, bu kadar aday `status='pending_approval'` yapılır. Kuyruk doluysa aday alınmaz.
3. **Üretim yapmaz.** Metin ve görsel onaydan sonra üretilir (§4.5).
4. Dedup ikinci katman: `rejected_tweets`'teki ya da `approved/scheduled/ready_to_post/posted`
   durumdaki id'ler aday olmaz (scrape ile qa arasında geçen sürede durum değişmiş olabilir).

**Çıktı:** `pending_approval` → onay kuyruğunda yalnız hedef tweet (metin, yazar, etkileşim,
orijinal medya önizlemesi) gösterilir.

### 4.3 scheduling-agent (`src/agents/scheduling-agent.js`)

**Girdi:** `status='approved'` (Giggle üretimi tamamlanmış) kayıtlar. `scheduleApproved()` onay
ve retry akışlarından çağrılır.

**Slot algoritması (`nextSlot`):**
- dakika aralığı = `min_post_interval_minutes` (taban) + `0..post_interval_jitter_minutes` rastgele
  **tam dakika**;
- **saniye ve milisaniye her kayıtta bağımsızca randomlanır** (`slot.setSeconds(rand60, rand1000)`),
  böylece postlar aynı `:ss.SSS` deseniyle gitmez;
- taban dakika sub-dakika kaymadan büyük olduğu için minimum aralık korunur.

**Aktif-saat penceresi (`clampToActiveHours`):** `active_hours_enabled=1` iken her slot yerel saat
penceresine (`active_hours_start`..`active_hours_end`, `active_hours_tz_offset` ile UTC↔yerel)
kısıtlanır. Pencere dışına düşen slot uygun günün başlangıç saatine, ilk saat içinde rastgele
jitter'la taşınır. VPS UTC çalışır; Türkiye için offset 3.

**Günlük limit:** bir günde etkin limitin üzerinde slot verilmez; fazlası sonraki güne kayar
(yerel saat korunur, pencerede kalır).

**Worker:** `promoteDue` her dakika `scheduled_at <= now AND status='scheduled'` kayıtları
`ready_to_post` yapar.

Kullanıcı Schedule sekmesinden `scheduled` bir kaydı iptal edebilir (`/api/cancel` → `cancelled`).

### 4.4 post-agent (`src/agents/post-agent.js`)

**Girdi:** `status='ready_to_post'`.

1. Günlük etkin limit kontrolü (`remainingDailyQuota`); doluysa `blocked_daily_limit`.
2. `generated_reply_text` boşsa güvenlik: `failed`.
3. `strip_promo_links=1` ise `stripPromoLinks()` ile metin temizlenir (DB'deki tam metin değişmez).
4. `postReply` → görsel upload + `createReply`.
5. Başarı: `posted` + `posted_reply_id`, `daily_post_counts` artar, `incAuthorReply(author)`.
6. Hata: `failed` + `error_message`. **Otomatik retry yok**; dashboard'dan `/api/retry`.

### 4.5 Üretim: Giggle (`src/lib/giggle-client.js`)

Cevap metni ve çizgi-roman görseli tek Giggle çağrısıyla üretilir. Üretim **onaydan sonra** ve
yalnız onaylanan tweetler için tetiklenir.

**Servis sözleşmesi:**
- `POST <GIGGLE_API_URL>` (Supabase Edge Function `tweet-comic-reply`).
- Auth header `x-api-key: <GIGGLE_API_KEY>`; `GIGGLE_AUTH_SCHEME` ile `bearer | apikey | x-api-key`
  seçilebilir.
- Gövde: `{ id, text, author, platform:'twitter', media: string[] }`.
- Yanıt: `text` (reply metni) + `media[0]` (Supabase storage imzalı URL, ~1 saat geçerli).
- Giggle **yalnız görsel** kabul eder (jpeg/png/webp); bu yüzden video/GIF için poster karesi
  gönderilir. Medyasız tweetler de işlenir (`media:[]`).
- Üretim ~105 sn sürer; client timeout 180 sn. Edge Function idle limiti nedeniyle
  `504 IDLE_TIMEOUT` (ve 502/503, abort) geçici hatadır → `generateComicReply` toplam
  `GIGGLE_MAX_RETRIES+1` (varsayılan 3) deneme yapar, aralarda 3 sn × deneme bekler.

`generateComicReply({id,text,author,media})` → `{replyText, imagePath, imageUrl}`. Görsel imzalı URL
süreli olduğu için **üretim anında** `data/images/<id>.<ext>`'e indirilir; dashboard `/images/*`
ile serve eder. Giggle isteği normal `fetch` kullanır, X proxy'sinden etkilenmez.

**Giggle metni ve `stripPromoLinks`:** Giggle'ın döndürdüğü metin "— Giggle" imzası ve "Download
Giggle 👇 App Store / Google Play" link bloğu içerir. Tekrarlı ve linkli reply X'te spam sinyali
olduğundan `strip_promo_links=1` iken bu blok post anında temizlenir; imza kalır. Dashboard
"görünen == postlanan" olsun diye aynı temizliği gösterir (`/api/health` `stripPromoLinks`).
Uygulandığı yerler: `post-agent.runPostCycle` ve `server.processDirectPost`.

## 5. Dashboard (`src/dashboard/`)

Express REST API (`server.js`) + vanilla HTML/JS frontend (`public/index.html, app.js, style.css`),
build adımı yok. Dashboard aynı DB üzerinde view + control katmanıdır. Sağ üstte "X bağlı" durum
çubuğu (`/api/health`, 30 sn'de bir).

### 5.1 Keyword & Scrape
Virgülle ayrılmış keyword girişi, "Scrape Et" butonu, son scrape özeti (bulunan / eklenen /
filtre-elenen / hesap-limiti-elenen sayıları).

### 5.2 Onay Kuyruğu
`pending_approval` kayıtlar; her biri için orijinal tweet metni, yazar, etkileşim sayıları, link,
orijinal medya önizlemesi. Üç aksiyon:

- **Onayla** (`/api/approve`) → `generating` → arka planda `generateComicForApproved` (Giggle) →
  başarı `approved` + `scheduleApproved()` → `scheduled`; hata `failed`.
- **Hemen Paylaş** (`/api/post-now`) → `generating` → seri kuyruk (`enqueueDirectPost` /
  `drainDirectQueue` / `processDirectPost`) → Giggle → zamanlamadan `postReply` → `posted`
  (günlük limit son kontrol; doluysa `blocked_daily_limit`). Frontend geri-alınamaz onay diyaloğu
  ister. Art arda tıklananlar tek worker'da sırayla işlenir; iki direct-post arasında
  `direct_post_min_gap_seconds` + `0..direct_post_gap_jitter_seconds` taban bekleme uygulanır.
  Kuyruk bellek-içi; restart'ta `generating` kayıtlar `pending_approval`'a döner.
  - **Post aşaması fallback (hata sınıfına göre):**
    - *Geçici throttle* (`err.throttled`, boş `tweet_results`): `direct_post_throttle_retries` kez,
      aralarında `direct_post_throttle_wait_seconds` bekleyerek aynı içerik tekrar denenir. Geçerse
      `posted`. Hepsi tükenirse `approved` + `scheduleApproved()` ile sonraya zamanlanır,
      `error_message` temizlenir.
    - *Sert hata* (`err.noRetry`: 226, 344, auth): `failed`, `error_message` korunur.
    - *Üretim (Giggle) hatası*: her zaman `failed`.
    - Her dalda `pushNotification` → frontend `/api/notifications?since=<id>` 10 sn'de bir çeker →
      5 sn toast. Bildirimler bellek-içi halka tampon (son 50), restart'ta sıfırlanır.
- **Reddet** (`/api/reject`) → `rejected_tweets` (kalıcı dedup).

### 5.3 Schedule
`generating / scheduled / ready_to_post / posted / failed / blocked_daily_limit / cancelled`
kayıtların listesi, **`scheduled_at DESC`** (en yeniden en eskiye, tüm filtreler için). Durum
filtre çipleri, gün içi 24 saat ray görünümü, "sonraki post" göstergesi; sekme açıkken 60 sn'de bir
tazelenir. Her satırda: orijinal tweet (metin+link), üretilen reply metni, görsel küçük önizlemesi,
planlanan tarih ve saat (yerel saat), durum, postlandıysa reply linki, başarısızsa hata mesajı.
`generating` "Üretiliyor" olarak gösterilir.

Aksiyonlar: `scheduled` → **İptal** (`/api/cancel`); `failed`/`blocked_daily_limit` → **Yeniden
Dene** (`/api/retry`); "Başarısız" filtresinde birden fazla kayıt varsa **"Hepsini Yeniden Dene (N)"**
(`/api/retry-all`). `retryOne()`: metin varsa `approved` + yeniden planlar; metin yoksa `generating` +
Giggle'ı baştan çağırır.

### 5.4 Hesaplar
`/api/author-replies` → `{windowDays, maxReplies, windowStart, book:[{author,count,last_at}]}`.
Pencere içinde hangi hesaba kaç reply atıldığı; sınıra ulaşanlar "sınırda" rozetiyle.

### 5.5 Ayarlar
Tüm `settings` satırları sayısal alan olarak listelenir (`author_cap_window_start` runtime değeri
olduğu için gizli). Kaydet → `/api/settings` → DB; ajanlar bir sonraki turda yeni değeri kullanır.

| Anahtar | Varsayılan | Anlam |
|---|---|---|
| `daily_post_limit` | 30 | günlük post tavanı |
| `daily_limit_jitter` | 6 | o günün etkin limiti = tavan − rastgele 0..jitter (gün içinde sabit) |
| `yesterday_warn_max_per_day` | 2 | "dünkü sayıya ulaştın" uyarısının günlük gösterim tavanı |
| `min_post_interval_minutes` | 15 | iki post arası taban dakika |
| `post_interval_jitter_minutes` | 9 | tabana eklenen 0..N rastgele tam dakika |
| `scrape_target_per_keyword` | 200 | keyword başına çekilecek tweet hedefi |
| `scraped_ttl_hours` | 48 | işlenmemiş `scraped` kayıtların silinme süresi |
| `approval_queue_max` | 100 | onay kuyruğu üst sınırı (0=sınırsız) |
| `approval_ttl_hours` | 12 | onaylanmadan bekleyen kayıtların silinme süresi (0=kapalı) |
| `score_w_likes / retweets / replies / quotes` | 1 / 2 / 1.5 / 1.5 | skor ağırlıkları |
| `filter_min_faves` | 500 | X `min_faves:` operatörü |
| `filter_within_days` | 3 | X `since:` operatörü |
| `filter_exclude_replies` | 1 | yanıt tweetlerini ele |
| `filter_min_views` | 50000 | minimum görüntülenme (0=kapalı) |
| `filter_max_replies` | 2000 | yorum üst tavanı (0=kapalı) |
| `filter_max_reply_view_ratio` | 0.0015 | yorum/görüntülenme tavanı (0=kapalı) |
| `filter_max_age_hours` | 72 | tweet yaşı tavanı (0=kapalı) |
| `direct_post_min_gap_seconds` | 120 | art arda Hemen Paylaş arası taban bekleme |
| `direct_post_gap_jitter_seconds` | 60 | üstüne 0..N rastgele saniye |
| `direct_post_throttle_retries` | 3 | geçici throttle'da tekrar deneme sayısı |
| `direct_post_throttle_wait_seconds` | 90 | throttle denemeleri arası bekleme |
| `strip_promo_links` | 1 | post anında Giggle link bloğunu temizle |
| `active_hours_enabled` | 1 | aktif-saat penceresi açık |
| `active_hours_start` | 8 | yerel başlangıç saati (dahil) |
| `active_hours_end` | 23 | yerel bitiş saati (hariç) |
| `active_hours_tz_offset` | 3 | yerel saat − UTC (Türkiye=3) |
| `author_cap_max_replies` | 2 | pencere içinde hesap başına en fazla reply (0=kapalı) |
| `author_cap_window_days` | 7 | hesap reply defteri sıfırlanma penceresi |

### 5.6 API özeti
`POST /api/scrape`, `POST /api/generate` (qa turunu elle tetikler), `GET /api/queue`,
`GET /api/tweets?status=`, `GET /api/schedule`, `POST /api/approve`, `POST /api/post-now`,
`POST /api/reject`, `POST /api/cancel`, `POST /api/retry`, `POST /api/retry-all`,
`GET /api/author-replies`, `GET /api/notifications?since=`, `GET|POST /api/settings`,
`GET /api/health` (auth durumu, proxy, etkin/temel günlük limit, dünkü post sayısı, bugün planlı).

## 6. Veri Modeli (SQLite, WAL)

**DB: Node yerleşik `node:sqlite` (`DatabaseSync`).** VPS'te C derleyici olmadığı için native
bağımlılık kullanılmaz. **Gereksinim: Node ≥ 22.5** (`package.json` `engines`), kurulu Node 24.
`node:sqlite` deneysel; import'ta zararsız ExperimentalWarning basar.

Tek dosya `data/app.db`. Her bağlantı `src/lib/db.js` içinde açılır ve şu pragma'ları set eder:
`journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`. Tüm SQL `db.js` repository
katmanında; ajanlar ve dashboard iş mantığında SQL yazmaz. Şema ve migration'lar idempotent
(`CREATE TABLE IF NOT EXISTS`, try/catch'li `ALTER TABLE ADD COLUMN`); mevcut DB açılışta
otomatik güncellenir. `DEFAULT_SETTINGS` `INSERT OR IGNORE` ile seed edilir.

```sql
CREATE TABLE tweets (
  id TEXT PRIMARY KEY,              -- orijinal tweet id
  author TEXT,
  text TEXT,
  likes INTEGER,
  retweets INTEGER,
  replies INTEGER,
  quotes INTEGER,
  views INTEGER DEFAULT 0,          -- görüntülenme (kalite filtresi)
  url TEXT,
  keyword TEXT,                     -- hangi keyword ile bulundu (operatörsüz)
  score REAL,                       -- qa-agent engagement skoru
  tweet_media TEXT,                 -- orijinal tweetin medya URL'leri (JSON dizi, Giggle'a gider)
  generated_reply_text TEXT,        -- Giggle reply metni (tam hali; promo bloğu dahil)
  generated_image_url TEXT,         -- Giggle imzalı URL (süreli)
  generated_image_path TEXT,        -- indirilen görselin yerel yolu (data/images/)
  image_prompt TEXT,                -- kullanılmıyor, şema uyumu için duruyor
  status TEXT,                      -- scraped | pending_approval | generating | approved
                                     -- | scheduled | ready_to_post | posted | failed
                                     -- | blocked_daily_limit | cancelled
  scheduled_at DATETIME,
  posted_reply_id TEXT,
  error_message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rejected_tweets (
  tweet_id TEXT PRIMARY KEY,
  rejected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  reason TEXT
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE daily_post_counts (
  date TEXT PRIMARY KEY,            -- 'YYYY-MM-DD'
  count INTEGER DEFAULT 0,
  effective_limit INTEGER,          -- o günün etkin limiti (tavan − jitter), ilk hesapta yazılır
  warn_shown INTEGER DEFAULT 0      -- "dünkü sayıya ulaştın" uyarısı kaç kez gösterildi
);

CREATE TABLE author_reply_counts (   -- hesap başına reply defteri (pencere içinde)
  author TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  last_at DATETIME
);
```

## 7. Dedup, Tazelik ve Ban-Riski Önlemleri

**Dedup:** postlanan kayıt `posted` durumunda kalıcı durur; reddedilen `rejected_tweets`'e yazılır.
İkisi de re-scrape'te atlanır. Postlanan ya da reddedilen tweet asla ikinci kez reply almaz.

**TTL temizliği (cleanup döngüsü, 6 saat):**
- `purgeStaleScraped()` — `scraped_ttl_hours`'tan eski, hâlâ `scraped` kayıtları siler.
- `purgeStalePendingApproval()` — `approval_ttl_hours`'tan uzun süre `pending_approval` bekleyen
  kayıtları siler. Bunlar `rejected_tweets`'e **yazılmaz**; ileride yeniden scrape edilebilir.
  Süre `updated_at`'e göre.
- Dedup hafızasına (posted/rejected) dokunulmaz.

**Günlük limit:** `daily_post_limit` tavandır. `getEffectiveDailyLimit()` = tavan − rastgele
`0..daily_limit_jitter` (min 1); gün içinde sabit kalsın diye ilk hesapta
`daily_post_counts.effective_limit`'e yazılır. `remainingDailyQuota()` bu değeri kullanır. qa-agent
adayları, scheduling-agent slotları, post-agent postları bu limite göre keser.

**Zaman deseni:** dakika = taban + rastgele tam dakika; saniye/salise her slotta bağımsız random
(§4.3). Aktif-saat penceresi ile gece post atılmaz.

**Hesap başına reply sıklığı:** `author_reply_counts` tablosu, başarılı her postta
`incAuthorReply(author)` (scheduled ve direct post). `maybeResetAuthorWindow()` her okuma/yazmadan
önce bakar: `now − author_cap_window_start >= author_cap_window_days` ise tabloyu siler, pencereyi
yeniden başlatır. `isAuthorCapped(author)` (`count >= author_cap_max_replies`) olan hesapların yeni
tweetleri scrape'te elenir.

**"Dünkü sayıya ulaştın" uyarısı:** Hemen Paylaş sonrası bugünkü postlanan ≥ dünkü
(`maybeWarnYesterdayMatch`) ya da schedule anında bugünkü planlı+atılan ≥ dünkü
(`maybeWarnScheduleMatch`) → `pushNotification` toast. Günde en fazla `yesterday_warn_max_per_day`.

**Promo link temizleme:** §4.5.

**Hemen Paylaş burst koruması:** seri kuyruk + `direct_post_min_gap_seconds` + jitter (§5.2).

**Bilinçli olarak yok:** adaptif geri-çekilme / circuit breaker. Tek bir 226/344/throttle sinyali
normal gürültüdür; sistem durmaz. Post hatası `failed` olur, otomatik retry yok, tekrar elle.

## 8. Dış Servisler ve `.env`

| Servis | Kullanım | `.env` |
|---|---|---|
| X internal GraphQL | tweet arama, medya çıkarımı, medya upload, reply | `XACTIONS_AUTH_TOKEN`, `XACTIONS_CT0`, opsiyonel `X_PROXY_URL` |
| Giggle (Supabase Edge Function) | reply metni + çizgi-roman görseli | `GIGGLE_API_URL`, `GIGGLE_API_KEY`, `GIGGLE_AUTH_SCHEME` (`x-api-key`) |

Diğer: `PORT` (3000), `HOST` (`0.0.0.0`), `GIGGLE_MAX_RETRIES` (2).
`.env` repoya girmez (`.gitignore`: `node_modules/ .env data/ *.log`). `.env` **tümden yeniden
yazılmaz; yalnız ilgili satır değiştirilir.**

## 9. Proje Yapısı

```
/
├── CLAUDE.md                        -- bu dosya
├── HANDOFF.md                       -- devam eden oturum için özet
├── gerekli.md                       -- günlük işletim komutları + ayar açıklamaları
├── .env                             -- gizli anahtarlar (repoya girmez)
├── package.json                     -- express, dotenv, undici; "type": "module"; engines node>=22.5
├── src/
│   ├── index.js                     -- orchestrator (dashboard + 4 döngü)
│   ├── agents/
│   │   ├── scraping-agent.js
│   │   ├── qa-agent.js
│   │   ├── scheduling-agent.js
│   │   └── post-agent.js
│   ├── lib/
│   │   ├── db.js                    -- node:sqlite, şema, migration, repository fonksiyonları
│   │   ├── x-graphql.js             -- X GraphQL client + xfetch (proxy noktası)
│   │   ├── xactions-client.js       -- X aksiyon wrapper'ı: withRetry, checkAuth, proxyStatus, checkExitIp
│   │   ├── giggle-client.js         -- generateComicReply, stripPromoLinks
│   │   └── logger.js
│   └── dashboard/
│       ├── server.js                -- Express API + statik serve + direct-post kuyruğu + bildirimler
│       └── public/                  -- index.html, app.js, style.css
├── scripts/
│   ├── auth-test.js                 -- npm run auth-test: X cookie/arama/proxy çıkış IP kontrolü
│   └── retry-post.js                -- ilk failed kaydı ready_to_post yapıp post turunu çalıştırır
├── docs/xactions-notes.md           -- X client detayları
├── prompts/                         -- boş
└── data/                            -- app.db (+ -wal/-shm), images/
```

## 10. İşletim

**Kurulum / çalıştırma:**
```bash
npm install            # native derleme yok
# .env oluştur: XACTIONS_AUTH_TOKEN, XACTIONS_CT0, GIGGLE_API_URL, GIGGLE_API_KEY, GIGGLE_AUTH_SCHEME (§8)
npm start              # orchestrator + dashboard → http://localhost:3000
npm run auth-test      # X cookie / arama / çıkış IP kontrolü
```

**Kalıcı çalışma: systemd** — `/etc/systemd/system/x-automation.service` (repoda tutulmaz):
```ini
[Unit]
Description=X-Automation orchestrator (dashboard + 4 ajan döngüsü)
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=hakan
WorkingDirectory=/home/hakan/projeler/X-Automation
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
StandardOutput=append:/home/hakan/projeler/X-Automation/orchestrator.log
StandardError=append:/home/hakan/projeler/X-Automation/orchestrator.log
[Install]
WantedBy=multi-user.target
```
Yönetim: `sudo systemctl {status|restart|stop|start} x-automation`. Backend/ajan kodu değişince
`restart`; frontend statik diskten serve edildiği için sadece tarayıcı yenilemesi yeter.
Passwordless sudo yok; restart'ı kullanıcı çalıştırır.

**Erişim:** dashboard `0.0.0.0:3000`'e bind olur ama port internete açık değil; dashboard'da auth
yok. Erişim VS Code/Cursor Remote-SSH port-forward ya da `ssh -L 3000:localhost:3000` ile
`http://localhost:3000`.

**Cookie yenileme:** health "X bağlı değil" derse x.com'da tam çıkış-giriş → taze `auth_token` +
`ct0` → `.env`'de yalnız o iki satır → `sudo systemctl restart x-automation` → `npm run auth-test`.

**Tek instance kuralı:** aynı DB'ye iki orchestrator = çift postlama riski. Aynı portta ikinci
instance `EADDRINUSE` ile çöker; farklı portta ikinci orchestrator çalıştırılmaz.

## 11. Çalışma Kuralları (Claude Code için)

- Onaysız postlama yok. Gerçek reply postlayan bir test, içerik gösterilip açık onay alınmadan
  çalıştırılmaz.
- `.env` tümden yazılmaz.
- Dashboard public'e açılmaz.
- Ayarlanabilir her değer `settings` tablosundan okunur; sabit kod yazılmaz.
- Her yeni X isteği `xfetch`'ten geçer.
- `style.css`'teki `[hidden]{display:none!important}` kuralı modal/badge davranışı için zorunlu;
  kaldırılmaz.
- Mimari bir karar değişirse CLAUDE.md, HANDOFF.md ve gerekirse gerekli.md aynı değişiklikte
  güncellenir; dosyalar geçmiş halleri değil, mevcut durumu anlatır.

## 12. Kapsam Dışı (şu an yok)

- İçerik-benzerliği dedup (embedding).
- Otomatik periyodik scrape.
- Dashboard auth.
- Sessiz-hata watchdog / dış bildirim (Telegram, e-posta).
