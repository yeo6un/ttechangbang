// 방 만들기 2단계: 고른 곡의 가사를 확인하고, 반주로 쓸 유튜브 영상을 정한다 (또는 파일로 바꾼다)
import type { FoundLyrics, FoundSong, FoundVideo } from '../../lib/api';
import { ytQueryFor, type SongSearch } from '../../lib/find';
import { fmtTime } from '../../lib/parts';
import { ytSearchUrl } from '../../lib/yt/ids';
import { Icon } from '../../ui';
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
  video: VideoPick | null;
  /** 영상을 자동으로 찾는 중 */
  finding: boolean;
  alts: FoundVideo[];
  ytReady: boolean;
  ytError: string;
  /** 영상이 실제로 재생되는지 확인하는 중 */
  checking: boolean;
  /** 링크로 시작했을 때: 가사를 찾아볼 곡 후보 */
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

export function SourcePicker({ song, lyr, video, finding, alts, ytReady, ytError, checking, cand, onCandQ, onCandSearch, onPickSong, onVideo, onFile, onNext, onChangeSong }: Props) {
  const query = song ? ytQueryFor(song) : '';
  return (
    <section className="stack">
      <h1 className="title">{video ? '이 영상에 맞춰 부를까요?' : '반주로 쓸 영상을 골라요'}</h1>

      {video && (
        <div className="video-meta">
          <strong>{video.title || '유튜브 영상'}</strong>
          {video.author && <small>{video.author}</small>}
        </div>
      )}

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

      {!song && video && (
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

      {video ? (
        <>
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
          <button className="btn btn-ghost" onClick={() => onVideo(null)}>
            다른 영상으로 바꾸기
          </button>
        </>
      ) : finding ? (
        <p className="pill">
          <span className="spinner" /> 유튜브에서 영상을 찾는 중…
        </p>
      ) : (
        <div className="card">
          <p className="lead-sm">유튜브 영상을 방 안에서 그대로 틀어 반주로 써요. 노래 파일이 없어도 돼요.</p>
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
          <p className="hint">뮤직비디오보다 "Audio"나 가사 영상이 가사 타이밍과 잘 맞아요. 노래방(MR) 영상도 쓸 수 있어요.</p>
        </div>
      )}

      <div className="bottom-bar">
        <button className="btn btn-primary btn-xl" onClick={onNext} disabled={!video || !ytReady || checking}>
          {checking ? '영상이 재생되는지 확인하는 중…' : video && !ytReady && !ytError ? '영상을 불러오는 중…' : '다음: 부를 구간 고르기'}
        </button>
        <button className="btn btn-ghost" onClick={onFile}>
          유튜브 대신 노래 파일로 할게요
        </button>
      </div>
    </section>
  );
}
