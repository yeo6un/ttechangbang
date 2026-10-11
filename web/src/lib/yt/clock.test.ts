import { describe, expect, it } from 'vitest';
import { AudioWallClock, fitZero, fitZeroLines, MediaClock, OffsetTracker, tZeroOf, type AudioClockSource, type ZeroLog } from './clock';

/** 씨앗이 정해진 난수 (테스트가 매번 같은 결과를 내게) */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('OffsetTracker', () => {
  it('잡음 섞인 표본에서 차이값을 잡고, 한 번 튄 값은 무시한다', () => {
    const r = rng(1);
    const tr = new OffsetTracker({ tol: 0.045, minSamples: 3, minSpan: 0.3, window: 8, mode: 'median' });
    expect(tr.locked).toBe(false);
    for (let i = 0; i < 20; i++) tr.add(i * 0.25, 12.5 + (r() - 0.5) * 0.006);
    expect(tr.locked).toBe(true);
    expect(tr.value).toBeCloseTo(12.5, 2);
    tr.add(5.1, 12.9); // 한 번 튐
    expect(tr.value).toBeCloseTo(12.5, 2);
    expect(tr.jumps).toBe(0);
  });

  it('표본이 모자라거나 한순간에 몰려 있으면 아직 믿지 않는다', () => {
    const tr = new OffsetTracker({ tol: 0.045, minSamples: 3, minSpan: 0.3, window: 8, mode: 'median' });
    tr.add(0, 1);
    tr.add(0.05, 1);
    tr.add(0.1, 1);
    expect(tr.locked).toBe(false);
    tr.add(0.4, 1);
    expect(tr.locked).toBe(true);
  });

  it('값이 옮겨 가면(탐색·버퍼링) 알아채고 새 값으로 다시 잡는다', () => {
    const tr = new OffsetTracker({ tol: 0.045, minSamples: 3, minSpan: 0.3, window: 8, mode: 'median' });
    for (let i = 0; i < 10; i++) tr.add(i * 0.25, 3);
    expect(tr.locked).toBe(true);
    tr.add(2.6, 2.4);
    expect(tr.locked).toBe(true); // 한 번은 봐준다
    tr.add(2.85, 2.4);
    expect(tr.locked).toBe(false);
    expect(tr.jumps).toBe(1);
    tr.add(3.1, 2.4);
    expect(tr.locked).toBe(true);
    expect(tr.value).toBeCloseTo(2.4, 6);
  });

  it('upper: 계단처럼 늦게 읽힌 표본들에서는 위쪽 값을 고른다', () => {
    const r = rng(7);
    const tr = new OffsetTracker({ tol: 0.09, minSamples: 6, minSpan: 0.25, window: 3, mode: 'upper' });
    // 참값 5.0, 표본은 0~40ms 만큼 작게 읽힌다
    for (let i = 0; i < 60; i++) tr.add(i * 0.05, 5 - r() * 0.04);
    expect(tr.locked).toBe(true);
    expect(tr.value).toBeGreaterThan(4.99);
    expect(tr.value).toBeLessThanOrEqual(5);
  });
});

describe('OffsetTracker: 되짚어 보기', () => {
  it('값이 조금 옮겨 간 직후에 실시간 값은 예전 값을 따라가지만, 그 시간 폭의 표본만으로 고르면 바로 새 값이 나온다', () => {
    const tr = new OffsetTracker({ tol: 0.045, minSamples: 3, minSpan: 0.3, window: 8, mode: 'median' });
    // 4초에 20ms 옮겨 갔다 (허용 폭 안이라 "튄 값"으로 보지 않는다)
    for (let i = 0; i < 50; i++) tr.add(i * 0.1, i < 40 ? 2 : 2.02);
    expect(tr.value).toBeCloseTo(2, 9); // 아직 예전 값
    expect(tr.valueIn(0, 3.95)).toBeCloseTo(2, 9);
    expect(tr.valueIn(4, 4.95)).toBeCloseTo(2.02, 9);
    expect(tr.valueIn(20, 30)).toBeNull(); // 그때 받은 표본이 없다
    expect(tr.valueIn(4.7, 4.95)).toBeNull(); // 너무 적다
    // 새로 잡아도(탐색 등) 지나간 표본은 남아 있다
    tr.reset();
    expect(tr.valueIn(0, 3.95)).toBeCloseTo(2, 9);
    // 표본의 성질이 바뀌면 섞어 쓰지 않도록 지운다
    tr.setMode('upper');
    expect(tr.valueIn(0, 3.95)).toBeNull();
  });
});

