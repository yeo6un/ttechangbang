// 유튜브 반주용 재생기: 영상은 유튜브 플레이어가 틀고, 친구들의 목소리는 우리가 영상 시계에 맞춰 깐다.
// 파일 반주용 Transport 와 같은 모양(Deck)이라 화면 쪽에서는 거의 같은 방식으로 쓴다.
import { buildGraph, DEFAULT_YT_MIX, scheduleTakes, type Deck, type Graph, type MixSettings, type PlayOptions, type PlayTake } from '../audio/transport';
import { AudioWallClock, fitZero, fitZeroLines, tZeroOf, type ZeroFit, type ZeroLines, type ZeroLog } from './clock';
import { YT, YtError, type YtPlayer } from './player';

export interface YtSeg {
  /** 영상 안에서 구간 0초의 위치(초) */
  start: number;
  /** 구간 길이(초) */
  dur: number;
  /** 영상 전체 길이(초). 알고 있으면 넣는다: 영상 앞에 붙은 광고가 도는 동안을 가려내는 데 쓴다. */
  len?: number;
}

export type DeckEvent =
  | { type: 'ready' } // 영상이 실제로 돌기 시작해 싱크를 잡았다
  | { type: 'needTap'; on: boolean } // 브라우저가 막아서 사용자가 영상을 직접 눌러 줘야 한다
  | { type: 'stall' } // 영상이 버퍼링으로 멈칫했다
  | { type: 'resume' }
  | { type: 'paused' } // 사용자가 영상을 직접 눌러 멈췄다
  | { type: 'failed'; error: YtError };

type Phase = 'idle' | 'starting' | 'playing' | 'stalled';

interface TestHooks {
  /** 목소리를 영상에 맞춰 깔 때마다 알려 준다 (자동 테스트가 싱크를 확인하는 자리) */
  onYtVoices?: (info: { tZero: number; from: number; segStart: number; starts: number[] }) => void;
}
const hooks = () => (window as unknown as { __ttbTest?: TestHooks }).__ttbTest;

/** 문제가 생겼을 때 화면에 보여 줄 진단 값 */
export interface DeckDebug {
  state: number;
  phase: string;
  mediaLocked: boolean;
  audioLocked: boolean;
  /** 영상 위치를 무엇으로 받고 있는지 */
  timeSource: string;
  /** 소리 시계가 귀에 들리는 위치보다 앞서 있는 정도(ms) */
  aheadMs: number;
  jumps: number;
  stalls: number;
  resyncs: number;
  /** 플레이어가 알려 주는 영상 길이 / 우리가 아는 영상 길이 (초) */
  videoLen: number;
  wantLen: number;
}

/** 목소리가 영상에서 이만큼 밀리면 다시 맞춘다 (초) */
const RESYNC = 0.03;
const TICK = 80;
/** 플레이어가 알려 주는 길이가 우리가 아는 영상 길이와 이만큼 넘게 다르면, 지금 도는 것은 다른 것(광고)이다 (초) */
const LEN_TOL = 2.5;
/** 그런데 이만큼 기다려도 그대로면 영상 자체가 바뀐 것으로 보고 더 따지지 않는다 (ms) */
const AD_WAIT = 60_000;

export class YtDeck implements Deck {
  private graph: Graph;
  private sources: AudioScheduledSourceNode[] = [];
  private takes: PlayTake[] = [];
  private mix: MixSettings = DEFAULT_YT_MIX;
  private audio: AudioWallClock;
  private timer = 0;
  private phase: Phase = 'idle';
  private from = 0;
  private until = 0;
  private withTakes = true;
  private onEnd: (() => void) | undefined;
  private pausedAt = 0;
  private scheduledZero = NaN;
  /** 재생을 누른 때 / 마지막으로 위치를 옮기라고 한 때 (ms) */
  private startAt = 0;
  private reqAt = 0;
  private stallAt = 0;
  /** 영상 길이가 저장해 둔 값과 정말 달라져 있어서, 길이로 광고를 가려내기를 그만뒀는지 */
  private lenOff = false;
  private waiter: { resolve: (tZero: number) => void; reject: (e: Error) => void } | null = null;
  private subs = new Set<(e: DeckEvent) => void>();
  private offPlayer: () => void;
  private log: ZeroLog[] = [];
  /** 이번 재생에서 영상이 멈칫한 횟수 / 목소리를 다시 맞춘 횟수 */
  stalls = 0;
  resyncs = 0;
  needTap = false;

