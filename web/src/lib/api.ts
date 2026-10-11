// 서버와 주고받기
import type { Line } from './parts';

export interface Member {
  id: string;
  name: string;
  isHost: boolean;
  seat: number | null;
  joinedAt: number;
}

export interface Take {
  id: string;
  seat: number;
  member: string;
  memberName: string;
  start: number;
  dur: number;
  blob: string;
  offsetMs: number;
  gain: number;
  createdAt: number;
  lead: number;
  peaks: string;
  latencyMs: number;
  stats: { rmsDb: number; peakDb: number; gainDb: number; voiced: number };
  retakes: number;
}

export interface SongMeta {
  blob: string | null;
  dur: number;
  lead: number;
  peaks: string;
  name: string;
  bpm: number;
  beat0: number;
  demo: boolean;
}

export interface Room {
  code: string;
  title: string;
  createdAt: number;
  expiresAt: number;
  version: number;
  draft: boolean;
  blind: boolean;
  revealed: boolean;
  song: SongMeta;
  seatCount: number;
  lines: Line[];
  members: Member[];
  takes: Take[];
  me: { id: string; name: string; isHost: boolean; seat: number | null } | null;
}

export interface Identity {
  id: string;
  key: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const authHeader = (who?: Identity | null): Record<string, string> => (who ? { authorization: `Bearer ${who.id}.${who.key}` } : {});

async function request<T>(method: string, path: string, opts: { who?: Identity | null; body?: unknown; bin?: Uint8Array; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeader(opts.who), ...(opts.headers || {}) };
  let body: BodyInit | undefined;
  if (opts.bin) {
    body = opts.bin as Uint8Array<ArrayBuffer>;
    headers['content-type'] = 'audio/mpeg';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch('/api' + path, { method, headers, body });
  } catch {
    throw new ApiError(0, 'offline', '인터넷 연결을 확인해 주세요.');
  }
  if (res.status === 204) return null as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code || 'error', err?.message || '요청을 처리하지 못했어요. 잠시 뒤 다시 해 주세요.');
  }
  return data as T;
}

export const api = {
  config: () => request<{ ai: boolean; limits: { songSeconds: number; seats: number; roomDays: number }; now: number }>('GET', '/config'),

  createRoom: (body: { title: string; hostName: string; seatCount: number; song: Omit<SongMeta, 'blob'> }) =>
    request<{ code: string; member: Identity; room: Room }>('POST', '/rooms', { body }),

  /** v 를 주면 바뀐 게 없을 때 null 을 돌려준다 */
  getRoom: (code: string, who?: Identity | null, v?: number) => request<Room | null>('GET', `/rooms/${code}${v ? `?v=${v}` : ''}`, { who }),

  join: (code: string, name: string) => request<{ member: Identity; room: Room }>('POST', `/rooms/${code}/join`, { body: { name } }),
  setMe: (code: string, who: Identity, body: { name?: string; seat?: number | null }) => request<Room>('POST', `/rooms/${code}/me`, { who, body }),
  putSong: (code: string, who: Identity, bytes: Uint8Array) => request<Room>('PUT', `/rooms/${code}/song`, { who, bin: bytes }),
  putParts: (code: string, who: Identity, lines: Line[], seatCount: number) => request<Room>('PUT', `/rooms/${code}/parts`, { who, body: { lines, seatCount } }),
  putSettings: (code: string, who: Identity, body: { draft?: false; blind?: boolean; revealed?: boolean; extend?: boolean; title?: string }) =>
    request<Room>('PUT', `/rooms/${code}/settings`, { who, body }),
  release: (code: string, who: Identity, seat: number) => request<Room>('POST', `/rooms/${code}/release`, { who, body: { seat } }),
  deleteRoom: (code: string, who: Identity) => request<{ ok: true }>('DELETE', `/rooms/${code}`, { who }),

  postTake: (code: string, who: Identity, meta: Record<string, unknown>, bytes: Uint8Array) =>
    request<{ takeId: string; room: Room }>('POST', `/rooms/${code}/takes`, { who, bin: bytes, headers: { 'x-take-meta': encodeURIComponent(JSON.stringify(meta)) } }),
  patchTake: (code: string, who: Identity, id: string, body: { offsetMs?: number; gain?: number }) => request<Room>('PATCH', `/rooms/${code}/takes/${id}`, { who, body }),
  deleteTake: (code: string, who: Identity, id: string) => request<Room>('DELETE', `/rooms/${code}/takes/${id}`, { who }),

  async blob(code: string, id: string, who?: Identity | null): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await fetch(`/api/rooms/${code}/blobs/${id}`, { headers: authHeader(who) });
    } catch {
      throw new ApiError(0, 'offline', '인터넷 연결을 확인해 주세요.');
    }
    if (!res.ok) {
      let err: { code?: string; message?: string } | undefined;
      try {
        err = (await res.json()).error;
      } catch {
        /* 무시 */
      }
      throw new ApiError(res.status, err?.code || 'error', err?.message || '소리 파일을 받지 못했어요.');
    }
    return res.arrayBuffer();
  },

  aiAlign: (code: string, who: Identity, body: { lyrics?: string; language?: string }) =>
    request<{ text: string; language: string; words: { w: string; s: number; e: number }[]; segments: { s: number; e: number; text: string }[] }>('POST', `/rooms/${code}/ai/align`, { who, body }),
  aiSplit: (code: string, who: Identity, body: { lines: Line[]; seatCount: number; notes?: string }) =>
    request<{ assign: Record<string, number[]>; summary: string; source: 'ai' }>('POST', `/rooms/${code}/ai/split`, { who, body }),
};
