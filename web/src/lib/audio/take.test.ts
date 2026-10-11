import { describe, expect, it } from 'vitest';
import type { Pass } from '../parts';
import { cutTake, type RawTake } from './take';

const SR = 8000;

/** 구간 시각 segTime 에 낸 소리가 녹음의 몇 번째 표본에 찍히는지 (tZero·지연·녹음 시작 프레임으로) */
const frameOf = (segTime: number, tZero: number, latency: number, firstFrame: number) => Math.round((segTime + tZero + latency) * SR) - firstFrame;

function makePass(starts: number[]): Pass {
  const lines = starts.map((t0, i) => ({ id: 'l' + i, t0, t1: t0 + 2, text: '줄', seats: [0] }));
  return { index: 0, lines, t0: lines[0].t0, t1: lines[lines.length - 1].t1 };
}

/** 잘라 낸 결과에서 가장 큰 표본의 위치를 구간 시각으로 */
function clickTimes(cut: { samples: Float32Array; start: number; sampleRate: number }, around: number[]): number[] {
  return around.map((t) => {
    const a = Math.max(0, Math.round((t - 0.25 - cut.start) * cut.sampleRate));
    const b = Math.min(cut.samples.length, Math.round((t + 0.25 - cut.start) * cut.sampleRate));
    let best = a;
    for (let i = a; i < b; i++) if (Math.abs(cut.samples[i]) > Math.abs(cut.samples[best])) best = i;
    return cut.start + best / cut.sampleRate;
  });
}

describe('녹음 잘라 내기', () => {
  const latency = 0.15;
  // 녹음은 구간 0초보다 1초쯤 먼저 시작됐다 (tZero 40.5초 근처)
  const firstFrame = 317_000;
  const starts = [2, 5, 8, 11];
  const pass = makePass(starts);

  it('tZero 하나로 자르면 줄 시작에 낸 소리가 제자리에 온다', () => {
    const tZero = 40.5;
    const samples = new Float32Array(SR * 30);
    for (const t of starts) samples[frameOf(t, tZero, latency, firstFrame)] = 1;
    const raw: RawTake = { capture: { samples, firstFrame, sampleRate: SR }, tZero, plan: { from: -2, until: 14, countIn: false }, pass };
    const cut = cutTake(raw, latency);
    clickTimes(cut, starts).forEach((t, i) => expect(t).toBeCloseTo(starts[i], 3));
    expect(cut.start).toBeCloseTo(starts[0] - 0.3, 3);
  });

  it('도중에 싱크가 옮겨 갔으면 줄마다 다른 tZero 로 잘라 이어 붙인다', () => {
    const before = 40.5;
    const after = 40.39; // 셋째 줄부터는 소리 시계가 0.11초 밀렸다
    const zeros = [before, before, after, after];
    const samples = new Float32Array(SR * 30);
    starts.forEach((t, i) => (samples[frameOf(t, zeros[i], latency, firstFrame)] = 1));
    const capture = { samples, firstFrame, sampleRate: SR };
    const plan = { from: -2, until: 14, countIn: false };
    // 한 값(뒤쪽)으로만 자르면 앞의 두 줄이 0.11초 어긋난다
    const naive = clickTimes(cutTake({ capture, tZero: after, plan, pass }, latency), starts);
    expect(naive[0] - starts[0]).toBeCloseTo(0.11, 3);
    expect(naive[3] - starts[3]).toBeCloseTo(0, 3);
    // 줄마다 맞추면 모두 제자리
    const cut = cutTake({ capture, tZero: after, zeros, plan, pass }, latency);
    clickTimes(cut, starts).forEach((t, i) => expect(t).toBeCloseTo(starts[i], 3));
    // 길이와 시작은 한 덩어리 그대로
    expect(cut.start).toBeCloseTo(starts[0] - 0.3, 6);
    expect(cut.dur).toBeCloseTo(pass.t1 + 0.45 - (pass.t0 - 0.3), 3);
    expect(cut.windows).toEqual(starts.map((t) => [t, t + 2]));
  });

  it('녹음이 구간보다 짧아도(앞이나 뒤가 모자라도) 깨지지 않는다', () => {
    const tZero = 1;
    const samples = new Float32Array(SR * 4).fill(0.5); // 4초치밖에 없다
    const capture = { samples, firstFrame: Math.round((5 + tZero + latency) * SR), sampleRate: SR }; // 구간 5초부터 녹음됨
    const cut = cutTake({ capture, tZero, zeros: [tZero, tZero + 0.02, tZero, tZero], plan: { from: 0, until: 14, countIn: false }, pass }, latency);
    expect(cut.samples.length).toBe(Math.round((pass.t1 + 0.45 - (pass.t0 - 0.3)) * SR));
    const at = (t: number) => cut.samples[Math.round((t - cut.start) * SR)];
    expect(at(3)).toBe(0); // 녹음 전
    expect(at(6)).toBe(0.5);
    expect(at(8.5)).toBe(0.5);
    expect(at(12)).toBe(0); // 녹음 끝난 뒤
  });
});
