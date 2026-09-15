// Dashboard frontend (vanilla). REST API ile konuşur; iş mantığı sunucuda.

const $ = (s) => document.querySelector(s);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const post = (url, body) =>
  api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const imgSrc = (t) =>
  t.generated_image_path ? '/images/' + t.generated_image_path.split('/').pop() : t.generated_image_url || '';

// Post anında sunucu tanıtım linklerini temizliyorsa (strip_promo_links), dashboard'da da
// gösterimi aynı yapalım ki "görünen == postlanan" olsun. Bayrak /api/health'ten gelir.
let stripPromoOn = false;
function stripPromoLinksView(text) {
  if (!text) return text;
  let s = String(text);
  s = s.replace(/\n*\s*Download Giggle[\s\S]*$/i, '');
  s = s.replace(/^\s*(App Store|Google Play)\s*:.*$/gim, '');
  s = s.replace(/https?:\/\/(?:apps\.apple\.com|play\.google\.com)\/\S*/gi, '');
  return s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
const replyForDisplay = (text) => (stripPromoOn ? stripPromoLinksView(text) : text);

// ── Zaman ────────────────────────────────────────────────────────────────────
const fmtWhen = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('tr-TR', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};
const fmtClock = (iso) =>
  new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

/** "1s 24dk sonra" / "12dk önce" — mutlak saatin yanında bağlam verir. */
function fmtRelative(iso) {
  if (!iso) return '';
  const diffMin = Math.round((new Date(iso) - Date.now()) / 60000);
  const abs = Math.abs(diffMin);
  const suffix = diffMin >= 0 ? 'sonra' : 'önce';
  if (abs < 1) return 'şimdi';
  if (abs < 60) return `${abs}dk ${suffix}`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h < 24) return `${h}s${m ? ` ${m}dk` : ''} ${suffix}`;
  return `${Math.floor(h / 24)}g ${suffix}`;
}

/** Bugün / Yarın / tarih — gün başlıkları için. */
function dayLabel(iso) {
  if (!iso) return 'Zamanı belirsiz';
  const d = new Date(iso);
  const today = new Date();
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(d) - startOf(today)) / 86400000);
  if (days === 0) return 'Bugün';
  if (days === 1) return 'Yarın';
  if (days === -1) return 'Dün';
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric' });
}

// ── Sistem dili → insan dili ─────────────────────────────────────────────────
const STATUS = {
  generating:         { label: 'Üretiliyor',  cls: 's-generating' },
  scheduled:          { label: 'Planlandı',   cls: 's-scheduled' },
  ready_to_post:      { label: 'Sıraya girdi', cls: 's-ready' },
  posted:             { label: 'Postlandı',   cls: 's-posted' },
  failed:             { label: 'Başarısız',   cls: 's-failed' },
  blocked_daily_limit:{ label: 'Limit doldu', cls: 's-blocked' },
  cancelled:          { label: 'İptal edildi', cls: 's-cancelled' },
};
const statusOf = (s) => STATUS[s] || { label: s, cls: '' };

/** Ham X/GraphQL hatasını operatörün anlayacağı tek cümleye çevirir. */
function humanError(raw) {
  const m = String(raw || '');
  if (/daily limit for sending Tweets/i.test(m))
    return 'X, hesabın günlük gönderim limitine takıldığını söylüyor. Bu bizim kotamız değil, X’in hesaba uyguladığı kısıt.';
  if (/might be automated/i.test(m))
    return 'X isteği otomasyon olarak işaretledi. Post aralığını artırıp bir süre beklemek gerekiyor.';
  if (/boş sonuç döndürdü/i.test(m))
    return 'X reply’ı sessizce düşürdü — genelde aynı tweete tekrar yanıt ya da spam koruması.';
  if (/401|403|auth/i.test(m))
    return 'X oturumu geçersiz. auth_token ve ct0 çerezlerini yenilemen gerekiyor.';
  if (/rate.?limit|429/i.test(m))
    return 'X hız sınırına takıldı. Bir süre sonra yeniden dene.';
  return 'Post başarısız oldu.';
}

// ── Bildirimler ──────────────────────────────────────────────────────────────
function toast(message, kind = 'info', durationMs = 3600) {
  const t = el('div', `toast t-${kind}`);
  t.innerHTML = `<i></i><span>${esc(message)}</span>`;
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('is-leaving');
    setTimeout(() => t.remove(), 220);
  }, durationMs);
}

