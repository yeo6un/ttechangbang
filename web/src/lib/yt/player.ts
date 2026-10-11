// 유튜브 플레이어 감싸기. 공식 IFrame Player API 로 영상을 "그대로" 틀고(음원을 뽑지 않는다),
// 영상이 지금 몇 초를 들려주는지를 정밀하게 따라간다.
import { MediaClock } from './clock';

export const YT = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

/** 플레이어가 해 줘야 하는 일 (공식 API 의 일부). 테스트에서는 가짜로 바꿔 끼운다. */
export interface RawYt {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(volume: number): void;
  unMute?(): void;
  setPlaybackRate?(rate: number): void;
  getVideoData?(): { title?: string; author?: string } | undefined;
  getIframe?(): HTMLIFrameElement;
  destroy(): void;
}

export interface YtCallbacks {
  onReady(): void;
  onState(state: number): void;
  onError(code: number): void;
  /** (가짜 플레이어용) 영상 위치 표본을 직접 알려 준다 */
  onTime(media: number, perfMs: number): void;
}

export interface YtOptions {
  /** 유튜브 자체 조작 막대를 보일지 (구간을 찾을 때는 보이는 편이 편하다) */
  controls?: boolean;
  /** 만드는 도중에 화면을 떠났는지 물어볼 자리 (떠났으면 플레이어를 만들지 않는다) */
  cancelled?: () => boolean;
}

type Factory = (host: HTMLElement, videoId: string, cb: YtCallbacks, opts: YtOptions) => RawYt;
interface TestHooks {
  ytFactory?: Factory;
}
const hooks = () => (window as unknown as { __ttbTest?: TestHooks }).__ttbTest;

export type YtErrorKind = 'load' | 'blocked' | 'missing' | 'playback' | 'timeout';

