# X Entegrasyon Notları — `src/lib/x-graphql.js` + `src/lib/xactions-client.js`

X ile tüm iletişim harici kütüphane olmadan, X'in internal GraphQL API'sine cookie ile
authenticated istek atan kendi client'ımızla yapılır. Resmi API değil; hesap ban riski gerçek,
bu yüzden kadans ve limit önlemleri uygulama katmanında (`CLAUDE.md` §7).

## Katmanlar

- **`x-graphql.js`** — ham X GraphQL: `searchTweets`, `uploadImage`, `createReply`,
  `deleteTweet`, `verifyAuth`, `proxyStatus`, `checkExitIp`. Tüm HTTP istekleri tek `xfetch`
  sarmalayıcısından geçer.
- **`xactions-client.js`** — ajanların kullandığı sarmalayıcı: `search`, `postReply`, `checkAuth`,
  `tweetUrl`. Her çağrı `withRetry` içinden geçer:
  - `throttle()` — ardışık X aksiyonları arası en az 1,5 sn + 0-0,5 sn jitter.
  - varsayılan 2 tekrar (toplam 3 deneme), denemeler arası 1 sn × deneme.
  - 401/403 (auth), `err.throttled` (boş `tweet_results`) ve `err.noRetry` (226/344) durumunda
    **tekrar yapmaz**, hemen fırlatır; bayraklar (`throttled`, `noRetry`, `graphqlCode`, `status`)
    üst katmana taşınır. Direct-post fallback ve retry akışı bunlara göre karar verir.

Ajanlar `x-graphql.js`'i doğrudan çağırmaz; yeni bir X isteği eklenecekse `xfetch` üzerinden
yazılır ve `xactions-client.js`'te `withRetry` ile sarılır.

## Kimlik doğrulama

`.env`: `XACTIONS_AUTH_TOKEN` (x.com `auth_token` cookie'si) + `XACTIONS_CT0` (`ct0` cookie'si).
İkisi **aynı oturumdan** alınır; farklı oturumlardan gelirse X 401 döner.

`authHeaders()` her isteğe ekler:
```
authorization: Bearer <X public web bearer>
cookie: auth_token=<..>; ct0=<..>
x-csrf-token: <ct0>
x-twitter-auth-type: OAuth2Session
x-twitter-active-user: yes
x-twitter-client-language: en
referer: https://x.com/   origin: https://x.com   User-Agent: <tarayıcı UA>
```

`verifyAuth()` / `checkAuth()` `UserByScreenName` ile cookie'leri doğrular; dashboard sağ üstteki
"X bağlı" göstergesi bundan beslenir (`/api/health`).

**Cookie yenileme:** x.com'da tam çıkış-giriş → DevTools → Application → Cookies → `auth_token` +
`ct0` aynı anda → `.env`'de yalnız bu iki satır → `sudo systemctl restart x-automation` →
`npm run auth-test`.

## queryId çözümleme

X GraphQL endpoint'leri `https://x.com/i/api/graphql/<queryId>/<operationName>` şeklindedir ve
queryId'ler X'in web bundle'ıyla periyodik değişir. `resolveQueryIds()`:

1. `https://x.com/` HTML'inden `main.<hash>.js` bundle URL'ini bulur,
2. bundle içinde `queryId:"<id>",operationName:"<op>"` deseniyle her operasyonun güncel id'sini
   çeker,
3. bulunanları `FALLBACK_QUERY_IDS` üzerine yazar; bundle okunamazsa fallback kullanılır.

Sonuç process ömrü boyunca cache'lenir (`_queryIds`). Fallback tablosu: `SearchTimeline`,
`CreateTweet`, `DeleteTweet`, `TweetResultByRestId`, `UserByScreenName`. Bundle formatı kökten
değişirse `FALLBACK_QUERY_IDS` elle güncellenir.

## Arama — `searchTweets(keyword, { limit, product })`

