// 유튜브 링크 붙여넣기: 주소에서 영상 번호를 뽑고, 서버에 물어 제목을 확인한다
import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { parseYtId } from '../../lib/yt/ids';
import { Icon } from '../../ui';

export interface VideoPick {
  id: string;
  title: string;
  author: string;
  /** 영상 전체 길이(초). 아직 모르면 0. */
  len: number;
}

export async function lookUpVideo(text: string): Promise<VideoPick> {
  // 공유 글처럼 주소 앞뒤에 다른 말이 붙어 있어도 영상 번호만 뽑아서 묻는다
  const id = parseYtId(text);
  if (!id) throw new Error('유튜브 영상 주소가 아니에요. 영상의 "공유 → 링크 복사"로 받은 주소를 붙여 넣어 주세요.');
  let r: Awaited<ReturnType<typeof api.ytInfo>>;
  try {
    r = await api.ytInfo(id);
  } catch (e) {
    throw new Error(e instanceof ApiError ? e.message : '영상을 확인하지 못했어요. 잠시 뒤 다시 해 주세요.');
  }
  if (!r.ok || !r.id) {
    throw new Error(r.reason === 'blocked' ? '이 영상은 유튜브 밖에서 재생하지 못하게 막혀 있어요. 다른 영상을 골라 주세요.' : '영상을 찾을 수 없어요. 지워졌거나 비공개 영상일 수 있어요. 주소를 다시 확인해 주세요.');
  }
  return { id: r.id, title: r.title || '', author: r.author || '', len: 0 };
}

export function YtLinkInput({ onVideo, autoFocus }: { onVideo: (v: VideoPick) => void; autoFocus?: boolean }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (text: string) => {
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      onVideo(await lookUpVideo(text));
      setUrl('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return setErr('복사해 둔 주소가 없어요. 유튜브 영상에서 "공유 → 링크 복사"를 먼저 눌러 주세요.');
      setUrl(text.trim());
      await submit(text);
    } catch {
      // 브라우저가 클립보드 읽기를 막았을 때: 직접 붙여 넣게 한다
      setErr('여기 칸을 길게 눌러 "붙여넣기"를 해 주세요.');
      document.getElementById('yt-url')?.focus();
    }
  };

  return (
    <div className="link-input">
      <form
        className="link-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void submit(url);
        }}
      >
        <input
          id="yt-url"
          className="input"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="유튜브 링크"
          value={url}
          autoFocus={autoFocus}
          onChange={(e) => {
            setUrl(e.target.value);
            setErr('');
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (parseYtId(text)) {
              e.preventDefault();
              setUrl(text.trim());
              void submit(text);
            }
          }}
        />
        {url.trim() ? (
          <button className="btn btn-primary" disabled={busy}>
            {busy ? <span className="spinner" /> : '확인'}
          </button>
        ) : (
          <button type="button" className="btn btn-secondary" onClick={paste} disabled={busy}>
            <Icon name="paste" size={18} />
            붙여넣기
          </button>
        )}
      </form>
      {err && (
        <p className="pill pill-bad" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
