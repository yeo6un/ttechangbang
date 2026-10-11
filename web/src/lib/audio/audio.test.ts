import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEncoder } from 'wasm-media-encoders';
import { bestWindow, detectTempo, gateToWindows, normalizeBacking, normalizeVoice, voiceStats } from './analysis';
import { DEMO_BPM, DEMO_DURATION, DEMO_LINES, renderDemoBeat } from './demo';
import { estimateLatency, fft, lowpassDecimate, mixToMono, peak, rms, toDb } from './dsp';
import { findContentStart, LEAD_SEC, withLead } from './marker';
import { encodeMp3With, type Mp3EncoderLike } from './mp3';
import { base64ToBytes, bytesToBase64, computePeaks } from './peaks';
import { decodeWav, encodeWav } from './wav';

const SR = 48000;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x80000000 - 1;
  };
}

/** 사람 목소리 흉내: 음높이가 흔들리는 배음 덩어리 + 숨소리 */
function fakeVoice(n: number, sr: number, seed = 7): Float32Array {
  const r = lcg(seed);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = 180 + 40 * Math.sin(2 * Math.PI * 0.7 * t) + 8 * Math.sin(2 * Math.PI * 5.5 * t);
    phase += (2 * Math.PI * f0) / sr;
    const gate = Math.sin(2 * Math.PI * 0.45 * t) > -0.3 ? 1 : 0.02;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(phase * h) / h;
    out[i] = gate * (0.25 * v + 0.03 * r());
  }
  return out;
}

function delayed(x: Float32Array, samples: number, gain: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = Math.max(0, samples); i < x.length; i++) out[i] = gain * x[i - samples];
  return out;
}

describe('fft', () => {
  it('왕복하면 원래 값으로 돌아온다', () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const r = lcg(1);
    const src = Float64Array.from({ length: n }, () => r());
    re.set(src);
    fft(re, im);
    fft(re, im, true);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] - src[i]), Math.abs(im[i]));
    expect(err).toBeLessThan(1e-9);
  });
  it('사인파의 에너지가 제 주파수 칸에 모인다', () => {
    const n = 2048;
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 64 * i) / n));
    const im = new Float64Array(n);
    fft(re, im);
    const mag = (k: number) => Math.hypot(re[k], im[k]);
    expect(mag(64)).toBeGreaterThan(n / 2 - 1);
    expect(mag(63)).toBeLessThan(1e-6);
  });
});

describe('지연 측정 (재생한 반주가 마이크에 새어 들어온 정도로 재기)', () => {
  const beat = renderDemoBeat(SR);
  const ref = mixToMono([beat.left, beat.right]);
  const noise = lcg(11);
  /** 앞 4초는 조용히 기다리다가(방 잡음만) 그 뒤로 노래하는 상황 */
  const singing = fakeVoice(ref.length, SR).map((v, i) => (i < SR * 4 ? 0 : v) + 0.001 * noise());
  const mic = (delayMs: number, leakDb: number, voice: Float32Array) => {
    const d = Math.round((delayMs / 1000) * SR);
    const sig = delayed(ref, d, Math.pow(10, leakDb / 20));
    for (let i = 0; i < sig.length; i++) sig[i] += voice[i];
    return { sig, trueMs: (d / SR) * 1000 };
  };

  const cases: [string, number, number][] = [
    ['스피커로 틀어 크게 샐 때 (-6dB)', 137.4, -6],
    ['이어폰에서 꽤 샐 때 (-20dB)', 212.0, -20],
    ['이어폰에서 조금 샐 때 (-40dB)', 88.3, -40],
    ['이어폰에서 아주 조금 샐 때 (-50dB)', 164.9, -50],
    ['지연이 거의 없을 때', 9.5, -30],
  ];
  for (const [name, ms, db] of cases) {
    it(`${name}: ${ms}ms 를 ±1ms 안으로 찾는다`, { timeout: 30_000 }, () => {
      const { sig, trueMs } = mic(ms, db, singing);
      const est = estimateLatency(ref, sig, SR);
      expect(est.ok).toBe(true);
      expect(Math.abs(est.delaySec * 1000 - trueMs)).toBeLessThan(1);
      expect(Math.abs(est.gainDb - db)).toBeLessThan(9);
    });
  }

  it('쉬지 않고 노래해도 -20dB 로 새면 찾는다', { timeout: 30_000 }, () => {
    const { sig, trueMs } = mic(121, -20, fakeVoice(ref.length, SR, 5));
    const est = estimateLatency(ref, sig, SR);
    expect(est.ok).toBe(true);
    expect(Math.abs(est.delaySec * 1000 - trueMs)).toBeLessThan(1);
  });

  it('새는 소리가 없으면 못 믿겠다고 답한다', { timeout: 30_000 }, () => {
    expect(estimateLatency(ref, singing, SR).ok).toBe(false);
    expect(estimateLatency(ref, fakeVoice(ref.length, SR, 9), SR).ok).toBe(false);
    expect(estimateLatency(ref, new Float32Array(ref.length), SR).ok).toBe(false);
  });

  it('44.1kHz 에서도 맞는다', { timeout: 30_000 }, () => {
    const b = renderDemoBeat(44100);
    const r = mixToMono([b.left, b.right]);
    const d = Math.round(0.1731 * 44100);
    const v = fakeVoice(r.length, 44100, 3).map((x, i) => (i < 44100 * 4 ? 0 : x));
    const sig = delayed(r, d, 0.02);
    for (let i = 0; i < sig.length; i++) sig[i] += v[i];
    const est = estimateLatency(r, sig, 44100);
    expect(est.ok).toBe(true);
    expect(Math.abs(est.delaySec - d / 44100) * 1000).toBeLessThan(1);
  });
});

