import { describe, expect, it } from 'vitest';
import { DEMO_DURATION, DEMO_LINES } from './audio/demo';
import { alignWords, evenStarts, linesFromSegments, linesFromStarts, parseLyrics, type TimedWord } from './lyrics';
import { applyAssignment, autoAssign, blankLines, countSyllables, passesForSeat, passRecorded, repair, roomProgress, seatProgress, seatSeconds, type Line } from './parts';

const mk = (rows: [number, number, string, number[]?][]): Line[] => rows.map(([t0, t1, text, seats], i) => ({ id: 'L' + i, t0, t1, text, seats: seats || [] }));

describe('녹음 묶음(pass)', () => {
  const lines = mk([
    [1, 4, 'a', [0]],
    [5, 8, 'b', [1]],
    [9, 12, 'c', [0, 1]],
    [25, 28, 'd', [0]],
    [29, 31, 'e', [0]],
  ]);
  it('가까운 줄은 한 번에, 멀리 떨어진 줄은 따로 녹음한다', () => {
    const p0 = passesForSeat(lines, 0);
    expect(p0.map((p) => p.lines.map((l) => l.text).join(''))).toEqual(['ac', 'de']);
    expect(p0[0].t0).toBe(1);
    expect(p0[0].t1).toBe(12);
    expect(passesForSeat(lines, 1)).toHaveLength(1);
    expect(passesForSeat(lines, 2)).toHaveLength(0);
  });
  it('녹음이 줄 전체를 덮어야 끝난 것으로 본다', () => {
    const [first, second] = passesForSeat(lines, 0);
    const takes = [{ seat: 0, start: 0.7, dur: 11.8 }];
    expect(passRecorded(first, 0, takes)).toBe(true);
    expect(passRecorded(second, 0, takes)).toBe(false);
    expect(passRecorded(first, 0, [{ seat: 0, start: 0.7, dur: 5 }])).toBe(false);
    expect(passRecorded(first, 0, [{ seat: 1, start: 0.7, dur: 11.8 }])).toBe(false);
    expect(seatProgress(lines, 0, takes)).toEqual({ total: 2, done: 1 });
    const all = roomProgress(lines, 2, [...takes, { seat: 0, start: 24.8, dur: 6.5 }, { seat: 1, start: 4.9, dur: 7.4 }]);
    expect(all).toEqual({ total: 3, done: 3, allDone: true });
  });
  it('싱크를 밀어도 허용 범위 안이면 그대로 인정한다', () => {
    const [first] = passesForSeat(lines, 0);
    expect(passRecorded(first, 0, [{ seat: 0, start: 0.7, dur: 11.8, offsetMs: 120 }])).toBe(true);
  });
});

