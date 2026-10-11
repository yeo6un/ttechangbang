// 방 상태를 서버와 맞춰 두는 훅. 화면이 보이는 동안 몇 초마다 바뀐 게 있는지 물어본다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Identity, type Room } from './api';
import { store } from './store';

export interface RoomHandle {
  room: Room | null;
  error: ApiError | null;
  who: Identity | null;
  /** 서버가 돌려준 새 상태를 바로 반영 */
  apply: (room: Room) => void;
  setWho: (who: Identity) => void;
  refresh: () => Promise<void>;
}

export function useRoom(code: string, intervalMs = 3000): RoomHandle {
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [who, setWhoState] = useState<Identity | null>(() => store.identity(code));
  const ref = useRef({ version: 0, who, stopped: false, busy: false });
  ref.current.who = who;

  const apply = useCallback((next: Room) => {
    if (next.version < ref.current.version) return;
    ref.current.version = next.version;
    setRoom(next);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    const st = ref.current;
    if (st.busy || st.stopped) return;
    st.busy = true;
    try {
      const next = await api.getRoom(code, st.who, st.version || undefined);
      if (st.stopped) return;
      if (next) {
        // 저장된 열쇠가 더는 통하지 않으면(방이 새로 만들어졌거나 지워짐) 버린다
        if (st.who && !next.me) {
          store.forget(code);
          setWhoState(null);
        }
        st.version = next.version;
        setRoom(next);
      }
      setError(null);
    } catch (e) {
      if (st.stopped) return;
      const err = e instanceof ApiError ? e : new ApiError(0, 'error', '방 정보를 불러오지 못했어요.');
      // 잠깐 끊긴 것은 조용히 다시 시도하고, 방이 없거나 끝난 경우만 화면에 알린다
      if (err.status === 404 || err.status === 410 || !st.version) setError(err);
      if (err.status === 404 || err.status === 410) st.stopped = true;
    } finally {
      st.busy = false;
    }
  }, [code]);

  useEffect(() => {
    const st = ref.current;
    st.stopped = false;
    st.version = 0;
    void refresh();
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = window.setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      st.stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [code, intervalMs, refresh]);

  const setWho = useCallback(
    (next: Identity) => {
      store.setIdentity(code, next);
      setWhoState(next);
    },
    [code],
  );

  return { room, error, who, apply, setWho, refresh };
}
