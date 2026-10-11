// 이 기기에만 저장하는 것들: 방별 내 열쇠, 최근 방, 이름, 녹음 설정, 믹서 설정
import type { Identity } from './api';
import { DEFAULT_MIX, type MixSettings } from './audio/transport';

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

  mic: (): { earphones: boolean; deviceId: string; guide: number; hearOthers: boolean } => ({
    earphones: true,
    deviceId: '',
    guide: 0.8,
    hearOthers: true,
    ...read<object>('ttb.mic', {}),
  }),
  setMic: (v: Partial<{ earphones: boolean; deviceId: string; guide: number; hearOthers: boolean }>) => write('ttb.mic', { ...store.mic(), ...v }),

  mix: (code: string): MixSettings => ({ ...DEFAULT_MIX, ...read<Partial<MixSettings>>(`ttb.mix.${code}`, {}) }),
  setMix: (code: string, mix: MixSettings) => write(`ttb.mix.${code}`, mix),
};
