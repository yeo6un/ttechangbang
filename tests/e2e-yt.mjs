// 실제 브라우저 테스트 4: 유튜브 영상을 반주로 쓰는 방.
//   곡 찾기 → 가사(시간표 포함) 자동 → 영상 링크 → 구간 고르기 → 파트 → 방 열기
//   → 두 사람이 영상에 맞춰 녹음 → 영상과 목소리를 함께 듣기 → 목소리만 파일로
// 진짜 유튜브와 바깥 검색 서버에는 닿을 수 없어서 가짜 플레이어(tests/fake-yt.mjs)와 가짜 검색 서버(tests/mock-find.mjs)를 쓴다.
// 가짜 가수가 영상의 가사 줄 시작마다 소리를 내고, 저장된 녹음에서 그 소리가 제자리에 있는지 재서 싱크를 확인한다.
//   node tests/e2e-yt.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { blockApple, fakeApple, fakeWorld, judgeSync } from './fake-yt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOT_DIR || '';
const VW = Number(process.env.VW || 390);
const BAR = (4 * 60) / 92;
/** 가사 데이터베이스(가짜)에 들어 있는 줄 시작 시각: 음원 기준 */
const LRC_STARTS = Array.from({ length: 8 }, (_, i) => (1 + i) * BAR);
const DEMO = 'ttbDEMO0001';
const MV = 'ttbMV000001';
const VIDEOS = {
  [DEMO]: { len: 24.07, title: '떼창방 밴드 - 연습용 노래 (Official Audio)', author: '떼창방 밴드 - Topic' },
  // 뮤직비디오: 앞에 5초짜리 도입부가 붙어 있다
  [MV]: { len: 29.07, title: '떼창방 밴드 - 연습용 노래 M/V', author: '떼창방 밴드' },
};

function startServer(port, extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttb-yt-'));
  const proc = spawn(process.execPath, [path.join(root, 'server/node-server.mjs')], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, MOCK_FIND: '1', ...extraEnv }, stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('http://') && resolve());
    setTimeout(() => reject(new Error('server start timeout')), 8000);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    ready,
    stop() {
      proc.kill();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const overflows = [];
const pages = [];
/** 화면을 남기고, 가로로 넘치는 곳이 없는지도 같이 본다 */
const shot = async (page, name) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) overflows.push(`${name}: ${over}px`);
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
};

async function newUser(browser, { latency = 0.12, apple = 'fake', ...world } = {}) {
  const context = await browser.newContext({ viewport: { width: VW, height: VW < 360 ? 600 : 844 }, deviceScaleFactor: 2, locale: 'ko-KR', permissions: ['microphone'] });
  await context.addInitScript(fakeWorld, { latency, videos: VIDEOS, jitterMs: 4, ...world });
  if (apple === 'fake') await fakeApple(context);
  else await blockApple(context);
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', (e) => console.log('   [page error]', e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|40[0-9]|ERR_FAILED|net::/.test(m.text()) && console.log('   [console]', m.text()));
  return page;
}

const getRoom = (page, code) =>
  page.evaluate(async (c) => {
    const who = JSON.parse(localStorage.getItem(`ttb.id.${c}`));
    return (await fetch(`/api/rooms/${c}`, { headers: { authorization: `Bearer ${who.id}.${who.key}` } })).json();
  }, code);

/** 방을 열고 번호를 돌려준다 (파트 나누기 화면에서 시작) */
async function openRoom(page, name, seats) {
  await page.getByRole('heading', { name: '파트를 나눠요' }).waitFor();
  for (let i = 4; i > seats; i--) await page.getByRole('button', { name: '줄이기' }).click();
  await page.getByLabel('내 이름').fill(name);
  const open = page.getByRole('button', { name: '방 열고 번호 받기' });
  await open.waitFor({ timeout: 20000 });
  await open.click();
  await page.locator('.code-show').waitFor({ timeout: 15000 });
  return (await page.locator('.code-show').innerText()).replace(/\D/g, '');
}

/** 가짜 가수에게 이 방의 줄 시작 시각을 알려 준다 */
async function teachSinger(page, room) {
  await page.evaluate(
    ({ segStart, times }) => {
      const t = window.__ttbTest;
      t.segStart = segStart;
      t.clickTimes = times;
      t.singing = true;
    },
    { segStart: room.song.yt.start, times: room.lines.map((l) => l.t0) },
  );
}