// ── Onay modalı (geri alınamaz aksiyonlar) ───────────────────────────────────
let modalResolve = null;
function confirmAction({ title, body, confirmLabel }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modalConfirm').textContent = confirmLabel;
  $('#modalBackdrop').hidden = false;
  $('#modalConfirm').focus();
  return new Promise((resolve) => (modalResolve = resolve));
}
function closeModal(result) {
  $('#modalBackdrop').hidden = true;
  if (modalResolve) modalResolve(result);
  modalResolve = null;
}
$('#modalConfirm').onclick = () => closeModal(true);
$('#modalCancel').onclick = () => closeModal(false);
$('#modalBackdrop').onclick = (e) => { if (e.target === $('#modalBackdrop')) closeModal(false); };
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modalBackdrop').hidden) closeModal(false);
});

// ── Sekmeler ─────────────────────────────────────────────────────────────────
const LOADERS = { queue: loadQueue, schedule: loadSchedule, accounts: loadAccounts, settings: loadSettings };
let activeTab = 'scrape';

function selectTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  $('#tab-' + name).classList.add('active');
  activeTab = name;
  localStorage.setItem('activeTab', name);
  LOADERS[name]?.();
}
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.onclick = () => selectTab(btn.dataset.tab);
});

// ── Sağlık şeridi ────────────────────────────────────────────────────────────
async function loadHealth() {
  const strip = $('#health');
  try {
    const h = await api('/api/health');
    stripPromoOn = !!h.stripPromoLinks;
    const used = h.postedToday;
    // Şeritte tavan (daily_post_limit) gösterilir; o günün jitter'lı etkin limiti tooltip'te.
    const limit = h.dailyPostLimitBase ?? h.dailyPostLimit;
    const effective = h.dailyPostLimit;
    const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

    const auth = h.auth.ok
      ? `<div class="pill is-ok"><i></i>X bağlı</div>`
      : `<div class="pill is-bad"><i></i>X auth: ${esc(h.auth.reason)}</div>`;

    const proxy = h.proxy?.enabled
      ? `<div class="pill is-info"><i></i>Proxy <span class="mono">${esc(h.proxy.host || 'aktif')}</span></div>`
      : `<div class="pill is-warn"><i></i>Proxy kapalı</div>`;

    strip.innerHTML = `
      ${auth}
      ${proxy}
      <div class="pill quota" title="Bugünkü etkin limit: ${effective} (tavan ${limit} − günlük rastgele jitter)">
        <div class="quota-row">
          <span class="quota-label">Bugün</span>
          <span class="quota-nums">${used}<span>/${limit}</span></span>
        </div>
        <div class="meter ${used >= effective ? 'is-full' : ''}"><i style="width:${pct}%"></i></div>
      </div>`;

    const badge = $('#queueCount');
    badge.textContent = h.counts.pending_approval;
    badge.hidden = h.counts.pending_approval === 0;
  } catch (e) {
    strip.innerHTML = `<div class="pill is-bad"><i></i>Konsol sunucuya ulaşamıyor</div>`;
  }
}

