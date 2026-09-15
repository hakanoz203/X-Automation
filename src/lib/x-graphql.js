/**
 * Minimal X (Twitter) GraphQL client — kendi implementasyonumuz.
 *
 * Neden: XActions (eskimiş queryId → 404) ve agent-twitter-client (bozuk guest-token
 * auth akışı → 401 code 32) bu ortamda çalışmadı. Ham authenticated GraphQL istekleri
 * ise cookie'lerle SORUNSUZ çalışıyor (bkz. docs/xactions-notes.md).
 *
 * Yaklaşım:
 *  - queryId'ler X'in canlı web bundle'ından (main.<hash>.js) dinamik çekilir → hep güncel.
 *  - Auth: auth_token + ct0 cookie + bearer + x-csrf-token (X'in web app'i gibi).
 *  - SearchTimeline artık POST endpoint'i (GET 404 verir).
 */
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
// fetch + FormData'yı undici'den alıyoruz (Node'un iç undici'siyle DEĞİL) ki ProxyAgent
// dispatcher'ı ve FormData gövdesi aynı undici sürümünden gelsin — aksi halde iki farklı
// undici karışır ve "invalid onRequestStart method" gibi sürüm-uyuşmazlığı hataları çıkar.
import { fetch as undiciFetch, FormData, ProxyAgent } from 'undici';

/**
 * Proxy: TÜM X istekleri buradan (xfetch) geçer. `.env`'de X_PROXY_URL set edilirse
 * (static residential ISP proxy) X trafiği o proxy üzerinden gider; OpenAI/fal.ai
 * istekleri ETKİLENMEZ (onlar kendi client'larında normal fetch kullanır).
 * Format: http://kullanici:sifre@host:port  (veya https://, socks desteklenmez).
 * X_PROXY_URL yoksa sistem eskisi gibi doğrudan sunucu IP'sinden çalışır.
 */
const PROXY_URL = process.env.X_PROXY_URL?.trim() || null;
const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : null;

/**
 * undici fetch + (varsa) proxy dispatcher enjekte eden sarmalayıcı.
 * Her iki dalda da undici fetch kullanılır — böylece undici FormData gövdesiyle tutarlı olur.
 */
function xfetch(url, opts = {}) {
  return proxyDispatcher
    ? undiciFetch(url, { ...opts, dispatcher: proxyDispatcher })
    : undiciFetch(url, opts);
}

/**
 * Proxy doğrulama: X isteklerinin (xfetch) çıkış IP'si ile doğrudan (proxysiz) çıkış
 * IP'sini döner. Proxy doğru çalışıyorsa `proxied` = residential IP, `direct` = VPS IP
 * ve ikisi FARKLI olmalı. Harici bir IP echo servisi kullanır (sadece tanı amaçlı).
 */
export async function checkExitIp() {
  const url = 'https://api.ipify.org?format=json';
  const out = { proxied: null, direct: null };
  try {
    out.proxied = (await (await xfetch(url)).json()).ip;
  } catch (e) {
    out.proxied = `hata: ${e.message}`;
  }
  try {
    out.direct = (await (await fetch(url)).json()).ip;
  } catch (e) {
    out.direct = `hata: ${e.message}`;
  }
  return out;
}

/** Proxy aktif mi? (log/health için) */
export function proxyStatus() {
  if (!PROXY_URL) return { enabled: false };
  let host = null;
  try {
    host = new URL(PROXY_URL).host;
  } catch {
    /* geçersiz URL — yine de enabled say, hata istek anında görünür */
  }
  return { enabled: true, host };
}

const BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Bundle'dan çekilemezse kullanılacak son-bilinen-güncel queryId'ler (2026-07).
const FALLBACK_QUERY_IDS = {
  SearchTimeline: 'Bcw3RzK-PatNAmbnw54hFw',
  CreateTweet: 'R5EPiGHgSqbTYFyozd-gFw',
  DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ',
  TweetResultByRestId: '-4_LMahNlI4MuLJ-EAFEog',
  UserByScreenName: 'G3KGOASz96M-Qu0nwmGXNg',
};

