// 방의 반주와 녹음을 불러와 함께 트는 훅 (방 화면·완성본 화면 공용).
// 반주가 올린 파일이면 Transport, 유튜브 영상이면 YtDeck 을 쓴다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Identity, type Room, type Take } from './api';
import { getCtx, unlockAudio } from './audio/context';
import { loadAudio } from './audio/library';
import { Transport, type MixSettings, type PlayTake } from './audio/transport';
import { store } from './store';
import { YtDeck } from './yt/deck';
import { useYtPlayer } from './yt/useYt';

/** 지금 내가 들을 수 있는 녹음 (블라인드 중에는 내 것만) */
export function audibleTakes(room: Room): Take[] {
  if (room.blind && !room.revealed) return room.takes.filter((t) => room.me && t.member === room.me.id);
  return room.takes;
}

/** shiftMs: 이 기기에서만 목소리 전체를 옮기는 값 (유튜브 반주에서 기기마다 다른 소리 지연을 맞출 때) */
export async function loadPlayTakes(room: Room, who: Identity | null, takes: Take[], shiftMs = 0): Promise<PlayTake[]> {
  const loaded = await Promise.all(
    takes.map((t) =>
      loadAudio(room.code, t.blob, who)
        .then((buffer): PlayTake => ({ id: t.id, seat: t.seat, buffer, start: t.start + (t.offsetMs + shiftMs) / 1000, gain: t.gain }))
        .catch(() => null),
    ),
  );
  return loaded.filter((x): x is PlayTake => !!x);
}

