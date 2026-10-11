// 방 만들기 3단계(유튜브 반주, 가사 시간표가 없을 때): 영상을 틀어 보며 시작·끝 위치를 찍어 구간을 고른다
import { useEffect, useRef, useState } from 'react';
import { fmtSpan, fmtTime } from '../../lib/parts';
import { YT, type YtPlayer } from '../../lib/yt/player';
import { Icon, useRaf } from '../../ui';

interface Props {
  player: YtPlayer | null;
  /** 영상 전체 길이(초). 모르면 0. */
  videoLen: number;
  maxLen: number;
  initial: { start: number; dur: number } | null;
  onConfirm: (seg: { start: number; dur: number }) => void;
}

const LENGTHS = [30, 45, 60, 90];

export function RangeTime({ player, videoLen, maxLen, initial, onConfirm }: Props) {
  const [start, setStart] = useState(initial?.start ?? 0);
  const [end, setEnd] = useState(initial ? initial.start + initial.dur : 60);
  const [len, setLen] = useState(videoLen);
  const [playing, setPlaying] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const nowRef = useRef<HTMLSpanElement>(null);
  const stopAt = useRef(0);

  useEffect(() => setLen((cur) => cur || videoLen), [videoLen]);
  // 영상 길이를 알게 되면 끝 위치가 영상 밖으로 나가지 않게 한다
  useEffect(() => {
    if (len > 0) setEnd((e) => Math.min(e, len));
  }, [len]);

  useEffect(() => {
    if (!player) return;
    setPlaying(player.state === YT.PLAYING);
    return player.on((e) => {
      if (e.type !== 'state') return;
      setPlaying(e.state === YT.PLAYING);
      if (e.state !== YT.PLAYING && e.state !== YT.BUFFERING) setPreviewing(false);
    });
  }, [player]);

  useRaf(() => {
    if (!player) return;
    const t = player.now();
    if (nowRef.current) nowRef.current.textContent = fmtTime(t);
    if (!len && player.duration > 0) setLen(player.duration);
    if (previewing && t >= stopAt.current) {
      player.pause();
      setPreviewing(false);
    }
  }, playing);

  const total = len > 0 ? len : Infinity;
  const clampStart = (s: number, e = end) => Math.max(0, Math.min(s, e - 5));
  const clampEnd = (e: number, s = start) => Math.min(total, Math.max(e, s + 5));
  const dur = end - start;
  const tooLong = dur > maxLen + 0.5;

  const markStart = () => {
    const t = Math.max(0, Math.floor((player?.now() ?? 0) * 10) / 10);
    setStart(t);
    // 시작을 끝보다 뒤에 찍으면 끝을 그만큼 밀어 준다
    if (t > end - 5) setEnd(Math.min(total, t + Math.max(30, dur)));
  };
  const markEnd = () => {
    const t = Math.ceil((player?.now() ?? 0) * 10) / 10;
    if (t > start + 5) setEnd(Math.min(total, t));
  };

  const preview = () => {
    if (!player) return;
    if (previewing) {
      player.pause();
      return setPreviewing(false);
    }
    stopAt.current = end;
    player.seek(start);
    player.play();
    setPreviewing(true);
  };

  return (
    <section className="stack range">
      <h1 className="title">어디를 부를까요?</h1>
      <p className="lead">영상을 틀어 보다가, 부르기 시작할 곳과 끝낼 곳에서 아래 버튼을 눌러 주세요.</p>

      <div className="card range-time">
        <p className="trim-times">
          <strong>
            {fmtTime(start)} ~ {fmtTime(end)}
          </strong>
          <span className={tooLong ? 'is-bad' : ''}>{tooLong ? `너무 길어요. ${fmtSpan(maxLen)}까지 돼요.` : `${fmtSpan(dur)}${len > 0 ? ` / 전체 ${fmtTime(len)}` : ''}`}</span>
        </p>
        <div className="mark-row">
          <button className="btn btn-secondary" onClick={markStart}>
            여기부터 부르기
          </button>
          <button className="btn btn-secondary" onClick={markEnd}>
            여기까지 부르기
          </button>
        </div>
        <p className="hint center">
          지금 영상 위치 <span ref={nowRef}>0:00</span>
        </p>
        <div className="fine-grid">
          <span>시작</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setStart((s) => clampStart(s - 1))} aria-label="시작 1초 앞으로">
            −1초
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setStart((s) => clampStart(s + 1))} aria-label="시작 1초 뒤로">
            +1초
          </button>
          <span>끝</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setEnd((e) => clampEnd(e - 1))} aria-label="끝 1초 앞으로">
            −1초
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setEnd((e) => clampEnd(e + 1))} aria-label="끝 1초 뒤로">
            +1초
          </button>
        </div>
      </div>

      <div className="chips" role="group" aria-label="구간 길이">
        {LENGTHS.filter((l) => l <= total - start + 0.5).map((l) => (
          <button key={l} className={`chip${Math.abs(dur - l) < 0.05 ? ' is-on' : ''}`} onClick={() => setEnd(Math.min(total, start + l))}>
            {l}초
          </button>
        ))}
        {len > 0 && len <= maxLen && (
          <button
            className={`chip${start === 0 && end >= len - 0.05 ? ' is-on' : ''}`}
            onClick={() => {
              setStart(0);
              setEnd(len);
            }}
          >
            전체
          </button>
        )}
      </div>

      <button className="btn btn-secondary" onClick={preview} disabled={!player}>
        <Icon name={previewing ? 'pause' : 'play'} size={18} />
        {previewing ? '멈추기' : '고른 구간 들어 보기'}
      </button>

      <div className="bottom-bar">
        <button className="btn btn-primary btn-xl" disabled={tooLong || dur < 5} onClick={() => onConfirm({ start: Math.round(start * 1000) / 1000, dur: Math.round(dur * 1000) / 1000 })}>
          이 구간으로 할게요
        </button>
      </div>
    </section>
  );
}
