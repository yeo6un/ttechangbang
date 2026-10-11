// 유튜브 영상과 우리 소리를 맞추는 시계 계산.
//
// 유튜브 영상의 소리는 우리가 직접 만질 수 없어서(다른 사이트의 플레이어 안에 있다), 파일 반주처럼
// "같은 오디오 시계에 올려 한 샘플 단위로 맞추는" 방법을 쓸 수 없다. 대신 두 가지 차이값을 계속 재서 맞춘다.
//   D = 영상 위치 − 벽시계      (영상이 지금 몇 초를 들려주고 있는지)
//   A = 소리 시계 − 벽시계      (우리 AudioContext 의 몇 초가 지금 귀에 들리고 있는지)
// 그러면 "구간 s 초가 귀에 들리는 순간의 소리 시계" = s + (구간 시작 − D + A) 가 된다.
// 이 괄호 안의 값을 tZero 라 부르고, 녹음을 자를 때와 목소리를 깔 때 모두 이 값을 쓴다.
// 벽시계는 performance.now() (초 단위로 바꿔서) 를 쓴다.

export interface TrackerOptions {
  /** 이 안에 모여 있는 표본만 같은 값으로 본다 (초) */
  tol: number;
  /** 값을 믿기 시작하는 데 필요한 표본 수와 시간 폭 */
  minSamples: number;
  minSpan: number;
  /** 최근 이만큼의 표본만 쓴다 (초) */
  window: number;
  /**
   * median: 표본이 참값 둘레에 고르게 흩어질 때.
   * upper: 표본이 참값보다 작게만 나올 때(계단처럼 가끔씩만 바뀌는 시계를 읽은 경우) — 위쪽 값을 고른다.
   */
  mode: 'median' | 'upper';
}

interface Sample {
  t: number;
  v: number;
}

/** 잡음 섞인 표본들에서 두 시계의 차이를 안정적으로 뽑아낸다. 값이 갑자기 옮겨 가면(탐색·버퍼링) 알아채고 새로 잡는다. */
export class OffsetTracker {
  private samples: Sample[] = [];
  private strikes: Sample[] = [];
  private _value = NaN;
  private _locked = false;
  /** 값이 옮겨 간 횟수 */
  jumps = 0;

  constructor(private readonly o: TrackerOptions) {}

  get locked(): boolean {
    return this._locked;
  }
  get value(): number {
    return this._value;
  }
  get count(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples = [];
    this.strikes = [];
    this._value = NaN;
    this._locked = false;
  }

  /** t: 표본을 얻은 시각(초), v: 그때의 차이값 */
  add(t: number, v: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    if (this._locked) {
      if (Math.abs(v - this._value) > this.o.tol) {
        // 한 번 튄 값은 버린다. 튄 값끼리 서로 맞으면 시계가 정말 옮겨 간 것이다.
        this.strikes.push({ t, v });
        const n = this.strikes.length;
        if (n >= 2 && Math.abs(this.strikes[n - 1].v - this.strikes[n - 2].v) <= this.o.tol) {
          this.samples = this.strikes.slice(-2);
          this.relock();
        } else if (n >= 4) {
          this.samples = this.strikes.slice(-1);
          this.relock();
        }
        return;
      }
      this.strikes = [];
      this.samples.push({ t, v });
      while (this.samples.length > 3 && t - this.samples[0].t > this.o.window) this.samples.shift();
      this._value = this.pick(this.samples);
      return;
    }
    // 아직 못 잡았을 때: 가장 새 표본과 같은 무리만 남긴다 (탐색 직후의 낡은 표본을 털어 낸다)
    this.samples.push({ t, v });
    this.samples = this.samples.filter((s) => Math.abs(s.v - v) <= this.o.tol && t - s.t <= this.o.window);
    this._value = this.pick(this.samples);
    const span = t - this.samples[0].t;
    if (this.samples.length >= this.o.minSamples && span >= this.o.minSpan) this._locked = true;
  }

