// 방 만들기(MR 파일 + 원곡 영상): 영상과 MR을 같이 틀어 보며 둘이 어긋난 만큼을 맞춘다.
// 영상의 소리는 우리가 들여다볼 수 없어서 자동으로는 못 맞춘다. 대신 귀로 확인한다:
// 두 소리가 한 소리처럼 겹쳐 들리면 맞은 것이고, 메아리처럼 두 번 들리면 어긋난 것이다.
import { useEffect, useRef, useState } from 'react';
import { getCtx } from '../../lib/audio/context';
import type { PlayTake } from '../../lib/audio/transport';
import { YtDeck } from '../../lib/yt/deck';
import type { YtPlayer } from '../../lib/yt/player';
import { Icon, Toggle, useToast } from '../../ui';

interface Props {
  player: YtPlayer | null;
  /** MR 파일 전체 */
  mr: AudioBuffer;
  /** 영상에서 고른 구간 */
  seg: { start: number; dur: number };
  /** 영상 시각 − MR 시각 (초). 클수록 MR이 늦게 나온다. */
  offset: number;
  /** 처음에 어림한 값 (얼마나 옮겼는지 보여 주려고) */
  base: number;
  loose: boolean;
  onOffset: (g: number) => void;
  onLoose: (v: boolean) => void;
  /** 브라우저가 막아서 영상을 직접 눌러 줘야 하는지 */
  onTap: (on: boolean) => void;
  onConfirm: () => void;
}

const STEPS: [number, string][] = [
  [-0.5, '−0.5'],
  [-0.05, '−0.05'],
  [-0.01, '−0.01'],
  [0.01, '+0.01'],
  [0.05, '+0.05'],
  [0.5, '+0.5'],
];

const fmtMove = (d: number) => (Math.abs(d) < 0.005 ? '그대로' : `${Math.abs(d).toFixed(2)}초 ${d > 0 ? '늦춤' : '당김'}`);

export function AlignStep({ player, mr, seg, offset, base, loose, onOffset, onLoose, onTap, onConfirm }: Props) {
  const toast = useToast();
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [vol, setVol] = useState(0.5);
  const deckRef = useRef<YtDeck | null>(null);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const volRef = useRef(vol);
  volRef.current = vol;

  // MR 파일 전체를 "영상에 맞춰 까는 소리"로 넘긴다. 구간 0초(영상 seg.start)에 MR의 (seg.start − offset)초가 나와야 한다.
  const mrTake = (g: number): PlayTake => ({ id: 'mr', seat: 0, buffer: mr, start: g - seg.start, gain: 1 });

  const dispose = () => {
    deckRef.current?.dispose();
    deckRef.current = null;
    setPlaying(false);
    setWaiting(false);
    onTap(false);
  };
  useEffect(() => dispose, [player, mr, seg.start, seg.dur]); // eslint-disable-line react-hooks/exhaustive-deps

  // 옮기는 즉시 들리게 한다
  useEffect(() => {
    deckRef.current?.setTakes([mrTake(offset)]);
  }, [offset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    deckRef.current?.setMix({ backing: 0.8, seats: { 0: vol }, echo: 0 });
  }, [vol]);

  const deck = (): YtDeck | null => {
    if (!player) return null;
    const ctx = getCtx();
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    if (!deckRef.current || deckRef.current.ctx !== ctx) {
      deckRef.current?.dispose();
      const d = new YtDeck(ctx, player, seg);
      d.setMix({ backing: 0.8, seats: { 0: volRef.current }, echo: 0 });
      d.on((e) => {
        if (e.type === 'needTap') onTap(e.on);
        else if (e.type === 'ready') setWaiting(false);
        else if (e.type === 'paused') setPlaying(false);
        else if (e.type === 'failed') {
          setPlaying(false);
          setWaiting(false);
          toast(e.error.message, 'error');
        }
      });
      deckRef.current = d;
    }
    return deckRef.current;
  };

  const play = (from?: number) => {
    const d = deck();
    if (!d) return toast('영상을 불러오는 중이에요. 잠시 뒤에 다시 눌러 주세요.', 'error');
    d.setTakes([mrTake(offsetRef.current)]);
    const pos = from ?? (d.rawPosition() >= seg.dur - 0.5 ? 0 : d.rawPosition());
    setPlaying(true);
    setWaiting(true);
    // 영상이 실제로 돌기 시작해야 끝나는 약속. 실패는 위의 알림에서 처리한다.
    d.play(pos, { until: seg.dur, onEnd: () => setPlaying(false) }).catch(() => {});
  };

  const pause = () => {
    deckRef.current?.pause();
    setPlaying(false);
    setWaiting(false);
  };

  const move = (d: number) => onOffset(Math.round((offset + d) * 1000) / 1000);

  return (
    <section className="stack range align">
      <h1 className="title">원곡과 MR을 맞춰요</h1>
      <p className="lead">원곡 영상과 MR을 같이 틀어 볼게요. 두 소리가 한 소리처럼 겹쳐 들리면 맞는 거예요.</p>

      <div className="align-play">
        <button className="btn btn-primary" onClick={() => (playing ? pause() : play())} disabled={!player}>
          <Icon name={playing ? 'pause' : 'play'} size={18} />
          {playing ? (waiting ? '영상을 준비하는 중…' : '멈추기') : '같이 들어 보기'}
        </button>
        <button className="btn btn-ghost" onClick={() => play(0)} disabled={!player}>
          처음부터
        </button>
      </div>

      <div className="card sync-card">
        <div className="sync-head">
          <strong>MR 타이밍</strong>
          <output id="mr-shift">{fmtMove(offset - base)}</output>
        </div>
        <div className="shift-row six">
          {STEPS.map(([d, label]) => (
            <button key={label} className="btn btn-secondary btn-sm" onClick={() => move(d)} aria-label={`MR ${Math.abs(d)}초 ${d > 0 ? '늦추기' : '당기기'}`}>
              {label}
            </button>
          ))}
        </div>
        <p className="hint">메아리처럼 두 번 들리면 어긋난 거예요. MR이 원곡보다 늦게 들리면 −, 먼저 들리면 + 를 눌러요. 크게 어긋나 있으면 0.5초씩 먼저 옮겨 보세요.</p>
        <label className="field">
          <span>MR 소리 크기</span>
          <input id="mr-vol" type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} />
        </label>
      </div>

      <details className="card options">
        <summary>아무리 옮겨도 안 맞아요</summary>
        <p className="hint">MR이 원곡과 빠르기나 길이가 다른 버전(노래방용으로 새로 만든 반주 등)이면 딱 맞출 수 없어요. 그럴 때는 아래를 켜 주세요. 녹음은 MR만 들으면서 하고, 영상은 부르기 전에 들어 보는 용도로만 써요.</p>
        <Toggle id="guide-loose" checked={loose} onChange={onLoose} label="영상은 미리 듣기로만 쓰기" hint="켜면 영상을 따라 부르며 녹음하는 기능은 꺼져요." />
      </details>

      <div className="bottom-bar">
        <button
          className="btn btn-primary btn-xl"
          onClick={() => {
            pause();
            onConfirm();
          }}
        >
          {loose ? '미리 듣기로만 쓸게요' : '잘 맞아요, 다음으로'}
        </button>
      </div>
    </section>
  );
}
