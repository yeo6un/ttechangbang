// 실제 브라우저 테스트 6: MR(반주) 파일로 부르고, 원곡 유튜브 영상을 가이드로 붙인 방.
//   곡 찾기 → MR 파일 + 원곡 영상 고르기 → 가사 줄로 구간 → 원곡과 MR 맞추기 → 방 열기
//   → 방장: 원곡 영상을 따라 부르며 녹음 (목소리는 MR 시간에 얹힌다)
//   → 친구: MR만 듣고 녹음 → 함께 듣기 → 반주가 들어간 완성본 MP3
// 진짜 유튜브에는 닿을 수 없어서 가짜 플레이어(tests/fake-yt.mjs)를 쓴다. 가짜 영상은 뮤직비디오처럼 앞에 5초짜리
// 도입부가 있고, MR 파일은 음원과 같은 시간표다. 가수는 "영상"의 가사 줄 시작마다 소리를 내므로,
// 저장된 녹음에서 그 소리가 "MR 시간"으로 제자리에 있으면 영상 ↔ MR 맞추기가 끝까지 맞은 것이다.
//   node tests/e2e-guide.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fakeApple, fakeWorld, judgeSync, measureClicks, readRoom } from './fake-yt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOT_DIR || '';
const VW = Number(process.env.VW || 390);
const PORT = 8795;
const BAR = (4 * 60) / 92;
/** 가사 데이터베이스(가짜)에 들어 있는 줄 시작 시각: 음원(= MR 파일) 기준 */
const LRC_STARTS = Array.from({ length: 8 }, (_, i) => (1 + i) * BAR);
const INTRO = 5;
const MV = 'ttbMV000001';
const DEMO = 'ttbDEMO0001';
const VIDEOS = {
  [MV]: { len: 29.07, title: '떼창방 밴드 - 연습용 노래 M/V', author: '떼창방 밴드' },
  [DEMO]: { len: 24.07, title: '떼창방 밴드 - 연습용 노래 (Official Audio)', author: '떼창방 밴드 - Topic' },
};
const MR_NAME = '떼창방 밴드 - 연습용 노래 (Inst.).wav';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttb-guide-'));
const server = spawn(process.execPath, [path.join(root, 'server/node-server.mjs')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MOCK_FIND: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('http://') && resolve());
  setTimeout(() => reject(new Error('server start timeout')), 8000);
});
const BASE = `http://127.0.0.1:${PORT}`;

const overflows = [];
const pages = [];
const shot = async (page, name) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) overflows.push(`${name}: ${over}px`);
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
async function newUser({ latency = 0.12, identity = null, ...world } = {}) {
  const context = await browser.newContext({ viewport: { width: VW, height: VW < 360 ? 600 : 844 }, deviceScaleFactor: 2, locale: 'ko-KR', permissions: ['microphone'] });
  await context.addInitScript(fakeWorld, { latency, videos: VIDEOS, jitterMs: 4, ...world });
  // 같은 사람이 다른 기기로 들어온 것처럼: 방 열쇠를 미리 넣어 둔다
  if (identity) await context.addInitScript(([k, v]) => localStorage.setItem(k, v), identity);
  await fakeApple(context);
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', (e) => console.log('   [page error]', e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|40[0-9]|ERR_FAILED|net::/.test(m.text()) && console.log('   [console]', m.text()));
  return page;
}

/** 가수에게 줄 시작 시각을 알려 준다. mr: 영상 없이 MR에 맞춰 부르는지 */
const teachSinger = (page, room, mr = false) =>
  page.evaluate(
    ({ segStart, times, mr }) => {
      const t = window.__ttbTest;
      t.segStart = segStart;
      t.clickTimes = times;
      t.singing = !mr;
      t.singMr = mr;
    },
    { segStart: room.song.guide.start, times: room.lines.map((l) => l.t0), mr },
  );

/** 싱크를 미리 재 둔다 (시험 소리) */
async function calibrate(page) {
  await page.getByText('소리 설정').click();
  await page.getByRole('button', { name: '싱크 미리 맞춰 두기' }).click();
  await page.getByRole('button', { name: '재기 시작' }).click();
  await page.getByText('녹음에 자동으로 반영할게요').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '닫기' }).click();
}

