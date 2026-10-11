// 실제 브라우저(크로미움)로 전체 흐름을 돌려 본다:
//   방 만들기 → 번호 발급 → 두 사람이 각자 들어와 파트 고르기 → 녹음 → 합쳐 듣기 → 파일 만들기
// 마이크는 "지연이 있는 가짜 마이크"로 바꿔 끼운다. 반주가 조금 새어 들어가고, 가사 줄이 시작하는 순간마다
// 짧은 소리를 내는 가수 역할이다. 저장된 녹음에서 그 소리가 제자리에 있는지 재서 싱크 정확도를 확인한다.
//
//   BASE=http://127.0.0.1:8787 SIM_LATENCY=0.137 node tests/e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const SHOTS = process.env.SHOT_DIR || '';
const BAR = (4 * 60) / 92;
const LINE_STARTS = Array.from({ length: 8 }, (_, i) => Math.round((1 + i) * BAR * 1000) / 1000);

function simMic({ latency, leak, clickTimes }) {
  window.__ttbTest = {
    latency,
    leak,
    clickTimes,
    plays: [],
    onGraph(master, ctx) {
      this.master = master;
      this.graphCtx = ctx;
      this.wire?.();
    },
    micFactory(ctx) {
      const dest = ctx.createMediaStreamDestination();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = this.latency;
      const leakGain = ctx.createGain();
      leakGain.gain.value = this.leak;
      const voice = ctx.createGain();
      voice.connect(delay);
      leakGain.connect(delay);
      delay.connect(dest);
      // 방 잡음
      const noise = ctx.createBufferSource();
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.001;
      noise.buffer = nb;
      noise.loop = true;
      noise.connect(dest);
      noise.start();
      const calibGain = ctx.createGain();
      calibGain.gain.value = 0.3;
      calibGain.connect(delay);
      this.calibGain = calibGain;
      this.voice = voice;
      this.micCtx = ctx;
      this.wire = () => {
        if (this.master && this.graphCtx === ctx) {
          try {
            this.master.connect(leakGain);
          } catch {}
        }
      };
      this.wire();
      return dest.stream;
    },
    // 싱크 재기용 시험 소리: 이어폰을 마이크에 댄 것처럼 크게 들어온다
    onCalibrate(node) {
      if (this.calibGain) node.connect(this.calibGain);
    },
    onPlay({ tZero, from, until }) {
      this.plays.push({ tZero, from, until });
      const ctx = this.micCtx;
      if (!ctx || !this.voice || !this.singing) return;
      for (const t of this.clickTimes) {
        if (t < from || t > until) continue;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = 880;
        g.gain.setValueAtTime(0, 0);
        g.gain.setValueAtTime(0.5, tZero + t);
        g.gain.exponentialRampToValueAtTime(0.001, tZero + t + 0.3);
        osc.connect(g).connect(this.voice);
        osc.start(tZero + t);
        osc.stop(tZero + t + 0.35);
      }
    },
  };
}

const VW = Number(process.env.VW || 390);
const overflows = [];
/** 화면을 남기고, 가로로 넘치는 곳이 없는지도 같이 본다 */
const shot = async (page, name) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (over > 0) overflows.push(`${name}: ${over}px`);
  if (!SHOTS) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
};

async function newUser(browser, latency, leak) {
  const context = await browser.newContext({ viewport: { width: VW, height: VW < 360 ? 600 : 844 }, deviceScaleFactor: 2, locale: 'ko-KR', permissions: ['microphone'] });
  await context.addInitScript(simMic, { latency, leak, clickTimes: LINE_STARTS });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('   [page error]', e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|404/.test(m.text()) && console.log('   [console]', m.text()));
  return page;
}

