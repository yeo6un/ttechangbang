// 방 만들기 2단계: 반주로 쓸 MR 파일과, 따라 부를 원곡 영상(가이드)을 고른다.
//  - MR 파일 + 원곡 영상: 영상을 보고 들으며 부르고, 목소리는 MR 위에 얹는다 (권장)
//  - MR 파일만: 반주만 들으며 부른다
//  - 원곡 영상만: 영상을 그대로 반주로 쓴다 (완성본 파일에는 목소리만 담긴다)
import type { FoundLyrics, FoundSong, FoundVideo } from '../../lib/api';
import { ytQueryFor, type SongSearch } from '../../lib/find';
import { fmtTime } from '../../lib/parts';
import { ytSearchUrl } from '../../lib/yt/ids';
import { Icon, Spinner } from '../../ui';
import { SongResults } from './SongFinder';
import { YtLinkInput, type VideoPick } from './YtLinkInput';

export interface LyrState {
  state: 'idle' | 'loading' | 'done';
  data: FoundLyrics | null;
  /** 줄별 시간표가 달린 줄 수 */
  syncedLines: number;
}

interface Props {
  song: FoundSong | null;
  lyr: LyrState;
  /** 골라 둔 MR 파일 */
  mr: { name: string; dur: number } | null;
  /** 여는 중인 파일 이름 */
  loadingFile: string;
  video: VideoPick | null;
  /** 영상을 자동으로 찾는 중 */
  finding: boolean;
  alts: FoundVideo[];
  ytReady: boolean;
  ytError: string;
  /** 영상이 실제로 재생되는지 확인하는 중 */
  checking: boolean;
  /** 곡을 정하지 않고 시작했을 때: 가사를 찾아볼 곡 후보 */
  cand: { q: string; busy: boolean; search: SongSearch | null };
  onCandQ: (q: string) => void;
  onCandSearch: () => void;
  onPickSong: (s: FoundSong) => void;
  onVideo: (v: VideoPick | null) => void;
  onFile: () => void;
  onNext: () => void;
  onChangeSong: () => void;
}

function LyricsStatus({ lyr }: { lyr: LyrState }) {
  if (lyr.state === 'loading')
    return (
      <p className="pill">
        <span className="spinner" /> 가사를 찾는 중…
      </p>
    );
  if (lyr.state !== 'done') return null;
  if (!lyr.data?.found) return <p className="pill">가사는 찾지 못했어요. 다음 단계에서 직접 넣을 수 있어요.</p>;
  return (
    <p className="pill pill-ok pill-line">
      <Icon name="check" size={16} />
      <span>{lyr.syncedLines >= 2 ? `가사를 찾았어요. 줄마다 타이밍도 들어 있어요 (${lyr.syncedLines}줄).` : '가사를 찾았어요. 타이밍은 다음 단계에서 맞춰요.'}</span>
    </p>
  );
}

