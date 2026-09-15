/**
 * Failed durumdaki (226 throttle) adayı tekrar postlar. İçerik korunur, yeniden üretim yok.
 * Kullanım: node scripts/retry-post.js
 */
import 'dotenv/config';
import * as db from '../src/lib/db.js';
import { runPostCycle } from '../src/agents/post-agent.js';

const failed = db.getByStatus('failed');
if (failed.length === 0) {
  console.log('Retry edilecek failed aday yok.');
  process.exit(0);
}

const c = failed[0];
console.log(`Retry: ${c.id} @${c.author}`);
db.updateStatus(c.id, 'ready_to_post', { error_message: null });

const res = await runPostCycle();
console.log('post sonucu:', JSON.stringify(res));

const t = db.getTweet(c.id);
if (t.status === 'posted') {
  console.log('POSTLANDI ✔  https://x.com/Aquilammm/status/' + t.posted_reply_id);
} else {
  console.log('Hâlâ başarısız:', t.error_message);
}