/** 저장된 내 녹음을 받아 풀고, 줄 시작마다 낸 소리가 몇 ms 어긋나 있는지 잰다 */
async function measureSync(page, code) {
  return page.evaluate(async (c) => {
    const who = JSON.parse(localStorage.getItem(`ttb.id.${c}`));
    const auth = { authorization: `Bearer ${who.id}.${who.key}` };
    const room = await (await fetch(`/api/rooms/${c}`, { headers: auth })).json();
    const { decodeWithLead, getCtx } = window.__ttbTest.lib;
    const out = [];
    for (const take of room.takes.filter((t) => t.member === who.id)) {
      const bytes = await (await fetch(`/api/rooms/${c}/blobs/${take.blob}`, { headers: auth })).arrayBuffer();
      const buf = await decodeWithLead(bytes, getCtx());
      const x = buf.getChannelData(0);
      const sr = buf.sampleRate;
      let peak = 0;
      for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
      for (const line of room.lines) {
        const expect = Math.round((line.t0 - take.start) * sr);
        if (expect < sr * 0.05 || expect > x.length - sr * 0.3) continue;
        let onset = -1;
        for (let i = expect - Math.round(sr * 0.15); i < expect + Math.round(sr * 0.15); i++) {
          if (Math.abs(x[i]) > peak * 0.25) {
            onset = i;
            break;
          }
        }
        if (onset >= 0) out.push({ line: line.t0, errorMs: ((onset - expect) / sr) * 1000, latencyMs: take.latencyMs });
      }
    }
    return out;
  }, code);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const s1 = startServer(8793, {});
const s2 = startServer(8794, { MOCK_AI: '1', YOUTUBE_API_KEY: 'test-key' });
try {
  await Promise.all([s1.ready, s2.ready]);
  const BASE = s1.base;

  // ───────── 1. 가수·곡 이름으로 찾아서 방 만들기 ─────────
  const host = await newUser(browser, { latency: 0.137 });
  await host.goto(BASE + '/new');
  await shot(host, '50-find-empty');
  await host.locator('#song-q').fill('떼창방 밴드 연습용 노래');
  await host.getByRole('button', { name: '찾기' }).click();
  await host.locator('.song-row').first().waitFor({ timeout: 15000 });
  const rows = await host.locator('.song-row').allInnerTexts();
  assert.match(rows[0], /연습용 노래[\s\S]*떼창방 밴드[\s\S]*0:24/);
  assert.equal(rows.length, 2);
  await shot(host, '51-find-results');
  await host.locator('.song-row').first().click();
  await host.getByRole('heading', { name: '반주로 쓸 영상을 골라요' }).waitFor();
  await host.getByText('가사를 찾았어요. 줄마다 타이밍도 들어 있어요 (8줄).').waitFor({ timeout: 15000 });
  const href = await host.getByRole('link', { name: '유튜브에서 이 곡 찾기' }).getAttribute('href');
  assert.equal(href, `https://www.youtube.com/results?search_query=${encodeURIComponent('떼창방 밴드 연습용 노래 audio')}`);
  await shot(host, '52-source-empty');
  console.log('  ✓ 한글로 찾은 곡의 가사(시간표 포함)를 자동으로 찾아왔다. 영상은 유튜브에서 찾아 붙이도록 안내한다');

  // 유튜브 밖에서 재생이 막힌 영상은 붙여 넣을 때 알려 준다
  await host.locator('#yt-url').fill('https://youtu.be/blockedAAAA');
  await host.getByRole('button', { name: '확인' }).click();
  await host.getByText('유튜브 밖에서 재생하지 못하게 막혀 있어요').waitFor({ timeout: 10000 });
  await host.locator('#yt-url').fill('유튜브 주소가 아닌 글');
  await host.getByRole('button', { name: '확인' }).click();
  await host.getByText('유튜브 영상 주소가 아니에요').waitFor();

  await host.locator('#yt-url').fill(`같이 부를 노래 https://youtu.be/${DEMO}?si=abc123`);
  await host.getByRole('button', { name: '확인' }).click();
  await host.getByRole('heading', { name: '이 영상에 맞춰 부를까요?' }).waitFor({ timeout: 10000 });
  await host.locator('.fake-yt').waitFor();
  await host.getByText('떼창방 밴드 - 연습용 노래 (Official Audio)').waitFor();
  await shot(host, '53-source-video');
  await host.getByRole('button', { name: '다음: 부를 구간 고르기' }).click();
  await host.getByRole('heading', { name: '어디를 부를까요?' }).waitFor();
  assert.equal(await host.locator('.range-row').count(), 8);
  assert.equal(await host.locator('.range-row.is-in').count(), 8); // 짧은 곡이라 추천 구간이 곡 전체다
  // 끝낼 줄을 여섯째 줄로 줄였다가 다시 전체로
  await host.getByRole('button', { name: '끝낼 줄 고르기' }).click();
  await host.locator('.range-pick').nth(5).click();
  assert.equal(await host.locator('.range-row.is-in').count(), 6);
  assert.match(await host.locator('.range-sum').innerText(), /6줄/);
  await shot(host, '54-range-lines');
  await host.getByRole('button', { name: '처음부터 끝까지' }).click();
  assert.equal(await host.locator('.range-row.is-in').count(), 8);
  // 영상을 틀면 지금 나오는 줄에 표시가 된다 (셋째 줄부터 들어 본다)
  await host.getByRole('button', { name: '이 줄부터 들어 보기' }).nth(2).click();
  await host.locator('.range-row.is-now').waitFor({ timeout: 8000 });
  const nowCheck = await host.evaluate(() => {
    const p = window.__ttbTest.players.at(-1);
    const rows = [...document.querySelectorAll('.range-row')];
    return { video: p.media(), row: rows.findIndex((r) => r.classList.contains('is-now')) };
  });
  const wantRow = LRC_STARTS.filter((t) => t <= nowCheck.video + 0.05).length - 1;
  assert.ok(Math.abs(nowCheck.row - wantRow) <= 1, `지금 줄 표시가 영상과 안 맞는다 (${JSON.stringify(nowCheck)}, 기대 ${wantRow})`);
  // 가사 싱크 조절은 접혀 있다 (음원과 길이가 같은 영상이라 보통 필요 없다)
  assert.equal(await host.getByRole('button', { name: '가사 0.1초 늦추기' }).isVisible(), false);
  await host.locator('.sync-card summary').click();
  await host.getByRole('button', { name: '가사 0.1초 늦추기' }).click();
  assert.equal(await host.locator('#lyric-shift').innerText(), '0.1초 늦춤');
  await host.getByRole('button', { name: '가사 0.1초 당기기' }).click();
  assert.equal(await host.locator('#lyric-shift').innerText(), '그대로');
  await shot(host, '55-range-playing');
  await host.getByRole('button', { name: '이 구간으로 할게요' }).click();
  await host.getByRole('heading', { name: '파트를 나눠요' }).waitFor();
  assert.equal(await host.locator('#room-title').inputValue(), '연습용 노래');
  assert.equal(await host.locator('.fake-yt').count(), 0); // 파트 나누기에서는 영상을 내린다
  await shot(host, '56-parts');
  const code = await openRoom(host, '방장민지', 2);
  const room0 = await getRoom(host, code);
  assert.equal(room0.song.blob, null);
  assert.equal(room0.song.yt.id, DEMO);
  assert.equal(room0.song.artist, '떼창방 밴드');
  assert.ok(Math.abs(room0.song.yt.start - (LRC_STARTS[0] - 1)) < 0.01, `구간 시작 ${room0.song.yt.start}`);
  assert.equal(room0.lines.length, 8);
  room0.lines.forEach((l, i) => assert.ok(Math.abs(l.t0 + room0.song.yt.start - LRC_STARTS[i]) < 0.01, `줄 ${i} 시각 ${l.t0}`));
  assert.ok(room0.song.dur > 21 && room0.song.dur <= 24.07 - room0.song.yt.start + 0.01);
  console.log(`  ✓ 영상 링크를 붙이고 가사 줄로 구간을 골라 방을 열었다: ${code} (음원은 올리지 않는다)`);

  // ───────── 2. 방장: 영상에 맞춰 녹음 ─────────
  await host.getByRole('button', { name: '방으로 들어가기' }).click();
  await host.getByRole('heading', { name: '어느 파트를 부를래요?' }).waitFor();
  await host.getByRole('button', { name: /빨강 파트/ }).click();
  await host.getByRole('button', { name: '내 파트 녹음하기' }).waitFor();
  await host.locator('.player-card .fake-yt').waitFor();
  await shot(host, '57-room');
  await host.getByRole('button', { name: '내 파트 녹음하기' }).click();
  await host.getByRole('heading', { name: '녹음 준비' }).waitFor();
  await host.getByRole('button', { name: '마이크 켜기' }).click();
  await host.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  await shot(host, '58-rec-ready');
  // 유튜브 반주는 싱크를 자동으로 잴 수 없으므로 시험 소리로 한 번 재 둔다
  await host.getByText('소리 설정').click();
  await host.getByRole('button', { name: '싱크 미리 맞춰 두기' }).click();
  await host.getByRole('button', { name: '재기 시작' }).click();
  await host.getByText('녹음에 자동으로 반영할게요').waitFor({ timeout: 20000 });
  await host.getByRole('button', { name: '닫기' }).click();
  await teachSinger(host, room0);
  const hostNotes = [];
  for (let round = 0; round < 6; round++) {
    await host.getByRole('button', { name: /녹음 시작|다시 녹음하기/ }).click();
    await host.locator('.stage.has-video').waitFor();
    if (round === 0) {
      await host.locator('.stage.is-singing').waitFor({ timeout: 20000 });
      await host.waitForTimeout(500);
      await shot(host, '59-stage-video');
      // 무대에서도 영상이 화면 안에 다 보여야 한다
      const box = await host.locator('.stage .yt-box').boundingBox();
      assert.ok(box && box.width >= 200 && box.height >= 199 && box.y >= 0, `영상 크기 ${JSON.stringify(box)}`);
    }
    await host.getByRole('heading', { name: '들어 보세요' }).waitFor({ timeout: 90000 });
    hostNotes.push(await host.locator('.lead').first().innerText());
    if (round === 0) await shot(host, '60-review-video');
    await host.getByRole('button', { name: '이걸로 저장' }).click();
    const done = host.getByRole('heading', { name: '다 불렀어요!' });
    const next = host.getByRole('heading', { name: '저장했어요' });
    await Promise.race([done.waitFor({ timeout: 30000 }), next.waitFor({ timeout: 30000 })]);
    if (await done.isVisible()) break;
  }
  assert.match(hostNotes[0], /지난번에 맞춘 싱크/);
  const hostSync = await measureSync(host, code);
  assert.ok(hostSync.length >= 3, `방장: 잰 지점이 너무 적다 (${hostSync.length})`);
  const hostJudge = judgeSync(hostSync.map((r) => r.errorMs));
  if (process.env.DEBUG_SYNC) console.log('     방장 오차들:', hostSync.map((r) => `${r.line.toFixed(1)}s:${r.errorMs.toFixed(1)}`).join(', '));
  console.log(`  ✓ 방장 녹음: 넣은 마이크 지연 137ms → 시험 소리로 잰 값 ${hostSync[0].latencyMs}ms, 영상 기준 남은 오차 ${hostJudge.typical.toFixed(1)}ms (${hostSync.length}곳, 가장 튄 곳 ${hostJudge.worst.toFixed(1)}ms)`);
  assert.ok(hostJudge.typical < 12, `방장: 싱크 오차가 크다 (${hostJudge.typical.toFixed(1)}ms)`);

  // ───────── 3. 친구: 휴대폰처럼 영상을 직접 눌러야 재생되는 브라우저 ─────────
  const guest = await newUser(browser, { latency: 0.262, blockAutoplay: true });
  await guest.goto(`${BASE}/r/${code}`);
  await guest.getByText('방장민지 님이 만든 방이에요').waitFor();
  await guest.getByLabel('내 이름').fill('도윤');
  await guest.getByRole('button', { name: '들어가기' }).click();
  await guest.getByRole('button', { name: /파랑 파트/ }).click();
  await guest.getByRole('button', { name: '내 파트 녹음하기' }).click();
  await guest.getByRole('button', { name: '마이크 켜기' }).click();
  await guest.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  await teachSinger(guest, room0);
  let guestNote = '';
  for (let round = 0; round < 6; round++) {
    await guest.getByRole('button', { name: /녹음 시작|다시 녹음하기/ }).click();
    if (round === 0) {
      // 브라우저가 재생을 막았다: 영상을 눌러 달라는 안내가 나오고, 누르면 이어진다
      await guest.getByText('▶ 를 눌러 주세요').waitFor({ timeout: 10000 });
      await shot(guest, '61-stage-tap');
      await guest.locator('.fake-yt').click();
    }
    await guest.getByRole('heading', { name: '들어 보세요' }).waitFor({ timeout: 90000 });
    if (round === 0) {
      guestNote = await guest.locator('.lead').first().innerText();
      // 처음 쓰는 기기: 들어보는 화면에서 시험 소리로 재서 방금 녹음을 다시 맞춘다
      await guest.getByRole('button', { name: '귀로 맞추기 어려우면 자동으로 재기' }).click();
      await guest.getByRole('button', { name: '재기 시작' }).click();
      await guest.getByText('방금 녹음도 이 값으로 다시 맞췄어요').waitFor({ timeout: 20000 });
      await guest.getByRole('button', { name: '닫기' }).click();
    }
    await guest.getByRole('button', { name: '이걸로 저장' }).click();
    const done = guest.getByRole('heading', { name: '다 불렀어요!' });
    const next = guest.getByRole('heading', { name: '저장했어요' });
    await Promise.race([done.waitFor({ timeout: 30000 }), next.waitFor({ timeout: 30000 })]);
    if (await done.isVisible()) break;
  }
  assert.match(guestNote, /처음 한 번은 직접 맞춰야/);
  const guestSync = await measureSync(guest, code);
  assert.ok(guestSync.length >= 3, `친구: 잰 지점이 너무 적다 (${guestSync.length})`);
  const guestJudge = judgeSync(guestSync.map((r) => r.errorMs));
  if (process.env.DEBUG_SYNC) console.log('     친구 오차들:', guestSync.map((r) => `${r.line.toFixed(1)}s:${r.errorMs.toFixed(1)}`).join(', '));
  console.log(`  ✓ 친구 녹음(영상을 직접 눌러 시작): 넣은 지연 262ms → 잰 값 ${guestSync[0].latencyMs}ms, 남은 오차 ${guestJudge.typical.toFixed(1)}ms (${guestSync.length}곳, 가장 튄 곳 ${guestJudge.worst.toFixed(1)}ms)`);
  assert.ok(guestJudge.typical < 12, `친구: 싱크 오차가 크다 (${guestJudge.typical.toFixed(1)}ms)`);

  // ───────── 4. 영상과 두 사람 목소리를 함께 듣기 ─────────
  await host.getByRole('button', { name: '방으로 돌아가기' }).click();
  await host.getByRole('button', { name: '완성본 듣기' }).waitFor({ timeout: 15000 });
  await host.evaluate(() => (window.__ttbTest.voices = []));
  await host.getByRole('button', { name: '재생' }).click();
  await host.getByRole('button', { name: '멈추기' }).waitFor({ timeout: 20000 });
  await host.waitForFunction(() => window.__ttbTest.voices.length > 0, null, { timeout: 15000 });
  await host.waitForTimeout(2500);
  const pos = await host.locator('.player-text strong').innerText();
  assert.notEqual(pos.split('/')[0].trim(), '0:00');
  await shot(host, '62-room-playing');
  // 타임라인을 눌러 다른 곳으로 옮겨도 목소리가 영상을 따라간다
  const tl = await host.locator('.timeline-canvas').boundingBox();
  await host.mouse.click(tl.x + tl.width * 0.5, tl.y + tl.height / 2);
  await host.waitForTimeout(2000);
  const voices = await host.evaluate(() => window.__ttbTest.voices);
  // 소리 처리가 밀려 다시 맞춘 적이 있으면 그 직전 값은 어긋나 있으므로, 마지막으로 맞춘 값을 본다
  const voiceWorst = Math.abs(voices[voices.length - 1].errorMs);
  await host.getByRole('button', { name: '멈추기' }).click();
  assert.equal(await host.evaluate(() => window.__ttbTest.players.filter((p) => !p.dead).at(-1).state), 2); // 영상도 멈춘다
  console.log(`  ✓ 방 화면: 영상에 맞춰 목소리를 깔았다 (${voices.length}번 맞춤, 마지막으로 맞춘 값과 참값의 차이 ${voiceWorst.toFixed(1)}ms). 위치 ${pos}`);
  assert.ok(voiceWorst < 12, `재생 싱크 오차가 크다 (${voiceWorst.toFixed(1)}ms)`);

  // ───────── 5. 완성본 화면: 목소리만 파일로 ─────────
  await host.getByRole('button', { name: '완성본 듣기' }).click();
  await host.getByRole('heading', { name: '오늘의 시상식' }).waitFor({ timeout: 15000 });
  await host.locator('.player-card .fake-yt').waitFor();
  await host.getByRole('heading', { name: '목소리 전체 타이밍' }).waitFor();
  await host.getByRole('button', { name: '목소리 전체 10ms 늦게' }).click();
  assert.equal(await host.locator('.sync-head output').first().innerText(), '10ms 늦게');
  await host.getByRole('button', { name: '목소리 전체 10ms 빠르게' }).click();
  await shot(host, '63-mix-video');
  await host.getByRole('button', { name: '목소리만 파일로 만들기' }).click();
  const link = host.getByRole('link', { name: 'MP3 내려받기' });
  await link.waitFor({ timeout: 60000 });
  const fileName = await link.getAttribute('download');
  assert.match(fileName, /\(목소리\)\.mp3$/);
  const dl = host.waitForEvent('download');
  await link.click();
  const file = await dl;
  const size = fs.statSync(await file.path()).size;
  assert.ok(size > 50_000, `목소리 파일이 너무 작다 (${size})`);
  console.log(`  ✓ 영상 소리는 빼고 목소리만 합친 MP3 를 만들었다: ${fileName} (${Math.round(size / 1024)}KB)`);

  if (process.env.ONLY_RECORD) throw new Error('ONLY_RECORD: 녹음까지만 확인하고 멈춤');
  // ───────── 6. 링크로 시작 + 음원과 길이가 다른 영상(뮤직비디오): 가사 싱크 밀기 ─────────
  const linker = await newUser(browser, {});
  await linker.goto(BASE + '/new');
  await linker.locator('#yt-url').fill(`https://www.youtube.com/watch?v=${MV}`);
  await linker.getByRole('button', { name: '확인' }).click();
  await linker.getByRole('heading', { name: '이 영상에 맞춰 부를까요?' }).waitFor({ timeout: 10000 });
  // 영상 제목으로 곡을 어림해서 가사 후보를 보여 준다
  assert.equal(await linker.locator('#lyr-q').inputValue(), '떼창방 밴드 - 연습용 노래');
  await linker.locator('.song-row').first().waitFor({ timeout: 15000 });
  await shot(linker, '64-link-first');
  await linker.locator('.song-row').first().click();
  await linker.getByText('가사를 찾았어요. 줄마다 타이밍도 들어 있어요 (8줄).').waitFor({ timeout: 15000 });
  await linker.getByRole('button', { name: '다음: 부를 구간 고르기' }).click();
  await linker.getByText('이 영상은 음원과 길이가 달라요').waitFor();
  // 방법 1: 버튼으로 4초 늦춘다
  for (let i = 0; i < 4; i++) await linker.getByRole('button', { name: '가사 1초 늦추기' }).click();
  assert.equal(await linker.locator('#lyric-shift').innerText(), '4.0초 늦춤');
  // 방법 2: 영상을 틀고 첫 줄이 시작되는 순간 눌러서 맞춘다 (도입부 5초 + 첫 줄 2.6초)
  await linker.getByRole('button', { name: '영상을 들으며 눌러서 맞추기' }).click();
  await linker.locator('.fake-yt').click();
  await linker.waitForFunction(() => window.__ttbTest.players.at(-1).state === 1);
  await shot(linker, '65-tap-shift');
  await linker.evaluate((firstLine) => {
    const p = window.__ttbTest.players.at(-1);
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('지금 시작!'));
    // 앱이 손이 늦는 만큼 0.08초 당겨 주므로 그만큼 늦게 누른다
    const wait = p.t0 + (firstLine + 0.08 - p.base) * 1000 - performance.now();
    return new Promise((resolve) => setTimeout(() => (btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), resolve()), Math.max(0, wait)));
  }, LRC_STARTS[0] + 5);
  const shiftText = await linker.locator('#lyric-shift').innerText();
  const tapped = Number(/([\d.]+)초 늦춤/.exec(shiftText)?.[1]);
  assert.ok(Math.abs(tapped - 5) <= 0.11, `눌러서 맞춘 값이 어긋났다: ${shiftText}`);
  await linker.locator('.fake-yt').click(); // 멈춤
  // 0.1초 단위로 다듬어 정확히 5.0초로
  for (let i = 0; i < 3 && (await linker.locator('#lyric-shift').innerText()) !== '5.0초 늦춤'; i++) {
    const cur = Number(/([\d.]+)초/.exec(await linker.locator('#lyric-shift').innerText())[1]);
    await linker.getByRole('button', { name: cur < 5 ? '가사 0.1초 늦추기' : '가사 0.1초 당기기' }).click();
  }
  assert.equal(await linker.locator('#lyric-shift').innerText(), '5.0초 늦춤');
  await linker.getByRole('button', { name: '이 구간으로 할게요' }).click();
  const code2 = await openRoom(linker, '링크방장', 3);
  const room2 = await getRoom(linker, code2);
  assert.equal(room2.song.yt.id, MV);
  assert.ok(Math.abs(room2.song.yt.start - (LRC_STARTS[0] + 5 - 1)) < 0.01, `구간 시작 ${room2.song.yt.start}`);
  room2.lines.forEach((l, i) => assert.ok(Math.abs(l.t0 + room2.song.yt.start - (LRC_STARTS[i] + 5)) < 0.01, `줄 ${i} 시각 ${l.t0}`));
  assert.equal(room2.title, '연습용 노래');
  console.log(`  ✓ 링크로 시작: 영상 제목으로 가사를 찾고, 뮤직비디오의 도입부만큼 가사를 밀어(눌러서 ${shiftText}) 방을 열었다`);

  // ───────── 6-나. 영상 앞에 광고가 붙은 경우 ① 광고가 도는 동안 플레이어가 "재생 중"이라고 알리는 경우: 녹음 ─────────
  // 광고의 시각(0초부터)을 영상의 시각으로 잘못 알면 광고에 맞춰 녹음하게 된다. 광고가 끝나고 진짜 영상이 돌 때까지 기다려야 한다.
  const adSinger = await newUser(browser, { latency: 0.15, ad: { sec: 9, len: 15, state: 1 } });
  await adSinger.goto(`${BASE}/r/${code2}`);
  await adSinger.getByLabel('내 이름').fill('광고본가수');
  await adSinger.getByRole('button', { name: '들어가기' }).click();
  await adSinger.getByRole('button', { name: /빨강 파트/ }).click();
  await adSinger.getByRole('button', { name: '내 파트 녹음하기' }).click();
  await adSinger.getByRole('button', { name: '마이크 켜기' }).click();
  await adSinger.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  await adSinger.getByText('소리 설정').click();
  await adSinger.getByRole('button', { name: '싱크 미리 맞춰 두기' }).click();
  await adSinger.getByRole('button', { name: '재기 시작' }).click();
  await adSinger.getByText('녹음에 자동으로 반영할게요').waitFor({ timeout: 20000 });
  await adSinger.getByRole('button', { name: '닫기' }).click();
  await teachSinger(adSinger, room2);
  const adWarnings = [];
  for (let round = 0; round < 6; round++) {
    await adSinger.getByRole('button', { name: /녹음 시작|다시 녹음하기/ }).click();
    if (round === 0) {
      // 광고가 도는 동안: 무대는 시작하지 않고 기다리며, 기다리면 된다고 알려 준다
      await adSinger.getByText('광고가 나오면 끝난 뒤에 시작해요').waitFor({ timeout: 10000 });
      const during = await adSinger.evaluate(() => {
        const p = window.__ttbTest.players.at(-1);
        return { ad: !!p.ad, state: p.state, waiting: !!document.querySelector('.stage-prep'), singing: !!document.querySelector('.stage.is-singing') };
      });
      assert.deepEqual(during, { ad: true, state: 1, waiting: true, singing: false });
      await shot(adSinger, '73-stage-ad');
    }
    await adSinger.getByRole('heading', { name: '들어 보세요' }).waitFor({ timeout: 90000 });
    adWarnings.push(...(await adSinger.locator('.pill-bad').allInnerTexts()));
    await adSinger.getByRole('button', { name: '이걸로 저장' }).click();
    const done = adSinger.getByRole('heading', { name: '다 불렀어요!' });
    const next = adSinger.getByRole('heading', { name: '저장했어요' });
    await Promise.race([done.waitFor({ timeout: 30000 }), next.waitFor({ timeout: 30000 })]);
    if (await done.isVisible()) break;
  }
  assert.ok(!adWarnings.some((w) => /멈칫/.test(w)), `광고 뒤 녹음에 끊김 경고가 떴다: ${adWarnings.join(' / ')}`);
  assert.equal(await adSinger.evaluate(() => window.__ttbTest.players.at(-1).seeksInAd), 0); // 광고 중에는 영상을 건드리지 않는다
  const adSync = await measureSync(adSinger, code2);
  assert.ok(adSync.length >= 2, `광고 뒤 녹음: 잰 지점이 너무 적다 (${adSync.length})`);
  const adJudge = judgeSync(adSync.map((r) => r.errorMs));
  if (process.env.DEBUG_SYNC) console.log('     광고 뒤 오차들:', adSync.map((r) => `${r.line.toFixed(1)}s:${r.errorMs.toFixed(1)}`).join(', '));
  console.log(`  ✓ 영상 앞 광고(재생 중으로 알리는 경우): 광고가 끝날 때까지 기다렸다가 녹음했다. 넣은 지연 150ms → 잰 값 ${adSync[0].latencyMs}ms, 남은 오차 ${adJudge.typical.toFixed(1)}ms (${adSync.length}곳, 가장 튄 곳 ${adJudge.worst.toFixed(1)}ms)`);
  assert.ok(adJudge.typical < 12, `광고 뒤 녹음: 싱크 오차가 크다 (${adJudge.typical.toFixed(1)}ms)`);

  // ───────── 6-다. 영상 앞 광고 ② 광고가 도는 동안 플레이어가 "시작 전"으로 남는 경우: 방 화면에서 듣기 ─────────
  const adWatcher = await newUser(browser, { ad: { sec: 5, len: 15, state: -1 } });
  await adWatcher.goto(`${BASE}/r/${code}`);
  await adWatcher.getByLabel('내 이름').fill('구경꾼');
  await adWatcher.getByRole('button', { name: '들어가기' }).click();
  await adWatcher.locator('.player-card .fake-yt').waitFor({ timeout: 15000 });
  await adWatcher.getByRole('button', { name: '재생' }).click();
  // 멈춰 있을 때만 누르고, 광고면 기다리라고 알려 준다 (광고를 누르면 광고 사이트가 열린다)
  await adWatcher.getByText('광고가 나오는 중이면 끝날 때까지 기다리면 돼요').waitFor({ timeout: 10000 });
  await shot(adWatcher, '74-room-ad');
  await adWatcher.waitForFunction(() => window.__ttbTest.voices.length > 0, null, { timeout: 20000 });
  await adWatcher.waitForTimeout(3000);
  const afterAd = await adWatcher.evaluate(() => ({ voices: window.__ttbTest.voices, note: !!document.querySelector('.yt-note'), state: window.__ttbTest.players.at(-1).state }));
  assert.equal(afterAd.note, false, '영상이 시작됐는데 안내가 남아 있다');
  assert.equal(afterAd.state, 1);
  const adVoice = Math.abs(afterAd.voices.at(-1).errorMs);
  await adWatcher.getByRole('button', { name: '멈추기' }).click();
  console.log(`  ✓ 영상 앞 광고(시작 전으로 남는 경우): 광고가 끝난 뒤 영상에 맞춰 목소리를 깔았다 (참값과의 차이 ${adVoice.toFixed(1)}ms)`);
  assert.ok(adVoice < 12, `광고 뒤 재생 싱크 오차가 크다 (${adVoice.toFixed(1)}ms)`);

  // ───────── 7. 시간표 없는 가사: 영상에서 시간으로 구간을 고르고, 영상을 들으며 탭으로 맞춘다 ─────────
  const tapper = await newUser(browser, { videos: { ...VIDEOS, [MV]: { ...VIDEOS[MV], blockedOnPlay: true } } });
  await tapper.goto(BASE + '/new');
  await tapper.locator('#song-q').fill('Untimed Song');
  await tapper.getByRole('button', { name: '찾기' }).click();
  await tapper.locator('.song-row').first().waitFor({ timeout: 15000 });
  assert.match(await tapper.locator('.song-row').first().innerText(), /Untimed Song[\s\S]*가사/);
  await tapper.locator('.song-row').first().click();
  await tapper.getByText('가사를 찾았어요. 타이밍은 다음 단계에서 맞춰요.').waitFor({ timeout: 15000 });
  // 틀어 봐야 알 수 있는 막힌 영상: 다음으로 넘어가기 전에 잠깐 틀어 보고, 안 되면 알려 준다
  await tapper.locator('#yt-url').fill(`https://youtu.be/${MV}`);
  await tapper.getByRole('button', { name: '확인' }).click();
  await tapper.locator('.fake-yt').waitFor({ timeout: 10000 });
  await tapper.getByRole('button', { name: '다음: 부를 구간 고르기' }).click();
  await tapper.locator('.toast-error').waitFor({ timeout: 10000 });
  assert.match(await tapper.locator('.toast-error').innerText(), /유튜브 밖에서 재생하지 못하게/);
  await tapper.locator('.yt-note-bad').waitFor();
  assert.equal(await tapper.getByRole('heading', { name: '이 영상에 맞춰 부를까요?' }).count(), 1); // 그대로 이 단계에 머문다
  await shot(tapper, '66-video-blocked');
  await tapper.getByRole('button', { name: '다른 영상으로 바꾸기' }).click();
  await tapper.locator('#yt-url').fill(`https://youtu.be/${DEMO}`);
  await tapper.getByRole('button', { name: '확인' }).click();
  await tapper.locator('.fake-yt').waitFor({ timeout: 10000 });
  await tapper.getByRole('button', { name: '다음: 부를 구간 고르기' }).click();
  await tapper.getByText('영상을 틀어 보다가').waitFor();
  // 재생되는지 확인하느라 잠깐 틀었던 영상은 멈춰 있다
  assert.equal(await tapper.evaluate(() => window.__ttbTest.players.filter((p) => !p.dead).at(-1).state), 2);
  // 영상을 5초쯤 틀다가 "여기부터", 조금 더 가서 "여기까지"
  await tapper.locator('.fake-yt').click();
  await tapper.waitForFunction(() => window.__ttbTest.players.at(-1).media() > 1.2);
  await tapper.getByRole('button', { name: '여기부터 부르기' }).click();
  const marked = await tapper.locator('.trim-times strong').innerText();
  assert.match(marked, /^0:01 ~/);
  await tapper.locator('.fake-yt').click();
  await shot(tapper, '67-range-time');
  await tapper.getByRole('button', { name: '전체' }).click();
  assert.match(await tapper.locator('.trim-times strong').innerText(), /^0:00 ~ 0:24/);
  await tapper.getByRole('button', { name: '고른 구간 들어 보기' }).click();
  await tapper.getByRole('button', { name: '멈추기' }).waitFor();
  await tapper.getByRole('button', { name: '멈추기' }).click();
  await tapper.getByRole('button', { name: '이 구간으로 할게요' }).click();
  await tapper.getByRole('heading', { name: '가사를 넣어 주세요' }).waitFor();
  assert.equal((await tapper.locator('#lyrics').inputValue()).split('\n').length, 8); // 찾아온 가사가 미리 들어 있다
  await tapper.getByText('찾아온 곡 전체 가사예요').waitFor();
  await shot(tapper, '68-lyrics-prefilled');
  await tapper.getByRole('button', { name: '다음: 타이밍 맞추기' }).click();
  await tapper.getByRole('button', { name: /들으면서 탭하기/ }).click();
  await tapper.getByRole('button', { name: '시작하기' }).click();
  await tapper.locator('.tap-button').waitFor();
  await tapper.waitForFunction(() => window.__ttbTest.players.at(-1).state === 1, null, { timeout: 10000 });
  await tapper.evaluate((starts) => {
    const p = window.__ttbTest.players.at(-1);
    const btn = document.querySelector('.tap-button');
    for (const s of starts) {
      const wait = p.t0 + (s + 0.08 - p.base) * 1000 - performance.now();
      setTimeout(() => btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), Math.max(0, wait));
    }
  }, LRC_STARTS);
  await tapper.waitForTimeout(3000);
  await shot(tapper, '69-tap-video');
  await tapper.getByText('탭한 대로 맞췄어요').waitFor({ timeout: 40000 });
  assert.equal(await tapper.locator('.timing-list li').count(), 8);
  // 가사 전체를 0.5초 뒤로 밀었다가 되돌린다
  const firstTime = () => tapper.locator('.timing-list li .timing-text small').first().innerText();
  const before = await firstTime();
  await tapper.getByRole('button', { name: '0.5초 뒤로' }).click();
  await tapper.getByRole('button', { name: '0.5초 뒤로' }).click();
  assert.notEqual(await firstTime(), before);
  await tapper.getByRole('button', { name: '0.5초 앞으로' }).click();
  await tapper.getByRole('button', { name: '0.5초 앞으로' }).click();
  assert.equal(await firstTime(), before);
  // 한 줄을 영상으로 들어 본다
  await tapper.getByRole('button', { name: /들어 보기$/ }).nth(1).click();
  await tapper.waitForFunction(() => window.__ttbTest.players.at(-1).state === 1, null, { timeout: 10000 });
  await tapper.getByRole('button', { name: '다음: 파트 나누기' }).click();
  const code3 = await openRoom(tapper, '탭방장', 2);
  const room3 = await getRoom(tapper, code3);
  assert.equal(room3.song.yt.start, 0);
  const worstTap = Math.max(...room3.lines.map((l, i) => Math.abs(l.t0 - LRC_STARTS[i]) * 1000));
  console.log(`  ✓ 시간표 없는 가사: 영상에서 시간으로 구간을 고르고, 영상을 들으며 탭으로 맞췄다 (오차 최대 ${worstTap.toFixed(0)}ms)`);
  assert.ok(worstTap < 150, '탭 타이밍이 크게 어긋났다');

  // ───────── 8. AI·유튜브 열쇠가 있는 서버: 한글 검색어 → 공식 표기로 다시 찾기, 영상까지 자동 ─────────
  const auto = await newUser(browser, { apple: 'blocked' });
  await auto.goto(s2.base + '/new');
  await auto.locator('#song-q').fill('떼창방 밴드 연습용 노래');
  await auto.getByRole('button', { name: '찾기' }).click();
  await auto.getByText('"Ttechang Band Practice Song"(으)로 찾았어요.').waitFor({ timeout: 20000 });
  assert.equal(await auto.locator('.song-row').count(), 1); // 같은 곡은 시간표 있는 쪽 하나만
  await shot(auto, '70-ai-rewrite');
  await auto.locator('.song-row').first().click();
  await auto.getByRole('heading', { name: '이 영상에 맞춰 부를까요?' }).waitFor({ timeout: 15000 });
  await auto.getByText('가사를 찾았어요. 줄마다 타이밍도 들어 있어요 (8줄).').waitFor({ timeout: 15000 });
  assert.equal(await auto.evaluate(() => window.__ttbTest.players.at(-1).id), DEMO); // 라이브·뮤직비디오보다 음원 영상을 먼저 고른다
  assert.equal(await auto.locator('.alt-row').count(), 2);
  await shot(auto, '71-auto-video');
  // 다른 영상으로 바꾸면 그 영상이 뜨고, 원래 영상은 목록에 남는다
  await auto.locator('.alt-row').first().click();
  await auto.waitForFunction((id) => window.__ttbTest.players.filter((p) => !p.dead).at(-1)?.id === id, MV, { timeout: 10000 });
  assert.ok((await auto.locator('.alt-row').allInnerTexts()).some((t) => /Official Audio|연습용 노래/.test(t)));
  await auto.locator('.alt-row').first().click();
  await auto.waitForFunction((id) => window.__ttbTest.players.filter((p) => !p.dead).at(-1)?.id === id, DEMO, { timeout: 10000 });
  await auto.getByRole('button', { name: '다음: 부를 구간 고르기' }).click();
  await auto.getByRole('button', { name: '이 구간으로 할게요' }).click();
  const code4 = await openRoom(auto, '자동방장', 4);
  const room4 = await getRoom(auto, code4);
  assert.equal(room4.song.yt.id, DEMO);
  assert.equal(room4.title, 'Practice Song');
  console.log('  ✓ Apple 검색이 막혀도 AI 가 검색어를 공식 표기로 바꿔 찾고, 유튜브 열쇠가 있으면 영상까지 자동으로 골라 준다');

  // ───────── 9. 유튜브 앱의 "공유"로 넘어온 주소로 바로 시작 ─────────
  // 휴대폰처럼 영상을 직접 눌러야 재생되는 브라우저: 다음으로 넘어갈 때 눌러 달라고 안내한다
  const shared = await newUser(browser, { blockAutoplay: true });
  await shared.goto(`${BASE}/new?text=${encodeURIComponent(`https://youtu.be/${DEMO}`)}`);
  await shared.getByRole('heading', { name: '이 영상에 맞춰 부를까요?' }).waitFor({ timeout: 10000 });
  await shared.locator('.fake-yt').waitFor();
  await shared.getByRole('button', { name: '다음: 부를 구간 고르기' }).click();
  await shared.getByRole('button', { name: '영상이 재생되는지 확인하는 중…' }).waitFor();
  await shared.getByText('한 번 눌러 재생해 주세요').waitFor({ timeout: 10000 });
  await shot(shared, '72-confirm-tap');
  await shared.locator('.fake-yt').click();
  await shared.getByRole('heading', { name: '어디를 부를까요?' }).waitFor({ timeout: 10000 });
  console.log('  ✓ 공유로 넘어온 유튜브 주소로 바로 시작한다. 재생이 막힌 브라우저에서는 영상을 눌러 달라고 안내한다');

  // 아예 열리지 않는 영상(지워졌거나 막힌 영상)은 영상 자리에 이유를 보여 주고 다음으로 못 넘어가게 한다
  const dead = await newUser(browser, { videos: { ...VIDEOS, [DEMO]: { ...VIDEOS[DEMO], blocked: true } } });
  await dead.goto(`${BASE}/new?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${DEMO}`)}`);
  await dead.locator('.yt-cover-error').waitFor({ timeout: 10000 });
  assert.match(await dead.locator('.yt-cover-error').innerText(), /유튜브 밖에서 재생하지 못하게/);
  assert.equal(await dead.getByRole('button', { name: '다음: 부를 구간 고르기' }).isDisabled(), true);
  console.log('  ✓ 열리지 않는 영상은 이유를 보여 주고 넘어가지 못하게 한다');

  assert.deepEqual(overflows, [], `가로로 넘치는 화면이 있다 (${VW}px)`);
  console.log(`  ✓ ${VW}px 너비에서 가로로 넘치는 화면이 없다`);
  console.log('\n유튜브 반주 흐름 통과 (가짜 플레이어 기준)');
} catch (e) {
  for (const [i, p] of pages.entries()) {
    const toast = await p.locator('.toast').allInnerTexts().catch(() => []);
    const h1 = await p.locator('h1').allInnerTexts().catch(() => []);
    console.log(`   [실패 시 화면 ${i}] 제목: ${h1.join(' | ')} / 알림: ${toast.join(' | ')}`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/fail-${i}.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
  s1.stop();
  s2.stop();
}
