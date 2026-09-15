/**
 * Orchestrator (spec §2) — tek process.
 * Dashboard server + ajan döngüleri aynı süreçte çalışır. DB tek source of truth.
 * Karar: 4 ayrı process/pm2 yerine tek orchestrator (tek VPS + tek kullanıcı).
 */
import 'dotenv/config';
import { purgeStaleScraped, purgeStalePendingApproval, resetGeneratingToPending } from './lib/db.js'; // şema + WAL init (import edilince kurulur)
import { startServer } from './dashboard/server.js';
import { runQaCycle } from './agents/qa-agent.js';
import { promoteDue } from './agents/scheduling-agent.js';
import { runPostCycle } from './agents/post-agent.js';
import { proxyStatus } from './lib/xactions-client.js';
import { log } from './lib/logger.js';

const MINUTE = 60_000;

// Basit güvenli döngü: hata olsa da process çökmesin
function safeLoop(name, fn, intervalMs) {
  let running = false;
  const tick = async () => {
    if (running) return; // örtüşmeyi önle
    running = true;
    try {
      await fn();
    } catch (err) {
      log('orchestrator', `${name} döngü hatası: ${err.message}`, 'error');
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}

function main() {
  log('orchestrator', 'başlatılıyor…');

  // Restart kurtarma: yarıda kalmış 'generating' kayıtları (bellek-içi Giggle/direct-post
  // süreçleri restart'ta kaybolur) onay kuyruğuna geri döndür.
  const recovered = resetGeneratingToPending();
  if (recovered > 0) log('orchestrator', `${recovered} yarıda kalmış 'generating' → 'pending_approval' kurtarıldı`);

  // X trafiği için proxy durumu (static residential ISP proxy — ban riski önlemi)
  const px = proxyStatus();
  if (px.enabled) {
    log('orchestrator', `X proxy AKTİF → ${px.host || '(host okunamadı)'}`);
  } else {
    log('orchestrator', 'X proxy KAPALI — X trafiği doğrudan sunucu IP\'sinden gidiyor', 'warn');
  }

  const server = startServer();

  // scheduling: her dakika zamanı geleni ready_to_post yap
  const t1 = safeLoop('scheduling', async () => promoteDue(), MINUTE);
  // post: her dakika ready_to_post kuyruğunu postla
  const t2 = safeLoop('post', async () => runPostCycle(), MINUTE);
  // qa: scrape dashboard'dan tetikleniyor; yine de artık scraped kalanları
  //     periyodik (2 dk) temizlemek için emniyet turu
  const t3 = safeLoop('qa', async () => runQaCycle(), 2 * MINUTE);
  // cleanup: bayat 'scraped' + uzun süre onaylanmadan bekleyen 'pending_approval' tweetleri
  //          temizle (TTL). pending_approval silinir, rejected'a YAZILMAZ (kullanıcı isteği) —
  //          6 saatte bir.
  const t4 = safeLoop(
    'cleanup',
    async () => {
      const n = purgeStaleScraped();
      if (n > 0) log('cleanup', `${n} bayat 'scraped' tweet temizlendi (TTL)`);
      const p = purgeStalePendingApproval();
      if (p > 0) log('cleanup', `${p} bayat 'pending_approval' tweet temizlendi (onaylanmadan bekledi, TTL)`);
    },
    6 * 60 * MINUTE
  );

  const shutdown = () => {
    log('orchestrator', 'kapatılıyor…');
    clearInterval(t1);
    clearInterval(t2);
    clearInterval(t3);
    clearInterval(t4);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
