// 방장이 파트를 다시 나누는 화면
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Line } from '../lib/parts';
import { navigate } from '../lib/router';
import { useRoom } from '../lib/room';
import { Spinner, TopBar, useToast } from '../ui';
import { PartsEditor } from './PartsEditor';

export function EditParts({ code }: { code: string }) {
  const toast = useToast();
  const { room, who, apply, error } = useRoom(code, 20000);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [seatCount, setSeatCount] = useState(0);
  const [aiOn, setAiOn] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.config().then((c) => setAiOn(c.ai)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!room) return;
    if (!room.me?.isHost) return navigate(`/r/${code}`, { replace: true });
    if (!lines) {
      setLines(room.lines);
      setSeatCount(room.seatCount);
    }
  }, [room, code, lines]);

  if (error && !room) {
    return (
      <main className="page">
        <TopBar onBack={() => navigate('/')} title="파트 수정" />
        <section className="stack empty">
          <p className="lead">{error.message}</p>
        </section>
      </main>
    );
  }
  if (!room || !lines || !who) {
    return (
      <main className="page">
        <TopBar onBack={() => navigate(`/r/${code}`)} title="파트 수정" />
        <Spinner label="불러오는 중…" />
      </main>
    );
  }

  const save = async () => {
    if (lines.some((l) => !l.seats.length)) return toast('아직 부를 사람이 없는 줄이 있어요.', 'error');
    setSaving(true);
    try {
      apply(await api.putParts(code, who, lines, seatCount));
      toast('파트를 바꿨어요');
      navigate(`/r/${code}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '저장하지 못했어요.', 'error');
      setSaving(false);
    }
  };

  return (
    <main className="page">
      <TopBar onBack={() => navigate(`/r/${code}`)} backLabel="방으로" title="파트 다시 나누기" />
      <section className="stack">
        {room.takes.length > 0 && <p className="pill pill-bad">이미 녹음한 사람의 줄을 바꾸면 그 사람은 다시 녹음해야 할 수 있어요.</p>}
        <PartsEditor
          lines={lines}
          seatCount={seatCount}
          dur={room.song.dur}
          songPeaks={room.song.peaks}
          ai={room.lines.some((l) => l.text) ? { code, who } : null}
          aiAvailable={aiOn}
          onChange={(l, n) => {
            setLines(l);
            setSeatCount(n);
          }}
        />
        <div className="bottom-bar">
          <button className="btn btn-primary btn-xl" onClick={save} disabled={saving}>
            {saving ? '저장하는 중…' : '이대로 저장'}
          </button>
        </div>
      </section>
    </main>
  );
}
