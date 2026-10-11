// 방의 반주와 녹음을 불러와 함께 트는 훅 (방 화면·완성본 화면 공용)
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Identity, type Room, type Take } from './api';
import { unlockAudio } from './audio/context';
import { loadAudio } from './audio/library';
import { Transport, type MixSettings, type PlayTake } from './audio/transport';
import { store } from './store';

/** 지금 내가 들을 수 있는 녹음 (블라인드 중에는 내 것만) */
export function audibleTakes(room: Room): Take[] {
  if (room.blind && !room.revealed) return room.takes.filter((t) => room.me && t.member === room.me.id);
  return room.takes;
}

export async function loadPlayTakes(room: Room, who: Identity | null, takes: Take[]): Promise<PlayTake[]> {
  const loaded = await Promise.all(
    takes.map((t) =>
      loadAudio(room.code, t.blob, who)
        .then((buffer): PlayTake => ({ id: t.id, seat: t.seat, buffer, start: t.start + t.offsetMs / 1000, gain: t.gain }))
        .catch(() => null),
    ),
  );
  return loaded.filter((x): x is PlayTake => !!x);
}

export function useRoomAudio(room: Room | null, who: Identity | null) {
  const tRef = useRef<Transport | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mix, setMixState] = useState<MixSettings>(() => store.mix(room?.code || ''));
  const code = room?.code;
  // 방 정보가 도착하면 이 기기에 저장해 둔 소리 크기를 불러온다
  useEffect(() => {
    if (!code) return;
    const saved = store.mix(code);
    setMixState(saved);
    tRef.current?.setMix(saved);
  }, [code]);
  const roomRef = useRef(room);
  roomRef.current = room;
  const whoRef = useRef(who);
  whoRef.current = who;
  const mixRef = useRef(mix);
  mixRef.current = mix;
  const loadedOnce = useRef(false);

  const takes = useMemo(() => (room ? audibleTakes(room) : []), [room]);
  const takesKey = takes.map((t) => `${t.id}:${t.offsetMs}:${t.gain}`).join('|') + '|' + (room?.song.blob || '');

  const sync = useCallback(async () => {
    const r = roomRef.current;
    if (!r || !r.song.blob) throw new ApiError(409, 'no_song', '노래가 아직 준비되지 않았어요.');
    const ctx = await unlockAudio();
    if (!tRef.current || tRef.current.ctx !== ctx) {
      tRef.current?.dispose();
      tRef.current = new Transport(ctx);
    }
    const t = tRef.current;
    const [song, list] = await Promise.all([loadAudio(r.code, r.song.blob, whoRef.current), loadPlayTakes(r, whoRef.current, audibleTakes(r))]);
    t.setSong(song);
    t.setTakes(list);
    t.setMix(mixRef.current);
    loadedOnce.current = true;
    return t;
  }, []);

  const play = useCallback(
    async (from?: number) => {
      setLoading(true);
      setError('');
      try {
        const t = await sync();
        const pos = from ?? (t.rawPosition() >= t.duration - 0.05 ? 0 : t.rawPosition());
        t.play(pos, { onEnd: () => setPlaying(false) });
        setPlaying(true);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '소리를 불러오지 못했어요. 다시 눌러 주세요.');
      } finally {
        setLoading(false);
      }
    },
    [sync],
  );

  const pause = useCallback(() => {
    tRef.current?.pause();
    setPlaying(false);
  }, []);

  const toggle = useCallback(() => (playing ? pause() : void play()), [playing, pause, play]);

  const seek = useCallback((pos: number) => tRef.current?.seek(pos), []);
  const getPosition = useCallback(() => tRef.current?.position() ?? 0, []);

  // 새 녹음이 올라오거나 싱크가 바뀌면 다시 불러온다 (재생 중이면 그 자리에서 이어서)
  useEffect(() => {
    if (!loadedOnce.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const wasPlaying = tRef.current?.playing;
        const pos = tRef.current?.rawPosition() ?? 0;
        const t = await sync();
        if (cancelled) return;
        if (wasPlaying) t.play(pos, { onEnd: () => setPlaying(false) });
      } catch {
        /* 다음 재생 때 다시 시도 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takesKey]);

  const setMix = useCallback((next: MixSettings) => {
    setMixState(next);
    tRef.current?.setMix(next);
    if (roomRef.current) store.setMix(roomRef.current.code, next);
  }, []);

  useEffect(
    () => () => {
      tRef.current?.dispose();
      tRef.current = null;
    },
    [],
  );

  return { playing, loading, error, toggle, play, pause, seek, getPosition, mix, setMix, sync };
}
