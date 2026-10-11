// 실제 브라우저 테스트 3: AI 화면 흐름 (가짜 AI 서버로). 가사 자동 싱크, 가사 받아쓰기, 파트 추천.
//   node tests/e2e-ai.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttb-ai-'));
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOT_DIR || '';
const BAR = (4 * 60) / 92;
const LINE_STARTS = Array.from({ length: 8 }, (_, i) => (1 + i) * BAR);
const LYRICS = ['하나 둘 셋 시작해', '목소리를 겹쳐 봐', '틀려도 그냥 웃어', '박자는 대충 가도', '여기는 내가 할게', '다음은 네가 받아', '다 같이 크게 질러 봐', '떼창방에서 만나'];

const server = spawn(process.execPath, [path.join(root, 'server/node-server.mjs')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, MOCK_AI: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => String(d).includes('http://') && resolve());
  setTimeout(() => reject(new Error('server start timeout')), 8000);
});

const shot = async (page, name) => SHOTS && (await page.waitForTimeout(250), await page.screenshot({ path: `${SHOTS}/${name}.png` }));
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'ko-KR' });
  await context.addInitScript(() => (window.__ttbTest = {}));
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('   [page error]', e.message));

  const upload = async () => {
    await page.goto(BASE + '/new');
    const wavB64 = await page.evaluate(() => {
      const { renderDemoBeat, encodeWav } = window.__ttbTest.lib;
      const { left, right } = renderDemoBeat(44100);
      const bytes = encodeWav([left, right], 44100);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    await page.locator('#song-file').setInputFiles({ name: 'ai-test.wav', mimeType: 'audio/wav', buffer: Buffer.from(wavB64, 'base64') });
    // 파일만 고르고(원곡 영상 없이) 넘어간다
    await page.getByRole('heading', { name: '반주와 원곡 영상을 골라요' }).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: '다음: 부를 구간 고르기' }).click();
    await page.getByRole('button', { name: '전체' }).click();
    await page.getByRole('button', { name: '이 구간으로 할게요' }).click();
    await page.getByRole('heading', { name: '가사를 넣어 주세요' }).waitFor();
    await page.getByText('반주가 방에 올라갔어요').waitFor({ timeout: 30000 });
  };
  const readStarts = async () =>
    (await page.locator('.timing-list li .timing-text small').allInnerTexts()).map((t) => {
      const [m, s] = t.split(':').map(Number);
      return m * 60 + s;
    });

  // ───────── 가사를 넣고 AI 로 타이밍 맞추기 ─────────
  await upload();
  await page.locator('#lyrics').fill(LYRICS.join('\n'));
  await page.getByRole('button', { name: '다음: 타이밍 맞추기' }).click();
  await shot(page, '40-ai-choice');
  await page.getByRole('button', { name: /AI로 자동 맞추기/ }).click();
  await page.getByText('AI가 노래를 듣고 타이밍을 맞췄어요').waitFor({ timeout: 20000 });
  const texts = await page.locator('.timing-list li .timing-text').allInnerTexts();
  assert.equal(texts.length, 8);
  // 받아쓰기가 "우서", "할께"처럼 틀려도 원래 가사 글자는 그대로 써야 한다
  assert.match(texts[2], /틀려도 그냥 웃어/);
  assert.match(texts[4], /여기는 내가 할게/);
  const starts = await readStarts();
  starts.forEach((s, i) => assert.ok(Math.abs(s - Math.floor(LINE_STARTS[i] + 0.04)) <= 1, `줄 ${i} 시작 ${s} vs ${LINE_STARTS[i]}`));
  await shot(page, '41-ai-timing');
  console.log('  ✓ AI 자동 싱크: 틀리게 받아쓴 글자가 있어도 8줄 모두 제 위치에 맞췄다');

  // 정확한 값은 방을 연 뒤 서버에 저장된 줄 시각으로 확인
  await page.getByRole('button', { name: '다음: 파트 나누기' }).click();
  await page.getByRole('heading', { name: '파트를 나눠요' }).waitFor();
  await page.getByRole('button', { name: '줄이기' }).click(); // 3명
  await page.locator('#ai-notes').fill('랩은 2번이 하고 싶대요');
  await page.getByRole('button', { name: 'AI 추천' }).click();
  await page.getByText('후렴인 마지막 줄은 다같이').waitFor({ timeout: 15000 });
  await shot(page, '42-ai-split');
  await page.getByLabel('내 이름').fill('AI방장');
  await page.getByRole('button', { name: '방 열고 번호 받기' }).click();
  await page.locator('.code-show').waitFor({ timeout: 15000 });
  const code = (await page.locator('.code-show').innerText()).replace(/\D/g, '');
  const lines = await page.evaluate(async (c) => {
    const who = JSON.parse(localStorage.getItem(`ttb.id.${c}`));
    return (await (await fetch(`/api/rooms/${c}`, { headers: { authorization: `Bearer ${who.id}.${who.key}` } })).json()).lines;
  }, code);
  const worst = Math.max(...lines.map((l, i) => Math.abs(l.t0 - (LINE_STARTS[i] + 0.04)) * 1000));
  console.log(`  ✓ AI 타이밍과 실제 줄 시작의 차이: 최대 ${worst.toFixed(0)}ms`);
  assert.ok(worst < 150);
  // AI 가 한 줄을 빼먹고 없는 번호(99)를 줬지만, 모든 줄에 사람이 있고 3명 모두 줄을 받았다
  assert.ok(lines.every((l) => l.seats.length >= 1 && l.seats.every((s) => s >= 0 && s < 3)));
  for (let s = 0; s < 3; s++) assert.ok(lines.some((l) => l.seats.includes(s)));
  assert.deepEqual(lines[7].seats, [0, 1, 2]);
  assert.deepEqual(lines[0].seats, [0]);
  console.log('  ✓ AI 파트 추천: 엉성한 답(빠진 줄·없는 번호)을 고쳐서 적용했다');

  // ───────── 가사 없이 AI 받아쓰기 ─────────
  await upload();
  await page.getByRole('button', { name: 'AI에게 가사 받아쓰기 맡기기' }).click();
  await page.getByText('AI가 받아쓴 가사예요').waitFor({ timeout: 20000 });
  const heard = await page.locator('.timing-list li .timing-text').allInnerTexts();
  assert.equal(heard.length, 8); // 간주에서 지어낸 "(음악)" 줄은 빠져야 한다
  assert.ok(heard.some((t) => /목소리를 겹쳐봐/.test(t)));
  await shot(page, '43-ai-transcribe');
  console.log('  ✓ AI 받아쓰기: 받아쓴 문장이 가사 줄로 들어왔다');

  console.log('\nAI 화면 흐름 통과 (가짜 AI 기준)');
} finally {
  await browser.close();
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