- `SearchTimeline` **POST** ile çağrılır (GET 404 döner). Gövde `{ variables, features }`;
  `features` kanıtlanmış geniş feature setidir (eksik feature X'te 400 üretir).
- `product` `'Top' | 'Latest'`; sistem `Top` kullanır.
- `limit`'e ulaşana ya da cursor bitene kadar `bottom` cursor ile sayfalanır; `guard` sayacı
  sonsuz döngüyü keser.
- Keyword'e scraping-agent tarafından `min_faves:` ve `since:` operatörleri eklenmiş gelir.
  `-filter:replies` operatörü SearchTimeline'da 0 sonuç döndürdüğü için kullanılmaz; yanıt eleme
  kodda (`isReply`) yapılır.

`parseTweetResult` her tweeti şu nesneye çevirir:
```js
{
  id, text, author,                     // author = screen_name
  likes, retweets, replies, quotes,
  views,                                // t.views.count; yoksa 0
  isReply,                              // in_reply_to_status_id_str || in_reply_to_user_id_str
  createdAt,                            // X'in created_at string'i
  url,                                  // https://x.com/<author>/status/<id>
  media: string[],                      // aşağıda
}
```
`TweetWithVisibilityResults` sarmalı da açılır.

## Medya çıkarımı — `extractMedia(legacy)`

`legacy.extended_entities.media` (yoksa `entities.media`) içindeki her öğenin `media_url_https`
değeri alınır. Fotoğrafta bu görselin kendisi, video/GIF'te X'in poster karesidir. Giggle yalnız
görsel (jpeg/png/webp) kabul ettiği ve mp4 gönderilirse 422 `MEDIA_FETCH_FAILED` verdiği için
video URL'i hiç kullanılmaz. Dizi `tweets.tweet_media` (JSON) kolonunda saklanır ve Giggle
isteğinin `media` alanı olur; medyasız tweette `[]`.

## Reply postlama

`postReply(tweetId, text, imagePathOrBuffer)`:

1. **`uploadImage(input, mimeType)`** — chunked upload `https://upload.x.com/i/media/upload.json`:
   `INIT` (total_bytes, media_type, media_category=tweet_image) → `APPEND` (undici `FormData`,
   tek segment) → `FINALIZE` → gerekirse `STATUS` polling → `media_id_string`. Dosya yolu ya da
   Buffer alır; mime uzantıdan çıkarılır (`mimeFromPath`).
2. **`createReply(tweetId, text, mediaIds)`** — `CreateTweet` POST:
   `variables.tweet_text`, `variables.reply.in_reply_to_tweet_id`,
   `variables.media.media_entities=[{media_id, tagged_users:[]}]`. Dönen
   `data.create_tweet.tweet_results.result.rest_id` reply id'sidir; `posted_reply_id`'ye yazılır.

Gerçek post olduğu için `createReply` yalnız onaylanmış kayıtlar için ve içerik gösterilip açık onay
alınmadan test amaçlı çalıştırılmaz.

## X hata sınıflandırması (`graphqlPost` + `createReply`)

| Sinyal | Anlam | Bayrak | Davranış |
|---|---|---|---|
| HTTP 401/403 | cookie geçersiz/süresi dolmuş | `status` | retry yok, `failed`; cookie yenile |
| GraphQL **226** | "might be automated" — anti-otomasyon flag'i | `noRetry` | retry yok, `failed` |
| GraphQL **344** | hesabın X günlük gönderim kotası (~24 saat kayan) | `noRetry` | retry yok, `failed` |
| boş `tweet_results` `{}` | spam/duplicate throttle; dakikalar sonra aynı içerik geçer | `throttled` | hızlı retry yok; direct-post beklet-tekrar-dene, tükenirse sonraya zamanlar |
| 429 | rate limit | `status` | `withRetry` 1-2 sn arayla en fazla 2 tekrar |

Bunlar bizim `daily_post_limit` kontrolünden bağımsızdır; bizimki yerel kontroldür ve
`blocked_daily_limit` üretir, X'e istek bile atılmaz.

## Proxy

`.env`'de `X_PROXY_URL=http://user:pass@host:port` set edilirse `xfetch` tüm X isteklerini undici
`ProxyAgent` dispatcher'ı ile bu proxy'den geçirir. `fetch`, `FormData` ve `ProxyAgent` üçü de
`undici` paketinden import edilir; Node'un global `fetch`'i `ProxyAgent` ile uyumsuzdur
(`invalid onRequestStart method`). Giggle istekleri normal `fetch` kullandığı için etkilenmez.

- `proxyStatus()` → `{ enabled, host }`; orchestrator başlangıç logu ve `/api/health.proxy`.
- `checkExitIp()` → `{ proxied, direct }`; `npm run auth-test` ikisini yan yana basar, proxy
  çalışıyorsa farklı olmalı.
- Yönlendirme **post anında** belirlenir; DB'de IP/proxy bilgisi tutulmaz.
- Şu an `X_PROXY_URL` yorumda; X trafiği doğrudan VPS IP'sinden gidiyor.

## Test

```bash
npm run auth-test     # proxy durumu + çıkış IP + cookie doğrulama + küçük bir arama
```
