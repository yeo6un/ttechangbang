// 녹음 한 번(Capture)을 구간 시간에 맞춰 잘라 내고, 다듬어서 올릴 수 있는 모양으로 만든다.
import type { Pass } from '../parts';
import { applyFades, gateToWindows, highpass, normalizeVoice, voiceStats, type VoiceStats } from './analysis';
import { encodeWithLead } from './codec';
import { estimateLatency, type LatencyEstimate } from './dsp';
import { LEAD_SEC } from './marker';
import { bytesToBase64, computePeaks } from './peaks';
import type { Capture } from './recorder';
import { playedReference } from './transport';

/** 파트 시작 전에 미리 틀어 주는 길이(초) */
export const PRE_ROLL = 4;
/** 파트가 끝난 뒤 반주를 조금 더 트는 길이 */
export const POST_ROLL = 0.5;
/** 반주가 멈춘 뒤에도 마이크는 조금 더 받는다 (지연만큼 늦게 들어오는 소리까지 담으려고) */
export const TAIL_CAPTURE = 0.8;
const MARGIN_BEFORE = 0.3;
const MARGIN_AFTER = 0.45;

export interface PassPlan {
  /** 재생 시작 위치 (음수면 그만큼 카운트만 나온다) */
  from: number;
  until: number;
  countIn: boolean;
}

export function planPass(pass: Pass, songDur: number, yt?: { start: number }): PassPlan {
  if (yt) {
    // 유튜브 반주: 구간 앞쪽의 영상을 미리 틀 수 있지만 영상 맨 앞보다 앞으로는 못 간다. 박자 세는 소리는 넣지 않는다.
    return { from: Math.max(-yt.start, pass.t0 - PRE_ROLL), until: Math.min(songDur + POST_ROLL, pass.t1 + POST_ROLL), countIn: false };
  }
  const from = pass.t0 - PRE_ROLL;
  return {
    from,
    until: Math.min(songDur, pass.t1 + POST_ROLL),
    // 앞에 들을 반주가 2초도 안 되면 박자 세는 소리를 넣어 준다
    countIn: pass.t0 < 2,
  };
}

export interface RawTake {
  capture: Capture;
  /** 구간 0초가 나온 컨텍스트 시각 */
  tZero: number;
  /**
   * (유튜브 반주) 줄마다 따로 잰 tZero, pass.lines 순서대로.
   * 부르는 도중에 영상과 우리 소리 시계의 차이가 옮겨 갔을 때 각 줄을 제자리에 놓으려는 것이다.
   */
  zeros?: number[];
  plan: PassPlan;
  pass: Pass;
}

/** 녹음에 새어 들어간 반주로 실제 지연을 잰다 */
export function measureLatency(raw: RawTake, song: AudioBuffer | null): LatencyEstimate {
  const { capture, tZero, plan } = raw;
  const ref = playedReference(song, capture.sampleRate, capture.firstFrame, capture.samples.length, tZero, plan.from, plan.until, plan.countIn);
  return estimateLatency(ref, capture.samples, capture.sampleRate);
}

export interface CutTake {
  samples: Float32Array;
  sampleRate: number;
  /** 구간 기준 시작 시각(초) */
  start: number;
  dur: number;
  /** 내가 부르는 줄들의 [시작, 끝] */
  windows: [number, number][];
}

/** 지연(latencySec)만큼 당겨서, 파트 구간(+여유)만 잘라 낸다 */
export function cutTake(raw: RawTake, latencySec: number): CutTake {
  const { capture, tZero, pass } = raw;
  const sr = capture.sampleRate;
  if (raw.zeros && raw.zeros.length === pass.lines.length && raw.zeros.some((z) => z !== tZero)) return cutByLines(raw, raw.zeros, latencySec);
  // samples[i] 가 실제로 불린 구간 시각 = (firstFrame + i)/sr - tZero - latency
  const indexOf = (segTime: number) => Math.round((segTime + tZero + latencySec) * sr) - capture.firstFrame;
  const a = Math.max(0, indexOf(pass.t0 - MARGIN_BEFORE));
  const b = Math.min(capture.samples.length, indexOf(pass.t1 + MARGIN_AFTER));
  const samples = capture.samples.slice(a, Math.max(a + 1, b));
  const start = (capture.firstFrame + a) / sr - tZero - latencySec;
  return { samples, sampleRate: sr, start, dur: samples.length / sr, windows: pass.lines.map((l) => [l.t0, l.t1]) };
}

/**
 * 줄마다 다른 tZero 로 잘라 이어 붙인다. 줄과 줄 사이(조용한 곳)의 한가운데에서 값을 바꾼다.
 * 결과는 구간 시각으로 끊김 없이 이어진 한 덩어리다.
 */
function cutByLines(raw: RawTake, zeros: number[], latencySec: number): CutTake {
  const { capture, pass } = raw;
  const sr = capture.sampleRate;
  const lines = pass.lines;
  const startSeg = pass.t0 - MARGIN_BEFORE;
  const endSeg = pass.t1 + MARGIN_AFTER;
  const total = Math.max(1, Math.round((endSeg - startSeg) * sr));
  const samples = new Float32Array(total);
  for (let i = 0; i < lines.length; i++) {
    const segFrom = i === 0 ? startSeg : (lines[i - 1].t1 + lines[i].t0) / 2;
    const segTo = i + 1 < lines.length ? (lines[i].t1 + lines[i + 1].t0) / 2 : endSeg;
    const outFrom = Math.max(0, Math.round((segFrom - startSeg) * sr));
    const outTo = Math.min(total, Math.round((segTo - startSeg) * sr));
    // samples[n] 이 불린 구간 시각 = startSeg + n/sr  ↔  녹음의 (그 시각 + tZero + 지연) 자리
    const shift = Math.round((startSeg + zeros[i] + latencySec) * sr) - capture.firstFrame;
    const a = Math.max(outFrom, -shift);
    const b = Math.min(outTo, capture.samples.length - shift);
    if (b > a) samples.set(capture.samples.subarray(a + shift, b + shift), a);
  }
  return { samples, sampleRate: sr, start: startSeg, dur: total / sr, windows: lines.map((l) => [l.t0, l.t1]) };
}

export interface FinalTake {
  bytes: Uint8Array;
  start: number;
  dur: number;
  lead: number;
  peaks: string;
  stats: VoiceStats & { gainDb: number };
}

/** 다듬기(저역 정리 → 내 줄 밖 소리 지우기 → 음량 맞춤 → 앞뒤 페이드) 후 MP3 로 */
export async function finishTake(cut: CutTake): Promise<FinalTake & { processed: Float32Array }> {
  const x = cut.samples.slice();
  highpass(x, cut.sampleRate, 70);
  gateToWindows(x, cut.sampleRate, cut.start, cut.windows);
  const stats = voiceStats(x, cut.sampleRate);
  const gainDb = normalizeVoice(x, stats);
  applyFades(x, cut.sampleRate);
  const bytes = await encodeWithLead([x], cut.sampleRate, 5);
  const buckets = Math.max(8, Math.min(900, Math.round(cut.dur * 25)));
  return {
    bytes,
    start: cut.start,
    dur: cut.dur,
    lead: LEAD_SEC,
    peaks: bytesToBase64(computePeaks(x, buckets)),
    stats: { ...stats, gainDb },
    processed: x,
  };
}

/** 미리듣기용: 다듬은 소리를 바로 재생할 수 있는 버퍼로 */
export function toBuffer(ctx: BaseAudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
  buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  return buf;
}
