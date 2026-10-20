#!/usr/bin/env node
// Offline dry run: mock LLM + mock Telegram, whole scenario compressed with
// fast-forward. Prints the conversation the user would have received.
//   node scripts/simulate-offline.js            (mock LLM)
//   LLM_PROVIDER=claude node scripts/simulate-offline.js   (real Claude, no Telegram, costs tokens)
process.env.LLM_PROVIDER ??= 'mock';
process.env.ALLOW_FAST_FORWARD = 'true';
process.env.LOG_LEVEL ??= 'info';
const { openDb } = await import('../src/db/db.js');
const { Simulation } = await import('../src/engine/simulation.js');
const { MockTelegram } = await import('../src/telegram/api.js');
const { formatForChat } = await import('../src/admin/commands.js');

const db = openDb(':memory:');
const tg = new MockTelegram();
const sim = new Simulation(db, { transport: tg, chatId: '1', sleep: async () => {} });
const replies = (process.env.REPLIES || '어느 병원이야?|내가 지금 갈게').split('|').filter(Boolean);

await sim.start();
await sim.fastForward(125);                  // past the accident
for (const r of replies) {
  sim.onUserMessage({ text: r, updateId: Math.floor(Math.random() * 1e9), messageId: 1 });
  await sim.scheduleInboundDeliberation(10);
  await sim.fastForward(20);
}
await sim.fastForward(140);                  // ~3h after the accident
console.log('\n=== STATUS ===\n' + formatForChat('status', sim.status()));
console.log('\n=== EVENTS ===\n' + formatForChat('events', sim.events()));
console.log('\n=== CONVERSATION ===\n' + formatForChat('conversation', sim.conversation()));
