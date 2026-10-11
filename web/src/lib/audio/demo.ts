// 연습용 비트: 파일이 없어도 바로 해볼 수 있게 코드로 직접 만드는 짧은 반주.
// 순수 계산이라 테스트에서도 그대로 쓴다. (가사·멜로디 모두 이 앱을 위해 새로 지은 것)

export const DEMO_BPM = 92;
const BEAT = 60 / DEMO_BPM;
const BAR = BEAT * 4;
const INTRO_BARS = 1;
const SONG_BARS = 8;
export const DEMO_DURATION = (INTRO_BARS + SONG_BARS) * BAR + 0.6;

export const DEMO_LINES: { t0: number; t1: number; text: string }[] = [
  '하나 둘 셋 시작해',
  '목소리를 겹쳐 봐',
  '틀려도 그냥 웃어',
  '박자는 대충 가도',
  '여기는 내가 할게',
  '다음은 네가 받아',
  '다 같이 크게 질러 봐',
  '떼창방에서 만나',
].map((text, i) => {
  const t0 = (INTRO_BARS + i) * BAR;
  return { t0: Math.round(t0 * 1000) / 1000, t1: Math.round((t0 + BAR - 0.18) * 1000) / 1000, text };
});

const midi = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

const CHORDS = [
  [60, 64, 67],
  [59, 62, 67],
  [60, 64, 69],
  [60, 65, 69],
  [60, 64, 67],
  [59, 62, 67],
  [60, 65, 69],
  [60, 64, 67],
];
const BASS = [36, 31, 33, 29, 36, 31, 29, 36];
const MELODY = [
  [64, 64, 67, 67, 69, 69, 67, 0],
  [62, 62, 67, 67, 71, 71, 67, 0],
  [64, 64, 69, 69, 72, 72, 69, 0],
  [65, 65, 69, 69, 72, 69, 65, 0],
  [67, 67, 72, 72, 76, 76, 72, 0],
  [67, 67, 71, 71, 74, 74, 71, 0],
  [65, 69, 72, 77, 76, 72, 69, 65],
  [72, 72, 72, 72, 72, 76, 72, 0],
];

