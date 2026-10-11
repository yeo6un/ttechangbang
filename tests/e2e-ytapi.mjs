// 실제 브라우저 테스트 5: 유튜브 IFrame API 를 타는 진짜 길.
// 앱이 https://www.youtube.com/iframe_api 를 불러와 YT.Player 를 만들고, 다른 사이트(youtube.com)의 틀과 알림을 주고받는
// 부분을 확인한다. 진짜 유튜브에는 닿을 수 없어서 그 두 주소를 "흉내 플레이어"로 바꿔 끼운다 (tests/fake-yt.mjs 의 stubYouTubeApi).
//   - 알림에 "영상 위치를 잰 시각"이 들어 있는 경우 / 없는 경우(도착 시각으로 어림) 둘 다 본다
//   - 영상을 직접 눌러야 재생되는 경우(휴대폰)도 본다
//   node tests/e2e-ytapi.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fakeWorld, judgeSync, stubYouTubeApi } from './fake-yt.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.SHOT_DIR || '';
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttb-ytapi-'));
const server = spawn(process.execPath, [path.join(root, 'server/node-server.mjs')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MOCK_FIND: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('http://') && resolve());
  setTimeout(() => reject(new Error('server start timeout')), 8000);
});

const call = async (method, url, body, who) => {
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.id}.${who.key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
};

// 방은 API 로 바로 만든다: 영상 3초 지점부터 18초짜리 구간, 세 사람이 세 줄씩 번갈아
const SEG_START = 3;
const LINES = Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, t0: Math.round((1 + i * 1.9) * 10) / 10, t1: Math.round((1 + i * 1.9 + 1.6) * 10) / 10, text: `연습 줄 ${i + 1}번`, seats: [i % 3] }));
const created = await call('POST', '/api/rooms', {
  title: '흉내 플레이어 방',
  hostName: '방장',
  seatCount: 3,
  song: { dur: 18, lead: 0, peaks: '', name: '흉내 영상', bpm: 0, beat0: 0, demo: false, yt: { id: 'ttbDEMO0001', start: SEG_START, len: 24, title: '흉내 영상', author: '흉내 채널' } },
});
const code = created.code;
await call('PUT', `/api/rooms/${code}/parts`, { seatCount: 3, lines: LINES }, created.member);
await call('PUT', `/api/rooms/${code}/settings`, { draft: false }, created.member);

const pages = [];
async function newUser(browser, name, seat, yt, latency) {
  const who = seat === 0 ? created.member : (await call('POST', `/api/rooms/${code}/join`, { name })).member;
  await call('POST', `/api/rooms/${code}/me`, { name, seat }, who);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ko-KR', permissions: ['microphone'] });
  await context.addInitScript(fakeWorld, { latency, realApi: true });
  await context.addInitScript(({ code, who }) => window.top === window && localStorage.setItem(`ttb.id.${code}`, JSON.stringify(who)), { code, who });
  await stubYouTubeApi(context, yt);
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', (e) => console.log('   [page error]', e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|40[0-9]|ERR_FAILED|net::/.test(m.text()) && console.log('   [console]', m.text()));
  return page;
}

/** 저장된 내 녹음에서, 줄 시작마다 낸 소리가 몇 ms 어긋나 있는지 잰다 */
const measureSync = (page) =>
  page.evaluate(async (c) => {
    const who = JSON.parse(localStorage.getItem(`ttb.id.${c}`));
    const auth = { authorization: `Bearer ${who.id}.${who.key}` };
    const room = await (await fetch(`/api/rooms/${c}`, { headers: auth })).json();
    const { decodeWithLead, getCtx } = window.__ttbTest.lib;
    const out = [];
    for (const take of room.takes.filter((t) => t.member === who.id)) {
      const buf = await decodeWithLead(await (await fetch(`/api/rooms/${c}/blobs/${take.blob}`, { headers: auth })).arrayBuffer(), getCtx());
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
        if (onset >= 0) out.push({ errorMs: ((onset - expect) / sr) * 1000, latencyMs: take.latencyMs });
      }
    }
    return out;
  }, code);