// ── Scrape ───────────────────────────────────────────────────────────────────
$('#scrapeBtn').onclick = async () => {
  const keywords = $('#keywords').value.trim();
  if (!keywords) { toast('Önce bir keyword yaz.', 'bad'); return; }

  const btn = $('#scrapeBtn');
  const box = $('#scrapeResult');
  btn.disabled = true;
  btn.textContent = 'Aranıyor…';
  box.hidden = false;
  box.innerHTML = `<div class="scrape-foot">Tweetler aranıyor ve cevap metinleri üretiliyor. Bu bir iki dakika sürebilir.</div>`;

  try {
    const { summary } = await post('/api/scrape', { keywords });
    box.innerHTML = '';
    for (const [kw, s] of Object.entries(summary.perKeyword)) {
      const row = el('div', 'scrape-row' + (s.error ? ' is-error' : ''));
      row.innerHTML = `
        <div class="scrape-kw">${esc(kw)}</div>
        <div class="scrape-stats">${
          s.error
            ? `<span>${esc(s.error)}</span>`
            : `<span><b>${s.found}</b> bulundu</span><span><b>${s.inserted}</b> yeni</span><span><b>${s.filtered ?? 0}</b> kalite-elendi</span><span><b>${s.skipped}</b> atlandı</span>`
        }</div>`;
      box.appendChild(row);
    }
    const foot = el('div', 'scrape-foot');
    foot.textContent = summary.total.inserted
      ? `${summary.total.inserted} yeni tweet onay kuyruğuna alınıyor (kalite filtresinden geçenler). Onayladıklarında Giggle cevabı üretilir — Onay Kuyruğu'na bak.`
      : 'Yeni tweet yok. Bulunanların hepsi ya kalite filtresine takıldı ya daha önce işlendi.';
    box.appendChild(foot);
    loadHealth();
  } catch (e) {
    box.innerHTML = `<div class="scrape-foot">Scrape başarısız: ${esc(e.message)}</div>`;
    toast('Scrape başarısız oldu.', 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Scrape et';
  }
};

// ── Onay kuyruğu ─────────────────────────────────────────────────────────────
function skeletons(list, n = 3) {
  list.innerHTML = '';
  for (let i = 0; i < n; i++) list.appendChild(el('div', 'skeleton skeleton-card'));
}

function emptyState(icon, title, sub) {
  return `<div class="empty">
    <div class="empty-icon">${icon}</div>
    <div class="empty-title">${esc(title)}</div>
    <div class="empty-sub">${esc(sub)}</div>
  </div>`;
}

const removeCard = (card) => {
  card.classList.add('is-leaving');
  setTimeout(() => card.remove(), 200);
};

/** Orijinal tweetin medya URL'lerini (JSON dizi) güvenle parse eder. */
function parseTweetMedia(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Onay kuyruğu / hedef tweet için medya önizlemesi (ilk medya).
 * Not: tweet_media her zaman GÖRSEL URL'i tutar — fotoğraf tweetinde görselin kendisi,
 * video/GIF tweetinde X'in poster/kapak karesidir (Giggle yalnız görsel kabul ettiği için
 * x-graphql media çıkarımı hep `media_url_https` kullanır). Bu yüzden hep <img> olarak gösterilir.
 */
function origMediaPreview(media) {
  if (!media.length) {
    return `<div class="media-note"><span>💬</span>Bu tweette medya yok</div>`;
  }
  const first = media[0];
  const more = media.length > 1 ? `<span class="media-more">+${media.length - 1}</span>` : '';
  return `<img src="${esc(first)}" alt="Tweet görseli" loading="lazy" />${more}`;
}

async function loadQueue() {
  const list = $('#queueList');
  skeletons(list);

  let items;
  try {
    items = await api('/api/queue');
  } catch (e) {
    list.innerHTML = emptyState('⚠', 'Kuyruk yüklenemedi', e.message);
    return;
  }

  if (!items.length) {
    list.innerHTML = emptyState('✓', 'Onay bekleyen tweet yok',
      'Keyword & Scrape sekmesinden tweet çektiğinde en yüksek etkileşimliler burada onayına sunulur.');
    return;
  }

  list.innerHTML = '';
  for (const t of items) {
    const card = el('div', 'card');
    const media = parseTweetMedia(t.tweet_media);

    // Onay kuyruğunda YALNIZ hedef tweet gösterilir. Cevap metni + çizgi-roman görseli,
    // onaydan sonra Giggle ile üretilir (bu yüzden burada gösterilmez).
    card.innerHTML = `
      <div class="body">
        <div class="col">
          <div class="orig">
            <div class="meta">
              <span class="author">@${esc(t.author)}</span>
              <span class="stat">👁 ${t.views ?? 0}</span>
              <span class="stat">❤ ${t.likes}</span>
              <span class="stat">🔁 ${t.retweets}</span>
              <span class="stat">💬 ${t.replies}</span>
              <span class="stat score">skor ${(t.score ?? 0).toFixed(1)}</span>
              ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">tweeti aç ↗</a>` : ''}
            </div>
            <div class="orig-text">${esc(t.text)}</div>
          </div>
          <div class="actions">
            <button class="btn-ok approve">Onayla</button>
            <button class="btn-primary postnow">Hemen Paylaş</button>
            <button class="btn-quiet-danger reject">Reddet</button>
          </div>
          <div class="approve-note micro">Onayla → Giggle cevabı üretilip 24 saate planlanır. Hemen Paylaş → üretilip zamanlamadan anında postlanır.</div>
        </div>
        <div class="media">${origMediaPreview(media)}</div>
      </div>`;

    card.querySelector('.approve').onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Gönderiliyor…';
      try {
        await post('/api/approve', { id: t.id });
        removeCard(card);
        toast('Onaylandı — Giggle çizgi-romanı hazırlıyor, bitince planlanacak (Schedule sekmesi).', 'ok');
        loadHealth();
        if (!list.querySelector('.card:not(.is-leaving)')) setTimeout(loadQueue, 220);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Onayla';
        toast(`Onaylanamadı: ${err.message}`, 'bad');
      }
    };

    // Hemen Paylaş: zamanlamadan anında postlar — geri alınamaz, onay iste.
    card.querySelector('.postnow').onclick = async () => {
      const ok = await confirmAction({
        title: 'Zamanlamadan hemen paylaş',
        body: `@${t.author} adlı tweete Giggle çizgi-roman cevabı üretilip HEMEN X'e postlanacak. Bu işlem geri alınamaz.`,
        confirmLabel: 'Hemen paylaş',
      });
      if (!ok) return;
      try {
        await post('/api/post-now', { id: t.id });
        removeCard(card);
        toast('Sıraya alındı — üretilip paylaşılacak (art arda olanlar ban önlemi için aralıklı). Schedule sekmesinden takip et.', 'ok');
        loadHealth();
        if (!list.querySelector('.card:not(.is-leaving)')) setTimeout(loadQueue, 220);
      } catch (err) {
        toast(`Paylaşılamadı: ${err.message}`, 'bad');
      }
    };

    // Reddetmek kalıcıdır (dedup hafızasına yazılır) — onay iste
    card.querySelector('.reject').onclick = async () => {
      const ok = await confirmAction({
        title: 'Bu tweeti reddet',
        body: `@${t.author} adlı hesabın bu tweeti bir daha asla önerilmeyecek. Geri alınamaz.`,
        confirmLabel: 'Reddet',
      });
      if (!ok) return;
      try {
        await post('/api/reject', { id: t.id });
        removeCard(card);
        toast('Reddedildi — bir daha önerilmeyecek.', 'info');
        loadHealth();
        if (!list.querySelector('.card:not(.is-leaving)')) setTimeout(loadQueue, 220);
      } catch (err) {
        toast(`Reddedilemedi: ${err.message}`, 'bad');
      }
    };

    list.appendChild(card);
  }
}