export function renderDemoBeat(sr: number): { left: Float32Array; right: Float32Array } {
  const n = Math.round(DEMO_DURATION * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let seed = 20261011;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x80000000 - 1;
  };
  const add = (t: number, len: number, fn: (i: number, tt: number) => [number, number]) => {
    const s = Math.round(t * sr);
    const m = Math.round(len * sr);
    for (let i = 0; i < m && s + i < n; i++) {
      if (s + i < 0) continue;
      const [l, r] = fn(i, i / sr);
      L[s + i] += l;
      R[s + i] += r;
    }
  };
  const kick = (t: number, g = 1) =>
    add(t, 0.3, (_i, tt) => {
      // 주파수가 136Hz 에서 46Hz 로 빠르게 떨어지는 사인파
      const v = g * 0.95 * Math.exp(-tt * 9) * Math.sin(2 * Math.PI * (46 * tt + (90 / 28) * (1 - Math.exp(-tt * 28))));
      return [v, v];
    });
  const snare = (t: number, g = 1) => {
    let lp = 0;
    add(t, 0.2, (_i, tt) => {
      const w = rand();
      lp += 0.35 * (w - lp);
      const noise = (w - lp) * Math.exp(-tt * 22);
      const tone = Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt * 30);
      const v = g * (0.5 * noise + 0.35 * tone);
      return [v, v];
    });
  };
  const hat = (t: number, g = 1, open = false) => {
    let prev = 0;
    add(t, open ? 0.16 : 0.05, (_i, tt) => {
      const w = rand();
      const hp = w - prev;
      prev = w;
      const v = g * 0.16 * hp * Math.exp(-tt * (open ? 16 : 70));
      return [v * 0.8, v * 1.1];
    });
  };
  const rim = (t: number) =>
    add(t, 0.06, (_i, tt) => {
      const v = 0.5 * Math.exp(-tt * 90) * (Math.sin(2 * Math.PI * 1700 * tt) + 0.5 * Math.sin(2 * Math.PI * 830 * tt));
      return [v, v];
    });
  const bass = (t: number, len: number, m: number) => {
    const f = midi(m);
    let lp = 0;
    add(t, len, (_i, tt) => {
      let saw = 0;
      for (let h = 1; h <= 6; h++) saw += Math.sin(2 * Math.PI * f * h * tt) / h;
      lp += 0.12 * (saw - lp);
      const env = Math.min(1, tt * 200) * Math.exp(-tt * 3.5) * Math.min(1, (len - tt) * 60);
      const v = 0.34 * env * lp;
      return [v, v];
    });
  };
  const pad = (t: number, len: number, notes: number[]) =>
    add(t, len, (_i, tt) => {
      const env = Math.min(1, tt * 6) * Math.min(1, (len - tt) * 5);
      let l = 0;
      let r = 0;
      for (const m of notes) {
        const f = midi(m);
        l += Math.sin(2 * Math.PI * f * 0.997 * tt) + 0.3 * Math.sin(2 * Math.PI * f * 2 * tt);
        r += Math.sin(2 * Math.PI * f * 1.003 * tt) + 0.3 * Math.sin(2 * Math.PI * f * 2.004 * tt);
      }
      const trem = 0.8 + 0.2 * Math.sin(2 * Math.PI * (1 / BEAT) * tt);
      return [0.05 * env * trem * l, 0.05 * env * trem * r];
    });
  const lead = (t: number, len: number, m: number) => {
    const f = midi(m);
    add(t, len, (_i, tt) => {
      const env = Math.min(1, tt * 120) * Math.exp(-tt * 5) * Math.min(1, (len - tt) * 80);
      const v = 0.15 * env * (Math.sin(2 * Math.PI * f * tt) + 0.35 * Math.sin(2 * Math.PI * f * 2 * tt) + 0.12 * Math.sin(2 * Math.PI * f * 3 * tt));
      return [v * 1.05, v * 0.95];
    });
  };

  // 도입 한 마디: 박자 세는 소리
  for (let b = 0; b < 4; b++) {
    rim(b * BEAT);
    hat(b * BEAT + BEAT / 2, 0.7);
  }
  kick(3.5 * BEAT, 0.7);

  for (let bar = 0; bar < SONG_BARS; bar++) {
    const t = (INTRO_BARS + bar) * BAR;
    kick(t);
    kick(t + 2 * BEAT);
    if (bar % 2 === 1) kick(t + 2.5 * BEAT, 0.8);
    snare(t + BEAT);
    snare(t + 3 * BEAT);
    for (let e = 0; e < 8; e++) hat(t + (e * BEAT) / 2, e % 2 ? 1 : 0.6, e === 7 && bar % 4 === 3);
    pad(t, BAR, CHORDS[bar]);
    for (let e = 0; e < 8; e++) {
      if (e === 3 || e === 6) continue;
      bass(t + (e * BEAT) / 2, BEAT / 2 - 0.01, BASS[bar] + (e === 7 ? 12 : 0));
    }
    MELODY[bar].forEach((m, e) => m && lead(t + (e * BEAT) / 2, BEAT / 2 - 0.02, m));
  }
  // 마지막 한 방
  const end = (INTRO_BARS + SONG_BARS) * BAR;
  kick(end);
  pad(end, 0.55, CHORDS[0]);

  let p = 0;
  for (let i = 0; i < n; i++) {
    L[i] = Math.tanh(L[i] * 1.3);
    R[i] = Math.tanh(R[i] * 1.3);
    p = Math.max(p, Math.abs(L[i]), Math.abs(R[i]));
  }
  const g = p > 0 ? 0.85 / p : 1;
  for (let i = 0; i < n; i++) {
    L[i] *= g;
    R[i] *= g;
  }
  return { left: L, right: R };
}
