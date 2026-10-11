// 방 만들기 3단계(유튜브 반주 + 시간표 달린 가사): 가사 줄을 눌러 부를 구간을 고르고,
// 영상을 틀어 보며 가사가 영상과 맞는지 확인한다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { rangeToLines, suggestRange, syncLineEnd, type RangePick, type SyncLine } from '../../lib/lyrics';
import { fmtSpan, fmtTime } from '../../lib/parts';
import { YT, type YtPlayer } from '../../lib/yt/player';
import { Icon, useRaf, useToast } from '../../ui';

export interface LineRange {
  a: number;
  b: number;
  /** 가사 시각에 더하는 값(초) */
  shift: number;
}

interface Props {
  sync: SyncLine[];
  player: YtPlayer | null;
  /** 영상 전체 길이(초). 모르면 0. */
  videoLen: number;
  /** 가사가 맞춰진 음원의 길이(초). 모르면 0. */
  lyricsDur: number;
  maxLen: number;
  initial: LineRange | null;
  onConfirm: (pick: RangePick, range: LineRange) => void;
}

const fmtShift = (s: number) => (Math.abs(s) < 0.005 ? '그대로' : `${Math.abs(s).toFixed(1)}초 ${s > 0 ? '늦춤' : '당김'}`);

export function RangeLines({ sync, player, videoLen, lyricsDur, maxLen, initial, onConfirm }: Props) {
  const toast = useToast();
  const suggested = useMemo(() => suggestRange(sync), [sync]);
  const [a, setA] = useState(initial?.a ?? suggested.a);
  const [b, setB] = useState(initial?.b ?? suggested.b);
  const [shift, setShift] = useState(initial?.shift ?? 0);
  const [mode, setMode] = useState<'start' | 'end'>('start');
  const [tapMode, setTapMode] = useState(false);
  // 가사 싱크 조절은 보통 필요 없어서 접어 둔다. 영상이 음원과 길이가 다르면 펼쳐서 확인을 권한다.
  const [syncOpen, setSyncOpen] = useState(!!initial && Math.abs(initial.shift) > 0.005);
  const [now, setNow] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  // 영상 길이를 뒤늦게 알게 되는 경우가 있어서(재생을 시작해야 알려 주는 영상) 계속 확인한다
  const [len, setLen] = useState(videoLen);
  useEffect(() => setLen((cur) => cur || videoLen), [videoLen]);

  useEffect(() => {
    if (!player) return;
    setPlaying(player.state === YT.PLAYING);
    return player.on((e) => {
      if (e.type === 'state') setPlaying(e.state === YT.PLAYING);
    });
  }, [player]);

  useRaf(() => {
    if (!player) return;
    const t = player.now();
    let cur = -1;
    for (let i = 0; i < sync.length; i++) {
      if (sync[i].t + shift <= t + 0.05) cur = i;
      else break;
    }
    // 간주처럼 줄이 끝난 지 한참이면 표시하지 않는다
    if (cur >= 0 && t > syncLineEnd(sync, cur) + shift + 0.5) cur = -1;
    if (cur !== now) setNow(cur);
    if (!len && player.duration > 0) setLen(player.duration);
  }, playing);

  const pick = useMemo(() => rangeToLines(sync, a, b, shift, len), [sync, a, b, shift, len]);
  const tooLong = pick.dur > maxLen + 0.5;
  // 영상이 음원과 길이가 다르면(뮤직비디오 등) 가사 시간표가 그대로 맞지 않을 수 있다
  const lengthGap = len > 0 && lyricsDur > 0 ? len - lyricsDur : 0;
  const mismatch = Math.abs(lengthGap) > 4;
  useEffect(() => {
    if (mismatch) setSyncOpen(true);
  }, [mismatch]);

  const scrollTo = (i: number) => {
    requestAnimationFrame(() => listRef.current?.children[i]?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const choose = (i: number) => {
    if (mode === 'start') {
      setA(i);
      if (i > b) setB(i);
      setMode('end');
    } else {
      setB(i);
      if (i < a) setA(i);
    }
  };

  const playFrom = (i: number) => {
    if (!player) return;
    player.seek(Math.max(0, sync[i].t + shift - 1));
    player.play();
  };

  const nudge = (d: number) => setShift((s) => Math.round(Math.max(-sync[0].t, Math.min(600, s + d)) * 100) / 100);

  const tapNow = () => {
    if (!player || player.state !== YT.PLAYING) return toast('영상을 먼저 재생해 주세요. 영상을 누르면 재생돼요.', 'error');
    // 누르는 손이 살짝 늦는 만큼 당겨 준다
    const s = player.now() - 0.08 - sync[a].t;
    setShift(Math.round(Math.max(-sync[0].t, s) * 100) / 100);
    setTapMode(false);
    toast('맞췄어요. 영상을 계속 보면서 지금 부르는 줄이 맞게 표시되는지 확인해 주세요.');
  };

  return (
    <section className="stack range">
      <h1 className="title">어디를 부를까요?</h1>
      <p className="lead">시작할 줄과 끝낼 줄을 눌러 주세요. 영상을 틀면 지금 나오는 줄에 표시가 돼요.</p>

      <div className="chips" role="group" aria-label="구간 빠르게 고르기">
        <button
          className={`chip${a === suggested.a && b === suggested.b ? ' is-on' : ''}`}
          onClick={() => {
            setA(suggested.a);
            setB(suggested.b);
            scrollTo(suggested.a);
          }}
        >
          추천 구간
        </button>
        <button
          className={`chip${a === 0 && b === sync.length - 1 ? ' is-on' : ''}`}
          onClick={() => {
            setA(0);
            setB(sync.length - 1);
          }}
        >
          처음부터 끝까지
        </button>
      </div>

      <details className="card options sync-card" open={syncOpen} onToggle={(e) => setSyncOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <span>
            가사 싱크 <output id="lyric-shift">{fmtShift(shift)}</output>
          </span>
        </summary>
        {tapMode ? (
          <>
            <p className="hint">영상을 틀고, 아래 줄이 시작되는 순간 버튼을 눌러 주세요.</p>
            <p className="sheet-quote">{sync[a].text}</p>
            <div className="sheet-actions">
              <button className="btn btn-secondary" onClick={() => setTapMode(false)}>
                취소
              </button>
              <button className="btn btn-primary" onPointerDown={tapNow}>
                지금 시작!
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="hint">
              {Math.abs(lengthGap) > 4
                ? '이 영상은 음원과 길이가 달라요(뮤직비디오일 수 있어요). 재생해서 가사 표시가 노래와 맞는지 꼭 확인해 주세요.'
                : '영상을 틀었을 때 가사 표시가 노래보다 빠르면 +, 늦으면 − 를 눌러요. 보통은 그대로 맞아요.'}
            </p>
            <div className="shift-row">
              <button className="btn btn-secondary btn-sm" onClick={() => nudge(-1)} aria-label="가사 1초 당기기">
                −1초
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => nudge(-0.1)} aria-label="가사 0.1초 당기기">
                −0.1
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => nudge(0.1)} aria-label="가사 0.1초 늦추기">
                +0.1
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => nudge(1)} aria-label="가사 1초 늦추기">
                +1초
              </button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setTapMode(true)}>
              <Icon name="tap" size={18} />
              영상을 들으며 눌러서 맞추기
            </button>
          </>
        )}
      </details>

      <div className="seg-toggle" role="group" aria-label="무엇을 고를지">
        <button className={mode === 'start' ? 'is-on' : ''} aria-pressed={mode === 'start'} onClick={() => setMode('start')}>
          시작할 줄 고르기
        </button>
        <button className={mode === 'end' ? 'is-on' : ''} aria-pressed={mode === 'end'} onClick={() => setMode('end')}>
          끝낼 줄 고르기
        </button>
      </div>

      <ol className="range-list" ref={listRef}>
        {sync.map((l, i) => {
          const inRange = i >= a && i <= b;
          return (
            <li key={i} className={`range-row${inRange ? ' is-in' : ''}${i === now ? ' is-now' : ''}`}>
              <button className="range-pick" onClick={() => choose(i)} aria-pressed={inRange}>
                <small>{fmtTime(Math.max(0, l.t + shift))}</small>
                <span className="range-text">{l.text}</span>
                {(i === a || i === b) && (
                  <span className="range-tags">
                    {i === a && <em>여기부터</em>}
                    {i === b && <em>여기까지</em>}
                  </span>
                )}
              </button>
              <button className="icon-btn" onClick={() => playFrom(i)} aria-label="이 줄부터 들어 보기">
                <Icon name="play" size={18} />
              </button>
            </li>
          );
        })}
      </ol>

      <div className="bottom-bar">
        <p className={`range-sum${tooLong ? ' is-bad' : ''}`}>
          <strong>
            {fmtTime(pick.start)} ~ {fmtTime(pick.start + pick.dur)}
          </strong>
          <span>{tooLong ? `너무 길어요. ${fmtSpan(maxLen)}까지 돼요.` : `${fmtSpan(pick.dur)}, ${pick.lines.length}줄`}</span>
        </p>
        <button className="btn btn-primary btn-xl" disabled={tooLong || pick.lines.length === 0} onClick={() => onConfirm(pick, { a, b, shift })}>
          이 구간으로 할게요
        </button>
      </div>
    </section>
  );
}
