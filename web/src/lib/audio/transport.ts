// 재생 엔진: 반주 + 여러 사람의 녹음을 같은 시계에 올려 함께 튼다. 완성본 뽑기(오프라인 렌더)도 같은 배선을 쓴다.
import { reportedOutputLatency } from './context';

export interface PlayTake {
  id: string;
  seat: number;
  buffer: AudioBuffer;
  /** 구간 기준 시작 시각(초) — 싱크 조절값까지 더한 값 */
  start: number;
  gain: number;
}

export interface MixSettings {
  /** 반주 크기 0~1.5 */
  backing: number;
  /** 자리별 목소리 크기 (없으면 1) */
  seats: Record<number, number>;
  /** 노래방 에코 0~1 */
  echo: number;
}

export const DEFAULT_MIX: MixSettings = { backing: 0.8, seats: {}, echo: 0.18 };
/** 유튜브 영상은 파일 반주보다 크게 들려서 처음 크기를 조금 낮게 잡는다 */
export const DEFAULT_YT_MIX: MixSettings = { backing: 0.6, seats: {}, echo: 0.18 };

/** 방의 반주와 녹음을 함께 트는 재생기. 파일 반주(Transport)와 유튜브 반주(YtDeck)가 같은 모양을 갖는다. */
export interface Deck {
  readonly ctx: AudioContext;
  readonly duration: number;
  readonly playing: boolean;
  setTakes(takes: PlayTake[]): void;
  setMix(mix: MixSettings): void;
  /** 파일 반주는 바로 시작하고, 유튜브 반주는 영상이 실제로 돌기 시작하면 끝나는 약속을 돌려준다 */
  play(from: number, opts?: PlayOptions): number | Promise<number>;
  pause(): void;
  stop(): void;
  seek(pos: number): void;
  rawPosition(): number;
  position(): number;
  dispose(): void;
}

export interface Graph {
  backingGain: GainNode;
  seatGains: Map<number, GainNode>;
  voiceBus: GainNode;
  wet: GainNode;
  master: GainNode;
}

let impulseCache: { sr: number; buf: AudioBuffer } | null = null;

function impulse(ctx: BaseAudioContext): AudioBuffer {
  if (impulseCache && impulseCache.sr === ctx.sampleRate) return impulseCache.buf;
  const len = Math.round(ctx.sampleRate * 1.4);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  let seed = 4321;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x80000000 - 1;
  };
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / ctx.sampleRate;
      // 초반 반사음 몇 개 + 부드럽게 사그라드는 꼬리
      d[i] = rand() * Math.exp(-t * 4.2) * (t < 0.012 ? t / 0.012 : 1) * 0.5;
    }
  }
  impulseCache = { sr: ctx.sampleRate, buf };
  return buf;
}

export function buildGraph(ctx: BaseAudioContext, mix: MixSettings, dest: AudioNode): Graph {
  const master = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 6;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.2;
  master.connect(limiter).connect(dest);
  const backingGain = ctx.createGain();
  backingGain.gain.value = mix.backing;
  backingGain.connect(master);
  const voiceBus = ctx.createGain();
  voiceBus.connect(master);
  const conv = ctx.createConvolver();
  conv.buffer = impulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = mix.echo;
  voiceBus.connect(conv).connect(wet).connect(master);
  return { backingGain, seatGains: new Map(), voiceBus, wet, master };
}

export function seatGain(ctx: BaseAudioContext, g: Graph, mix: MixSettings, seat: number): GainNode {
  let node = g.seatGains.get(seat);
  if (!node) {
    node = ctx.createGain();
    node.gain.value = mix.seats[seat] ?? 1;
    node.connect(g.voiceBus);
    g.seatGains.set(seat, node);
  }
  return node;
}

export function scheduleTakes(ctx: BaseAudioContext, g: Graph, mix: MixSettings, takes: PlayTake[], tZero: number, from: number, sources: AudioScheduledSourceNode[]) {
  for (const t of takes) {
    const end = t.start + t.buffer.duration;
    if (end <= from) continue;
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    const tg = ctx.createGain();
    tg.gain.value = t.gain;
    src.connect(tg).connect(seatGain(ctx, g, mix, t.seat));
    if (t.start >= from) src.start(tZero + t.start);
    else src.start(tZero + from, from - t.start);
    sources.push(src);
  }
}

function clickBuffer(ctx: BaseAudioContext, high: boolean): AudioBuffer {
  const len = Math.round(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const f = high ? 1568 : 1046;
  for (let i = 0; i < len; i++) {
    const t = i / ctx.sampleRate;
    d[i] = 0.5 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 70);
  }
  return buf;
}