/** 내 파트를 끝까지 녹음하고 저장한다. 저장 직전 화면 상태를 돌려준다. */
async function recordAll(page, label, shots = false) {
  await page.getByRole('button', { name: '마이크 켜기' }).click();
  await page.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  if (shots) await shot(page, `${label}-ready`);
  const notes = [];
  for (let round = 0; round < 6; round++) {
    await page.evaluate(() => (window.__ttbTest.singing = true));
    await page.getByRole('button', { name: /녹음 시작|다시 녹음하기/ }).click();
    if (shots && round === 0) {
      await page.locator('.stage').waitFor();
      await page.waitForTimeout(1500);
      await shot(page, `${label}-stage-wait`);
      await page.locator('.stage.is-singing').waitFor({ timeout: 15000 });
      await page.waitForTimeout(700);
      await shot(page, `${label}-stage-sing`);
    }
    await page.getByRole('heading', { name: '들어 보세요' }).waitFor({ timeout: 90000 });
    notes.push(await page.locator('.lead').first().innerText());
    if (shots && round === 0) await shot(page, `${label}-review`);
    await page.getByRole('button', { name: '이걸로 저장' }).click();
    const done = page.getByRole('heading', { name: '다 불렀어요!' });
    const next = page.getByRole('heading', { name: '저장했어요' });
    await Promise.race([done.waitFor({ timeout: 30000 }), next.waitFor({ timeout: 30000 })]);
    if (await done.isVisible()) break;
  }
  if (shots) await shot(page, `${label}-done`);
  return notes;
}

/** 저장된 녹음을 받아 풀고, 가사 줄 시작마다 낸 소리가 실제로 몇 ms 어긋나 있는지 잰다 */
async function measureSync(page, code) {
  return page.evaluate(
    async ({ code, starts }) => {
      const who = JSON.parse(localStorage.getItem(`ttb.id.${code}`));
      const auth = { authorization: `Bearer ${who.id}.${who.key}` };
      const room = await (await fetch(`/api/rooms/${code}`, { headers: auth })).json();
      const { decodeWithLead, getCtx } = window.__ttbTest.lib;
      const out = [];
      for (const take of room.takes.filter((t) => t.member === who.id)) {
        const bytes = await (await fetch(`/api/rooms/${code}/blobs/${take.blob}`, { headers: auth })).arrayBuffer();
        const buf = await decodeWithLead(bytes, getCtx());
        const x = buf.getChannelData(0);
        const sr = buf.sampleRate;
        let peak = 0;
        for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
        for (const t of starts) {
          const expect = Math.round((t - take.start) * sr);
          if (expect < sr * 0.05 || expect > x.length - sr * 0.3) continue;
          // 예상 위치 앞뒤 150ms 안에서 소리가 처음 커지는 지점
          let onset = -1;
          for (let i = expect - Math.round(sr * 0.15); i < expect + Math.round(sr * 0.15); i++) {
            if (Math.abs(x[i]) > peak * 0.25) {
              onset = i;
              break;
            }
          }
          if (onset >= 0) out.push({ line: t, errorMs: ((onset - expect) / sr) * 1000, latencyMs: take.latencyMs });
        }
      }
      return out;
    },
    { code, starts: LINE_STARTS },
  );
}