export class YtError extends Error {
  constructor(
    public kind: YtErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** 유튜브가 알려 주는 오류 번호를 사람이 읽을 말로 */
export function ytErrorOf(code: number): YtError {
  if (code === 101 || code === 150) return new YtError('blocked', '이 영상은 올린 사람이 유튜브 밖에서 재생하지 못하게 막아 뒀어요. 다른 영상을 골라 주세요.');
  if (code === 100) return new YtError('missing', '영상을 찾을 수 없어요. 지워졌거나 비공개 영상이에요.');
  if (code === 2) return new YtError('missing', '영상 주소가 올바르지 않아요.');
  if (code === 5) return new YtError('playback', '이 브라우저에서는 영상을 재생하지 못했어요. 크롬이나 사파리 최신 버전으로 열어 주세요.');
  return new YtError('playback', '영상을 재생하지 못했어요. 잠시 뒤 다시 해 주세요.');
}

interface YtNamespace {
  Player: new (el: HTMLElement, config: Record<string, unknown>) => RawYt;
}

let apiPromise: Promise<YtNamespace> | null = null;

function loadApi(): Promise<YtNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<YtNamespace>((resolve, reject) => {
    const w = window as unknown as { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void };
    if (w.YT?.Player) return resolve(w.YT);
    const fail = () => {
      apiPromise = null;
      reject(new YtError('load', '유튜브를 불러오지 못했어요. 인터넷 연결을 확인하거나, 유튜브가 막힌 와이파이라면 다른 연결로 바꿔 주세요.'));
    };
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      if (w.YT?.Player) resolve(w.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = fail;
    document.head.appendChild(script);
    window.setTimeout(() => {
      if (!w.YT?.Player) fail();
    }, 15000);
  });
  return apiPromise;
}

export type YtEvent = { type: 'state'; state: number } | { type: 'error'; error: YtError };

export class YtPlayer {
  readonly clock = new MediaClock();
  state: number = YT.UNSTARTED;
  error: YtError | null = null;
  private raw: RawYt | null = null;
  private subs = new Set<(e: YtEvent) => void>();
  private pollTimer = 0;
  private lastSampleAt = 0;
  private lastPolled = NaN;
  private dead = false;
  private onMessage: ((e: MessageEvent) => void) | null = null;
  private frame: HTMLIFrameElement | null = null;
  private mount: HTMLElement | null = null;
  /** 영상 위치를 무엇으로 받고 있는지 (진단용): stamp = 잰 시각이 든 알림, message = 알림 도착 시각, poll = 직접 물어봄 */
  timeSource: 'none' | 'stamp' | 'message' | 'poll' | 'direct' = 'none';

  private constructor(readonly videoId: string) {}

  static create(host: HTMLElement, videoId: string, opts: YtOptions = {}): Promise<YtPlayer> {
    const p = new YtPlayer(videoId);
    return new Promise<YtPlayer>((resolve, reject) => {
      let settled = false;
      const cb: YtCallbacks = {
        onReady: () => {
          if (settled || p.dead) return;
          settled = true;
          p.attachMessages();
          resolve(p);
        },
        onState: (s) => p.setState(s),
        onError: (code) => {
          const err = ytErrorOf(code);
          p.error = err;
          p.emit({ type: 'error', error: err });
          if (!settled) {
            settled = true;
            p.destroy();
            reject(err);
          }
        },
        onTime: (media, perfMs) => {
          p.timeSource = 'direct';
          p.feed(media, perfMs);
        },
      };
      const build = (make: () => RawYt) => {
        if (p.dead) return;
        if (opts.cancelled?.()) {
          settled = true;
          p.destroy();
          return reject(new YtError('load', '취소됨'));
        }
        try {
          p.raw = make();
        } catch {
          settled = true;
          p.destroy();
          reject(new YtError('load', '유튜브 플레이어를 만들지 못했어요.'));
        }
      };
      // 자리(host)는 다른 플레이어와 번갈아 쓸 수 있으므로, 내가 넣은 것만 넣고 뺀다
      const mount = document.createElement('div');
      mount.className = 'yt-mount';
      p.mount = mount;
      host.appendChild(mount);
      const fake = hooks()?.ytFactory;
      if (fake) {
        build(() => fake(mount, videoId, cb, opts));
      } else {
        loadApi().then(
          (api) =>
            build(
              () =>
                new api.Player(mount, {
                  videoId,
                  width: '100%',
                  height: '100%',
                  playerVars: {
                    playsinline: 1,
                    controls: opts.controls ? 1 : 0,
                    rel: 0,
                    fs: 0,
                    disablekb: 1,
                    iv_load_policy: 3,
                    modestbranding: 1,
                    enablejsapi: 1,
                    hl: 'ko',
                    origin: location.origin,
                  },
                  events: {
                    onReady: () => cb.onReady(),
                    onStateChange: (e: { data: number }) => cb.onState(e.data),
                    onError: (e: { data: number }) => cb.onError(e.data),
                  },
                }),
            ),
          (e) => {
            settled = true;
            reject(e);
          },
        );
      }
      window.setTimeout(() => {
        if (!settled) {
          settled = true;
          p.destroy();
          reject(new YtError('timeout', '유튜브 영상이 열리지 않아요. 인터넷 연결을 확인하고 다시 해 주세요.'));
        }
      }, 25000);
    });
  }

  /**
   * 플레이어가 부모 창으로 보내는 알림에는 "영상 위치"와 "그 위치를 잰 시각"이 함께 들어 있다.
   * 이것을 직접 읽으면 알림이 오가는 시간만큼의 오차 없이 영상 시계를 잡을 수 있다.
   */
  private attachMessages(): void {
    try {
      this.frame = this.raw?.getIframe?.() ?? null;
    } catch {
      this.frame = null;
    }
    if (!this.frame) return;
    this.onMessage = (e: MessageEvent) => {
      if (!this.frame || e.source !== this.frame.contentWindow) return;
      if (!/^https:\/\/(www\.)?youtube(-nocookie)?\.com$/.test(e.origin)) return;
      let data: unknown = e.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      const info = (data as { info?: Record<string, unknown> } | null)?.info;
      if (!info || typeof info !== 'object') return;
      const media = info.currentTime;
      if (typeof media !== 'number') return;
      const stamped = info.currentTimeLastUpdated_;
      const nowEpoch = Date.now();
      const nowPerf = performance.now();
      // 잰 시각이 들어 있으면(초 단위의 벽시계) 그것을, 없으면 알림이 도착한 시각을 쓴다.
      // 잰 시각이 "지금보다 뒤"거나 너무 오래됐으면 우리가 아는 뜻이 아닌 것이므로 믿지 않는다.
      const age = typeof stamped === 'number' ? nowEpoch - stamped * 1000 : NaN;
      const hasStamp = age >= -5 && age < 1500;
      const perfMs = hasStamp ? nowPerf - age : nowPerf;
      this.timeSource = hasStamp ? 'stamp' : 'message';
      this.feed(media, perfMs, hasStamp);
    };
    window.addEventListener('message', this.onMessage);
  }

  private feed(media: number, perfMs: number, exact = true): void {
    this.lastSampleAt = performance.now();
    this.clock.feed(media, perfMs, exact);
  }

  private setState(s: number): void {
    if (this.dead) return;
    this.state = s;
    this.clock.setPlaying(s === YT.PLAYING);
    window.clearInterval(this.pollTimer);
    if (s === YT.PLAYING) {
      this.lastPolled = NaN;
      // 알림으로 위치가 들어오지 않는 환경을 위한 대비: 플레이어에게 직접 물어본다
      this.pollTimer = window.setInterval(() => {
        if (!this.raw || performance.now() - this.lastSampleAt < 700) return;
        let t = NaN;
        try {
          t = this.raw.getCurrentTime();
        } catch {
          return;
        }
        if (Number.isFinite(t) && t !== this.lastPolled) {
          this.lastPolled = t;
          this.timeSource = 'poll';
          this.clock.feed(t, performance.now(), false);
        }
      }, 40);
    }
    this.emit({ type: 'state', state: s });
  }

  private emit(e: YtEvent): void {
    for (const fn of [...this.subs]) fn(e);
  }

  on(fn: (e: YtEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** 영상 전체 길이(초). 아직 모르면 0. */
  get duration(): number {
    try {
      const d = this.raw?.getDuration() ?? 0;
      return Number.isFinite(d) && d > 0 ? d : 0;
    } catch {
      return 0;
    }
  }

  get info(): { title: string; author: string } {
    try {
      const d = this.raw?.getVideoData?.();
      return { title: String(d?.title || ''), author: String(d?.author || '') };
    } catch {
      return { title: '', author: '' };
    }
  }

  /** 지금 영상 위치 (멈춰 있을 때도) */
  now(): number {
    return this.clock.mediaAt(performance.now());
  }

  play(): void {
    try {
      // 예전에 이 기기에서 영상 소리를 꺼 뒀거나 빠르기를 바꿔 뒀으면 되돌린다 (반주가 들려야 하고, 싱크는 제 빠르기를 전제로 한다)
      this.raw?.unMute?.();
      this.raw?.setPlaybackRate?.(1);
      this.raw?.playVideo();
    } catch {
      /* 준비 전 */
    }
  }

  /**
   * 영상이 실제로 재생되는지 확인한다 (올린 사람이 다른 사이트에서의 재생을 막아 둔 영상은 틀어 봐야 알 수 있다).
   * 재생이 시작되면 끝나고, 막혀 있으면 그 이유로 거절한다. 누른 그 순간에 불러야 한다.
   * onBlocked: 브라우저가 자동 재생을 막아 사용자가 영상을 직접 눌러 줘야 할 때 불린다.
   */
  confirmPlayable(onBlocked: (blocked: boolean) => void, timeoutMs = 90_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.state === YT.PLAYING) return resolve();
      let done = false;
      const finish = (err?: YtError) => {
        if (done) return;
        done = true;
        off();
        window.clearTimeout(hint);
        window.clearTimeout(limit);
        onBlocked(false);
        if (err) reject(err);
        else resolve();
      };
      const off = this.on((e) => {
        if (e.type === 'error') finish(e.error);
        else if (e.state === YT.PLAYING) finish();
      });
      const hint = window.setTimeout(() => {
        if (!done && (this.state === YT.UNSTARTED || this.state === YT.CUED || this.state === YT.PAUSED)) onBlocked(true);
      }, 2500);
      const limit = window.setTimeout(() => finish(new YtError('timeout', '영상이 재생되지 않아요. 인터넷 연결을 확인하거나 다른 영상을 골라 주세요.')), timeoutMs);
      this.play();
    });
  }
  pause(): void {
    try {
      this.raw?.pauseVideo();
    } catch {
      /* 준비 전 */
    }
  }
  seek(sec: number): void {
    const t = Math.max(0, sec);
    this.clock.noteSeek(t, performance.now());
    try {
      this.raw?.seekTo(t, true);
    } catch {
      /* 준비 전 */
    }
  }
  /** 0~1 */
  setVolume(v: number): void {
    try {
      this.raw?.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100));
    } catch {
      /* 준비 전 */
    }
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    window.clearInterval(this.pollTimer);
    if (this.onMessage) window.removeEventListener('message', this.onMessage);
    this.subs.clear();
    try {
      this.raw?.destroy();
    } catch {
      /* 이미 없어짐 */
    }
    this.raw = null;
    try {
      this.frame?.remove();
      this.mount?.remove();
    } catch {
      /* 무시 */
    }
    this.frame = null;
    this.mount = null;
  }
}