  private relock(): void {
    this.strikes = [];
    this._locked = false;
    this.jumps++;
    this._value = this.pick(this.samples);
  }

  private pick(list: Sample[]): number {
    if (!list.length) return NaN;
    const vs = list.map((s) => s.v).sort((a, b) => a - b);
    if (this.o.mode === 'upper') return vs[Math.min(vs.length - 1, Math.floor(vs.length * 0.9))];
    const mid = vs.length >> 1;
    return vs.length % 2 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
  }
}

/** 영상 시계: 유튜브 플레이어가 알려 주는 (영상 위치, 그 순간의 벽시계) 표본으로 D 를 잡는다 */
export class MediaClock {
  private tr = new OffsetTracker({ tol: 0.045, minSamples: 3, minSpan: 0.3, window: 8, mode: 'median' });
  private last: { media: number; perf: number } | null = null;
  private _playing = false;
  /** 탐색 직후 잠깐은, 탐색 전 위치를 알리는 늦은 표본이 섞여 들어올 수 있다 */
  private expect: { media: number; perf: number } | null = null;

  get playing(): boolean {
    return this._playing;
  }

  setPlaying(on: boolean): void {
    if (on === this._playing) return;
    // 멈춘 동안에도 마지막 위치는 기억해 둔다
    if (!on && this.last) this.last = { media: this.mediaAt(performance.now()), perf: performance.now() };
    this._playing = on;
    this.tr.reset();
  }

  /** media: 영상 위치(초), perfMs: 그 위치였던 순간 (performance.now 기준 ms) */
  feed(media: number, perfMs: number): void {
    if (!Number.isFinite(media) || !Number.isFinite(perfMs)) return;
    if (this.expect) {
      const since = (perfMs - this.expect.perf) / 1000;
      if (since > 2) this.expect = null;
      else if (media < this.expect.media - 0.6 || media > this.expect.media + Math.max(0, since) + 1) return;
    }
    if (this._playing) this.tr.add(perfMs / 1000, media - perfMs / 1000);
    if (!this.last || perfMs >= this.last.perf || !this._playing) this.last = { media, perf: perfMs };
  }

  /** 탐색을 시켰을 때: 낡은 표본을 버리고 새 위치를 임시로 기억한다 */
  noteSeek(media: number, perfMs: number): void {
    this.tr.reset();
    this.last = { media, perf: perfMs };
    this.expect = { media, perf: perfMs };
  }

  get locked(): boolean {
    return this._playing && this.tr.locked;
  }
  /** D: 영상 위치 = 벽시계(초) + D */
  get offset(): number {
    return this.tr.value;
  }
  get jumps(): number {
    return this.tr.jumps;
  }

  /** 그 순간 귀에 들리는 영상 위치 */
  mediaAt(perfMs: number): number {
    if (this.locked) return perfMs / 1000 + this.tr.value;
    if (!this.last) return 0;
    // 아직 못 잡았으면 마지막 표본에서 이어 간다. 탐색 직후에는 영상이 실제로 돌기 전이라 멈춰 둔다.
    return this._playing && this.tr.count > 0 ? this.last.media + (perfMs - this.last.perf) / 1000 : this.last.media;
  }
}

export interface AudioClockSource {
  readonly currentTime: number;
  readonly state?: string;
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
  readonly outputLatency?: number;
  readonly baseLatency?: number;
}

/** 소리 시계: 우리 AudioContext 의 몇 초가 지금 귀에 들리고 있는지(A)를 잡는다 */
export class AudioWallClock {
  private stamp = new OffsetTracker({ tol: 0.03, minSamples: 4, minSpan: 0.15, window: 6, mode: 'median' });
  private stairs = new OffsetTracker({ tol: 0.09, minSamples: 6, minSpan: 0.25, window: 3, mode: 'upper' });
  private stampFails = 0;

  constructor(private readonly ctx: AudioClockSource) {}

