// 녹음 화면: 준비(이어폰·마이크) → 노래방식 녹음 → 들어보고 싱크 맞추기 → 저장
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type Room } from '../lib/api';
import { freshCtx, isIOS, reportedOutputLatency, setAudioSession, unlockAudio } from '../lib/audio/context';
import { estimateDelay } from '../lib/audio/dsp';
import { calibrationSignal, chooseLatency, displayLatency, rememberLatency, reportedLatency, setUserBias, userBias, type LatencyChoice } from '../lib/audio/latency';
import { loadAudio, seedAudio } from '../lib/audio/library';
import { listMics, Mic, MicError } from '../lib/audio/recorder';
import { cutTake, finishTake, measureLatency, planPass, TAIL_CAPTURE, toBuffer, type FinalTake, type PassPlan, type RawTake } from '../lib/audio/take';
import { Transport, type PlayTake } from '../lib/audio/transport';
import { fmtTime, isAll, passesForSeat, passRecorded, seatColor, seatName, type Line, type Pass } from '../lib/parts';
import { navigate } from '../lib/router';
import { useRoom } from '../lib/room';
import { audibleTakes, loadPlayTakes } from '../lib/roomAudio';
import { seatNames } from '../lib/roomView';
import { store } from '../lib/store';
import { YtDeck, type DeckEvent } from '../lib/yt/deck';
import type { YtPlayer } from '../lib/yt/player';
import { useYtPlayer, YtFrame, YtTapNote } from '../lib/yt/useYt';
import { Icon, InAppNotice, Sheet, Spinner, Toggle, TopBar, useRaf, useToast } from '../ui';

type Phase = 'prep' | 'opening' | 'ready' | 'rolling' | 'processing' | 'review' | 'saving' | 'saved' | 'done';

/** 유튜브 반주에서, 부르는 동안 잰 싱크 값이 이보다 흩어지면 영상이 끊긴 것으로 본다 (초) */
const YT_SPREAD_MAX = 0.06;

interface Review {
  raw: RawTake;
  choice: LatencyChoice;
  reported: number;
  fin: FinalTake & { processed: Float32Array };
  sampleRate: number;
  /** 유튜브 반주일 때: 부르는 동안 영상이 멈칫했는지 */
  shaky?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Record({ code }: { code: string }) {
  const toast = useToast();
  const { room, error, who, apply } = useRoom(code, 8000);
  const [phase, setPhase] = useState<Phase>('prep');
  const [pref, setPref] = useState(() => store.mic());
  const [passIndex, setPassIndex] = useState<number | null>(null);
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [nudge, setNudge] = useState(0);
  const [revPlaying, setRevPlaying] = useState(false);
  const [calib, setCalib] = useState<{ open: boolean; state: 'idle' | 'running' | 'ok' | 'fail'; ms?: number }>({ open: false, state: 'idle' });
  const [notice, setNotice] = useState('');
  // 유튜브 영상을 반주로 쓰는 방: 영상은 플레이어가 틀고, 싱크는 영상 시계를 따라 잡는다
  const ytRef = room?.song.yt;
  const isYt = !!ytRef;
  const yt = useYtPlayer(ytRef?.id);
  const ytPlayerRef = useRef<YtPlayer | null>(null);
  ytPlayerRef.current = yt.player;
  const [ytTap, setYtTap] = useState(false);
  const [rollReady, setRollReady] = useState(false);
  const [stageSinging, setStageSinging] = useState(false);
  const micRef = useRef<Mic | null>(null);
  const tRef = useRef<Transport | YtDeck | null>(null);
  const songRef = useRef<AudioBuffer | null>(null);
  const othersRef = useRef<PlayTake[]>([]);
  const rollRef = useRef<{ pass: Pass; plan: PassPlan; tZero: number } | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);
  const roomRef = useRef<Room | null>(room);
  roomRef.current = room;
  const aliveRef = useRef(true);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const reviewRef = useRef<Review | null>(review);
  reviewRef.current = review;
  const nudgeTimer = useRef(0);
  const watchdog = useRef(0);
  /** 지금 돌고 있는 녹음의 번호. 끝내기 처리가 두 번 겹치지 않게 한다. */
  const rollSeq = useRef(0);

  const seat = room?.me?.seat ?? null;
  const passes = useMemo(() => (room && seat !== null ? passesForSeat(room.lines, seat) : []), [room, seat]);
  const recorded = useMemo(() => (room && seat !== null ? passes.map((p) => passRecorded(p, seat, room.takes)) : []), [room, seat, passes]);
  const current = passIndex !== null ? passes[passIndex] : undefined;

  useEffect(() => {
    if (!passes.length) return;
    if (passIndex === null) {
      const i = recorded.findIndex((r) => !r);
      setPassIndex(i < 0 ? 0 : i);
    } else if (passIndex >= passes.length) {
      // 방장이 파트를 바꿔서 묶음 수가 줄었을 때
      setPassIndex(0);
    }
  }, [passIndex, passes.length, recorded]);

