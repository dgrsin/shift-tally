// World clock. Real time and world time run 1:1; `time_offset_ms` absorbs
// fast-forwards and pauses so world time is continuous and monotonic.
//   running: world = real + offset
//   paused : world = paused_at_real + offset   (frozen)
export const MIN = 60_000;

export function worldNow(sim, realNow = Date.now()) {
  if (sim.status === 'paused' && sim.paused_at_real != null) return sim.paused_at_real + sim.time_offset_ms;
  return realNow + sim.time_offset_ms;
}

export function pause(sim, realNow = Date.now()) {
  if (sim.status !== 'running') return sim;
  return { ...sim, status: 'paused', paused_at_real: realNow };
}

export function resume(sim, realNow = Date.now()) {
  if (sim.status !== 'paused') return sim;
  const frozenFor = realNow - sim.paused_at_real;
  return { ...sim, status: 'running', paused_at_real: null, time_offset_ms: sim.time_offset_ms - frozenFor };
}

export function fastForward(sim, minutes) {
  return { ...sim, time_offset_ms: sim.time_offset_ms + Math.round(minutes * MIN) };
}

export function fmtSeoul(ms) {
  return new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}
export function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit' });
}
export function elapsedMin(fromMs, toMs) { return Math.floor((toMs - fromMs) / MIN); }
