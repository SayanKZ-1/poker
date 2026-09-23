import {createHmac, timingSafeEqual} from 'node:crypto';

/** Telegram HMAC validation. Never trust initDataUnsafe or a client-supplied ID. */
export function validateTelegramInitData(raw, botToken, {now = Date.now(), maxAgeSeconds = 300} = {}) {
  if (typeof raw !== 'string' || !raw || raw.length > 16384 || !botToken) throw new Error('Откройте приложение через Telegram');
  const params = new URLSearchParams(raw);
  const seen = new Set();
  for (const [key] of params) {
    if (seen.has(key)) throw new Error('Повторяющийся параметр авторизации');
    seen.add(key);
  }
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Некорректная подпись Telegram');
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', key).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new Error('Не удалось проверить Telegram');
  const authDate = Number(params.get('auth_date'));
  const age = Math.floor(now / 1000) - authDate;
  if (!Number.isSafeInteger(authDate) || authDate <= 0 || age < -30 || age > maxAgeSeconds) throw new Error('Авторизация устарела. Откройте Mini App заново');
  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { throw new Error('Некорректный профиль Telegram'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== 'string' || user.is_bot) throw new Error('Некорректный профиль Telegram');
  return {id: `tg:${user.id}`, name: user.first_name.slice(0, 32), telegramId: String(user.id)};
}
