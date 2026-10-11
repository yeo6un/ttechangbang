// 저장용 소리 파일 만들기/읽기. 항상 [싱크 마커 + 내용] 을 MP3 로 저장한다.
import { mixToMono } from './dsp';
import { findContentStart, LEAD_SEC, withLead } from './marker';

interface Pending {
  resolve: (b: Uint8Array) => void;
  reject: (e: Error) => void;
  onProgress?: (r: number) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./mp3.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; bytes?: Uint8Array; error?: string; progress?: number }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.progress !== undefined) return p.onProgress?.(e.data.progress);
    pending.delete(e.data.id);
    if (e.data.bytes) p.resolve(e.data.bytes);
    else p.reject(new Error(e.data.error || 'MP3 변환에 실패했어요'));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'MP3 변환에 실패했어요'));
    pending.clear();
    worker = null;
  };
  return worker;
}

const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

async function toSupportedRate(channels: Float32Array[], sr: number): Promise<{ channels: Float32Array[]; sr: number }> {
  if (LAME_RATES.includes(sr)) return { channels, sr };
  const target = sr > 48000 ? 48000 : 44100;
  const n = Math.ceil((channels[0].length * target) / sr);
  const off = new OfflineAudioContext(channels.length, n, target);
  const buf = off.createBuffer(channels.length, channels[0].length, sr);
  channels.forEach((c, i) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return { channels: Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i)), sr: target };
}

/** 마커를 붙여 MP3 로 만든다. quality: 0(최고)~9(최소), 반주 4 · 목소리 5 정도. */
export async function encodeWithLead(channels: Float32Array[], sr: number, quality: number, onProgress?: (r: number) => void): Promise<Uint8Array> {
  const fit = await toSupportedRate(channels, sr);
  const withMarker = withLead(fit.channels, fit.sr);
  return encodeRaw(withMarker, fit.sr, quality, onProgress);
}

/** 마커 없이 그대로 MP3 로 (완성본 저장용) */
export async function encodeRaw(channels: Float32Array[], sr: number, quality: number, onProgress?: (r: number) => void): Promise<Uint8Array> {
  const fit = await toSupportedRate(channels, sr);
  const id = ++seq;
  const w = getWorker();
  const copies = fit.channels.map((c) => c.slice());
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage(
      { id, channels: copies, sampleRate: fit.sr, quality, wasmUrl: new URL('/vendor/mp3.wasm', location.origin).href },
      copies.map((c) => c.buffer),
    );
  });
}

/** 서버에서 받은 소리 파일을 풀고, 마커 뒤의 내용만 남긴다. */
export async function decodeWithLead(bytes: ArrayBuffer, ctx: BaseAudioContext): Promise<AudioBuffer> {
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  const chans = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
  const head = Math.min(decoded.length, Math.round(decoded.sampleRate * 0.8));
  const start = findContentStart(mixToMono(chans.map((c) => c.subarray(0, head))), decoded.sampleRate);
  const from = start.found ? start.index : Math.round(LEAD_SEC * decoded.sampleRate);
  const len = Math.max(1, decoded.length - from);
  const out = ctx.createBuffer(decoded.numberOfChannels, len, decoded.sampleRate);
  chans.forEach((c, i) => out.copyToChannel(c.subarray(from) as Float32Array<ArrayBuffer>, i));
  return out;
}

/** 사용자가 고른 음악·영상 파일을 푼다 */
export async function decodeFile(file: Blob, ctx: BaseAudioContext): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer();
  return ctx.decodeAudioData(bytes);
}
