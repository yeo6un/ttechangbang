// 들으면서 탭하기: 반주를 틀어 놓고, 가사 줄이 시작되는 순간마다 큰 버튼을 눌러 타이밍을 맞춘다.
// 파일 반주(Transport)와 유튜브 반주(YtDeck) 어느 쪽이든 같은 방식으로 쓴다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Deck } from '../../lib/audio/transport';
import { Icon, useRaf } from '../../ui';

interface Props {
  texts: string[];
  dur: number;
  /** 누른 그 순간에 불러야 한다 (휴대폰 브라우저는 누른 직후에만 재생을 허락한다) */
  getDeck: () => Deck | Promise<Deck>;
  /** 유튜브 영상을 반주로 쓰는지 (박자 세는 소리 대신 영상이 조금 먼저 나온다) */
  video: boolean;
  onDone: (starts: number[]) => void;
  onCancel: () => void;
}

export function TapSync({ texts, dur, getDeck, video, onDone, onCancel }: Props) {
  const [started, setStarted] = useState(false);
  const [taps, setTaps] = useState<number[]>([]);
  const tRef = useRef<Deck | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLParagraphElement>(null);
  const tapsRef = useRef<number[]>([]);
  tapsRef.current = taps;
  const next = taps.length;

  const finish = useCallback(
    (list: number[]) => {
      tRef.current?.stop();
      if (!list.length) return onCancel();
      onDone(list);
    },
    [onCancel, onDone],
  );

  const begin = async (from: number) => {
    const t = await getDeck();
    tRef.current = t;
    setStarted(true);
    // 유튜브 반주는 영상이 실제로 돌기 시작해야 끝나는 약속을 돌려준다. 실패 알림은 바깥(방 만들기 화면)에서 띄운다.
    void Promise.resolve(t.play(from, { withTakes: false, countIn: from < 0, onEnd: () => finish(tapsRef.current) })).catch(() => {});
  };

  useEffect(() => () => tRef.current?.stop(), []);

  useRaf(() => {
    const t = tRef.current;
    if (!t) return;
    const pos = t.position();
    if (barRef.current) barRef.current.style.width = `${Math.max(0, Math.min(1, pos / dur)) * 100}%`;
    if (countRef.current) countRef.current.textContent = pos < 0 ? String(Math.ceil(-pos)) : '';
  }, started);

  const tap = () => {
    const t = tRef.current;
    if (!t || !t.playing) return;
    const pos = t.position();
    if (pos < -0.2) return;
    // 누르는 손이 살짝 늦는 만큼 당겨 준다
    const at = Math.max(0, pos - 0.08);
    const list = [...tapsRef.current, at];
    setTaps(list);
    if (navigator.vibrate) navigator.vibrate(12);
    if (list.length >= texts.length) window.setTimeout(() => finish(list), 500);
  };

  const undo = () => {
    const list = tapsRef.current.slice(0, -1);
    setTaps(list);
    void begin(Math.max(0, (list[list.length - 1] ?? 0) - 2));
  };

  useEffect(() => {
    if (!started) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        tap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  if (!started) {
    return (
      <section className="stack">
        <h1 className="title">들으면서 탭하기</h1>
        <p className="lead">노래가 나오면, 화면에 보이는 줄이 시작되는 순간마다 큰 버튼을 눌러 주세요. 틀리면 "한 줄 되돌리기"를 누르면 돼요.</p>
        <div className="card">
          <p className="tap-preview">{texts[0]}</p>
          <p className="hint">{video ? '첫 줄이에요. 영상이 구간 조금 앞에서부터 나와요.' : '첫 줄이에요. 셋을 센 뒤 노래가 시작돼요.'}</p>
        </div>
        <div className="bottom-bar">
          <button className="btn btn-primary btn-xl" onClick={() => begin(-3)}>
            시작하기
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            취소
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="tap-stage">
      <div className="tap-progress">
        <div ref={barRef} />
      </div>
      <p className="tap-count" ref={countRef} aria-hidden="true" />
      <div className="tap-lines">
        <p className="tap-done">{next > 0 ? texts[next - 1] : ''}</p>
        <p className="tap-now">{texts[next] ?? '끝!'}</p>
        <p className="tap-next">{texts[next + 1] ?? ''}</p>
      </div>
      <button className="tap-button" onPointerDown={tap} disabled={next >= texts.length}>
        <span>이 줄 시작!</span>
        <small>
          {Math.min(next + 1, texts.length)} / {texts.length}
        </small>
      </button>
      <div className="tap-tools">
        <button className="btn btn-ghost" onClick={undo} disabled={!taps.length}>
          <Icon name="redo" size={18} /> 한 줄 되돌리기
        </button>
        <button className="btn btn-ghost" onClick={() => finish(tapsRef.current)}>
          여기까지만 쓰기
        </button>
      </div>
    </section>
  );
}
