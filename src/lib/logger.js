/**
 * Basit zaman damgalı logger. Tüm ajanlar/dashboard bunu kullanır.
 */
function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function log(scope, message, level = 'info') {
  const line = `[${ts()}] [${scope}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
