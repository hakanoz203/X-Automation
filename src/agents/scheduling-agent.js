/**
 * scheduling-agent (spec §4.3, §7)
 * approved tweetleri önümüzdeki 24 saate, minimum interval + jitter ile dağıtır.
 * Ayrıca her dakika çalışan döngü scheduled_at'i gelenleri ready_to_post yapar.
 */
import {
  getByStatus,
  setScheduled,
  promoteDueScheduled,
  getSettingNumber,
  countScheduledForDate,
} from '../lib/db.js';
import { log } from '../lib/logger.js';

/** Slot'un saniye + salisesini bağımsızca randomlar (sabit :ss.SSS parmak izini kırar). */
function randomizeSecMs(d) {
  d.setSeconds(Math.floor(Math.random() * 60), Math.floor(Math.random() * 1000));
  return d;
}

/**
 * (A) Slot'u aktif-saat penceresine kaydırır (yerel saat, tz offset ile). Pencere dışıysa uygun
 * günün başlangıç saatine + ilk saat içinde rastgele jitter'a taşır. 24 saate düz dağıtmak (gece
 * dahil) klasik bot sinyalidir; postları yalnız uyanık saatlere sıkıştırırız.
 * @param {Date} slot
 * @returns {Date}
 */
function clampToActiveHours(slot) {
  if (getSettingNumber('active_hours_enabled', 1) !== 1) return slot;
  const start = getSettingNumber('active_hours_start', 8);
  const end = getSettingNumber('active_hours_end', 23);
  const tzMin = getSettingNumber('active_hours_tz_offset', 3) * 60;

  // slot'u yerel saate kaydır: shifted.getUTC*() artık yerel değerleri verir.
  const local = new Date(slot.getTime() + tzMin * 60_000);
  const h = local.getUTCHours();
  if (h >= start && h < end) return slot; // zaten pencere içinde

  let y = local.getUTCFullYear();
  let mo = local.getUTCMonth();
  let d = local.getUTCDate();
  if (h >= end) d += 1; // akşam penceresi kapandı → ertesi gün (Date.UTC ay taşmasını halleder)
  // Pencere başında yığılmayı önlemek için ilk saate rastgele jitter.
  const jMin = Math.floor(Math.random() * 60);
  const jSec = Math.floor(Math.random() * 60);
  const jMs = Math.floor(Math.random() * 1000);
  const newLocalMs = Date.UTC(y, mo, d, start, jMin, jSec, jMs);
  return new Date(newLocalMs - tzMin * 60_000); // gerçek UTC'ye geri çevir
}

/**
 * cursor'dan sonraki bir sonraki uygun slot'u üretir: TABAN A dk + 0..jitter tam dk, saniye/salise
 * randomlu, aktif-saat penceresine kısıtlı, o günün günlük limiti doluysa sonraki güne kaydırılmış.
 * @param {number} cursorMs
 * @returns {Date}
 */
function nextSlot(cursorMs, { minGapMin, jitterMin, dailyLimit }) {
  const extraMin = Math.floor(Math.random() * (jitterMin + 1)); // 0..jitterMin dahil
  let slot = new Date(cursorMs + (minGapMin + extraMin) * 60_000);
  randomizeSecMs(slot);
  slot = clampToActiveHours(slot);

  // Günlük limit: o gün için doluysa ertesi güne kaydır (+24h yerel saati korur → pencerede kalır).
  let guard = 0;
  while (countScheduledForDate(slot.toISOString().slice(0, 10)) >= dailyLimit && guard < 14) {
    slot = new Date(slot.getTime() + 24 * 3600_000);
    guard++;
  }
  return slot;
}

/** Mevcut scheduled kayıtların en ileri zamanı ya da şimdi — dağıtım başlangıç cursor'u. */
function scheduleCursorStart() {
  let cursor = Date.now();
  for (const r of getByStatus('scheduled')) {
    const ts = r.scheduled_at ? new Date(r.scheduled_at).getTime() : 0;
    if (ts > cursor) cursor = ts;
  }
  return cursor;
}

/**
 * approved kayıtları zamanlar. Zaman damgaları son planlanan zamandan itibaren
 * `min_post_interval_minutes + 0..post_interval_jitter_minutes` tam dakika artışıyla (saniye/salise
 * randomlu, aktif-saat penceresine kısıtlı) üretilir. Günlük limit aşılırsa fazlalar sonraki güne kayar.
 * @returns {Promise<{scheduled:number, deferred:number}>}
 */
export function scheduleApproved() {
  const approved = getByStatus('approved');
  const out = { scheduled: 0, deferred: 0 };
  if (approved.length === 0) return out;

  const minGapMin = getSettingNumber('min_post_interval_minutes', 15);
  const jitterMin = getSettingNumber('post_interval_jitter_minutes', 9);
  const dailyLimit = getSettingNumber('daily_post_limit', 30);

  let cursor = scheduleCursorStart();
  for (const t of approved) {
    const slot = nextSlot(cursor, { minGapMin, jitterMin, dailyLimit });
    setScheduled(t.id, slot.toISOString());
    cursor = slot.getTime();
    out.scheduled++;
    log('scheduling', `${t.id} planlandı → ${slot.toISOString()}`);
  }
  return out;
}

/**
 * Her dakika çalışan döngü: zamanı gelen scheduled kayıtları ready_to_post yapar.
 * @returns {number} terfi eden kayıt sayısı
 */
export function promoteDue() {
  const n = promoteDueScheduled(new Date().toISOString());
  if (n > 0) log('scheduling', `${n} kayıt ready_to_post'a geçti`);
  return n;
}
