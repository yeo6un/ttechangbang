// 방 상태에서 화면에 쓸 값들을 뽑는다
import type { Room } from './api';
import { passesForSeat, passRecorded, seatProgress, seatSeconds, type Line } from './parts';

const DAY = 86_400_000;

/** 자리별 표시 이름: 지금 앉은 사람 → 없으면 그 자리에 녹음한 사람 */
export function seatNames(room: Room): (string | null)[] {
  return Array.from({ length: room.seatCount }, (_, s) => {
    const m = room.members.find((x) => x.seat === s);
    if (m) return m.name;
    const t = [...room.takes].reverse().find((x) => x.seat === s);
    return t ? t.memberName : null;
  });
}

export interface SeatInfo {
  seat: number;
  name: string | null;
  occupied: boolean;
  mine: boolean;
  lines: Line[];
  seconds: number;
  total: number;
  done: number;
}

export function seatInfos(room: Room): SeatInfo[] {
  const names = seatNames(room);
  return Array.from({ length: room.seatCount }, (_, s) => {
    const p = seatProgress(room.lines, s, room.takes);
    return {
      seat: s,
      name: names[s],
      occupied: room.members.some((m) => m.seat === s),
      mine: room.me?.seat === s,
      lines: room.lines.filter((l) => l.seats.includes(s)),
      seconds: seatSeconds(room.lines, s),
      total: p.total,
      done: p.done,
    };
  });
}

export function nextPassIndex(room: Room, seat: number): number {
  const passes = passesForSeat(room.lines, seat);
  const i = passes.findIndex((p) => !passRecorded(p, seat, room.takes));
  return i < 0 ? 0 : i;
}

export function daysLeft(room: Room): string {
  const ms = room.expiresAt - Date.now();
  if (ms <= 0) return '곧 사라져요';
  if (ms < DAY) return `${Math.max(1, Math.round(ms / 3_600_000))}시간 뒤 사라져요`;
  return `${Math.ceil(ms / DAY)}일 뒤 사라져요`;
}

export interface Award {
  title: string;
  seat: number;
  name: string;
  detail: string;
}

/** 재미로 주는 상. 자리마다 하나씩만. */
export function awards(room: Room): Award[] {
  const names = seatNames(room);
  const seats = new Map<number, { loud: number; n: number; voiced: number; retakes: number; finished: number }>();
  for (const t of room.takes) {
    const s = seats.get(t.seat) || { loud: 0, n: 0, voiced: 0, retakes: 0, finished: 0 };
    s.loud += t.stats.rmsDb;
    s.n++;
    s.voiced += t.stats.voiced;
    s.retakes += t.retakes;
    s.finished = Math.max(s.finished, t.createdAt);
    seats.set(t.seat, s);
  }
  const list = [...seats.entries()].map(([seat, v]) => ({ seat, loud: v.loud / v.n, voiced: v.voiced, retakes: v.retakes, finished: v.finished }));
  if (list.length < 2) return [];
  const out: Award[] = [];
  const used = new Set<number>();
  const give = (title: string, pick: (typeof list)[number] | undefined, detail: string) => {
    if (!pick || used.has(pick.seat)) return;
    used.add(pick.seat);
    out.push({ title, seat: pick.seat, name: names[pick.seat] || '이름 없음', detail });
  };
  const by = (f: (x: (typeof list)[number]) => number) => [...list].sort((a, b) => f(b) - f(a));
  give('목청왕', by((x) => x.loud)[0], '마이크에 가장 크게 불렀어요');
  const retake = by((x) => x.retakes)[0];
  if (retake && retake.retakes > 0) give('재도전상', retake, `마음에 들 때까지 ${retake.retakes}번 다시 불렀어요`);
  give('분량왕', by((x) => x.voiced).find((x) => !used.has(x.seat)), '가장 오래 소리를 냈어요');
  give('일등 출석상', by((x) => -x.finished).find((x) => !used.has(x.seat)), '제일 먼저 녹음을 끝냈어요');
  if (list.length >= 4) give('속삭임상', by((x) => -x.loud).find((x) => !used.has(x.seat)), '가장 조심스럽게 불렀어요');
  return out;
}
