// 파트 모델: 가사 줄(Line)을 자리(seat)에 나눠 주고, 자리별로 "한 번에 녹음할 묶음(Pass)"을 만든다.

export interface Line {
  id: string;
  /** 구간 시작 기준 시각(초) */
  t0: number;
  t1: number;
  text: string;
  /** 이 줄을 부르는 자리 번호들. 전원이면 다같이. */
  seats: number[];
}

export interface TakeRange {
  seat: number;
  start: number;
  dur: number;
  offsetMs?: number;
}

export interface Pass {
  index: number;
  lines: Line[];
  t0: number;
  t1: number;
}

/** 줄 사이가 이보다 가까우면 한 번에 이어서 녹음한다 */
export const PASS_GAP = 6;
/** 한 번에 녹음하는 묶음이 이보다 길어지면 나눈다 (틀리면 처음부터 다시 불러야 하니까) */
export const PASS_MAX = 75;

export const SEATS = [
  { name: '빨강', color: '#FF4D5E' },
  { name: '파랑', color: '#3D8BFF' },
  { name: '보라', color: '#A66BFF' },
  { name: '노랑', color: '#FFC93C' },
  { name: '주황', color: '#FF8A3D' },
  { name: '청록', color: '#1FD1C1' },
  { name: '분홍', color: '#FF6FB5' },
  { name: '크림', color: '#EFE6CF' },
] as const;

export const seatColor = (seat: number) => SEATS[((seat % SEATS.length) + SEATS.length) % SEATS.length].color;
export const seatName = (seat: number) => SEATS[((seat % SEATS.length) + SEATS.length) % SEATS.length].name;

let idCounter = 0;
export function newLineId(): string {
  idCounter++;
  return 'l' + Date.now().toString(36).slice(-4) + idCounter.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

export const isAll = (line: Line, seatCount: number) => seatCount > 1 && line.seats.length >= seatCount;

export function linesForSeat(lines: Line[], seat: number): Line[] {
  return lines.filter((l) => l.seats.includes(seat)).sort((a, b) => a.t0 - b.t0);
}

export function passesForSeat(lines: Line[], seat: number): Pass[] {
  const mine = linesForSeat(lines, seat);
  const passes: Pass[] = [];
  for (const line of mine) {
    const last = passes[passes.length - 1];
    if (last && line.t0 - last.t1 < PASS_GAP && line.t1 - last.t0 <= PASS_MAX) {
      last.lines.push(line);
      last.t1 = Math.max(last.t1, line.t1);
    } else {
      passes.push({ index: passes.length, lines: [line], t0: line.t0, t1: line.t1 });
    }
  }
  return passes;
}

export function seatSeconds(lines: Line[], seat: number): number {
  return linesForSeat(lines, seat).reduce((s, l) => s + (l.t1 - l.t0), 0);
}

const TOL = 0.6;
export function lineRecorded(line: Line, seat: number, takes: TakeRange[]): boolean {
  return takes.some((t) => {
    if (t.seat !== seat) return false;
    const s = t.start + (t.offsetMs || 0) / 1000;
    return s <= line.t0 + TOL && s + t.dur >= line.t1 - TOL;
  });
}

export function passRecorded(pass: Pass, seat: number, takes: TakeRange[]): boolean {
  return pass.lines.every((l) => lineRecorded(l, seat, takes));
}

export function seatProgress(lines: Line[], seat: number, takes: TakeRange[]): { total: number; done: number } {
  const passes = passesForSeat(lines, seat);
  return { total: passes.length, done: passes.filter((p) => passRecorded(p, seat, takes)).length };
}

export function roomProgress(lines: Line[], seatCount: number, takes: TakeRange[]): { total: number; done: number; allDone: boolean } {
  let total = 0;
  let done = 0;
  for (let s = 0; s < seatCount; s++) {
    const p = seatProgress(lines, s, takes);
    total += p.total;
    done += p.done;
  }
  return { total, done, allDone: total > 0 && done === total };
}

// ───────────── 자동 배정 ─────────────

export function countSyllables(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[가-힣]|[a-zA-Z]+|\d/g)) {
    const w = m[0];
    if (/[a-zA-Z]/.test(w)) n += Math.max(1, (w.toLowerCase().match(/[aeiouy]+/g) || []).length);
    else n += 1;
  }
  return n;
}

const normKey = (text: string) => text.toLowerCase().replace(/[^가-힣a-z0-9]/g, '');

export type AssignMode = 'smart' | 'roulette';

interface Phrase {
  idx: number[];
  dur: number;
  beforeHook: boolean;
}