// SearchTimeline için kanıtlanmış geniş feature seti.
const SEARCH_FEATURES = {
  rweb_video_screen_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// CreateTweet için feature seti (X eksik olanı "cannot be null" ile bildirir; gerekirse eklenir).
const TWEET_FEATURES = {
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: true,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  articles_preview_enabled: true,
  rweb_video_screen_enabled: false,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
};

// --- Kimlik ----------------------------------------------------------------
function cookieString() {
  const at = process.env.XACTIONS_AUTH_TOKEN;
  const ct = process.env.XACTIONS_CT0;
  if (!at) throw new Error('XACTIONS_AUTH_TOKEN tanımlı değil');
  if (!ct) throw new Error('XACTIONS_CT0 tanımlı değil');
  return { at, ct, cookie: `auth_token=${at}; ct0=${ct}` };
}

function authHeaders(extra = {}) {
  const { ct, cookie } = cookieString();
  return {
    authorization: 'Bearer ' + decodeURIComponent(BEARER),
    cookie,
    'x-csrf-token': ct,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    referer: 'https://x.com/',
    origin: 'https://x.com',
    'User-Agent': UA,
    ...extra,
  };
}

// --- queryId çözümleyici (X bundle'ından) ----------------------------------
let _queryIds = null;

async function resolveQueryIds() {
  if (_queryIds) return _queryIds;
  try {
    const html = await (await xfetch('https://x.com/', { headers: { 'User-Agent': UA } })).text();
    const jsUrls = [
      ...html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[a-zA-Z0-9._/-]*main\.[a-f0-9]+\.js/g),
    ].map((m) => m[0]);
    const mainUrl = jsUrls[0];
    if (!mainUrl) throw new Error('main.js bulunamadı');
    const main = await (await xfetch(mainUrl, { headers: { 'User-Agent': UA } })).text();
    const ids = {};
    for (const op of Object.keys(FALLBACK_QUERY_IDS)) {
      const m = main.match(new RegExp('queryId:"([A-Za-z0-9_-]+)",operationName:"' + op + '"'));
      if (m) ids[op] = m[1];
    }
    _queryIds = { ...FALLBACK_QUERY_IDS, ...ids };
  } catch {
    _queryIds = { ...FALLBACK_QUERY_IDS };
  }
  return _queryIds;
}

async function queryId(op) {
  return (await resolveQueryIds())[op];
}

