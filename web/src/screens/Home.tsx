// 첫 화면: 방 만들기 / 방 번호로 들어가기 / 최근 방
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { fmtCode, navigate } from '../lib/router';
import { store } from '../lib/store';
import { CodeInput, useToast } from '../ui';

// 첫 화면 그림: 레퍼런스처럼 원곡 한 줄 + 사람별 색깔 조각 (왼쪽 %, 너비 %)
const ART: { color: string; clips: [number, number][] }[] = [
  { color: 'var(--seat-0)', clips: [[0, 21], [22, 25], [49, 36]] },
  { color: 'var(--seat-1)', clips: [[2, 19], [22, 24], [49, 23], [74, 24]] },
  { color: 'var(--seat-2)', clips: [[0, 21], [22, 25], [74, 24]] },
  { color: 'var(--seat-3)', clips: [[0, 34], [35, 26], [83, 17]] },
  { color: 'var(--seat-5)', clips: [[49, 51]] },
];

export function Home() {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState(() => store.recent());

  const enter = async (c: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.getRoom(c, store.identity(c));
      navigate(`/r/${c}`);
    } catch (e) {
      // 닫혔거나 기간이 끝난 방은 최근 목록에서도 지운다
      if (e instanceof ApiError && (e.status === 410 || e.code === 'not_found')) {
        store.forget(c);
        setRecent(store.recent());
      }
      toast(e instanceof ApiError ? e.message : '방을 찾지 못했어요.', 'error');
      setBusy(false);
    }
  };

  return (
    <main className="page home">
      <section className="hero">
        <h1 className="brand">떼창방</h1>
        <p className="hero-sub">노래 한 곡을 친구들과 파트 나눠 부르고, 한 곡으로 합쳐요.</p>
        <div className="hero-art" aria-hidden="true">
          <div className="art-row art-song" />
          {ART.map((row, i) => (
            <div className="art-row" key={i}>
              {row.clips.map(([left, width], k) => (
                <i key={k} style={{ left: `${left}%`, width: `${width}%`, background: row.color, animationDelay: `${120 + i * 70 + k * 40}ms` }} />
              ))}
            </div>
          ))}
        </div>
      </section>

      <button className="btn btn-primary btn-xl" onClick={() => navigate('/new')}>
        방 만들기
      </button>

      <form
        className="card code-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6) void enter(code);
        }}
      >
        <h2>방 번호를 받았나요?</h2>
        <CodeInput value={code} onChange={setCode} />
        <button className="btn btn-secondary btn-xl" disabled={code.length < 6 || busy}>
          {busy ? '찾는 중…' : '들어가기'}
        </button>
      </form>

      {recent.length > 0 && (
        <section className="stack-sm">
          <h2 className="section-title">최근에 들어간 방</h2>
          <ul className="recent-list">
            {recent.map((r) => (
              <li key={r.code}>
                <button onClick={() => enter(r.code)}>
                  <span className="recent-title">{r.title}</span>
                  <span className="recent-code">
                    {r.host && <em>내가 만든 방</em>}
                    {fmtCode(r.code)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="stack-sm">
        <h2 className="section-title">이렇게 해요</h2>
        <ol className="how">
          <li>
            <strong>노래를 올리고 파트를 나눠요</strong>
            <span>부를 구간을 고르면 인원수에 맞게 자동으로 나눠 줘요.</span>
          </li>
          <li>
            <strong>방 번호를 친구들에게 보내요</strong>
            <span>앱 설치나 가입 없이 번호만 넣으면 들어와요.</span>
          </li>
          <li>
            <strong>각자 편한 시간에 내 파트만 녹음해요</strong>
            <span>다 모이면 한 곡으로 합쳐서 들을 수 있어요.</span>
          </li>
        </ol>
      </section>
    </main>
  );
}