function buildPhrases(lines: Line[], hook: boolean[], seatCount: number): Phrase[] {
  const soloTime = lines.reduce((s, l, i) => s + (hook[i] ? 0 : l.t1 - l.t0), 0);
  const soloCount = hook.filter((h) => !h).length;
  // 한 사람이 두 번쯤 차례가 오도록 묶음 길이를 잡되, 줄이 모자라면 한 줄씩 준다
  const target = soloCount <= seatCount * 2 ? 0 : Math.max(2.5, Math.min(7, soloTime / (seatCount * 2)));
  const phrases: Phrase[] = [];
  let cur: Phrase | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (hook[i]) {
      if (cur) {
        cur.beforeHook = true;
        phrases.push(cur);
        cur = null;
      }
      continue;
    }
    const d = lines[i].t1 - lines[i].t0;
    if (!cur) cur = { idx: [], dur: 0, beforeHook: false };
    cur.idx.push(i);
    cur.dur += d;
    const next = lines[i + 1];
    const gap = next ? next.t0 - lines[i].t1 : Infinity;
    // 다음 줄을 붙였을 때 목표 길이를 넘는 쪽이 더 크면 여기서 끊는다 (묶음이 너무 커져 한 사람에게 몰리지 않게)
    const nextHalf = next ? (next.t1 - next.t0) / 2 : 0;
    if (cur.dur + nextHalf > target || cur.idx.length >= 3 || gap > 1.2 || !next || hook[i + 1]) {
      cur.beforeHook = !!next && hook[i + 1];
      phrases.push(cur);
      cur = null;
    }
  }
  if (cur) phrases.push(cur);
  return phrases;
}

function findHooks(lines: Line[], seatCount: number): boolean[] {
  const n = lines.length;
  const hook = new Array<boolean>(n).fill(false);
  if (seatCount < 2) return hook;
  const freq = new Map<string, number>();
  for (const l of lines) {
    const k = normKey(l.text);
    if (k.length >= 2) freq.set(k, (freq.get(k) || 0) + 1);
  }
  let hookTime = 0;
  let total = 0;
  lines.forEach((l, i) => {
    const k = normKey(l.text);
    total += l.t1 - l.t0;
    if (k.length >= 2 && (freq.get(k) || 0) >= 2) {
      hook[i] = true;
      hookTime += l.t1 - l.t0;
    }
  });
  // 반복이 너무 많은 노래는 마지막 반복 묶음만 다같이로 둔다
  if (hookTime > total * 0.6) {
    let i = n - 1;
    while (i >= 0 && !hook[i]) i--;
    let start = i;
    while (start > 0 && hook[start - 1]) start--;
    hook.fill(false);
    for (let k = Math.max(0, start); k <= i; k++) hook[k] = true;
    if (i - start + 1 > n * 0.6) hook.fill(false);
  }
  // 가사에 반복이 없으면 마지막 줄을 다같이로
  if (!hook.some(Boolean) && n >= seatCount + 2) hook[n - 1] = true;
  return hook;
}

/**
 * 줄을 자리에 나눠 준다.
 * smart: 반복되는 줄(후렴)은 다같이, 나머지는 1~3줄씩 묶어 부르는 시간이 고르게 돌아가며 배정.
 * roulette: 같은 묶음을 무작위로.
 */
export function autoAssign(lines: Line[], seatCount: number, mode: AssignMode = 'smart', rand: () => number = Math.random): Line[] {
  const sorted = [...lines].sort((a, b) => a.t0 - b.t0);
  const n = sorted.length;
  const all = Array.from({ length: seatCount }, (_, i) => i);
  if (n === 0) return [];
  if (seatCount <= 1) return sorted.map((l) => ({ ...l, seats: [0] }));
  const hook = findHooks(sorted, seatCount);
  const phrases = buildPhrases(sorted, hook, seatCount);
  const seats: number[][] = sorted.map((_, i) => (hook[i] ? all : []));
  const load = new Array<number>(seatCount).fill(0);
  let last = -1;
  phrases.forEach((ph, pi) => {
    let pick = -1;
    if (mode === 'roulette') {
      const cands = all.filter((s) => s !== last);
      pick = cands[Math.floor(rand() * cands.length)];
    } else {
      let bestLoad = Infinity;
      for (let k = 0; k < seatCount; k++) {
        const s = (k + pi) % seatCount;
        if (s === last) continue;
        if (load[s] < bestLoad - 1e-6) {
          bestLoad = load[s];
          pick = s;
        }
      }
    }
    for (const i of ph.idx) seats[i] = [pick];
    load[pick] += ph.dur;
    last = pick;
    // 후렴 직전 줄은 둘이서 (셋 이상일 때)
    const duet = mode === 'roulette' ? rand() < 0.2 : ph.beforeHook && seatCount >= 3;
    if (duet) {
      const li = ph.idx[ph.idx.length - 1];
      const others = all.filter((s) => s !== pick);
      const second = mode === 'roulette' ? others[Math.floor(rand() * others.length)] : others.reduce((a, b) => (load[b] < load[a] ? b : a));
      seats[li] = [pick, second].sort((a, b) => a - b);
      load[second] += sorted[li].t1 - sorted[li].t0;
    }
  });
  return repair(
    sorted.map((l, i) => ({ ...l, seats: seats[i] })),
    seatCount,
  );
}

