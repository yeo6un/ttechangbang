// 방 만들기 마법사: 노래 찾기 → 반주(MR 파일)와 원곡 영상(가이드) → 부를 구간 → 영상과 MR 맞추기 → 가사·타이밍 → 파트 나누기 → 방 번호 받기
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type FoundSong, type FoundVideo, type GuideRef, type Identity } from '../lib/api';
import { bestWindow, detectTempo, normalizeBacking } from '../lib/audio/analysis';
import { decodeFile, encodeWithLead } from '../lib/audio/codec';
import { getCtx, unlockAudio } from '../lib/audio/context';
import { DEMO_BPM, DEMO_LINES, renderDemoBeat } from '../lib/audio/demo';
import { mixToMono } from '../lib/audio/dsp';
import { seedAudio } from '../lib/audio/library';
import { LEAD_SEC } from '../lib/audio/marker';
import { bytesToBase64, computePeaks } from '../lib/audio/peaks';
import { Transport, type Deck } from '../lib/audio/transport';
import { guessFromVideoTitle, loadLyrics, loadVideo, searchSongs, type SongSearch } from '../lib/find';
import { alignWords, evenStarts, linesFromSegments, linesFromStarts, parseLyrics, parseSynced, rangeToLines, shiftLines, type RangePick } from '../lib/lyrics';
import { autoAssign, blankLines, fmtTime, newLineId, type Line } from '../lib/parts';
import { fmtCode, navigate, roomLink } from '../lib/router';
import { store } from '../lib/store';
import { YtDeck } from '../lib/yt/deck';
import { parseYtId, ytThumb } from '../lib/yt/ids';
import { useYtPlayer, YtFrame, YtTapNote } from '../lib/yt/useYt';
import { copyText, Icon, Toggle, TopBar, useToast } from '../ui';
import { AlignStep } from './create/AlignStep';
import { PreviewButton, TrimBox, type Source } from './create/FileTrim';
import { RangeLines, type LineRange } from './create/RangeLines';
import { RangeTime } from './create/RangeTime';
import { SongFinder } from './create/SongFinder';
import { SourcePicker, type LyrState } from './create/SourcePicker';
import { TapSync } from './create/TapSync';
import { lookUpVideo, type VideoPick } from './create/YtLinkInput';
import { PartsEditor } from './PartsEditor';