// ── Schedule ─────────────────────────────────────────────────────────────────
const FILTERS = [
  { key: 'all',       label: 'Tümü',      match: () => true },
  { key: 'upcoming',  label: 'Planlı',    match: (t) => t.status === 'scheduled' || t.status === 'ready_to_post' || t.status === 'generating' },
  { key: 'posted',    label: 'Postlandı', match: (t) => t.status === 'posted' },
  { key: 'failed',    label: 'Başarısız', match: (t) => t.status === 'failed' || t.status === 'blocked_daily_limit' },
];
let activeFilter = 'all';
let scheduleItems = [];

/** İmza öğesi: bugünün 00:00–24:00'ü tek bir eksen üzerinde. */
function renderRail(items) {
  const rail = $('#rail');
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  const pos = (ms) => ((ms - dayStart) / DAY) * 100;

  const todays = items.filter((t) => {
    if (!t.scheduled_at) return false;
    const ms = new Date(t.scheduled_at).getTime();
    return ms >= dayStart && ms < dayStart + DAY;
  });

  rail.innerHTML = '';
  for (let h = 0; h <= 24; h += 3) {
    const tick = el('div', 'rail-hour mono');
    tick.style.left = `${(h / 24) * 100}%`;
    tick.textContent = String(h).padStart(2, '0');
    rail.appendChild(tick);
  }
  for (const t of todays) {
    const ms = new Date(t.scheduled_at).getTime();
    const dot = el('div', `rail-item ${statusOf(t.status).cls}`);
    dot.style.left = `${pos(ms)}%`;
    dot.title = `${fmtClock(t.scheduled_at)} · @${t.author} · ${statusOf(t.status).label}`;
    rail.appendChild(dot);
  }
  const nowLine = el('div', 'rail-now');
  nowLine.style.left = `${pos(now.getTime())}%`;
  rail.appendChild(nowLine);

  const planned = todays.filter((t) => t.status === 'scheduled' || t.status === 'ready_to_post').length;
  const done = todays.filter((t) => t.status === 'posted').length;
  $('#railCaption').textContent = todays.length
    ? `${done} postlandı · ${planned} sırada`
    : 'Bugün için planlanmış post yok';

  const next = items
    .filter((t) => (t.status === 'scheduled' || t.status === 'ready_to_post') && t.scheduled_at)
    .map((t) => new Date(t.scheduled_at))
    .filter((d) => d > now)
    .sort((a, b) => a - b)[0];

  $('#nextPost').innerHTML = next
    ? `<span class="micro">Sonraki post</span><strong>${fmtClock(next.toISOString())}</strong>${esc(fmtRelative(next.toISOString()))}`
    : `<span class="micro">Sonraki post</span><strong>—</strong>kuyruk boş`;
}

function renderFilters() {
  const box = $('#scheduleFilters');
  box.innerHTML = '';
  for (const f of FILTERS) {
    const n = scheduleItems.filter(f.match).length;
    const chip = el('button', 'chip' + (f.key === activeFilter ? ' active' : ''));
    chip.innerHTML = `${esc(f.label)}<span class="n">${n}</span>`;
    chip.onclick = () => { activeFilter = f.key; renderFilters(); renderScheduleList(); };
    box.appendChild(chip);
  }
}