  private reported(): number {
    const base = Number.isFinite(this.ctx.baseLatency) ? (this.ctx.baseLatency as number) : 0;
    const out = Number.isFinite(this.ctx.outputLatency) ? (this.ctx.outputLatency as number) : 0;
    return Math.max(0, base + out);
  }

  /** 자주(초당 열 번쯤) 불러 표본을 모은다 */
  sample(perfMs: number = performance.now()): void {
    if (this.ctx.state && this.ctx.state !== 'running') return;
    const cur = this.ctx.currentTime;
    if (!(cur > 0)) return;
    const now = perfMs / 1000;
    // ① 브라우저가 "지금 스피커로 나가는 위치"를 직접 알려 주는 경우
    let ok = false;
    try {
      const ts = this.ctx.getOutputTimestamp?.();
      const c = ts?.contextTime;
      const p = ts?.performanceTime;
      if (typeof c === 'number' && typeof p === 'number' && c > 0 && p > 0 && Math.abs(perfMs - p) < 1500 && c <= cur + 0.05 && c > cur - 2) {
        let v = c - p / 1000;
        // 재생 지연을 반영하지 않은 값(처리 위치 그대로)을 주는 브라우저라면 알려 준 지연만큼 빼 준다
        const implied = cur - (c + (perfMs - p) / 1000);
        if (implied < 0.003 && this.reported() > 0.015) v -= this.reported();
        this.stamp.add(now, v);
        ok = true;
      }
    } catch {
      /* 아래 방법으로 */
    }
    if (!ok) this.stampFails++;
    // ② 처리 위치(currentTime)에서 알려 준 재생 지연을 뺀 값. currentTime 은 계단처럼 올라가므로 위쪽 값을 쓴다.
    this.stairs.add(now, cur - now - this.reported());
  }

  private get best(): OffsetTracker {
    return this.stamp.locked || (this.stamp.count > 0 && this.stampFails < 5) ? this.stamp : this.stairs;
  }

  get locked(): boolean {
    return this.best.locked;
  }
  /** A: 귀에 들리는 소리 시계 위치 = 벽시계(초) + A */
  get offset(): number {
    return this.best.value;
  }
  /** 처리 위치가 귀에 들리는 위치보다 얼마나 앞서 있는지 (재생 지연의 추정값) */
  ahead(perfMs: number = performance.now()): number {
    if (!this.locked) return this.reported();
    return Math.max(0, this.ctx.currentTime - (perfMs / 1000 + this.offset));
  }
  reset(): void {
    this.stamp.reset();
    this.stairs.reset();
    this.stampFails = 0;
  }
}

/** 구간 0초가 귀에 들리는 순간의 소리 시계 값 */
export const tZeroOf = (segStart: number, mediaOffset: number, audioOffset: number) => segStart - mediaOffset + audioOffset;

export interface ZeroLog {
  /** 구간 위치(초) */
  pos: number;
  /** 그때 잰 tZero */
  k: number;
}

export interface ZeroFit {
  tZero: number;
  /** 잰 값들이 흩어진 정도(초). 크면 영상이 끊겼거나 시계가 흔들린 것이다. */
  spread: number;
  n: number;
}

/** 녹음하는 동안 모아 둔 tZero 기록에서, 실제로 부른 구간의 대푯값을 고른다 */
export function fitZero(log: ZeroLog[], t0: number, t1: number): ZeroFit | null {
  let use = log.filter((e) => e.pos >= t0 - 1 && e.pos <= t1 + 0.6 && Number.isFinite(e.k));
  if (use.length < 4) use = log.filter((e) => Number.isFinite(e.k));
  if (use.length < 3) return null;
  const ks = use.map((e) => e.k).sort((a, b) => a - b);
  const at = (q: number) => ks[Math.min(ks.length - 1, Math.max(0, Math.round(q * (ks.length - 1))))];
  return { tZero: at(0.5), spread: at(0.95) - at(0.05), n: ks.length };
}
