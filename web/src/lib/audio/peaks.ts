// 파형 그림용 요약값. 0~255 로 줄여 base64 문자열로 주고받는다.

export function computePeaks(x: Float32Array, buckets: number, from = 0, to = x.length): Uint8Array {
  const out = new Uint8Array(buckets);
  const span = Math.max(1, to - from);
  for (let b = 0; b < buckets; b++) {
    const s = from + Math.floor((b * span) / buckets);
    const e = Math.max(s + 1, from + Math.floor(((b + 1) * span) / buckets));
    let p = 0;
    for (let i = s; i < e && i < x.length; i++) {
      const v = Math.abs(x[i]);
      if (v > p) p = v;
    }
    // 작은 소리도 보이도록 제곱근 눈금
    out[b] = Math.min(255, Math.round(Math.sqrt(Math.min(1, p)) * 255));
  }
  return out;
}

export function bytesToBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  } catch {
    return new Uint8Array(0);
  }
}