describe('MediaClock', () => {
  it('재생 중인 영상의 위치를 벽시계에서 계산한다', () => {
    const c = new MediaClock();
    c.setPlaying(true);
    const D = 41.7 - 1000; // 벽시계 1000초에 영상은 41.7초
    for (let i = 0; i < 6; i++) {
      const wall = 1000 + i * 0.25;
      c.feed(wall + D, wall * 1000);
    }
    expect(c.locked).toBe(true);
    expect(c.mediaAt(1003_000)).toBeCloseTo(44.7, 6);
  });

  it('멈추면 그 자리에 서 있고, 탐색 직후에는 낡은 표본을 받지 않는다', () => {
    const c = new MediaClock();
    c.setPlaying(true);
    for (let i = 0; i < 6; i++) c.feed(10 + i * 0.25, (500 + i * 0.25) * 1000);
    expect(c.locked).toBe(true);
    c.noteSeek(60, 502_000);
    expect(c.locked).toBe(false);
    expect(c.mediaAt(502_100)).toBe(60); // 영상이 실제로 돌기 전에는 멈춰 둔다
    c.feed(11.6, 502_050); // 탐색 전 위치를 알리는 늦은 표본
    expect(c.mediaAt(502_100)).toBe(60);
    for (let i = 0; i < 5; i++) c.feed(60 + i * 0.25, (502.4 + i * 0.25) * 1000);
    expect(c.locked).toBe(true);
    expect(c.mediaAt(504_400)).toBeCloseTo(62, 6);
  });
});

describe('MediaClock: 위치를 잰 시각을 알려 주지 않는 플레이어', () => {
  it('알림이 도착한 시각만 알 때는(늦게만 도착한다) 위쪽 값을 골라 늦은 만큼 밀리지 않게 한다', () => {
    const r = rng(5);
    const D = 12.3 - 2000;
    const feed = (c: MediaClock, exact: boolean) => {
      c.setPlaying(true);
      for (let i = 0; i < 32; i++) {
        const wall = 2000 + i * 0.25;
        // 알림은 0~12ms 늦게 도착하고, 가끔 30ms 넘게 늦는다
        const late = r() * 0.012 + (i % 9 === 4 ? 0.03 : 0);
        c.feed(wall + D, (wall + late) * 1000, exact);
      }
    };
    const upper = new MediaClock();
    feed(upper, false);
    expect(upper.locked).toBe(true);
    // 참값보다 늦게 잡히는 정도가 2ms 를 넘지 않는다
    expect(D - upper.offset).toBeGreaterThanOrEqual(0);
    expect(D - upper.offset).toBeLessThan(0.002);
    // 같은 표본을 가운데 값으로 고르면 평균 지연만큼(6ms 쯤) 밀린다
    const median = new MediaClock();
    feed(median, true);
    expect(D - median.offset).toBeGreaterThan(0.004);
  });

  it('정확한 표본이 오는 동안에는 어림 표본을 섞지 않는다 (번갈아 받아도 잡은 값을 놓지 않는다)', () => {
    const c = new MediaClock();
    c.setPlaying(true);
    for (let i = 0; i < 6; i++) c.feed(5 + i * 0.25, (100 + i * 0.25) * 1000, true);
    expect(c.locked).toBe(true);
    for (let i = 6; i < 20; i++) {
      c.feed(5 + i * 0.25, (100 + i * 0.25) * 1000, true);
      c.feed(5 + i * 0.25, (100 + i * 0.25) * 1000 + 400, false); // 한참 늦게 읽은 값
      expect(c.locked).toBe(true);
    }
    expect(c.offset).toBeCloseTo(5 - 100, 6);
  });

  it('도중에 정확한 시각이 오기 시작하면 고르는 방법을 바꿔 새로 잡는다', () => {
    const c = new MediaClock();
    c.setPlaying(true);
    for (let i = 0; i < 6; i++) c.feed(5 + i * 0.25, (100 + i * 0.25) * 1000 + 8, false);
    expect(c.locked).toBe(true);
    c.feed(6.5, 101_500, true);
    expect(c.locked).toBe(false);
    for (let i = 1; i < 6; i++) c.feed(6.5 + i * 0.25, (101.5 + i * 0.25) * 1000, true);
    expect(c.locked).toBe(true);
    expect(c.offset).toBeCloseTo(5 - 100, 6);
  });
});

