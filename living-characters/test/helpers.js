process.env.LLM_PROVIDER = 'mock';
process.env.ALLOW_FAST_FORWARD = 'true';
process.env.ADMIN_TOKEN = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.INBOUND_DEBOUNCE_MS = '10';
export const { openDb } = await import('../src/db/db.js');
export const { Simulation } = await import('../src/engine/simulation.js');
export const { MockTelegram } = await import('../src/telegram/api.js');
export const { config } = await import('../src/config.js');
export const world = await import('../src/engine/world.js');
export const sister = await import('../src/characters/sister.js');
export const clock = await import('../src/engine/clock.js');

export function makeSim(db, tg, chatId = '42') {
  return new Simulation(db, { transport: tg, chatId, sleep: async () => {} });
}
export async function reply(sim, text, updateId) {
  sim.onUserMessage({ text, updateId, messageId: updateId });
  await sim.scheduleInboundDeliberation(5);
}