type Step = 'song' | 'source' | 'trim' | 'range' | 'align' | 'lyrics' | 'timing' | 'tap' | 'parts' | 'done';
/** 반주를 무엇으로 쓰는지: yt = 유튜브 영상 그대로, file = 올린 MR 파일(원곡 영상을 가이드로 붙일 수 있다), demo = 연습용 비트 */
type Mode = 'yt' | 'file' | 'demo';
/** 위쪽 진행 막대의 다섯 칸 가운데 몇 번째인지 */
const STEP_INDEX: Record<Step, number> = { song: 0, source: 0, trim: 1, range: 1, align: 1, lyrics: 2, timing: 3, tap: 3, parts: 4, done: 5 };
const LENGTHS = [30, 45, 60, 90];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 파일 이름에서 곡을 어림한다 (가사를 찾아볼 검색어로 쓴다) */
const guessFromFileName = (name: string) =>
  cleanTitle(name)
    .replace(/[\[(（【][^\])）】]*[\])）】]/g, ' ')
    .replace(/\b(mr|inst(rumental)?|karaoke|official|audio|off\s*vocal)\b\.?/gi, ' ')
    .replace(/반주|노래방|엠알/g, ' ')
    .replace(/[-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

interface Segment {
  buffer: AudioBuffer;
  peaks: string;
  bpm: number;
  beat0: number;
}

type Upload = { state: 'idle' } | { state: 'working'; label: string; progress: number } | { state: 'ready' } | { state: 'failed'; message: string };

function sliceBuffer(src: AudioBuffer, start: number, len: number): AudioBuffer {
  const sr = src.sampleRate;
  const a = Math.max(0, Math.round(start * sr));
  const n = Math.max(1, Math.min(src.length - a, Math.round(len * sr)));
  const chs = Math.min(2, src.numberOfChannels);
  const out = getCtx().createBuffer(chs, n, sr);
  const fade = Math.min(n >> 1, Math.round(sr * 0.03));
  const data = Array.from({ length: chs }, (_, c) => src.getChannelData(c).slice(a, a + n));
  normalizeBacking(data);
  data.forEach((d, c) => {
    for (let i = 0; i < fade; i++) {
      d[i] *= i / fade;
      d[n - 1 - i] *= i / fade;
    }
    out.copyToChannel(d, c);
  });
  return out;
}

const bufferChannels = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
const cleanTitle = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 60);

export function Create() {
  const toast = useToast();
  const [step, setStep] = useState<Step>('song');
  const [cfg, setCfg] = useState({ ai: false, ytSearch: false, ytSeconds: 330, songSeconds: 330, aiSeconds: 130 });
  const [opening, setOpening] = useState(false);

  // 곡 찾기
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState<SongSearch | null>(null);
  const [song, setSong] = useState<FoundSong | null>(null);
  const [lyr, setLyr] = useState<Omit<LyrState, 'syncedLines'>>({ state: 'idle', data: null });
  const [cand, setCand] = useState<{ q: string; busy: boolean; search: SongSearch | null }>({ q: '', busy: false, search: null });
  const findRun = useRef(0);

  // 유튜브 반주
  const [video, setVideo] = useState<VideoPick | null>(null);
  const [alts, setAlts] = useState<FoundVideo[]>([]);
  const [finding, setFinding] = useState(false);
  const [seg, setSeg] = useState<{ start: number; dur: number } | null>(null);
  const [lineRange, setLineRange] = useState<LineRange | null>(null);
  const [ytTap, setYtTap] = useState(false);
  const [checking, setChecking] = useState(false);
  /** 실제로 재생되는 것을 확인한 영상 */
  const playable = useRef('');
  const ytDeckRef = useRef<YtDeck | null>(null);
  const draftKey = useRef('');

  // 파일 반주
  const [source, setSource] = useState<Source | null>(null);
  const [loadingFile, setLoadingFile] = useState('');
  const [sel, setSel] = useState({ start: 0, len: 45 });
  const [segment, setSegment] = useState<Segment | null>(null);
  const [fileFrom, setFileFrom] = useState<'song' | 'source'>('song');

  // MR 파일 + 원곡 영상(가이드)
  /** 영상 시각 − MR 시각(초): 같은 순간이 영상에서는 MR 보다 이만큼 뒤에 있다 */
  const [gOff, setGOff] = useState(0);
  /** 처음 어림한 값. 귀로 맞춰 옮긴 뒤에는 바꾸지 않는다. */
  const [gBase, setGBase] = useState(0);
  const [gTouched, setGTouched] = useState(false);
  const [guideLoose, setGuideLoose] = useState(false);
  const [guide, setGuide] = useState<GuideRef | null>(null);
  const [slicing, setSlicing] = useState(false);

  // 공통
  const [title, setTitle] = useState('');
  const titleTouched = useRef(false);
  const [upload, setUpload] = useState<Upload>({ state: 'idle' });
  const [draft, setDraft] = useState<{ code: string; who: Identity } | null>(null);
  const [lyrics, setLyrics] = useState('');
  const [texts, setTexts] = useState<string[]>([]);
  const [timed, setTimed] = useState<Line[] | null>(null);
  const [timingNote, setTimingNote] = useState('');
  const [parts, setParts] = useState<Line[]>([]);
  const [partsFrom, setPartsFrom] = useState<Step>('timing');
  const [seatCount, setSeatCount] = useState(4);
  const [blind, setBlind] = useState(false);
  const [hostName, setHostName] = useState(() => store.name());
  const [aiBusy, setAiBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const runId = useRef(0);
  const transportRef = useRef<Transport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const mode: Mode = source ? (source.demo ? 'demo' : 'file') : 'yt';
  /** MR 파일로 부르면서 원곡 영상을 가이드로 붙이는 방 */
  const guided = mode === 'file' && !!video;
  /** 가이드 영상이 MR과 맞아서, 영상을 틀어 가사 타이밍을 확인해도 되는지 */
  const guideSynced = guided && !guideLoose;
  // 영상은 반주를 고르는 단계부터 타이밍을 맞추는 단계까지 같은 자리에 둔다
  const showYt =
    !!video &&
    (step === 'source' || step === 'range' || step === 'align' || ((mode === 'yt' || guideSynced) && (step === 'lyrics' || step === 'timing' || step === 'tap')));
  const yt = useYtPlayer(showYt ? video!.id : null, true);
  const sync = useMemo(() => (lyr.data?.synced ? parseSynced(lyr.data.synced) : []), [lyr.data]);
  const hasSync = sync.length >= 2;
  const dur = mode === 'yt' ? (seg?.dur ?? 0) : (segment?.buffer.duration ?? 0);
  const aiOn = cfg.ai;

  useEffect(() => {
    api
      .config()
      .then((c) => setCfg({ ai: c.ai, ytSearch: !!c.ytSearch, ytSeconds: c.limits.ytSeconds || 330, songSeconds: c.limits.songSeconds || 125, aiSeconds: c.limits.aiSeconds || 130 }))
      .catch(() => {});
    return () => transportRef.current?.dispose();
  }, []);

  // 영상 플레이어가 바뀌거나 사라지면 거기에 물려 둔 재생기도 정리한다
  useEffect(
    () => () => {
      ytDeckRef.current?.dispose();
      ytDeckRef.current = null;
      setYtTap(false);
    },
    [yt.player],
  );

  const transport = useCallback(async () => {
    const ctx = await unlockAudio();
    if (!transportRef.current || transportRef.current.ctx !== ctx) transportRef.current = new Transport(ctx);
    return transportRef.current;
  }, []);

  /** 유튜브 반주용 재생기. 사용자가 누른 그 순간에 불러야 소리가 허락된다. */
  const ytDeck = (): YtDeck | null => {
    const p = yt.player;
    if (!p || !seg) return null;
    const ctx = getCtx();
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    const cur = ytDeckRef.current;
    if (!cur || cur.yt !== p || cur.ctx !== ctx || cur.seg.start !== seg.start || cur.seg.dur !== seg.dur) {
      cur?.dispose();
      const d = new YtDeck(ctx, p, seg);
      d.setMix({ backing: 0.8, seats: {}, echo: 0 });
      d.on((e) => {
        if (e.type === 'needTap') setYtTap(e.on);
        else if (e.type === 'failed') toast(e.error.message, 'error');
      });
      ytDeckRef.current = d;
    }
    return ytDeckRef.current;
  };

  /** 지금 반주(파일이든 영상이든)를 트는 재생기 */
  const getDeck = async (): Promise<Deck> => {
    // 가이드 영상이 MR과 맞춰져 있으면 가사 타이밍은 영상(가수 목소리가 들린다)으로 확인한다
    if (mode === 'yt' || guideSynced) {
      const d = ytDeck();
      if (!d) throw new Error('영상이 아직 준비되지 않았어요.');
      return d;
    }
    const t = await transport();
    t.setSong(segment?.buffer ?? null);
    t.setTakes([]);
    return t;
  };

  const stopAudio = () => {
    transportRef.current?.stop();
    ytDeckRef.current?.stop();
    yt.player?.pause();
  };

  // ───────── 1. 곡 찾기 ─────────
  const runSearch = async () => {
    const text = q.trim();
    if (text.length < 2 || searching) return;
    // 검색 칸에 유튜브 링크를 넣은 경우에는 링크로 시작한다
    if (parseYtId(text) && /youtu/i.test(text)) return void startFromLink(text);
    setSearching(true);
    try {
      setSearch(await searchSongs(text, cfg.ai));
    } catch {
      setSearch({ songs: [], down: true });
    } finally {
      setSearching(false);
    }
  };

  const resetWork = () => {
    setSeg(null);
    setLineRange(null);
    setTimed(null);
    setTexts([]);
    setLyrics('');
    setTimingNote('');
  };

  const pickSong = (s: FoundSong, keepVideo = false) => {
    const id = ++findRun.current;
    setSong(s);
    if (!titleTouched.current) setTitle(s.title.slice(0, 60));
    setLyr({ state: 'loading', data: null });
    resetWork();
    loadLyrics(s).then(
      (data) => findRun.current === id && setLyr({ state: 'done', data }),
      () => findRun.current === id && setLyr({ state: 'done', data: { found: false } }),
    );
    if (!keepVideo) {
      // 새 곡으로 처음부터: 골라 둔 영상과 MR 파일은 비운다
      setVideo(null);
      setAlts([]);
      setFinding(false);
      setSource(null);
      setSegment(null);
      if (cfg.ytSearch) {
        setFinding(true);
        loadVideo(s)
          .then((r) => {
            if (findRun.current !== id || !r) return;
            setVideo(r.video);
            setAlts(r.alts);
          })
          .catch(() => {})
          .finally(() => findRun.current === id && setFinding(false));
      }
    }
    setStep('source');
  };

  const pickVideo = (v: VideoPick | null) => {
    stopAudio();
    const prev = video;
    setVideo(v);
    setSeg(null);
    setLineRange(null);
    setGTouched(false);
    setGuideLoose(false);
    // 바꾸기 전 영상은 "다른 영상" 목록에 남겨 둔다
    if (v) setAlts((cur) => [...(prev && prev.id !== v.id ? [{ ...prev, thumb: ytThumb(prev.id) }] : []), ...cur.filter((a) => a.id !== v.id && a.id !== prev?.id)].slice(0, 5));
  };

  const runCandSearch = async (text: string) => {
    if (text.trim().length < 2) return;
    setCand((c) => ({ ...c, busy: true }));
    try {
      const out = await searchSongs(text.trim(), cfg.ai);
      setCand((c) => ({ ...c, busy: false, search: out }));
    } catch {
      setCand((c) => ({ ...c, busy: false, search: { songs: [], down: true } }));
    }
  };

  /** 링크로 시작: 영상부터 정하고, 영상 제목으로 가사를 찾아본다 */
  const startWithVideo = (v: VideoPick) => {
    ++findRun.current;
    setSong(null);
    setLyr({ state: 'idle', data: null });
    setAlts([]);
    setFinding(false);
    setVideo(v);
    setSource(null);
    setSegment(null);
    resetWork();
    const guess = guessFromVideoTitle(v.title, v.author);
    if (!titleTouched.current) setTitle(guess.slice(0, 60));
    setCand({ q: guess, busy: false, search: null });
    if (guess.length >= 2) void runCandSearch(guess);
    setStep('source');
  };

  const startFromLink = async (text: string) => {
    try {
      startWithVideo(await lookUpVideo(text));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // 다른 앱(유튜브)의 "공유"로 넘어온 주소가 있으면 그 영상으로 바로 시작한다
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    const shared = [p.get('url'), p.get('text'), p.get('title')].find((x) => x && parseYtId(x));
    if (shared) void startFromLink(shared);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ───────── 2-가. 유튜브 영상으로 ─────────
  /**
   * 구간을 고르러 가기 전에 영상을 잠깐 틀어 본다. 올린 사람이 다른 사이트에서의 재생을 막아 둔 영상은
   * 틀어 봐야 알 수 있어서, 방을 다 만든 뒤에야 "재생이 안 돼요"가 되는 일을 막으려는 것이다.
   */
  const sourceNext = async () => {
    if (checking) return;
    const p = yt.player;
    if (video && p) {
      if (playable.current !== video.id) {
        setChecking(true);
        try {
          await p.confirmPlayable(setYtTap);
          p.pause();
          playable.current = video.id;
        } catch (e) {
          toast(e instanceof Error ? e.message : '영상을 재생하지 못했어요. 다른 영상을 골라 주세요.', 'error');
          return;
        } finally {
          setChecking(false);
          setYtTap(false);
        }
      }
      return setStep('range');
    }
    if (source) {
      // 영상을 고르지 않았거나 영상이 열리지 않을 때: MR만으로 간다
      if (video) pickVideo(null);
      setStep('trim');
    }
  };

  const prepareYt = async (s: { start: number; dur: number }) => {
    if (!video) return;
    const len = Math.round(yt.player?.duration || video.len || 0);
    const key = `${video.id}:${s.start}:${s.dur}`;
    if (draftKey.current === key && draft) return;
    const id = ++runId.current;
    draftKey.current = '';
    setDraft(null);
    setUpload({ state: 'working', label: '방을 준비하는 중', progress: 0.5 });
    try {
      const created = await api.createRoom({
        title: title.trim() || '이름 없는 방',
        hostName: store.name() || '방장',
        seatCount,
        song: { dur: s.dur, lead: 0, peaks: '', name: song?.title || video.title, artist: song?.artist || '', bpm: 0, beat0: 0, demo: false, yt: { id: video.id, start: s.start, len, title: video.title, author: video.author } },
      });
      if (runId.current !== id) return;
      store.setIdentity(created.code, created.member);
      draftKey.current = key;
      setDraft({ code: created.code, who: created.member });
      setUpload({ state: 'ready' });
    } catch (e) {
      if (runId.current !== id) return;
      setUpload({ state: 'failed', message: e instanceof ApiError ? e.message : '방을 준비하지 못했어요.' });
    }
  };

  const confirmLines = (pick: RangePick, range: LineRange) => {
    stopAudio();
    const s = { start: pick.start, dur: pick.dur };
    setLineRange(range);
    setSeg(s);
    if (guided) {
      // MR은 음원과 같은 시간표라고 보고 시작한다: 가사를 영상에 맞추느라 민 만큼 영상이 MR 보다 뒤에 있다
      if (!gTouched) {
        setGOff(range.shift);
        setGBase(range.shift);
      }
      return setStep('align');
    }
    setTexts(pick.lines.map((l) => l.text));
    setTimed(pick.lines);
    setTimingNote('');
    setParts(autoAssign(pick.lines, seatCount, 'smart'));
    setPartsFrom('range');
    setStep('parts');
    void prepareYt(s);
  };

  const confirmTime = (s: { start: number; dur: number }) => {
    stopAudio();
    setSeg(s);
    if (guided) {
      if (!gTouched) {
        setGOff(0);
        setGBase(0);
      }
      return setStep('align');
    }
    setTimed(null);
    if (!lyrics.trim() && lyr.data?.plain) setLyrics(lyr.data.plain);
    setStep('lyrics');
    void prepareYt(s);
  };

  // ───────── 2-나. 노래 파일로 ─────────
  const chooseFile = (from: 'song' | 'source') => {
    setFileFrom(from);
    fileRef.current?.click();
  };

  const openFile = async (file: File) => {
    if (file.size > 200 * 1024 * 1024) return toast('파일이 너무 커요. 200MB 이하 파일로 해 주세요.', 'error');
    setLoadingFile(file.name);
    try {
      stopAudio();
      await unlockAudio();
      const buffer = await decodeFile(file, getCtx());
      if (buffer.duration < 8) throw new Error('short');
      const mono = mixToMono(bufferChannels(buffer));
      const len = Math.min(45, Math.floor(buffer.duration));
      setSource({ buffer, name: file.name, demo: false, peaks: computePeaks(mono, 900) });
      setSel({ start: Math.min(bestWindow(mono, buffer.sampleRate, len), Math.max(0, buffer.duration - len)), len });
      setSegment(null);
      setGTouched(false);
      setGuideLoose(false);
      // 곡을 찾아 둔 상태가 아니면 파일 이름을 방 이름으로 쓴다
      if (!titleTouched.current && !(fileFrom === 'source' && (song || video))) setTitle(cleanTitle(file.name));
      if (fileFrom === 'song') {
        // 첫 화면에서 파일로 시작: 곡·영상은 비우고, 파일 이름으로 가사를 찾아본다
        ++findRun.current;
        setSong(null);
        setLyr({ state: 'idle', data: null });
        setLyrics('');
        setVideo(null);
        setAlts([]);
        setFinding(false);
        resetWork();
        const guess = guessFromFileName(file.name);
        setCand({ q: guess, busy: false, search: null });
        if (guess.length >= 2) void runCandSearch(guess);
      }
      setTimed(null);
      setStep('source');
    } catch (e) {
      toast((e as Error).message === 'short' ? '8초보다 긴 파일을 골라 주세요.' : '이 파일은 열 수 없어요. mp3, m4a, wav 같은 음악 파일로 다시 해 주세요.', 'error');
    } finally {
      setLoadingFile('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const useDemo = async () => {
    const ctx = await unlockAudio();
    const { left, right } = renderDemoBeat(ctx.sampleRate);
    normalizeBacking([left, right]);
    const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
    buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
    const peaks = computePeaks(mixToMono([left, right]), 400);
    setSource({ buffer, name: '연습용 비트', demo: true, peaks });
    setTitle('연습용 비트');
    const s: Segment = { buffer, peaks: bytesToBase64(peaks), bpm: DEMO_BPM, beat0: 0 };
    setSegment(s);
    const lines = DEMO_LINES.map((l) => ({ ...l, id: newLineId(), seats: [] as number[] }));
    setTexts(lines.map((l) => l.text));
    setTimed(lines);
    setParts(autoAssign(lines, seatCount, 'smart'));
    setVideo(null);
    setPartsFrom('song');
    setStep('parts');
    void prepare(s, '연습용 비트', '연습용 비트', true);
  };

  /** 고른 구간을 작게 줄여 방에 올린다 (화면은 다음 단계로 먼저 넘어간다) */
  const prepare = async (s: Segment, roomTitle: string, fileName: string, demo: boolean, guideRef: GuideRef | null = null) => {
    const id = ++runId.current;
    draftKey.current = '';
    setDraft(null);
    setUpload({ state: 'working', label: '반주를 작게 줄이는 중', progress: 0 });
    try {
      // 긴 반주(한 곡 전체)는 조금 더 줄여서 올린다
      const bytes = await encodeWithLead(bufferChannels(s.buffer), s.buffer.sampleRate, s.buffer.duration > 150 ? 5 : 4, (p) => {
        if (runId.current === id) setUpload({ state: 'working', label: '반주를 작게 줄이는 중', progress: p * 0.7 });
      });
      if (runId.current !== id) return;
      setUpload({ state: 'working', label: '방에 올리는 중', progress: 0.75 });
      const created = await api.createRoom({
        title: roomTitle || '이름 없는 방',
        hostName: store.name() || '방장',
        seatCount,
        song: {
          dur: s.buffer.duration,
          lead: LEAD_SEC,
          peaks: s.peaks,
          name: demo ? fileName : song?.title || fileName,
          artist: demo ? '' : song?.artist || '',
          bpm: s.bpm,
          beat0: s.beat0,
          demo,
          ...(guideRef ? { guide: guideRef } : {}),
        },
      });
      if (runId.current !== id) return;
      store.setIdentity(created.code, created.member);
      const room = await api.putSong(created.code, created.member, bytes);
      if (runId.current !== id) return;
      if (room.song.blob) seedAudio(room.song.blob, s.buffer);
      setDraft({ code: created.code, who: created.member });
      setUpload({ state: 'ready' });
    } catch (e) {
      if (runId.current !== id) return;
      setUpload({ state: 'failed', message: e instanceof ApiError ? e.message : '반주를 올리지 못했어요.' });
    }
  };

  /** MR 파일에서 고른 구간을 잘라 낸다 */
  const cutSegment = (src: AudioBuffer, start: number, len: number): Segment => {
    const buffer = sliceBuffer(src, start, len);
    const mono = mixToMono(bufferChannels(buffer));
    const tempo = detectTempo(mono, buffer.sampleRate);
    const ok = tempo.confidence > 1.6;
    return { buffer, peaks: bytesToBase64(computePeaks(mono, 400)), bpm: ok ? tempo.bpm : 0, beat0: ok ? tempo.beat0 : 0 };
  };

  const confirmTrim = () => {
    if (!source) return;
    stopAudio();
    const s = cutSegment(source.buffer, sel.start, sel.len);
    setSegment(s);
    setGuide(null);
    setTimed(null);
    if (!lyrics.trim() && lyr.data?.plain) setLyrics(lyr.data.plain);
    setStep('lyrics');
    void prepare(s, title.trim(), source.name, false);
  };

  /**
   * 영상과 MR을 맞춘 값(gOff)으로 MR에서 구간을 잘라 내고, 가사 줄을 MR 시간에 맞춘다.
   * 영상에서 고른 구간·가사 시각은 모두 "영상 시각"이라서, gOff 만큼 빼면 MR 시각이 된다.
   */
  const confirmAlign = async () => {
    if (!source || !video || !seg || slicing) return;
    stopAudio();
    const mrLen = source.buffer.duration;
    let start: number;
    let len: number;
    let lines: Line[] | null = null;
    if (hasSync && lineRange) {
      const pick = rangeToLines(sync, lineRange.a, lineRange.b, lineRange.shift - gOff, mrLen);
      if (!pick.lines.length || pick.dur < 5) return toast('MR 파일에 이 구간이 들어 있지 않아요. MR 타이밍을 다시 확인하거나 다른 구간을 골라 주세요.', 'error');
      start = pick.start;
      len = pick.dur;
      lines = pick.lines;
    } else {
      start = Math.max(0, seg.start - gOff);
      len = Math.min(mrLen, seg.start + seg.dur - gOff) - start;
      if (len < 5) return toast('MR 파일에 이 구간이 들어 있지 않아요. MR 타이밍을 다시 확인하거나 다른 구간을 골라 주세요.', 'error');
    }
    setSlicing(true);
    await sleep(30); // "준비 중" 표시가 먼저 보이게
    try {
      const s = cutSegment(source.buffer, start, len);
      const total = s.buffer.duration;
      const ref: GuideRef = {
        id: video.id,
        start: Math.round((start + gOff) * 1000) / 1000,
        len: Math.round(yt.player?.duration || video.len || 0),
        title: video.title,
        author: video.author,
        ...(guideLoose ? { loose: true } : {}),
      };
      setSel({ start, len: total });
      setSegment(s);
      setGuide(ref);
      setSeg({ start: ref.start, dur: total });
      if (lines) {
        const fit = lines.filter((l) => l.t0 < total - 0.3).map((l) => ({ ...l, t1: Math.min(l.t1, total) }));
        setTexts(fit.map((l) => l.text));
        setTimed(fit);
        if (guideLoose) {
          // 영상과 MR이 딱 맞지 않는 방: 가사 타이밍을 MR로 한 번 확인하고 넘어간다
          setTimingNote('찾아온 가사의 시간표예요. MR을 들어 보며 어긋난 곳은 고쳐 주세요. 전체가 밀려 있으면 "가사 전체" 버튼으로 한꺼번에 옮겨요.');
          setStep('timing');
        } else {
          setTimingNote('');
          setParts(autoAssign(fit, seatCount, 'smart'));
          setPartsFrom('align');
          setStep('parts');
        }
      } else {
        setTimed(null);
        if (!lyrics.trim() && lyr.data?.plain) setLyrics(lyr.data.plain);
        setStep('lyrics');
      }
      void prepare(s, title.trim(), source.name, false, ref);
    } finally {
      setSlicing(false);
    }
  };

  const retryPrepare = () => {
    if (mode === 'yt') {
      if (seg) void prepareYt(seg);
    } else if (segment && source) {
      void prepare(segment, title.trim(), source.name, source.demo, guided ? guide : null);
    }
  };

  // ───────── 3. 가사 ─────────
  /** 구간이 원곡(영상·파일)의 어디에서 시작하는지 */
  const origin = mode === 'yt' ? (seg?.start ?? 0) : sel.start;

  const lyricsNext = () => {
    const parsed = parseLyrics(lyrics);
    if (!parsed.texts.length) return toast('가사를 한 줄 이상 넣어 주세요. 가사가 없으면 아래 "가사 없이 진행"을 눌러 주세요.', 'error');
    setTexts(parsed.texts);
    if (parsed.times) {
      const lines = linesFromStarts(parsed.texts, parsed.times.map((t) => t - origin), dur).filter((l) => l.t0 >= 0);
      if (lines.length) {
        setTimed(lines);
        setTimingNote('가사에 들어 있던 시간표로 타이밍을 맞췄어요. 어긋난 줄만 고쳐 주세요.');
        return setStep('timing');
      }
    }
    setTimed(null);
    setTimingNote('');
    setStep('timing');
  };

  /** 파일 반주: 찾아 둔 가사의 시간표를 그대로 쓴다 (올린 파일이 음원과 같다고 보고) */
  const useFoundSynced = () => {
    const inRange = sync.filter((l) => l.t >= origin - 0.3 && l.t < origin + dur - 0.5);
    if (!inRange.length) return toast('고른 구간에 해당하는 가사 줄이 없어요. 가사를 직접 넣어 주세요.', 'error');
    const lines = linesFromStarts(
      inRange.map((l) => l.text),
      inRange.map((l) => Math.max(0, l.t - origin)),
      dur,
    );
    setTexts(lines.map((l) => l.text));
    setLyrics(lines.map((l) => l.text).join('\n'));
    setTimed(lines);
    setTimingNote('찾아온 가사의 시간표로 맞췄어요. 줄마다 ▶ 로 들어 보고, 전체가 밀려 있으면 "가사 전체" 버튼으로 한꺼번에 옮겨 주세요.');
    setStep('timing');
  };

  const skipLyrics = () => {
    const lines = blankLines(dur, segment?.bpm ?? 0, segment?.beat0 ?? 0);
    setTexts([]);
    setTimed(lines);
    setParts(autoAssign(lines, seatCount, 'smart'));
    setPartsFrom('lyrics');
    setStep('parts');
  };

  // ───────── 4. 타이밍 ─────────
  const timeEvenly = () => {
    setTimed(linesFromStarts(texts, evenStarts(texts, dur), dur));
    setTimingNote('일단 고르게 펼쳤어요. 줄마다 들어 보면서 맞춰 주세요.');
  };

  const timeWithAi = async () => {
    if (!draft) return;
    setAiBusy(true);
    try {
      const hasKo = /[가-힣]/.test(lyrics);
      const hasLatin = /[a-zA-Z]{3,}/.test(lyrics);
      const out = await api.aiAlign(draft.code, draft.who, { lyrics: texts.join('\n'), language: hasKo ? 'ko' : hasLatin ? 'en' : undefined });
      const r = alignWords(texts, out.words, dur);
      setTimed(linesFromStarts(texts, r.starts, dur));
      setTimingNote(
        r.confidence >= 0.45
          ? 'AI가 노래를 듣고 타이밍을 맞췄어요. 줄마다 들어 보고 어긋난 곳만 고쳐 주세요.'
          : 'AI가 가사를 잘 못 알아들었어요. 대략만 맞췄으니 "들으면서 탭하기"로 다시 맞추는 걸 권해요.',
      );
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'AI가 타이밍을 찾지 못했어요. 탭으로 맞춰 주세요.', 'error');
    } finally {
      setAiBusy(false);
    }
  };

  const transcribeWithAi = async () => {
    if (!draft || !segment) return;
    setAiBusy(true);
    try {
      const out = await api.aiAlign(draft.code, draft.who, {});
      const lines = linesFromSegments(out.segments, dur);
      if (!lines.length) throw new ApiError(502, 'ai_failed', 'AI가 가사를 알아듣지 못했어요. 가사를 직접 넣어 주세요.');
      setTexts(lines.map((l) => l.text));
      setLyrics(lines.map((l) => l.text).join('\n'));
      setTimed(lines);
      setTimingNote('AI가 받아쓴 가사예요. 틀린 글자가 있을 수 있어요. 타이밍은 줄마다 들어 보고 고쳐 주세요.');
      setStep('timing');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'AI가 가사를 알아듣지 못했어요.', 'error');
    } finally {
      setAiBusy(false);
    }
  };

  const nudgeLine = (id: string, delta: number) => {
    setTimed((cur) => {
      if (!cur) return cur;
      const moved = cur
        .map((l) => ({ id: l.id, text: l.text, t: l.id === id ? Math.max(0, Math.min(dur - 0.3, l.t0 + delta)) : l.t0 }))
        .sort((x, y) => x.t - y.t);
      return linesFromStarts(moved.map((m) => m.text), moved.map((m) => m.t), dur).map((l, i) => ({ ...l, id: moved[i].id }));
    });
  };

  const shiftAll = (delta: number) => setTimed((cur) => (cur ? shiftLines(cur, delta, dur) : cur));

  const playLine = async (line: Line) => {
    try {
      const d = await getDeck();
      void Promise.resolve(d.play(Math.max(0, line.t0 - 0.6), { until: Math.min(dur, line.t1 + 0.2), withTakes: false })).catch(() => {});
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const timingNext = () => {
    if (!timed?.length) return;
    stopAudio();
    setParts(autoAssign(timed, seatCount, 'smart'));
    setPartsFrom('timing');
    setStep('parts');
  };

  // ───────── 5. 파트 → 방 열기 ─────────
  const openRoom = async () => {
    if (!draft) return;
    const name = hostName.trim();
    if (!name) return toast('내 이름을 적어 주세요. 친구들에게 이 이름으로 보여요.', 'error');
    if (parts.some((l) => !l.seats.length)) return toast('아직 부를 사람이 없는 줄이 있어요.', 'error');
    setOpening(true);
    try {
      store.setName(name);
      await api.setMe(draft.code, draft.who, { name });
      await api.putParts(draft.code, draft.who, parts, seatCount);
      const room = await api.putSettings(draft.code, draft.who, { draft: false, blind, title: title.trim() || undefined });
      store.touchRecent(room, true);
      setStep('done');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '방을 열지 못했어요. 다시 눌러 주세요.', 'error');
    } finally {
      setOpening(false);
    }
  };

  const back = () => {
    stopAudio();
    switch (step) {
      case 'song':
      case 'done':
        return navigate('/');
      case 'source':
        return setStep('song');
      case 'trim':
      case 'range':
        return setStep('source');
      case 'align':
        return setStep('range');
      case 'lyrics':
        return setStep(mode === 'yt' ? 'range' : guided ? 'align' : 'trim');
      case 'timing':
        // 가이드 방에서 찾아온 가사를 바로 쓴 경우에는 가사 넣는 단계를 거치지 않았다
        return setStep(guided && hasSync && lineRange ? 'align' : 'lyrics');
      case 'tap':
        return setStep('timing');
      case 'parts':
        return setStep(partsFrom);
    }
  };

  const shareText = draft ? `떼창방에서 같이 불러요! "${title || '이름 없는 방'}"\n방 번호 ${fmtCode(draft.code)}\n${roomLink(draft.code)}` : '';
  const videoLen = yt.player?.duration || video?.len || 0;

  return (
    <main className="page create">
      <TopBar
        onBack={step === 'done' ? undefined : back}
        title={step === 'done' ? '' : '방 만들기'}
        right={
          step !== 'done' && step !== 'song' ? (
            <ol className="steps" aria-label={`5단계 중 ${STEP_INDEX[step] + 1}단계`}>
              {[0, 1, 2, 3, 4].map((i) => (
                <li key={i} className={i <= STEP_INDEX[step] ? 'is-on' : ''} />
              ))}
            </ol>
          ) : null
        }
      />
      <input ref={fileRef} id="song-file" type="file" accept="audio/*,video/mp4,video/quicktime,video/webm,.mp3,.m4a,.wav,.aac,.flac,.ogg,.opus" hidden onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])} />

      {showYt && <YtFrame yt={yt} className={step === 'range' || step === 'align' ? 'is-sticky' : ''} note={ytTap ? <YtTapNote /> : null} />}

      {step === 'song' && (
        <SongFinder q={q} onQ={setQ} busy={searching} search={search} onSearch={runSearch} onPick={(s) => pickSong(s)} onVideo={startWithVideo} onFile={() => chooseFile('song')} onDemo={useDemo} loadingFile={loadingFile} />
      )}

      {step === 'source' && (
        <SourcePicker
          song={song}
          lyr={{ ...lyr, syncedLines: sync.length }}
          mr={source && !source.demo ? { name: source.name, dur: source.buffer.duration } : null}
          loadingFile={loadingFile}
          video={video}
          finding={finding}
          alts={alts}
          ytReady={!!yt.player}
          ytError={yt.error?.message || ''}
          cand={cand}
          onCandQ={(text) => setCand((c) => ({ ...c, q: text }))}
          onCandSearch={() => void runCandSearch(cand.q)}
          onPickSong={(s) => pickSong(s, true)}
          onVideo={pickVideo}
          onFile={() => chooseFile('source')}
          checking={checking}
          onNext={() => void sourceNext()}
          onChangeSong={() => {
            stopAudio();
            setStep('song');
          }}
        />
      )}

      {step === 'range' &&
        video &&
        (hasSync ? (
          <RangeLines sync={sync} player={yt.player} videoLen={videoLen} lyricsDur={lyr.data?.dur || song?.dur || 0} maxLen={guided ? cfg.songSeconds : cfg.ytSeconds} initial={lineRange} onConfirm={confirmLines} />
        ) : (
          <RangeTime player={yt.player} videoLen={videoLen} maxLen={guided ? cfg.songSeconds : cfg.ytSeconds} initial={seg} onConfirm={confirmTime} />
        ))}

      {step === 'align' && source && video && seg && (
        <>
          <AlignStep
            player={yt.player}
            mr={source.buffer}
            seg={seg}
            offset={gOff}
            base={gBase}
            loose={guideLoose}
            onOffset={(g) => {
              setGOff(g);
              setGTouched(true);
            }}
            onLoose={setGuideLoose}
            onTap={setYtTap}
            onConfirm={() => void confirmAlign()}
          />
          {slicing && (
            <p className="pill" role="status">
              <span className="spinner" /> MR에서 구간을 잘라 내는 중…
            </p>
          )}
        </>
      )}

      {step === 'trim' && source && (
        <section className="stack">
          <h1 className="title">부를 구간을 골라요</h1>
          <p className="lead">가장 신나는 부분을 골라 뒀어요. 밝은 상자를 끌어서 옮길 수 있어요.</p>
          <TrimBox source={source} sel={sel} onChange={setSel} />
          <div className="chips" role="group" aria-label="구간 길이">
            {LENGTHS.filter((l) => l <= source.buffer.duration).map((l) => (
              <button key={l} className={`chip${Math.round(sel.len) === l ? ' is-on' : ''}`} onClick={() => setSel((s) => ({ len: l, start: Math.min(s.start, Math.max(0, source.buffer.duration - l)) }))}>
                {l}초
              </button>
            ))}
            {source.buffer.duration <= cfg.songSeconds && (
              <button className={`chip${sel.len >= source.buffer.duration - 0.5 ? ' is-on' : ''}`} onClick={() => setSel({ start: 0, len: source.buffer.duration })}>
                전체
              </button>
            )}
          </div>
          <div className="trim-nudge">
            <button className="btn btn-ghost btn-sm" onClick={() => setSel((s) => ({ ...s, start: Math.max(0, s.start - 1) }))}>
              1초 앞으로
            </button>
            <PreviewButton source={source} sel={sel} getTransport={transport} />
            <button className="btn btn-ghost btn-sm" onClick={() => setSel((s) => ({ ...s, start: Math.min(source.buffer.duration - s.len, s.start + 1) }))}>
              1초 뒤로
            </button>
          </div>
          <div className="bottom-bar">
            <button className="btn btn-primary btn-xl" onClick={confirmTrim}>
              이 구간으로 할게요
            </button>
          </div>
        </section>
      )}

      {step === 'lyrics' && (
        <section className="stack">
          <h1 className="title">가사를 넣어 주세요</h1>
          <p className="lead">고른 구간의 가사만, 한 줄에 한 소절씩 넣어요. 녹음할 때 노래방처럼 보여 줘요.</p>
          <UploadPill upload={upload} quiet={mode === 'yt'} onRetry={retryPrepare} />
          {mode === 'file' && hasSync && (
            <div className="card">
              <h3 className="card-title">
                <Icon name="spark" size={20} /> 찾아 둔 가사가 있어요
              </h3>
              <p className="hint">줄마다 타이밍까지 들어 있어요. 올린 파일이 음원 그대로라면 바로 맞아요.</p>
              <button className="btn btn-primary" onClick={useFoundSynced}>
                찾아 둔 가사 쓰기
              </button>
            </div>
          )}
          {!!lyr.data?.plain && lyrics === lyr.data.plain && <p className="hint">찾아온 곡 전체 가사예요. 고른 구간에 없는 줄은 지워 주세요.</p>}
          <textarea id="lyrics" className="input lyrics-input" rows={9} value={lyrics} onChange={(e) => setLyrics(e.target.value)} placeholder={'첫 소절\n둘째 소절\n셋째 소절…'} />
          {aiOn && mode === 'file' && !guided && dur <= cfg.aiSeconds && (
            <button className="btn btn-secondary" disabled={!draft || aiBusy} onClick={transcribeWithAi}>
              <Icon name="spark" size={18} />
              {aiBusy ? 'AI가 듣는 중…' : draft ? 'AI에게 가사 받아쓰기 맡기기' : '노래가 올라가면 AI를 쓸 수 있어요'}
            </button>
          )}
          <div className="bottom-bar">
            <button className="btn btn-primary btn-xl" onClick={lyricsNext} disabled={!lyrics.trim()}>
              다음: 타이밍 맞추기
            </button>
            <button className="btn btn-ghost" onClick={skipLyrics}>
              가사 없이 진행
            </button>
          </div>
        </section>
      )}

      {step === 'timing' && dur > 0 && (
        <section className="stack">
          <h1 className="title">가사 타이밍을 맞춰요</h1>
          {!timed ? (
            <>
              <p className="lead">각 줄이 노래의 어디에서 시작하는지 알려 주세요. 방법을 하나 골라요.</p>
              <UploadPill upload={upload} quiet={mode === 'yt'} onRetry={retryPrepare} />
              <div className="choice-list">
                {aiOn && mode === 'file' && !guided && dur <= cfg.aiSeconds && (
                  <button className="choice" disabled={!draft || aiBusy} onClick={timeWithAi}>
                    <Icon name="spark" />
                    <span>
                      <strong>{aiBusy ? 'AI가 노래를 듣는 중…' : 'AI로 자동 맞추기'}</strong>
                      <small>{draft ? '10~30초쯤 걸려요. 끝나면 줄마다 확인할 수 있어요.' : '반주가 다 올라가면 누를 수 있어요.'}</small>
                    </span>
                  </button>
                )}
                <button className="choice" onClick={() => setStep('tap')}>
                  <Icon name="tap" />
                  <span>
                    <strong>들으면서 탭하기</strong>
                    <small>노래를 들으며 줄이 시작할 때마다 화면을 눌러요. 가장 정확해요.</small>
                  </span>
                </button>
                <button className="choice" onClick={timeEvenly}>
                  <Icon name="clock" />
                  <span>
                    <strong>고르게 나누기</strong>
                    <small>일단 같은 간격으로 펼친 뒤, 줄마다 직접 고쳐요.</small>
                  </span>
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="lead">{timingNote || '줄마다 ▶ 로 들어 보고, 빠르거나 느리면 − / + 로 옮겨 주세요.'}</p>
              <div className="shift-all" role="group" aria-label="가사 전체 옮기기">
                <span>가사 전체</span>
                <button className="btn btn-secondary btn-sm" onClick={() => shiftAll(-0.5)}>
                  0.5초 앞으로
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => shiftAll(0.5)}>
                  0.5초 뒤로
                </button>
              </div>
              <ol className="timing-list">
                {timed.map((l) => (
                  <li key={l.id}>
                    <button className="icon-btn" onClick={() => playLine(l)} aria-label={`${l.text} 들어 보기`}>
                      <Icon name="play" size={18} />
                    </button>
                    <span className="timing-text">
                      <small>{fmtTime(l.t0)}</small>
                      {l.text}
                    </span>
                    <button className="icon-btn" onClick={() => nudgeLine(l.id, -0.2)} aria-label="0.2초 앞으로">
                      <Icon name="minus" size={18} />
                    </button>
                    <button className="icon-btn" onClick={() => nudgeLine(l.id, 0.2)} aria-label="0.2초 뒤로">
                      <Icon name="plus" size={18} />
                    </button>
                  </li>
                ))}
              </ol>
              <div className="bottom-bar">
                <button className="btn btn-primary btn-xl" onClick={timingNext}>
                  다음: 파트 나누기
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    stopAudio();
                    setTimed(null);
                  }}
                >
                  다른 방법으로 다시 맞추기
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {step === 'tap' && dur > 0 && (
        <TapSync
          texts={texts}
          dur={dur}
          getDeck={getDeck}
          video={mode === 'yt' || guideSynced}
          onCancel={() => setStep('timing')}
          onDone={(starts) => {
            const lines = linesFromStarts(texts.slice(0, starts.length), starts, dur);
            if (lines.length < texts.length) toast(`구간 안에 들어온 ${lines.length}줄만 썼어요.`);
            setTimed(lines);
            setTimingNote('탭한 대로 맞췄어요. 줄마다 ▶ 로 확인해 보세요.');
            setStep('timing');
          }}
        />
      )}

      {step === 'parts' && dur > 0 && (
        <section className="stack">
          <h1 className="title">파트를 나눠요</h1>
          <p className="lead">일단 고르게 나눠 뒀어요. 친구들은 방에 들어와서 원하는 색을 고르면 돼요.</p>
          <UploadPill upload={upload} quiet={mode === 'yt'} onRetry={retryPrepare} />
          <PartsEditor
            lines={parts}
            seatCount={seatCount}
            dur={dur}
            songPeaks={mode === 'yt' ? '' : (segment?.peaks ?? '')}
            ai={draft && texts.length ? draft : null}
            aiAvailable={aiOn}
            onChange={(l, n) => {
              setParts(l);
              setSeatCount(n);
            }}
          />
          <div className="card">
            <Toggle id="blind" checked={blind} onChange={setBlind} label="블라인드 모드" hint="모두 녹음을 마칠 때까지 서로의 녹음을 들을 수 없어요. 다 모이면 한꺼번에 공개해요." />
          </div>
          <label className="field">
            <span>방 이름</span>
            <input
              id="room-title"
              className="input"
              value={title}
              maxLength={60}
              onChange={(e) => {
                titleTouched.current = true;
                setTitle(e.target.value);
              }}
              placeholder="친구들에게 보일 방 이름"
            />
          </label>
          <label className="field">
            <span>내 이름</span>
            <input id="host-name" className="input" value={hostName} maxLength={16} onChange={(e) => setHostName(e.target.value)} placeholder="친구들에게 보일 이름" autoComplete="nickname" />
          </label>
          <div className="bottom-bar">
            <button className="btn btn-primary btn-xl" onClick={openRoom} disabled={!draft || opening}>
              {opening ? '방 여는 중…' : draft ? '방 열고 번호 받기' : upload.state === 'failed' ? '다시 준비해 주세요' : mode === 'yt' ? '방을 준비하는 중…' : '반주 올리는 중…'}
            </button>
          </div>
        </section>
      )}

      {step === 'done' && draft && (
        <section className="stack done">
          <p className="eyebrow-plain">방이 열렸어요</p>
          <h1 className="title">{title || '이름 없는 방'}</h1>
          <div className="code-show" aria-label={`방 번호 ${draft.code.split('').join(' ')}`}>
            {fmtCode(draft.code)}
          </div>
          <p className="lead center">이 번호나 링크를 친구들에게 보내 주세요. 방은 7일 동안 열려 있어요.</p>
          <button
            className="btn btn-primary btn-xl"
            onClick={async () => {
              const ok = await copyText(shareText);
              setCopied(ok ? 'text' : '');
              toast(ok ? '초대 글을 복사했어요. 채팅방에 붙여 넣어 주세요.' : '복사하지 못했어요. 번호를 직접 알려 주세요.', ok ? 'info' : 'error');
            }}
          >
            <Icon name={copied === 'text' ? 'check' : 'copy'} />
            초대 글 복사하기
          </button>
          {typeof navigator.share === 'function' && (
            <button className="btn btn-secondary btn-xl" onClick={() => navigator.share({ text: shareText }).catch(() => {})}>
              <Icon name="share" />
              다른 앱으로 보내기
            </button>
          )}
          <button className="btn btn-secondary btn-xl" onClick={() => navigate(`/r/${draft.code}`)}>
            방으로 들어가기
          </button>
        </section>
      )}
    </main>
  );
}

/** 방 준비 상황. quiet: 올릴 파일이 없는 유튜브 반주에서는 잘 됐을 때 아무것도 보여 주지 않는다. */
function UploadPill({ upload, onRetry, quiet }: { upload: Upload; onRetry: () => void; quiet?: boolean }) {
  if (upload.state === 'idle') return null;
  if (upload.state === 'ready')
    return quiet ? null : (
      <p className="pill pill-ok">
        <Icon name="check" size={16} /> 반주가 방에 올라갔어요
      </p>
    );
  if (upload.state === 'failed')
    return (
      <p className="pill pill-bad">
        {upload.message}
        <button className="link-btn" onClick={onRetry}>
          {quiet ? '다시 시도' : '다시 올리기'}
        </button>
      </p>
    );
  if (quiet) return null;
  return (
    <p className="pill">
      <span className="spinner" /> {upload.label} {Math.round(upload.progress * 100)}%
    </p>
  );
}