describe('자동 배정', () => {
  const demo = (): Line[] => DEMO_LINES.map((l, i) => ({ ...l, id: 'd' + i, seats: [] }));

  for (const n of [2, 3, 4, 6, 8]) {
    it(`${n}명: 모든 줄에 사람이 있고, 모두 최소 한 줄은 부른다`, () => {
      const out = autoAssign(demo(), n);
      expect(out.every((l) => l.seats.length >= 1 && l.seats.every((s) => s >= 0 && s < n))).toBe(true);
      for (let s = 0; s < n; s++) expect(out.some((l) => l.seats.includes(s))).toBe(true);
    });
  }

  it('혼자 부르는 묶음은 같은 사람이 연달아 맡지 않고, 시간이 고르게 나뉜다', () => {
    const lines = mk(Array.from({ length: 16 }, (_, i) => [i * 3, i * 3 + 2.8, `서로 다른 가사 줄 ${i} ${'가'.repeat(i % 5)}`] as [number, number, string]));
    const out = autoAssign(lines, 4);
    const solos = out.filter((l) => l.seats.length === 1);
    let prev = -1;
    let run = 0;
    for (const l of solos) {
      run = l.seats[0] === prev ? run + 1 : 1;
      prev = l.seats[0];
      expect(run).toBeLessThanOrEqual(3);
    }
    const secs = [0, 1, 2, 3].map((s) => seatSeconds(out, s));
    expect(Math.max(...secs) - Math.min(...secs)).toBeLessThan(9);
  });

  it('가사 없는 구간 12개를 4명에게: 혼자 부르는 구간 수가 한 개 넘게 차이 나지 않는다', () => {
    const out = autoAssign(blankLines(60, 92, 0.6), 4);
    const solo = [0, 1, 2, 3].map((s) => out.filter((l) => l.seats.length === 1 && l.seats[0] === s).length);
    expect(Math.max(...solo) - Math.min(...solo)).toBeLessThanOrEqual(1);
    // 마지막 구간은 다같이, 그 앞 구간은 둘이서 부르므로 혼자 부르는 구간은 전체에서 둘을 뺀 수다
    expect(solo.reduce((a, b) => a + b, 0)).toBe(out.length - 2);
  });

  for (const [n, count] of [[3, 9], [5, 14], [6, 20], [8, 24]] as const) {
    it(`${count}줄을 ${n}명에게: 부르는 시간이 고르게 나뉜다`, () => {
      const lines = mk(Array.from({ length: count }, (_, i) => [i * 3.2, i * 3.2 + 3, `서로 다른 줄 ${i} ${'나'.repeat(i % 4)}`] as [number, number, string]));
      const out = autoAssign(lines, n);
      const secs = Array.from({ length: n }, (_, s) => seatSeconds(out, s));
      // 가장 많이 부르는 사람과 적게 부르는 사람의 차이가 두 줄(6.4초)을 넘지 않는다
      expect(Math.max(...secs) - Math.min(...secs)).toBeLessThanOrEqual(6.5);
    });
  }

  it('반복되는 줄(후렴)은 다같이 부른다', () => {
    const lines = mk([
      [0, 3, '첫 소절이에요'],
      [3, 6, '둘째 소절이죠'],
      [6, 9, '라라라 떼창 후렴'],
      [9, 12, '셋째 소절 가요'],
      [12, 15, '넷째 소절 와요'],
      [15, 18, '라라라 떼창 후렴!'],
    ]);
    const out = autoAssign(lines, 3);
    expect(out[2].seats).toEqual([0, 1, 2]);
    expect(out[5].seats).toEqual([0, 1, 2]);
    expect(out[0].seats).toHaveLength(1);
    // 후렴 바로 앞 줄은 둘이서
    expect(out[1].seats.length).toBe(2);
  });

  it('반복이 없으면 마지막 줄을 다같이로 둔다', () => {
    const out = autoAssign(mk(Array.from({ length: 6 }, (_, i) => [i * 4, i * 4 + 3, `줄 ${i} 내용`] as [number, number, string])), 3);
    expect(out[5].seats).toEqual([0, 1, 2]);
  });

  it('한 명이면 전부 그 사람', () => {
    expect(autoAssign(demo(), 1).every((l) => l.seats.length === 1 && l.seats[0] === 0)).toBe(true);
  });

  it('룰렛도 빈 자리 없이 나눈다 (여러 번 돌려도)', () => {
    let seed = 5;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let k = 0; k < 40; k++) {
      const n = 2 + (k % 5);
      const out = autoAssign(demo(), n, 'roulette', rand);
      expect(out.every((l) => l.seats.length >= 1)).toBe(true);
      for (let s = 0; s < n; s++) expect(out.some((l) => l.seats.includes(s))).toBe(true);
    }
  });

  it('줄보다 사람이 많으면 함께 부르게 해서라도 모두 넣는다', () => {
    const out = autoAssign(mk([[0, 3, '하나'], [4, 7, '둘']]), 5);
    expect(out.every((l) => l.seats.length >= 1)).toBe(true);
  });

  it('AI 답이 엉성해도 고쳐서 쓴다', () => {
    const lines = demo();
    const out = applyAssignment(lines, { d0: [0], d1: [9, 1], d2: [], d5: [2, 2] }, 3);
    expect(out.every((l) => l.seats.length >= 1 && l.seats.every((s) => s < 3))).toBe(true);
    expect(out[1].seats).toEqual([1]);
    expect(out[5].seats).toEqual([2]);
    for (let s = 0; s < 3; s++) expect(out.some((l) => l.seats.includes(s))).toBe(true);
    expect(repair(mk([[0, 1, 'x', [0]]]), 2)[0].seats).toEqual([0]);
  });

  it('가사 없는 구간은 박자에 맞춰 나눈다', () => {
    const lines = blankLines(30, 120, 0.25);
    // 120BPM → 한 마디 2초 → 두 마디 4초 단위
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(lines[1].t0 - lines[0].t0).toBeCloseTo(4, 2);
    expect(lines.every((l) => l.t1 > l.t0 && l.t1 <= 30)).toBe(true);
    const free = blankLines(22);
    expect(free[1].t0 - free[0].t0).toBeCloseTo(5, 2);
    expect(blankLines(1.5)).toHaveLength(1);
  });

  it('글자 수 세기', () => {
    expect(countSyllables('하나 둘 셋 시작해')).toBe(7);
    expect(countSyllables('Heart shaker baby')).toBe(5);
    expect(countSyllables('1, 2, 3 가자!')).toBe(5);
  });
});

