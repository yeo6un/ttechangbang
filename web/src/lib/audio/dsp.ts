// 순수 신호 처리 함수 모음 (브라우저·Node 어디서나 동작, 테스트 가능)

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** 제자리 radix-2 FFT. 길이는 2의 거듭제곱이어야 한다. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
    const wlRe = Math.cos(ang);
    const wlIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const vRe = re[b] * wRe - im[b] * wIm;
        const vIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
        const nRe = wRe * wlRe - wIm * wlIm;
        wIm = wRe * wlIm + wIm * wlRe;
        wRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 창 씌운 sinc 저역 필터로 걸러서 factor 배 줄인다. */
export function lowpassDecimate(x: Float32Array, factor: number): Float64Array {
  if (factor <= 1) return Float64Array.from(x);
  const half = 6 * factor;
  const taps = 2 * half + 1;
  const h = new Float64Array(taps);
  const fc = 0.45 / factor;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const t = i - half;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  const n = Math.floor(x.length / factor);
  const y = new Float64Array(n);
  for (let m = 0; m < n; m++) {
    const c = m * factor;
    const lo = Math.max(0, c - half);
    const hi = Math.min(x.length - 1, c + half);
    let acc = 0;
    for (let j = lo; j <= hi; j++) acc += x[j] * h[j - c + half];
    y[m] = acc;
  }
  return y;
}

export function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let acc = 0;
  const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) acc += x[i] * x[i];
  return Math.sqrt(acc / n);
}

export function peak(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    if (v > p) p = v;
  }
  return p;
}

export const toDb = (v: number) => 20 * Math.log10(Math.max(v, 1e-9));
export const fromDb = (db: number) => Math.pow(10, db / 20);

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const g = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

export interface DelayEstimate {
  /** sig 가 ref 보다 늦은 시간(초). 음수면 빠름. */
  delaySec: number;
  /** 봉우리 높이 ÷ 주변 잡음. 8 이상이면 믿을 만하다. */
  confidence: number;
  /** ref 가 sig 에 섞여 들어간 크기 (dB, 0 = 같은 크기) */
  gainDb: number;
}

/**
 * 재생한 소리(ref)가 마이크 녹음(sig) 안에 얼마나 늦게 섞여 들어갔는지 찾는다.
 * ref → sig 의 임펄스 응답을 주파수 영역 나눗셈(위너 역필터)으로 구해 가장 큰 봉우리를 고른다.
 * 목소리처럼 ref 와 무관한 소리는 잡음으로 평균돼 사라지므로, 이어폰에서 살짝 새는 소리만으로도 지연을 잴 수 있다.
 */
export function estimateDelay(
  ref: Float32Array,
  sig: Float32Array,
  sr: number,
  opts: { minLagSec?: number; maxLagSec?: number; maxSeconds?: number; whiten?: number } = {},
): DelayEstimate {
  const minLagSec = opts.minLagSec ?? 0;
  const maxLagSec = opts.maxLagSec ?? 0.6;
  const maxN = Math.floor((opts.maxSeconds ?? 40) * sr);
  const n0 = Math.min(ref.length, sig.length, maxN);
  const none: DelayEstimate = { delaySec: 0, confidence: 0, gainDb: -120 };
  if (n0 < sr * 0.5) return none;
  const factor = Math.max(1, Math.round(sr / 8000));
  const dsr = sr / factor;
  const a = lowpassDecimate(ref.subarray(0, n0), factor);
  const b = lowpassDecimate(sig.subarray(0, n0), factor);
  const n = a.length;
  const m = nextPow2(n * 2);
  const aRe = new Float64Array(m);
  const aIm = new Float64Array(m);
  const bRe = new Float64Array(m);
  const bIm = new Float64Array(m);
  // 1차 차분으로 저역 덩어리를 줄여 준다
  for (let i = 1; i < n; i++) {
    aRe[i] = a[i] - a[i - 1];
    bRe[i] = b[i] - b[i - 1];
  }
  fft(aRe, aIm);
  fft(bRe, bIm);
  const loBin = Math.floor((300 / dsr) * m);
  const hiBin = Math.ceil((3600 / dsr) * m);
  let meanPow = 0;
  for (let k = loBin; k <= hiBin; k++) meanPow += aRe[k] * aRe[k] + aIm[k] * aIm[k];
  meanPow /= Math.max(1, hiBin - loBin + 1);
  if (meanPow <= 1e-18) return none;
  // λ 가 작으면 봉우리가 뾰족해지지만 잡음에 약해지고, 크면 그 반대다 (기준 소리의 대역 평균 세기에 대한 배수)
  const lambda = meanPow * (opts.whiten ?? 5);
  let ideal = 0; // 같은 처리를 거친 "지연 0, 크기 1" 응답의 봉우리 높이 (크기 환산용)
  for (let k = 0; k <= m / 2; k++) {
    const inBand = k >= loBin && k <= hiBin;
    const k2 = (m - k) % m;
    if (!inBand) {
      aRe[k] = aIm[k] = 0;
      aRe[k2] = aIm[k2] = 0;
      continue;
    }
    for (const idx of k2 === k ? [k] : [k, k2]) {
      const xr = aRe[idx];
      const xi = aIm[idx];
      const yr = bRe[idx];
      const yi = bIm[idx];
      const d = xr * xr + xi * xi + lambda;
      ideal += (xr * xr + xi * xi) / d;
      // conj(X)·Y / (|X|² + λ)
      aRe[idx] = (xr * yr + xi * yi) / d;
      aIm[idx] = (xr * yi - xi * yr) / d;
    }
  }
  fft(aRe, aIm, true);
  const h = aRe;
  const kMin = Math.round(minLagSec * dsr);
  const kMax = Math.min(Math.round(maxLagSec * dsr), m / 2 - 1);
  const at = (k: number) => h[(k + m) % m];
  let best = kMin;
  let bestAbs = 0;
  for (let k = kMin; k <= kMax; k++) {
    const v = Math.abs(at(k));
    if (v > bestAbs) {
      bestAbs = v;
      best = k;
    }
  }
  const guard = Math.max(3, Math.round(0.004 * dsr));
  let noise = 0;
  let cnt = 0;
  for (let k = kMin; k <= kMax; k++) {
    if (Math.abs(k - best) <= guard) continue;
    noise += at(k) * at(k);
    cnt++;
  }
  const noiseRms = Math.sqrt(noise / Math.max(1, cnt));
  // 포물선 보간으로 한 샘플보다 잘게
  const y0 = Math.abs(at(best - 1));
  const y1 = bestAbs;
  const y2 = Math.abs(at(best + 1));
  const denom = y0 - 2 * y1 + y2;
  const frac = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
  return {
    delaySec: (best + frac) / dsr,
    confidence: noiseRms > 0 ? bestAbs / noiseRms : 0,
    gainDb: ideal > 0 ? toDb(bestAbs / (ideal / m)) : -120,
  };
}

