# gerekli.md — günlük işletim

## Komutlar (terminalde)

```bash
sudo systemctl restart x-automation    # backend/ajan kodu değişince
sudo systemctl stop x-automation       # durdur
sudo systemctl start x-automation      # başlat
sudo systemctl status x-automation     # durum
tail -30 orchestrator.log              # log
npm run auth-test                      # X cookie / arama / çıkış IP kontrolü
```

Backend kodu değişince tek gereken restart. Frontend (`src/dashboard/public/`) diskten serve
edildiği için tarayıcı yenilemesi yeter.

Dashboard: `http://localhost:3000` (VS Code/Cursor port-forward ya da
`ssh -L 3000:localhost:3000 <vps>`). Port dışarı kapalı, auth yok.

**Cookie yenileme:** sağ üstte "X bağlı değil" görünürse → x.com'da tam çıkış-giriş → yeni
`auth_token` + `ct0` → `.env`'de yalnız `XACTIONS_AUTH_TOKEN` ve `XACTIONS_CT0` satırları →
restart → `npm run auth-test`.

## Onay kuyruğu aksiyonları

- **Onayla** → Giggle üretir (~2 dk) → otomatik zamanlanır → Schedule sekmesinde görünür.
- **Hemen Paylaş** → Giggle üretir → zamanlamadan postlar. Art arda tıklananlar sırayla, aralarında
  2-3 dk beklemeyle gider. X geçici throttle verirse 90 sn arayla 3 kez tekrar dener, geçmezse
  sonraya zamanlar; 226/344 gibi sert hatada "Başarısız"a düşer.
- **Reddet** → kalıcı; o tweet bir daha aday olmaz.

Onaylanmadan 12 saat bekleyen kayıtlar kuyruktan silinir (reddedilmiş sayılmaz, yeniden
scrape edilebilir).

## Schedule sekmesi

En yeniden en eskiye sıralı. Durum çipleriyle filtre. `scheduled` kayıt **İptal** edilebilir.
`failed` / `blocked_daily_limit` kayıtlar **Yeniden Dene** ile tekrar denenir; "Başarısız"
filtresinde **Hepsini Yeniden Dene (N)** hepsini tek seferde yeniden dener. Otomatik retry yok.

Hata mesajında görülen X kodları:
- **344** → hesabın X günlük gönderim kotası doldu (~24 saat). Bekle.
- **226** → "might be automated". Art arda deneme yapılmaz; kadans düşürülür, 24-72 saat post
  atılmaz (scrape/onay güvenli).
- boş `tweet_results` → geçici throttle, dakikalar sonra aynı içerik geçer.

## Ayarlar sekmesindeki alanlar

Değiştirip Kaydet'e basınca DB'ye yazılır; ajanlar bir sonraki turda yeni değeri kullanır.
Virgüllü ondalıklar (1,5) sistem dilinden kaynaklanır, DB'de 1.5 saklanır.

### Hacim ve kadans
- **Günlük post limiti** (30) — tavan. Etkin günlük limit her gün bu tavandan **Günlük limit
  jitter** (6) kadar rastgele düşülerek belirlenir (30, jitter 6 → 24-30 arası), gün içinde sabit.
  Sabit günlük sayı bot parmak izi olduğu için.
- **Min. post aralığı** (15 dk) — iki post arası taban. Üstüne **Post aralığı jitter** (9) ile
  0-9 rastgele tam dakika eklenir; saniye ve salise her postta ayrıca rastgele.
- **Dün uyarısı / gün** (2) — bugünkü post sayısı dünküne ulaşınca çıkan uyarının günlük tavanı.

### Aktif saat penceresi
- **Aktif-saat açık** (1), **başlangıç** (8), **bitiş** (23), **UTC farkı** (3 = Türkiye).
  Postlar yalnız bu yerel saat aralığında zamanlanır; dışına düşen slot ertesi günün başlangıç
  saatine kayar. Sunucu UTC çalışır.

### Scrape ve kalite filtresi
- **Keyword başına hedef** (200) — bir keyword için çekilecek tweet sayısı. Skor elemesi ve
  ret sonrası 30 postluk günlük hedefi karşılayacak havuz.
- **scraped TTL** (48 saat) — çekilip aday olmamış tweetler bu süre sonra silinir.
- **Onay kuyruğu max** (100) — kuyrukta aynı anda en fazla bu kadar aday (0 = sınırsız).
- **Onay TTL** (12 saat) — onaylanmadan bekleyen adaylar silinir (0 = kapalı).
- **min_faves** (500) — X aramasına `min_faves:` operatörü olarak eklenir.
- **within_days** (3) — X aramasına `since:` olarak eklenir.
- **exclude_replies** (1) — başka tweete yanıt olanlar elenir.
- **min_views** (50000) — bundan az görüntülenen elenir (0 = kapalı).
- **max_replies** (2000) — bundan çok yorumu olan elenir (0 = kapalı).
- **max_reply_view_ratio** (0.0015) — yorum/görüntülenme oranı bunu geçerse elenir; reply'ın
  yorum yığınında gömülmemesi için asıl filtre (0 = kapalı).
- **max_age_hours** (72) — bundan eski tweet elenir (0 = kapalı).

### Skor ağırlıkları
`skor = like×1 + retweet×2 + reply×1,5 + quote×1,5`. qa-agent en yüksek skorluları aday seçer.
Retweet'e 2 verilmesi retweet'in daha güçlü yayılım sinyali olmasından.

### Hemen Paylaş
- **Direct-post min aralık** (120 sn) + **jitter** (60 sn) — art arda Hemen Paylaş'lar arası
  bekleme (2-3 dk).
- **Throttle tekrar** (3) × **throttle bekleme** (90 sn) — geçici throttle'da tekrar deneme.

### Hesap başına sınır
- **Hesap başına max reply** (2) — pencere içinde aynı hesaba en fazla bu kadar reply; dolunca o
  hesabın yeni tweetleri scrape'te elenir (0 = kapalı). "Hesaplar" sekmesinde görülür.
- **Hesap sınırı penceresi** (7 gün) — defter haftalık sıfırlanır.

### Diğer
- **Promo linklerini temizle** (1) — Giggle metnindeki "Download Giggle / App Store / Google Play"
  bloğu post anında kaldırılır; "— Giggle" imzası kalır. DB'deki metin değişmez.