  constructor(
    readonly ctx: AudioContext,
    readonly yt: YtPlayer,
    readonly seg: YtSeg,
  ) {
    this.graph = buildGraph(ctx, this.mix, ctx.destination);
    this.audio = new AudioWallClock(ctx);
    this.offPlayer = yt.on((e) => {
      if (e.type === 'error') this.fail(e.error);
      else this.tick();
    });
    yt.setVolume(this.mix.backing);
  }

  get duration(): number {
    return this.seg.dur;
  }
  get playing(): boolean {
    return this.phase !== 'idle';
  }
  /** 영상이 실제로 돌고 있고 싱크도 잡힌 상태인지 */
  get rolling(): boolean {
    return this.phase === 'playing';
  }

  on(fn: (e: DeckEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  private emit(e: DeckEvent): void {
    for (const fn of [...this.subs]) fn(e);
  }

  setTakes(takes: PlayTake[]): void {
    this.takes = takes;
    if (this.phase === 'playing') this.startVoices();
  }

  setMix(mix: MixSettings): void {
    this.mix = mix;
    const now = this.ctx.currentTime;
    this.graph.wet.gain.setTargetAtTime(mix.echo, now, 0.03);
    for (const [seat, node] of this.graph.seatGains) node.gain.setTargetAtTime(mix.seats[seat] ?? 1, now, 0.03);
    this.yt.setVolume(mix.backing);
  }

  /**
   * from(구간 기준 초, 음수면 구간 앞부분의 영상을 미리 튼다)부터 재생.
   * 영상이 실제로 돌기 시작해 싱크를 잡으면 tZero 로 끝나는 약속을 돌려준다.
   * 사용자가 누른 그 순간에 불러야 한다 (휴대폰 브라우저는 누른 직후에만 재생을 허락한다).
   */
  play(from: number, opts: PlayOptions = {}): Promise<number> {
    this.settle(new Error('replaced'));
    this.stopVoices();
    // 영상 맨 앞보다 앞으로는 갈 수 없다
    this.from = Math.max(-this.seg.start, from);
    const videoLeft = this.yt.duration > 0 ? this.yt.duration - this.seg.start : Infinity;
    this.until = Math.max(this.from + 0.2, Math.min(opts.until ?? this.seg.dur, videoLeft));
    this.withTakes = opts.withTakes !== false;
    this.onEnd = opts.onEnd;
    this.phase = 'starting';
    this.startAt = this.reqAt = performance.now();
    this.stalls = 0;
    this.resyncs = 0;
    this.log = [];
    this.scheduledZero = NaN;
    this.setNeedTap(false);
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    this.yt.seek(this.seg.start + this.from);
    this.yt.play();
    const p = new Promise<number>((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
    this.arm(TICK);
    return p;
  }

  private settle(err?: Error, tZero = 0): void {
    const w = this.waiter;
    this.waiter = null;
    if (!w) return;
    if (err) w.reject(err);
    else w.resolve(tZero);
  }

  private arm(ms: number): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(this.tick, ms);
  }

  private setNeedTap(on: boolean): void {
    if (this.needTap === on) return;
    this.needTap = on;
    this.emit({ type: 'needTap', on });
  }

  private pos(now = performance.now()): number {
    return this.yt.clock.mediaAt(now) - this.seg.start;
  }

  /**
   * 지금 플레이어에서 도는 것이 우리 영상이 아닌 것(영상 앞에 붙은 광고) 같은지.
   * 광고가 도는 동안 플레이어가 "재생 중"이라고 하면서 광고의 시각을 알려 주는 경우에 대비한 것이다.
   * 그때는 영상 길이도 광고의 길이로 바뀌므로, 방에 저장해 둔 영상 길이와 견주어 본다.
   */
  private foreign(now: number): boolean {
    const want = this.seg.len ?? 0;
    // 저장해 둔 길이가 없거나 구간보다도 짧으면(믿을 수 없는 값) 이 방법은 쓰지 않는다
    if (this.lenOff || !(want > 0) || want < this.seg.start + this.seg.dur - 1) return false;
    const got = this.yt.duration;
    if (!(got > 0) || Math.abs(got - want) <= LEN_TOL) return false;
    if (now - this.startAt > AD_WAIT) {
      // 올린 사람이 영상을 잘라 냈을 때처럼 길이가 정말 달라졌을 수도 있다. 한 번 이렇게 판단하면 다시 기다리지 않는다.
      this.lenOff = true;
      return false;
    }
    return true;
  }

  /** 구간 0초가 귀에 들리는 순간의 소리 시계 값. 아직 못 잡았으면 null. */
  tZero(): number | null {
    if (!this.yt.clock.locked || !this.audio.locked) return null;
    return tZeroOf(this.seg.start, this.yt.clock.offset, this.audio.offset);
  }

  private tick = (): void => {
    if (this.phase === 'idle') return;
    const now = performance.now();
    this.audio.sample(now);
    const st = this.yt.state;
    const locked = this.yt.clock.locked;
    const pos = this.pos(now);
    let next = TICK;

    if (this.phase === 'starting') {
      const waited = now - this.startAt;
      // 영상 앞에 광고가 붙으면 한참 걸릴 수 있어서 넉넉히 기다린다
      const limit = this.needTap ? 180_000 : 75_000;
      if (st === YT.PLAYING && locked && !this.foreign(now)) {
        // 엉뚱한 곳에서 돌고 있으면(사용자가 직접 누른 재생, 광고 뒤 등) 원하는 곳으로 다시 옮긴다.
        // 옮기고 나면 영상 시계를 새로 잡을 때까지(몇 초) 여기로 다시 오지 않으므로 잇달아 옮기게 되지는 않는다.
        // 광고가 도는 동안에는 옮기라는 말이 먹히지 않을 수 있어서, 몇 번 안 됐다고 포기하지 않고 끝날 때까지 다시 해 본다.
        const elapsed = (now - this.reqAt) / 1000;
        if (pos < this.from - 0.8 || pos > this.from + elapsed + 0.8) {
          if (waited > limit) return this.fail(new YtError('playback', '영상을 원하는 위치에서 틀지 못했어요. 다시 눌러 주세요.'));
          this.reqAt = now;
          this.yt.seek(this.seg.start + this.from);
        } else {
          this.phase = 'playing';
          this.setNeedTap(false);
          this.startVoices();
          this.settle(undefined, this.tZero() ?? 0);
          this.emit({ type: 'ready' });
        }
      } else {
        // 누른 지 한참인데도 시작하지 않으면 브라우저가 막은 것이다: 영상을 직접 눌러 달라고 한다
        if ((st === YT.UNSTARTED || st === YT.CUED || st === YT.PAUSED) && waited > 2200) this.setNeedTap(true);
        if (waited > limit) return this.fail(new YtError('timeout', '영상이 시작되지 않았어요. 인터넷 연결을 확인하고 다시 눌러 주세요.'));
      }
    } else if (this.phase === 'playing') {
      if (st === YT.ENDED || pos >= this.until - 0.005) return this.finish();
      if (st === YT.PAUSED) return this.userPaused(pos);
      if (st !== YT.PLAYING || !locked) {
        this.phase = 'stalled';
        this.stallAt = now;
        this.stalls++;
        this.stopVoices();
        this.emit({ type: 'stall' });
      } else {
        const k = this.tZero();
        if (k !== null) {
          this.log.push({ pos, k, at: now / 1000 });
          if (this.log.length > 6000) this.log.shift();
          const wanted = this.withTakes && this.takes.length > 0;
          if (wanted && Number.isNaN(this.scheduledZero)) this.startVoices();
          else if (wanted && Math.abs(k - this.scheduledZero) > RESYNC) {
            this.resyncs++;
            this.startVoices();
          }
        }
        next = Math.max(4, Math.min(TICK, (this.until - pos) * 1000 + 2));
      }
    } else if (this.phase === 'stalled') {
      if (st === YT.ENDED) return this.finish();
      if (st === YT.PAUSED) return this.userPaused(pos);
      if (st === YT.PLAYING && locked) {
        this.phase = 'playing';
        this.startVoices();
        this.emit({ type: 'resume' });
      } else if (now - this.stallAt > 25_000) {
        return this.fail(new YtError('timeout', '영상이 오래 멈춰 있어요. 인터넷 연결을 확인하고 다시 눌러 주세요.'));
      }
    }
    this.arm(next);
  };

  private startVoices(): void {
    this.stopVoices();
    this.scheduledZero = NaN;
    if (!this.withTakes || !this.takes.length) return;
    const k = this.tZero();
    if (k === null) return;
    // 조금 뒤부터 깐다. 지난 시각에 예약하면 그만큼 밀려 나오기 때문에, 재생 지연보다 넉넉히 앞을 본다.
    const lookahead = Math.max(0.12, this.audio.ahead() + 0.1);
    const from = Math.max(0, this.pos() + lookahead);
    scheduleTakes(this.ctx, this.graph, this.mix, this.takes, k, from, this.sources);
    this.scheduledZero = k;
    hooks()?.onYtVoices?.({ tZero: k, from, segStart: this.seg.start, starts: this.takes.map((t) => t.start) });
  }

  private stopVoices(): void {
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* 이미 끝남 */
      }
    }
    this.sources = [];
  }

  private finish(): void {
    window.clearTimeout(this.timer);
    this.phase = 'idle';
    this.pausedAt = this.until >= this.seg.dur - 0.01 ? 0 : Math.max(0, this.until);
    this.stopVoices();
    this.yt.pause();
    const cb = this.onEnd;
    this.onEnd = undefined;
    cb?.();
  }

  private userPaused(pos: number): void {
    window.clearTimeout(this.timer);
    this.phase = 'idle';
    this.pausedAt = Math.max(0, Math.min(this.seg.dur, pos));
    this.onEnd = undefined;
    this.stopVoices();
    this.emit({ type: 'paused' });
  }

  private fail(error: YtError): void {
    const wasIdle = this.phase === 'idle';
    window.clearTimeout(this.timer);
    this.phase = 'idle';
    this.onEnd = undefined;
    this.stopVoices();
    this.setNeedTap(false);
    this.yt.pause();
    const hadWaiter = !!this.waiter;
    this.settle(error);
    if (!wasIdle || hadWaiter) this.emit({ type: 'failed', error });
  }

  /** 멈추고 지금 위치를 기억한다 */
  pause(): void {
    if (this.phase !== 'idle') this.pausedAt = Math.max(0, Math.min(this.seg.dur, this.position()));
    this.halt();
  }

  stop(): void {
    this.halt();
    this.pausedAt = 0;
  }

  private halt(): void {
    window.clearTimeout(this.timer);
    const was = this.phase;
    this.phase = 'idle';
    this.onEnd = undefined;
    this.stopVoices();
    this.setNeedTap(false);
    if (was !== 'idle') this.yt.pause();
    this.settle(new Error('stopped'));
  }

  seek(pos: number): void {
    const p = Math.max(0, Math.min(this.seg.dur, pos));
    if (this.phase === 'idle') {
      this.pausedAt = p;
      return;
    }
    const onEnd = this.onEnd;
    const w = this.waiter;
    this.waiter = null; // 기다리던 쪽은 그대로 이어서 기다리게 둔다
    void this.play(p, { until: this.until, withTakes: this.withTakes, onEnd }).then(
      (z) => w?.resolve(z),
      (e) => w?.reject(e),
    );
  }

  rawPosition(): number {
    return this.position();
  }

  /** 지금 귀에 들리는 구간 위치 */
  position(): number {
    if (this.phase === 'idle') return this.pausedAt;
    if (this.phase === 'starting') return this.from;
    return Math.min(this.until, Math.max(this.from, this.pos()));
  }

  debug(): DeckDebug {
    return {
      state: this.yt.state,
      phase: this.phase,
      mediaLocked: this.yt.clock.locked,
      audioLocked: this.audio.locked,
      timeSource: this.yt.timeSource,
      aheadMs: Math.round(this.audio.ahead() * 1000),
      jumps: this.yt.clock.jumps,
      stalls: this.stalls,
      resyncs: this.resyncs,
      videoLen: Math.round(this.yt.duration * 10) / 10,
      wantLen: this.seg.len ?? 0,
    };
  }

  /** 녹음하는 동안 잰 값들에서, 부른 구간(t0~t1)의 tZero 를 고른다 */
  zeroFor(t0: number, t1: number): ZeroFit | null {
    return fitZero(this.log, t0, t1);
  }

  /** 줄마다 따로 고른 tZero (부르는 도중 싱크가 옮겨 갔어도 각 줄이 제자리에 오게) */
  zerosFor(windows: [number, number][]): ZeroLines | null {
    return fitZeroLines(this.log, windows, {
      segStart: this.seg.start,
      media: (t0, t1) => this.yt.clock.valueIn(t0, t1),
      audio: (t0, t1) => this.audio.valueIn(t0, t1),
    });
  }

  dispose(): void {
    this.halt();
    this.offPlayer();
    this.subs.clear();
    try {
      this.graph.master.disconnect();
    } catch {
      /* 무시 */
    }
  }
}