describe('싱크 마커', () => {
  it('마커를 붙이면 내용이 정확히 LEAD_SEC 뒤에서 시작한다', () => {
    const x = fakeVoice(SR, SR);
    const [y] = withLead([x], SR);
    const r = findContentStart(y, SR);
    expect(r.found).toBe(true);
    expect(r.index).toBe(Math.round(LEAD_SEC * SR));
  });

  it('마커가 없으면 규격 위치를 돌려준다', () => {
    const r = findContentStart(fakeVoice(SR, SR), SR);
    expect(r.found).toBe(false);
  });

  for (const sr of [48000, 44100]) {
    it(`MP3 로 줄였다 풀어도 ${sr}Hz 에서 2샘플 안으로 제자리를 찾는다`, async () => {
      const wasm = fs.readFileSync(path.resolve(__dirname, '../../../public/vendor/mp3.wasm'));
      const encoder = (await createEncoder('audio/mpeg', wasm)) as unknown as Mp3EncoderLike;
      const beat = renderDemoBeat(sr);
      const content = [beat.left.subarray(0, sr * 6), beat.right.subarray(0, sr * 6)];
      const bytes = encodeMp3With(encoder, withLead(content, sr), sr, 4);
      expect(bytes.length).toBeGreaterThan(20_000);
      expect(bytes.length).toBeLessThan(200_000);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttb-mp3-'));
      const mp3 = path.join(dir, 'a.mp3');
      const wav = path.join(dir, 'a.wav');
      fs.writeFileSync(mp3, bytes);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp3, '-ac', '2', '-ar', String(sr), '-c:a', 'pcm_s16le', wav]);
      const dec = decodeWav(new Uint8Array(fs.readFileSync(wav)));
      fs.rmSync(dir, { recursive: true });
      const mono = mixToMono(dec.channels);
      const start = findContentStart(mono, sr);
      expect(start.found).toBe(true);
      // 찾은 위치부터의 소리가 원본과 몇 샘플 어긋나는지: 좌우로 밀어 보며 가장 잘 맞는 자리를 찾는다
      const orig = mixToMono(content);
      const len = sr * 2;
      let bestLag = 0;
      let bestDot = -Infinity;
      for (let lag = -60; lag <= 60; lag++) {
        let dot = 0;
        for (let i = sr; i < sr + len; i += 3) dot += orig[i] * (mono[start.index + i + lag] || 0);
        if (dot > bestDot) {
          bestDot = dot;
          bestLag = lag;
        }
      }
      expect(Math.abs(bestLag)).toBeLessThanOrEqual(2);
    });
  }
});

describe('박자·구간 분석', () => {
  const beat = renderDemoBeat(SR);
  const mono = mixToMono([beat.left, beat.right]);

  it('연습용 비트의 BPM 을 찾는다', () => {
    const t = detectTempo(mono, SR);
    expect(Math.abs(t.bpm - DEMO_BPM)).toBeLessThan(1.5);
    expect(t.confidence).toBeGreaterThan(1.5);
    // 첫 박 위치는 박 간격으로 나눈 나머지가 0 근처
    const beatSec = 60 / t.bpm;
    const off = t.beat0 % beatSec;
    expect(Math.min(off, beatSec - off)).toBeLessThan(0.06);
  });

  it('조용한 앞부분을 건너뛰고 소리가 꽉 찬 구간을 고른다', () => {
    const quiet = new Float32Array(SR * 20);
    const loud = fakeVoice(SR * 10, SR);
    const song = new Float32Array(quiet.length + loud.length + quiet.length);
    song.set(loud, quiet.length);
    const start = bestWindow(song, SR, 10);
    expect(start).toBeGreaterThan(18);
    expect(start).toBeLessThan(20.5);
  });

  it('연습용 비트: 길이와 가사 줄 위치가 맞다', () => {
    expect(mono.length).toBe(Math.round(DEMO_DURATION * SR));
    expect(DEMO_LINES).toHaveLength(8);
    expect(DEMO_LINES[7].t1).toBeLessThan(DEMO_DURATION);
    expect(rms(mono)).toBeGreaterThan(0.05);
  });
});

