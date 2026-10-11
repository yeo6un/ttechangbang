// 곡·목소리 분석: 박자(BPM), 가장 신나는 구간, 목소리 크기 통계, 음량 맞춤
import { fromDb, peak, toDb } from './dsp';

export interface Tempo {
  bpm: number;
  /** 첫 박이 떨어지는 시각(초) */
  beat0: number;
  /** 1 근처면 박자를 못 찾은 것, 클수록 뚜렷 */
  confidence: number;
}

const HOP_SEC = 0.01;

/** 소리가 갑자기 커지는 정도를 10ms 단위로 뽑는다 (박자 찾기의 재료) */
export function onsetEnvelope(mono: Float32Array, sr: number): { env: Float32Array; hopSec: number } {
  const hop = Math.max(1, Math.round(sr * HOP_SEC));
  const n = Math.floor(mono.length / hop);
  const env = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const s = i * hop;
    for (let j = 0; j < hop; j++) {
      const v = mono[s + j];
      acc += v * v;
    }
    const e = Math.log1p(1000 * Math.sqrt(acc / hop));
    env[i] = i === 0 ? 0 : Math.max(0, e - prev);
    prev = e;
  }
  return { env, hopSec: hop / sr };
}

export function detectTempo(mono: Float32Array, sr: number): Tempo {
  const { env, hopSec } = onsetEnvelope(mono, sr);
  const n = env.length;
  const none = { bpm: 0, beat0: 0, confidence: 0 };
  if (n < 400) return none;
  const maxLag = Math.min(n - 2, Math.ceil((60 / 55 / hopSec) * 4) + 2);
  const ac = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let acc = 0;
    const lim = n - lag;
    for (let i = 0; i < lim; i++) acc += env[i] * env[i + lag];
    ac[lag] = acc / lim;
  }
  const acAt = (lag: number) => {
    if (lag >= maxLag) return 0;
    const k = Math.floor(lag);
    const f = lag - k;
    return ac[k] * (1 - f) + ac[k + 1] * f;
  };
  const scoreOf = (bpm: number) => {
    const lag = 60 / bpm / hopSec;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.8, 2));
    return (acAt(lag) + 0.5 * acAt(lag * 2) + 0.25 * acAt(lag * 4)) * prior;
  };
  let best = 0;
  let bestScore = -1;
  let total = 0;
  let count = 0;
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const s = scoreOf(bpm);
    total += s;
    count++;
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  for (let bpm = best - 1; bpm <= best + 1; bpm += 0.02) {
    const s = scoreOf(bpm);
    if (s > bestScore) {
      bestScore = s;
      best = bpm;
    }
  }
  const mean = total / count;
  const period = 60 / best / hopSec;
  let bestPhase = 0;
  let bestSum = -1;
  for (let p = 0; p < period; p += 0.5) {
    let sum = 0;
    for (let t = p; t < n - 1; t += period) {
      const k = Math.floor(t);
      sum += env[k] + env[k + 1];
    }
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = p;
    }
  }
  return { bpm: Math.round(best * 10) / 10, beat0: bestPhase * hopSec, confidence: mean > 0 ? bestScore / mean : 0 };
}

/** 길이 winSec 창을 밀어 가며 소리가 가장 꽉 찬 구간의 시작 시각을 고른다 (대개 후렴) */
export function bestWindow(mono: Float32Array, sr: number, winSec: number): number {
  const frame = Math.round(sr * 0.25);
  const n = Math.floor(mono.length / frame);
  const win = Math.round(winSec / 0.25);
  if (n <= win) return 0;
  const e = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const s = i * frame;
    for (let j = 0; j < frame; j += 4) acc += mono[s + j] * mono[s + j];
    e[i + 1] = e[i] + acc;
  }
  let best = 0;
  let bestV = -1;
  for (let i = 0; i + win <= n; i++) {
    const v = e[i + win] - e[i];
    if (v > bestV) {
      bestV = v;
      best = i;
    }
  }
  // 첫 소절 전에 숨 고를 틈을 조금 둔다
  return Math.max(0, best * 0.25 - 1);
}

export interface VoiceStats {
  rmsDb: number;
  peakDb: number;
  /** 실제로 소리를 낸 시간(초) */
  voiced: number;
}

