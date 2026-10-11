// 마이크 녹음. AudioWorklet 으로 가공 전 원음을 받고, 각 조각이 컨텍스트 시계로 언제 들어왔는지 함께 기록한다.
// (재생과 같은 시계를 쓰기 때문에 반주 위치와 정확히 맞춰 붙일 수 있다)

const WORKLET = `
class TtbRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.first = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.n = 0; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.n > 0) {
      const out = this.buf.slice(0, this.n);
      this.port.postMessage({ frame: this.first, data: out }, [out.buffer]);
      this.n = 0;
    }
  }
  process(inputs) {
    if (!this.on) return true;
    const input = inputs[0];
    const len = (input && input[0] && input[0].length) || 128;
    if (this.n === 0) this.first = currentFrame;
    if (input && input.length > 0 && input[0]) {
      const chs = input.length;
      for (let i = 0; i < input[0].length; i++) {
        let v = 0;
        for (let c = 0; c < chs; c++) v += input[c][i];
        this.buf[this.n + i] = v / chs;
      }
    } else {
      this.buf.fill(0, this.n, this.n + len);
    }
    this.n += len;
    if (this.n + len > this.buf.length) this.flush();
    return true;
  }
}
registerProcessor('ttb-recorder', TtbRecorder);
`;

const loaded = new WeakSet<BaseAudioContext>();

async function ensureWorklet(ctx: AudioContext): Promise<void> {
  if (loaded.has(ctx)) return;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
    loaded.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface MicOptions {
  deviceId?: string;
  /** 이어폰 없이 스피커로 들으며 녹음할 때: 반주가 같이 녹음되지 않게 울림 제거를 켠다 */
  echoCancel: boolean;
}

export interface Capture {
  samples: Float32Array;
  /** samples[0] 이 들어온 컨텍스트 프레임 번호 */
  firstFrame: number;
  sampleRate: number;
}

interface TestHooks {
  micFactory?: (ctx: AudioContext) => MediaStream | Promise<MediaStream>;
}

export class MicError extends Error {
  constructor(
    public kind: 'denied' | 'missing' | 'busy' | 'unsupported' | 'other',
    message: string,
  ) {
    super(message);
  }
}

export class Mic {
  private chunks: { frame: number; data: Float32Array }[] = [];
  private stopResolve: (() => void) | null = null;
  private levelBuf: Float32Array<ArrayBuffer>;

  private constructor(
    readonly ctx: AudioContext,
    readonly stream: MediaStream,
    private source: MediaStreamAudioSourceNode,
    private node: AudioWorkletNode,
    private analyser: AnalyserNode,
    private sink: GainNode,
    readonly echoCancel: boolean,
  ) {
    this.levelBuf = new Float32Array(analyser.fftSize);
    node.port.onmessage = (e: MessageEvent<{ frame?: number; data?: Float32Array; done?: boolean }>) => {
      if (e.data.done) {
        this.stopResolve?.();
        this.stopResolve = null;
      } else if (e.data.data) {
        this.chunks.push({ frame: e.data.frame!, data: e.data.data });
      }
    };
  }

  /**
   * 마이크를 연다. 컨텍스트는 마이크 권한을 받은 "뒤에" 만들도록 함수로 받는다
   * (아이폰은 마이크가 켜지면 소리 경로가 바뀌어서, 그 뒤에 만든 컨텍스트가 안정적이다).
   */
  static async open(getContext: () => Promise<AudioContext>, opts: MicOptions): Promise<Mic> {
    const hooks = (window as unknown as { __ttbTest?: TestHooks }).__ttbTest;
    let stream: MediaStream;
    let ctx: AudioContext | null = null;
    if (hooks?.micFactory) {
      ctx = await getContext();
      stream = await hooks.micFactory(ctx);
    } else {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new MicError('unsupported', '이 브라우저에서는 마이크를 쓸 수 없어요. 크롬이나 사파리로 열어 주세요.');
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
            echoCancellation: opts.echoCancel,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
          },
          video: false,
        });
      } catch (e) {
        const name = (e as DOMException)?.name || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          throw new MicError('denied', '마이크 권한이 꺼져 있어요. 주소창 옆 자물쇠(또는 설정)에서 마이크를 허용한 뒤 다시 눌러 주세요.');
        }
        if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new MicError('missing', '마이크를 찾지 못했어요. 이어폰 마이크가 제대로 꽂혔는지 확인해 주세요.');
        if (name === 'NotReadableError' || name === 'AbortError') throw new MicError('busy', '다른 앱이 마이크를 쓰고 있어요. 통화나 녹음 앱을 닫고 다시 해 주세요.');
        throw new MicError('other', '마이크를 켜지 못했어요. 페이지를 새로 고친 뒤 다시 해 주세요.');
      }
    }
    try {
      ctx ??= await getContext();
      await ensureWorklet(ctx);
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      throw new MicError('unsupported', '이 브라우저에서는 녹음을 시작하지 못했어요. 크롬이나 사파리 최신 버전으로 열어 주세요.');
    }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'ttb-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const sink = ctx.createGain();
    sink.gain.value = 0; // 내 목소리가 이어폰으로 되돌아 나오지 않게 소리는 버린다 (노드만 살려 둠)
    source.connect(node);
    source.connect(analyser);
    node.connect(sink).connect(ctx.destination);
    return new Mic(ctx, stream, source, node, analyser, sink, opts.echoCancel);
  }

  /** 브라우저가 알려 주는 마이크 쪽 지연(초). 모르면 0. */
  get inputLatency(): number {
    try {
      const s = this.stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number };
      return Number.isFinite(s?.latency) ? Math.min(0.5, Math.max(0, s.latency!)) : 0;
    } catch {
      return 0;
    }
  }

  get label(): string {
    return this.stream.getAudioTracks()[0]?.label || '';
  }

  /** 지금 들어오는 소리 크기 0~1 */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let acc = 0;
    for (let i = 0; i < this.levelBuf.length; i++) acc += this.levelBuf[i] * this.levelBuf[i];
    const rmsV = Math.sqrt(acc / this.levelBuf.length);
    // -60dB~-6dB 를 0~1 로
    const db = 20 * Math.log10(Math.max(rmsV, 1e-6));
    return Math.max(0, Math.min(1, (db + 60) / 54));
  }

  start(): void {
    this.chunks = [];
    this.node.port.postMessage('start');
  }

  async stop(): Promise<Capture> {
    await new Promise<void>((resolve) => {
      this.stopResolve = resolve;
      this.node.port.postMessage('stop');
      setTimeout(resolve, 600);
    });
    const sr = this.ctx.sampleRate;
    if (!this.chunks.length) return { samples: new Float32Array(0), firstFrame: 0, sampleRate: sr };
    const first = this.chunks[0].frame;
    const last = this.chunks[this.chunks.length - 1];
    const total = last.frame - first + last.data.length;
    const samples = new Float32Array(total);
    // 프레임 번호대로 제자리에 넣는다 (중간에 끊긴 조각이 있어도 뒤가 밀리지 않는다)
    for (const c of this.chunks) samples.set(c.data, c.frame - first);
    this.chunks = [];
    return { samples, firstFrame: first, sampleRate: sr };
  }

  close(): void {
    try {
      this.source.disconnect();
      this.node.disconnect();
      this.sink.disconnect();
      this.analyser.disconnect();
    } catch {
      /* 이미 끊김 */
    }
    for (const t of this.stream.getTracks()) t.stop();
  }
}

export async function listMics(): Promise<{ deviceId: string; label: string }[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `마이크 ${i + 1}` }));
  } catch {
    return [];
  }
}
