import { describe, expect, it } from 'vitest';
import { fromItunes, guessFromVideoTitle, normName, ytQueryFor } from './find';
import { parseSynced, rangeToLines, shiftLines, suggestRange, syncLineEnd } from './lyrics';
import { passesForSeat, PASS_MAX, type Line } from './parts';
import { parseYtId, ytSearchUrl, ytWatchUrl } from './yt/ids';

// 테스트용 가사는 모두 이 앱을 위해 지은 연습용 문장이다
const LRC = [
  '[00:10.00] 하나 둘 셋 시작해',
  '[00:14.50] 목소리를 겹쳐 봐',
  '[00:19.00]',
  '[00:30.00] 틀려도 그냥 웃어',
  '[00:34.00] 박자는 대충 가도',
  '[00:40.00][01:20.00] 다 같이 크게 질러 봐',
  '[00:44.00][01:24.00] 떼창방에서 만나',
  '[00:48.00][01:28.00] 우리 노래가 되게',
  '[00:53.00] ♪',
  '[01:00.00] 여기는 내가 할게',
  '[01:05.00] 다음은 네가 받아',
  '[01:33.00]',
].join('\n');

describe('찾아온 가사(시간표 포함) 읽기', () => {
  const sync = parseSynced(LRC);

  it('시각 순서로 줄을 만들고, 글자 없는 줄은 앞 줄의 끝 표시로 쓴다', () => {
    expect(sync.map((l) => l.t)).toEqual([10, 14.5, 30, 34, 40, 44, 48, 60, 65, 80, 84, 88]);
    expect(sync[1]).toEqual({ t: 14.5, text: '목소리를 겹쳐 봐', end: 19 });
    expect(sync[6].end).toBe(53); // 기호만 있는 줄도 끝 표시다
    expect(sync[11].end).toBe(93);
    expect(sync[0].end).toBeNull();
  });

  it('한 줄에 시각이 여러 개면 그만큼 되풀이된다', () => {
    expect(sync.filter((l) => l.text === '떼창방에서 만나').map((l) => l.t)).toEqual([44, 84]);
  });

  it('글자마다 시각을 적은 표기와 엉뚱한 줄은 걸러 낸다', () => {
    const out = parseSynced('[ar: 누군가]\n그냥 글\n[00:01.00] <00:01.00>하나 <00:01.50>둘\n');
    expect(out).toEqual([{ t: 1, text: '하나 둘', end: null }]);
  });

  it('줄 끝: 끝 표시, 다음 줄 직전, 글자 수 어림 가운데 가장 이른 것', () => {
    expect(syncLineEnd(sync, 0)).toBeCloseTo(14.46, 2); // 다음 줄 직전
    expect(syncLineEnd(sync, 1)).toBeLessThanOrEqual(19); // 끝 표시보다 늦지 않다
    expect(syncLineEnd(sync, 3)).toBeLessThan(40); // 간주가 길면 글자 수로 어림
  });

  it('추천 구간: 처음부터 첫 후렴(되풀이되는 줄 묶음)이 끝나는 곳까지', () => {
    const r = suggestRange(sync);
    expect(r).toEqual({ a: 0, b: 6 });
  });

  it('추천 구간: 되풀이가 없으면 앞에서부터 한 토막', () => {
    const plain = parseSynced(Array.from({ length: 40 }, (_, i) => `[${String(Math.floor((i * 5) / 60)).padStart(2, '0')}:${String((i * 5) % 60).padStart(2, '0')}.00] 서로 다른 줄 ${i}번`).join('\n'));
    const r = suggestRange(plain, 70);
    expect(r.a).toBe(0);
    expect(syncLineEnd(plain, r.b) - plain[0].t).toBeLessThanOrEqual(70);
    expect(r.b).toBeGreaterThan(8);
  });

  it('고른 줄 범위를 방에 넣을 구간과 줄로 바꾼다 (영상이 늦게 시작하면 그만큼 민다)', () => {
    const pick = rangeToLines(sync, 2, 6, 12.5, 200);
    // 첫 줄(30초)이 영상에서는 42.5초: 구간은 그보다 1초 앞에서 시작한다
    expect(pick.start).toBeCloseTo(41.5, 3);
    expect(pick.lines.map((l) => l.text)).toEqual(['틀려도 그냥 웃어', '박자는 대충 가도', '다 같이 크게 질러 봐', '떼창방에서 만나', '우리 노래가 되게']);
    expect(pick.lines[0].t0).toBeCloseTo(1, 3);
    expect(pick.lines[2].t0).toBeCloseTo(11, 3);
    // 마지막 줄은 끝 표시(53초)에서 끝나고, 구간은 그 뒤 1.2초까지
    expect(pick.lines[4].t1).toBeCloseTo(53 + 12.5 - 41.5, 3);
    expect(pick.dur).toBeCloseTo(53 + 12.5 + 1.2 - 41.5, 3);
    for (const l of pick.lines) expect(l.t1).toBeGreaterThan(l.t0);
  });

  it('구간은 영상 길이를 넘지 않고, 영상 맨 앞보다 앞으로 가지 않는다', () => {
    const tail = rangeToLines(sync, 9, 11, 0, 90);
    expect(tail.start + tail.dur).toBeLessThanOrEqual(90);
    const head = rangeToLines(parseSynced('[00:00.30] 처음부터 부르는 줄\n[00:05.00] 다음 줄'), 0, 1, 0, 60);
    expect(head.start).toBe(0);
    expect(head.lines[0].t0).toBeCloseTo(0.3, 3);
  });
});

