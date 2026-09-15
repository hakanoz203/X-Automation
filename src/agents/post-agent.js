/**
 * post-agent (spec §4.4, §7)
 * ready_to_post kayıtları X'e metin+görsel reply olarak postlar.
 * Günlük limit son kontrolü; başarı → posted, hata → failed (otomatik retry YOK).
 */
import { existsSync } from 'node:fs';
import {
  getByStatus,
  updateStatus,
  incTodayPostCount,
  incAuthorReply,
  remainingDailyQuota,
  getSettingNumber,
} from '../lib/db.js';
import { postReply } from '../lib/xactions-client.js';
import { stripPromoLinks } from '../lib/giggle-client.js';
import { log } from '../lib/logger.js';

/**
 * ready_to_post kuyruğunu işler.
 * @returns {Promise<{posted:number, failed:number, blocked:number}>}
 */
export async function runPostCycle() {
  const ready = getByStatus('ready_to_post');
  const out = { posted: 0, failed: 0, blocked: 0 };

  for (const t of ready) {
    // Post öncesi son güvenlik: günlük limit (spec §4.4)
    if (remainingDailyQuota() <= 0) {
      updateStatus(t.id, 'blocked_daily_limit');
      out.blocked++;
      log('post', `${t.id} günlük limit doldu → blocked_daily_limit`, 'warn');
      continue;
    }

    // Metin yoksa postlama (Giggle üretimi düşmüş olabilir) → failed, kullanıcı retry eder.
    if (!t.generated_reply_text || !String(t.generated_reply_text).trim()) {
      updateStatus(t.id, 'failed', { error_message: 'reply metni yok (üretim tamamlanmadı)' });
      out.failed++;
      log('post', `${t.id} reply metni yok → failed`, 'warn');
      continue;
    }

    try {
      const imagePath =
        t.generated_image_path && existsSync(t.generated_image_path)
          ? t.generated_image_path
          : null;

      const finalText = getSettingNumber('strip_promo_links', 1)
        ? stripPromoLinks(t.generated_reply_text)
        : t.generated_reply_text;
      const { replyId } = await postReply(t.id, finalText, imagePath);
      updateStatus(t.id, 'posted', { posted_reply_id: replyId });
      incTodayPostCount();
      incAuthorReply(t.author); // (E) hesap başına reply sayacı
      out.posted++;
      log('post', `${t.id} postlandı${replyId ? ` (reply ${replyId})` : ''}`);
    } catch (err) {
      updateStatus(t.id, 'failed', { error_message: err.message?.slice(0, 500) });
      out.failed++;
      log('post', `${t.id} POST HATA: ${err.message}`, 'error');
    }
  }
  return out;
}