/** 가짜 AudioContext: 처리 위치는 buffer 초 단위 계단으로 오르고, 실제 소리는 outLat 초 뒤에 난다 */
function fakeCtx(opts: { origin: number; buffer: number; outLat: number; stamps: 'good' | 'none' | 'uncompensated'; reported?: number }) {
  let wall = 0;
  const cont = () => wall - opts.origin; // 계단이 없는 이상적인 처리 위치
  const src: AudioClockSource & { at(w: number): void } = {
    at(w: number) {
      wall = w;
    },
    get currentTime() {
      return Math.max(0, Math.floor(cont() / opts.buffer) * opts.buffer);
    },
    state: 'running',
    get outputLatency() {
      return opts.reported ?? opts.outLat;
    },
    baseLatency: 0,
  };
  if (opts.stamps !== 'none') {
    src.getOutputTimestamp = () => {
      // 마지막 계단이 시작된 순간에 잰 값을 돌려준다
      const stepWall = opts.origin + Math.floor(cont() / opts.buffer) * opts.buffer;
      const heard = stepWall - opts.origin - (opts.stamps === 'good' ? opts.outLat : 0);
      return { contextTime: heard, performanceTime: stepWall * 1000 };
    };
  }
  return src;
}

describe('AudioWallClock', () => {
  const run = (ctx: ReturnType<typeof fakeCtx>, clock: AudioWallClock) => {
    const r = rng(3);
    for (let w = 100; w < 104; w += 0.08 + r() * 0.01) {
      ctx.at(w);
      clock.sample(w * 1000);
    }
  };

  it('브라우저가 알려 주는 출력 위치로 "귀에 들리는 소리 시계"를 잡는다', () => {
    const ctx = fakeCtx({ origin: 90, buffer: 0.01, outLat: 0.12, stamps: 'good' });
    const clock = new AudioWallClock(ctx);
    run(ctx, clock);
    expect(clock.locked).toBe(true);
    // 벽시계 w 에 귀에 들리는 소리 시계 = (w - 90) - 0.12
    expect(clock.offset).toBeCloseTo(-90 - 0.12, 3);
    expect(clock.ahead(103_990)).toBeGreaterThan(0.1);
  });

  it('출력 위치를 알려 주지 않는 브라우저에서는 처리 위치와 알려 준 지연으로 잡는다', () => {
    const ctx = fakeCtx({ origin: 90, buffer: 0.02, outLat: 0.05, stamps: 'none' });
    const clock = new AudioWallClock(ctx);
    run(ctx, clock);
    expect(clock.locked).toBe(true);
    expect(Math.abs(clock.offset - (-90 - 0.05))).toBeLessThan(0.006);
  });

  it('지연을 반영하지 않은 출력 위치를 주는 브라우저는 알려 준 지연만큼 고쳐 쓴다', () => {
    const ctx = fakeCtx({ origin: 90, buffer: 0.005, outLat: 0.18, stamps: 'uncompensated' });
    const clock = new AudioWallClock(ctx);
    run(ctx, clock);
    expect(clock.offset).toBeCloseTo(-90 - 0.18, 2);
  });
});