export function voiceStats(x: Float32Array, sr: number): VoiceStats {
  const frame = Math.max(1, Math.round(sr * 0.02));
  const n = Math.floor(x.length / frame);
  if (n === 0) return { rmsDb: -120, peakDb: -120, voiced: 0 };
  const levels = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const s = i * frame;
    for (let j = 0; j < frame; j++) acc += x[s + j] * x[s + j];
    levels[i] = Math.sqrt(acc / frame);
  }
  const sorted = Float32Array.from(levels).sort();
  const floor = sorted[Math.floor(n * 0.1)];
  const top = sorted[Math.floor(n * 0.95)];
  const thresh = Math.max(floor * 3, top * 0.12, fromDb(-55));
  let acc = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (levels[i] >= thresh) {
      acc += levels[i] * levels[i];
      cnt++;
    }
  }
  return { rmsDb: cnt ? toDb(Math.sqrt(acc / cnt)) : -120, peakDb: toDb(peak(x)), voiced: cnt * 0.02 };
}

/** 저역 웅웅거림을 걷어내는 1차 고역 필터 (제자리) */
export function highpass(x: Float32Array, sr: number, fc = 70): void {
  const rc = 1 / (2 * Math.PI * fc);
  const a = rc / (rc + 1 / sr);
  let py = 0;
  let px = 0;
  for (let i = 0; i < x.length; i++) {
    const y = a * (py + x[i] - px);
    px = x[i];
    py = y;
    x[i] = y;
  }
}

/** 목소리 크기를 비슷하게 맞춘다. 돌려주는 값은 적용한 증폭(dB). */
export function normalizeVoice(x: Float32Array, stats: VoiceStats, targetDb = -16): number {
  if (stats.voiced < 0.1 || stats.rmsDb < -70) return 0;
  let gainDb = Math.max(-12, Math.min(26, targetDb - stats.rmsDb));
  const headroom = -1 - stats.peakDb;
  // 잠깐 튀는 소리 때문에 전체가 작아지지 않게, 6dB 까지는 넘쳐도 부드럽게 눌러 준다
  gainDb = Math.min(gainDb, headroom + 6);
  const g = fromDb(gainDb);
  for (let i = 0; i < x.length; i++) {
    const v = x[i] * g;
    const av = Math.abs(v);
    x[i] = av <= 0.7 ? v : Math.sign(v) * (0.7 + 0.29 * Math.tanh((av - 0.7) / 0.29));
  }
  return gainDb;
}

/**
 * 반주 음량을 일정한 크기(-18dBFS 근처)로 맞춘다. 요즘 음원은 아주 크게 만들어져 있어서
 * 그대로 두면 친구들 목소리가 묻힌다. 채널들을 같은 비율로 조절하고, 적용한 배율을 돌려준다.
 */
export function normalizeBacking(channels: Float32Array[], targetDb = -18): number {
  let acc = 0;
  let pk = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 2) {
      const v = ch[i];
      acc += v * v;
      const a = Math.abs(v);
      if (a > pk) pk = a;
      n++;
    }
  }
  if (!n || pk < 1e-4) return 1;
  const rmsDb = toDb(Math.sqrt(acc / n));
  let g = fromDb(Math.max(-14, Math.min(12, targetDb - rmsDb)));
  if (pk * g > 0.98) g = 0.98 / pk;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  return g;
}

export function applyFades(x: Float32Array, sr: number, inSec = 0.015, outSec = 0.12): void {
  const a = Math.min(x.length, Math.round(inSec * sr));
  const b = Math.min(x.length, Math.round(outSec * sr));
  for (let i = 0; i < a; i++) x[i] *= i / a;
  for (let i = 0; i < b; i++) x[x.length - 1 - i] *= i / b;
}

/**
 * 내 줄이 아닌 구간의 소리를 지운다 (숨소리·새어 든 반주·다른 사람 차례에 낸 소리).
 * windows 는 [시작, 끝] 초 단위이고, x[0] 의 시각이 start 다. 앞뒤로 여유를 두고 부드럽게 여닫는다.
 */
export function gateToWindows(x: Float32Array, sr: number, start: number, windows: [number, number][], before = 0.28, after = 0.42, ramp = 0.07): void {
  const env = new Float32Array(x.length);
  const r = Math.max(1, Math.round(ramp * sr));
  for (const [t0, t1] of windows) {
    const a = Math.round((t0 - before - start) * sr);
    const b = Math.round((t1 + after - start) * sr);
    for (let i = Math.max(0, a - r); i < Math.min(x.length, b + r); i++) {
      let g = 1;
      if (i < a) g = 0.5 - 0.5 * Math.cos((Math.PI * (i - (a - r))) / r);
      else if (i > b) g = 0.5 + 0.5 * Math.cos((Math.PI * (i - b)) / r);
      if (g > env[i]) env[i] = g;
    }
  }
  for (let i = 0; i < x.length; i++) x[i] *= env[i];
}