function scheduleCard(t) {
  const card = el('div', 'card');
  const img = imgSrc(t);
  const st = statusOf(t.status);
  const postedLink = t.posted_reply_id && t.author
    ? `<a href="https://x.com/${esc(t.author)}/status/${esc(t.posted_reply_id)}" target="_blank" rel="noopener">postlanan reply ↗</a>`
    : '';
  const isRetryable = t.status === 'failed' || t.status === 'blocked_daily_limit';

  card.innerHTML = `
    <div class="card-top">
      <div>
        <span class="when">${t.scheduled_at ? fmtClock(t.scheduled_at) : '—'}</span>
        <span class="when-rel">${esc(t.scheduled_at ? fmtRelative(t.scheduled_at) : 'zamanı yok')}</span>
      </div>
      <span class="status ${st.cls}"><i></i>${esc(st.label)}</span>
    </div>

    <div class="orig">
      <div class="meta">
        <span class="author">@${esc(t.author)}</span>
        ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">orijinal ↗</a>` : ''}
        ${postedLink}
      </div>
      <div class="orig-text">${esc(t.text)}</div>
    </div>

    <div class="body">
      <div class="col">
        <span class="micro">Cevap${stripPromoOn ? ' <span class="micro" style="opacity:.7">(tanıtım linkleri postta kaldırılıyor)</span>' : ''}</span>
        <div class="reply-text">${esc(replyForDisplay(t.generated_reply_text))}</div>
        ${t.status === 'scheduled' ? `<div class="actions"><button class="btn-ghost btn-sm cancel">İptal et</button></div>` : ''}
        ${isRetryable ? `<div class="actions"><button class="btn-ghost btn-sm retry">Yeniden dene</button></div>` : ''}
      </div>
      ${img ? `<div class="media"><img src="${esc(img)}" alt="Üretilen görsel" loading="lazy" /></div>` : ''}
    </div>

    ${t.error_message ? `
      <div class="err">
        <div class="err-title">${esc(humanError(t.error_message))}</div>
        <details>
          <summary>X'in döndürdüğü ham yanıt</summary>
          <pre>${esc(t.error_message)}</pre>
        </details>
      </div>` : ''}`;

  const cancelBtn = card.querySelector('.cancel');
  if (cancelBtn) cancelBtn.onclick = async () => {
    const ok = await confirmAction({
      title: 'Planlanmış postu iptal et',
      body: `Bu reply ${fmtWhen(t.scheduled_at)} tarihinde postlanacaktı. İptal edersen postlanmaz.`,
      confirmLabel: 'İptal et',
    });
    if (!ok) return;
    try {
      await post('/api/cancel', { id: t.id });
      toast('Post iptal edildi.', 'info');
      loadSchedule();
    } catch (e) { toast(`İptal edilemedi: ${e.message}`, 'bad'); }
  };

  const retryBtn = card.querySelector('.retry');
  if (retryBtn) retryBtn.onclick = async () => {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Planlanıyor…';
    try {
      await post('/api/retry', { id: t.id });
      toast('Yeniden planlandı — sıradaki uygun saate yerleştirildi.', 'ok');
      loadSchedule();
    } catch (e) {
      retryBtn.disabled = false;
      retryBtn.textContent = 'Yeniden dene';
      toast(`Yeniden denenemedi: ${e.message}`, 'bad');
    }
  };

  return card;
}

function renderScheduleList() {
  const list = $('#scheduleList');
  const filter = FILTERS.find((f) => f.key === activeFilter);
  const items = scheduleItems.filter(filter.match);

  if (!items.length) {
    list.innerHTML = emptyState('◷', 'Bu filtrede kayıt yok',
      activeFilter === 'all'
        ? 'Onay kuyruğundan bir cevap onayladığında burada planlanmış olarak görünür.'
        : 'Başka bir filtre dene.');
    return;
  }

  list.innerHTML = '';

  // "Başarısız" filtresinde toplu yeniden deneme butonu.
  if (activeFilter === 'failed' && items.length > 1) {
    const bar = el('div', 'bulk-bar');
    const btn = el('button', 'btn-primary btn-sm');
    btn.textContent = `Hepsini Yeniden Dene (${items.length})`;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Planlanıyor…';
      try {
        const r = await post('/api/retry-all', {});
        toast(`${r.total} kayıt yeniden denendi (${r.scheduled} planlandı, ${r.generating} üretiliyor).`, 'ok');
        loadSchedule();
      } catch (e) {
        btn.disabled = false;
        toast(`Yeniden denenemedi: ${e.message}`, 'bad');
      }
    };
    bar.appendChild(btn);
    list.appendChild(bar);
  }

  let lastDay = null;
  for (const t of items) {
    const day = dayLabel(t.scheduled_at);
    if (day !== lastDay) {
      const head = el('div', 'day-head');
      head.textContent = day;
      list.appendChild(head);
      lastDay = day;
    }
    list.appendChild(scheduleCard(t));
  }
}

async function loadSchedule() {
  const list = $('#scheduleList');
  if (!list.children.length) skeletons(list, 2);
  try {
    scheduleItems = await api('/api/schedule');
  } catch (e) {
    list.innerHTML = emptyState('⚠', 'Schedule yüklenemedi', e.message);
    return;
  }
  renderRail(scheduleItems);
  renderFilters();
  renderScheduleList();
}

// ── Hesaplar (E: reply kayıt defteri) ────────────────────────────────────────
async function loadAccounts() {
  const list = $('#accountsList');
  const info = $('#accountsInfo');
  let data;
  try {
    data = await api('/api/author-replies');
  } catch (e) {
    list.innerHTML = emptyState('⚠', 'Kayıt defteri yüklenemedi', e.message);
    return;
  }
  const started = data.windowStart ? fmtWhen(data.windowStart) : '—';
  info.textContent =
    `Son ${data.windowDays} günlük pencere (başlangıç: ${started}). Bir hesaba ${data.maxReplies} reply'a ulaşınca, o hesabın yeni tweetleri scrape aşamasında elenir. Pencere ${data.windowDays} günde bir sıfırlanır.`;

  const book = data.book || [];
  if (!book.length) {
    list.innerHTML = emptyState('👤', 'Bu pencerede henüz reply yok', 'Başarılı bir post atıldığında hesap burada görünür.');
    return;
  }
  list.innerHTML = '';
  for (const r of book) {
    const capped = data.maxReplies > 0 && r.count >= data.maxReplies;
    const row = el('div', 'card account-row');
    row.innerHTML = `
      <div class="acc-main">
        <a class="author" href="https://x.com/${esc(r.author)}" target="_blank" rel="noopener">@${esc(r.author)}</a>
        <span class="acc-last micro">son: ${esc(r.last_at ? fmtWhen(r.last_at) : '—')}</span>
      </div>
      <span class="acc-count ${capped ? 'is-capped' : ''}">${r.count} reply${capped ? ' · sınırda' : ''}</span>`;
    list.appendChild(row);
  }
}