/** 카운트(박자 세는 소리)를 넣을 위치들: 0초 전 3번 */
export const COUNT_IN = [-3, -2, -1];

export interface PlayOptions {
  /** 이 위치에서 멈춘다 (기본: 곡 끝) */
  until?: number;
  /** 녹음을 같이 틀지 (기본 true) */
  withTakes?: boolean;
  /** from 이 음수일 때 박자 세는 소리를 넣는다 */
  countIn?: boolean;
  onEnd?: () => void;
}

interface TestHooks {
  onGraph?: (master: AudioNode, ctx: AudioContext) => void;
  onPlay?: (info: { tZero: number; from: number; until: number }) => void;
}
const hooks = () => (window as unknown as { __ttbTest?: TestHooks }).__ttbTest;

export class Transport implements Deck {
  private graph: Graph;
  private sources: AudioScheduledSourceNode[] = [];
  private timer = 0;
  private song: AudioBuffer | null = null;
  private takes: PlayTake[] = [];
  private mix: MixSettings = DEFAULT_MIX;
  private _playing = false;
  /** 구간 0초가 나오는 컨텍스트 시각 */
  tZero = 0;
  private from = 0;
  private until = 0;
  private pausedAt = 0;
  private onEnd: (() => void) | undefined;
  private lastOpts: PlayOptions = {};
  /** 화면 표시를 늦추는 값(초). 재 둔 실제 지연이 있으면 브라우저가 알려 준 값 대신 쓴다. */
  displayLatency: number | null = null;

  constructor(readonly ctx: AudioContext) {
    this.graph = buildGraph(ctx, this.mix, ctx.destination);
    hooks()?.onGraph?.(this.graph.master, ctx);
  }

  get duration(): number {
    return this.song?.duration ?? 0;
  }
  get playing(): boolean {
    return this._playing;
  }

  setSong(buffer: AudioBuffer | null): void {
    this.song = buffer;
  }
  setTakes(takes: PlayTake[]): void {
    this.takes = takes;
  }

  setMix(mix: MixSettings): void {
    this.mix = mix;
    const now = this.ctx.currentTime;
    this.graph.backingGain.gain.setTargetAtTime(mix.backing, now, 0.03);
    this.graph.wet.gain.setTargetAtTime(mix.echo, now, 0.03);
    for (const [seat, node] of this.graph.seatGains) node.gain.setTargetAtTime(mix.seats[seat] ?? 1, now, 0.03);
  }

  /** from(초, 음수 가능) 위치부터 재생. 돌려주는 tZero 로 녹음 위치를 계산한다. */
  play(from: number, opts: PlayOptions = {}): number {
    this.stopSources();
    const ctx = this.ctx;
    const dur = this.duration;
    const until = Math.min(opts.until ?? dur, dur);
    const startAt = ctx.currentTime + 0.12;
    const tZero = startAt - from;
    this.tZero = tZero;
    this.from = from;
    this.until = until;
    this.onEnd = opts.onEnd;
    this.lastOpts = opts;
    if (this.song && until > Math.max(0, from)) {
      const src = ctx.createBufferSource();
      src.buffer = this.song;
      src.connect(this.graph.backingGain);
      const offset = Math.max(0, from);
      src.start(tZero + offset, offset, until - offset);
      this.sources.push(src);
    }
    if (opts.countIn && from < 0) {
      for (const p of COUNT_IN) {
        if (p < from) continue;
        const c = ctx.createBufferSource();
        c.buffer = clickBuffer(ctx, p === COUNT_IN[COUNT_IN.length - 1]);
        c.connect(this.graph.master);
        c.start(tZero + p);
        this.sources.push(c);
      }
    }
    if (opts.withTakes !== false) scheduleTakes(ctx, this.graph, this.mix, this.takes, tZero, Math.max(0, from), this.sources);
    this._playing = true;
    hooks()?.onPlay?.({ tZero, from, until });
    window.clearTimeout(this.timer);
    const check = () => {
      if (!this._playing) return;
      const remain = tZero + until - ctx.currentTime;
      if (remain <= 0.005) {
        this.pausedAt = until >= dur - 0.01 ? 0 : until;
        this.stopSources();
        const cb = this.onEnd;
        this.onEnd = undefined;
        cb?.();
      } else {
        this.timer = window.setTimeout(check, Math.min(250, remain * 1000 + 5));
      }
    };
    this.timer = window.setTimeout(check, 100);
    return tZero;
  }

