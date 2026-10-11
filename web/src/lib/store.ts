// 이 기기에만 저장하는 것들: 방별 내 열쇠, 최근 방, 이름, 녹음 설정, 믹서 설정
import type { Identity } from './api';
import { DEFAULT_MIX, DEFAULT_YT_MIX, type MixSettings } from './audio/transport';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 사생활 보호 모드 등: 저장 없이도 이번 방문은 동작한다 */
  }
}

export interface MicPrefs {
  earphones: boolean;
  deviceId: string;
  /** 반주(또는 영상) 소리 크기 */
  guide: number;
  hearOthers: boolean;
  monitor: 'guide' | 'mr';
}

export interface RecentRoom {
  code: string;
  title: string;
  at: number;
  host: boolean;
}

const idKey = (code: string) => `ttb.id.${code}`;

export const store = {
  identity: (code: string): Identity | null => {
    const v = read<Identity | null>(idKey(code), null);
    return v && v.id && v.key ? v : null;
  },
  setIdentity: (code: string, who: Identity) => write(idKey(code), who),
  forget(code: string) {
    try {
      localStorage.removeItem(idKey(code));
      localStorage.removeItem(`ttb.mix.${code}`);
      localStorage.removeItem(`ttb.gbias.${code}`);
    } catch {
      /* 무시 */
    }
    write('ttb.recent', store.recent().filter((r) => r.code !== code));
  },

  recent: (): RecentRoom[] => read<RecentRoom[]>('ttb.recent', []).filter((r) => r && /^\d{6}$/.test(r.code)),
  touchRecent(room: { code: string; title: string }, host: boolean) {
    const list = store.recent().filter((r) => r.code !== room.code);
    list.unshift({ code: room.code, title: room.title, at: Date.now(), host });
    write('ttb.recent', list.slice(0, 12));
  },

  name: (): string => read<string>('ttb.name', ''),
  setName: (name: string) => write('ttb.name', name),

  /** monitor: 가이드 영상이 붙은 방에서 녹음할 때 무엇을 들을지 (원곡 영상 / MR 반주) */
  mic: (): MicPrefs => ({
    earphones: true,
    deviceId: '',
    guide: 0.8,
    hearOthers: true,
    monitor: 'guide',
    ...read<object>('ttb.mic', {}),
  }),
  setMic: (v: Partial<MicPrefs>) => write('ttb.mic', { ...store.mic(), ...v }),

  mix: (code: string, yt = false): MixSettings => ({ ...(yt ? DEFAULT_YT_MIX : DEFAULT_MIX), ...read<Partial<MixSettings>>(`ttb.mix.${code}`, {}) }),
  setMix: (code: string, mix: MixSettings) => write(`ttb.mix.${code}`, mix),

  /** 유튜브 반주에서 이 기기만 목소리 전체를 옮겨 듣는 값(ms). 기기마다 소리가 나오는 지연이 달라서 둔다. */
  ytShift: (): number => {
    const v = Number(read<number>('ttb.ytshift', 0));
    return Number.isFinite(v) ? Math.max(-300, Math.min(300, v)) : 0;
  },
  setYtShift: (ms: number) => write('ttb.ytshift', ms),

  /**
   * 원곡 영상을 따라 부른 녹음을 MR에 얹을 때 이 기기에서 옮겨 주는 값(ms).
   * 영상 소리와 우리 소리가 나오는 빠르기가 기기마다 조금 다르고, 방마다 영상과 MR을 맞춘 정도도 달라서
   * 방별로 기억한다. 처음 가는 방에서는 이 기기에서 마지막으로 쓴 값부터 시작한다.
   */
  guideBias: (code: string): number => {
    const v = Number(read<number | null>(`ttb.gbias.${code}`, null) ?? read<number>('ttb.gbias', 0));
    return Number.isFinite(v) ? Math.max(-300, Math.min(300, Math.round(v / 10) * 10)) : 0;
  },
  setGuideBias(code: string, ms: number) {
    write(`ttb.gbias.${code}`, ms);
    // 크게 옮긴 값은 그 방의 영상과 MR이 어긋나 있어서일 가능성이 높으므로, 다른 방의 시작값으로는 쓰지 않는다
    if (Math.abs(ms) <= 80) write('ttb.gbias', ms);
  },
};