export function useRoomAudio(room: Room | null, who: Identity | null) {
  const tRef = useRef<Transport | null>(null);
  const deckRef = useRef<YtDeck | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needTap, setNeedTap] = useState(false);
  const code = room?.code;
  const ytRef = room?.song.yt;
  const isYt = !!ytRef;
  const yt = useYtPlayer(ytRef?.id);
  const [mix, setMixState] = useState<MixSettings>(() => store.mix(room?.code || '', isYt));
  const [shift, setShiftState] = useState(() => store.ytShift());
  // 방 정보가 도착하면 이 기기에 저장해 둔 소리 크기를 불러온다
  useEffect(() => {
    if (!code) return;
    const saved = store.mix(code, isYt);
    setMixState(saved);
    tRef.current?.setMix(saved);
    deckRef.current?.setMix(saved);
  }, [code, isYt]);
  const roomRef = useRef(room);
  roomRef.current = room;
  const whoRef = useRef(who);
  whoRef.current = who;
  const mixRef = useRef(mix);
  mixRef.current = mix;
  const shiftRef = useRef(shift);
  shiftRef.current = shift;
  const loadedOnce = useRef(false);

  const takes = useMemo(() => (room ? audibleTakes(room) : []), [room]);
  const takesKey = takes.map((t) => `${t.id}:${t.offsetMs}:${t.gain}`).join('|') + '|' + (room?.song.blob || '') + '|' + (isYt ? shift : 0);

  // ───── 파일 반주 ─────
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

  // ───── 유튜브 반주 ─────
  const player = yt.player;
  /** 재생기를 준비한다. 사용자가 누른 그 순간에 불러야 소리가 허락된다. */
  const ytDeck = useCallback((): YtDeck | null => {
    const r = roomRef.current;
    if (!player || !r?.song.yt) return null;
    const ctx = getCtx();
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    if (!deckRef.current || deckRef.current.yt !== player || deckRef.current.ctx !== ctx) {
      deckRef.current?.dispose();
      const d = new YtDeck(ctx, player, { start: r.song.yt.start, dur: r.song.dur, len: r.song.yt.len });
      d.setMix(mixRef.current);
      d.on((e) => {
        if (e.type === 'needTap') setNeedTap(e.on);
        else if (e.type === 'paused') setPlaying(false);
        else if (e.type === 'failed') {
          setPlaying(false);
          setLoading(false);
          setError(e.error.message);
        }
      });
      deckRef.current = d;
    }
    return deckRef.current;
  }, [player]);

  const loadYtTakes = useCallback(async () => {
    const r = roomRef.current;
    const d = deckRef.current;
    if (!r || !d) return;
    const list = await loadPlayTakes(r, whoRef.current, audibleTakes(r), shiftRef.current);
    if (deckRef.current === d) d.setTakes(list);
    loadedOnce.current = true;
  }, []);

  const play = useCallback(
    async (from?: number) => {
      setError('');
      if (roomRef.current?.song.yt) {
        const d = ytDeck();
        if (!d) return setError('영상을 불러오는 중이에요. 잠시 뒤에 다시 눌러 주세요.');
        const pos = from ?? (d.rawPosition() >= d.duration - 0.05 ? 0 : d.rawPosition());
        setLoading(true);
        setPlaying(true);
        // 영상은 누른 즉시 시작시키고, 목소리는 받아지는 대로 얹는다
        d.play(pos, { onEnd: () => setPlaying(false) }).then(
          () => setLoading(false),
          (e: Error) => {
            if (e.message !== 'replaced') setLoading(false);
          },
        );
        void loadYtTakes().catch(() => {});
        return;
      }
      setLoading(true);
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
    [sync, ytDeck, loadYtTakes],
  );

  const pause = useCallback(() => {
    tRef.current?.pause();
    deckRef.current?.pause();
    setPlaying(false);
    setLoading(false);
  }, []);

  const toggle = useCallback(() => (playing ? pause() : void play()), [playing, pause, play]);

  const seek = useCallback((pos: number) => {
    tRef.current?.seek(pos);
    deckRef.current?.seek(pos);
  }, []);
  const getPosition = useCallback(() => deckRef.current?.position() ?? tRef.current?.position() ?? 0, []);

  // 새 녹음이 올라오거나 싱크가 바뀌면 다시 불러온다 (재생 중이면 그 자리에서 이어서)
  useEffect(() => {
    if (!loadedOnce.current) return;
    let cancelled = false;
    void (async () => {
      try {
        if (roomRef.current?.song.yt) {
          await loadYtTakes();
          return;
        }
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
    deckRef.current?.setMix(next);
    if (roomRef.current) store.setMix(roomRef.current.code, next);
  }, []);

  const setShift = useCallback((ms: number) => {
    const v = Math.max(-300, Math.min(300, Math.round(ms / 10) * 10));
    setShiftState(v);
    store.setYtShift(v);
  }, []);

  // 플레이어가 바뀌거나 화면을 떠나면 재생기를 정리한다
  useEffect(
    () => () => {
      deckRef.current?.dispose();
      deckRef.current = null;
      setPlaying(false);
      setNeedTap(false);
    },
    [player],
  );
  useEffect(
    () => () => {
      tRef.current?.dispose();
      tRef.current = null;
    },
    [],
  );

  /** 유튜브 반주에서 싱크가 이상할 때 화면에 보여 줄 진단 글 (문제를 알릴 때 캡처해서 보내는 용도) */
  const diagnose = useCallback((): string => {
    const d = deckRef.current;
    const ctx = d?.ctx;
    const dbg = d?.debug();
    const out = ctx as (AudioContext & { outputLatency?: number }) | undefined;
    return [
      dbg ? `영상 ${dbg.state}/${dbg.phase} · 영상시계 ${dbg.mediaLocked ? '잡음' : '못 잡음'}(${dbg.timeSource}) · 소리시계 ${dbg.audioLocked ? '잡음' : '못 잡음'}` : '아직 재생한 적이 없어요',
      dbg ? `앞섬 ${dbg.aheadMs}ms · 옮김 ${dbg.jumps} · 멈칫 ${dbg.stalls} · 다시맞춤 ${dbg.resyncs} · 길이 ${dbg.videoLen}/${dbg.wantLen}` : '',
      out ? `소리 ${out.sampleRate}Hz · base ${Math.round((out.baseLatency || 0) * 1000)}ms · out ${Number.isFinite(out.outputLatency) ? Math.round((out.outputLatency as number) * 1000) + 'ms' : '?'} · stamp ${typeof out.getOutputTimestamp === 'function' ? '있음' : '없음'}` : '',
      navigator.userAgent,
    ]
      .filter(Boolean)
      .join('\n');
  }, []);

  return { playing, loading, error: error || (isYt && yt.error ? yt.error.message : ''), toggle, play, pause, seek, getPosition, mix, setMix, sync, isYt, yt, needTap, shift, setShift, diagnose };
}
