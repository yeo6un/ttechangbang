// 실제 브라우저 테스트 2: 파일로 방 만들기(구간 → 가사 → 탭으로 타이밍 → 파트), 블라인드 모드, 진짜 마이크 경로
//   BASE=http://127.0.0.1:8787 node tests/e2e-create.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOT_DIR || '';
const BAR = (4 * 60) / 92;
const LINE_STARTS = Array.from({ length: 8 }, (_, i) => Math.round((1 + i) * BAR * 1000) / 1000);
const LYRICS = ['[1절]', '하나 둘 셋 시작해', '목소리를 겹쳐 봐', '', '틀려도 그냥 웃어', '박자는 대충 가도', '여기는 내가 할게', '다음은 네가 받아', '다 같이 크게 질러 봐', '떼창방에서 만나'].join('\n');

const pages = [];
const VW = Number(process.env.VW || 390);
const overflows = [];
/** 화면을 남기고, 가로로 넘치는 곳이 없는지도 같이 본다 */
const shot = async (page, name) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) overflows.push(`${name}: ${over}px`);
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

async function newPage(browser, initScript) {
  const context = await browser.newContext({ viewport: { width: VW, height: VW < 360 ? 600 : 844 }, deviceScaleFactor: 2, locale: 'ko-KR', permissions: ['microphone'] });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  pages.push(page);
  page.on('pageerror', (e) => console.log('   [page error]', e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|40[34]/.test(m.text()) && console.log('   [console]', m.text()));
  return page;
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
try {
  // ───────── 1. 노래 파일로 방 만들기 ─────────
  // 테스트 훅은 재생 시작 시각만 알려 주게 한다 (탭 타이밍을 맞추려고). 마이크는 건드리지 않는다.
  const host = await newPage(browser, () => {
    window.__ttbTest = { plays: [], onPlay(info) { this.plays.push(info); }, onGraph(_m, ctx) { this.ctx = ctx; } };
  });
  await host.goto(BASE + '/new');
  // 연습용 비트를 WAV 파일로 만들어 "내 노래 파일"처럼 올린다
  const wavB64 = await host.evaluate(() => {
    const { renderDemoBeat, encodeWav } = window.__ttbTest.lib;
    const { left, right } = renderDemoBeat(44100);
    const bytes = encodeWav([left, right], 44100);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  await host.locator('#song-file').setInputFiles({ name: '우리 노래_최종.wav', mimeType: 'audio/wav', buffer: Buffer.from(wavB64, 'base64') });
  await host.getByRole('heading', { name: '부를 구간을 골라요' }).waitFor({ timeout: 20000 });
  assert.equal(await host.locator('#room-title').inputValue(), '우리 노래 최종');
  await shot(host, '20-trim');
  await host.getByRole('button', { name: '전체' }).click();
  await host.getByRole('button', { name: '구간 듣기' }).click();
  await host.getByRole('button', { name: '멈추기' }).waitFor();
  await host.waitForTimeout(600);
  await host.getByRole('button', { name: '멈추기' }).click();
  await host.getByRole('button', { name: '이 구간으로 할게요' }).click();
  console.log('  ✓ 파일을 열고 구간을 골랐다');

  await host.getByRole('heading', { name: '가사를 넣어 주세요' }).waitFor();
  await host.locator('#lyrics').fill(LYRICS);
  await shot(host, '21-lyrics');
  await host.getByRole('button', { name: '다음: 타이밍 맞추기' }).click();
  await host.getByRole('heading', { name: '가사 타이밍을 맞춰요' }).waitFor();
  await shot(host, '22-timing-choice');
  // AI 가 없는 서버에서는 AI 선택지가 보이지 않아야 한다
  assert.equal(await host.getByRole('button', { name: /AI로 자동 맞추기/ }).count(), 0);

  await host.getByRole('button', { name: /들으면서 탭하기/ }).click();
  await host.getByRole('heading', { name: '들으면서 탭하기' }).waitFor();
  await host.getByRole('button', { name: '시작하기' }).click();
  await host.locator('.tap-button').waitFor();
  // 각 줄이 시작하는 순간에 맞춰 버튼을 누른다 (앱이 손이 늦는 만큼 0.08초 당겨 주므로 그만큼 늦게 누른다)
  await host.evaluate((starts) => {
    const t = window.__ttbTest;
    const play = t.plays[t.plays.length - 1];
    const btn = document.querySelector('.tap-button');
    for (const s of starts) {
      const wait = (play.tZero + s + 0.08 - t.ctx.currentTime) * 1000 + (t.ctx.outputLatency + t.ctx.baseLatency) * 1000;
      setTimeout(() => btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })), Math.max(0, wait));
    }
  }, LINE_STARTS);
  await host.waitForTimeout(4000);
  await shot(host, '23-tap');
  await host.getByText('탭한 대로 맞췄어요').waitFor({ timeout: 40000 });
  const tapped = await host.locator('.timing-list li .timing-text').allInnerTexts();
  assert.equal(tapped.length, 8);
  assert.match(tapped[0], /0:03[\s\S]*하나 둘 셋 시작해/);
  assert.match(tapped[7], /0:21[\s\S]*떼창방에서 만나/);
  await shot(host, '24-timing-review');
  // 한 줄을 0.2초 뒤로 옮겼다가 되돌려 본다
  await host.getByRole('button', { name: '0.2초 뒤로' }).first().click();
  await host.getByRole('button', { name: '0.2초 앞으로' }).first().click();
  await host.getByRole('button', { name: '다음: 파트 나누기' }).click();
  console.log('  ✓ 가사를 붙여 넣고 탭으로 타이밍을 맞췄다 (8줄)');

  await host.getByRole('heading', { name: '파트를 나눠요' }).waitFor();
  await host.getByRole('button', { name: '줄이기' }).click(); // 4명 → 3명
  await host.getByRole('button', { name: '룰렛' }).click();
  await host.getByRole('button', { name: '자동 추천' }).click();
  // 첫 줄을 눌러 "다같이"로 바꿔 본다
  await host.locator('.line-row').first().click();
  await host.getByRole('button', { name: '다같이', exact: true }).click();
  await host.getByRole('button', { name: '이대로' }).click();
  assert.equal(await host.locator('.line-row').first().locator('.all-chip').count(), 1);
  await host.getByText('블라인드 모드').click();
  await host.getByLabel('내 이름').fill('서연');
  await shot(host, '25-parts');
  const open = host.getByRole('button', { name: '방 열고 번호 받기' });
  await open.waitFor({ timeout: 40000 });
  await open.click();
  await host.locator('.code-show').waitFor({ timeout: 15000 });
  const code = (await host.locator('.code-show').innerText()).replace(/\D/g, '');
  console.log('  ✓ 3명·블라인드 모드로 방을 열었다:', code);

  // 탭으로 맞춘 줄 시각이 실제 줄 시작과 얼마나 다른지 서버에 저장된 값으로 확인
  const lines = await host.evaluate(async (c) => {
    const who = JSON.parse(localStorage.getItem(`ttb.id.${c}`));
    const room = await (await fetch(`/api/rooms/${c}`, { headers: { authorization: `Bearer ${who.id}.${who.key}` } })).json();
    return room.lines.map((l) => ({ t0: l.t0, text: l.text, seats: l.seats }));
  }, code);
  const worstTap = Math.max(...lines.map((l, i) => Math.abs(l.t0 - LINE_STARTS[i]) * 1000));
  console.log(`  ✓ 탭 타이밍 오차 최대 ${worstTap.toFixed(0)}ms`);
  assert.ok(worstTap < 120, '탭 타이밍이 크게 어긋났다');
  assert.equal(lines[0].seats.length, 3);

  // ───────── 2. 진짜 마이크 경로(브라우저의 가짜 장치)로 녹음 ─────────
  await host.getByRole('button', { name: '방으로 들어가기' }).click();
  await host.getByRole('button', { name: /빨강 파트/ }).click();
  await host.getByRole('button', { name: '내 파트 녹음하기' }).click();
  await host.getByRole('button', { name: '마이크 켜기' }).click();
  await host.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  // 가짜 장치는 삑삑 소리를 내므로 막대가 움직여야 한다
  let moved = 0;
  for (let i = 0; i < 25 && moved < 0.05; i++) {
    await host.waitForTimeout(120);
    moved = await host.locator('.meter div').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  }
  assert.ok(moved > 0.05, `마이크 막대가 움직이지 않는다 (${moved})`);
  await host.getByText('소리 설정').click();
  await shot(host, '26-rec-options');
  let rounds = 0;
  for (; rounds < 6; rounds++) {
    await host.getByRole('button', { name: /녹음 시작|다시 녹음하기/ }).click();
    await host.getByRole('heading', { name: '들어 보세요' }).waitFor({ timeout: 90000 });
    if (rounds === 0) {
      // 싱크 막대를 움직여 저장해 본다 (다시 잘라서 올리는 경로)
      await host.getByRole('button', { name: '10ms 늦게' }).click();
      await host.getByRole('button', { name: '10ms 늦게' }).click();
      assert.equal(await host.locator('.sync-head output').innerText(), '20ms 늦게');
    }
    await host.getByRole('button', { name: '이걸로 저장' }).click();
    const done = host.getByRole('heading', { name: '다 불렀어요!' });
    const next = host.getByRole('heading', { name: '저장했어요' });
    await Promise.race([done.waitFor({ timeout: 30000 }), next.waitFor({ timeout: 30000 })]);
    if (await done.isVisible()) break;
  }
  console.log(`  ✓ 브라우저 마이크 경로로 녹음·저장했다 (${rounds + 1}번에 나눠서)`);
  await shot(host, '27-rec-done-blind');
  await host.getByRole('button', { name: '방으로 돌아가기' }).click();

  // ───────── 3. 블라인드: 친구는 방장의 녹음을 듣지 못한다 ─────────
  const guest = await newPage(browser);
  await guest.goto(`${BASE}/r/${code}`);
  await guest.getByLabel('내 이름').fill('하준');
  await guest.getByRole('button', { name: '들어가기' }).click();
  await guest.getByText('블라인드 모드').first().waitFor();
  await shot(guest, '28-guest-blind');
  const blocked = await guest.evaluate(async (c) => {
    const who = JSON.parse(localStorage.getItem(`ttb.id.${c}`));
    const h = { authorization: `Bearer ${who.id}.${who.key}` };
    const room = await (await fetch(`/api/rooms/${c}`, { headers: h })).json();
    const codes = [];
    for (const t of room.takes) codes.push((await fetch(`/api/rooms/${c}/blobs/${t.blob}`, { headers: h })).status);
    return codes;
  }, code);
  assert.ok(blocked.length > 0 && blocked.every((s) => s === 403), `블라인드인데 들린다: ${blocked}`);
  // 반주는 들을 수 있다
  await guest.getByRole('button', { name: '재생' }).click();
  await guest.getByRole('button', { name: '멈추기' }).waitFor({ timeout: 20000 });
  await guest.getByRole('button', { name: '멈추기' }).click();
  console.log('  ✓ 블라인드 모드: 친구는 반주만 들리고 방장의 녹음은 막혀 있다');

  // 방장이 기다리지 않고 공개 → 친구 화면에 반영
  await host.getByRole('button', { name: '기다리지 않고 공개하기' }).click();
  await host.getByText('모두의 녹음이 공개됐어요').waitFor({ timeout: 10000 });
  await guest.getByText('모두의 녹음이 공개됐어요').waitFor({ timeout: 15000 });
  await shot(guest, '29-guest-revealed');
  const opened = await guest.evaluate(async (c) => {
    const who = JSON.parse(localStorage.getItem(`ttb.id.${c}`));
    const h = { authorization: `Bearer ${who.id}.${who.key}` };
    const room = await (await fetch(`/api/rooms/${c}`, { headers: h })).json();
    return (await fetch(`/api/rooms/${c}/blobs/${room.takes[0].blob}`, { headers: h })).status;
  }, code);
  assert.equal(opened, 200);
  console.log('  ✓ 공개하면 몇 초 안에 친구 화면에도 반영되고 녹음이 들린다');

  // ───────── 4. 방장 메뉴: 파트 다시 나누기, 방 닫기 ─────────
  await host.getByRole('button', { name: '더보기' }).click();
  await shot(host, '30-host-menu');
  await host.getByRole('button', { name: /파트 다시 나누기/ }).click();
  await host.getByRole('heading', { name: '몇 명이 부르나요?' }).waitFor();
  await host.getByText('이미 녹음한 사람의 줄을 바꾸면').waitFor();
  await host.getByRole('button', { name: '이대로 저장' }).click();
  await host.getByRole('button', { name: '더보기' }).waitFor();
  await host.getByRole('button', { name: '더보기' }).click();
  await host.getByRole('button', { name: /방 닫기/ }).click();
  await host.getByRole('button', { name: '방 닫고 모두 지우기' }).click();
  await host.getByRole('heading', { name: '떼창방' }).waitFor({ timeout: 10000 });
  await guest.getByRole('heading', { name: '방을 찾지 못했어요' }).waitFor({ timeout: 15000 });
  await shot(guest, '31-guest-closed');
  console.log('  ✓ 방을 닫으면 친구 화면에도 방이 사라졌다고 나온다');

  assert.deepEqual(overflows, [], `가로로 넘치는 화면이 있다 (${VW}px)`);
  console.log(`  ✓ ${VW}px 너비에서 가로로 넘치는 화면이 없다`);

  console.log('\n방 만들기·블라인드·마이크 경로 통과');
} catch (e) {
  // 실패한 순간의 화면과 알림 문구를 남긴다
  for (const [i, p] of pages.entries()) {
    const toast = await p.locator('.toast').allInnerTexts().catch(() => []);
    const h1 = await p.locator('h1').allInnerTexts().catch(() => []);
    console.log(`   [실패 시 화면 ${i}] 제목: ${h1.join(' | ')} / 알림: ${toast.join(' | ')}`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/fail-${i}.png` }).catch(() => {});
  }
  throw e;
} finally {
  await browser.close();
}
