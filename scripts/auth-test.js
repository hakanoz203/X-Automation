/**
 * X auth + arama testi. VPS'te çalıştır: `npm run auth-test`
 * .env'deki XACTIONS_AUTH_TOKEN + XACTIONS_CT0 ile X'e bağlanıp küçük bir arama yapar.
 */
import 'dotenv/config';
import { checkAuth, search, tweetUrl, proxyStatus, checkExitIp } from '../src/lib/xactions-client.js';

console.log('X auth testi başlıyor…\n');

// --- Proxy durumu + çıkış IP doğrulaması ---
const px = proxyStatus();
if (px.enabled) {
  console.log(`Proxy: AKTİF → ${px.host}`);
  const ip = await checkExitIp();
  console.log(`  X isteklerinin çıkış IP'si (proxy): ${ip.proxied}`);
  console.log(`  Doğrudan (VPS) çıkış IP'si:          ${ip.direct}`);
  if (ip.proxied && ip.direct && ip.proxied !== ip.direct && !String(ip.proxied).startsWith('hata')) {
    console.log('  ✔ Proxy çalışıyor — X trafiği residential IP üzerinden gidiyor.\n');
  } else {
    console.log('  ✖ DİKKAT: proxy çıkış IP\'si doğrulanamadı (yukarıdaki değerleri kontrol et).\n');
  }
} else {
  console.log('Proxy: KAPALI — X trafiği doğrudan VPS IP\'sinden gidiyor (.env X_PROXY_URL ekle).\n');
}

const auth = await checkAuth();
console.log('checkAuth:', auth.ok ? '✔ BAŞARILI' : `✖ BAŞARISIZ — ${auth.reason}`);

try {
  const tweets = await search('claude ai', 5, { type: 'Top' });
  console.log(`\n✔ Arama çalıştı — ${tweets.length} tweet bulundu:\n`);
  for (const t of tweets.slice(0, 5)) {
    console.log(`  • @${t.author}  ❤${t.likes} 🔁${t.retweets} 💬${t.replies}`);
    console.log(`    ${(t.text || '').slice(0, 70).replace(/\n/g, ' ')}`);
    console.log(`    ${tweetUrl(t)}\n`);
  }
  console.log('SONUÇ: X entegrasyonu ÇALIŞIYOR. `npm start` ile sistemi başlatabilirsin.');
  process.exit(0);
} catch (err) {
  console.log(`\n✖ Arama BAŞARISIZ: ${err.message}`);
  console.log('\nSONUC: Bu IP/cookie ile X reddediyor.');
  console.log('  - code 32 "Could not authenticate you" -> cookie gecersiz VEYA IP bloklu.');
  console.log('  - Bu VPS te de basarisizsa cookie leri tazele (x.com tam logout -> login).');
  process.exit(1);
}
