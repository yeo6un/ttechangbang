// 16비트 WAV 만들기 / 읽기

export function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const nCh = channels.length;
  const n = channels[0].length;
  const bytes = new Uint8Array(44 + n * nCh * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * nCh * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return bytes;
}

export function decodeWav(bytes: Uint8Array): { channels: Float32Array[]; sampleRate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  let nCh = 1;
  let sampleRate = 44100;
  let bits = 16;
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      nCh = v.getUint16(o + 10, true);
      sampleRate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
    } else if (id === 'data') {
      const frames = Math.floor(Math.min(size, bytes.length - o - 8) / (nCh * (bits / 8)));
      const channels = Array.from({ length: nCh }, () => new Float32Array(frames));
      let p = o + 8;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < nCh; c++) {
          channels[c][i] = bits === 16 ? v.getInt16(p, true) / 0x8000 : v.getFloat32(p, true);
          p += bits / 8;
        }
      }
      return { channels, sampleRate };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('WAV 데이터가 없어요');
}
