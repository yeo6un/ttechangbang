// 지연 보정값 고르기: ① 방금 잰 값 → ② 이 기기에서 전에 맞췄던 값 → ③ 브라우저가 알려 주는 값
import { reportedOutputLatency } from './context';
import type { LatencyEstimate } from './dsp';

const KEY = 'ttb.latency.v1';

interface Remembered {
  sec: number;
  /** 기억할 당시 브라우저가 알려 준 값 — 이어폰을 바꿔 이 값이 달라지면 그만큼 보정한다 */
  reported: number;
  at: number;
}

export interface LatencyChoice {
  sec: number;
  source: 'measured' | 'remembered' | 'reported';
  /** 반주가 마이크에 새어 들어간 크기(dB). 잰 경우에만. */
  leakDb?: number;
}

/** 브라우저가 알려 주는 왕복 지연. 값을 주지 않는 브라우저(일부 사파리)를 위해 바닥값을 둔다. */
export function reportedLatency(ctx: AudioContext, inputLatency: number): number {
  return Math.max(0.03, reportedOutputLatency(ctx) + inputLatency);
}

function load(): Remembered | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v && Number.isFinite(v.sec) && Number.isFinite(v.reported)) return v;
  } catch {
    /* 저장소를 못 쓰는 환경 */
  }
  return null;
}

export function rememberLatency(sec: number, reported: number): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ sec, reported, at: Date.now() } satisfies Remembered));
  } catch {
    /* 무시 */
  }
}

export function chooseLatency(est: LatencyEstimate | null, reported: number): LatencyChoice {
  if (est?.ok) return { sec: est.delaySec, source: 'measured', leakDb: est.gainDb };
  const mem = load();
  if (mem) {
    const adjusted = mem.sec + (reported - mem.reported);
    return { sec: Math.max(0, Math.min(1, adjusted)), source: 'remembered', leakDb: est && est.confidence > 5 ? est.gainDb : undefined };
  }
  return { sec: Math.max(0, Math.min(1, reported)), source: 'reported' };
}

const BIAS_KEY = 'ttb.bias.v1';

/**
 * 자동으로 잰 싱크가 맞는데도 사용자가 일부러 옮긴 값(ms). 박자를 살짝 늦게 타는 사람은 매번 같은 만큼 옮기게 되므로
 * 기억해 뒀다가 다음 녹음의 막대 시작 위치로 쓴다.
 */
export function userBias(): number {
  try {
    const v = Number(localStorage.getItem(BIAS_KEY));
    return Number.isFinite(v) ? Math.max(-300, Math.min(300, Math.round(v / 10) * 10)) : 0;
  } catch {
    return 0;
  }
}

export function setUserBias(ms: number): void {
  try {
    localStorage.setItem(BIAS_KEY, String(ms));
  } catch {
    /* 무시 */
  }
}

/** 싱크 맞추기용 시험 신호: 2.4초짜리 잡음 묶음 (스피커·이어폰을 마이크에 대고 재는 용도) */
export function calibrationSignal(sr: number): Float32Array {
  const n = Math.round(sr * 2.4);
  const out = new Float32Array(n);
  let seed = 90210;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const w = seed / 0x80000000 - 1;
    lp += 0.25 * (w - lp);
    const t = i / sr;
    // 0.3초 간격으로 "칙 칙" 끊어지는 소리
    const burst = t % 0.3 < 0.18 ? 1 : 0;
    const edge = Math.min(1, t * 20, (2.4 - t) * 20);
    out[i] = 0.28 * burst * edge * (w - lp * 0.6);
  }
  return out;
}

/**
 * 화면(가사 색칠·카운트다운)을 소리에 맞추기 위한 재생 쪽 지연 추정.
 * 재 둔 왕복 지연이 있으면 거기서 마이크 쪽 몫(대략 0.02초)을 뺀 값을, 없으면 브라우저가 알려 준 값을 쓴다.
 */
export function displayLatency(reportedOutput: number, reportedTotal: number): number {
  const mem = load();
  if (!mem) return reportedOutput;
  const total = mem.sec + (reportedTotal - mem.reported);
  return Math.max(reportedOutput, Math.min(0.6, total - 0.02));
}