// ── Ayarlar ──────────────────────────────────────────────────────────────────
const SETTING_META = {
  daily_post_limit: {
    label: 'Günlük post limiti (tavan)', unit: 'post',
    desc: 'Bir günde en fazla kaç reply postlanır (üst sınır). Etkin limit her gün bundan 0..jitter kadar rastgele düşülerek belirlenir (aşağı).',
  },
  daily_limit_jitter: {
    label: 'Günlük limit rastgele payı', unit: 'post',
    desc: 'Ban riski önlemi (B). Her gün tavandan 0..bu kadar rastgele post DÜŞÜLÜR — ör. tavan 30, pay 6 → o gün 24-30 arası. Sabit günlük hacim = bot parmak izi. 0 = kapalı (hep tavan).',
  },
  yesterday_warn_max_per_day: {
    label: 'Dün-uyarısı günlük limiti', unit: 'kez',
    desc: '"Dün X post attın, bugün farklı olsun" uyarısı bir günde en fazla bu kadar gösterilir. 0 = uyarı kapalı.',
  },
  min_post_interval_minutes: {
    label: 'Minimum post aralığı (taban A)', unit: 'dk',
    desc: 'İki zamanlanmış post arası TABAN süre. Gerçek aralık = A + 0..jitter tam dk; ayrıca her postun saniye ve salisesi bağımsız randomlanır (sabit saat deseni = bot sinyali).',
  },
  post_interval_jitter_minutes: {
    label: 'Post aralığı rastgele payı', unit: 'dk',
    desc: 'Taban A’nın üstüne 0..bu kadar rastgele TAM dakika eklenir (ör. A=20, jitter=9 → 20-29 dk). Tek basamak önerilir; büyütürsen dağılım genişler (ban açısından daha iyi).',
  },
  scrape_target_per_keyword: {
    label: 'Keyword başına hedef', unit: 'tweet',
    desc: 'Her keyword için kaç tweet çekilmeye çalışılır. Eleme ve ret payı bırakmak için yüksek tutulur.',
  },
  scraped_ttl_hours: {
    label: 'Havuz tazeliği', unit: 'saat',
    desc: 'Bu süreden eski, hâlâ işlenmemiş tweetler silinir. Postlanan ve reddedilenlere dokunulmaz.',
  },
  approval_queue_max: {
    label: 'Onay kuyruğu üst sınırı', unit: 'tweet',
    desc: 'Onay kuyruğunda aynı anda en fazla kaç tweet bekleyebilir. Dolduğunda qa yeni aday eklemez (kuyruk şişmesin). 0 = sınırsız.',
  },
  approval_ttl_hours: {
    label: 'Onay kuyruğu bekleme süresi', unit: 'saat',
    desc: 'Bu süreden fazla onaylanmadan bekleyen tweetler silinir (reddedilmiş sayılmaz, dedup’a girmez — ileride yeniden çıkabilir). 0 = kapalı.',
  },
  score_w_likes:    { label: 'Skor ağırlığı: like',    unit: '×', desc: 'Engagement skorunda beğeninin çarpanı.' },
  score_w_retweets: { label: 'Skor ağırlığı: retweet', unit: '×', desc: 'Engagement skorunda retweetin çarpanı.' },
  score_w_replies:  { label: 'Skor ağırlığı: reply',   unit: '×', desc: 'Engagement skorunda yanıtın çarpanı.' },
  score_w_quotes:   { label: 'Skor ağırlığı: quote',   unit: '×', desc: 'Engagement skorunda alıntının çarpanı.' },

  // --- Kalite filtresi ---
  filter_min_faves: {
    label: 'Filtre: min. beğeni', unit: 'like',
    desc: 'Katman 1 (X sunucu tarafı). Bu beğeninin altındaki tweetler hiç çekilmez. Düşük etkileşim çöpünü keser. 0 = kapalı.',
  },
  filter_within_days: {
    label: 'Filtre: son N gün', unit: 'gün',
    desc: 'Katman 1 (X since:). Yalnızca son bu kadar günde paylaşılan tweetler çekilir. 0 = kapalı.',
  },
  filter_exclude_replies: {
    label: 'Filtre: yanıtları hariç tut', unit: '1/0',
    desc: 'Katman 1. 1 = başka tweetlere yanıt olan tweetleri çekme (yalnız orijinal gönderiler). 0 = kapalı.',
  },
  filter_min_views: {
    label: 'Filtre: min. görüntülenme', unit: 'view',
    desc: 'Katman 2 (kod). Bu görüntülenmenin altındaki tweetler elenir (erişim tabanı). views bilinmiyorsa atlanır. 0 = kapalı.',
  },
  filter_max_replies: {
    label: 'Filtre: max. yorum', unit: 'yorum',
    desc: 'Katman 2. Bu kadar yorumu geçen tweetler elenir (yanıtımız gömülmesin diye üst güvenlik tavanı). 0 = kapalı.',
  },
  filter_max_reply_view_ratio: {
    label: 'Filtre: max. yorum/görüntülenme oranı', unit: 'oran',
    desc: 'Katman 2 — asıl "gömülme" filtresi. yorum/görüntülenme bu oranı geçerse elenir. Ör. 0.0015. views bilinmiyorsa atlanır. 0 = kapalı.',
  },
  filter_max_age_hours: {
    label: 'Filtre: max. yaş', unit: 'saat',
    desc: 'Katman 2. Bu saatten eski tweetler elenir (tazelik). 0 = kapalı.',
  },

  // --- Hemen Paylaş aralığı ---
  direct_post_min_gap_seconds: {
    label: 'Hemen Paylaş: min. aralık', unit: 'sn',
    desc: 'Art arda "Hemen Paylaş" tıklandığında iki post arası en az bu kadar saniye beklenir (burst/ban önlemi). Tek sırada işlenir.',
  },
  direct_post_gap_jitter_seconds: {
    label: 'Hemen Paylaş: rastgele pay', unit: 'sn',
    desc: 'Min. aralığın üstüne 0..bu kadar rastgele saniye eklenir (robot gibi görünmemek için). Ör. 120 + 60 → 2-3 dk arası.',
  },
  strip_promo_links: {
    label: 'Postta tanıtım linklerini kaldır', unit: '1/0',
    desc: 'Ban riski önlemi. 1 = reply postlanırken Giggle "Download / App Store / Google Play" link bloğu temizlenir (X, tekrarlı+linkli reply\'ları spam sayar). DB\'deki tam metin değişmez; sadece X\'e giden temizlenir. 0 = aynen postla.',
  },

  // --- (A) Aktif-saat penceresi ---
  active_hours_enabled: {
    label: 'Aktif-saat penceresi', unit: '1/0',
    desc: 'Ban riski önlemi. 1 = postlar yalnız uyanık saatlerde zamanlanır (gece post atmak klasik bot sinyalidir). 0 = 24 saate dağıt.',
  },
  active_hours_start: {
    label: 'Aktif-saat: başlangıç', unit: 'saat',
    desc: 'Yerel saat (dahil). Bu saatten önce post zamanlanmaz. Ör. 8 = 08:00.',
  },
  active_hours_end: {
    label: 'Aktif-saat: bitiş', unit: 'saat',
    desc: 'Yerel saat (hariç). Bu saatten sonra post zamanlanmaz. Ör. 23 = 23:00.',
  },
  active_hours_tz_offset: {
    label: 'Yerel saat farkı (UTC+)', unit: 'saat',
    desc: 'Sunucu UTC çalışır; başlangıç/bitiş saatlerini kendi saat dilimine çevirmek için. Türkiye = 3.',
  },

  // --- (E) Hesap başına reply sıklığı ---
  author_cap_max_replies: {
    label: 'Hesap başına max reply', unit: 'reply',
    desc: 'Ban riski önlemi (E). Bir hesaba pencere içinde en fazla bu kadar reply atılır; aşınca o hesabın yeni tweetleri scrape aşamasında elenir (aşırı hedefleme = spam/reply-guy sinyali). 0 = kapalı.',
  },
  author_cap_window_days: {
    label: 'Hesap sınırı penceresi', unit: 'gün',
    desc: 'Hesap reply kayıt defteri bu kadar günde bir sıfırlanır (varsayılan 7 = haftalık). "Hesaplar" sekmesinden görülebilir.',
  },
};