describe('녹음과 재생의 싱크 (가상의 기기)', () => {
  /**
   * 한 기기의 세계: 벽시계 w 에 영상은 w + D 를 들려준다. 소리 시계의 c 는 벽시계 c + originA + o 에 귀에 들린다
   * (o = 재생 지연). 마이크로 들어온 소리는 i 초 뒤에 소리 시계에 찍힌다.
   */
  const device = (D: number, origin: number, o: number, i: number) => ({
    D,
    A: -origin - o,
    /** 가수가 영상 위치 m 에 맞춰 낸 소리가 찍히는 소리 시계 */
    recordedAt: (m: number) => m - D + i - origin,
    /** 소리 시계 c 에 예약한 소리가 귀에 들릴 때의 영상 위치 */
    heardMedia: (c: number) => c + origin + o + D,
    roundTrip: o + i,
  });

  it('잰 왕복 지연과 tZero 로 자르면 목소리가 제자리에 오고, 다른 기기에서 틀어도 맞는다', () => {
    const segStart = 62; // 영상의 62초부터가 구간 0초
    const a = device(-940.2, 900, 0.045, 0.021);
    const tZeroA = tZeroOf(segStart, a.D, a.A);
    // 구간 10초(영상 72초)에 낸 소리
    const frameTime = a.recordedAt(segStart + 10);
    // 앱의 계산: 찍힌 시각 − tZero − 왕복 지연 = 구간 위치
    expect(frameTime - tZeroA - a.roundTrip).toBeCloseTo(10, 9);

    // 재생 지연이 전혀 다른 기기(블루투스)에서 틀기
    const b = device(-70.5, 20, 0.21, 0.03);
    const tZeroB = tZeroOf(segStart, b.D, b.A);
    const scheduled = tZeroB + 10; // 구간 10초짜리 소리를 예약
    expect(b.heardMedia(scheduled) - segStart).toBeCloseTo(10, 9);
  });

  it('녹음하는 동안의 tZero 기록에서 부른 구간의 대푯값을 고른다', () => {
    const r = rng(11);
    const log = [];
    for (let pos = -4; pos < 30; pos += 0.08) log.push({ pos, k: 123.456 + (r() - 0.5) * 0.004 });
    log[40].k += 0.2; // 한 번 튄 값
    const fit = fitZero(log, 5, 20)!;
    expect(fit.tZero).toBeCloseTo(123.456, 2);
    expect(fit.spread).toBeLessThan(0.01);
    expect(fit.n).toBeGreaterThan(100);
    // 영상이 끊겨 값이 흩어진 경우
    const broken = log.map((e) => (e.pos > 12 ? { ...e, k: e.k + 0.4 } : e));
    expect(fitZero(broken, 5, 20)!.spread).toBeGreaterThan(0.3);
    expect(fitZero([], 0, 1)).toBeNull();
  });

  it('부르는 도중에 싱크가 옮겨 가면 줄마다 그때의 값을 쓴다', () => {
    const r = rng(23);
    const log = [];
    // 구간 9초에서 소리 처리가 0.11초 밀렸다 (그 뒤로는 tZero 가 0.11 작다)
    for (let pos = -4; pos < 24; pos += 0.08) log.push({ pos, k: 50 + (pos > 9 ? -0.11 : 0) + (r() - 0.5) * 0.004 });
    const windows: [number, number][] = [
      [1, 3.4],
      [4, 6.4],
      [11, 13.4],
      [14, 16.4],
      [17, 19.4],
    ];
    const fit = fitZeroLines(log, windows)!;
    // 전체 대푯값은 줄이 많은 쪽(뒤쪽)
    expect(fit.overall.tZero).toBeCloseTo(49.89, 2);
    expect(fit.lines[0]).toBeCloseTo(50, 2);
    expect(fit.lines[1]).toBeCloseTo(50, 2);
    // 대푯값과 같은 쪽의 줄은 똑같은 값을 쓴다 (잔떨림을 따라가지 않는다)
    expect(fit.lines[2]).toBe(fit.overall.tZero);
    expect(fit.lines[4]).toBe(fit.overall.tZero);
    expect(fit.spread).toBeLessThan(0.01); // 줄 안에서는 흔들리지 않았다
  });

  it('옮겨 간 바로 뒤의 줄: 실시간 값은 한동안 예전 값에 머물지만, 되짚어 고르면 그 줄을 부르던 때의 값이 나온다', () => {
    const r = rng(31);
    const opts = { origin: 90, buffer: 0.01, outLat: 0.05, stamps: 'good' as const };
    const ctx = fakeCtx(opts);
    const audio = new AudioWallClock(ctx);
    const media = new MediaClock();
    media.setPlaying(true);
    const segStart = 30;
    const D = -74; // 벽시계 100초에 영상 26초(구간 −4초)
    const log: ZeroLog[] = [];
    let report = 100;
    for (let w = 100; w < 124; w += 0.08) {
      // 벽시계 110초(구간 6초)에 소리 처리가 한 번 밀려서, 그 뒤로는 소리가 20ms 늦게 나온다
      if (w >= 110) opts.outLat = 0.07;
      for (; report <= w; report += 0.25) media.feed(report + D, report * 1000 + (r() - 0.5) * 4);
      ctx.at(w);
      audio.sample(w * 1000);
      if (media.locked && audio.locked) log.push({ pos: w + D - segStart, k: tZeroOf(segStart, media.offset, audio.offset), at: w });
    }
    const truth = (outLat: number) => tZeroOf(segStart, D, -90 - outLat);
    // 옮겨 가기 전의 줄 / 바로 뒤의 줄 / 한참 뒤의 줄들
    const windows: [number, number][] = [
      [1, 3.5],
      [6.5, 8],
      [10, 12.5],
      [13, 15.5],
      [16, 18.5],
    ];
    const live = fitZeroLines(log, windows)!;
    const back = fitZeroLines(log, windows, { segStart, media: (a, b) => media.valueIn(a, b), audio: (a, b) => audio.valueIn(a, b) })!;
    expect(back.lines[0]).toBeCloseTo(truth(0.05), 2);
    expect(back.lines[1]).toBeCloseTo(truth(0.07), 2);
    expect(back.lines[4]).toBeCloseTo(truth(0.07), 2);
    expect(back.lines[2]).toBe(back.overall.tZero); // 대푯값과 같은 쪽은 똑같은 값
    // 실시간 값만으로 고르면 바로 뒤의 줄이 예전 값 쪽에 남는다
    expect(Math.abs(live.lines[1] - truth(0.07))).toBeGreaterThan(0.012);
    expect(Math.abs(back.lines[1] - truth(0.07))).toBeLessThan(0.003);
  });

  it('되짚어 볼 표본이 없으면(기록에 시각이 없거나 표본이 모자라면) 기록된 값으로 고른다', () => {
    const log: ZeroLog[] = [];
    for (let pos = 0; pos < 10; pos += 0.08) log.push({ pos, k: 7 + (pos > 5 ? 0.05 : 0), at: 200 + pos });
    const none = { segStart: 0, media: () => null, audio: () => null };
    const fit = fitZeroLines(log, [[1, 3], [6, 9]], none)!;
    expect(fit.lines[0]).toBeCloseTo(7, 6);
    expect(fit.lines[1]).toBeCloseTo(7.05, 6);
    // 시각이 적히지 않은 기록
    const bare = fitZeroLines(log.map(({ pos, k }) => ({ pos, k })), [[1, 3], [6, 9]], { segStart: 0, media: () => 1, audio: () => 2 })!;
    expect(bare.lines[0]).toBeCloseTo(7, 6);
  });

  it('줄을 부르는 도중에 옮겨 갔으면 흩어진 정도로 알려 준다', () => {
    const log = [];
    for (let pos = 0; pos < 10; pos += 0.08) log.push({ pos, k: 7 + (pos > 5 ? 0.2 : 0) });
    const fit = fitZeroLines(log, [[3, 7]])!;
    expect(fit.spread).toBeGreaterThan(0.15);
    expect(fitZeroLines([], [[0, 1]])).toBeNull();
    expect(fitZeroLines(log, [])).toBeNull();
  });
});
