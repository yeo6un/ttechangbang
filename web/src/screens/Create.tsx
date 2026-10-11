// 방 만들기 마법사: 노래 고르기 → 구간 고르기 → 가사·타이밍 → 파트 나누기 → 방 번호 받기
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Identity } from '../lib/api';
import { bestWindow, detectTempo, normalizeBacking } from '../lib/audio/analysis';
import { decodeFile, encodeWithLead } from '../lib/audio/codec';
import { getCtx, unlockAudio } from '../lib/audio/context';
import { DEMO_BPM, DEMO_LINES, renderDemoBeat } from '../lib/audio/demo';
import { mixToMono } from '../lib/audio/dsp';
import { seedAudio } from '../lib/audio/library';
import { LEAD_SEC } from '../lib/audio/marker';
import { bytesToBase64, computePeaks } from '../lib/audio/peaks';
import { Transport } from '../lib/audio/transport';
import { alignWords, evenStarts, linesFromSegments, linesFromStarts, parseLyrics } from '../lib/lyrics';
import { autoAssign, blankLines, fmtTime, newLineId, type Line } from '../lib/parts';
import { fmtCode, navigate, roomLink } from '../lib/router';
import { store } from '../lib/store';
import { copyText, Icon, Spinner, Toggle, TopBar, useRaf, useToast } from '../ui';
import { PartsEditor } from './PartsEditor';

type Step = 'song' | 'trim' | 'lyrics' | 'timing' | 'tap' | 'parts' | 'done';
const STEP_ORDER: Step[] = ['song', 'trim', 'lyrics', 'timing', 'parts', 'done'];
const LENGTHS = [30, 45, 60, 90];
const MAX_LEN = 120;