  const cleanup = useCallback(() => {
    window.clearTimeout(nudgeTimer.current);
    window.clearTimeout(watchdog.current);
    tRef.current?.dispose();
    tRef.current = null;
    micRef.current?.close();
    micRef.current = null;
    void wakeRef.current?.release().catch(() => {});
    wakeRef.current = null;
    setAudioSession('playback');
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cleanup();
    };
  }, [cleanup]);

  // 방에 들어오지 않았거나 파트가 없으면 방 화면으로 돌려보낸다
  useEffect(() => {
    if (room && (!room.me || room.me.seat === null)) navigate(`/r/${code}`, { replace: true });
  }, [room, code]);

  useRaf(() => {
    const mic = micRef.current;
    if (mic && meterRef.current) meterRef.current.style.transform = `scaleX(${mic.level().toFixed(3)})`;
  }, phase === 'ready' || phase === 'saved' || phase === 'rolling');

  // ───────── 유튜브 재생기에서 오는 알림 ─────────
  const onDeckEvent = (e: DeckEvent) => {
    if (e.type === 'needTap') setYtTap(e.on);
    if (phaseRef.current === 'rolling') {
      if (e.type === 'ready') setRollReady(true);
      else if (e.type === 'paused') {
        void abortPass();
        toast('영상이 멈춰서 녹음을 멈췄어요. 녹음하는 동안에는 영상을 누르지 말아 주세요.', 'error');
      } else if (e.type === 'failed') {
        void abortPass();
        toast(e.error.message, 'error');
      }
    } else if (e.type === 'paused' || e.type === 'failed') {
      setRevPlaying(false);
      if (e.type === 'failed' && phaseRef.current === 'review') toast(e.error.message, 'error');
    }
  };
  const deckEventRef = useRef(onDeckEvent);
  deckEventRef.current = onDeckEvent;

  // ───────── 마이크 켜기 ─────────
  const openMic = async (next = pref) => {
    const r = roomRef.current;
    if (!r || (!r.song.blob && !r.song.yt)) return;
    if (r.song.yt && !ytPlayerRef.current) return toast(yt.error?.message || '영상을 불러오는 중이에요. 잠시 뒤에 다시 눌러 주세요.', 'error');
    setPhase('opening');
    setNotice('');
    try {
      cleanup();
      setAudioSession('play-and-record');
      await unlockAudio(); // 누른 순간에 소리를 깨워 둔다
      const provide = () => (isIOS() ? freshCtx() : unlockAudio());
      if (!next.earphones) {
        // 스피커 모드: 반주가 같이 녹음되지 않게 울림 제거를 켜기 전에, 스피커→마이크 지연을 먼저 재 둔다
        setNotice('스피커 소리로 싱크를 재는 중이에요. 잠깐 "칙칙" 소리가 나요.');
        try {
          const probe = await Mic.open(provide, { deviceId: next.deviceId || undefined, echoCancel: false });
          const result = await runCalibration(probe);
          if (result.ok) rememberLatency(result.sec, reportedLatency(probe.ctx, probe.inputLatency));
          probe.close();
        } catch (e) {
          if (e instanceof MicError) throw e;
        }
        setNotice('');
      }
      const mic = await Mic.open(provide, { deviceId: next.deviceId || undefined, echoCancel: !next.earphones });
      if (!aliveRef.current) return mic.close();
      micRef.current = mic;
      const player = ytPlayerRef.current;
      if (r.song.yt && player) {
        songRef.current = null;
        othersRef.current = await loadPlayTakes(r, who, audibleTakes(r).filter((t) => t.seat !== r.me?.seat), store.ytShift());
        const deck = new YtDeck(mic.ctx, player, { start: r.song.yt.start, dur: r.song.dur, len: r.song.yt.len });
        deck.on((e) => deckEventRef.current(e));
        tRef.current = deck;
      } else {
        const song = await loadAudio(code, r.song.blob!, who);
        songRef.current = song;
        othersRef.current = await loadPlayTakes(r, who, audibleTakes(r).filter((t) => t.seat !== r.me?.seat));
        const t = new Transport(mic.ctx);
        t.setSong(song);
        tRef.current = t;
      }
      setDevices(await listMics());
      setPhase('ready');
    } catch (e) {
      cleanup();
      setNotice('');
      setPhase('prep');
      toast(e instanceof MicError || e instanceof ApiError ? e.message : '녹음 준비를 하지 못했어요. 다시 눌러 주세요.', 'error');
    }
  };

  const changePref = (patch: Partial<typeof pref>, reopen = false) => {
    const next = { ...pref, ...patch };
    setPref(next);
    store.setMic(next);
    if (reopen && micRef.current) void openMic(next);
  };

  // ───────── 싱크 재기 (시험 소리를 틀고 마이크로 받아 지연을 잰다) ─────────
  const runCalibration = async (mic: Mic): Promise<{ ok: boolean; sec: number }> => {
    const ctx = mic.ctx;
    const sr = ctx.sampleRate;
    const sig = calibrationSignal(sr);
    const src = ctx.createBufferSource();
    src.buffer = toBuffer(ctx, sig, sr);
    src.connect(ctx.destination);
    // 자동 테스트의 가짜 마이크가 이 시험 소리를 "들을" 수 있게 알려 준다
    (window as unknown as { __ttbTest?: { onCalibrate?: (node: AudioNode) => void } }).__ttbTest?.onCalibrate?.(src);
    mic.start();
    const at = ctx.currentTime + 0.2;
    src.start(at);
    await sleep((0.2 + 2.4 + 0.9) * 1000);
    const cap = await mic.stop();
    const ref = new Float32Array(cap.samples.length);
    const off = Math.round(at * sr) - cap.firstFrame;
    for (let i = 0; i < sig.length; i++) {
      const k = off + i;
      if (k >= 0 && k < ref.length) ref[k] = sig[i];
    }
    const est = estimateDelay(ref, cap.samples, sr, { maxLagSec: 0.8 });
    return { ok: est.confidence >= 10 && est.gainDb > -70, sec: est.delaySec };
  };

  const calibrate = async () => {
    const mic = micRef.current;
    if (!mic) return;
    setCalib({ open: true, state: 'running' });
    try {
      tRef.current?.stop();
      setRevPlaying(false);
      const r = await runCalibration(mic);
      if (r.ok) {
        rememberLatency(r.sec, reportedLatency(mic.ctx, mic.inputLatency));
        setCalib({ open: true, state: 'ok', ms: Math.round(r.sec * 1000) });
        // 들어보는 중이었다면 방금 잰 값으로 그 녹음을 바로 다시 맞춘다
        const cur = reviewRef.current;
        if (cur && phaseRef.current === 'review') {
          const fin = await finishTake(cutTake(cur.raw, r.sec));
          setNudge(0);
          setReview({ ...cur, choice: { sec: r.sec, source: 'measured' }, fin });
        }
      } else {
        setCalib({ open: true, state: 'fail' });
      }
    } catch {
      setCalib({ open: true, state: 'fail' });
    }
  };

  // ───────── 녹음 ─────────
  const startPass = async () => {
    const mic = micRef.current;
    const t = tRef.current;
    const r = roomRef.current;
    if (!mic || !t || !r || !current) return;
    const hear = pref.hearOthers && othersRef.current.length > 0;
    window.clearTimeout(nudgeTimer.current);
    window.clearTimeout(watchdog.current);
    if (t instanceof YtDeck) {
      // 영상은 누른 그 순간에 시작시켜야 한다 (휴대폰 브라우저는 누른 직후에만 재생을 허락한다)
      const plan = planPass(current, r.song.dur, t.seg);
      t.setTakes(hear ? othersRef.current : []);
      t.setMix({ backing: pref.guide, seats: {}, echo: 0.1 });
      const seq = ++rollSeq.current;
      mic.start();
      setRollReady(false);
      rollRef.current = { pass: current, plan, tZero: NaN };
      t.play(plan.from, { until: plan.until, withTakes: hear, onEnd: () => void finishPass(seq) }).catch(() => {
        /* 실패는 재생기 알림(failed)으로 처리한다 */
      });
      // 영상이 시작되기를 기다리는 시간까지 넉넉히 잡은 안전장치
      watchdog.current = window.setTimeout(() => void finishPass(seq), (plan.until - plan.from + 150) * 1000);
    } else {
      const song = songRef.current;
      if (!song) return;
      try {
        await mic.ctx.resume();
      } catch {
        /* 무시 */
      }
      const plan = planPass(current, song.duration);
      t.setTakes(hear ? othersRef.current : []);
      t.setMix({ backing: pref.guide, seats: {}, echo: 0.1 });
      t.displayLatency = displayLatency(reportedOutputLatency(mic.ctx), reportedLatency(mic.ctx, mic.inputLatency));
      const seq = ++rollSeq.current;
      mic.start();
      const tZero = t.play(plan.from, { until: plan.until, countIn: plan.countIn, withTakes: hear, onEnd: () => void finishPass(seq) });
      rollRef.current = { pass: current, plan, tZero };
      setRollReady(true);
      // 재생 끝 신호를 놓쳐도 녹음 화면에 갇히지 않게 하는 안전장치
      watchdog.current = window.setTimeout(() => void finishPass(seq), (plan.until - plan.from + 2.5) * 1000);
    }
    setReview(null);
    setNudge(0);
    setPhase('rolling');
    try {
      wakeRef.current = await (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release: () => Promise<void> }> } }).wakeLock?.request('screen') ?? null;
    } catch {
      /* 화면 꺼짐 방지를 못 써도 녹음은 된다 */
    }
  };

  const finishPass = async (seq: number) => {
    if (seq !== rollSeq.current || phaseRef.current === 'processing') return;
    rollSeq.current++;
    window.clearTimeout(watchdog.current);
    const mic = micRef.current;
    const roll = rollRef.current;
    const song = songRef.current;
    const deck = tRef.current instanceof YtDeck ? tRef.current : null;
    // 유튜브 반주: 부르는 동안 잰 "영상 시계 ↔ 소리 시계" 값을 멈추기 전에 받아 둔다 (줄마다 따로)
    const fit = deck && roll ? deck.zerosFor(roll.pass.lines.map((l) => [l.t0, l.t1])) : null;
    const stalls = deck ? deck.stalls : 0;
    tRef.current?.stop();
    if (!mic || !roll || (!song && !deck)) return setPhase('ready');
    phaseRef.current = 'processing';
    setPhase('processing');
    await sleep(TAIL_CAPTURE * 1000);
    const capture = await mic.stop();
    void wakeRef.current?.release().catch(() => {});
    if (!aliveRef.current) return;
    if (capture.samples.length < capture.sampleRate) {
      toast('녹음된 소리가 없어요. 마이크를 확인하고 다시 해 주세요.', 'error');
      return setPhase('ready');
    }
    if (deck && !fit) {
      toast('영상이 끊겨서 싱크를 잡지 못했어요. 인터넷 연결을 확인하고 다시 불러 주세요.', 'error');
      return setPhase('ready');
    }
    await sleep(30); // 화면이 "정리 중"으로 바뀔 틈
    try {
      const raw: RawTake = { capture, tZero: fit ? fit.overall.tZero : roll.tZero, zeros: fit?.lines, plan: roll.plan, pass: roll.pass };
      // 유튜브 영상의 소리는 우리가 들여다볼 수 없어서 "새어 들어간 반주"로 재는 방법을 쓸 수 없다
      const est = deck || mic.echoCancel ? null : measureLatency(raw, song);
      const reported = reportedLatency(mic.ctx, mic.inputLatency);
      const choice = chooseLatency(est, reported);
      const fin = await finishTake(cutTake(raw, choice.sec));
      if (!aliveRef.current) return;
      // 자동으로 잰 경우에는 지난번에 일부러 옮겨 둔 만큼을 막대 시작 위치로 쓴다
      const startNudge = choice.source === 'measured' ? userBias() : 0;
      setNudge(startNudge);
      setReview({ raw, choice, reported, fin, sampleRate: capture.sampleRate, shaky: !!fit && (fit.spread > YT_SPREAD_MAX || stalls > 0) });
      setPhase('review');
      void playReview(fin, startNudge, capture.sampleRate, roll.pass);
    } catch {
      toast('녹음을 정리하지 못했어요. 다시 불러 주세요.', 'error');
      setPhase('ready');
    }
  };

  const abortPass = async () => {
    rollSeq.current++;
    window.clearTimeout(watchdog.current);
    tRef.current?.stop();
    await micRef.current?.stop();
    void wakeRef.current?.release().catch(() => {});
    setPhase('ready');
  };

  // 녹음 도중 화면이 꺼지거나 다른 앱으로 넘어가면 소리가 끊기므로, 그 녹음은 버리고 알려 준다
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && phaseRef.current === 'rolling') {
        void abortPass();
        toast('화면이 꺼지거나 다른 앱으로 넘어가서 녹음을 멈췄어요. 다시 불러 주세요.', 'error');
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ───────── 들어보기 ─────────
  const playReview = async (fin: Review['fin'], offsetMs: number, sampleRate: number, pass: Pass) => {
    const t = tRef.current;
    const r = roomRef.current;
    if (!t || !r || r.me?.seat == null) return;
    const yt = t instanceof YtDeck;
    // 유튜브 반주에서는 이 기기에 맞춰 둔 "목소리 전체 타이밍"을 미리듣기에도 똑같이 적용한다
    const shift = yt ? store.ytShift() : 0;
    const mine: PlayTake = { id: 'preview', seat: r.me.seat, buffer: toBuffer(t.ctx, fin.processed, sampleRate), start: fin.start + (offsetMs + shift) / 1000, gain: 1 };
    t.setTakes([...othersRef.current, mine]);
    t.setMix({ backing: yt ? Math.min(1, pref.guide) : 0.7, seats: {}, echo: 0.16 });
    setRevPlaying(true);
    // 유튜브 반주는 영상이 실제로 돌기 시작해야 끝나는 약속을 돌려준다. 실패는 재생기 알림으로 처리한다.
    void Promise.resolve(t.play(Math.max(0, pass.t0 - 2), { until: Math.min(r.song.dur, pass.t1 + 1), onEnd: () => setRevPlaying(false) })).catch(() => {});
  };

  const changeNudge = (v: number) => {
    const val = Math.max(-300, Math.min(300, v));
    setNudge(val);
    window.clearTimeout(nudgeTimer.current);
    if (review && revPlaying) {
      nudgeTimer.current = window.setTimeout(() => {
        // 그 사이 저장하거나 다시 부르기를 눌렀다면 재생하지 않는다
        if (phaseRef.current === 'review') void playReview(review.fin, val, review.sampleRate, review.raw.pass);
      }, 180);
    }
  };

  const save = async () => {
    const r = roomRef.current;
    if (!review || !r || !who || r.me?.seat == null) return;
    window.clearTimeout(nudgeTimer.current);
    tRef.current?.stop();
    setRevPlaying(false);
    phaseRef.current = 'saving';
    setPhase('saving');
    try {
      // 막대로 옮긴 만큼을 지연값에 반영해 다시 잘라 낸다 (뒤로 +면 지연이 그만큼 작았던 것)
      const latency = review.choice.sec - nudge / 1000;
      const fin = nudge === 0 ? review.fin : await finishTake(cutTake(review.raw, latency));
      const out = await api.postTake(
        code,
        who,
        { seat: r.me.seat, start: fin.start, dur: fin.dur, lead: fin.lead, peaks: fin.peaks, latencyMs: Math.round(latency * 1000), stats: fin.stats },
        fin.bytes,
      );
      const saved = out.room.takes.find((t) => t.id === out.takeId);
      if (saved && tRef.current) seedAudio(saved.blob, toBuffer(tRef.current.ctx, fin.processed, review.sampleRate));
      if (review.choice.source === 'measured') {
        // 잰 값은 그대로 기억하고, 사용자가 옮긴 만큼은 취향으로 따로 기억한다
        rememberLatency(review.choice.sec, review.reported);
        setUserBias(nudge);
      } else if (nudge !== 0) {
        rememberLatency(latency, review.reported);
      }
      apply(out.room);
      const nextPasses = passesForSeat(out.room.lines, r.me.seat);
      const nextIdx = nextPasses.findIndex((p) => !passRecorded(p, r.me!.seat!, out.room.takes));
      setReview(null);
      if (nextIdx < 0) {
        cleanup();
        setPhase('done');
      } else {
        setPassIndex(nextIdx);
        setPhase('saved');
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '저장하지 못했어요. 다시 눌러 주세요.', 'error');
      setPhase('review');
    }
  };

  // ───────── 화면 ─────────
  if (error && !room) {
    return (
      <main className="page">
        <TopBar onBack={() => navigate('/')} title="녹음" />
        <section className="stack empty">
          <h1 className="title">방을 찾지 못했어요</h1>
          <p className="lead">{error.message}</p>
        </section>
      </main>
    );
  }
  if (!room || seat === null) {
    return (
      <main className="page">
        <TopBar onBack={() => navigate(`/r/${code}`)} title="녹음" />
        <Spinner label="준비 중…" />
      </main>
    );
  }

  const style = { '--me': seatColor(seat) } as React.CSSProperties;
  const leave = () => {
    cleanup();
    navigate(`/r/${code}`);
  };

  if (!passes.length) {
    return (
      <main className="page record" style={style}>
        <TopBar onBack={leave} backLabel="방으로" title={`${seatName(seat)} 파트 녹음`} />
        <section className="stack empty">
          <h1 className="title">이 파트에는 부를 줄이 없어요</h1>
          <p className="lead">방으로 돌아가 다른 파트를 고르거나, 방장에게 파트를 나눠 달라고 해 주세요.</p>
          <button className="btn btn-primary btn-xl" onClick={leave}>
            방으로 돌아가기
          </button>
        </section>
      </main>
    );
  }
  const others = audibleTakes(room).filter((t) => t.seat !== seat).length;
  const rolling = phase === 'rolling' && !!rollRef.current && !!tRef.current;
  const backing = isYt ? '영상' : '반주';

  // 유튜브 플레이어는 단계가 바뀌어도 같은 자리에 그대로 둔다 (자리를 옮기면 영상이 처음부터 다시 불러와진다).
  // 그래서 녹음 무대와 나머지 화면이 같은 틀(main)을 쓰고, 영상의 위치는 CSS 로만 바꾼다.
  return (
    <main className={rolling ? `stage${isYt ? ' has-video' : ''}${stageSinging ? ' is-singing' : ''}` : 'page record'} style={style}>
      {isYt && phase !== 'done' && (
        <YtFrame yt={yt} note={!rolling && ytTap ? <YtTapNote /> : null} />
      )}
      {rolling ? (
        <Stage
          room={room}
          roll={rollRef.current!}
          getPosition={() => tRef.current?.position() ?? 0}
          meterRef={meterRef}
          passLabel={`${(passIndex ?? 0) + 1} / ${passes.length}`}
          onCancel={abortPass}
          onSinging={setStageSinging}
          ready={rollReady}
          tapHint={isYt && ytTap}
          video={isYt}
        />
      ) : (
        <>
          <TopBar onBack={leave} backLabel="방으로" title={phase === 'done' ? '' : `${seatName(seat)} 파트 녹음`} />

          {(phase === 'prep' || phase === 'opening') && (
            <section className="stack">
              <h1 className="title">녹음 준비</h1>
              <p className="lead">
                {passes.length > 1 ? `내 파트는 ${passes.length}번에 나눠 녹음해요. ` : ''}
                {backing}
                {isYt ? '이' : '가'} 4초 먼저 나오고, 내 차례가 되면 가사에 색이 들어와요.
              </p>
              <div className="choice-list" role="radiogroup" aria-label="듣는 방법">
                <button className={`choice${pref.earphones ? ' is-on' : ''}`} role="radio" aria-checked={pref.earphones} onClick={() => changePref({ earphones: true })}>
                  <Icon name="headphones" />
                  <span>
                    <strong>이어폰을 꼈어요</strong>
                    <small>추천. 목소리만 깨끗하게 녹음돼요. 줄 이어폰이 가장 좋고, 블루투스는 소리가 늦거나 뭉개질 수 있어요.</small>
                  </span>
                </button>
                <button className={`choice${!pref.earphones ? ' is-on' : ''}`} role="radio" aria-checked={!pref.earphones} onClick={() => changePref({ earphones: false })}>
                  <Icon name="speaker" />
                  <span>
                    <strong>이어폰 없이 할게요</strong>
                    <small>스피커 {backing}
                      {isYt ? ' 소리' : ''}가 같이 녹음되지 않게 걸러 줘요. 목소리가 조금 뭉개질 수 있어요.</small>
                  </span>
                </button>
              </div>
              <InAppNotice />
              {notice && <p className="pill">{notice}</p>}
              {isYt && yt.error && <p className="pill pill-bad">{yt.error.message}</p>}
              <div className="bottom-bar">
                <button className="btn btn-primary btn-xl" onClick={() => openMic()} disabled={phase === 'opening' || (isYt && !yt.player)}>
                  <Icon name="mic" />
                  {phase === 'opening' ? '마이크 켜는 중…' : isYt && yt.loading ? '영상을 불러오는 중…' : '마이크 켜기'}
                </button>
                <p className="hint center">브라우저가 마이크를 써도 되는지 물으면 "허용"을 눌러 주세요.</p>
              </div>
            </section>
          )}

          {(phase === 'ready' || phase === 'saved') && (
            <section className="stack">
              {phase === 'saved' ? (
                <>
                  <h1 className="title">저장했어요</h1>
                  <p className="lead">이어서 다음 부분을 녹음해요.</p>
                </>
              ) : (
                <>
                  <h1 className="title">마이크가 켜졌어요</h1>
                  <p className="lead">"아" 하고 소리를 내 보세요. 아래 막대가 움직이면 준비 끝이에요.</p>
                </>
              )}
              <div className="meter" aria-hidden="true">
                <div ref={meterRef} />
              </div>

              <ol className="pass-list">
                {passes.map((p, i) => (
                  <li key={i}>
                    <button className={`pass${i === passIndex ? ' is-on' : ''}`} onClick={() => setPassIndex(i)} aria-pressed={i === passIndex}>
                      <span className="pass-num">{i + 1}</span>
                      <span className="pass-text">
                        <strong>{p.lines.map((l) => l.text).filter(Boolean).slice(0, 2).join(' / ') || `${fmtTime(p.t0)} 구간`}</strong>
                        <small>
                          {fmtTime(p.t0)} ~ {fmtTime(p.t1)}, {p.lines.length}줄
                        </small>
                      </span>
                      {recorded[i] ? (
                        <span className="status status-done">
                          <Icon name="check" size={15} /> 녹음됨
                        </span>
                      ) : (
                        <span className="status">아직</span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>

              <details className="card options">
                <summary>소리 설정</summary>
                <label className="field">
                  <span>{isYt ? '영상 소리 크기' : '반주 크기'}</span>
                  <input id="guide-vol" type="range" min={0.2} max={isYt ? 1 : 1.4} step={0.05} value={Math.min(pref.guide, isYt ? 1 : 1.4)} onChange={(e) => changePref({ guide: Number(e.target.value) })} />
                </label>
                {isYt && isIOS() && <p className="hint">아이폰·아이패드에서는 영상 소리 크기가 기기 음량을 따라가요.</p>}
                {others > 0 && <Toggle id="hear-others" checked={pref.hearOthers} onChange={(v) => changePref({ hearOthers: v })} label="친구들 녹음도 같이 듣기" hint="먼저 녹음한 친구 목소리에 맞춰 부를 수 있어요." />}
                {devices.length > 1 && (
                  <label className="field">
                    <span>마이크</span>
                    <select id="mic-device" className="input" value={pref.deviceId} onChange={(e) => changePref({ deviceId: e.target.value }, true)}>
                      <option value="">기본 마이크</option>
                      {devices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button className="btn btn-secondary" onClick={() => changePref({ earphones: !pref.earphones }, true)}>
                  <Icon name={pref.earphones ? 'speaker' : 'headphones'} size={18} />
                  {pref.earphones ? '이어폰 없이 하기로 바꾸기' : '이어폰 끼고 하기로 바꾸기'}
                </button>
                {pref.earphones && (
                  <button className="btn btn-secondary" onClick={() => setCalib({ open: true, state: 'idle' })}>
                    싱크 미리 맞춰 두기
                  </button>
                )}
              </details>

              <div className="bottom-bar">
                <button className="btn btn-rec btn-xl" onClick={startPass} disabled={!current}>
                  <span className="rec-dot" />
                  {current && recorded[passIndex ?? 0] ? `${(passIndex ?? 0) + 1}번 다시 녹음하기` : `${(passIndex ?? 0) + 1}번 녹음 시작`}
                </button>
              </div>
            </section>
          )}

          {phase === 'processing' && (
            <section className="stack empty">
              <Spinner label="녹음을 정리하고 싱크를 맞추는 중…" />
            </section>
          )}

          {(phase === 'review' || phase === 'saving') && review && (
            <section className="stack">
              <h1 className="title">들어 보세요</h1>
              <p className="lead">{reviewMessage(review, isYt)}</p>
              {warnings(review, pref.earphones).map((w) => (
                <p key={w} className="pill pill-bad">
                  {w}
                </p>
              ))}
              <div className="card review-card">
                <button
                  className="play-btn"
                  onClick={() => {
                    if (revPlaying) {
                      tRef.current?.pause();
                      setRevPlaying(false);
                    } else void playReview(review.fin, nudge, review.sampleRate, review.raw.pass);
                  }}
                  aria-label={revPlaying ? '멈추기' : '다시 듣기'}
                >
                  <Icon name={revPlaying ? 'pause' : 'play'} size={26} />
                </button>
                <TakeWave fin={review.fin} pass={review.raw.pass} nudge={nudge} getPosition={() => tRef.current?.position() ?? 0} playing={revPlaying} />
              </div>
              <div className="card sync-card">
                <div className="sync-head">
                  <strong>목소리 타이밍</strong>
                  <output>{nudge === 0 ? '그대로' : nudge > 0 ? `${nudge}ms 늦게` : `${-nudge}ms 빠르게`}</output>
                </div>
                <div className="sync-row">
                  <button className="icon-btn" onClick={() => changeNudge(nudge - 10)} aria-label="10ms 빠르게">
                    <Icon name="minus" />
                  </button>
                  <input id="sync-nudge" type="range" min={-300} max={300} step={10} value={nudge} onChange={(e) => changeNudge(Number(e.target.value))} aria-label="목소리 타이밍" />
                  <button className="icon-btn" onClick={() => changeNudge(nudge + 10)} aria-label="10ms 늦게">
                    <Icon name="plus" />
                  </button>
                </div>
                <p className="hint">
                  목소리가 {backing}보다 늦게 들리면 왼쪽(빠르게), 앞서 나가면 오른쪽(늦게)으로 옮겨요. 한 번 맞추면 다음 녹음부터 그대로 적용돼요.
                </p>
                {review.choice.source !== 'measured' && pref.earphones && phase === 'review' && (
                  <button className="btn btn-secondary" onClick={() => setCalib({ open: true, state: 'idle' })}>
                    귀로 맞추기 어려우면 자동으로 재기
                  </button>
                )}
              </div>
              <div className="bottom-bar two">
                <button
                  className="btn btn-secondary btn-xl"
                  disabled={phase === 'saving'}
                  onClick={() => {
                    window.clearTimeout(nudgeTimer.current);
                    tRef.current?.stop();
                    setRevPlaying(false);
                    setPhase('ready');
                  }}
                >
                  <Icon name="redo" />
                  다시 부르기
                </button>
                <button className="btn btn-primary btn-xl" onClick={save} disabled={phase === 'saving'}>
                  {phase === 'saving' ? '올리는 중…' : '이걸로 저장'}
                </button>
              </div>
            </section>
          )}

          {phase === 'done' && (
            <section className="stack done">
              <p className="eyebrow-plain">{seatName(seat)} 파트</p>
              <h1 className="title">다 불렀어요!</h1>
              <p className="lead center">{room.blind && !room.revealed ? '모두 녹음을 마치면 한꺼번에 공개돼요.' : '방으로 돌아가면 지금까지 합쳐진 노래를 들을 수 있어요.'}</p>
              <button className="btn btn-primary btn-xl" onClick={() => navigate(`/r/${code}`)}>
                방으로 돌아가기
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  setPassIndex(0);
                  setPhase('prep');
                }}
              >
                다시 녹음하고 싶어요
              </button>
            </section>
          )}
        </>
      )}

      <Sheet open={calib.open} onClose={() => setCalib({ open: false, state: 'idle' })} title="싱크 미리 맞춰 두기">
        <p className="lead">이어폰 한쪽을 빼서 휴대폰 마이크(보통 아래쪽)나 이어폰 줄의 마이크에 바짝 대 주세요. 3초 동안 "칙칙" 소리를 틀어 소리가 돌아오는 시간을 재요.</p>
        {calib.state === 'running' && <Spinner label="재는 중… 움직이지 말아 주세요" />}
        {calib.state === 'ok' && (
          <p className="pill pill-ok">
            <Icon name="check" size={16} /> 쟀어요. 이 기기는 {calib.ms}ms 늦게 들어와요. {review ? '방금 녹음도 이 값으로 다시 맞췄어요.' : '녹음에 자동으로 반영할게요.'}
          </p>
        )}
        {calib.state === 'fail' && <p className="pill pill-bad">시험 소리를 찾지 못했어요. 볼륨을 키우고 이어폰을 마이크에 더 가까이 대 주세요.</p>}
        <div className="sheet-actions col">
          <button className="btn btn-primary btn-xl" onClick={calibrate} disabled={calib.state === 'running'}>
            {calib.state === 'idle' ? '재기 시작' : '다시 재기'}
          </button>
        </div>
      </Sheet>
    </main>
  );
}

function reviewMessage(r: Review, yt: boolean): string {
  if (r.choice.source === 'measured') return '싱크는 자동으로 맞췄어요. 괜찮으면 저장하고, 어긋나면 아래 막대로 맞춰 주세요.';
  if (r.choice.source === 'remembered') return '지난번에 맞춘 싱크를 그대로 썼어요. 어긋나면 아래 막대로 맞춰 주세요.';
  if (yt) return '영상과 목소리가 어긋나게 들리면 아래 막대로 맞춰 주세요. 유튜브 영상은 싱크를 자동으로 잴 수 없어서, 처음 한 번은 직접 맞춰야 해요.';
  return '반주와 목소리가 어긋나게 들리면 아래 막대로 맞춰 주세요.';
}

function warnings(r: Review, earphones: boolean): string[] {
  const out: string[] = [];
  if (r.fin.stats.voiced < 0.4) out.push('목소리가 거의 안 들려요. 마이크가 막혀 있지 않은지 확인하고 다시 불러 보세요.');
  if (earphones && r.choice.leakDb !== undefined && r.choice.leakDb > -22) out.push('반주가 마이크에 꽤 크게 들어갔어요. 이어폰을 꼈는지 확인하거나 "이어폰 없이 하기"로 바꿔 주세요.');
  if (r.shaky) out.push('부르는 동안 영상이 잠깐 멈칫했어요. 싱크가 어긋나게 들리면 다시 불러 주세요.');
  return out;
}

// ───────── 방금 녹음한 파형 ─────────
function TakeWave({ fin, pass, nudge, getPosition, playing }: { fin: FinalTake & { processed: Float32Array }; pass: Pass; nudge: number; getPosition: () => number; playing: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const from = pass.t0 - 2;
  const to = pass.t1 + 1;
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const w = wrap.clientWidth;
    const h = 64;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const c = canvas.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const X = (t: number) => ((t - from) / (to - from)) * w;
    const me = getComputedStyle(wrap).getPropertyValue('--me').trim() || '#FFF8EA';
    c.globalAlpha = 0.2;
    c.fillStyle = me;
    for (const l of pass.lines) c.fillRect(X(l.t0), 0, Math.max(2, X(l.t1) - X(l.t0) - 2), h);
    c.globalAlpha = 1;
    const x0 = X(fin.start + nudge / 1000);
    const x1 = X(fin.start + nudge / 1000 + fin.dur);
    const n = fin.processed.length;
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x += 2.5) {
      const a = Math.floor(((x - x0) / (x1 - x0)) * n);
      const b = Math.min(n, Math.floor(((x + 2.5 - x0) / (x1 - x0)) * n));
      let p = 0;
      for (let i = a; i < b; i += 8) p = Math.max(p, Math.abs(fin.processed[i]));
      const bar = Math.max(1.5, Math.sqrt(p) * (h / 2 - 4));
      c.fillRect(x, h / 2 - bar, 1.5, bar * 2);
    }
  }, [fin, pass, nudge, from, to]);
  useRaf(() => {
    const wrap = wrapRef.current;
    if (headRef.current && wrap) headRef.current.style.transform = `translateX(${Math.max(0, Math.min(1, (getPosition() - from) / (to - from))) * wrap.clientWidth}px)`;
  }, playing);
  return (
    <div className="take-wave" ref={wrapRef} aria-hidden="true">
      <canvas ref={canvasRef} />
      <div className="timeline-head" ref={headRef} />
    </div>
  );
}

// ───────── 노래방 무대 ─────────
/** 무대의 내용물. 바깥 틀(main.stage)은 녹음 화면이 들고 있다 (유튜브 영상을 같은 자리에 두려고). */
function Stage({
  room,
  roll,
  getPosition,
  meterRef,
  passLabel,
  onCancel,
  onSinging,
  ready,
  tapHint,
  video,
}: {
  room: Room;
  roll: { pass: Pass; plan: PassPlan; tZero: number };
  getPosition: () => number;
  meterRef: React.RefObject<HTMLDivElement>;
  passLabel: string;
  onCancel: () => void;
  onSinging: (on: boolean) => void;
  /** 반주가 실제로 돌기 시작했는지 (유튜브 영상은 시작까지 잠깐 걸린다) */
  ready: boolean;
  /** 브라우저가 막아서 영상을 직접 눌러 줘야 하는 상태 */
  tapHint: boolean;
  video: boolean;
}) {
  const { plan, pass } = roll;
  const names = useMemo(() => seatNames(room), [room]);
  const lines = useMemo(() => [...room.lines].filter((l) => l.t1 > plan.from - 0.5 && l.t0 < plan.until + 0.5).sort((a, b) => a.t0 - b.t0), [room.lines, plan]);
  const mineSet = useMemo(() => new Set(pass.lines.map((l) => l.id)), [pass]);
  const [idx, setIdx] = useState(-1);
  const [singing, setSinging] = useState(false);
  const [count, setCount] = useState(0);
  const fillRef = useRef<HTMLParagraphElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const lastStart = useRef('');
  const span = plan.until - plan.from;
  // 영상이 몇 초가 지나도 시작하지 않으면(보통 영상 앞 광고) 기다리면 된다고 알려 준다
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (ready) return setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), 4000);
    return () => window.clearTimeout(timer);
  }, [ready]);

  useEffect(() => {
    onSinging(singing);
  }, [singing, onSinging]);
  useEffect(() => () => onSinging(false), [onSinging]);

  useRaf(() => {
    const pos = getPosition();
    let cur = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].t0 <= pos + 0.03) cur = i;
    if (cur !== idx) setIdx(cur);
    const line = cur >= 0 ? lines[cur] : null;
    const inMine = ready && pass.lines.some((l) => pos >= l.t0 - 0.05 && pos <= l.t1 + 0.1);
    if (inMine !== singing) setSinging(inMine);
    if (fillRef.current && line) fillRef.current.style.setProperty('--p', `${Math.max(0, Math.min(1, (pos - line.t0) / Math.max(0.2, line.t1 - line.t0))) * 100}%`);
    if (headRef.current) headRef.current.style.left = `${Math.max(0, Math.min(1, (pos - plan.from) / span)) * 100}%`;
    // 내 다음 줄까지 남은 시간으로 카운트다운
    const next = pass.lines.find((l) => l.t0 > pos);
    const lead = next ? next.t0 - pos : 0;
    const prevMine = next ? [...pass.lines].reverse().find((l) => l.t1 <= next.t0) : undefined;
    const fresh = next && (!prevMine || next.t0 - prevMine.t1 > 1.6);
    const c = ready && fresh && lead <= 3.05 ? Math.ceil(lead) : 0;
    if (c !== count) setCount(c);
    // 내 줄이 시작하는 순간 진동
    const started = pass.lines.find((l) => pos >= l.t0 && pos < l.t0 + 0.12);
    if (ready && started && lastStart.current !== started.id) {
      lastStart.current = started.id;
      if (navigator.vibrate) navigator.vibrate(35);
    }
  }, true);

  const label = (l: Line) => {
    if (mineSet.has(l.id)) return isAll(l, room.seatCount) ? '다같이 (나도)' : l.seats.length > 1 ? '같이 불러요' : '내 차례';
    if (isAll(l, room.seatCount)) return '다같이';
    return l.seats.map((s) => names[s] || seatName(s)).join(', ');
  };
  // 지금 줄이 늘 같은 자리에 오도록 네 칸(지난 줄 · 지금 줄 · 다음 두 줄)을 고정해 둔다
  const nowIdx = Math.max(idx, 0);
  const slots = [nowIdx - 1, nowIdx, nowIdx + 1, nowIdx + 2];

  return (
    <>
      <header className="stage-top">
        <button className="icon-btn" onClick={onCancel} aria-label="녹음 그만하기">
          <Icon name="close" />
        </button>
        <div className="stage-progress" aria-hidden="true">
          {pass.lines.map((l) => (
            <i key={l.id} style={{ left: `${((l.t0 - plan.from) / span) * 100}%`, width: `${((l.t1 - l.t0) / span) * 100}%` }} />
          ))}
          <b ref={headRef} />
        </div>
        <span className="stage-pass">{passLabel}</span>
      </header>

      <div className="stage-status" aria-live="polite">
        {!ready ? (
          tapHint ? (
            <span className="waiting stage-prep">영상이 멈춰 있으면 ▶ 를 눌러 주세요. 광고가 나오는 중이면 끝날 때까지 기다려요.</span>
          ) : (
            <span className="waiting stage-prep is-col">
              <span className="stage-prep-row">
                <span className="spinner" /> 영상을 준비하는 중…
              </span>
              {slow && <small>광고가 나오면 끝난 뒤에 시작해요.</small>}
            </span>
          )
        ) : singing ? (
          <span className="on-air">
            <span className="rec-dot" /> 지금 불러요
          </span>
        ) : count > 0 ? (
          <span className="countdown" aria-label={`${count}초 뒤 내 차례`}>
            {[3, 2, 1].map((n) => (
              <i key={n} className={n <= count ? 'is-on' : ''} />
            ))}
            <em>곧 내 차례</em>
          </span>
        ) : (
          <span className="waiting">듣는 중</span>
        )}
      </div>

      <div className="stage-lines">
        {slots.map((i, slot) => {
          const l = i >= 0 && i < lines.length ? lines[i] : null;
          if (!l) return <div key={`empty-${slot}`} className={`k-line k-slot-${slot}`} />;
          const mine = mineSet.has(l.id);
          const started = idx >= 0;
          const cls = slot === 0 ? 'is-past' : slot === 1 ? (started ? 'is-now' : 'is-now is-waiting') : 'is-next';
          return (
            <div key={l.id} className={`k-line k-slot-${slot} ${cls}${mine ? ' is-mine' : ''}`}>
              <small style={mine ? undefined : ({ '--c': seatColor(l.seats[0] ?? 0) } as React.CSSProperties)}>{label(l)}</small>
              <p ref={slot === 1 && started ? fillRef : undefined}>{l.text || (mine ? '내 차례!' : '다른 파트')}</p>
            </div>
          );
        })}
      </div>

      <footer className="stage-bottom">
        <div className="meter" aria-hidden="true">
          <div ref={meterRef} />
        </div>
        <p>
          <span className="rec-dot" /> 녹음 중이에요. 끝까지 가면 자동으로 멈춰요.{video ? ' 영상은 누르지 말아 주세요.' : ''}
        </p>
      </footer>
    </>
  );
}