/** 내 파트를 끝까지 녹음·저장한다. each(round) 는 들어보는 화면에서 불린다. */
async function recordAll(page, each) {
  for (let round = 0; round < 6; round++) {
    await page.getByRole('button', { name: /녹음 시작|다시 녹음하기/ }).click();
    await page.getByRole('heading', { name: '들어 보세요' }).waitFor({ timeout: 90000 });
    await each?.(round);
    await page.getByRole('button', { name: '이걸로 저장' }).click();
    const done = page.getByRole('heading', { name: '다 불렀어요!' });
    const next = page.getByRole('heading', { name: '저장했어요' });
    await Promise.race([done.waitFor({ timeout: 30000 }), next.waitFor({ timeout: 30000 })]);
    if (await done.isVisible()) return;
  }
  throw new Error('녹음이 끝나지 않았다');
}

try {
  // ───────── 1. 곡을 찾고, MR 파일과 원곡 영상을 고른다 ─────────
  const host = await newUser({ latency: 0.137 });
  await host.goto(BASE + '/new');
  await shot(host, '80-find');
  await host.locator('#song-q').fill('떼창방 밴드 연습용 노래');
  await host.getByRole('button', { name: '찾기' }).click();
  await host.locator('.song-row').first().waitFor({ timeout: 15000 });
  await host.locator('.song-row').first().click();
  await host.getByRole('heading', { name: '반주와 원곡 영상을 골라요' }).waitFor();
  await host.getByText('가사를 찾았어요. 줄마다 타이밍도 들어 있어요 (8줄).').waitFor({ timeout: 15000 });
  // 아무것도 안 골랐으면 넘어갈 수 없다
  assert.equal(await host.getByRole('button', { name: '다음: 부를 구간 고르기' }).isDisabled(), true);
  await shot(host, '81-source-empty');

  // MR 파일: 연습용 비트를 WAV 로 만들어 "가지고 있던 반주 파일"처럼 올린다
  const wavB64 = await host.evaluate(() => {
    const { renderDemoBeat, encodeWav } = window.__ttbTest.lib;
    const { left, right } = renderDemoBeat(44100);
    const bytes = encodeWav([left, right], 44100);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const [chooser] = await Promise.all([host.waitForEvent('filechooser'), host.getByRole('button', { name: 'MR 파일 고르기' }).click()]);
  await chooser.setFiles({ name: MR_NAME, mimeType: 'audio/wav', buffer: Buffer.from(wavB64, 'base64') });
  await host.locator('#pick-mr .pick-row').waitFor({ timeout: 20000 });
  assert.match(await host.locator('#pick-mr').innerText(), /\(Inst\.\)\.wav[\s\S]*0:24/);
  // 곡을 찾아 둔 상태라 방 이름과 가사는 그대로다
  await host.getByText('가사를 찾았어요. 줄마다 타이밍도 들어 있어요 (8줄).').waitFor();
  await host.getByText('원곡 영상 없이 MR만으로도 만들 수 있어요').waitFor();

  await host.locator('#yt-url').fill(`https://www.youtube.com/watch?v=${MV}`);
  await host.getByRole('button', { name: '확인' }).click();
  await host.locator('.fake-yt').waitFor({ timeout: 10000 });
  await host.getByText('녹음할 때 이 영상을 보고 들으면서 가수를 따라 불러요').waitFor();
  await shot(host, '82-source-both');
  console.log('  ✓ 곡을 찾은 뒤 MR 파일과 원곡 영상(가이드)을 함께 골랐다');

  // ───────── 2. 가사 줄로 구간을 고르고(뮤직비디오라 가사를 5초 민다), 원곡과 MR을 맞춘다 ─────────
  await host.getByRole('button', { name: '다음: 부를 구간 고르기' }).click();
  await host.getByRole('heading', { name: '어디를 부를까요?' }).waitFor({ timeout: 10000 });
  await host.getByText('이 영상은 음원과 길이가 달라요').waitFor();
  for (let i = 0; i < INTRO; i++) await host.getByRole('button', { name: '가사 1초 늦추기' }).click();
  assert.equal(await host.locator('#lyric-shift').innerText(), '5.0초 늦춤');
  await host.getByRole('button', { name: '처음부터 끝까지' }).click();
  assert.equal(await host.locator('.range-row.is-in').count(), 8);
  await host.getByRole('button', { name: '이 구간으로 할게요' }).click();

  await host.getByRole('heading', { name: '원곡과 MR을 맞춰요' }).waitFor();
  // MR은 음원과 같은 시간표라고 보고, 가사를 민 만큼(5초) 영상이 뒤에 있다고 어림해 둔다
  assert.equal(await host.locator('#mr-shift').innerText(), '그대로');
  await shot(host, '83-align');
  await host.evaluate(() => (window.__ttbTest.voices = []));
  await host.getByRole('button', { name: '같이 들어 보기' }).click();
  await host.waitForFunction(() => window.__ttbTest.voices.length > 0, null, { timeout: 15000 });
  await host.waitForTimeout(800);
  // 영상의 구간 시작(첫 줄 1초 앞)에서 MR은 (첫 줄 − 1)초를 내야 한다: MR을 구간 0초보다 그만큼 앞에서 시작시킨다
  const segStartVideo = LRC_STARTS[0] + INTRO - 1;
  const heard = await host.evaluate(() => window.__ttbTest.voices.at(-1));
  assert.equal(heard.starts.length, 1);
  assert.ok(Math.abs(heard.starts[0] - (INTRO - segStartVideo)) < 0.002, `MR 시작 위치 ${heard.starts[0]}`);
  assert.ok(Math.abs(heard.errorMs) < 12, `영상에 맞춰 MR을 깐 값이 어긋났다 (${heard.errorMs.toFixed(1)}ms)`);
  // 옮기면 바로 들리는 소리도 옮겨 간다
  await host.getByRole('button', { name: 'MR 0.05초 늦추기' }).click();
  assert.equal(await host.locator('#mr-shift').innerText(), '0.05초 늦춤');
  await host.waitForFunction((want) => Math.abs(window.__ttbTest.voices.at(-1).starts[0] - want) < 0.002, INTRO + 0.05 - segStartVideo, { timeout: 5000 });
  await shot(host, '84-align-playing');
  await host.getByRole('button', { name: 'MR 0.05초 당기기' }).click();
  assert.equal(await host.locator('#mr-shift').innerText(), '그대로');
  await host.getByRole('button', { name: '멈추기' }).click();
  assert.equal(await host.evaluate(() => window.__ttbTest.players.filter((p) => !p.dead).at(-1).state), 2);
  await host.getByRole('button', { name: '잘 맞아요, 다음으로' }).click();

  await host.getByRole('heading', { name: '파트를 나눠요' }).waitFor({ timeout: 20000 });
  assert.equal(await host.locator('#room-title').inputValue(), '연습용 노래');
  assert.equal(await host.locator('.fake-yt').count(), 0);
  for (let i = 4; i > 2; i--) await host.getByRole('button', { name: '줄이기' }).click();
  await host.getByLabel('내 이름').fill('가이드방장');
  const open = host.getByRole('button', { name: '방 열고 번호 받기' });
  await open.waitFor({ timeout: 30000 });
  await shot(host, '85-parts');
  await open.click();
  await host.locator('.code-show').waitFor({ timeout: 15000 });
  const code = (await host.locator('.code-show').innerText()).replace(/\D/g, '');
  const room = await readRoom(host, code);
  assert.ok(room.song.blob, 'MR이 올라가 있어야 한다');
  assert.equal(room.song.yt, undefined);
  assert.equal(room.song.name, '연습용 노래');
  assert.equal(room.song.artist, '떼창방 밴드');
  assert.deepEqual({ ...room.song.guide, start: 0 }, { id: MV, start: 0, len: 29, title: '떼창방 밴드 - 연습용 노래 M/V', author: '떼창방 밴드' });
  // MR 구간은 첫 줄 1초 앞에서 시작하고, 그 순간이 영상에서는 도입부 5초만큼 뒤다
  assert.ok(Math.abs(room.song.guide.start - segStartVideo) < 0.01, `가이드 시작 ${room.song.guide.start}`);
  assert.equal(room.lines.length, 8);
  room.lines.forEach((l, i) => assert.ok(Math.abs(l.t0 - (LRC_STARTS[i] - (LRC_STARTS[0] - 1))) < 0.01, `줄 ${i} 시각 ${l.t0}`));
  // 연습용 비트는 24.07초다. 구간은 MR의 끝에서 잘린다.
  assert.ok(room.song.dur > 21 && room.song.dur <= 24.07 - (LRC_STARTS[0] - 1) + 0.02, `구간 길이 ${room.song.dur}`);
  console.log(`  ✓ 가사 줄로 구간을 고르고 원곡과 MR을 맞춰 방을 열었다: ${code} (MR 구간 ${room.song.dur.toFixed(1)}초, 영상에서는 ${room.song.guide.start.toFixed(2)}초부터)`);

  // ───────── 3. 방장: 원곡 영상을 따라 부르며 녹음한다 ─────────
  await host.getByRole('button', { name: '방으로 들어가기' }).click();
  await host.getByRole('heading', { name: '어느 파트를 부를래요?' }).waitFor();
  await host.getByRole('button', { name: /빨강 파트/ }).click();
  // 방 화면은 MR로 돈다 (영상은 없다)
  assert.equal(await host.locator('.player-card .fake-yt').count(), 0);
  // 원곡 영상은 펼쳐서 볼 수 있다 (펼쳤을 때만 불러온다)
  assert.equal(await host.locator('.fake-yt').count(), 0);
  await host.getByText('원곡 영상 보기 (가이드)').click();
  await host.locator('.guide-view .fake-yt').waitFor({ timeout: 10000 });
  await shot(host, '85-room-guide-open');
  await host.getByText('원곡 영상 보기 (가이드)').click();
  await host.waitForFunction(() => !document.querySelector('.fake-yt'), null, { timeout: 5000 });
  await host.getByRole('button', { name: '내 파트 녹음하기' }).click();
  await host.getByRole('heading', { name: '녹음 준비' }).waitFor();
  await host.locator('.fake-yt').waitFor({ timeout: 10000 });
  await host.getByText('영상 속 가수를 따라 부르면 되고').waitFor();
  await shot(host, '86-rec-prep');
  await host.getByRole('button', { name: '마이크 켜기' }).click();
  await host.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  assert.equal(await host.getByRole('button', { name: '원곡 따라 부르기' }).getAttribute('aria-pressed'), 'true');
  await calibrate(host);
  // 부르기 전에 내 파트를 원곡으로 들어 본다
  await host.getByRole('button', { name: '원곡으로 내 파트 미리 듣기' }).click();
  await host.waitForFunction(() => window.__ttbTest.players.at(-1).state === 1, null, { timeout: 10000 });
  await host.waitForTimeout(700);
  const preview = await host.evaluate(() => window.__ttbTest.players.at(-1).media());
  assert.ok(preview > segStartVideo - 1.5 && preview < segStartVideo + 6, `미리 듣기 위치 ${preview}`);
  await shot(host, '87-rec-ready');
  await host.getByRole('button', { name: '멈추기' }).click();
  assert.equal(await host.evaluate(() => window.__ttbTest.players.at(-1).state), 2);

  await teachSinger(host, room);
  const notes = [];
  await host.evaluate(() => (window.__ttbTest.plays = []));
  let staged = false;
  const hostDone = recordAll(host, async (round) => {
    notes.push(await host.locator('.lead').first().innerText());
    if (round === 0) {
      // 들어보기는 MR로 한다: 영상은 멈춘 채 치워져 있고, 반주 재생기가 돈다
      const st = await host.evaluate(() => ({ video: window.__ttbTest.players.at(-1).state, away: !!document.querySelector('.yt-frame.is-away'), plays: window.__ttbTest.plays.length }));
      assert.deepEqual({ video: st.video, away: st.away }, { video: 2, away: true });
      assert.ok(st.plays >= 1, 'MR로 들어보기가 시작되지 않았다');
      await shot(host, '89-review');
    }
  });
  // 녹음 무대: 영상이 보이고, 영상 속 줄에 맞춰 가사가 넘어간다
  await host.locator('.stage.has-video').waitFor({ timeout: 10000 });
  await host.locator('.stage.is-singing').waitFor({ timeout: 20000 });
  staged = true;
  await shot(host, '88-stage-guide');
  await hostDone;
  assert.ok(staged);
  assert.match(notes[0], /원곡을 따라 부른 목소리를 MR 위에 얹었어요/);
  const hostSync = await measureClicks(host, code);
  assert.ok(hostSync.length >= 3, `방장: 잰 지점이 너무 적다 (${hostSync.length})`);
  const hostJudge = judgeSync(hostSync.map((r) => r.errorMs));
  if (process.env.DEBUG_SYNC) console.log('     방장 오차들:', hostSync.map((r) => `${r.line.toFixed(1)}s:${r.errorMs.toFixed(1)}`).join(', '));
  console.log(`  ✓ 방장(원곡 영상을 따라 부름): 넣은 마이크 지연 137ms → 잰 값 ${hostSync[0].latencyMs}ms, MR 기준 남은 오차 ${hostJudge.typical.toFixed(1)}ms (${hostSync.length}곳, 가장 튄 곳 ${hostJudge.worst.toFixed(1)}ms)`);
  assert.ok(hostJudge.typical < 12, `방장: 싱크 오차가 크다 (${hostJudge.typical.toFixed(1)}ms)`);

  // ───────── 4. 친구: MR만 듣고 녹음한다 ─────────
  const guest = await newUser({ latency: 0.211 });
  await guest.goto(`${BASE}/r/${code}`);
  await guest.getByText('가이드방장 님이 만든 방이에요').waitFor();
  await guest.getByLabel('내 이름').fill('도윤');
  await guest.getByRole('button', { name: '들어가기' }).click();
  await guest.getByRole('button', { name: /파랑 파트/ }).click();
  await guest.getByRole('button', { name: '내 파트 녹음하기' }).click();
  await guest.getByRole('button', { name: '마이크 켜기' }).click();
  await guest.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  await guest.getByRole('button', { name: 'MR만 듣고 부르기' }).click();
  assert.equal(await guest.getByRole('button', { name: 'MR만 듣고 부르기' }).getAttribute('aria-pressed'), 'true');
  await guest.getByText('반주만 들으면서 불러요').waitFor();
  await calibrate(guest);
  await teachSinger(guest, room, true);
  let mrStage = null;
  const guestDone = recordAll(guest);
  await guest.locator('.stage').waitFor({ timeout: 10000 });
  mrStage = await guest.evaluate(() => ({ video: document.querySelector('.stage')?.classList.contains('has-video'), away: !!document.querySelector('.yt-frame.is-away'), state: window.__ttbTest.players.at(-1)?.state }));
  await guestDone;
  // MR로 부르는 동안에는 영상을 틀지 않는다
  assert.equal(mrStage.video, false);
  assert.equal(mrStage.away, true);
  assert.notEqual(mrStage.state, 1);
  const guestSync = await measureClicks(guest, code);
  assert.ok(guestSync.length >= 3, `친구: 잰 지점이 너무 적다 (${guestSync.length})`);
  const guestJudge = judgeSync(guestSync.map((r) => r.errorMs));
  console.log(`  ✓ 친구(MR만 듣고 부름): 넣은 지연 211ms → 잰 값 ${guestSync[0].latencyMs}ms, 남은 오차 ${guestJudge.typical.toFixed(1)}ms (${guestSync.length}곳)`);
  assert.ok(guestJudge.typical < 12, `친구: 싱크 오차가 크다 (${guestJudge.typical.toFixed(1)}ms)`);

  // ───────── 5. 함께 듣기와 완성본: 반주(MR)가 들어간 파일 ─────────
  await host.getByRole('button', { name: '방으로 돌아가기' }).click();
  await host.getByRole('button', { name: '완성본 듣기' }).waitFor({ timeout: 15000 });
  await host.evaluate(() => (window.__ttbTest.plays = []));
  await host.getByRole('button', { name: '재생' }).click();
  await host.getByRole('button', { name: '멈추기' }).waitFor({ timeout: 20000 });
  await host.waitForTimeout(1500);
  assert.ok((await host.evaluate(() => window.__ttbTest.plays.length)) >= 1);
  assert.notEqual((await host.locator('.player-text strong').innerText()).split('/')[0].trim(), '0:00');
  await shot(host, '90-room');
  await host.getByRole('button', { name: '멈추기' }).click();
  await host.getByRole('button', { name: '완성본 듣기' }).click();
  await host.getByRole('heading', { name: '오늘의 시상식' }).waitFor({ timeout: 15000 });
  assert.equal(await host.locator('.fake-yt').count(), 0);
  assert.equal(await host.getByRole('heading', { name: '목소리 전체 타이밍' }).count(), 0); // 영상 반주 방에만 있는 조절
  await host.getByRole('button', { name: '완성본 파일 만들기' }).click();
  const link = host.getByRole('link', { name: 'MP3 내려받기' });
  await link.waitFor({ timeout: 60000 });
  const fileName = await link.getAttribute('download');
  assert.equal(fileName, '연습용 노래 - 떼창방.mp3');
  const dl = host.waitForEvent('download');
  await link.click();
  const size = fs.statSync(await (await dl).path()).size;
  assert.ok(size > 250_000, `완성본 파일이 너무 작다 (${size})`);
  console.log(`  ✓ 방과 완성본은 MR 반주로 돌고, 반주가 들어간 MP3 가 만들어졌다: ${fileName} (${Math.round(size / 1024)}KB)`);

  // ───────── 6. 원곡 영상이 열리지 않는 기기: MR만으로 녹음할 수 있다 ─────────
  const guestKey = await guest.evaluate((c) => localStorage.getItem(`ttb.id.${c}`), code);
  const other = await newUser({ identity: [`ttb.id.${code}`, guestKey], videos: { ...VIDEOS, [MV]: { ...VIDEOS[MV], blocked: true } } });
  await other.goto(`${BASE}/r/${code}/rec`);
  await other.getByRole('heading', { name: '녹음 준비' }).waitFor({ timeout: 15000 });
  await other.locator('.yt-cover-error').waitFor({ timeout: 10000 });
  await other.getByRole('button', { name: '마이크 켜기' }).click();
  await other.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  await other.getByText('원곡 영상을 열 수 없어서 MR만 들으며 녹음해요').waitFor();
  assert.equal(await other.getByRole('button', { name: '원곡 따라 부르기' }).count(), 0);
  assert.equal(await other.getByRole('button', { name: /다시 녹음하기/ }).isDisabled(), false);
  await shot(other, '91-video-blocked');
  console.log('  ✓ 원곡 영상이 열리지 않는 기기에서는 MR만으로 녹음하도록 넘어간다');

  // ───────── 7. 영상과 MR이 딱 맞지 않을 때: 영상은 미리 듣기로만 쓴다 (시간표 없는 가사, 시간으로 구간 고르기) ─────────
  const host2 = await newUser({});
  await host2.goto(BASE + '/new');
  await host2.locator('#song-q').fill('Untimed Song');
  await host2.getByRole('button', { name: '찾기' }).click();
  await host2.locator('.song-row').first().waitFor({ timeout: 15000 });
  await host2.locator('.song-row').first().click();
  await host2.getByText('가사를 찾았어요. 타이밍은 다음 단계에서 맞춰요.').waitFor({ timeout: 15000 });
  const [chooser2] = await Promise.all([host2.waitForEvent('filechooser'), host2.getByRole('button', { name: 'MR 파일 고르기' }).click()]);
  await chooser2.setFiles({ name: 'karaoke-version.wav', mimeType: 'audio/wav', buffer: Buffer.from(wavB64, 'base64') });
  await host2.locator('#pick-mr .pick-row').waitFor({ timeout: 20000 });
  await host2.locator('#yt-url').fill(`https://youtu.be/${DEMO}`);
  await host2.getByRole('button', { name: '확인' }).click();
  await host2.locator('.fake-yt').waitFor({ timeout: 10000 });
  await host2.getByRole('button', { name: '다음: 부를 구간 고르기' }).click();
  // 시간표가 없으니 영상에서 시간으로 구간을 고른다
  await host2.getByText('영상을 틀어 보다가').waitFor({ timeout: 10000 });
  await host2.getByRole('button', { name: '전체' }).click();
  await host2.getByRole('button', { name: '이 구간으로 할게요' }).click();
  await host2.getByRole('heading', { name: '원곡과 MR을 맞춰요' }).waitFor();
  await host2.getByText('아무리 옮겨도 안 맞아요').click();
  await host2.getByText('영상은 미리 듣기로만 쓰기').click();
  await shot(host2, '92-align-loose');
  await host2.getByRole('button', { name: '미리 듣기로만 쓸게요' }).click();
  await host2.getByRole('heading', { name: '가사를 넣어 주세요' }).waitFor({ timeout: 20000 });
  assert.equal((await host2.locator('#lyrics').inputValue()).split('\n').length, 8);
  // 영상과 맞지 않는 방에서는 가사 타이밍을 영상이 아니라 MR로 확인한다 (영상은 내려가 있다)
  assert.equal(await host2.locator('.fake-yt').count(), 0);
  await host2.getByRole('button', { name: '다음: 타이밍 맞추기' }).click();
  await host2.getByRole('button', { name: /고르게 나누기/ }).click();
  await host2.getByRole('button', { name: '다음: 파트 나누기' }).click();
  await host2.getByRole('heading', { name: '파트를 나눠요' }).waitFor();
  for (let i = 4; i > 2; i--) await host2.getByRole('button', { name: '줄이기' }).click();
  await host2.getByLabel('내 이름').fill('느슨방장');
  const open2 = host2.getByRole('button', { name: '방 열고 번호 받기' });
  await open2.waitFor({ timeout: 30000 });
  await open2.click();
  await host2.locator('.code-show').waitFor({ timeout: 15000 });
  const code2 = (await host2.locator('.code-show').innerText()).replace(/\D/g, '');
  const room2 = await readRoom(host2, code2);
  assert.deepEqual(room2.song.guide, { id: DEMO, start: 0, len: 24, title: '떼창방 밴드 - 연습용 노래 (Official Audio)', author: '떼창방 밴드 - Topic', loose: true });
  assert.ok(Math.abs(room2.song.dur - 24.07) < 0.05, `구간 길이 ${room2.song.dur}`);
  await host2.getByRole('button', { name: '방으로 들어가기' }).click();
  await host2.getByRole('button', { name: /빨강 파트/ }).click();
  await host2.getByRole('button', { name: '내 파트 녹음하기' }).click();
  await host2.getByRole('button', { name: '마이크 켜기' }).click();
  await host2.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  await host2.getByText('미리 듣기로만 써요').waitFor();
  assert.equal(await host2.getByRole('button', { name: '원곡 따라 부르기' }).count(), 0);
  // 미리 듣기는 된다
  await host2.getByRole('button', { name: '원곡으로 내 파트 미리 듣기' }).click();
  await host2.waitForFunction(() => window.__ttbTest.players.at(-1).state === 1, null, { timeout: 10000 });
  await host2.getByRole('button', { name: '멈추기' }).click();
  // 녹음은 MR로 한다 (영상을 틀지 않는다)
  await host2.getByRole('button', { name: /녹음 시작/ }).click();
  await host2.locator('.stage').waitFor({ timeout: 10000 });
  assert.equal(await host2.evaluate(() => document.querySelector('.stage').classList.contains('has-video')), false);
  assert.notEqual(await host2.evaluate(() => window.__ttbTest.players.at(-1).state), 1);
  await host2.getByRole('button', { name: '녹음 그만하기' }).click();
  await host2.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 10000 });
  console.log(`  ✓ 영상과 MR이 맞지 않는 방(${code2}): 영상은 미리 듣기로만 쓰고 녹음은 MR로 한다`);

  assert.deepEqual(overflows, [], `가로로 넘치는 화면이 있다 (${VW}px)`);
  console.log(`  ✓ ${VW}px 너비에서 가로로 넘치는 화면이 없다`);
  console.log('\nMR + 가이드 영상 흐름 통과 (가짜 플레이어 기준)');
} catch (e) {
  for (const [i, p] of pages.entries()) {
    const toast = await p.locator('.toast').allInnerTexts().catch(() => []);
    const h1 = await p.locator('h1').allInnerTexts().catch(() => []);
    console.log(`   [실패 시 화면 ${i}] 제목: ${h1.join(' | ')} / 알림: ${toast.join(' | ')}`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/fail-guide-${i}.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
