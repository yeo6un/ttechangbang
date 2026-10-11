// 유튜브 플레이어를 화면에 붙이는 훅과 자리(틀) 컴포넌트
import { useEffect, useState, type ReactNode } from 'react';
import { YtError, YtPlayer } from './player';

export interface YtHandle {
  /** 영상이 들어갈 자리에 붙인다 */
  hostRef: (el: HTMLDivElement | null) => void;
  player: YtPlayer | null;
  error: YtError | null;
  loading: boolean;
}

/** videoId 가 정해지고 자리가 화면에 붙으면 플레이어를 만든다. 화면을 떠나면 없앤다. */
export function useYtPlayer(videoId: string | null | undefined, controls = false): YtHandle {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [player, setPlayer] = useState<YtPlayer | null>(null);
  const [error, setError] = useState<YtError | null>(null);

  useEffect(() => {
    setPlayer(null);
    setError(null);
    if (!host || !videoId) return;
    let dead = false;
    let made: YtPlayer | null = null;
    YtPlayer.create(host, videoId, { controls, cancelled: () => dead }).then(
      (p) => {
        if (dead) return p.destroy();
        made = p;
        p.on((e) => {
          if (e.type === 'error') setError(e.error);
        });
        setPlayer(p);
      },
      (e) => {
        if (!dead) setError(e instanceof YtError ? e : new YtError('load', '유튜브 영상을 열지 못했어요.'));
      },
    );
    return () => {
      dead = true;
      made?.destroy();
    };
  }, [host, videoId, controls]);

  return { hostRef: setHost, player, error, loading: !!videoId && !player && !error };
}

/**
 * 재생을 눌렀는데 영상이 돌지 않을 때의 안내.
 * 브라우저가 막아서 멈춰 있는 것일 수도, 영상 앞 광고가 나오는 중일 수도 있다. 광고를 누르면 광고 사이트가 열리므로
 * "멈춰 있을 때만" 누르라고 알려 준다.
 */
export function YtTapNote({ after = '' }: { after?: string }) {
  return (
    <p className="yt-note">
      영상이 멈춰 있으면 한 번 눌러 재생해 주세요. 광고가 나오는 중이면 끝날 때까지 기다리면 돼요.{after ? ` ${after}` : ''}
    </p>
  );
}

/**
 * 영상 틀. 유튜브 규정대로 재생 중인 영상 위에는 아무것도 덮지 않는다
 * (불러오는 중이거나 오류일 때만 안내를 보여 준다).
 */
export function YtFrame({ yt, className = '', note }: { yt: YtHandle; className?: string; note?: ReactNode }) {
  return (
    <div className={`yt-frame ${className}`}>
      <div className="yt-box">
        <div className="yt-host" ref={yt.hostRef} />
        {yt.loading && (
          <div className="yt-cover">
            <span className="spinner" /> 영상을 불러오는 중…
          </div>
        )}
        {yt.error && !yt.player && <div className="yt-cover yt-cover-error">{yt.error.message}</div>}
      </div>
      {yt.error && yt.player && <p className="yt-note yt-note-bad">{yt.error.message}</p>}
      {note}
    </div>
  );
}