describe('목소리 음량', () => {
  it('작은 목소리를 키우고 큰 목소리는 줄여 비슷하게 맞춘다', () => {
    const quiet = fakeVoice(SR * 3, SR).map((v) => v * 0.05);
    const loud = fakeVoice(SR * 3, SR).map((v) => v * 1.5);
    const g1 = normalizeVoice(quiet, voiceStats(quiet, SR));
    const g2 = normalizeVoice(loud, voiceStats(loud, SR));
    expect(g1).toBeGreaterThan(10);
    expect(g2).toBeLessThan(0);
    const a = voiceStats(quiet, SR).rmsDb;
    const b = voiceStats(loud, SR).rmsDb;
    expect(Math.abs(a - b)).toBeLessThan(4);
    expect(peak(quiet)).toBeLessThanOrEqual(1);
  });

  it('무음은 건드리지 않는다', () => {
    const z = new Float32Array(SR);
    expect(normalizeVoice(z, voiceStats(z, SR))).toBe(0);
  });
});

describe('보조 도구', () => {
  it('WAV 왕복', () => {
    const x = fakeVoice(4000, SR);
    const { channels, sampleRate } = decodeWav(encodeWav([x, x], SR));
    expect(sampleRate).toBe(SR);
    expect(channels).toHaveLength(2);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(channels[1][i] - Math.max(-1, Math.min(1, x[i]))));
    expect(err).toBeLessThan(1 / 16000);
  });
  it('파형 요약과 base64 왕복', () => {
    const x = fakeVoice(SR, SR);
    const p = computePeaks(x, 64);
    expect(p).toHaveLength(64);
    expect(Math.max(...p)).toBeGreaterThan(100);
    expect(Array.from(base64ToBytes(bytesToBase64(p)))).toEqual(Array.from(p));
  });
  it('줄여 뽑기는 높은 소리를 걸러낸다', () => {
    const hi = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 7000 * i) / 48000));
    const lo = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 500 * i) / 48000));
    expect(toDb(rms(lowpassDecimate(hi, 6)))).toBeLessThan(-40);
    expect(toDb(rms(lowpassDecimate(lo, 6)))).toBeGreaterThan(-4);
  });
});

describe('내 줄 밖 소리 지우기', () => {
  it('내 줄 구간(앞뒤 여유 포함)만 남기고 나머지는 조용해진다', () => {
    const x = new Float32Array(SR * 10).fill(0.5);
    gateToWindows(x, SR, 1, [[3, 4], [4.3, 5], [8, 9]]);
    const at = (t: number) => x[Math.round((t - 1) * SR)];
    expect(at(1.5)).toBe(0); // 내 줄 전
    expect(at(2.9)).toBeCloseTo(0.5, 5); // 줄 시작 0.28초 전부터 열려 있다
    expect(at(3.5)).toBeCloseTo(0.5, 5);
    expect(at(4.15)).toBeCloseTo(0.5, 5); // 붙어 있는 두 줄 사이는 끊기지 않는다
    expect(at(5.3)).toBeCloseTo(0.5, 5); // 끝난 뒤 0.42초까지 남긴다
    expect(at(6.5)).toBe(0); // 다른 사람 차례
    expect(at(8.5)).toBeCloseTo(0.5, 5);
    expect(at(9.9)).toBe(0);
    // 여닫는 곳이 뚝 끊기지 않는다
    let maxStep = 0;
    for (let i = 1; i < x.length; i++) maxStep = Math.max(maxStep, Math.abs(x[i] - x[i - 1]));
    expect(maxStep).toBeLessThan(0.001);
  });
});

