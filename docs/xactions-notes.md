# XActions Entegrasyon Notları

> ## ✅ NİHAİ ÇÖZÜM: Kendi minimal GraphQL client'ı (harici X kütüphanesi YOK)
>
> Hem XActions hem agent-twitter-client elendi (aşağıda). Çözüm: `src/lib/x-graphql.js`
> — saf `fetch` ile X'in internal GraphQL API'sine doğrudan authenticated istek.
>
> **Neden çalışıyor (canlı doğrulandı):**
> - **Cookie'ler geçerli, IP çalışıyor.** Ham `UserByScreenName` isteği 200 döndü; sorun
>   hep kütüphanelerdeydi.
> - **queryId'ler X'in canlı bundle'ından dinamik çekiliyor** (`x.com/` → `main.<hash>.js`
>   → regex `queryId:"X",operationName:"OP"`). Fallback hardcoded (güncel 2026-07):
>   `SearchTimeline: Bcw3RzK-PatNAmbnw54hFw`, `CreateTweet: R5EPiGHgSqbTYFyozd-gFw`.
> - **SearchTimeline artık POST** (GET → boş 404 — takıldığımız yer buydu). Body: `{variables, features}`.
> - Auth header'ları: `authorization: Bearer <public web bearer>`, `cookie: auth_token=..; ct0=..`,
>   `x-csrf-token: <ct0>`, `x-twitter-auth-type: OAuth2Session`, `x-twitter-active-user: yes`.
> - Medya: chunked upload `upload.x.com/i/media/upload.json` (INIT→APPEND→FINALIZE) → `media_id_string`
>   → `CreateTweet` POST (`media.media_entities` + `reply.in_reply_to_tweet_id`).
>
> **Canlı test durumu:** search ✔, medya yükleme ✔ (gerçek media_id), OpenAI ✔, fal.ai ✔.
> `createReply` gerçek post olduğu için kullanıcı onayıyla test edilir.
>
> **Bakım notu:** X queryId'leri periyodik değişir; dinamik çekim bunu otomatik yakalar.
> Bundle formatı kökten değişirse `x-graphql.js`'teki FALLBACK_QUERY_IDS'i güncelle.
>
> ---
>
> ## ⚠️ ELENEN 2: agent-twitter-client (bozuk auth akışı)
>
> **XActios 3.1.0 kullanılmıyor.** Canlı testte XActions'ın hardcode ettiği X GraphQL
> `queryId`/endpoint'lerinin **eskimiş** olduğu ve TÜM çağrıların `404` döndürdüğü
> tespit edildi (SearchTimeline, UserByScreenName, TweetResultByRestId, hatta
> cookie'siz `guest/activate` bile). Bu bir kimlik-bilgisi veya IP sorunu **değil**:
> - Ortamdan X'e erişim var (public syndication API'den tweet #20 `200` döndü).
> - Guest-token (cookie kullanmaz) bile 404 → sorun kütüphanede.
>
> Yerine **`agent-twitter-client`** (aktif bakımlı, twitter-scraper forku) seçildi.
> Canlı testte X'in search endpoint'ine **doğru queryId ile ulaştı** (404 yok).
> Kullanılan API (`src/lib/xactions-client.js` bunu sarar):
> ```js
> import { Scraper, SearchMode } from 'agent-twitter-client';
> const s = new Scraper();
> await s.setCookies([                       // Domain=.twitter.com ŞART (jar host'u)
>   `auth_token=${AUTH}; Domain=.twitter.com; Path=/; Secure; HttpOnly`,
>   `ct0=${CT0}; Domain=.twitter.com; Path=/; Secure`,
> ]);
> for await (const t of s.searchTweets(kw, limit, SearchMode.Top)) { ... }
> // Tweet: { id, text, username, likes, retweets, replies, views, permanentUrl, photos }
> await s.sendTweet(text, replyToTweetId, [{ data: Buffer, mediaType: 'image/png' }]);
> ```
>
> **AÇIK BLOKER — cookie yenileme gerekli:** `.env`'deki `auth_token`/`ct0` sağlam
> formatta (40 / 160 karakter) ama X tarafından **reddediliyor** (agent-twitter-client
> search: `401 code 32 "Could not authenticate you"`). Token süresi dolmuş veya ct0 ile
> auth_token farklı oturumlardan. Çözüm: x.com'da giriş yapıp DevTools → Application →
> Cookies'ten **aynı anda** taze `auth_token` + `ct0` alıp `.env`'i güncellemek.
>
> Aşağıdaki XActions notları **tarihsel/referans** olarak korunuyor (uygulanmıyor).

---

Bu dosya, `xactions` (v3.1.0) npm paketinin kaynağı incelenerek çıkarıldı. Sistem, XActions'ı **doğrudan Node kütüphanesi** olarak, spesifik olarak **HTTP-only scraper** katmanı üzerinden kullanır (Puppeteer / better-sqlite3 / Prisma gerektirmez).

## Kritik karar: Neden HTTP scraper?

`xactions` paketinin ana export'u (`import ... from 'xactions'`) Puppeteer + Prisma + better-sqlite3 çeker. Bu ortamda **build araçları (make/gcc) yok**, dolayısıyla `better-sqlite3` native derlenemiyor. Ancak:

- Paket `--ignore-scripts` ile kurulabiliyor (native derleme atlanır).
- `xactions/scrapers/twitter/http` alt-modülü **saf HTTP** (fetch/axios tabanlı, Twitter internal GraphQL API). Native bağımlılık çekmeden import oluyor (~60ms). İhtiyacımız olan tüm fonksiyonlar burada.

> **Kurulum:** `npm install xactions --ignore-scripts`
> Bizim DB katmanımız `better-sqlite3` yerine **Node 24 yerleşik `node:sqlite`** kullanır (native derleme yok).

## Kimlik doğrulama

Cookie string ile: `auth_token=<...>; ct0=<...>`

`.env`'de mevcut:
- `XACTIONS_AUTH_TOKEN` → `auth_token`
- `XACTIONS_CT0` → `ct0`

Cookie string'i şöyle kur: `` `auth_token=${AUTH_TOKEN}; ct0=${CT0}` ``

## Kullanılan API yüzeyi

### 1. Scraper oluşturma (auth'lu)
```js
import { createHttpScraper } from 'xactions/scrapers/twitter/http';
const scraper = await createHttpScraper({
  cookies: `auth_token=${process.env.XACTIONS_AUTH_TOKEN}; ct0=${process.env.XACTIONS_CT0}`,
  rateLimitStrategy: 'wait', // 429'da bekler; 'error' fırlatır
});
// scraper.client → düşük seviye TwitterHttpClient (search için gerekli)
// scraper.uploadImage / scraper.replyToTweet / scraper.postTweet ... → bağlı metodlar
```

### 2. Keyword arama (POPÜLER tweetler)
`searchTweets` http barrel'ında **re-export edilmemiş**, iç yoldan import edilir:
```js
import { searchTweets } from 'xactions/scrapers/twitter/http/search.js';
// NOT: package exports map bu alt-yolu açmıyor; tam yol ile:
// import { searchTweets } from '.../node_modules/xactions/src/scrapers/twitter/http/search.js'
const tweets = await searchTweets(scraper.client, keyword, {
  limit: 200,        // internal pagination ile bu sayıya kadar
  type: 'Top',       // 'Top' = popüler | 'Latest' | 'Photos' | 'Videos'
  lang: 'en',        // opsiyonel
  minLikes: 10,      // opsiyonel ön-filtre (min_faves)
});
```
`type: 'Top'` + `minLikes` popülerlik gereksinimini (spec §4.1) karşılar.

### 3. Dönen tweet nesnesi (parseTweetData)
```js
{
  id: '1868...',                  // orijinal tweet id (PRIMARY KEY)
  text: 'full text...',
  createdAt: '2026-07-08T...Z',   // ISO
  author: { id, username, name, avatar, verified },
  metrics: { likes, retweets, replies, quotes, bookmarks, views },
  media: [{ type, url, ... }],
  isReply, isRetweet, lang, ...
}
```
- **Permalink alanı YOK** → kur: `https://x.com/${author.username}/status/${id}`
- Engagement skoru için: `metrics.likes/retweets/replies/quotes` (spec §4.2 formülü birebir uyumlu).

### 4. Görsel yükleme → media_id
```js
const { mediaId } = await scraper.uploadImage(imagePathOrBuffer); // max 5 MB (JPEG/PNG/GIF/WebP)
// dönüş: { mediaId: string, mediaKey: string|null }
```

### 5. Metin + görsel REPLY (gating premisi — DESTEKLENİYOR ✅)
```js
await scraper.replyToTweet(tweetId, replyText, { mediaIds: [mediaId] });
// içte postTweet(client, text, { replyTo: tweetId, mediaIds }) çağırır
```
> **Gating risk çözüldü:** Metin+görsel reply tam destekli (chunked upload → `upload.x.com`, GraphQL CreateTweet `media_entities` + `reply.in_reply_to_tweet_id`). Fallback'e gerek yok.

## Hata sınıfları
`xactions/scrapers/twitter/http` şunları export eder: `TwitterApiError, RateLimitError, AuthError, NotFoundError, NetworkError`. post-agent bunları yakalayıp `status='failed'` + `error_message` yazar (spec §4.4).

## Rate-limit / ban riski
- `createHttpScraper({ rateLimitStrategy: 'wait' })` → 429'da otomatik bekler.
- Yine de spec §7 önlemleri (günlük limit, aksiyonlar arası jitter) **uygulama katmanında** zorunlu — tüm X aksiyonları `src/lib/xactions-client.js`'ten geçer (tek merkez).
- Resmi API değil (cookie tabanlı) → hesap ban riski gerçek; günlük post limiti düşük tutulmalı.

## Özet eşleme (spec → gerçek API)
| Spec (MCP tool) | Gerçek kullanım (HTTP kütüphane) |
|---|---|
| `x_search_tweets` | `searchTweets(client, kw, { type:'Top', limit })` |
| `x_get_tweet_metrics` | search sonucundaki `tweet.metrics` (ayrı çağrı gerekmez) |
| `x_reply` (metin+medya) | `uploadImage()` → `replyToTweet(id, text, { mediaIds })` |

## Tweet medya çıkarımı (Giggle için — 2026-07-28)
Giggle çizgi-roman servisi hedef tweetin görselini/videosunu ister. Medya URL'leri **ayrı bir
tweet-detay çağrısına gerek kalmadan** `src/lib/x-graphql.js` `parseTweetResult` içinde search
payload'ından çıkarılır: `legacy.extended_entities.media` (yoksa `entities.media`) →
- `type==='photo'` → `media_url_https`
- `type==='video'|'animated_gif'` → `video_info.variants` içinden en yüksek bitrate `video/mp4`
Çıkan dizi tweet nesnesinde `media` alanı olur, `tweets.tweet_media` (JSON) kolonunda saklanır ve
Giggle isteğinin `media` alanına konur. Medya yoksa `[]` (tweet yine de işlenir). Detay: `CLAUDE.md` §12.6.
