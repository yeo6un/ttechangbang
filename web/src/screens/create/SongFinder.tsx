// 방 만들기 1단계: 가수·곡 이름으로 곡 찾기. 못 찾았거나 다른 방법이 편하면 MR 파일·영상 링크·연습용 비트로 시작한다.
import type { ReactNode } from 'react';
import type { FoundSong } from '../../lib/api';
import type { SongSearch } from '../../lib/find';
import { fmtTime } from '../../lib/parts';
import { Icon, Spinner } from '../../ui';
import { YtLinkInput, type VideoPick } from './YtLinkInput';

export function SongRow({ song, onPick }: { song: FoundSong; onPick: (s: FoundSong) => void }) {
  return (
    <button className="song-row" onClick={() => onPick(song)}>
      <span className="song-note" aria-hidden="true">
        <Icon name="music" size={20} />
      </span>
      <span className="song-text">
        <strong>{song.title}</strong>
        <small>
          {song.artist}
          {song.album && song.album !== song.title ? ` · ${song.album}` : ''}
        </small>
      </span>
      <span className="song-side">
        {song.dur > 0 && <small>{fmtTime(song.dur)}</small>}
        {song.lyrics && <em>{song.lyrics === 'synced' ? '가사·타이밍' : '가사'}</em>}
      </span>
    </button>
  );
}

export function SongResults({ search, busy, onPick, emptyHint }: { search: SongSearch | null; busy: boolean; onPick: (s: FoundSong) => void; emptyHint: ReactNode }) {
  if (busy) return <Spinner label="찾는 중…" />;
  if (!search) return null;
  if (!search.songs.length) {
    return <p className="pill">{search.down ? '곡을 찾아 주는 서버가 답하지 않아요. 잠시 뒤 다시 해 주세요.' : emptyHint}</p>;
  }
  return (
    <>
      {search.rewritten && <p className="hint">"{search.rewritten}"(으)로 찾았어요.</p>}
      <ul className="song-list">
        {search.songs.map((s) => (
          <li key={s.id}>
            <SongRow song={s} onPick={onPick} />
          </li>
        ))}
      </ul>
    </>
  );
}

interface Props {
  q: string;
  onQ: (q: string) => void;
  busy: boolean;
  search: SongSearch | null;
  onSearch: () => void;
  onPick: (s: FoundSong) => void;
  onVideo: (v: VideoPick) => void;
  onFile: () => void;
  onDemo: () => void;
  loadingFile: string;
}

export function SongFinder({ q, onQ, busy, search, onSearch, onPick, onVideo, onFile, onDemo, loadingFile }: Props) {
  return (
    <section className="stack">
      <h1 className="title">어떤 노래를 부를까요?</h1>
      <p className="lead">가수와 곡 이름을 넣으면 가사를 찾아 드려요. 그다음에 MR(반주) 파일과 따라 부를 원곡 영상을 골라요.</p>
      <form
        className="search-row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) onSearch();
        }}
      >
        <input id="song-q" className="input" type="search" enterKeyHint="search" autoComplete="off" placeholder="예) 가수 이름 곡 이름" value={q} maxLength={80} onChange={(e) => onQ(e.target.value)} aria-label="가수와 곡 이름" />
        <button className="btn btn-primary" disabled={busy || q.trim().length < 2}>
          <Icon name="search" size={20} />
          찾기
        </button>
      </form>

      <SongResults search={search} busy={busy} onPick={onPick} emptyHint="찾지 못했어요. 가수 이름을 함께 넣거나 영어 이름으로 다시 찾아보세요. 아래에서 MR 파일이나 유튜브 링크로 바로 시작할 수도 있어요." />

      <div className="stack-sm other-ways">
        <h2 className="section-title">다른 방법으로 시작하기</h2>
        {loadingFile ? (
          <div className="card">
            <Spinner label={`"${loadingFile}" 여는 중…`} />
          </div>
        ) : (
          <button className="btn btn-secondary btn-xl" onClick={onFile}>
            <Icon name="music" />
            MR(반주) 파일 고르기
          </button>
        )}
        <div className="card">
          <h3 className="card-title">
            <Icon name="video" size={20} /> 유튜브 링크로
          </h3>
          <p className="hint">원곡 영상에서 "공유 → 링크 복사"를 누른 뒤 여기에 붙여 넣어요. 따라 부를 가이드로 쓰고, MR 파일이 없으면 영상을 그대로 반주로 쓸 수도 있어요.</p>
          <YtLinkInput onVideo={onVideo} />
        </div>
        {!loadingFile && (
          <button className="btn btn-ghost" onClick={onDemo}>
            파일 없이 연습용 비트로 해보기
          </button>
        )}
      </div>

      <ul className="notes">
        <li>MR 파일은 가지고 있는 것을 직접 올려요. 방과 함께 7일 뒤에 지워져요.</li>
        <li>영상은 유튜브 플레이어로 그대로 재생해요. 영상의 소리를 내려받거나 저장하지 않아요.</li>
        <li>가사는 공개 가사 모음(LRCLIB)에서 찾아와요. 틀린 곳이 있을 수 있어요.</li>
        <li>친구끼리 즐기는 용도로만 써 주세요. 완성본을 공개된 곳에 올리면 원곡 저작권 문제가 생길 수 있어요.</li>
      </ul>
    </section>
  );
}