/** 내 파트를 끝까지 녹음한다. tap: 영상을 직접 눌러 줘야 하는 브라우저인지. */
async function record(page, tap) {
  await page.goto(`${BASE}/r/${code}/rec`);
  await page.getByRole('heading', { name: '녹음 준비' }).waitFor();
  // 진짜 길: 다른 사이트(youtube.com)에서 온 틀이 화면에 붙어 있어야 한다
  await page.frameLocator('.yt-host iframe').getByText('흉내 유튜브 플레이어').waitFor({ timeout: 15000 });
  const src = await page.locator('.yt-host iframe').getAttribute('src');
  assert.match(src, /^https:\/\/www\.youtube\.com\/embed\/ttbDEMO0001\?/);
  for (const want of ['playsinline=1', 'enablejsapi=1', `origin=${encodeURIComponent(BASE)}`]) assert.ok(src.includes(want), `플레이어 주소에 ${want} 가 없다: ${src}`);
  await page.getByRole('button', { name: '마이크 켜기' }).click();
  await page.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  await page.getByText('소리 설정').click();
  await page.getByRole('button', { name: '싱크 미리 맞춰 두기' }).click();
  await page.getByRole('button', { name: '재기 시작' }).click();
  await page.getByText('녹음에 자동으로 반영할게요').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '닫기' }).click();
  await page.evaluate(
    ({ segStart, times }) => {
      const t = window.__ttbTest;
      t.segStart = segStart;
      t.clickTimes = times;
      t.singing = true;
    },
    { segStart: SEG_START, times: LINES.map((l) => l.t0) },
  );
  for (let round = 0; round < 6; round++) {
    await page.getByRole('button', { name: /녹음 시작|다시 녹음하기/ }).click();
    if (tap && round === 0) {
      await page.getByText('▶ 를 눌러 주세요').waitFor({ timeout: 10000 });
      await page.frameLocator('.yt-host iframe').locator('#b').click();
    }
    await page.getByRole('heading', { name: '들어 보세요' }).waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: '이걸로 저장' }).click();
    const done = page.getByRole('heading', { name: '다 불렀어요!' });
    const next = page.getByRole('heading', { name: '저장했어요' });
    await Promise.race([done.waitFor({ timeout: 30000 }), next.waitFor({ timeout: 30000 })]);
    if (await done.isVisible()) break;
  }
  return measureSync(page);
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  const cases = [
    { name: '방장', seat: 0, latency: 0.11, yt: { stamp: true }, label: '잰 시각이 든 알림', limit: 10 },
    { name: '지우', seat: 1, latency: 0.19, yt: { stamp: false }, label: '도착 시각으로 어림', limit: 15 },
    { name: '하람', seat: 2, latency: 0.15, yt: { stamp: true, block: true }, label: '영상을 직접 눌러 시작', limit: 10 },
  ];
  const users = [];
  for (const c of cases) {
    const page = await newUser(browser, c.name, c.seat, c.yt, c.latency);
    const sync = await record(page, !!c.yt.block);
    assert.ok(sync.length >= 3, `${c.name}: 잰 지점이 너무 적다 (${sync.length})`);
    const { typical, worst } = judgeSync(sync.map((r) => r.errorMs));
    if (process.env.DEBUG_SYNC) {
      console.log('     오차들:', sync.map((r) => r.errorMs.toFixed(1)).join(', '));
      console.log('     부르는 동안 앱이 잡은 싱크와 참값의 차이:', (await page.evaluate(() => window.__ttbTest.voices.map((v) => v.errorMs.toFixed(1)))).join(', '));
    }
    console.log(`  ✓ ${c.name} (${c.label}): 넣은 지연 ${Math.round(c.latency * 1000)}ms → 잰 값 ${sync[0].latencyMs}ms, 남은 오차 ${typical.toFixed(1)}ms (${sync.length}곳, 가장 튄 곳 ${worst.toFixed(1)}ms)`);
    assert.ok(typical < c.limit, `${c.name}: 싱크 오차가 크다 (${typical.toFixed(1)}ms)`);
    users.push(page);
  }

  // 완성본 화면에서 영상과 세 사람 목소리를 함께 듣는다
  const host = users[0];
  await host.goto(`${BASE}/r/${code}/mix`);
  await host.getByRole('heading', { name: '목소리 전체 타이밍' }).waitFor({ timeout: 15000 });
  await host.evaluate(() => (window.__ttbTest.voices = []));
  await host.getByRole('button', { name: '재생' }).click();
  await host.getByRole('button', { name: '멈추기' }).waitFor({ timeout: 20000 });
  await host.waitForFunction(() => window.__ttbTest.voices.length > 0, null, { timeout: 15000 });
  await host.waitForTimeout(3000);
  // 진단 글에 "영상 위치를 무엇으로 받는지"가 나온다
  await host.locator('.diag summary').click();
  await host.locator('.diag pre').waitFor();
  await host.waitForTimeout(1200);
  const diag = await host.locator('.diag pre').innerText();
  assert.match(diag, /영상시계 잡음\(stamp\)/, diag);
  assert.match(diag, /소리시계 잡음/, diag);
  if (SHOTS) await host.screenshot({ path: `${SHOTS}/80-ytapi-mix.png` });
  const voices = await host.evaluate(() => window.__ttbTest.voices);
  const last = Math.abs(voices[voices.length - 1].errorMs);
  await host.getByRole('button', { name: '멈추기' }).click();
  console.log(`  ✓ 완성본 화면: 영상에 맞춰 세 사람 목소리를 깔았다 (${voices.length}번 맞춤, 마지막으로 맞춘 값과 참값의 차이 ${last.toFixed(1)}ms)`);
  assert.ok(last < 12, `재생 싱크 오차가 크다 (${last.toFixed(1)}ms)`);

  // 영상을 직접 눌러 멈추면 목소리도 멈추고, 버튼이 "재생"으로 돌아온다
  await host.getByRole('button', { name: '재생' }).click();
  await host.getByRole('button', { name: '멈추기' }).waitFor({ timeout: 20000 });
  await host.waitForFunction(() => window.__ttbTest.players.at(-1).state === 1, null, { timeout: 10000 });
  await host.waitForTimeout(800);
  await host.frameLocator('.yt-host iframe').locator('#b').click();
  await host.getByRole('button', { name: '재생' }).waitFor({ timeout: 10000 });
  console.log('  ✓ 영상을 직접 눌러 멈추면 재생 버튼도 따라 바뀐다');

  console.log('\n유튜브 IFrame API 길 통과 (흉내 플레이어 기준)');
} catch (e) {
  for (const [i, p] of pages.entries()) {
    const toast = await p.locator('.toast').allInnerTexts().catch(() => []);
    const h1 = await p.locator('h1').allInnerTexts().catch(() => []);
    console.log(`   [실패 시 화면 ${i}] 제목: ${h1.join(' | ')} / 알림: ${toast.join(' | ')}`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/fail-api-${i}.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