async function loadSettings() {
  const form = $('#settingsForm');
  let rows;
  try {
    rows = await api('/api/settings');
  } catch (e) {
    form.innerHTML = emptyState('⚠', 'Ayarlar yüklenemedi', e.message);
    return;
  }
  form.innerHTML = '';
  for (const { key, value } of rows) {
    if (key === 'author_cap_window_start') continue; // runtime durumu — düzenlenebilir ayar değil
    const meta = SETTING_META[key] || { label: key, unit: '', desc: '' };
    const box = el('div', 'setting');
    box.innerHTML = `
      <label for="set-${esc(key)}">${esc(meta.label)}</label>
      <div class="desc">${esc(meta.desc)}</div>
      <div class="field">
        <input id="set-${esc(key)}" type="number" step="any" min="0"
               data-key="${esc(key)}" value="${esc(value)}" />
        <span class="unit">${esc(meta.unit)}</span>
      </div>`;
    form.appendChild(box);
  }
}

$('#saveSettings').onclick = async (e) => {
  const btn = e.currentTarget;
  const body = {};
  document.querySelectorAll('#settingsForm input').forEach((i) => (body[i.dataset.key] = i.value));
  btn.disabled = true;
  try {
    await post('/api/settings', body);
    $('#settingsSaved').textContent = '✓ Kaydedildi';
    setTimeout(() => ($('#settingsSaved').textContent = ''), 2400);
    loadHealth();
  } catch (err) {
    toast(`Kaydedilemedi: ${err.message}`, 'bad');
  } finally {
    btn.disabled = false;
  }
};