describe('가사 전체 밀기', () => {
  const lines: Line[] = [
    { id: 'a', t0: 1, t1: 3, text: '첫 줄', seats: [0] },
    { id: 'b', t0: 4, t1: 6, text: '둘째 줄', seats: [1] },
  ];
  it('모든 줄을 같은 만큼 옮기고 자리 배정은 그대로 둔다', () => {
    const out = shiftLines(lines, 0.5, 10);
    expect(out.map((l) => [l.t0, l.t1, l.seats])).toEqual([
      [1.5, 3.5, [0]],
      [4.5, 6.5, [1]],
    ]);
  });
  it('첫 줄이 0초 앞으로 나가거나 마지막 줄이 끝을 넘지 않는 만큼만 옮긴다', () => {
    expect(shiftLines(lines, -5, 10)[0].t0).toBe(0);
    expect(shiftLines(lines, 50, 10)[1].t0).toBeCloseTo(9.6, 3);
  });
});

describe('긴 곡의 녹음 묶음', () => {
  it('한 번에 부르는 묶음이 너무 길어지면 나눈다', () => {
    const lines: Line[] = Array.from({ length: 60 }, (_, i) => ({ id: 'l' + i, t0: i * 4, t1: i * 4 + 3.6, text: '줄', seats: [0] }));
    const passes = passesForSeat(lines, 0);
    expect(passes.length).toBeGreaterThan(2);
    for (const p of passes) expect(p.t1 - p.t0).toBeLessThanOrEqual(PASS_MAX);
    expect(passes.reduce((n, p) => n + p.lines.length, 0)).toBe(60);
  });
});

describe('곡 찾기 도우미', () => {
  it('이름 비교: 괄호 설명·기호·띄어쓰기는 무시한다', () => {
    expect(normName('연습용 노래 (Remastered)')).toBe(normName('연습용노래'));
    expect(normName('Practice Song - Live')).toBe('practicesong');
    expect(normName('!!!')).toBe('');
  });

  it('Apple 검색 결과: 노래만, 같은 곡은 한 번만, 그림 주소는 쓰지 않는다', () => {
    const rows = [
      { kind: 'song', trackId: 1, trackName: '연습용 노래', artistName: '떼창방 밴드', collectionName: '1집', trackTimeMillis: 24_000, artworkUrl100: 'https://example.com/a.jpg' },
      { kind: 'song', trackId: 2, trackName: '연습용 노래', artistName: '떼창방 밴드', collectionName: '모음집', trackTimeMillis: 24_400 },
      { kind: 'music-video', trackId: 3, trackName: '연습용 노래', artistName: '떼창방 밴드' },
      { kind: 'song', trackId: 4, trackName: '연습용 노래 (Live)', artistName: '떼창방 밴드', trackTimeMillis: 61_000 },
    ];
    const out = fromItunes(rows);
    expect(out.map((s) => s.itunesId)).toEqual([1, 4]);
    expect(out[0]).toMatchObject({ id: 'it1', title: '연습용 노래', artist: '떼창방 밴드', album: '1집', dur: 24, art: '' });
  });

  it('영상 제목에서 곡 이름을 어림한다', () => {
    expect(guessFromVideoTitle('떼창방 밴드 - 연습용 노래 (Official Audio) [가사]', '떼창방 밴드')).toBe('떼창방 밴드 - 연습용 노래');
    // 음원 영상("가수 - Topic" 채널)은 제목에 곡 이름만 있다
    expect(guessFromVideoTitle('연습용 노래', '떼창방 밴드 - Topic')).toBe('떼창방 밴드 연습용 노래');
    expect(guessFromVideoTitle('[MV] 연습용 노래 | Official Video 4K', '어느 채널')).toBe('연습용 노래');
  });

  it('유튜브에서 찾아볼 검색어와 주소', () => {
    expect(ytQueryFor({ title: '연습용 노래', artist: '떼창방 밴드' })).toBe('떼창방 밴드 연습용 노래 audio');
    expect(ytSearchUrl('떼창방 밴드 연습용 노래')).toMatch(/^https:\/\/www\.youtube\.com\/results\?search_query=%EB%96%BC/);
    expect(ytWatchUrl('ttbDEMO0001', 12.7)).toBe('https://www.youtube.com/watch?v=ttbDEMO0001&t=12s');
  });
});

describe('유튜브 주소에서 영상 번호 뽑기', () => {
  it('여러 모양의 주소를 알아본다', () => {
    const id = 'ttbDEMO0001';
    for (const u of [
      id,
      `https://www.youtube.com/watch?v=${id}`,
      `https://youtu.be/${id}?si=abcdef`,
      `https://m.youtube.com/watch?v=${id}&t=30s`,
      `https://music.youtube.com/watch?v=${id}&feature=share`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}?rel=0`,
      `youtube.com/watch?v=${id}`,
      `이 노래 어때 https://youtu.be/${id} 같이 부르자`,
    ]) {
      expect(parseYtId(u), u).toBe(id);
    }
  });
  it('유튜브가 아니거나 번호가 이상하면 빈 값', () => {
    for (const u of ['', '그냥 글', 'https://example.com/watch?v=ttbDEMO0001', 'https://youtu.be/short', 'https://www.youtube.com/watch?v=tooLongVideoId123']) {
      expect(parseYtId(u), u).toBe('');
    }
  });
});
