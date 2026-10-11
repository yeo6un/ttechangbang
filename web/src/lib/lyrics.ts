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
      const text = m[2].trim();
      if (!text) continue;
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