  private stopSources(): void {
    window.clearTimeout(this.timer);
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* 이미 끝남 */
      }
    }
    this.sources = [];
    this._playing = false;
  }

  /** 멈추고 지금 위치를 기억한다 */
  pause(): void {
    if (this._playing) this.pausedAt = Math.max(0, Math.min(this.duration, this.rawPosition()));
    this.onEnd = undefined;
    this.stopSources();
  }

  stop(): void {
    this.onEnd = undefined;
    this.stopSources();
    this.pausedAt = 0;
  }

  seek(pos: number): void {
    const p = Math.max(0, Math.min(this.duration, pos));
    if (this._playing) this.play(p, { ...this.lastOpts, onEnd: this.onEnd, countIn: false });
    else this.pausedAt = p;
  }

  /** 스피커로 내보낸 기준의 위치 */
  rawPosition(): number {
    if (!this._playing) return this.pausedAt;
    return Math.min(this.until, Math.max(this.from, this.ctx.currentTime - this.tZero));
  }

  /** 지금 귀에 들리는 위치 (화면 표시용) */
  position(): number {
    if (!this._playing) return this.pausedAt;
    const lag = this.displayLatency ?? reportedOutputLatency(this.ctx);
    return Math.min(this.until, Math.max(this.from, this.ctx.currentTime - this.tZero - lag));
  }

  dispose(): void {
    this.stop();
    try {
      this.graph.master.disconnect();
    } catch {
      /* 무시 */
    }
  }
}

/** 완성본을 파일로 뽑기 위해 실제 시간보다 빠르게 섞는다 */
export async function renderMix(song: AudioBuffer | null, takes: PlayTake[], mix: MixSettings, sampleRate = 44100, duration = song?.duration ?? 0): Promise<AudioBuffer> {
  const tail = 1.2;
  const length = Math.ceil((Math.max(duration, 1) + tail) * sampleRate);
  const off = new OfflineAudioContext(2, length, sampleRate);
  const g = buildGraph(off, mix, off.destination);
  if (song) {
    const src = off.createBufferSource();
    src.buffer = song;
    src.connect(g.backingGain);
    src.start(0);
  }
  scheduleTakes(off, g, mix, takes, 0, 0, []);
  const out = await off.startRendering();
  // 파일에서는 소리가 넘쳐 깨지지 않게 전체 크기를 맞춘다. MP3 로 줄이면 꼭대기가 조금 더 솟을 수 있어서
  // 가장 큰 순간을 -1.5dB 에 둔다 (너무 작으면 9dB 까지 키움)
  let pk = 0;
  for (let c = 0; c < out.numberOfChannels; c++) {
    const d = out.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > pk) pk = v;
    }
  }
  if (pk > 1e-4) {
    const gain = Math.min(2.8, 0.84 / pk);
    for (let c = 0; c < out.numberOfChannels; c++) {
      const d = out.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= gain;
    }
  }
  return out;
}

/** 녹음 구간 동안 실제로 내보낸 소리(모노)를 다시 만든다 — 지연 측정의 기준 신호 */
export function playedReference(song: AudioBuffer | null, sr: number, firstFrame: number, length: number, tZero: number, from: number, until: number, countIn: boolean): Float32Array {
  const ref = new Float32Array(length);
  const zeroFrame = Math.round(tZero * sr);
  if (song) {
    const chans = Array.from({ length: song.numberOfChannels }, (_, i) => song.getChannelData(i));
    const lo = Math.max(0, from);
    const ratio = song.sampleRate / sr;
    for (let i = 0; i < length; i++) {
      const pos = (firstFrame + i) / sr - tZero;
      if (pos < lo || pos >= until) continue;
      const p = Math.round((firstFrame + i - zeroFrame) * ratio);
      if (p < 0 || p >= song.length) continue;
      let v = 0;
      for (const c of chans) v += c[p];
      ref[i] = v / chans.length;
    }
  }
  if (countIn && from < 0) {
    for (const p of COUNT_IN) {
      if (p < from) continue;
      const f = p === COUNT_IN[COUNT_IN.length - 1] ? 1568 : 1046;
      const start = zeroFrame + Math.round(p * sr) - firstFrame;
      const len = Math.round(sr * 0.05);
      for (let k = 0; k < len; k++) {
        const i = start + k;
        if (i < 0 || i >= length) continue;
        const t = k / sr;
        ref[i] += 0.5 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 70);
      }
    }
  }
  return ref;
}
