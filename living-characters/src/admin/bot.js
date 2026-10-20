// Optional admin bot: a second Telegram bot that only accepts commands from
// ADMIN_CHAT_IDS. Keeps control and debug output out of the character chat.
import { config } from '../config.js';
import { logger } from '../log.js';
import { startPoller } from '../telegram/poller.js';
import { HELP, formatForChat } from './commands.js';

const log = logger('admin-bot');

export function startAdminBot({ api, db, commands }) {
  const allowed = new Set(config.telegram.adminChatIds);
  return startPoller({
    api, db, name: 'admin', timeoutSec: config.telegram.pollTimeoutSec,
    async onMessage({ chatId, text, from }) {
      if (text.trim() === '/whoami') { await api.sendMessage(chatId, `chat id: ${chatId}`); return; }
      if (!allowed.has(chatId)) { log.warn(`ignored admin command from ${chatId} (${from?.username || from?.first_name || '?'})`); return; }
      const [cmdRaw, ...rest] = text.trim().split(/\s+/);
      const cmd = cmdRaw.replace(/^\//, '').replace(/@\w+$/, '').toLowerCase();
      if (cmd === 'help' || cmd === 'start_help') { await api.sendMessage(chatId, HELP); return; }
      const fn = commands[cmd];
      if (!fn) { await api.sendMessage(chatId, `모르는 명령: ${cmd}\n\n${HELP}`); return; }
      const args = cmd === 'ff' ? { minutes: rest[0] } : cmd === 'events' ? { limit: rest[0] } : {};
      try {
        const result = await fn(args);
        const out = formatForChat(cmd, result);
        for (let i = 0; i < out.length; i += 3800) await api.sendMessage(chatId, out.slice(i, i + 3800));
      } catch (e) { await api.sendMessage(chatId, `오류: ${e.message}`); }
    },
  });
}
