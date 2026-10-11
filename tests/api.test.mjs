// API 통합 테스트: Node 서버를 임시 폴더로 띄우고 실제 HTTP 로 전체 흐름을 확인한다.
//   node tests/api.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttb-api-'));
const PORT = 8899;
// BASE 를 주면 이미 떠 있는 서버(예: wrangler dev 로 띄운 Cloudflare Worker)를 검사한다.
// 이때는 DB 파일을 직접 건드리는 검사(만료)는 건너뛴다.
const EXTERNAL = process.env.BASE || '';
const base = EXTERNAL || `http://127.0.0.1:${PORT}`;

const server = EXTERNAL
  ? null
  : spawn(process.execPath, [path.join(root, 'server/node-server.mjs')], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MOCK_FIND: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
if (server) {
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('http://') && resolve());
    server.on('exit', (c) => reject(new Error('server exited ' + c)));
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
}

const auth = (m) => ({ authorization: `Bearer ${m.id}.${m.key}` });
async function call(method, url, { member, body, bin, headers } = {}) {
  const h = { ...(member ? auth(member) : {}), ...(headers || {}) };
  let payload;
  if (bin) {
    payload = bin;
    h['content-type'] = 'audio/mpeg';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer());
  return { status: res.status, data };
}
const takeMeta = (m) => ({ 'x-take-meta': encodeURIComponent(JSON.stringify(m)) });
const fakeAudio = (n, seed = 1) => {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i++) a[i] = (i * 31 + seed * 7) & 255;
  return a;
};

let passed = 0;
const step = async (name, fn) => {
  await fn();
  passed++;
  console.log('  ✓', name);
};

