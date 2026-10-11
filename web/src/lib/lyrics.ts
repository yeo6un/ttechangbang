// 가사 다루기: 붙여넣은 글 정리, LRC(시간표 달린 가사) 읽기, 줄 타이밍 만들기,
// AI 가 받아쓴 단어 시각과 가사를 맞춰 붙이기(정렬)
import { countSyllables, newLineId, type Line } from './parts';

export interface ParsedLyrics {
  texts: string[];
  /** LRC 형식이면 각 줄의 시작 시각(곡 처음 기준, 초) */
  times: number[] | null;
}

const LRC = /^((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)\s*(.*)$/;

export function parseLyrics(raw: string): ParsedLyrics {
  const texts: string[] = [];
  const times: number[] = [];
  let timed = 0;
  for (const rawLine of raw.replace(/\r/g, '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = LRC.exec(line);
    if (m) {
      const text = m[2].trim().slice(0, 140);
      // 글자가 하나도 없는 줄(빈 줄, 간주 표시 기호만 있는 줄)은 가사가 아니다
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      for (const tm of m[1].matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)) {
        const frac = tm[3] ? Number('0.' + tm[3]) : 0;
        texts.push(text);
        times.push(Number(tm[1]) * 60 + Number(tm[2]) + frac);
        timed++;
      }
      continue;
    }
    // [Verse 1], (후렴) 같은 표시만 있는 줄은 뺀다
    if (/^[\[(（【].{0,24}[\])）】]$/.test(line) || /^\[(ti|ar|al|by|offset|length|re|ve):/i.test(line)) continue;
    texts.push(line.slice(0, 140));
    times.push(NaN);
  }
  if (timed > 0 && timed >= texts.length * 0.8) {
    const order = texts.map((t, i) => ({ t, time: times[i] })).filter((x) => Number.isFinite(x.time)).sort((a, b) => a.time - b.time);
    return { texts: order.map((x) => x.t), times: order.map((x) => x.time) };
  }
  return { texts, times: null };
}

const estDur = (text: string) => Math.max(1.2, countSyllables(text) * 0.34 + 0.6);

/** 줄 시작 시각들로 줄 구간을 만든다. 끝은 다음 줄 시작 직전, 간주가 길면 글자 수로 어림한다. */
export function linesFromStarts(texts: string[], starts: number[], dur: number): Line[] {
  const order = texts.map((text, i) => ({ text, t: starts[i] })).filter((x) => Number.isFinite(x.t) && x.t < dur - 0.2).sort((a, b) => a.t - b.t);
  return order.map((x, i) => {
    const t0 = Math.max(0, x.t);
    const next = i + 1 < order.length ? order[i + 1].t : dur;
    const natural = t0 + estDur(x.text) * 1.6 + 1;
    let t1 = Math.min(next - 0.04, natural, dur);
    if (t1 - t0 < 0.4) t1 = Math.min(dur, t0 + 0.4);
    return { id: newLineId(), t0: round3(t0), t1: round3(t1), text: x.text, seats: [] };
  });
}

/** 타이밍 정보가 없을 때: 글자 수에 비례해 구간 전체에 고르게 펼친다 */
export function evenStarts(texts: string[], dur: number, lead = 0.6, tail = 0.8): number[] {
  const weights = texts.map((t) => estDur(t));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const usable = Math.max(1, dur - lead - tail);
  const out: number[] = [];
  let acc = 0;
  for (const w of weights) {
    out.push(round3(lead + (acc / total) * usable));
    acc += w;
  }
  return out;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** 이미 맞춘 줄들을 통째로 앞뒤로 민다 (가사 전체가 노래보다 빠르거나 느릴 때) */
export function shiftLines(lines: Line[], delta: number, dur: number): Line[] {
  if (!lines.length) return lines;
  // 첫 줄이 0초 앞으로, 마지막 줄이 끝 뒤로 넘어가지 않는 만큼만 민다
  const lo = -Math.min(...lines.map((l) => l.t0));
  const hi = dur - 0.4 - Math.max(...lines.map((l) => l.t0));
  const d = Math.max(lo, Math.min(hi, delta));
  return lines.map((l) => ({ ...l, t0: round3(l.t0 + d), t1: round3(Math.min(dur, Math.max(l.t0 + d + 0.2, l.t1 + d))) }));
}

// ───────────── 찾아온 가사(줄별 시간표 포함) 다루기 ─────────────

export interface SyncLine {
  /** 곡 처음 기준 시작 시각(초) */
  t: number;
  text: string;
  /** 가사 파일에 "여기서 끝난다"는 표시가 있었으면 그 시각 */
  end: number | null;
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** 시간표 달린 가사(LRC)를 줄 목록으로. 글자가 없는 시간표 줄은 "앞 줄이 여기서 끝난다"는 표시로 쓴다. */
export function parseSynced(lrc: string): SyncLine[] {
  const rows: { t: number; text: string }[] = [];
  for (const rawLine of String(lrc || '').replace(/\r/g, '').split('\n')) {
    const m = LRC.exec(rawLine.trim());
    if (!m) continue;
    // 글자마다 시각을 적어 둔 표기(<00:12.34>)는 지운다
    const text = m[2].replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    for (const tm of m[1].matchAll(STAMP)) {
      const frac = tm[3] ? Number('0.' + tm[3]) : 0;
      rows.push({ t: Number(tm[1]) * 60 + Number(tm[2]) + frac, text });
    }
  }
  rows.sort((a, b) => a.t - b.t);
  const out: SyncLine[] = [];
  for (const r of rows) {
    if (/[\p{L}\p{N}]/u.test(r.text)) out.push({ t: r.t, text: r.text, end: null });
    else if (out.length && out[out.length - 1].end === null && r.t > out[out.length - 1].t) out[out.length - 1].end = r.t;
  }
  return out;
}

/** 줄이 끝나는 시각: 끝 표시 · 다음 줄 직전 · 글자 수로 어림한 길이 가운데 가장 이른 것 */
export function syncLineEnd(lines: SyncLine[], i: number): number {
  const l = lines[i];
  const next = i + 1 < lines.length ? lines[i + 1].t - 0.04 : Infinity;
  const natural = l.t + estDur(l.text) * 1.6 + 1;
  return Math.max(l.t + 0.4, Math.min(l.end ?? Infinity, next, natural));
}

/**
 * 부를 구간을 미리 골라 준다: 처음부터 첫 후렴이 끝나는 곳까지(너무 길면 후렴 앞쪽을 줄인다).
 * 후렴은 "가사가 되풀이되는 줄이 이어진 첫 묶음"으로 어림한다. 못 찾으면 앞에서부터 target 초쯤.
 */
export function suggestRange(lines: SyncLine[], target = 70): { a: number; b: number } {
  const n = lines.length;
  if (n === 0) return { a: 0, b: 0 };
  const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const freq = new Map<string, number>();
  for (const l of lines) {
    const k = key(l.text);
    if (k.length >= 2) freq.set(k, (freq.get(k) || 0) + 1);
  }
  const rep = lines.map((l) => (freq.get(key(l.text)) || 0) >= 2);
  let i0 = -1;
  let i1 = -1;
  for (let i = 0; i < n && i0 < 0; i++) {
    if (!rep[i]) continue;
    let j = i;
    while (j + 1 < n && rep[j + 1] && lines[j + 1].t - syncLineEnd(lines, j) < 6) j++;
    if (j > i && syncLineEnd(lines, j) - lines[i].t >= 8) {
      i0 = i;
      i1 = j;
    } else {
      i = j;
    }
  }
  if (i0 >= 0) {
    const end = syncLineEnd(lines, i1);
    let a = i0;
    while (a > 0 && end - lines[a - 1].t <= target + 12) a--;
    // 후렴만 덩그러니 남지 않게, 줄이 너무 적으면 앞쪽을 조금 더 넣는다
    while (a > 0 && i1 - a + 1 < 4) a--;
    return { a, b: i1 };
  }
  let b = 0;
  while (b + 1 < n && syncLineEnd(lines, b + 1) - lines[0].t <= target) b++;
  return { a: 0, b: Math.max(b, Math.min(n - 1, 3)) };
}

export interface RangePick {
  /** 영상(또는 음원) 안에서 구간이 시작하는 위치와 길이(초) */
  start: number;
  dur: number;
  lines: Line[];
}

/**
 * 고른 줄 범위(a~b)를 방에 넣을 구간과 줄로 바꾼다.
 * shift: 가사 시각에 더하는 값(초) — 영상이 음원보다 늦게 시작하면 양수.
 * total: 영상 전체 길이(모르면 0).
 */
export function rangeToLines(sync: SyncLine[], a: number, b: number, shift: number, total = 0, lead = 1, tail = 1.2): RangePick {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(sync.length - 1, Math.max(a, b));
  const start = Math.max(0, sync[lo].t + shift - lead);
  let end = syncLineEnd(sync, hi) + shift + tail;
  if (total > 0) end = Math.min(total, end);
  const dur = Math.max(1, end - start);
  const lines: Line[] = [];
  for (let i = lo; i <= hi; i++) {
    const t0 = Math.max(0, sync[i].t + shift - start);
    if (t0 >= dur - 0.2) break;
    let t1 = Math.min(dur, syncLineEnd(sync, i) + shift - start);
    if (t1 - t0 < 0.4) t1 = Math.min(dur, t0 + 0.4);
    lines.push({ id: newLineId(), t0: round3(t0), t1: round3(t1), text: sync[i].text, seats: [] });
  }
  return { start: round3(start), dur: round3(dur), lines };
}

// ───────────── 받아쓴 단어 ↔ 가사 정렬 ─────────────

export interface TimedWord {
  w: string;
  s: number;
  e: number;
}

/** 한글은 초성·중성·종성으로 풀어 비교한다 (받아쓰기가 조금 틀려도 부분 점수를 주려고) */
function units(text: string): string[] {
  const out: string[] = [];
  for (const ch of text.normalize('NFC').toLowerCase()) {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) {
      const k = c - 0xac00;
      out.push('i' + Math.floor(k / 588), 'm' + Math.floor((k % 588) / 28));
      if (k % 28) out.push('f' + (k % 28));
    } else if (/[a-z0-9]/.test(ch)) {
      out.push(ch);
    }
  }
  return out;
}

export interface AlignResult {
  starts: number[];
  ends: number[];
  /** 가사 글자 가운데 받아쓰기와 맞은 비율 (0~1) */
  confidence: number;
}

export function alignWords(texts: string[], words: TimedWord[], dur: number): AlignResult {
  const A: string[] = [];
  const aLine: number[] = [];
  texts.forEach((t, li) => {
    for (const u of units(t)) {
      A.push(u);
      aLine.push(li);
    }
  });
  const B: string[] = [];
  const bTime: number[] = [];
  const bEnd: number[] = [];
  for (const w of words) {
    const us = units(w.w);
    const span = Math.max(0.01, w.e - w.s);
    us.forEach((u, k) => {
      B.push(u);
      bTime.push(w.s + (span * k) / us.length);
      bEnd.push(w.s + (span * (k + 1)) / us.length);
    });
  }
  const n = A.length;
  const m = B.length;
  const starts = new Array<number>(texts.length).fill(NaN);
  const ends = new Array<number>(texts.length).fill(NaN);
  if (!n || !m) return { starts: evenStarts(texts, dur), ends, confidence: 0 };

  // 전역 정렬(양 끝 건너뛰기는 싸게). score/trace 를 1차원 배열로.
  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  const trace = new Uint8Array((n + 1) * W); // 1=대각, 2=위(가사 글자 건너뜀), 3=왼쪽(받아쓴 글자 건너뜀)
  const GAP_A = -0.6;
  const GAP_B = -0.4;
  for (let i = 1; i <= n; i++) {
    score[i * W] = i * GAP_A;
    trace[i * W] = 2;
  }
  for (let j = 1; j <= m; j++) trace[j] = 3; // 첫 행은 0점: 앞부분 받아쓰기는 공짜로 건너뛴다
  for (let i = 1; i <= n; i++) {
    const row = i * W;
    const up = row - W;
    const a = A[i - 1];
    for (let j = 1; j <= m; j++) {
      const d = score[up + j - 1] + (a === B[j - 1] ? 2 : -1.2);
      const u = score[up + j] + GAP_A;
      const l = score[row + j - 1] + GAP_B;
      if (d >= u && d >= l) {
        score[row + j] = d;
        trace[row + j] = 1;
      } else if (u >= l) {
        score[row + j] = u;
        trace[row + j] = 2;
      } else {
        score[row + j] = l;
        trace[row + j] = 3;
      }
    }
  }
  // 마지막 행에서 가장 좋은 끝점을 고른다 (뒷부분 받아쓰기는 공짜로 버림)
  let j = m;
  let best = -Infinity;
  for (let k = 0; k <= m; k++) {
    if (score[n * W + k] > best) {
      best = score[n * W + k];
      j = k;
    }
  }
  let i = n;
  let matched = 0;
  const firstIdx = new Array<number>(texts.length).fill(-1); // 줄 안에서 처음 맞은 글자의 위치
  const firstTime = new Array<number>(texts.length).fill(NaN);
  const lastEnd = new Array<number>(texts.length).fill(NaN);
  const lineOffset: number[] = [];
  {
    let prev = -1;
    aLine.forEach((li, idx) => {
      if (li !== prev) {
        lineOffset[li] = idx;
        prev = li;
      }
    });
  }
  // 가사 글자 i 가 받아쓴 글자 몇 번과 맞았는지 (-1 = 안 맞음)
  const pair = new Int32Array(n).fill(-1);
  while (i > 0 && j > 0) {
    const t = trace[i * W + j];
    if (t === 1) {
      if (A[i - 1] === B[j - 1]) {
        matched++;
        pair[i - 1] = j - 1;
      }
      i--;
      j--;
    } else if (t === 2) i--;
    else j--;
  }
  // 홀로 우연히 맞은 글자는 버리고, 두 글자 이상 연달아 맞은 곳만 시간 기준으로 삼는다
  for (let k = 0; k < n; k++) {
    if (pair[k] < 0) continue;
    const solid = (k + 1 < n && pair[k + 1] === pair[k] + 1) || (k > 0 && pair[k - 1] === pair[k] - 1);
    if (!solid) continue;
    const li = aLine[k];
    if (firstIdx[li] < 0) {
      firstIdx[li] = k - lineOffset[li];
      firstTime[li] = bTime[pair[k]];
    }
    lastEnd[li] = bEnd[pair[k]];
  }
  const unitsPerLine = texts.map((t) => Math.max(1, units(t).length));
  const secPerUnit = 0.34 / 2.6;
  for (let li = 0; li < texts.length; li++) {
    if (firstIdx[li] >= 0) {
      // 처음 맞은 글자가 줄 중간이면 그만큼 앞으로 당긴다
      starts[li] = Math.max(0, firstTime[li] - firstIdx[li] * secPerUnit);
      ends[li] = lastEnd[li];
    }
  }
  // 못 맞춘 줄은 앞뒤 줄 사이를 글자 수 비율로 나눠 채운다
  let li = 0;
  while (li < texts.length) {
    if (!Number.isNaN(starts[li])) {
      li++;
      continue;
    }
    let hi = li;
    while (hi < texts.length && Number.isNaN(starts[hi])) hi++;
    const left = li > 0 ? (Number.isNaN(ends[li - 1]) ? starts[li - 1] + estDur(texts[li - 1]) : ends[li - 1]) + 0.15 : 0.3;
    const right = hi < texts.length ? starts[hi] - 0.1 : dur - 0.5;
    const w = unitsPerLine.slice(li, hi);
    const total = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let k = li; k < hi; k++) {
      starts[k] = left + ((right - left) * acc) / total;
      acc += w[k - li];
    }
    li = hi;
  }
  // 순서가 뒤집히지 않게 정리
  for (let k = 0; k < texts.length; k++) {
    starts[k] = Math.min(Math.max(0, starts[k]), Math.max(0, dur - 0.3));
    if (k > 0 && starts[k] < starts[k - 1] + 0.2) starts[k] = Math.min(dur - 0.2, starts[k - 1] + 0.2);
    starts[k] = round3(starts[k]);
  }
  return { starts, ends, confidence: matched / n };
}

/** 받아쓴 문장 그대로를 가사 줄로 쓴다 (가사를 안 넣었을 때) */
export function linesFromSegments(segments: { s: number; e: number; text: string }[], dur: number): Line[] {
  const out: Line[] = [];
  for (const g of segments) {
    const text = g.text.replace(/[♪♫♬]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!text || g.s >= dur - 0.2) continue;
    // 간주에서 흔히 지어내는 말은 가사가 아니다: (음악), [박수], "시청해 주셔서 감사합니다" 같은 것
    if (/^[\[(（【].*[\])）】]$/.test(text) || /시청해\s*주셔서|구독과\s*좋아요|자막\s*(제공|by)|^MBC\s*뉴스/i.test(text)) continue;
    out.push({ id: newLineId(), t0: round3(Math.max(0, g.s)), t1: round3(Math.min(dur, Math.max(g.e, g.s + 0.4))), text, seats: [] });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}
