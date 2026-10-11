// 싱크 마커: 저장하는 모든 소리 파일 앞에 짧은 "삑"(처프)을 붙인다.
// MP3 는 브라우저마다 앞부분에 붙는 지연이 달라서, 풀어낸 뒤 이 삑의 위치를 찾아
// 정확히 그 뒤부터 쓰면 어느 기기에서든 한 샘플 단위로 같은 위치가 된다. (삑은 잘려서 들리지 않는다)

export const LEAD_SEC = 0.12;
const CHIRP_AT = 0.03;
const CHIRP_LEN = 0.02;
const F0 = 2000;
const F1 = 6000;

export function makeChirp(sr: number): Float32Array {
  const n = Math.round(CHIRP_LEN * sr);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const phase = 2 * Math.PI * (F0 * t + ((F1 - F0) / (2 * CHIRP_LEN)) * t * t);
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = 0.6 * win * Math.sin(phase);
  }
  return out;
}

/** 각 채널 앞에 마커 구간(LEAD_SEC)을 붙인다. */
export function withLead(channels: Float32Array[], sr: number): Float32Array[] {
  const lead = Math.round(LEAD_SEC * sr);
  const chirp = makeChirp(sr);
  const at = Math.round(CHIRP_AT * sr);
  return channels.map((ch) => {
    const out = new Float32Array(lead + ch.length);
    out.set(chirp, at);
    out.set(ch, lead);
    return out;
  });
}

export interface LeadResult {
  /** 실제 내용이 시작하는 샘플 위치 */
  index: number;
  found: boolean;
  score: number;
}

/** 풀어낸 소리에서 마커를 찾아 내용 시작 위치를 돌려준다. 못 찾으면 규격상 위치(LEAD_SEC)를 쓴다. */
export function findContentStart(x: Float32Array, sr: number): LeadResult {
  const chirp = makeChirp(sr);
  const L = chirp.length;
  const searchEnd = Math.min(x.length - L, Math.round(0.6 * sr));
  const fallback = { index: Math.min(x.length, Math.round(LEAD_SEC * sr)), found: false, score: 0 };
  if (searchEnd <= 0) return fallback;
  let cEnergy = 0;
  for (let i = 0; i < L; i++) cEnergy += chirp[i] * chirp[i];
  // 구간 에너지를 누적합으로 구한다
  let win = 0;
  for (let i = 0; i < L; i++) win += x[i] * x[i];
  let best = 0;
  let bestScore = 0;
  for (let k = 0; k <= searchEnd; k++) {
    if (win > 1e-9) {
      let dot = 0;
      for (let i = 0; i < L; i++) dot += x[k + i] * chirp[i];
      const score = dot / Math.sqrt(cEnergy * win);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (k < searchEnd) win += x[k + L] * x[k + L] - x[k] * x[k];
  }
  if (bestScore < 0.5) return fallback;
  return { index: best + Math.round((LEAD_SEC - CHIRP_AT) * sr), found: true, score: bestScore };
}
