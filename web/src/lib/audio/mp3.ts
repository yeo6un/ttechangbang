// MP3 로 줄이기 (LAME 을 WebAssembly 로 돌린다). 인코더 객체만 넘겨받는 순수 함수라 워커·테스트 양쪽에서 쓴다.

export interface Mp3EncoderLike {
  configure(params: { sampleRate: number; channels: 1 | 2; vbrQuality?: number; bitrate?: number }): void;
  encode(samples: readonly Float32Array[]): Uint8Array;
  finalize(): Uint8Array;
}

export function encodeMp3With(
  encoder: Mp3EncoderLike,
  channels: Float32Array[],
  sampleRate: number,
  vbrQuality: number,
  onProgress?: (ratio: number) => void,
): Uint8Array {
  const chs = channels.slice(0, 2);
  encoder.configure({ sampleRate, channels: chs.length as 1 | 2, vbrQuality });
  const n = chs[0].length;
  const STEP = 1152 * 64;
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let off = 0; off < n; off += STEP) {
    const out = encoder.encode(chs.map((c) => c.subarray(off, Math.min(n, off + STEP))));
    if (out.length) {
      parts.push(out.slice());
      total += out.length;
    }
    onProgress?.(Math.min(1, (off + STEP) / n));
  }
  const fin = encoder.finalize();
  if (fin.length) {
    parts.push(fin.slice());
    total += fin.length;
  }
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return bytes;
}