describe('반주 음량 맞춤', () => {
  it('크게 만들어진 곡은 줄이고, 작은 곡은 키우되 깨지지 않게 한다', () => {
    const loudL = Float32Array.from({ length: SR }, (_, i) => 0.9 * Math.sin((2 * Math.PI * 220 * i) / SR));
    const loudR = loudL.slice();
    const g1 = normalizeBacking([loudL, loudR]);
    expect(g1).toBeLessThan(0.3);
    expect(Math.abs(toDb(rms(loudL)) - -18)).toBeLessThan(0.5);
    expect(loudL[10]).toBe(loudR[10]); // 좌우를 같은 비율로

    const quiet = Float32Array.from({ length: SR }, (_, i) => 0.01 * Math.sin((2 * Math.PI * 220 * i) / SR));
    expect(normalizeBacking([quiet])).toBeGreaterThan(3.9);
    // 순간적으로 튀는 소리가 있으면 그 꼭대기가 넘치지 않는 선까지만 키운다
    const spiky = Float32Array.from({ length: SR }, (_, i) => (i === 100 ? 0.9 : 0.01 * Math.sin(i / 20)));
    normalizeBacking([spiky]);
    expect(peak(spiky)).toBeLessThanOrEqual(0.981);
    expect(normalizeBacking([new Float32Array(100)])).toBe(1);
  });
});

describe('지연 측정: 실제 방에 가까운 조건', () => {
  const beat = renderDemoBeat(SR);
  const ref = mixToMono([beat.left, beat.right]);
  const rnd = lcg(77);
  const voice = fakeVoice(ref.length, SR, 21).map((v, i) => (i < SR * 4 ? 0 : v) + 0.002 * rnd());

  /** 휴대폰 스피커 → 방 → 마이크: 찌그러짐, 좁은 대역, 벽 반사, 기기 간 시계 어긋남을 넣는다 */
  function acousticPath(x: Float32Array, delayMs: number, gainDb: number, driftPpm = 0): Float32Array {
    const d = Math.round((delayMs / 1000) * SR);
    const g = Math.pow(10, gainDb / 20);
    const n = x.length;
    // 1) 작은 스피커의 찌그러짐
    const bent = new Float32Array(n);
    for (let i = 0; i < n; i++) bent[i] = Math.tanh(x[i] * 2.2) / 2.2;
    // 2) 저역이 빠지는 작은 스피커 (1차 고역 필터 400Hz) + 고역이 깎이는 마이크 (1차 저역 필터 5kHz)
    const out = new Float32Array(n);
    const aH = 1 / (1 + (2 * Math.PI * 400) / SR);
    const aL = (2 * Math.PI * 5000) / SR / (1 + (2 * Math.PI * 5000) / SR);
    let hp = 0;
    let px = 0;
    let lp = 0;
    for (let i = 0; i < n; i++) {
      hp = aH * (hp + bent[i] - px);
      px = bent[i];
      lp += aL * (hp - lp);
      out[i] = lp;
    }
    // 3) 직접음 + 벽 반사 몇 개
    const echoes: [number, number][] = [[0, 1], [Math.round(0.0031 * SR), 0.45], [Math.round(0.0074 * SR), -0.3], [Math.round(0.0192 * SR), 0.2], [Math.round(0.041 * SR), 0.12]];
    const room = new Float32Array(n);
    for (const [e, a] of echoes) for (let i = d + e; i < n; i++) room[i] += g * a * out[i - d - e];
    if (!driftPpm) return room;
    // 4) 재생 장치와 녹음 장치의 시계가 조금 다르게 가는 경우
    const ratio = 1 + driftPpm / 1e6;
    const drifted = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio;
      const k = Math.floor(p);
      if (k + 1 >= n) break;
      drifted[i] = room[k] + (room[k + 1] - room[k]) * (p - k);
    }
    return drifted;
  }

  const cases: [string, number, number, number][] = [
    ['스피커로 틀고 부를 때', 183, -8, 0],
    ['이어폰에서 조금 샐 때', 121, -38, 0],
    ['블루투스처럼 지연이 클 때', 347, -30, 0],
    ['두 장치의 시계가 60ppm 어긋날 때', 150, -20, 60],
  ];
  for (const [name, ms, db, drift] of cases) {
    it(`${name}: 직접음 도착 시각(${ms}ms)을 ±3ms 안으로 찾는다`, { timeout: 30_000 }, () => {
      const leak = acousticPath(ref, ms, db, drift);
      const sig = new Float32Array(ref.length);
      for (let i = 0; i < sig.length; i++) sig[i] = leak[i] + voice[i];
      const est = estimateLatency(ref, sig, SR);
      expect(est.ok).toBe(true);
      expect(Math.abs(est.delaySec * 1000 - ms)).toBeLessThan(3);
    });
  }
});