try {
  let host, code, state, a, b;

  await step('설정 읽기: AI 없음으로 표시', async () => {
    const r = await call('GET', '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.data.ai, false);
  });

  await step('방 만들기 → 6자리 코드와 방장 열쇠', async () => {
    const r = await call('POST', '/api/rooms', { body: { title: '테스트 곡', hostName: '방장이', seatCount: 3, song: { dur: 20, lead: 0.12, peaks: 'AAEC', name: 'x.mp3' } } });
    assert.equal(r.status, 201);
    assert.match(r.data.code, /^\d{6}$/);
    code = r.data.code;
    host = r.data.member;
    assert.equal(r.data.room.draft, true);
    assert.equal(r.data.room.me.isHost, true);
  });

  await step('초안 방은 남에게 보이지 않고, 들어올 수도 없다', async () => {
    assert.equal((await call('GET', `/api/rooms/${code}`)).status, 404);
    assert.equal((await call('POST', `/api/rooms/${code}/join`, { body: { name: '불청객' } })).status, 404);
    assert.equal((await call('GET', `/api/rooms/${code}`, { member: host })).status, 200);
  });

  const song = fakeAudio(1_500_000, 3); // 여러 조각으로 나뉘는 크기
  await step('노래 올리기 전에는 방을 열 수 없다', async () => {
    const r = await call('PUT', `/api/rooms/${code}/settings`, { member: host, body: { draft: false } });
    assert.equal(r.status, 409);
  });

  await step('노래 올리기 → 그대로 다시 받기 (여러 조각)', async () => {
    const r = await call('PUT', `/api/rooms/${code}/song`, { member: host, bin: song });
    assert.equal(r.status, 200);
    const blob = r.data.song.blob;
    assert.ok(blob);
    const g = await call('GET', `/api/rooms/${code}/blobs/${blob}`, { member: host });
    assert.equal(g.status, 200);
    assert.equal(g.data.length, song.length);
    assert.ok(g.data.every((v, i) => v === song[i]));
  });

  await step('남은 노래를 못 올린다', async () => {
    assert.equal((await call('PUT', `/api/rooms/${code}/song`, { bin: song })).status, 401);
  });

  await step('파트 저장: 정렬·정리되고 범위 밖 자리는 버려진다', async () => {
    const lines = [
      { id: 'b', t0: 5, t1: 9, text: '둘째 줄', seats: [1, 7] },
      { id: 'a', t0: 1, t1: 4.5, text: '  첫째   줄 ', seats: [0] },
      { id: 'c', t0: 10, t1: 14, text: '다같이', seats: [0, 1, 2] },
      { id: 'd', t0: 15, t1: 99, text: '끝', seats: [2] },
    ];
    const r = await call('PUT', `/api/rooms/${code}/parts`, { member: host, body: { lines, seatCount: 3 } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.lines.map((l) => l.id), ['a', 'b', 'c', 'd']);
    assert.equal(r.data.lines[0].text, '첫째 줄');
    assert.deepEqual(r.data.lines[1].seats, [1]);
    assert.equal(r.data.lines[3].t1, 20);
  });

  await step('방 열기 → 7일짜리 임시 방', async () => {
    const r = await call('PUT', `/api/rooms/${code}/settings`, { member: host, body: { draft: false, blind: true } });
    assert.equal(r.status, 200);
    assert.equal(r.data.draft, false);
    assert.equal(r.data.blind, true);
    const days = (r.data.expiresAt - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days < 7.1);
    state = r.data;
  });

  await step('코드로 들어오기 (두 명)', async () => {
    const ra = await call('POST', `/api/rooms/${code}/join`, { body: { name: '민지' } });
    const rb = await call('POST', `/api/rooms/${code}/join`, { body: { name: '도윤' } });
    assert.equal(ra.status, 201);
    assert.equal(rb.status, 201);
    a = ra.data.member;
    b = rb.data.member;
    assert.equal(rb.data.room.members.length, 3);
    assert.equal((await call('POST', `/api/rooms/${code}/join`, { body: { name: '   ' } })).status, 400);
  });

  await step('자리 고르기: 같은 자리는 한 명만', async () => {
    assert.equal((await call('POST', `/api/rooms/${code}/me`, { member: a, body: { seat: 0 } })).status, 200);
    const r = await call('POST', `/api/rooms/${code}/me`, { member: b, body: { seat: 0 } });
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'seat_taken');
    const ok = await call('POST', `/api/rooms/${code}/me`, { member: b, body: { seat: 1 } });
    assert.equal(ok.data.me.seat, 1);
    assert.equal((await call('POST', `/api/rooms/${code}/me`, { member: b, body: { seat: 5 } })).status, 400);
  });

  await step('변경이 없으면 204, 있으면 새 상태', async () => {
    const r1 = await call('GET', `/api/rooms/${code}`, { member: a });
    const res = await fetch(`${base}/api/rooms/${code}?v=${r1.data.version}`, { headers: auth(a) });
    assert.equal(res.status, 204);
    await call('POST', `/api/rooms/${code}/me`, { member: a, body: { name: '민지짱' } });
    const res2 = await fetch(`${base}/api/rooms/${code}?v=${r1.data.version}`, { headers: auth(a) });
    assert.equal(res2.status, 200);
    assert.equal((await res2.json()).me.name, '민지짱');
  });

  let takeA, takeB;
  await step('녹음 올리기: 내 자리만 가능', async () => {
    const bad = await call('POST', `/api/rooms/${code}/takes`, { member: a, bin: fakeAudio(4000), headers: takeMeta({ seat: 1, start: 5, dur: 4 }) });
    assert.equal(bad.status, 403);
    const ra = await call('POST', `/api/rooms/${code}/takes`, {
      member: a, bin: fakeAudio(40_000, 5),
      headers: takeMeta({ seat: 0, start: 0.7, dur: 4.2, lead: 0.12, peaks: 'AQID', latencyMs: 84, stats: { rmsDb: -22, peakDb: -3, gainDb: 6, voiced: 3.1 } }),
    });
    assert.equal(ra.status, 201);
    takeA = ra.data.room.takes.find((t) => t.id === ra.data.takeId);
    assert.equal(takeA.memberName, '민지짱');
    assert.equal(takeA.stats.rmsDb, -22);
    assert.equal(takeA.retakes, 0);
    const rb = await call('POST', `/api/rooms/${code}/takes`, { member: b, bin: fakeAudio(30_000, 9), headers: takeMeta({ seat: 1, start: 4.8, dur: 4.6 }) });
    assert.equal(rb.status, 201);
    takeB = rb.data.room.takes.find((t) => t.id === rb.data.takeId);
  });

  await step('블라인드: 남의 녹음은 못 듣고 내 녹음·반주는 들린다', async () => {
    assert.equal((await call('GET', `/api/rooms/${code}/blobs/${takeB.blob}`, { member: a })).status, 403);
    assert.equal((await call('GET', `/api/rooms/${code}/blobs/${takeB.blob}`)).status, 403);
    const own = await call('GET', `/api/rooms/${code}/blobs/${takeA.blob}`, { member: a });
    assert.equal(own.status, 200);
    assert.equal(own.data.length, 40_000);
    assert.equal((await call('GET', `/api/rooms/${code}/blobs/${state.song.blob}`, { member: a })).status, 200);
  });

  await step('다시 녹음하면 겹치는 예전 녹음이 바뀌고 횟수가 센다', async () => {
    const r = await call('POST', `/api/rooms/${code}/takes`, { member: a, bin: fakeAudio(41_000, 6), headers: takeMeta({ seat: 0, start: 0.8, dur: 4.1 }) });
    assert.equal(r.status, 201);
    const mine = r.data.room.takes.filter((t) => t.seat === 0);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].retakes, 1);
    assert.equal((await call('GET', `/api/rooms/${code}/blobs/${takeA.blob}`, { member: a })).status, 404);
    takeA = mine[0];
    // 겹치지 않는 다른 구간은 따로 남는다
    const r2 = await call('POST', `/api/rooms/${code}/takes`, { member: a, bin: fakeAudio(20_000, 2), headers: takeMeta({ seat: 0, start: 9.8, dur: 4.4 }) });
    assert.equal(r2.data.room.takes.filter((t) => t.seat === 0).length, 2);
  });

  await step('싱크·음량 고치기와 지우기는 본인과 방장만', async () => {
    assert.equal((await call('PATCH', `/api/rooms/${code}/takes/${takeA.id}`, { member: b, body: { offsetMs: 50 } })).status, 403);
    const r = await call('PATCH', `/api/rooms/${code}/takes/${takeA.id}`, { member: a, body: { offsetMs: -35.5 } });
    assert.equal(r.data.takes.find((t) => t.id === takeA.id).offsetMs, -35.5);
    assert.equal((await call('DELETE', `/api/rooms/${code}/takes/${takeB.id}`, { member: a })).status, 403);
    assert.equal((await call('PATCH', `/api/rooms/${code}/takes/${takeB.id}`, { member: host, body: { gain: 1.5 } })).status, 200);
  });

  await step('공개하면 모두 들을 수 있다', async () => {
    assert.equal((await call('PUT', `/api/rooms/${code}/settings`, { member: a, body: { revealed: true } })).status, 403);
    const r = await call('PUT', `/api/rooms/${code}/settings`, { member: host, body: { revealed: true } });
    assert.equal(r.data.revealed, true);
    assert.equal((await call('GET', `/api/rooms/${code}/blobs/${takeB.blob}`, { member: a })).status, 200);
  });

  await step('자리 수를 줄이면 넘치는 자리는 비워진다', async () => {
    const r = await call('PUT', `/api/rooms/${code}/parts`, { member: host, body: { lines: state.lines, seatCount: 1 } });
    assert.equal(r.data.seatCount, 1);
    assert.equal(r.data.members.find((m) => m.id === b.id).seat, null);
    assert.equal(r.data.members.find((m) => m.id === a.id).seat, 0);
  });

  await step('방장이 자리를 비울 수 있고, AI 는 연결 안 됨으로 답한다', async () => {
    const r = await call('POST', `/api/rooms/${code}/release`, { member: host, body: { seat: 0 } });
    assert.equal(r.data.members.find((m) => m.id === a.id).seat, null);
    assert.equal((await call('POST', `/api/rooms/${code}/ai/split`, { member: host, body: { lines: state.lines } })).status, 501);
    assert.equal((await call('POST', `/api/rooms/${code}/ai/align`, { member: a, body: {} })).status, 403);
  });

  await step('기간 늘리기', async () => {
    const before = (await call('GET', `/api/rooms/${code}`, { member: host })).data.expiresAt;
    const r = await call('PUT', `/api/rooms/${code}/settings`, { member: host, body: { extend: true } });
    assert.ok(r.data.expiresAt > before + 6 * 86_400_000);
  });

  await step('틀린 코드·엉뚱한 주소', async () => {
    assert.equal((await call('GET', '/api/rooms/000000')).status, 404);
    assert.equal((await call('GET', '/api/rooms/abc')).status, 404);
    assert.equal((await call('GET', '/api/nothing')).status, 404);
    assert.equal((await call('POST', `/api/rooms/${code}/me`, { member: { id: a.id, key: 'ff'.repeat(24) }, body: { seat: 0 } })).status, 401);
  });

  // ───────── 유튜브 영상을 반주로 쓰는 방 ─────────
  await step('유튜브 반주 방: 노래 파일 없이 열리고, 한 곡 전체 길이까지 된다', async () => {
    const bad = await call('POST', '/api/rooms', { body: { title: 'x', hostName: 'h', song: { dur: 200, yt: { id: 'nope' } } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error.code, 'bad_video');
    // 파일 방은 여전히 125초까지만
    assert.equal((await call('POST', '/api/rooms', { body: { title: 'x', hostName: 'h', song: { dur: 200 } } })).data.room.song.dur, 125);
    const r = await call('POST', '/api/rooms', {
      body: { title: '연습용 노래', hostName: '방장', seatCount: 2, song: { dur: 200, name: '연습용 노래', artist: '떼창방 밴드', art: 'https://evil.example/x.jpg', yt: { id: 'https://youtu.be/ttbDEMO0001?t=3', start: 12.3456, len: 215, title: '영상 제목', author: '채널' } } },
    });
    assert.equal(r.status, 201);
    const y = r.data;
    assert.deepEqual(y.room.song.yt, { id: 'ttbDEMO0001', start: 12.346, len: 215, title: '영상 제목', author: '채널' });
    assert.equal(y.room.song.dur, 200);
    assert.equal(y.room.song.art, ''); // 허용한 그림 주소가 아니면 버린다
    assert.equal(y.room.song.blob, null);
    const lines = [{ id: 'a', t0: 150, t1: 160, text: '뒤쪽 줄', seats: [0] }, { id: 'b', t0: 3, t1: 8, text: '앞쪽 줄', seats: [1] }];
    assert.equal((await call('PUT', `/api/rooms/${y.code}/parts`, { member: y.member, body: { lines, seatCount: 2 } })).data.lines[1].t0, 150);
    const open = await call('PUT', `/api/rooms/${y.code}/settings`, { member: y.member, body: { draft: false } });
    assert.equal(open.status, 200);
    assert.equal(open.data.draft, false);
    await call('POST', `/api/rooms/${y.code}/me`, { member: y.member, body: { seat: 0 } });
    const take = await call('POST', `/api/rooms/${y.code}/takes`, { member: y.member, bin: fakeAudio(9000), headers: takeMeta({ seat: 0, start: 149.7, dur: 10.8 }) });
    assert.equal(take.status, 201);
    assert.equal(take.data.room.takes[0].start, 149.7);
    // 받아쓰기 AI 는 저장된 음원이 있어야 해서 이 방에서는 쓸 수 없다
    assert.ok([409, 501].includes((await call('POST', `/api/rooms/${y.code}/ai/align`, { member: y.member, body: {} })).status));
    await call('DELETE', `/api/rooms/${y.code}`, { member: y.member });
  });

  if (!EXTERNAL) {
    await step('곡 찾기: 가사 데이터베이스에서 목록이 나오고, 같은 곡은 하나만 남는다 (시간표가 있고 길이가 엉뚱하지 않은 쪽)', async () => {
      assert.equal((await call('GET', '/api/find/songs?q=a')).status, 400);
      const r = await call('GET', '/api/find/songs?q=practice%20song');
      assert.equal(r.status, 200);
      assert.equal(r.data.via, 'lrclib');
      const mine = r.data.songs.filter((x) => x.artist === 'Ttechang Band');
      assert.equal(mine.length, 1);
      assert.deepEqual({ ...mine[0] }, { id: 'lr501', lrclibId: 501, title: 'Practice Song', artist: 'Ttechang Band', album: 'Ttechang Vol.1', dur: 24, art: '', lyrics: 'synced' });
      // 한글 검색어는 영어 표기와 안 맞아 바로는 안 나온다 (AI 가 없는 서버)
      const ko = await call('GET', `/api/find/songs?ai=1&q=${encodeURIComponent('떼창방 밴드 연습용 노래')}`);
      assert.equal(ko.data.songs.length, 0);
      assert.equal(ko.data.down, false);
      const l = await call('GET', '/api/find/lyrics?lrclib=501');
      assert.equal(l.data.found, true);
      assert.match(l.data.synced, /^\[00:02\.61\]/);
    });

    await step('가사 찾기: 다른 표기(영어 이름)까지 넣어 주면 찾고, 제목만 같은 남의 곡은 고르지 않는다', async () => {
      const ko = `title=${encodeURIComponent('연습용 노래')}&artist=${encodeURIComponent('떼창방 밴드')}&dur=24`;
      assert.equal((await call('GET', `/api/find/lyrics?${ko}`)).data.found, false);
      const r = await call('GET', `/api/find/lyrics?${ko}&title2=${encodeURIComponent('Practice Song (Remastered)')}&artist2=${encodeURIComponent('Ttechang Band')}`);
      assert.equal(r.status, 200);
      assert.equal(r.data.found, true);
      assert.equal(r.data.id, 501); // 길이가 맞고 시간표가 있는 쪽
      assert.equal(r.data.source, 'LRCLIB');
      assert.equal(r.data.synced.split('\n').length, 8);
      // 시간표 없는 가사만 있는 곡
      const u = await call('GET', '/api/find/lyrics?title=Untimed%20Song&artist=Ttechang%20Band&dur=24');
      assert.equal(u.data.found, true);
      assert.equal(u.data.synced, '');
      assert.equal(u.data.plain.split('\n').length, 8);
      // 길이를 모르고 찾을 때: 공연을 통째로 올린 것처럼 길이가 엉뚱한 판(505)이 아니라, 여럿이 같은 길이로 올린 판을 고른다
      const nodur = await call('GET', '/api/find/lyrics?title=Practice%20Song&artist=Ttechang%20Band');
      assert.equal(nodur.data.id, 501);
      assert.equal(nodur.data.dur, 24);
      // 가수 이름도 길이도 안 맞으면 같은 제목이라도 버린다
      assert.equal((await call('GET', '/api/find/lyrics?title=Practice%20Song&artist=Nobody&dur=120')).data.found, false);
      assert.equal((await call('GET', '/api/find/lyrics?title=No%20Such%20Song&artist=Ttechang%20Band')).data.found, false);
    });

    await step('영상 링크 확인. 열쇠가 없으면 영상 자동 찾기는 꺼져 있다', async () => {
      assert.equal((await call('GET', '/api/config')).data.ytSearch, false);
      const v = await call('GET', '/api/find/video?title=Practice%20Song&artist=Ttechang%20Band&dur=24');
      assert.deepEqual(v.data, { found: false, reason: 'no_key' });
      const ok = await call('GET', `/api/find/yt?url=${encodeURIComponent('https://m.youtube.com/watch?v=ttbMV000001&feature=share')}`);
      assert.equal(ok.data.ok, true);
      assert.equal(ok.data.id, 'ttbMV000001');
      assert.match(ok.data.title, /M\/V/);
      const blocked = await call('GET', '/api/find/yt?url=https://youtu.be/blockedAAAA');
      assert.equal(blocked.data.ok, false);
      assert.equal(blocked.data.reason, 'blocked');
      assert.equal((await call('GET', '/api/find/yt?url=https://youtu.be/missingAAAA')).data.reason, 'missing');
      const bad = await call('GET', `/api/find/yt?url=${encodeURIComponent('https://example.com/watch?v=ttbDEMO0001')}`);
      assert.equal(bad.status, 400);
    });

    await step('찾은 결과는 저장해 두고 다시 묻지 않는다', async () => {
      const db = new DatabaseSync(path.join(dataDir, 'ttechang.db'));
      const keys = db.prepare('SELECT key FROM cache').all().map((r) => r.key);
      db.close();
      assert.ok(keys.includes('songs2:raw:practice song'));
      assert.ok(keys.some((k) => k.startsWith('lyrics2:')));
      assert.ok(keys.includes('yt:ttbMV000001'));
      assert.ok(!keys.includes('yt:blockedAAAA')); // 실패한 결과는 저장하지 않는다
    });

    await step('바꾼 검색어 후보가 여럿이면 모두 찾아서 번갈아 합친다 (먼저 걸린 한쪽만 쓰지 않는다)', async () => {
      const { findSongs } = await import('../server/find.js');
      const mockFetch = (await import('./mock-find.mjs')).default;
      const asked = [];
      const rewrite = async (q) => {
        asked.push(q);
        return ['No Such Song At All', 'Ttechang Band Untimed Song', 'Ttechang Band Practice Song', 'ignored fourth'];
      };
      const out = await findSongs({ fetch: mockFetch }, '한글로 적은 검색어', { rewrite });
      assert.deepEqual(asked, ['한글로 적은 검색어']);
      assert.equal(out.via, 'lrclib');
      assert.equal(out.rewritten, 'Ttechang Band Untimed Song'); // 결과가 나온 첫 후보
      assert.deepEqual(out.songs.map((s) => s.lrclibId), [503, 501]);
      // 후보가 모두 빈손이면 못 찾은 것으로
      const none = await findSongs({ fetch: mockFetch }, '한글로 적은 검색어', { rewrite: async () => ['Nothing Here'] });
      assert.deepEqual({ songs: none.songs.length, via: none.via, down: none.down }, { songs: 0, via: 'none', down: false });
      // AI 가 실패해도 죽지 않는다
      const broken = await findSongs({ fetch: mockFetch }, '한글로 적은 검색어', { rewrite: async () => Promise.reject(new Error('quota')) });
      assert.equal(broken.songs.length, 0);
    });

    await step('AI·유튜브 열쇠가 연결된 서버: 한글 검색어를 공식 표기로 바꿔 찾고, 영상도 자동으로 고른다', async () => {
      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ttb-api2-'));
      const s2 = spawn(process.execPath, [path.join(root, 'server/node-server.mjs')], {
        env: { ...process.env, PORT: '8898', DATA_DIR: dir2, MOCK_FIND: '1', MOCK_AI: '1', YOUTUBE_API_KEY: 'test-key' },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      try {
        await new Promise((resolve, reject) => {
          s2.stdout.on('data', (d) => String(d).includes('http://') && resolve());
          setTimeout(() => reject(new Error('second server start timeout')), 8000);
        });
        const get = async (u) => (await fetch('http://127.0.0.1:8898' + u)).json();
        const cfg = await get('/api/config');
        assert.equal(cfg.ai, true);
        assert.equal(cfg.ytSearch, true);
        const q = encodeURIComponent('떼창방 밴드 연습용 노래');
        assert.equal((await get(`/api/find/songs?q=${q}`)).songs.length, 0); // 부탁하지 않으면 AI 를 쓰지 않는다
        const r = await get(`/api/find/songs?ai=1&q=${q}`);
        assert.equal(r.rewritten, 'Ttechang Band Practice Song');
        assert.equal(r.songs[0].lrclibId, 501);
        // 라이브·뮤직비디오보다 길이가 맞는 음원 영상을 먼저 고른다
        const v = await get('/api/find/video?title=Practice%20Song&artist=Ttechang%20Band&dur=24');
        assert.equal(v.found, true);
        assert.equal(v.id, 'ttbDEMO0001');
        assert.equal(v.len, 24);
        assert.deepEqual(v.alts.map((a) => a.id), ['ttbMV000001', 'liveLIVE001']);
      } finally {
        s2.kill();
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });
  }

  if (!EXTERNAL) await step('기간이 끝난 방은 410 을 주고 통째로 지워진다', async () => {
    const r = await call('POST', '/api/rooms', { body: { title: '곧 사라질 방', hostName: 'h', song: { dur: 10 } } });
    const c2 = r.data.code;
    await call('PUT', `/api/rooms/${c2}/song`, { member: r.data.member, bin: fakeAudio(1000) });
    const db = new DatabaseSync(path.join(dataDir, 'ttechang.db'));
    db.prepare('UPDATE rooms SET expires_at = ? WHERE code = ?').run(Date.now() - 1000, c2);
    const g = await call('GET', `/api/rooms/${c2}`, { member: r.data.member });
    assert.equal(g.status, 410);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blobs WHERE room = ?').get(c2).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM members WHERE room = ?').get(c2).n, 0);
    db.close();
  });

  await step('방 닫기: 방장만, 닫으면 전부 삭제', async () => {
    assert.equal((await call('DELETE', `/api/rooms/${code}`, { member: a })).status, 403);
    assert.equal((await call('DELETE', `/api/rooms/${code}`, { member: host })).status, 200);
    assert.equal((await call('GET', `/api/rooms/${code}`, { member: host })).status, 404);
    if (EXTERNAL) return;
    const db = new DatabaseSync(path.join(dataDir, 'ttechang.db'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM takes').get().n, 0);
    db.close();
  });

  console.log(`\nAPI 테스트 ${passed}개 통과`);
} finally {
  server?.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