describe('가사', () => {
  it('붙여넣은 가사에서 빈 줄과 [후렴] 같은 표시를 뺀다', () => {
    const p = parseLyrics('[Verse 1]\n첫 줄이에요\n\n  둘째 줄  \n(후렴)\n셋째 줄\r\n');
    expect(p.texts).toEqual(['첫 줄이에요', '둘째 줄', '셋째 줄']);
    expect(p.times).toBeNull();
  });

  it('LRC 시간표를 읽는다 (한 줄에 시간이 여러 개여도)', () => {
    const p = parseLyrics('[ti:제목]\n[00:12.50]첫 줄\n[00:18.2][01:02.00]후렴\n[00:15]둘째 줄');
    expect(p.texts).toEqual(['첫 줄', '둘째 줄', '후렴', '후렴']);
    expect(p.times).toEqual([12.5, 15, 18.2, 62]);
  });

  it('시작 시각으로 줄 구간을 만든다: 끝은 다음 줄 직전, 간주가 길면 적당히 끊는다', () => {
    const lines = linesFromStarts(['가나다라', '마바사아', '자차카타'], [1, 4, 30], 40);
    expect(lines[0].t0).toBe(1);
    expect(lines[0].t1).toBeCloseTo(3.96, 2);
    expect(lines[1].t1).toBeLessThan(12);
    expect(lines[2].t1).toBeLessThanOrEqual(40);
    expect(linesFromStarts(['a', 'b'], [5, 50], 20)).toHaveLength(1);
  });

  it('고르게 펼치기', () => {
    const s = evenStarts(['짧다', '이 줄은 훨씬 길고 글자가 많아요', '끝'], 20);
    expect(s[0]).toBeCloseTo(0.6, 2);
    expect(s[2] - s[1]).toBeGreaterThan(s[1] - s[0]);
    expect(s[2]).toBeLessThan(20);
  });

  const texts = DEMO_LINES.map((l) => l.text);
  const perfectWords = (): TimedWord[] =>
    DEMO_LINES.flatMap((l) => {
      const ws = l.text.split(' ');
      const step = (l.t1 - l.t0) / ws.length;
      return ws.map((w, i) => ({ w, s: l.t0 + i * step, e: l.t0 + (i + 1) * step - 0.05 }));
    });

  it('받아쓰기가 정확하면 줄 시작을 0.15초 안으로 맞춘다', () => {
    const r = alignWords(texts, perfectWords(), DEMO_DURATION);
    expect(r.confidence).toBeGreaterThan(0.95);
    r.starts.forEach((s, i) => expect(Math.abs(s - DEMO_LINES[i].t0)).toBeLessThan(0.15));
  });

  it('받아쓰기가 틀리고 빠져도 줄 순서와 대략의 위치를 지킨다', () => {
    const words = perfectWords()
      // 한 줄(3번째)은 통째로 못 듣고, 군데군데 틀리게 듣는다
      .filter((w) => !(w.s >= DEMO_LINES[2].t0 && w.s < DEMO_LINES[2].t1))
      .map((w, i) => (i % 4 === 1 ? { ...w, w: w.w.replace(/[가-힣]$/, '요') } : w));
    words.unshift({ w: '음악', s: 0.2, e: 0.6 });
    words.push({ w: '감사합니다', s: DEMO_DURATION - 0.5, e: DEMO_DURATION - 0.1 });
    const r = alignWords(texts, words, DEMO_DURATION);
    expect(r.confidence).toBeGreaterThan(0.6);
    r.starts.forEach((s, i) => {
      expect(Math.abs(s - DEMO_LINES[i].t0)).toBeLessThan(i === 2 ? 1.2 : 0.4);
      if (i > 0) expect(s).toBeGreaterThan(r.starts[i - 1]);
    });
  });

  it('전혀 다른 말이 들어오면 자신 없다고 알려 준다', () => {
    const words = [{ w: 'completely', s: 1, e: 2 }, { w: 'different', s: 3, e: 4 }];
    const r = alignWords(texts, words, DEMO_DURATION);
    expect(r.confidence).toBeLessThan(0.2);
    expect(r.starts).toHaveLength(texts.length);
    r.starts.forEach((s, i) => i > 0 && expect(s).toBeGreaterThan(r.starts[i - 1]));
  });

  it('가사를 안 넣었으면 받아쓴 문장을 줄로 쓴다', () => {
    const lines = linesFromSegments(
      [
        { s: 2, e: 5, text: ' ♪ 첫 문장 ♪ ' },
        { s: 0.5, e: 1.5, text: '먼저' },
        { s: 99, e: 100, text: '밖' },
        { s: 6, e: 6.1, text: '' },
        { s: 7, e: 8, text: '(음악)' },
        { s: 9, e: 10, text: '시청해주셔서 감사합니다.' },
        { s: 11, e: 12, text: '♪♪' },
      ],
      20,
    );
    expect(lines.map((l) => l.text)).toEqual(['먼저', '첫 문장']);
  });
});
