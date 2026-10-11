// 하나뿐인 AudioContext 를 관리한다. 브라우저는 사용자가 누른 뒤에만 소리를 허락하므로
// 버튼 핸들러 안에서 unlockAudio() 를 불러 깨운다.

let ctx: AudioContext | null = null;

type AudioSessionNav = Navigator & { audioSession?: { type: string } };

export function getCtx(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    const Ctor: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ latencyHint: 'interactive' });
  }
  return ctx;
}

export async function unlockAudio(): Promise<AudioContext> {
  const c = getCtx();
  if (c.state !== 'running') {
    try {
      await c.resume();
    } catch {
      /* 다음 터치 때 다시 시도된다 */
    }
  }
  return c;
}

/** 아이폰은 마이크를 켜면 소리 경로가 바뀌므로, 녹음 직전에 컨텍스트를 새로 만든다 */
export async function freshCtx(): Promise<AudioContext> {
  if (ctx && ctx.state !== 'closed') {
    try {
      await ctx.close();
    } catch {
      /* 무시 */
    }
  }
  ctx = null;
  return unlockAudio();
}

/** iOS: 무음 스위치와 상관없이 소리가 나게, 녹음 때는 녹음 겸용 모드로 */
export function setAudioSession(type: 'playback' | 'play-and-record'): void {
  try {
    const nav = navigator as AudioSessionNav;
    if (nav.audioSession) nav.audioSession.type = type;
  } catch {
    /* 지원하지 않는 브라우저 */
  }
}

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** 브라우저가 알려 주는 재생 지연(초). 참고치일 뿐 정확하지 않을 수 있다. */
export function reportedOutputLatency(c: AudioContext): number {
  const base = Number.isFinite(c.baseLatency) ? c.baseLatency : 0;
  const out = Number.isFinite((c as AudioContext & { outputLatency?: number }).outputLatency) ? (c as AudioContext & { outputLatency: number }).outputLatency : 0;
  return base + out;
}