export interface LatencyEstimate extends DelayEstimate {
  /** 믿고 써도 되는지 */
  ok: boolean;
  /** full: 전체로 잼, quiet: 노래하지 않는 조용한 순간만 골라 잼 */
  method: 'full' | 'quiet';
}

/** 이 값 이상이면 측정값을 믿는다 (새는 소리가 전혀 없을 때는 4 안팎이 나온다) */
export const LATENCY_CONFIDENCE = 7.5;

/**
 * 녹음에서 재생 지연을 잰다. 두 가지로 재서 더 뚜렷한 쪽을 고른다.
 *  - 전체: 스피커로 틀었거나 이어폰 소리가 크게 샐 때 잘 맞는다.
 *  - 조용한 순간만: 노래 시작 전·줄 사이처럼 목소리가 없는 순간만 남겨서,
 *    이어폰에서 아주 조금 새는 소리도 목소리에 묻히지 않게 한다.
 */
export function estimateLatency(ref: Float32Array, sig: Float32Array, sr: number, maxLagSec = 0.6): LatencyEstimate {
  const n = Math.min(ref.length, sig.length);
  const full = estimateDelay(ref, sig, sr, { maxLagSec });
  const frame = Math.max(1, Math.round(sr * 0.02));
  const frames = Math.floor(n / frame);
  let best: LatencyEstimate = { ...full, ok: full.confidence >= LATENCY_CONFIDENCE, method: 'full' };
  if (frames >= 50) {
    const level = new Float32Array(frames);
    for (let f = 0; f < frames; f++) level[f] = rms(sig, f * frame, (f + 1) * frame);
    const sorted = Float32Array.from(level).sort();
    const floor = sorted[Math.floor(frames * 0.2)];
    const thresh = Math.max(floor * 3.5, 1e-4);
    const quiet = new Uint8Array(frames);
    let kept = 0;
    for (let f = 0; f < frames; f++) {
      const loudNear = level[f] > thresh || (f > 0 && level[f - 1] > thresh) || (f + 1 < frames && level[f + 1] > thresh);
      if (!loudNear) {
        quiet[f] = 1;
        kept++;
      }
    }
    if (kept >= 50 && kept < frames) {
      const gated = new Float32Array(n);
      for (let f = 0; f < frames; f++) {
        if (!quiet[f]) continue;
        const s = f * frame;
        for (let i = 0; i < frame; i++) gated[s + i] = sig[s + i];
      }
      const q = estimateDelay(ref, gated, sr, { maxLagSec });
      if (q.confidence > best.confidence) {
        best = { ...q, gainDb: q.gainDb - toDb(kept / frames), ok: q.confidence >= LATENCY_CONFIDENCE, method: 'quiet' };
      }
    }
  }
  return best;
}
