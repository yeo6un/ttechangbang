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

/** 유튜브 영상을 반주로 쓰는 방: 영상 번호와, 영상 안에서 구간이 시작하는 위치 */
export interface YtRef {
  id: string;
  start: number;
  /** 영상 전체 길이(초). 모르면 0. */
  len: number;
  title: string;
  author: string;
}

/**
 * 가이드 영상: 반주(MR) 파일로 부르는 방에 붙여 둔 원곡 영상. 녹음할 때 보고 들으며 따라 부른다.
 * start 는 MR 구간의 0초가 영상의 몇 초인지 (음수일 수도 있다).
 */
export interface GuideRef extends YtRef {
  /** 영상과 MR이 딱 맞지 않아서, 따라 부르기에는 못 쓰고 미리 듣기로만 쓰는 경우 */
  loose?: boolean;
}

export interface SongMeta {
  blob: string | null;
  dur: number;
  lead: number;
  peaks: string;
  name: string;
  artist?: string;
  art?: string;
  bpm: number;
  beat0: number;
  demo: boolean;
  /** 유튜브 영상을 반주로 쓰는 방 (음원 파일이 없다) */
  yt?: YtRef;
  /** 반주 파일로 부르는 방에 붙인 원곡 영상 */
  guide?: GuideRef;
}

export interface ServerConfig {
  ai: boolean;
  /** 가수·곡 이름으로 유튜브 영상까지 자동으로 찾을 수 있는지 (서버에 YouTube API 열쇠가 있을 때) */
  ytSearch?: boolean;
  limits: { songSeconds: number; ytSeconds?: number; aiSeconds?: number; seats: number; roomDays: number };
  now: number;
}

/** 검색으로 찾은 곡 */
export interface FoundSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  dur: number;
  art: string;
  itunesId?: number;
  lrclibId?: number;
  /** 가사가 있는지 미리 아는 경우 */
  lyrics?: 'synced' | 'plain';
}

export interface FoundLyrics {
  found: boolean;
  id?: number;
  title?: string;
  artist?: string;
  dur?: number;
  /** 줄별 시간표가 달린 가사(LRC). 없으면 빈 글. */
  synced?: string;
  plain?: string;
  source?: string;
  down?: boolean;
}

export interface FoundVideo {
  id: string;
  title: string;
  author: string;
  thumb: string;
  len: number;
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
  config: () => request<ServerConfig>('GET', '/config'),

  findSongs: (q: string, ai = false) => request<{ songs: FoundSong[]; via: string; rewritten?: string; down?: boolean }>('GET', `/find/songs?q=${encodeURIComponent(q)}${ai ? '&ai=1' : ''}`),
  findLyrics(want: { names?: { title: string; artist: string }[]; dur?: number; lrclibId?: number }) {
    const p = new URLSearchParams();
    (want.names || []).slice(0, 2).forEach((n, i) => {
      p.set(i ? 'title2' : 'title', n.title);
      p.set(i ? 'artist2' : 'artist', n.artist);
    });
    if (want.dur) p.set('dur', String(Math.round(want.dur)));
    if (want.lrclibId) p.set('lrclib', String(want.lrclibId));
    return request<FoundLyrics>('GET', `/find/lyrics?${p}`);
  },
  findVideo: (want: { title: string; artist: string; dur?: number }) =>
    request<({ found: true; alts: FoundVideo[]; via: string } & FoundVideo) | { found: false; reason?: string }>(
      'GET',
      `/find/video?title=${encodeURIComponent(want.title)}&artist=${encodeURIComponent(want.artist)}${want.dur ? `&dur=${Math.round(want.dur)}` : ''}`,
    ),
  ytInfo: (url: string) => request<{ ok: boolean; id?: string; title?: string; author?: string; thumb?: string; reason?: string; unverified?: boolean }>('GET', `/find/yt?url=${encodeURIComponent(url)}`),

  createRoom: (body: { title: string; hostName: string; seatCount: number; song: Omit<SongMeta, 'blob'> }) =>
    request<{ code: string; member: Identity; room: Room }>('POST', '/rooms', { body }),

  /** v 를 주면 바뀐 게 없을 때 null 을 돌려준다 */
  getRoom: (code: string, who?: Identity | null, v?: number) => request<Room | null>('GET', `/rooms/${code}${v ? `?v=${v}` : ''}`, { who }),

  join: (code: string, name: string) => request<{ member: Identity; room: Room }>('POST', `/rooms/${code}/join`, { body: { name } }),
  setMe: (code: string, who: Identity, body: { name?: string; seat?: number | null }) => request<Room>('POST', `/rooms/${code}/me`, { who, body }),
  putSong: (code: string, who: Identity, bytes: Uint8Array) => request<Room>('PUT', `/rooms/${code}/song`, { who, bin: bytes }),
  putParts: (code: string, who: Identity, lines: Line[], seatCount: number) => request<Room>('PUT', `/rooms/${code}/parts`, { who, body: { lines, seatCount } }),
  putSettings: (code: string, who: Identity, body: { draft?: false; blind?: boolean; revealed?: boolean; extend?: boolean; title?: string; guideStart?: number; guideLoose?: boolean }) =>
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