/** 빈 줄을 채우고, 한 줄도 못 받은 자리가 없게 고친다 */
export function repair(lines: Line[], seatCount: number): Line[] {
  const out = lines.map((l) => ({ ...l, seats: [...new Set(l.seats.filter((s) => Number.isInteger(s) && s >= 0 && s < seatCount))].sort((a, b) => a - b) }));
  const load = () => {
    const arr = new Array<number>(seatCount).fill(0);
    for (const l of out) for (const s of l.seats) arr[s] += l.t1 - l.t0;
    return arr;
  };
  for (let i = 0; i < out.length; i++) {
    if (out[i].seats.length) continue;
    const ld = load();
    const prev = i > 0 ? out[i - 1].seats : [];
    let pick = 0;
    let best = Infinity;
    for (let s = 0; s < seatCount; s++) {
      const penalty = prev.length === 1 && prev[0] === s && seatCount > 1 ? 1e6 : 0;
      if (ld[s] + penalty < best) {
        best = ld[s] + penalty;
        pick = s;
      }
    }
    out[i].seats = [pick];
  }
  if (out.length >= seatCount) {
    for (let guard = 0; guard < seatCount * 2; guard++) {
      const counts = new Array<number>(seatCount).fill(0);
      for (const l of out) for (const s of l.seats) counts[s]++;
      const empty = counts.findIndex((c) => c === 0);
      if (empty < 0) break;
      // 혼자 부르는 줄이 가장 많은 자리에서 한 줄을 넘겨 받는다
      const solo = new Array<number>(seatCount).fill(0);
      for (const l of out) if (l.seats.length === 1) solo[l.seats[0]]++;
      const rich = solo.indexOf(Math.max(...solo));
      const candidates = out.filter((l) => l.seats.length === 1 && l.seats[0] === rich);
      if (solo[rich] >= 2 && candidates.length) {
        candidates[Math.floor(candidates.length / 2)].seats = [empty];
      } else {
        // 넘겨줄 혼자 줄이 없으면 가장 긴 줄에 함께 들어간다
        const longest = out.reduce((a, b) => (b.t1 - b.t0 > a.t1 - a.t0 ? b : a));
        longest.seats = [...new Set([...longest.seats, empty])].sort((a, b) => a - b);
      }
    }
  }
  return out;
}

/** AI 가 준 배정(줄 id → 자리들)을 적용하고 빈틈을 고친다 */
export function applyAssignment(lines: Line[], assign: Record<string, number[]>, seatCount: number): Line[] {
  return repair(
    [...lines].sort((a, b) => a.t0 - b.t0).map((l) => ({ ...l, seats: Array.isArray(assign[l.id]) ? assign[l.id] : [] })),
    seatCount,
  );
}

/** 가사 없이 진행할 때: 마디(또는 시간) 단위로 빈 구간을 만든다 */
export function blankLines(dur: number, bpm = 0, beat0 = 0): Line[] {
  let step = 5;
  let start = 0.5;
  if (bpm >= 55 && bpm <= 200) {
    const bar = (60 / bpm) * 4;
    let bars = 2;
    while (bar * bars < 3.2) bars *= 2;
    while (bar * bars > 8.5 && bars > 1) bars /= 2;
    step = bar * bars;
    start = beat0 % step;
  }
  const out: Line[] = [];
  for (let t = start, i = 0; t < dur - 1.2; t += step, i++) {
    out.push({ id: newLineId(), t0: Math.round(t * 1000) / 1000, t1: Math.round(Math.min(dur, t + step - 0.15) * 1000) / 1000, text: '', seats: [] });
  }
  if (!out.length) out.push({ id: newLineId(), t0: 0, t1: dur, text: '', seats: [] });
  return out;
}

/** 길이를 말로: 45초, 3분 5초 */
export function fmtSpan(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}초`;
  return s % 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s / 60}분`;
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
