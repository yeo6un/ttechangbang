// 떼창방 API — 웹 표준 Request/Response 만 쓰는 핸들러.
// Cloudflare Worker(D1)와 Node(node:sqlite) 양쪽에서 같은 코드가 돈다.
// env.DB 는 { run, all, get, batch } 를 가진 얇은 어댑터다 (db-d1.js / node-server.mjs 참고).

import { aiAlign, aiSongQueries, aiSplit } from './ai.js';
import { findLyrics, findSongs, findVideo, parseYtId, ytInfo } from './find.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const LIMITS = {
  songBytes: 8 * 1024 * 1024,
  takeBytes: 3 * 1024 * 1024,
  /** 반주(MR) 파일은 한 곡 전체까지 올릴 수 있다 */
  songSeconds: 330,
  /** 유튜브 영상을 반주로 쓰는 방은 음원을 저장하지 않으므로 한 곡 전체까지 허용한다 */
  ytSeconds: 330,
  /** AI 가 듣고 가사 타이밍을 맞추는 일은 짧은 구간에서만 한다 (긴 파일은 무료 한도 안에서 처리하기 어렵다) */
  aiSeconds: 130,
  seats: 8,
  lines: 200,
  lineText: 140,
  members: 40,
  takesPerRoom: 200,
  title: 60,
  name: 16,
  draftTtl: DAY,
  roomTtl: 7 * DAY,
  maxTtl: 30 * DAY,
  aiPerRoom: 15,
};

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    song_blob TEXT,
    song_meta TEXT NOT NULL,
    lines TEXT NOT NULL,
    seat_count INTEGER NOT NULL,
    settings TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    is_host INTEGER NOT NULL DEFAULT 0,
    seat INTEGER,
    joined_at INTEGER NOT NULL,
    UNIQUE (room, seat)
  )`,
  `CREATE TABLE IF NOT EXISTS takes (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    seat INTEGER NOT NULL,
    member TEXT NOT NULL,
    member_name TEXT NOT NULL,
    start REAL NOT NULL,
    dur REAL NOT NULL,
    blob TEXT NOT NULL,
    meta TEXT NOT NULL,
    offset_ms REAL NOT NULL DEFAULT 0,
    gain REAL NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS blobs (
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    room TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_members_room ON members (room)`,
  `CREATE INDEX IF NOT EXISTS idx_takes_room ON takes (room)`,
  `CREATE INDEX IF NOT EXISTS idx_blobs_room ON blobs (room)`,
  `CREATE INDEX IF NOT EXISTS idx_rooms_expires ON rooms (expires_at)`,
];

const schemaReady = new WeakSet();

async function ensureSchema(db) {
  if (schemaReady.has(db)) return;
  await db.batch(SCHEMA.map((sql) => [sql]));
  schemaReady.add(db);
}

// ───────────────────────── 작은 도구들 ─────────────────────────

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function fail(status, code, message) {
  throw new ApiError(status, code, message);
}

const HEX = '0123456789abcdef';
function randomId(bytes = 12) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  let s = '';
  for (const b of a) s += HEX[b >> 4] + HEX[b & 15];
  return s;
}

function randomCode() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let s = '';
  for (const b of new Uint8Array(buf)) s += HEX[b >> 4] + HEX[b & 15];
  return s;
}

function toBase64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64) {
  if (typeof Buffer !== 'undefined') {
    const b = Buffer.from(b64, 'base64');
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

const cleanText = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const num = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

async function readJson(request, maxBytes = 256 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) fail(413, 'too_large', '요청이 너무 커요.');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object') fail(400, 'bad_json', '요청 형식이 올바르지 않아요.');
    return v;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    fail(400, 'bad_json', '요청 형식이 올바르지 않아요.');
  }
}

async function readBinary(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) fail(413, 'too_large', '파일이 너무 커요.');
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length === 0) fail(400, 'empty', '빈 파일이에요.');
  if (buf.length > maxBytes) fail(413, 'too_large', '파일이 너무 커요.');
  return buf;
}

// 같은 인스턴스 안에서만 유지되는 느슨한 횟수 제한 (무차별 대입·남용 완화용)
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
    if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  }
  b.count++;
  return b.count <= max;
}

const clientIp = (request) =>
  request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'local';

// ───────────────────────── 저장소 ─────────────────────────

const CHUNK = 450_000; // 3의 배수 → 조각별 base64 를 이어 붙이면 전체 base64 가 된다. base64 로 60만 자라 D1 의 행 크기 한도 안이다.

async function putBlob(db, room, bytes) {
  const id = randomId(12);
  for (let off = 0, seq = 0; off < bytes.length; off += CHUNK, seq++) {
    await db.run('INSERT INTO blobs (id, seq, room, data) VALUES (?, ?, ?, ?)', id, seq, room, toBase64(bytes.subarray(off, off + CHUNK)));
  }
  return id;
}

async function getBlobBase64(db, room, id) {
  const rows = await db.all('SELECT data FROM blobs WHERE id = ? AND room = ? ORDER BY seq', id, room);
  if (!rows.length) return null;
  return rows.map((r) => r.data).join('');
}

async function deleteRoom(db, code) {
  await db.batch([
    ['DELETE FROM blobs WHERE room = ?', code],
    ['DELETE FROM takes WHERE room = ?', code],
    ['DELETE FROM members WHERE room = ?', code],
    ['DELETE FROM rooms WHERE code = ?', code],
  ]);
}

/** 바깥 서비스에 물어본 결과를 잠깐 저장해 둔다 (같은 곡을 여러 번 묻지 않게) */
async function cached(db, key, ttlMs, fn, keep = () => true) {
  const k = key.slice(0, 300);
  const now = Date.now();
  try {
    const row = await db.get('SELECT value FROM cache WHERE key = ? AND expires_at > ?', k, now);
    if (row) return JSON.parse(row.value);
  } catch {
    /* 저장해 둔 값이 깨졌으면 새로 묻는다 */
  }
  const value = await fn();
  if (keep(value)) {
    try {
      await db.run('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at', k, JSON.stringify(value), now + ttlMs);
    } catch {
      /* 저장에 실패해도 결과는 돌려준다 */
    }
  }
  return value;
}

export async function purgeExpired(env) {
  const db = env.DB;
  await ensureSchema(db);
  await db.run('DELETE FROM cache WHERE expires_at < ?', Date.now());
  const rows = await db.all('SELECT code FROM rooms WHERE expires_at < ? LIMIT 50', Date.now());
  for (const r of rows) await deleteRoom(db, r.code);
  return rows.length;
}

async function getRoom(db, code) {
  if (!/^\d{6}$/.test(code)) fail(404, 'not_found', '그런 방이 없어요. 코드를 다시 확인해 주세요.');
  const row = await db.get('SELECT * FROM rooms WHERE code = ?', code);
  if (!row) fail(404, 'not_found', '그런 방이 없어요. 코드를 다시 확인해 주세요.');
  if (row.expires_at < Date.now()) {
    await deleteRoom(db, code);
    fail(410, 'expired', '기간이 끝나서 사라진 방이에요.');
  }
  row.settings = JSON.parse(row.settings);
  return row;
}

async function getMe(db, request, code) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer ([0-9a-f]{8,64})\.([0-9a-f]{16,128})$/.exec(h);
  if (!m) return null;
  const row = await db.get('SELECT * FROM members WHERE id = ? AND room = ?', m[1], code);
  if (!row) return null;
  if ((await sha256Hex(m[2])) !== row.key_hash) return null;
  return row;
}

function requireMe(me) {
  if (!me) fail(401, 'no_member', '먼저 방에 들어와 주세요.');
  return me;
}
function requireHost(me) {
  requireMe(me);
  if (!me.is_host) fail(403, 'not_host', '방을 만든 사람만 할 수 있어요.');
  return me;
}

const bump = (code) => ['UPDATE rooms SET version = version + 1 WHERE code = ?', code];

async function buildState(db, room, me) {
  const [members, takes] = await Promise.all([
    db.all('SELECT id, name, is_host, seat, joined_at FROM members WHERE room = ? ORDER BY joined_at', room.code),
    db.all('SELECT * FROM takes WHERE room = ? ORDER BY start', room.code),
  ]);
  // 버전은 방금 다시 읽은 값을 쓴다 (수정 직후에도 최신 번호가 나가도록)
  const fresh = await db.get('SELECT version, expires_at FROM rooms WHERE code = ?', room.code);
  return {
    code: room.code,
    title: room.title,
    createdAt: room.created_at,
    expiresAt: fresh ? fresh.expires_at : room.expires_at,
    version: fresh ? fresh.version : room.version,
    draft: !!room.settings.draft,
    blind: !!room.settings.blind,
    revealed: !!room.settings.revealed,
    song: { blob: room.song_blob, ...JSON.parse(room.song_meta) },
    seatCount: room.seat_count,
    lines: JSON.parse(room.lines),
    members: members.map((m) => ({ id: m.id, name: m.name, isHost: !!m.is_host, seat: m.seat, joinedAt: m.joined_at })),
    takes: takes.map((t) => ({
      id: t.id,
      seat: t.seat,
      member: t.member,
      memberName: t.member_name,
      start: t.start,
      dur: t.dur,
      blob: t.blob,
      offsetMs: t.offset_ms,
      gain: t.gain,
      createdAt: t.created_at,
      ...JSON.parse(t.meta),
    })),
    me: me ? { id: me.id, name: me.name, isHost: !!me.is_host, seat: me.seat } : null,
  };
}

function sanitizeLines(input, seatCount, songDur) {
  if (!Array.isArray(input)) fail(400, 'bad_lines', '파트 정보가 올바르지 않아요.');
  if (input.length > LIMITS.lines) fail(400, 'too_many_lines', `줄이 너무 많아요. ${LIMITS.lines}줄까지 돼요.`);
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const t0 = num(raw.t0, 0, songDur, NaN);
    let t1 = num(raw.t1, 0, songDur, NaN);
    if (!Number.isFinite(t0) || !Number.isFinite(t1)) continue;
    if (t1 - t0 < 0.2) t1 = Math.min(songDur, t0 + 0.2);
    if (t1 - t0 < 0.05) continue;
    let id = cleanText(raw.id, 16).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id || seen.has(id)) id = randomId(4);
    seen.add(id);
    const seats = [];
    if (Array.isArray(raw.seats)) {
      for (const s of raw.seats) {
        const n = Number(s);
        if (Number.isInteger(n) && n >= 0 && n < seatCount && !seats.includes(n)) seats.push(n);
      }
    }
    seats.sort((a, b) => a - b);
    out.push({ id, t0: Math.round(t0 * 1000) / 1000, t1: Math.round(t1 * 1000) / 1000, text: cleanText(raw.text, LIMITS.lineText), seats });
  }
  out.sort((a, b) => a.t0 - b.t0);
  return out;
}

/** 유튜브 영상을 반주로 쓰는 방: 영상 번호와, 영상 안에서 구간이 시작하는 위치만 저장한다 */
function sanitizeYt(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = parseYtId(raw.id);
  if (!id) fail(400, 'bad_video', '유튜브 영상 주소가 올바르지 않아요.');
  return {
    id,
    start: Math.round(num(raw.start, 0, 43200, 0) * 1000) / 1000,
    len: Math.round(num(raw.len, 0, 43200, 0)),
    title: cleanText(raw.title, 120),
    author: cleanText(raw.author, 80),
  };
}

/**
 * 가이드 영상: 반주(MR) 파일로 부르는 방에 "원곡 영상"을 붙여 두고, 녹음할 때 보고 들으며 따라 부른다.
 * start 는 MR 구간의 0초가 영상의 몇 초인지 (MR 앞부분이 영상보다 길면 음수가 된다).
 * loose: 영상과 MR이 딱 맞지 않아서 "미리 듣기"로만 쓰는 경우.
 */
function sanitizeGuide(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = parseYtId(raw.id);
  if (!id) fail(400, 'bad_video', '유튜브 영상 주소가 올바르지 않아요.');
  return {
    id,
    start: Math.round(num(raw.start, -600, 43200, 0) * 1000) / 1000,
    len: Math.round(num(raw.len, 0, 43200, 0)),
    title: cleanText(raw.title, 120),
    author: cleanText(raw.author, 80),
    ...(raw.loose ? { loose: true } : {}),
  };
}

const safeArt = (v) => (typeof v === 'string' && v.length <= 300 && /^https:\/\/([a-z0-9-]+\.)*(mzstatic\.com|ytimg\.com)\//.test(v) ? v : '');

function sanitizeSongMeta(raw) {
  const yt = sanitizeYt(raw?.yt);
  const guide = yt ? null : sanitizeGuide(raw?.guide);
  const dur = num(raw?.dur, 1, yt ? LIMITS.ytSeconds : LIMITS.songSeconds, NaN);
  if (!Number.isFinite(dur)) fail(400, 'bad_song', '곡 길이 정보가 올바르지 않아요.');
  const peaks = typeof raw.peaks === 'string' && raw.peaks.length <= 4000 && /^[A-Za-z0-9+/=]*$/.test(raw.peaks) ? raw.peaks : '';
  return {
    dur: Math.round(dur * 1000) / 1000,
    lead: num(raw.lead, 0, 1, 0),
    peaks,
    name: cleanText(raw.name, 80),
    artist: cleanText(raw.artist, 80),
    art: safeArt(raw.art),
    bpm: num(raw.bpm, 0, 300, 0),
    beat0: num(raw.beat0, 0, 10, 0),
    demo: !!raw.demo,
    ...(yt ? { yt } : {}),
    ...(guide ? { guide } : {}),
  };
}

// ───────────────────────── 라우터 ─────────────────────────

export async function handleApi(request, env, ctx) {
  try {
    await ensureSchema(env.DB);
    return await route(request, env, ctx);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message } }, e.status);
    console.error('api error', e && e.stack ? e.stack : e);
    return json({ error: { code: 'server', message: '서버에서 문제가 생겼어요. 잠시 뒤 다시 해 주세요.' } }, 500);
  }
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const method = request.method.toUpperCase();
  const db = env.DB;
  const ip = clientIp(request);

  if (seg[0] === 'config' && method === 'GET') {
    return json({
      ai: !!env.AI,
      find: true,
      ytSearch: !!env.YOUTUBE_API_KEY,
      limits: { songSeconds: LIMITS.songSeconds, ytSeconds: LIMITS.ytSeconds, aiSeconds: LIMITS.aiSeconds, seats: LIMITS.seats, roomDays: LIMITS.roomTtl / DAY },
      now: Date.now(),
    });
  }

  // 곡·가사·유튜브 영상 찾기 (방과 상관없이 쓸 수 있다)
  if (seg[0] === 'find' && method === 'GET') {
    if (!rateLimit('find:' + ip, 90, 10 * 60_000)) fail(429, 'slow_down', '너무 자주 찾고 있어요. 잠시 뒤에 다시 해 주세요.');
    const p = url.searchParams;
    const text = (k, max) => cleanText(p.get(k), max);
    const intOf = (k) => {
      const n = Number(p.get(k));
      return Number.isInteger(n) && n > 0 ? n : 0;
    };
    if (seg[1] === 'songs') {
      const q = text('q', 80);
      if (q.length < 2) fail(400, 'short_query', '가수나 곡 이름을 두 글자 이상 넣어 주세요.');
      // ai=1: 그대로 찾아서 없으면 AI 가 공식 표기로 바꾼 검색어로 한 번 더 (AI 횟수를 아끼려고 따로 부탁할 때만)
      const useAi = p.get('ai') === '1' && !!env.AI && rateLimit('findai:' + ip, 20, HOUR);
      const rewrite = useAi ? (query) => aiSongQueries(env, query) : undefined;
      // (열쇠 앞의 숫자는 고르는 방법을 바꿀 때 올린다: 예전 방법으로 골라 저장해 둔 결과를 다시 쓰지 않게)
      return json(await cached(db, `songs2:${useAi ? 'ai' : 'raw'}:${q.toLowerCase()}`, DAY, () => findSongs(env, q, { rewrite }), (v) => v.songs.length > 0));
    }
    if (seg[1] === 'lyrics') {
      // 같은 곡의 표기를 두 가지까지 받는다 (title/artist, title2/artist2)
      const names = [
        { title: text('title', 120), artist: text('artist', 80) },
        { title: text('title2', 120), artist: text('artist2', 80) },
      ].filter((n) => n.title);
      const want = { names, dur: num(p.get('dur'), 0, 3600, 0), lrclibId: intOf('lrclib') };
      if (!names.length && !want.lrclibId) fail(400, 'no_title', '곡 이름이 필요해요.');
      const key = `lyrics2:${want.lrclibId}:${names.map((n) => `${n.title}|${n.artist}`).join('||').toLowerCase()}:${Math.round(want.dur)}`;
      // 못 찾은 결과는 저장하지 않는다 (가사가 나중에 올라올 수 있다)
      return json(await cached(db, key, 7 * DAY, () => findLyrics(env, want), (v) => v.found));
    }
    if (seg[1] === 'video') {
      const want = { title: text('title', 120), artist: text('artist', 80), dur: num(p.get('dur'), 0, 3600, 0) };
      if (!want.title) fail(400, 'no_title', '곡 이름이 필요해요.');
      if (!env.YOUTUBE_API_KEY) return json({ found: false, reason: 'no_key' });
      return json(await cached(db, `video:${want.title.toLowerCase()}|${want.artist.toLowerCase()}|${Math.round(want.dur)}`, 7 * DAY, () => findVideo(env, want), (v) => v.found));
    }
    if (seg[1] === 'yt') {
      const id = parseYtId(p.get('url') || '');
      if (!id) fail(400, 'bad_video', '유튜브 영상 주소가 아니에요. 영상의 "공유 → 링크 복사"로 받은 주소를 붙여 넣어 주세요.');
      return json(await cached(db, 'yt:' + id, DAY, () => ytInfo(env, id), (v) => v.ok && !v.unverified));
    }
    fail(404, 'no_route', '없는 주소예요.');
  }

  if (seg[0] !== 'rooms') fail(404, 'no_route', '없는 주소예요.');

  // POST /api/rooms — 방 만들기 (초안 상태로 시작)
  if (seg.length === 1) {
    if (method !== 'POST') fail(405, 'method', '지원하지 않는 요청이에요.');
    if (!rateLimit('create:' + ip, 15, HOUR)) fail(429, 'slow_down', '방을 너무 자주 만들고 있어요. 잠시 뒤에 다시 해 주세요.');
    const body = await readJson(request);
    const title = cleanText(body.title, LIMITS.title) || '이름 없는 방';
    const hostName = cleanText(body.hostName, LIMITS.name) || '방장';
    const songMeta = sanitizeSongMeta(body.song);
    const seatCount = Math.round(num(body.seatCount, 1, LIMITS.seats, 4));
    const now = Date.now();
    if (Math.random() < 0.2) ctx?.waitUntil?.(purgeExpired(env).catch(() => {}));
    let code = '';
    for (let i = 0; i < 12 && !code; i++) {
      const c = randomCode();
      try {
        await db.run(
          'INSERT INTO rooms (code, title, created_at, expires_at, version, song_blob, song_meta, lines, seat_count, settings) VALUES (?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)',
          c, title, now, now + LIMITS.draftTtl, JSON.stringify(songMeta), '[]', seatCount,
          JSON.stringify({ draft: true, blind: false, revealed: false, ai: 0 }),
        );
        code = c;
      } catch (e) {
        if (!/UNIQUE|constraint/i.test(String(e && e.message))) throw e;
      }
    }
    if (!code) fail(503, 'busy', '방 번호를 만들지 못했어요. 다시 시도해 주세요.');
    const id = randomId(8);
    const key = randomId(24);
    await db.run('INSERT INTO members (id, room, name, key_hash, is_host, seat, joined_at) VALUES (?, ?, ?, ?, 1, NULL, ?)', id, code, hostName, await sha256Hex(key), now);
    const room = await getRoom(db, code);
    const me = await db.get('SELECT * FROM members WHERE id = ?', id);
    return json({ code, member: { id, key }, room: await buildState(db, room, me) }, 201);
  }

  const code = seg[1];
  if (seg.length === 2 && method === 'GET') {
    // 방 상태 읽기. v 가 같으면 본문 없이 204.
    const v = Number(url.searchParams.get('v') || 0);
    let room;
    try {
      room = await getRoom(db, code);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && !rateLimit('miss:' + ip, 40, 10 * 60_000)) {
        fail(429, 'slow_down', '코드를 너무 많이 틀렸어요. 10분 뒤에 다시 해 주세요.');
      }
      throw e;
    }
    if (v && v === room.version) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    const me = await getMe(db, request, code);
    if (room.settings.draft && !(me && me.is_host)) fail(404, 'not_ready', '아직 준비 중인 방이에요. 방장이 방을 열면 들어올 수 있어요.');
    return json(await buildState(db, room, me));
  }

  const room = await getRoom(db, code);
  const me = await getMe(db, request, code);
  const sub = seg[2];

  // DELETE /api/rooms/:code — 방 닫기
  if (seg.length === 2 && method === 'DELETE') {
    requireHost(me);
    await deleteRoom(db, code);
    return json({ ok: true });
  }

  // PUT /api/rooms/:code/song — 반주 올리기
  if (sub === 'song' && method === 'PUT') {
    requireHost(me);
    const bytes = await readBinary(request, LIMITS.songBytes);
    const blob = await putBlob(db, code, bytes);
    const old = room.song_blob;
    await db.batch([['UPDATE rooms SET song_blob = ? WHERE code = ?', blob, code], bump(code)]);
    if (old) await db.run('DELETE FROM blobs WHERE id = ? AND room = ?', old, code);
    return json(await buildState(db, await getRoom(db, code), me));
  }

  // POST /api/rooms/:code/join — 이름 넣고 들어오기
  if (sub === 'join' && method === 'POST') {
    if (room.settings.draft) fail(404, 'not_ready', '아직 준비 중인 방이에요.');
    if (!rateLimit('join:' + ip, 30, HOUR)) fail(429, 'slow_down', '잠시 뒤에 다시 해 주세요.');
    const body = await readJson(request);
    const name = cleanText(body.name, LIMITS.name);
    if (!name) fail(400, 'no_name', '이름을 적어 주세요.');
    const count = await db.get('SELECT COUNT(*) AS n FROM members WHERE room = ?', code);
    if (count.n >= LIMITS.members) fail(409, 'full', '방이 꽉 찼어요.');
    const id = randomId(8);
    const key = randomId(24);
    await db.batch([
      ['INSERT INTO members (id, room, name, key_hash, is_host, seat, joined_at) VALUES (?, ?, ?, ?, 0, NULL, ?)', id, code, name, await sha256Hex(key), Date.now()],
      bump(code),
    ]);
    const meRow = await db.get('SELECT * FROM members WHERE id = ?', id);
    return json({ member: { id, key }, room: await buildState(db, await getRoom(db, code), meRow) }, 201);
  }

  // POST /api/rooms/:code/me — 내 이름·자리 바꾸기
  if (sub === 'me' && method === 'POST') {
    requireMe(me);
    const body = await readJson(request);
    const stmts = [];
    if (body.name !== undefined) {
      const name = cleanText(body.name, LIMITS.name);
      if (!name) fail(400, 'no_name', '이름을 적어 주세요.');
      stmts.push(['UPDATE members SET name = ? WHERE id = ?', name, me.id]);
    }
    if (body.seat !== undefined) {
      if (body.seat === null) {
        stmts.push(['UPDATE members SET seat = NULL WHERE id = ?', me.id]);
      } else {
        const seat = Number(body.seat);
        if (!Number.isInteger(seat) || seat < 0 || seat >= room.seat_count) fail(400, 'bad_seat', '없는 파트예요.');
        stmts.push(['UPDATE members SET seat = ? WHERE id = ?', seat, me.id]);
      }
    }
    if (stmts.length) {
      try {
        await db.batch([...stmts, bump(code)]);
      } catch (e) {
        if (/UNIQUE|constraint/i.test(String(e && e.message))) fail(409, 'seat_taken', '방금 다른 친구가 먼저 고른 파트예요. 다른 파트를 골라 주세요.');
        throw e;
      }
    }
    return json(await buildState(db, await getRoom(db, code), await db.get('SELECT * FROM members WHERE id = ?', me.id)));
  }

  // PUT /api/rooms/:code/parts — 파트(줄·자리 수) 저장
  if (sub === 'parts' && method === 'PUT') {
    requireHost(me);
    const body = await readJson(request, 512 * 1024);
    const seatCount = Math.round(num(body.seatCount, 1, LIMITS.seats, room.seat_count));
    const songDur = JSON.parse(room.song_meta).dur;
    const lines = sanitizeLines(body.lines, seatCount, songDur);
    await db.batch([
      ['UPDATE rooms SET lines = ?, seat_count = ? WHERE code = ?', JSON.stringify(lines), seatCount, code],
      ['UPDATE members SET seat = NULL WHERE room = ? AND seat >= ?', code, seatCount],
      bump(code),
    ]);
    return json(await buildState(db, await getRoom(db, code), await db.get('SELECT * FROM members WHERE id = ?', me.id)));
  }

  // PUT /api/rooms/:code/settings — 방 열기, 블라인드, 공개, 기간 늘리기
  if (sub === 'settings' && method === 'PUT') {
    requireHost(me);
    const body = await readJson(request);
    const s = { ...room.settings };
    let expires = room.expires_at;
    let title = room.title;
    if (body.title !== undefined) title = cleanText(body.title, LIMITS.title) || title;
    if (body.blind !== undefined) {
      s.blind = !!body.blind;
      if (!s.blind) s.revealed = false;
    }
    if (body.revealed !== undefined) s.revealed = !!body.revealed;
    if (body.draft === false && s.draft) {
      if (!room.song_blob && !JSON.parse(room.song_meta).yt) fail(409, 'no_song', '노래가 아직 올라가지 않았어요. 잠시 뒤 다시 눌러 주세요.');
      s.draft = false;
      expires = Date.now() + LIMITS.roomTtl;
    }
    if (body.extend) expires = Math.min(Date.now() + LIMITS.maxTtl, Math.max(expires, Date.now()) + LIMITS.roomTtl);
    // 가이드 영상의 위치 고치기 (영상과 MR이 어긋나 있을 때 방장이 나중에 맞춘다)
    let songMeta = room.song_meta;
    if (body.guideStart !== undefined || body.guideLoose !== undefined) {
      const meta = JSON.parse(room.song_meta);
      if (!meta.guide) fail(409, 'no_guide', '이 방에는 가이드 영상이 없어요.');
      if (body.guideStart !== undefined) meta.guide.start = Math.round(num(body.guideStart, -600, 43200, meta.guide.start) * 1000) / 1000;
      if (body.guideLoose !== undefined) {
        if (body.guideLoose) meta.guide.loose = true;
        else delete meta.guide.loose;
      }
      songMeta = JSON.stringify(meta);
    }
    await db.batch([['UPDATE rooms SET settings = ?, expires_at = ?, title = ?, song_meta = ? WHERE code = ?', JSON.stringify(s), expires, title, songMeta, code], bump(code)]);
    return json(await buildState(db, await getRoom(db, code), me));
  }

  // POST /api/rooms/:code/release — 방장이 자리 비우기
  if (sub === 'release' && method === 'POST') {
    requireHost(me);
    const body = await readJson(request);
    const seat = Number(body.seat);
    if (!Number.isInteger(seat)) fail(400, 'bad_seat', '없는 파트예요.');
    await db.batch([['UPDATE members SET seat = NULL WHERE room = ? AND seat = ?', code, seat], bump(code)]);
    return json(await buildState(db, await getRoom(db, code), await db.get('SELECT * FROM members WHERE id = ?', me.id)));
  }

  // 녹음(테이크)
  if (sub === 'takes') {
    if (seg.length === 3 && method === 'POST') {
      requireMe(me);
      let meta;
      try {
        meta = JSON.parse(decodeURIComponent(request.headers.get('x-take-meta') || ''));
      } catch {
        fail(400, 'bad_meta', '녹음 정보가 올바르지 않아요.');
      }
      const seat = Number(meta.seat);
      if (!Number.isInteger(seat) || seat < 0 || seat >= room.seat_count) fail(400, 'bad_seat', '없는 파트예요.');
      if (me.seat !== seat) fail(403, 'not_your_seat', '내 파트가 아니에요. 방에서 파트를 먼저 골라 주세요.');
      const songDur = JSON.parse(room.song_meta).dur;
      const start = num(meta.start, -2, songDur, NaN);
      const dur = num(meta.dur, 0.2, songDur + 5, NaN);
      if (!Number.isFinite(start) || !Number.isFinite(dur)) fail(400, 'bad_meta', '녹음 정보가 올바르지 않아요.');
      const count = await db.get('SELECT COUNT(*) AS n FROM takes WHERE room = ?', code);
      if (count.n >= LIMITS.takesPerRoom) fail(409, 'too_many', '이 방에 녹음이 너무 많아요. 안 쓰는 녹음을 지워 주세요.');
      const bytes = await readBinary(request, LIMITS.takeBytes);

      // 같은 자리에서 시간대가 절반 넘게 겹치는 예전 녹음은 새 녹음으로 바꾼다
      const olds = await db.all('SELECT id, start, dur, blob, meta, offset_ms FROM takes WHERE room = ? AND seat = ?', code, seat);
      let retakes = 0;
      const replaced = [];
      for (const o of olds) {
        const a0 = o.start + o.offset_ms / 1000;
        const ov = Math.min(a0 + o.dur, start + dur) - Math.max(a0, start);
        if (ov > 0.5 * Math.min(o.dur, dur)) {
          replaced.push(o);
          try {
            retakes = Math.max(retakes, (JSON.parse(o.meta).retakes || 0) + 1);
          } catch {}
        }
      }
      const stats = meta.stats && typeof meta.stats === 'object' ? meta.stats : {};
      const cleanMeta = {
        lead: num(meta.lead, 0, 1, 0),
        peaks: typeof meta.peaks === 'string' && meta.peaks.length <= 1600 && /^[A-Za-z0-9+/=]*$/.test(meta.peaks) ? meta.peaks : '',
        latencyMs: Math.round(num(meta.latencyMs, -1000, 2000, 0)),
        stats: {
          rmsDb: num(stats.rmsDb, -120, 0, -60),
          peakDb: num(stats.peakDb, -120, 0, -60),
          gainDb: num(stats.gainDb, -40, 40, 0),
          voiced: num(stats.voiced, 0, 600, 0),
        },
        retakes,
      };
      const blob = await putBlob(db, code, bytes);
      const id = randomId(8);
      const stmts = [
        ['INSERT INTO takes (id, room, seat, member, member_name, start, dur, blob, meta, offset_ms, gain, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)',
          id, code, seat, me.id, me.name, start, dur, blob, JSON.stringify(cleanMeta), Date.now()],
      ];
      for (const o of replaced) {
        stmts.push(['DELETE FROM takes WHERE id = ?', o.id]);
        stmts.push(['DELETE FROM blobs WHERE id = ? AND room = ?', o.blob, code]);
      }
      stmts.push(bump(code));
      await db.batch(stmts);
      return json({ takeId: id, room: await buildState(db, await getRoom(db, code), me) }, 201);
    }

    const take = seg[3] ? await db.get('SELECT * FROM takes WHERE id = ? AND room = ?', seg[3], code) : null;
    if (!take) fail(404, 'no_take', '이미 지워진 녹음이에요.');
    requireMe(me);
    if (take.member !== me.id && !me.is_host) fail(403, 'not_yours', '내 녹음만 바꿀 수 있어요.');

    if (method === 'PATCH') {
      const body = await readJson(request);
      const offset = body.offsetMs !== undefined ? num(body.offsetMs, -1000, 1000, take.offset_ms) : take.offset_ms;
      const gain = body.gain !== undefined ? num(body.gain, 0, 4, take.gain) : take.gain;
      await db.batch([['UPDATE takes SET offset_ms = ?, gain = ? WHERE id = ?', offset, gain, take.id], bump(code)]);
      return json(await buildState(db, await getRoom(db, code), me));
    }
    if (method === 'DELETE') {
      await db.batch([['DELETE FROM takes WHERE id = ?', take.id], ['DELETE FROM blobs WHERE id = ? AND room = ?', take.blob, code], bump(code)]);
      return json(await buildState(db, await getRoom(db, code), me));
    }
    fail(405, 'method', '지원하지 않는 요청이에요.');
  }

  // GET /api/rooms/:code/blobs/:id — 소리 파일
  if (sub === 'blobs' && seg[3] && method === 'GET') {
    const id = seg[3];
    if (id !== room.song_blob) {
      const take = await db.get('SELECT member FROM takes WHERE blob = ? AND room = ?', id, code);
      if (!take) fail(404, 'no_blob', '소리 파일을 찾지 못했어요.');
      if (room.settings.blind && !room.settings.revealed && !(me && me.id === take.member)) {
        fail(403, 'blind', '블라인드 모드예요. 모두 녹음을 마치면 들을 수 있어요.');
      }
    }
    const b64 = await getBlobBase64(db, code, id);
    if (!b64) fail(404, 'no_blob', '소리 파일을 찾지 못했어요.');
    return new Response(fromBase64(b64), {
      headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, max-age=604800, immutable' },
    });
  }

  // AI 도우미 (Workers AI 가 연결돼 있을 때만)
  if (sub === 'ai' && method === 'POST') {
    requireHost(me);
    if (!env.AI) fail(501, 'no_ai', '이 서버에는 AI 기능이 연결돼 있지 않아요.');
    if ((room.settings.ai || 0) >= LIMITS.aiPerRoom) fail(429, 'ai_limit', '이 방에서 AI를 쓸 수 있는 횟수를 다 썼어요. 직접 맞춰 주세요.');
    if (!rateLimit('ai:' + ip, 30, HOUR)) fail(429, 'slow_down', 'AI를 너무 자주 불렀어요. 잠시 뒤에 다시 해 주세요.');
    const body = await readJson(request, 256 * 1024);
    const s = { ...room.settings, ai: (room.settings.ai || 0) + 1 };
    await db.run('UPDATE rooms SET settings = ? WHERE code = ?', JSON.stringify(s), code);
    const songMeta = JSON.parse(room.song_meta);

    if (seg[3] === 'align') {
      if (!room.song_blob) fail(409, 'no_song', '노래가 아직 올라가지 않았어요.');
      if (songMeta.dur > LIMITS.aiSeconds) fail(413, 'too_long', 'AI 는 2분이 안 되는 구간만 들을 수 있어요. 탭으로 직접 맞춰 주세요.');
      const b64 = await getBlobBase64(db, code, room.song_blob);
      if (!b64) fail(409, 'no_song', '노래가 아직 올라가지 않았어요.');
      const language = /^[a-z]{2}$/.test(String(body.language || '')) ? body.language : undefined;
      try {
        const out = await aiAlign(env, b64, { language, prompt: cleanText(body.lyrics, 600) });
        const lead = songMeta.lead || 0;
        const shift = (t) => Math.max(0, Math.round((t - lead) * 1000) / 1000);
        return json({
          text: out.text,
          language: out.language,
          words: out.words.map((w) => ({ w: w.w, s: shift(w.s), e: shift(w.e) })),
          segments: out.segments.map((g) => ({ s: shift(g.s), e: shift(g.e), text: g.text })),
        });
      } catch (e) {
        console.error('ai align failed', e && e.message);
        fail(502, 'ai_failed', 'AI가 가사 타이밍을 찾지 못했어요. 탭으로 직접 맞춰 주세요.');
      }
    }

    if (seg[3] === 'split') {
      const seatCount = Math.round(num(body.seatCount, 1, LIMITS.seats, room.seat_count));
      const lines = sanitizeLines(body.lines, seatCount, songMeta.dur).slice(0, 120);
      if (!lines.length) fail(400, 'bad_lines', '나눌 줄이 없어요.');
      try {
        const out = await aiSplit(env, { title: room.title, lines, seatCount, notes: cleanText(body.notes, 300) });
        return json(out);
      } catch (e) {
        console.error('ai split failed', e && e.message);
        fail(502, 'ai_failed', 'AI 추천을 받지 못했어요. 자동 배정으로 대신할게요.');
      }
    }
  }

  fail(404, 'no_route', '없는 주소예요.');
}