export function SourcePicker({ song, lyr, mr, loadingFile, video, finding, alts, ytReady, ytError, checking, cand, onCandQ, onCandSearch, onPickSong, onVideo, onFile, onNext, onChangeSong }: Props) {
  const query = song ? ytQueryFor(song) : '';
  // 영상을 골랐으면 플레이어가 준비돼야 넘어간다. 영상이 열리지 않을 때(오류)는 MR만으로 넘어갈 수 있다.
  const videoOk = !video || ytReady;
  const canNext = !loadingFile && (mr ? videoOk || !!ytError : !!video && ytReady);
  return (
    <section className="stack">
      <h1 className="title">반주와 원곡 영상을 골라요</h1>

      {song ? (
        <div className="song-card">
          <span className="song-note" aria-hidden="true">
            <Icon name="music" size={20} />
          </span>
          <span className="song-text">
            <strong>{song.title}</strong>
            <small>
              {song.artist}
              {song.dur > 0 ? ` · ${fmtTime(song.dur)}` : ''}
            </small>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onChangeSong}>
            다른 곡
          </button>
        </div>
      ) : null}
      <LyricsStatus lyr={lyr} />

      <div className="card pick-card" id="pick-mr">
        <h3 className="card-title">
          <Icon name="music" size={20} /> MR(반주) 파일
          {mr && <Icon name="check" size={18} />}
        </h3>
        {loadingFile ? (
          <Spinner label={`"${loadingFile}" 여는 중…`} />
        ) : mr ? (
          <div className="pick-row">
            <span className="song-text">
              <strong>{mr.name}</strong>
              <small>{fmtTime(mr.dur)} · 녹음과 완성본의 반주로 써요</small>
            </span>
            <button className="btn btn-ghost btn-sm" onClick={onFile}>
              다른 파일
            </button>
          </div>
        ) : (
          <>
            <p className="hint">가수 목소리 없이 반주만 들어 있는 음원 파일이에요 (Inst. 또는 MR이라고 적힌 것). 녹음과 완성본의 반주로 써요.</p>
            <button className="btn btn-secondary" onClick={onFile}>
              <Icon name="music" size={18} />
              MR 파일 고르기
            </button>
          </>
        )}
      </div>

      <div className="card pick-card" id="pick-video">
        <h3 className="card-title">
          <Icon name="video" size={20} /> 원곡 영상 (가이드)
          {video && <Icon name="check" size={18} />}
        </h3>
        {video ? (
          <>
            <div className="pick-row">
              <span className="song-text video-meta">
                <strong>{video.title || '유튜브 영상'}</strong>
                {video.author && <small>{video.author}</small>}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => onVideo(null)}>
                다른 영상으로 바꾸기
              </button>
            </div>
            <p className="hint">{mr ? '녹음할 때 이 영상을 보고 들으면서 가수를 따라 불러요. 목소리는 MR 위에 얹혀요.' : '위에서 MR 파일도 고르면, 이 영상은 따라 부르는 가이드가 되고 완성본에는 MR이 들어가요.'}</p>
            {alts.length > 0 && (
              <div className="stack-sm">
                <h2 className="section-title">다른 영상</h2>
                <ul className="alt-list">
                  {alts.map((a) => (
                    <li key={a.id}>
                      <button className="alt-row" onClick={() => onVideo({ id: a.id, title: a.title, author: a.author, len: a.len })}>
                        <img src={a.thumb} alt="" width={96} height={54} loading="lazy" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                        <span className="song-text">
                          <strong>{a.title}</strong>
                          <small>
                            {a.author}
                            {a.len > 0 ? ` · ${fmtTime(a.len)}` : ''}
                          </small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : finding ? (
          <p className="pill">
            <span className="spinner" /> 유튜브에서 영상을 찾는 중…
          </p>
        ) : (
          <>
            <p className="hint">가수 목소리가 나오는 유튜브 영상이에요. 녹음할 때 보고 들으면서 같은 타이밍에 따라 부를 수 있어요.</p>
            <ol className="steps-list">
              {song && (
                <li>
                  <a className="btn btn-secondary" href={ytSearchUrl(query)} target="_blank" rel="noopener noreferrer">
                    <Icon name="out" size={18} />
                    유튜브에서 이 곡 찾기
                  </a>
                </li>
              )}
              <li>
                <p>마음에 드는 영상에서 "공유 → 링크 복사"를 눌러요.</p>
              </li>
              <li>
                <div className="stack-sm">
                  <p>여기로 돌아와 붙여 넣어요.</p>
                  <YtLinkInput onVideo={onVideo} />
                </div>
              </li>
            </ol>
            <p className="hint">뮤직비디오보다 "Audio"나 가사 영상이 MR·가사와 잘 맞아요.</p>
          </>
        )}
      </div>

      {!song && (mr || video) && (
        <div className="card">
          <h3 className="card-title">
            <Icon name="search" size={20} /> 이 노래의 가사 찾기
          </h3>
          <form
            className="search-row"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (cand.q.trim().length >= 2) onCandSearch();
            }}
          >
            <input id="lyr-q" className="input" type="search" enterKeyHint="search" autoComplete="off" placeholder="가수 이름 곡 이름" value={cand.q} maxLength={80} onChange={(e) => onCandQ(e.target.value)} aria-label="가사를 찾을 가수와 곡 이름" />
            <button className="btn btn-secondary" disabled={cand.busy || cand.q.trim().length < 2}>
              찾기
            </button>
          </form>
          <SongResults search={cand.search} busy={cand.busy} onPick={onPickSong} emptyHint="가사를 찾지 못했어요. 다음 단계에서 직접 넣을 수 있어요." />
        </div>
      )}

      <div className="bottom-bar">
        {!mr && video && <p className="hint center">MR 파일이 없으면 이 영상을 그대로 반주로 써요. 그때는 완성본 파일에 목소리만 담겨요.</p>}
        {mr && !video && <p className="hint center">원곡 영상 없이 MR만으로도 만들 수 있어요.</p>}
        {mr && video && ytError && <p className="hint center">영상이 열리지 않아서 MR만으로 진행해요.</p>}
        <button className="btn btn-primary btn-xl" onClick={onNext} disabled={!canNext || checking}>
          {checking ? '영상이 재생되는지 확인하는 중…' : video && !ytReady && !ytError ? '영상을 불러오는 중…' : '다음: 부를 구간 고르기'}
        </button>
      </div>
    </section>
  );
}