interface Source {
  buffer: AudioBuffer;
  name: string;
  demo: boolean;
  peaks: Uint8Array;
}

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
  const [opening, setOpening] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [loadingFile, setLoadingFile] = useState('');
  const [sel, setSel] = useState({ start: 0, len: 45 });
  const [title, setTitle] = useState('');
  const [segment, setSegment] = useState<Segment | null>(null);
  const [upload, setUpload] = useState<Upload>({ state: 'idle' });
  const [draft, setDraft] = useState<{ code: string; who: Identity } | null>(null);
  const [lyrics, setLyrics] = useState('');
  const [texts, setTexts] = useState<string[]>([]);
  const [timed, setTimed] = useState<Line[] | null>(null);
  const [timingNote, setTimingNote] = useState('');
  const [parts, setParts] = useState<Line[]>([]);
  const [seatCount, setSeatCount] = useState(4);
  const [blind, setBlind] = useState(false);
  const [hostName, setHostName] = useState(() => store.name());
  const [aiOn, setAiOn] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const runId = useRef(0);
  const transportRef = useRef<Transport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.config().then((c) => setAiOn(c.ai)).catch(() => {});
    return () => transportRef.current?.dispose();
  }, []);

  const transport = useCallback(async () => {
    const ctx = await unlockAudio();
    if (!transportRef.current || transportRef.current.ctx !== ctx) transportRef.current = new Transport(ctx);
    return transportRef.current;
  }, []);

  const stopAudio = () => transportRef.current?.stop();

  // ───────── 1. 노래 ─────────
  const openFile = async (file: File) => {
    if (file.size > 200 * 1024 * 1024) return toast('파일이 너무 커요. 200MB 이하 파일로 해 주세요.', 'error');
    setLoadingFile(file.name);
    try {
      await unlockAudio();
      const buffer = await decodeFile(file, getCtx());
      if (buffer.duration < 8) throw new Error('short');
      const mono = mixToMono(bufferChannels(buffer));
      const len = Math.min(45, Math.floor(buffer.duration));
      setSource({ buffer, name: file.name, demo: false, peaks: computePeaks(mono, 900) });
      setSel({ start: Math.min(bestWindow(mono, buffer.sampleRate, len), Math.max(0, buffer.duration - len)), len });
      setTitle(cleanTitle(file.name));
      setStep('trim');
    } catch (e) {
      toast((e as Error).message === 'short' ? '8초보다 긴 노래 파일을 골라 주세요.' : '이 파일은 열 수 없어요. mp3, m4a, wav 같은 음악 파일이나 화면 녹화 영상으로 다시 해 주세요.', 'error');
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
    const seg: Segment = { buffer, peaks: bytesToBase64(peaks), bpm: DEMO_BPM, beat0: 0 };
    setSegment(seg);
    const lines = DEMO_LINES.map((l) => ({ ...l, id: newLineId(), seats: [] as number[] }));
    setTimed(lines);
    setParts(autoAssign(lines, seatCount, 'smart'));
    setStep('parts');
    void prepare(seg, '연습용 비트', '연습용 비트', true);
  };

  // ───────── 2. 구간 → 뒤에서 올리기 시작 ─────────
  const prepare = async (seg: Segment, roomTitle: string, fileName: string, demo: boolean) => {
    const id = ++runId.current;
    setDraft(null);
    setUpload({ state: 'working', label: '노래를 작게 줄이는 중', progress: 0 });
    try {
      const bytes = await encodeWithLead(bufferChannels(seg.buffer), seg.buffer.sampleRate, 4, (p) => {
        if (runId.current === id) setUpload({ state: 'working', label: '노래를 작게 줄이는 중', progress: p * 0.7 });
      });
      if (runId.current !== id) return;
      setUpload({ state: 'working', label: '방에 올리는 중', progress: 0.75 });
      const created = await api.createRoom({
        title: roomTitle || '이름 없는 방',
        hostName: store.name() || '방장',
        seatCount,
        song: { dur: seg.buffer.duration, lead: LEAD_SEC, peaks: seg.peaks, name: fileName, bpm: seg.bpm, beat0: seg.beat0, demo },
      });
      if (runId.current !== id) return;
      store.setIdentity(created.code, created.member);
      const room = await api.putSong(created.code, created.member, bytes);
      if (runId.current !== id) return;
      if (room.song.blob) seedAudio(room.song.blob, seg.buffer);
      setDraft({ code: created.code, who: created.member });
      setUpload({ state: 'ready' });
    } catch (e) {
      if (runId.current !== id) return;
      setUpload({ state: 'failed', message: e instanceof ApiError ? e.message : '노래를 올리지 못했어요.' });
    }
  };

  const confirmTrim = () => {
    if (!source) return;
    stopAudio();
    const buffer = sliceBuffer(source.buffer, sel.start, sel.len);
    const mono = mixToMono(bufferChannels(buffer));
    const tempo = detectTempo(mono, buffer.sampleRate);
    const ok = tempo.confidence > 1.6;
    const seg: Segment = { buffer, peaks: bytesToBase64(computePeaks(mono, 400)), bpm: ok ? tempo.bpm : 0, beat0: ok ? tempo.beat0 : 0 };
    setSegment(seg);
    setTimed(null);
    setStep('lyrics');
    void prepare(seg, title.trim(), source.name, false);
  };

  // ───────── 3. 가사 ─────────
  const dur = segment?.buffer.duration ?? 0;

  const lyricsNext = () => {
    const parsed = parseLyrics(lyrics);
    if (!parsed.texts.length) return toast('가사를 한 줄 이상 넣어 주세요. 가사가 없으면 아래 "가사 없이 진행"을 눌러 주세요.', 'error');
    setTexts(parsed.texts);
    if (parsed.times) {
      const lines = linesFromStarts(parsed.texts, parsed.times.map((t) => t - sel.start), dur).filter((l) => l.t0 >= 0);
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

  const skipLyrics = () => {
    if (!segment) return;
    const lines = blankLines(dur, segment.bpm, segment.beat0);
    setTexts([]);
    setTimed(lines);
    setParts(autoAssign(lines, seatCount, 'smart'));
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

  const playLine = async (line: Line) => {
    if (!segment) return;
    const t = await transport();
    t.setSong(segment.buffer);
    t.setTakes([]);
    t.play(Math.max(0, line.t0 - 0.6), { until: Math.min(dur, line.t1 + 0.2), withTakes: false });
  };

  const timingNext = () => {
    if (!timed?.length) return;
    stopAudio();
    setParts(autoAssign(timed, seatCount, 'smart'));
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
    if (step === 'song') return navigate('/');
    if (step === 'done') return navigate('/');
    if (step === 'tap') return setStep('timing');
    if (step === 'parts' && (source?.demo || !texts.length)) return setStep(source?.demo ? 'song' : 'lyrics');
    setStep(STEP_ORDER[Math.max(0, STEP_ORDER.indexOf(step) - 1)]);
  };

  const stepIndex = STEP_ORDER.indexOf(step === 'tap' ? 'timing' : step);
  const shareText = draft ? `떼창방에서 같이 불러요! "${title || '이름 없는 방'}"\n방 번호 ${fmtCode(draft.code)}\n${roomLink(draft.code)}` : '';

  return (
    <main className="page create">
      <TopBar
        onBack={step === 'done' ? undefined : back}
        title={step === 'done' ? '' : '방 만들기'}
        right={
          step !== 'done' && step !== 'song' ? (
            <ol className="steps" aria-label={`5단계 중 ${stepIndex + 1}단계`}>
              {STEP_ORDER.slice(0, 5).map((s, i) => (
                <li key={s} className={i <= stepIndex ? 'is-on' : ''} />
              ))}
            </ol>
          ) : null
        }
      />

      {step === 'song' && (
        <section className="stack">
          <h1 className="title">어떤 노래를 부를까요?</h1>
          <p className="lead">휴대폰이나 컴퓨터에 있는 노래 파일을 골라 주세요. 반주만 있는 파일(MR)도 좋아요.</p>
          <input ref={fileRef} id="song-file" type="file" accept="audio/*,video/mp4,video/quicktime,video/webm,.mp3,.m4a,.wav,.aac,.flac,.ogg,.opus" hidden onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])} />
          {loadingFile ? (
            <div className="card">
              <Spinner label={`"${loadingFile}" 여는 중…`} />
            </div>
          ) : (
            <>
              <button className="btn btn-primary btn-xl" onClick={() => fileRef.current?.click()}>
                <Icon name="music" />
                노래 파일 고르기
              </button>
              <button className="btn btn-secondary btn-xl" onClick={useDemo}>
                파일 없이 연습용 비트로 해보기
              </button>
            </>
          )}
          <ul className="notes">
            <li>mp3, m4a, wav 파일이나 화면 녹화 영상(mp4)을 쓸 수 있어요.</li>
            <li>고른 구간만 방에 저장되고, 방 기간이 끝나면 녹음과 함께 지워져요.</li>
            <li>친구끼리 즐기는 용도로만 써 주세요. 완성본을 공개된 곳에 올리면 원곡 저작권 문제가 생길 수 있어요.</li>
          </ul>
        </section>
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
            {source.buffer.duration <= MAX_LEN && (
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
          <label className="field">
            <span>방 이름 (곡 제목)</span>
            <input id="room-title" className="input" value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} placeholder="예) 하트셰이커 커버" />
          </label>
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
          <p className="lead">고른 구간의 가사만, 한 줄에 한 소절씩 붙여 넣어요. 녹음할 때 노래방처럼 보여 줘요.</p>
          <UploadPill upload={upload} onRetry={() => segment && source && prepare(segment, title.trim(), source.name, false)} />
          <textarea id="lyrics" className="input lyrics-input" rows={9} value={lyrics} onChange={(e) => setLyrics(e.target.value)} placeholder={'첫 소절\n둘째 소절\n셋째 소절…'} />
          {aiOn && (
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

      {step === 'timing' && segment && (
        <section className="stack">
          <h1 className="title">가사 타이밍을 맞춰요</h1>
          {!timed ? (
            <>
              <p className="lead">각 줄이 노래의 어디에서 시작하는지 알려 주세요. 방법을 하나 골라요.</p>
              <UploadPill upload={upload} onRetry={() => source && prepare(segment, title.trim(), source.name, false)} />
              <div className="choice-list">
                {aiOn && (
                  <button className="choice" disabled={!draft || aiBusy} onClick={timeWithAi}>
                    <Icon name="spark" />
                    <span>
                      <strong>{aiBusy ? 'AI가 노래를 듣는 중…' : 'AI로 자동 맞추기'}</strong>
                      <small>{draft ? '10~30초쯤 걸려요. 끝나면 줄마다 확인할 수 있어요.' : '노래가 다 올라가면 누를 수 있어요.'}</small>
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

      {step === 'tap' && segment && (
        <TapSync
          texts={texts}
          buffer={segment.buffer}
          getTransport={transport}
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

      {step === 'parts' && segment && (
        <section className="stack">
          <h1 className="title">파트를 나눠요</h1>
          <p className="lead">일단 고르게 나눠 뒀어요. 친구들은 방에 들어와서 원하는 색을 고르면 돼요.</p>
          <UploadPill upload={upload} onRetry={() => source && prepare(segment, title.trim(), source.name, source.demo)} />
          <PartsEditor
            lines={parts}
            seatCount={seatCount}
            dur={dur}
            songPeaks={segment.peaks}
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
            <span>내 이름</span>
            <input id="host-name" className="input" value={hostName} maxLength={16} onChange={(e) => setHostName(e.target.value)} placeholder="친구들에게 보일 이름" autoComplete="nickname" />
          </label>
          <div className="bottom-bar">
            <button className="btn btn-primary btn-xl" onClick={openRoom} disabled={!draft || opening}>
              {opening ? '방 여는 중…' : draft ? '방 열고 번호 받기' : upload.state === 'failed' ? '노래를 다시 올려 주세요' : '노래 올리는 중…'}
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

function UploadPill({ upload, onRetry }: { upload: Upload; onRetry: () => void }) {
  if (upload.state === 'idle') return null;
  if (upload.state === 'ready')
    return (
      <p className="pill pill-ok">
        <Icon name="check" size={16} /> 노래가 방에 올라갔어요
      </p>
    );
  if (upload.state === 'failed')
    return (
      <p className="pill pill-bad">
        {upload.message}
        <button className="link-btn" onClick={onRetry}>
          다시 올리기
        </button>
      </p>
    );
  return (
    <p className="pill">
      <span className="spinner" /> {upload.label} {Math.round(upload.progress * 100)}%
    </p>
  );
}

// ───────── 구간 고르기 상자 ─────────
function TrimBox({ source, sel, onChange }: { source: Source; sel: { start: number; len: number }; onChange: (s: { start: number; len: number }) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; start: number } | null>(null);
  const total = source.buffer.duration;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const draw = () => {
      const w = wrap.clientWidth;
      const h = 84;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const c = canvas.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, h);
      c.fillStyle = '#2BD576';
      const p = source.peaks;
      for (let x = 0; x < w; x += 3) {
        const a = Math.floor((x / w) * p.length);
        const b = Math.max(a + 1, Math.floor(((x + 3) / w) * p.length));
        let m = 0;
        for (let i = a; i < b; i++) m = Math.max(m, p[i]);
        const bar = Math.max(2, (m / 255) * (h - 10));
        c.fillRect(x, (h - bar) / 2, 2, bar);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [source]);

  const clampStart = (s: number) => Math.max(0, Math.min(total - sel.len, s));
  const toTime = (clientX: number) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return ((clientX - r.left) / r.width) * total;
  };

  return (
    <div className="trim">
      <div
        className="trim-wave"
        ref={wrapRef}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const t = toTime(e.clientX);
          const inside = t >= sel.start && t <= sel.start + sel.len;
          const start = inside ? sel.start : clampStart(t - sel.len / 2);
          if (!inside) onChange({ ...sel, start });
          drag.current = { x: e.clientX, start };
        }}
        onPointerMove={(e) => {
          if (!drag.current || !e.buttons) return;
          const r = wrapRef.current!.getBoundingClientRect();
          onChange({ ...sel, start: clampStart(drag.current.start + ((e.clientX - drag.current.x) / r.width) * total) });
        }}
        onPointerUp={() => (drag.current = null)}
        role="slider"
        tabIndex={0}
        aria-label="구간 시작 위치"
        aria-valuemin={0}
        aria-valuemax={Math.round(total - sel.len)}
        aria-valuenow={Math.round(sel.start)}
        aria-valuetext={`${fmtTime(sel.start)}부터 ${fmtTime(sel.start + sel.len)}까지`}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onChange({ ...sel, start: clampStart(sel.start - 1) });
          if (e.key === 'ArrowRight') onChange({ ...sel, start: clampStart(sel.start + 1) });
        }}
      >
        <canvas ref={canvasRef} />
        <div className="trim-window" style={{ left: `${(sel.start / total) * 100}%`, width: `${(sel.len / total) * 100}%` }} />
      </div>
      <p className="trim-times">
        <strong>
          {fmtTime(sel.start)} ~ {fmtTime(sel.start + sel.len)}
        </strong>
        <span>
          전체 {fmtTime(total)} 중 {Math.round(sel.len)}초
        </span>
      </p>
    </div>
  );
}

function PreviewButton({ source, sel, getTransport }: { source: Source; sel: { start: number; len: number }; getTransport: () => Promise<Transport> }) {
  const [on, setOn] = useState(false);
  const tRef = useRef<Transport | null>(null);
  const key = `${sel.start.toFixed(2)}:${sel.len}`;
  useEffect(() => {
    // 구간을 옮기면 재생을 멈춘다
    tRef.current?.stop();
    setOn(false);
  }, [key]);
  useEffect(() => () => tRef.current?.stop(), []);
  return (
    <button
      className="btn btn-secondary"
      onClick={async () => {
        const t = await getTransport();
        tRef.current = t;
        if (on) {
          t.stop();
          return setOn(false);
        }
        t.setSong(source.buffer);
        t.setTakes([]);
        t.play(sel.start, { until: sel.start + sel.len, withTakes: false, onEnd: () => setOn(false) });
        setOn(true);
      }}
    >
      <Icon name={on ? 'pause' : 'play'} size={18} />
      {on ? '멈추기' : '구간 듣기'}
    </button>
  );
}

// ───────── 들으면서 탭하기 ─────────
function TapSync({ texts, buffer, getTransport, onDone, onCancel }: { texts: string[]; buffer: AudioBuffer; getTransport: () => Promise<Transport>; onDone: (starts: number[]) => void; onCancel: () => void }) {
  const [started, setStarted] = useState(false);
  const [taps, setTaps] = useState<number[]>([]);
  const tRef = useRef<Transport | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLParagraphElement>(null);
  const tapsRef = useRef<number[]>([]);
  tapsRef.current = taps;
  const next = taps.length;
  const dur = buffer.duration;

  const finish = useCallback(
    (list: number[]) => {
      tRef.current?.stop();
      if (!list.length) return onCancel();
      onDone(list);
    },
    [onCancel, onDone],
  );

  const begin = async (from: number) => {
    const t = await getTransport();
    tRef.current = t;
    t.setSong(buffer);
    t.setTakes([]);
    t.play(from, { withTakes: false, countIn: from < 0, onEnd: () => finish(tapsRef.current) });
    setStarted(true);
  };

  useEffect(() => () => tRef.current?.stop(), []);

  useRaf(() => {
    const t = tRef.current;
    if (!t) return;
    const pos = t.position();
    if (barRef.current) barRef.current.style.width = `${Math.max(0, Math.min(1, pos / dur)) * 100}%`;
    if (countRef.current) countRef.current.textContent = pos < 0 ? String(Math.ceil(-pos)) : '';
  }, started);

  const tap = () => {
    const t = tRef.current;
    if (!t || !t.playing) return;
    const pos = t.position();
    if (pos < -0.2) return;
    // 누르는 손이 살짝 늦는 만큼 당겨 준다
    const at = Math.max(0, pos - 0.08);
    const list = [...tapsRef.current, at];
    setTaps(list);
    if (navigator.vibrate) navigator.vibrate(12);
    if (list.length >= texts.length) window.setTimeout(() => finish(list), 500);
  };

  const undo = () => {
    const list = tapsRef.current.slice(0, -1);
    setTaps(list);
    void begin(Math.max(0, (list[list.length - 1] ?? 0) - 2));
  };

  useEffect(() => {
    if (!started) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        tap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  if (!started) {
    return (
      <section className="stack">
        <h1 className="title">들으면서 탭하기</h1>
        <p className="lead">노래가 나오면, 화면에 보이는 줄이 시작되는 순간마다 큰 버튼을 눌러 주세요. 틀리면 "한 줄 되돌리기"를 누르면 돼요.</p>
        <div className="card">
          <p className="tap-preview">{texts[0]}</p>
          <p className="hint">첫 줄이에요. 셋을 센 뒤 노래가 시작돼요.</p>
        </div>
        <div className="bottom-bar">
          <button className="btn btn-primary btn-xl" onClick={() => begin(-3)}>
            시작하기
          </button>
          <button className="btn btn-ghost" onClick={onCancel}>
            취소
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="tap-stage">
      <div className="tap-progress">
        <div ref={barRef} />
      </div>
      <p className="tap-count" ref={countRef} aria-hidden="true" />
      <div className="tap-lines">
        <p className="tap-done">{next > 0 ? texts[next - 1] : ''}</p>
        <p className="tap-now">{texts[next] ?? '끝!'}</p>
        <p className="tap-next">{texts[next + 1] ?? ''}</p>
      </div>
      <button className="tap-button" onPointerDown={tap} disabled={next >= texts.length}>
        <span>이 줄 시작!</span>
        <small>
          {Math.min(next + 1, texts.length)} / {texts.length}
        </small>
      </button>
      <div className="tap-tools">
        <button className="btn btn-ghost" onClick={undo} disabled={!taps.length}>
          <Icon name="redo" size={18} /> 한 줄 되돌리기
        </button>
        <button className="btn btn-ghost" onClick={() => finish(tapsRef.current)}>
          여기까지만 쓰기
        </button>
      </div>
    </section>
  );
}
