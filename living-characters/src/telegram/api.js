// Minimal Telegram Bot API client (fetch-based) + mock transport for tests.
export class TelegramApi {
  constructor(token, { fetchImpl = fetch, baseUrl = 'https://api.telegram.org' } = {}) {
    if (!token) throw new Error('telegram token required');
    this.base = `${baseUrl}/bot${token}`;
    this.fetch = fetchImpl;
  }
  async call(method, params = {}, { timeoutMs = 40_000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetch(`${this.base}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: ctrl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        const err = new Error(`telegram ${method} failed: ${res.status} ${body.description || ''}`.trim());
        err.status = res.status; err.retryAfter = body.parameters?.retry_after;
        throw err;
      }
      return body.result;
    } finally { clearTimeout(t); }
  }
  getMe() { return this.call('getMe'); }
  sendMessage(chatId, text, extra = {}) { return this.call('sendMessage', { chat_id: chatId, text, ...extra }); }
  sendChatAction(chatId, action = 'typing') { return this.call('sendChatAction', { chat_id: chatId, action }); }
  getUpdates({ offset, timeoutSec = 25 } = {}) {
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, { timeoutMs: (timeoutSec + 15) * 1000 });
  }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: false }); }
}

/** In-memory stand-in with the same surface. Tests push inbound updates into it. */
export class MockTelegram {
  constructor({ failFirst = 0 } = {}) {
    this.sent = []; this.actions = []; this.queue = []; this.nextMsgId = 1; this.nextUpdateId = 1000; this.failFirst = failFirst;
  }
  async getMe() { return { id: 1, is_bot: true, first_name: '지은', username: 'living_sister_bot' }; }
  async sendMessage(chatId, text) {
    if (this.failFirst > 0) { this.failFirst--; throw new Error('mock network failure'); }
    const m = { chat_id: chatId, text, message_id: this.nextMsgId++, at: Date.now() };
    this.sent.push(m); return m;
  }
  async sendChatAction(chatId, action) { this.actions.push({ chatId, action }); return true; }
  pushInbound(chatId, text, { from = { id: Number(chatId), first_name: 'User' } } = {}) {
    const u = { update_id: this.nextUpdateId++, message: { message_id: this.nextMsgId++, chat: { id: Number(chatId), type: 'private' }, from, text, date: Math.floor(Date.now() / 1000) } };
    this.queue.push(u); return u;
  }
  async getUpdates({ offset } = {}) {
    const out = this.queue.filter((u) => offset == null || u.update_id >= offset);
    return out;
  }
  async deleteWebhook() { return true; }
}
