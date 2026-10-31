/**
 * Alert delivery: Telegram bot when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set,
 * otherwise append to data/alerts.log and print to stdout.
 *
 * Tokens are read from the environment or from a local .env file in the workspace;
 * they are never sent anywhere except the Telegram API.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ENV_FILE = path.join(ROOT, '.env');

function loadEnv() {
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (value && !process.env[key]) process.env[key] = value;
    }
  }
}

export async function send(text) {
  loadEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const stamp = new Date().toISOString();

  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.appendFileSync(path.join(ROOT, 'data', 'alerts.log'), `${stamp}\n${text}\n\n`);

  if (!token || !chatId) {
    console.log('[alerts] Telegram not configured — wrote to data/alerts.log');
    console.log(text);
    return { delivered: false };
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`telegram: ${json.description ?? res.status}`);
  return { delivered: true };
}

if (process.argv[1]?.endsWith('notify.mjs')) {
  const text = process.argv.slice(2).join(' ') || 'DSH alert test';
  await send(text);
  console.log('sent');
}