// --- GraphQL POST ----------------------------------------------------------
async function graphqlPost(op, variables, features) {
  const qid = await queryId(op);
  const url = `https://x.com/i/api/graphql/${qid}/${op}`;
  const res = await xfetch(url, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(features ? { variables, features } : { variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${op} HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${op} JSON parse hatası: ${text.slice(0, 200)}`);
  }
  if (json.errors?.length) {
    const first = json.errors[0];
    const err = new Error(`${op} GraphQL: ${first.message}`);
    err.graphqlErrors = json.errors;
    err.graphqlCode = first.code;
    // 226 = "might be automated" (anti-otomasyon flag'i), 344 = hesabın günlük X gönderim kotası.
    // İkisi de saniyeler içinde geçmez → hızlı retry hem işe yaramaz hem otomasyon/spam sinyalini
    // güçlendirir. withRetry bunları görünce hemen vazgeçer (üst katman: zamanlayıp sonra dener).
    if (
      first.code === 226 ||
      first.code === 344 ||
      /might be automated|daily limit for sending/i.test(first.message || '')
    ) {
      err.noRetry = true;
    }
    throw err;
  }
  return json;
}

// --- Tweet parse -----------------------------------------------------------
function parseTweetResult(tr) {
  if (!tr) return null;
  const t = tr.__typename === 'TweetWithVisibilityResults' ? tr.tweet : tr;
  const lg = t?.legacy;
  if (!lg) return null;
  const ur = t?.core?.user_results?.result;
  const username = ur?.core?.screen_name ?? ur?.legacy?.screen_name ?? null;
  const id = t.rest_id ?? lg.id_str;
  return {
    id,
    text: lg.full_text ?? '',
    author: username,
    likes: lg.favorite_count ?? 0,
    retweets: lg.retweet_count ?? 0,
    replies: lg.reply_count ?? 0,
    quotes: lg.quote_count ?? 0,
    views: Number(t?.views?.count ?? 0) || 0, // görüntülenme (bazı tweetlerde 0/yok olabilir)
    isReply: !!(lg.in_reply_to_status_id_str || lg.in_reply_to_user_id_str), // başka tweete yanıt mı
    createdAt: lg.created_at ?? null,
    url: username && id ? `https://x.com/${username}/status/${id}` : null,
    media: extractMedia(lg),
  };
}

/**
 * Tweet legacy'sinden medya URL'lerini çıkarır (Giggle'a gönderilecek).
 * ÖNEMLİ: Giggle yalnız GÖRSEL kabul eder (jpeg/png/webp) — video mp4 gönderilirse 422
 * "MEDIA_FETCH_FAILED" verir. Bu yüzden HER medya tipi için `media_url_https` (fotoğrafta
 * görselin kendisi, video/GIF'te X'in poster/kapak karesi — hepsi görsel) gönderilir.
 * @returns {string[]}
 */
function extractMedia(lg) {
  const items = lg?.extended_entities?.media ?? lg?.entities?.media ?? [];
  const out = [];
  for (const m of items) {
    if (m?.media_url_https) out.push(m.media_url_https); // foto = görsel; video/gif = poster görseli
  }
  return out.filter(Boolean);
}

/**
 * Keyword ile tweet ara (SearchTimeline, POST). Cursor ile pagination.
 * @param {string} keyword
 * @param {object} [opts] { limit=100, product='Top' }
 * @returns {Promise<Array>}
 */
export async function searchTweets(keyword, { limit = 100, product = 'Top' } = {}) {
  const out = [];
  let cursor = null;
  let guard = 0;
  while (out.length < limit && guard < 20) {
    guard++;
    const variables = {
      rawQuery: keyword,
      count: 20,
      querySource: 'typed_query',
      product,
      ...(cursor ? { cursor } : {}),
    };
    const json = await graphqlPost('SearchTimeline', variables, SEARCH_FEATURES);
    const insts = json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions ?? [];
    let newCursor = null;
    let added = 0;
    for (const ins of insts) {
      for (const e of ins.entries ?? []) {
        if (e.entryId?.startsWith('cursor-bottom')) newCursor = e.content?.value;
        const parsed = parseTweetResult(e?.content?.itemContent?.tweet_results?.result);
        if (parsed?.id) {
          out.push(parsed);
          added++;
          if (out.length >= limit) break;
        }
      }
      if (out.length >= limit) break;
    }
    if (!newCursor || added === 0) break;
    cursor = newCursor;
  }
  return out.slice(0, limit);
}

// --- Medya yükleme (chunked, upload.x.com) ---------------------------------
const UPLOAD_URL = 'https://upload.x.com/i/media/upload.json';

function mimeFromPath(p) {
  const ext = extname(p).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

/**
 * Görseli X'e yükler, media_id_string döndürür.
 * @param {string|Buffer} input  dosya yolu veya Buffer
 * @param {string} [mimeType]
 * @returns {Promise<string>} mediaId
 */
export async function uploadImage(input, mimeType) {
  let buffer, mime;
  if (Buffer.isBuffer(input)) {
    buffer = input;
    mime = mimeType || 'image/png';
  } else {
    buffer = await readFile(input);
    mime = mimeType || mimeFromPath(input);
  }

  // INIT
  const initBody = new URLSearchParams({
    command: 'INIT',
    total_bytes: String(buffer.length),
    media_type: mime,
    media_category: 'tweet_image',
  });
  const initRes = await xfetch(UPLOAD_URL, { method: 'POST', headers: authHeaders({ 'content-type': 'application/x-www-form-urlencoded' }), body: initBody });
  if (!initRes.ok) throw new Error(`media INIT HTTP ${initRes.status}: ${(await initRes.text()).slice(0, 150)}`);
  const mediaId = (await initRes.json()).media_id_string;

  // APPEND (tek segment — görseller küçük)
  const fd = new FormData();
  fd.append('command', 'APPEND');
  fd.append('media_id', mediaId);
  fd.append('segment_index', '0');
  fd.append('media', new Blob([buffer], { type: mime }));
  const appRes = await xfetch(UPLOAD_URL, { method: 'POST', headers: authHeaders(), body: fd });
  if (!appRes.ok) throw new Error(`media APPEND HTTP ${appRes.status}: ${(await appRes.text()).slice(0, 150)}`);

  // FINALIZE
  const finBody = new URLSearchParams({ command: 'FINALIZE', media_id: mediaId });
  const finRes = await xfetch(UPLOAD_URL, { method: 'POST', headers: authHeaders({ 'content-type': 'application/x-www-form-urlencoded' }), body: finBody });
  if (!finRes.ok) throw new Error(`media FINALIZE HTTP ${finRes.status}: ${(await finRes.text()).slice(0, 150)}`);
  const finJson = await finRes.json().catch(() => ({}));

  // İşleme gerekiyorsa (nadiren görsel için) STATUS ile bekle
  let info = finJson.processing_info;
  let tries = 0;
  while (info && info.state !== 'succeeded' && info.state !== 'failed' && tries < 10) {
    await new Promise((r) => setTimeout(r, (info.check_after_secs ?? 1) * 1000));
    const st = await xfetch(`${UPLOAD_URL}?command=STATUS&media_id=${mediaId}`, { headers: authHeaders() });
    info = (await st.json().catch(() => ({}))).processing_info;
    tries++;
  }
  if (info?.state === 'failed') throw new Error(`media işleme başarısız: ${JSON.stringify(info.error || {})}`);

  return mediaId;
}

/**
 * Bir tweete metin (+ medya) reply postlar (CreateTweet).
 * @param {string} tweetId
 * @param {string} text
 * @param {string[]} [mediaIds]
 * @returns {Promise<{replyId:string|null}>}
 */
export async function createReply(tweetId, text, mediaIds = []) {
  const variables = {
    tweet_text: text,
    reply: { in_reply_to_tweet_id: tweetId, exclude_reply_user_ids: [] },
    dark_request: false,
    media: {
      media_entities: mediaIds.map((id) => ({ media_id: id, tagged_users: [] })),
      possibly_sensitive: false,
    },
    semantic_annotation_ids: [],
  };
  const json = await graphqlPost('CreateTweet', variables, TWEET_FEATURES);
  const result = json?.data?.create_tweet?.tweet_results?.result;
  const replyId = result?.rest_id ?? result?.tweet?.rest_id ?? null;
  if (!replyId) {
    // Boş tweet_results = X tweeti sessizce düşürdü (genelde spam/tekrar throttle:
    // aynı tweete kısa sürede çok reply, ya da duplike içerik). Hata olarak işaretle
    // ki post-agent yanlışlıkla 'posted' demesin (spec §4.4).
    // KRİTİK: bu throttle saniyeler içinde kalkmaz; hızlı retry hem başarısız olur hem duplicate/
    // spam sinyalini büyütüp throttle'ı "yapışkan" yapar → `throttled` ile hızlı-retry'ı kapat.
    const err = new Error(
      `CreateTweet boş sonuç döndürdü (X spam/tekrar throttle olabilir): ${JSON.stringify(json).slice(0, 150)}`
    );
    err.throttled = true;
    throw err;
  }
  return { replyId };
}

/**
 * Bir tweeti/reply'i siler (DeleteTweet). Test reply'lerini temizlemek için.
 * @param {string} tweetId
 */
export async function deleteTweet(tweetId) {
  await graphqlPost('DeleteTweet', { tweet_id: tweetId, dark_request: false }, null);
  return { ok: true };
}

/** Cookie'lerin geçerli olduğunu doğrular (hafif bir GraphQL çağrısıyla). */
export async function verifyAuth() {
  try {
    // UserByScreenName GET — hafif, auth doğrular
    const qid = await queryId('UserByScreenName');
    const variables = encodeURIComponent(JSON.stringify({ screen_name: 'x' }));
    const features = encodeURIComponent(
      JSON.stringify({
        hidden_profile_subscriptions_enabled: true,
        rweb_tipjar_consumption_enabled: true,
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        highlights_tweets_tab_ui_enabled: true,
        responsive_web_twitter_article_notes_tab_enabled: true,
        subscriptions_feature_can_gift_premium: true,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
      })
    );
    const res = await xfetch(
      `https://x.com/i/api/graphql/${qid}/UserByScreenName?variables=${variables}&features=${features}`,
      { headers: authHeaders() }
    );
    if (res.status === 200) return { ok: true, reason: 'ok' };
    return { ok: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