// ── İlk yükleme ──────────────────────────────────────────────────────────────
selectTab(localStorage.getItem('activeTab') || 'scrape');
loadHealth();

setInterval(loadHealth, 30000);
// Schedule açıkken zaman ilerler: ray ve "sonraki post" tazelensin.
setInterval(() => { if (activeTab === 'schedule') loadSchedule(); }, 60000);

// ── Sunucu bildirimleri (arka plan olayları, ör. hemen-paylaş X'te reddedilip zamanlandı) ──
// Yeni bildirimleri periyodik çek, her birini 5 sn görünen bir toast olarak göster.
let _lastNotifId = 0;
async function pollNotifications() {
  try {
    const items = await api('/api/notifications?since=' + _lastNotifId);
    for (const n of items) {
      _lastNotifId = Math.max(_lastNotifId, n.id);
      toast(n.message, n.level === 'warn' ? 'bad' : n.level || 'info', 5000);
      if (activeTab === 'schedule') loadSchedule();
      loadHealth();
    }
  } catch {
    /* sunucuya ulaşılamıyorsa sessiz geç */
  }
}
// İlk açılışta biriken eskileri toast'lamadan atla: mevcut en yüksek id'yi başlangıç noktası yap.
(async () => {
  try {
    const items = await api('/api/notifications?since=0');
    _lastNotifId = items.reduce((mx, n) => Math.max(mx, n.id), 0);
  } catch { /* yoksay */ }
  setInterval(pollNotifications, 10000);
})();