const SIM_A = Number(process.env.SIM_LATENCY || 0.137);
const SIM_B = Number(process.env.SIM_LATENCY_B || 0.262);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const results = {};
try {
  // ───────── 방장: 방 만들기 ─────────
  const host = await newUser(browser, SIM_A, 0.03);
  await host.goto(BASE + '/');
  await shot(host, '01-home');
  await host.getByRole('button', { name: '방 만들기' }).click();
  await shot(host, '02-create-song');
  await host.getByRole('button', { name: '파일 없이 연습용 비트로 해보기' }).click();
  await host.getByRole('heading', { name: '파트를 나눠요' }).waitFor();
  // 2명으로 줄인다
  await host.getByRole('button', { name: '줄이기' }).click();
  await host.getByRole('button', { name: '줄이기' }).click();
  await host.getByLabel('내 이름').fill('방장민지');
  await shot(host, '03-create-parts');
  const open = host.getByRole('button', { name: '방 열고 번호 받기' });
  await open.waitFor({ timeout: 30000 });
  await open.scrollIntoViewIfNeeded();
  await shot(host, '03b-create-parts-bottom');
  await open.click();
  await host.locator('.code-show').waitFor({ timeout: 15000 });
  const code = (await host.locator('.code-show').innerText()).replace(/\D/g, '');
  assert.match(code, /^\d{6}$/);
  console.log('  ✓ 방이 열리고 번호가 나왔다:', code);
  await shot(host, '04-create-done');

  await host.getByRole('button', { name: '방으로 들어가기' }).click();
  await host.getByRole('heading', { name: '어느 파트를 부를래요?' }).waitFor();
  await shot(host, '05-room-pick');
  await host.getByRole('button', { name: /빨강 파트/ }).click();
  await host.getByRole('button', { name: '내 파트 녹음하기' }).waitFor();
  await shot(host, '06-room-seated');

  // ───────── 친구: 번호로 들어오기 ─────────
  const guest = await newUser(browser, SIM_B, 0.01);
  await guest.goto(BASE + '/');
  await guest.locator('#room-code').fill(code);
  await guest.getByRole('button', { name: '들어가기' }).click();
  await guest.getByLabel('내 이름').fill('도윤');
  await shot(guest, '07-guest-join');
  await guest.getByRole('button', { name: '들어가기' }).click();
  await guest.getByRole('heading', { name: '어느 파트를 부를래요?' }).waitFor();
  // 방장이 고른 빨강은 고를 수 없어야 한다
  assert.equal(await guest.getByRole('button', { name: /빨강 파트/ }).isDisabled(), true);
  await shot(guest, '08-guest-pick');
  await guest.getByRole('button', { name: /파랑 파트/ }).click();
  await guest.getByRole('button', { name: '내 파트 녹음하기' }).waitFor();
  console.log('  ✓ 친구가 번호로 들어와 남은 파트를 골랐다');

  // ───────── 방장 녹음 ─────────
  await host.getByRole('button', { name: '내 파트 녹음하기' }).click();
  await host.getByRole('heading', { name: '녹음 준비' }).waitFor();
  await shot(host, '09-rec-prep');
  const hostNotes = await recordAll(host, '10-host', true);
  console.log('  ✓ 방장 녹음 저장:', hostNotes[0]);
  const hostSync = await measureSync(host, code);
  results.host = hostSync;

  // ───────── 친구 녹음 (지연이 다른 기기) ─────────
  await guest.getByRole('button', { name: '내 파트 녹음하기' }).click();
  const guestNotes = await recordAll(guest, '11-guest');
  console.log('  ✓ 친구 녹음 저장:', guestNotes[0]);
  results.guest = await measureSync(guest, code);

  for (const [who, sim, list] of [['방장', SIM_A, results.host], ['친구', SIM_B, results.guest]]) {
    assert.ok(list.length >= 2, `${who}: 잰 지점이 너무 적다 (${list.length})`);
    const worst = Math.max(...list.map((r) => Math.abs(r.errorMs)));
    const mean = list.reduce((s, r) => s + r.errorMs, 0) / list.length;
    console.log(`  ✓ ${who} 싱크: 넣은 지연 ${Math.round(sim * 1000)}ms → 앱이 보정한 값 ${list[0].latencyMs}ms, 남은 오차 평균 ${mean.toFixed(1)}ms / 최대 ${worst.toFixed(1)}ms (${list.length}곳)`);
    assert.ok(worst < 8, `${who}: 싱크 오차가 크다 (${worst.toFixed(1)}ms)`);
  }

  // ───────── 합쳐 듣기 ─────────
  await host.getByRole('button', { name: '방으로 돌아가기' }).click();
  await host.getByRole('button', { name: '완성본 듣기' }).waitFor({ timeout: 15000 });
  await shot(host, '12-room-alldone');
  await host.getByRole('button', { name: '재생' }).click();
  await host.getByRole('button', { name: '멈추기' }).waitFor({ timeout: 20000 });
  await host.waitForTimeout(2500);
  const pos = await host.locator('.player-text strong').innerText();
  assert.notEqual(pos.split('/')[0].trim(), '0:00');
  await shot(host, '13-room-playing');
  await host.getByRole('button', { name: '멈추기' }).click();
  console.log('  ✓ 방 화면에서 반주와 두 사람 녹음이 함께 재생된다:', pos);

  await host.getByRole('button', { name: '완성본 듣기' }).click();
  await host.getByRole('heading', { name: '오늘의 시상식' }).waitFor({ timeout: 15000 });
  await shot(host, '14-mix');
  await host.getByRole('button', { name: '완성본 파일 만들기' }).click();
  const link = host.getByRole('link', { name: 'MP3 내려받기' });
  await link.waitFor({ timeout: 60000 });
  await link.scrollIntoViewIfNeeded();
  await shot(host, '15-mix-export');
  const dl = host.waitForEvent('download');
  await link.click();
  const file = await dl;
  const path = await file.path();
  const size = fs.statSync(path).size;
  assert.ok(size > 100_000, `완성본 파일이 너무 작다 (${size})`);
  if (SHOTS) fs.copyFileSync(path, `${SHOTS}/final-mix.mp3`);
  console.log(`  ✓ 완성본 MP3 가 만들어졌다: ${file.suggestedFilename()} (${Math.round(size / 1024)}KB)`);

  // ───────── 반주가 전혀 새지 않는 이어폰: 자동 측정이 안 되면 시험 소리로 재서 맞춘다 ─────────
  const solo = await newUser(browser, 0.193, 0);
  await solo.goto(BASE + '/new');
  await solo.getByRole('button', { name: '파일 없이 연습용 비트로 해보기' }).click();
  for (let i = 0; i < 3; i++) await solo.getByRole('button', { name: '줄이기' }).click(); // 혼자
  await solo.getByLabel('내 이름').fill('혼자');
  const open2 = solo.getByRole('button', { name: '방 열고 번호 받기' });
  await open2.waitFor({ timeout: 30000 });
  await open2.click();
  await solo.locator('.code-show').waitFor({ timeout: 15000 });
  const code2 = (await solo.locator('.code-show').innerText()).replace(/\D/g, '');
  await solo.getByRole('button', { name: '방으로 들어가기' }).click();
  await solo.getByRole('button', { name: /빨강 파트/ }).click();
  await solo.getByRole('button', { name: '내 파트 녹음하기' }).click();
  await solo.getByRole('button', { name: '마이크 켜기' }).click();
  await solo.getByRole('heading', { name: '마이크가 켜졌어요' }).waitFor({ timeout: 20000 });
  await solo.evaluate(() => {
    localStorage.removeItem('ttb.latency.v1'); // 처음 쓰는 기기처럼
    window.__ttbTest.singing = true;
  });
  await solo.getByRole('button', { name: /녹음 시작/ }).click();
  await solo.getByRole('heading', { name: '들어 보세요' }).waitFor({ timeout: 90000 });
  assert.match(await solo.locator('.lead').first().innerText(), /어긋나게 들리면/); // 자동으로는 못 쟀다
  await solo.getByRole('button', { name: '귀로 맞추기 어려우면 자동으로 재기' }).click();
  await shot(solo, '16-calibrate');
  await solo.getByRole('button', { name: '재기 시작' }).click();
  await solo.getByText('방금 녹음도 이 값으로 다시 맞췄어요').waitFor({ timeout: 20000 });
  await shot(solo, '17-calibrated');
  await solo.getByRole('button', { name: '닫기' }).click();
  assert.match(await solo.locator('.lead').first().innerText(), /자동으로 맞췄어요/);
  await solo.getByRole('button', { name: '이걸로 저장' }).click();
  await solo.getByRole('heading', { name: '다 불렀어요!' }).waitFor({ timeout: 30000 });
  const soloSync = await measureSync(solo, code2);
  const soloWorst = Math.max(...soloSync.map((r) => Math.abs(r.errorMs)));
  console.log(`  ✓ 새는 소리가 없을 때: 시험 소리로 재서(${soloSync[0].latencyMs}ms) 방금 녹음을 다시 맞췄다. 남은 오차 최대 ${soloWorst.toFixed(1)}ms (${soloSync.length}곳)`);
  assert.ok(soloSync.length >= 6 && soloWorst < 8, `시험 소리 보정 뒤 오차가 크다 (${soloWorst.toFixed(1)}ms)`);

  assert.deepEqual(overflows, [], `가로로 넘치는 화면이 있다 (${VW}px)`);
  console.log(`  ✓ ${VW}px 너비에서 가로로 넘치는 화면이 없다`);

  console.log('\n전체 흐름 통과');
} finally {
  await browser.close();
}
