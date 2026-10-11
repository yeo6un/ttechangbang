// 화면이 멈추지 않도록 MP3 변환은 별도 스레드에서 한다.
import { createEncoder } from 'wasm-media-encoders';
import { encodeMp3With, type Mp3EncoderLike } from './mp3';

interface Job {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  quality: number;
  wasmUrl: string;
}

let encoderPromise: Promise<Mp3EncoderLike> | null = null;
const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer);

self.onmessage = async (e: MessageEvent<Job>) => {
  const job = e.data;
  try {
    encoderPromise ??= createEncoder('audio/mpeg', job.wasmUrl) as unknown as Promise<Mp3EncoderLike>;
    const encoder = await encoderPromise;
    let last = 0;
    const bytes = encodeMp3With(encoder, job.channels, job.sampleRate, job.quality, (r) => {
      if (r - last >= 0.05 || r === 1) {
        last = r;
        post({ id: job.id, progress: r });
      }
    });
    post({ id: job.id, bytes }, [bytes.buffer]);
  } catch (err) {
    encoderPromise = null;
    post({ id: job.id, error: String((err as Error)?.message || err) });
  }
};
