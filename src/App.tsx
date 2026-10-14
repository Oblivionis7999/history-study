import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ArrowLeft, BookOpen, Bookmark, Check, ChevronRight, CircleHelp, Clock3, Download, Flag, Grid2X2, Layers3, ListChecks, LoaderCircle, Menu, PanelLeftClose, Plus, RotateCcw, Settings2, ShieldCheck, Sparkles, Upload, X } from 'lucide-react';
import { api, ApiError, initialState, labels, modeNames } from './api';
import type { Dashboard, Feedback, Kind, Mode, Preferences, Question, QuestionState, Session } from './api';
import AIPanel from './AIPanel';

type Launch = { mode: Mode; theme?: string; name?: string };
type Pending = { path: string; body: Record<string, unknown>; sid: string };
const pendingKey = (sid: string, qid: string) => 'history-pending-' + sid + '-' + qid;
const dateText = (stamp: number) => new Date(stamp * 1000).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });

export default function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [development, setDevelopment] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [page, setPage] = useState<'home' | 'practice' | 'result' | 'settings'>('home');
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 1024 && localStorage.getItem('history-left') !== 'closed');
  const [aiOpen, setAiOpen] = useState(false);
  const [launch, setLaunch] = useState<Launch | null>(null);
  const [launchError, setLaunchError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [milestone, setMilestone] = useState(false);
  const [finishConfirm, setFinishConfirm] = useState(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => { setLaunchError(''); }, [launch]);
  const applySession = useCallback((s: Session) => { sessionRef.current = s; setSession(s); }, []);
  const refresh = useCallback(async () => { const d = await api<Dashboard>('/dashboard'); setDashboard(d); return d; }, []);
  const handleError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) setAuth(false);
    setNotice(e instanceof Error ? e.message : '连接失败，请检查网络后重试。');
  }, []);
  const loadSession = useCallback(async (id: string, review = false) => {
    try { const s = await api<Session>('/sessions/' + id); applySession(s); setPage(s.status === 'completed' && !review ? 'result' : 'practice'); setAiOpen(false); return s; }
    catch (e) { handleError(e); return null; }
  }, [applySession, handleError]);

  useEffect(() => {
    api<{ authenticated: boolean; development: boolean }>('/auth/me').then(r => { setAuth(r.authenticated); setDevelopment(r.development); }).catch(handleError);
  }, [handleError]);
  useEffect(() => {
    if (!auth) return;
    refresh().catch(handleError);
    const id = new URLSearchParams(location.search).get('session');
    if (id) void loadSession(id);
    const onPop = () => { const target = new URLSearchParams(location.search).get('session'); if (target) void loadSession(target); else { setPage('home'); setAiOpen(false); } };
    const onVisible = () => { if (!document.hidden) refresh().catch(handleError); };
    window.addEventListener('popstate', onPop); document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('popstate', onPop); document.removeEventListener('visibilitychange', onVisible); };
  }, [auth, refresh, loadSession, handleError]);

  const home = () => { setPage('home'); setAiOpen(false); history.pushState({}, '', '/'); refresh().catch(handleError); if (window.innerWidth < 1024) setLeftOpen(false); };
  const resume = async (id: string, review = false) => { const s = await loadSession(id, review); if (s) history.pushState({}, '', '/?session=' + id); if (window.innerWidth < 1024) setLeftOpen(false); };
  const start = async (body: Record<string, unknown>) => {
    setBusy(true); setLaunchError('');
    try { const s = await api<Session>('/sessions', 'POST', body); applySession(s); setPage('practice'); setLaunch(null); setAiOpen(false); history.pushState({}, '', '/?session=' + s.id); if (window.innerWidth < 1024) setLeftOpen(false); await refresh(); }
    catch (e) { handleError(e); setLaunchError(e instanceof Error ? e.message : '创建练习失败，请重试。'); } finally { setBusy(false); }
  };

  const mutate = useCallback((suffix: string, method: string, body: Record<string, unknown>) => {
    const sid = sessionRef.current?.id;
    if (!sid) return Promise.reject(new Error('请先打开练习。'));
    const operation = async () => {
      const current = sessionRef.current;
      if (!current || current.id !== sid) throw new Error('当前练习已切换，请重新操作。');
      setBusy(true);
      const ticket: Pending = { path: suffix, body, sid };
      const key = pendingKey(sid, String(body.question_id ?? 'cursor'));
      localStorage.setItem(key, JSON.stringify(ticket));
      try {
        const s = await api<Session>('/sessions/' + sid + suffix, method, { ...body, revision: current.revision });
        localStorage.removeItem(key); setPending(null); setNotice('');
        if (sessionRef.current?.id === sid) applySession(s);
        return s;
      } catch (e) { setPending(ticket); handleError(e); throw e; }
      finally { setBusy(false); }
    };
    const result = queue.current.catch(() => undefined).then(operation);
    queue.current = result;
    return result;
  }, [applySession, handleError]);

  const move = useCallback(async (cursor: number) => {
    const s = sessionRef.current;
    if (!s || cursor < 0 || cursor >= s.question_ids.length) return;
    try { await mutate('/progress', 'PATCH', { cursor }); window.scrollTo({ top: 0, behavior: 'instant' }); }
    catch { /* Draft remains available for retry. */ }
  }, [mutate]);
  const submit = async (qid: string, selected: string[]) => {
    try {
      const before = sessionRef.current!;
      const s = await mutate('/answers', 'POST', { question_id: qid, selected });
      await refresh();
      if (s.status === 'completed') { setPage('result'); setAiOpen(false); }
      else if (s.mode === 'full' && Object.keys(s.results).length > Object.keys(before.results).length && Object.keys(s.results).length % 20 === 0) setMilestone(true);
    } catch { /* The selected options are retained in local storage. */ }
  };
  const updateState = async (qid: string, changes: Partial<QuestionState>) => {
    const current = dashboard?.states[qid] ?? initialState(qid);
    try { const next = await api<QuestionState>('/questions/' + qid + '/state', 'PATCH', { ...changes, revision: current.revision }); setDashboard(d => d ? { ...d, states: { ...d.states, [qid]: next } } : d); await refresh(); }
    catch (e) { handleError(e); throw e; }
  };
  const updatePrefs = async (changes: Partial<Preferences>) => {
    try { const prefs = await api<Preferences>('/preferences', 'PUT', changes); setDashboard(d => d ? { ...d, prefs } : d); }
    catch (e) { handleError(e); }
  };
  const finish = async () => {
    setFinishConfirm(false);
    try { await mutate('/finish', 'POST', {}); setPage('result'); setAiOpen(false); await refresh(); } catch { /* Message is shown in the notice. */ }
  };
  const question = page === 'practice' && session ? session.questions[session.cursor] : null;
  const retry = async () => {
    if (!pending) { setNotice(''); await refresh().catch(handleError); return; }
    try {
      if (sessionRef.current?.id !== pending.sid) { if (!await loadSession(pending.sid, true)) return; }
      else { const latest = await api<Session>('/sessions/' + pending.sid); applySession(latest); }
      await mutate(pending.path, pending.path === '/progress' ? 'PATCH' : 'POST', pending.body); await refresh();
    } catch (e) { handleError(e); }
  };

  if (auth === null || (auth && !dashboard)) return <div className="loading-screen"><BookOpen size={36} /><p>正在打开你的复习空间…</p>{notice && <button onClick={() => location.reload()}>重新连接</button>}</div>;
  if (!auth) return <Login onLogin={() => { setAuth(true); setNotice(''); }} />;
  if (!dashboard) return null;
  const d = dashboard;
  const latestFull = d.sessions.find(s => s.mode === 'full' && s.status === 'active');
  const latest = d.sessions.find(s => s.status === 'active');
  const toggleLeft = () => { setLeftOpen(v => { localStorage.setItem('history-left', v ? 'closed' : 'open'); return !v; }); if (window.innerWidth < 1024) setAiOpen(false); };

  return <div className={'app' + (leftOpen ? ' left-open' : '') + (aiOpen && question ? ' ai-open' : '')}>
    <div className="global-nav"><span>个人复习空间</span><span>中国近现代史纲要 · 2023版</span><span className="global-end"><ShieldCheck size={13} /> 私人学习记录</span></div>
    <header className="topbar">
      <div className="brand-group"><button className="icon-button" aria-label={leftOpen ? '收起导航' : '展开导航'} onClick={toggleLeft}>{leftOpen ? <PanelLeftClose size={20} /> : <Menu size={20} />}</button><button className="brand" onClick={home}><BookOpen size={24} /><span>史纲 <span className="brand-light">Study</span></span></button></div>
      <nav className="top-links"><button className={page === 'home' ? 'active' : ''} onClick={home}>学习概览</button><button onClick={() => setLaunch({ mode: 'review' })}>我的复习</button><button className={page === 'settings' ? 'active' : ''} onClick={() => { setPage('settings'); setAiOpen(false); }}>设置与数据</button></nav>
      <button className="primary compact top-continue" onClick={() => latest ? void resume(latest.id) : setLaunch({ mode: 'full' })}>{latest ? '继续学习' : '开始学习'}<ArrowRight size={15} /></button>
    </header>
    {leftOpen && <><div className="mobile-scrim" onClick={() => setLeftOpen(false)} /><aside className="left-sidebar">
      <div className="sidebar-caption">学习空间</div><button className={'nav-item ' + (page === 'home' ? 'selected' : '')} onClick={home}><Grid2X2 size={19} />学习概览</button>
      <div className="sidebar-caption section-label">练习</div>
      <button className={'nav-item ' + (page === 'practice' && session?.mode === 'full' ? 'selected' : '')} onClick={() => latestFull ? void resume(latestFull.id) : setLaunch({ mode: 'full' })}><Layers3 size={19} />通刷模式<span className="nav-number">700</span></button>
      <button className={'nav-item ' + (session?.mode === 'paper80' && page === 'practice' ? 'selected' : '')} onClick={() => setLaunch({ mode: 'paper80' })}><ListChecks size={19} />80题随机卷<span className="nav-number">80</span></button>
      <button className={'nav-item ' + (session?.mode === 'paper20' && page === 'practice' ? 'selected' : '')} onClick={() => setLaunch({ mode: 'paper20' })}><Clock3 size={19} />20题小卷<span className="nav-number">20</span></button>
      <button className="nav-item" onClick={() => setLaunch({ mode: 'category' })}><BookOpen size={19} />分类练习</button>
      <div className="sidebar-caption section-label">我的复习</div>
      <button className="nav-item" onClick={() => setLaunch({ mode: 'review' })}><RotateCcw size={19} />错题与不确定<span className="nav-number">{d.stats.due}</span></button>
      <button className="nav-item" onClick={() => setLaunch({ mode: 'favorites' })}><Bookmark size={19} />我的收藏<span className="nav-number">{d.stats.favorites}</span></button>
      {question && session && <div className="question-map"><div className="sidebar-caption">当前题组 <span>{Object.keys(session.results).length}/{session.questions.length}</span></div><div className="map-grid">{session.questions.map((q, i) => <button key={q.id} aria-label={'跳到第' + (i + 1) + '题'} title={labels[q.type] + ' · ' + (session.results[q.id] ? session.results[q.id].correct ? '答对' : '答错' : session.drafts[q.id]?.length ? '已选择' : '未做')} className={'map-number ' + (session.results[q.id] ? session.results[q.id].correct ? 'right' : 'wrong' : session.drafts[q.id]?.length ? 'draft' : '') + (i === session.cursor ? ' current' : '')} disabled={busy} onClick={() => { void move(i); if (window.innerWidth < 1024) setLeftOpen(false); }}>{i + 1}{d.states[q.id]?.favorite && <i />}</button>)}</div><div className="map-legend"><span><i className="dot right" />答对</span><span><i className="dot wrong" />答错</span><span><i className="dot" />未做</span></div></div>}
      <div className="sidebar-bottom"><span>700 道题，慢慢学清楚。</span><button className="text-button" onClick={() => { setPage('settings'); setAiOpen(false); }}><Settings2 size={16} />设置与数据</button></div>
    </aside></>}
    <main className="main-content">
      {notice && <div className="notice" role="alert"><span>{notice}</span><div><button onClick={() => void retry()}>重试／加载最新</button><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div></div>}
      {page === 'home' && <Home d={d} latestFull={latestFull} onResume={resume} onLaunch={setLaunch} />}
      {page === 'practice' && session && question && <Practice key={session.id + question.id} s={session} q={question} state={d.states[question.id] ?? initialState(question.id)} theme={d.themes.find(t => t.id === question.theme)?.name ?? ''} prefs={d.prefs} busy={busy} paused={aiOpen || milestone} onMove={move} onAnswer={submit} onDraft={(qid, selected) => mutate('/progress', 'PATCH', { question_id: qid, selected }).then(() => undefined).catch(() => undefined)} onState={updateState} onAsk={() => { setAiOpen(true); if (window.innerWidth < 1024) setLeftOpen(false); }} onPrefs={updatePrefs} onFinish={() => setFinishConfirm(true)} onResult={() => { setPage('result'); setAiOpen(false); }} />}
      {page === 'result' && session && <Results s={session} onReview={() => setPage('practice')} onHome={home} onNew={() => setLaunch({ mode: session.mode })} onWrong={() => setLaunch({ mode: 'review' })} />}
      {page === 'settings' && <Settings d={d} development={development} onPrefs={updatePrefs} onRestore={async (value) => { await api('/restore', 'POST', value); setSession(null); sessionRef.current = null; history.replaceState({}, '', '/'); await refresh(); setNotice('备份已恢复，当前数据已自动备份。'); }} onLogout={async () => { await api('/auth/logout', 'POST'); setAuth(false); }} />}
      <footer>中国近现代史纲要（2023版）<span>个人复习 · 700 道客观题</span></footer>
    </main>
    {aiOpen && question && session && <><div className="mobile-scrim ai-scrim" onClick={() => setAiOpen(false)} /><AIPanel q={question} s={session} configured={d.ai.configured} onClose={() => setAiOpen(false)} /></>}
    {launch && <LaunchDialog launch={launch} d={d} busy={busy} error={launchError} onClose={() => setLaunch(null)} onStart={start} />}
    {milestone && session && <Dialog onClose={() => setMilestone(false)}><div className="dialog-symbol"><Check size={26} /></div><h2>又完成了 20 道题。</h2><p>这一轮已经完成 {Object.keys(session.results).length} / {session.questions.length} 题。可以休息一下，下次从这里继续。</p><div className="dialog-actions"><button className="secondary" onClick={() => { setMilestone(false); home(); }}>先休息一下</button><button className="primary" onClick={() => { setMilestone(false); const next = session.questions.findIndex((q, i) => i > session.cursor && !session.results[q.id]); void move(next >= 0 ? next : session.cursor); }}>继续通刷<ArrowRight size={17} /></button></div></Dialog>}
    {finishConfirm && session && <Dialog onClose={() => setFinishConfirm(false)}><h2>提交这张卷子？</h2><p>已选择 {Object.values(session.drafts).filter(a => a.length).length} / {session.questions.length} 题。未答题会单独列出，交卷后可以查看答案与 AI 讲解。</p><div className="dialog-actions"><button className="secondary" onClick={() => setFinishConfirm(false)}>继续作答</button><button className="primary" disabled={busy} onClick={() => void finish()}>确认交卷</button></div></Dialog>}
  </div>;
}

function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  return <div className="login-page"><div className="login-card"><BookOpen className="blue" size={36} /><p className="eyebrow">你的个人复习空间</p><h1>史纲 Study</h1><p>从一道题，开始今天的复习。</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api('/auth/login', 'POST', { password }); onLogin(); } catch (e) { setError(e instanceof Error ? e.message : '连接失败'); } finally { setBusy(false); } }}><label htmlFor="password">访问密码</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />{error && <p className="error" role="alert">{error}</p>}<button className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : '进入复习空间'}<ArrowRight size={17} /></button></form><small>中国近现代史纲要（2023版） · 700 道题</small></div></div>;
}

function Home({ d, latestFull, onResume, onLaunch }: { d: Dashboard; latestFull?: Dashboard['sessions'][number]; onResume: (id: string) => Promise<void>; onLaunch: (value: Launch) => void }) {
  const accuracy = d.stats.answered ? Math.round(d.stats.first_correct / d.stats.answered * 100) : null;
  const progress = latestFull?.answered ?? 0;
  return <div className="home-page">
    <section className="home-heading"><p className="eyebrow">中国近现代史纲要 · 2023版</p><h1>温故，知新。</h1><p className="lead">把每一道题，变成真正理解的知识。</p><span className="course-meta">700 道客观题<span />9 个历史主题<span />随时继续</span></section>
    <section className="stats-grid" aria-label="学习统计"><Stat value={String(d.stats.answered)} label="已练题目" suffix="/ 700" /><Stat value={accuracy === null ? '—' : String(accuracy)} label="首答正确率" suffix={accuracy === null ? '' : '%'} /><Stat value={String(d.stats.due)} label="待复习题目" /><Stat value={String(d.stats.mastered)} label="已确认掌握" /></section>
    <section className="mode-grid">
      <div className="full-card"><div className="full-card-text"><span className="capsule dark-capsule"><Layers3 size={14} />完整通刷</span><h2>一轮通刷。<br />串起历史的脉络。</h2><p>按历史主题走完 700 道题。每次一点，进度自动保存。</p><button className="primary" onClick={() => latestFull ? void onResume(latestFull.id) : onLaunch({ mode: 'full' })}>{latestFull ? '继续通刷' : '开始通刷'}<ArrowRight size={17} /></button></div><div className="full-ring"><svg viewBox="0 0 160 160" aria-hidden="true"><circle cx="80" cy="80" r="68" className="ring-track" /><circle cx="80" cy="80" r="68" className="ring-progress" strokeDasharray={427.26} strokeDashoffset={427.26 * (1 - progress / 700)} /></svg><div><strong>{progress}</strong><span>/ 700 题</span></div><p>{latestFull ? '本轮已完成' : '从第一题开始'}</p></div></div>
      <div className="small-modes"><button className="mode-card" onClick={() => onLaunch({ mode: 'paper80' })}><div className="mode-icon"><ListChecks size={23} /></div><div><h3>80 题随机卷</h3><p>35 单选 · 35 多选 · 10 判断</p><span>系统复习，检验整体掌握</span></div><ChevronRight size={21} /></button><button className="mode-card" onClick={() => onLaunch({ mode: 'paper20' })}><div className="mode-icon"><Clock3 size={23} /></div><div><h3>20 题小卷</h3><p>9 单选 · 9 多选 · 2 判断</p><span>碎片时间，轻量练一组</span></div><ChevronRight size={21} /></button></div>
    </section>
    <section className="section-heading"><div><h2>按历史主题，逐步学清楚。</h2><p>选择一个主题，开始专项练习。</p></div><button className="text-button" onClick={() => onLaunch({ mode: 'category' })}>按题型练习<ChevronRight size={16} /></button></section>
    <section className="theme-grid">{d.themes.map((t, i) => <button className="theme-card" key={t.id} onClick={() => onLaunch({ mode: 'category', theme: t.id, name: t.name })}><div className="theme-top"><span>{String(i + 1).padStart(2, '0')}</span><ChevronRight size={18} /></div><h3>{t.name}</h3><p>{t.subtitle}</p><div className="theme-progress"><i style={{ width: (t.total ? t.done / t.total * 100 : 0) + '%' }} /></div><div className="theme-bottom"><span>{t.total} 道题</span><span>{t.done ? '已练 ' + t.done : '尚未开始'}{t.due > 0 && ' · 待复习 ' + t.due}</span></div></button>)}</section>
    <section className="review-row"><button onClick={() => onLaunch({ mode: 'review' })}><RotateCcw size={22} /><div><h3>回到还不熟的地方。</h3><p>{d.stats.due ? d.stats.due + ' 道题等待再次复习' : '错题和答对但不确定的题，会保存在这里'}</p></div><ArrowRight size={20} /></button><button onClick={() => onLaunch({ mode: 'favorites' })}><Bookmark size={22} /><div><h3>你的重点，随时回看。</h3><p>{d.stats.favorites ? '已收藏 ' + d.stats.favorites + ' 道题' : '收藏需要留意的题，写下自己的记忆笔记'}</p></div><ArrowRight size={20} /></button></section>
    {d.sessions.length > 0 && <section className="recent-section"><div className="section-heading"><h2>最近的练习</h2></div>{d.sessions.slice(0, 5).map(s => <button className="recent-row" key={s.id} onClick={() => void onResume(s.id)}><div className="mode-icon"><samp>{s.total}</samp></div><div><strong>{s.title}</strong><p>{dateText(s.updated_at)} · {s.feedback === 'test' ? '自测' : '即时练习'}</p></div><span>{s.answered} / {s.total} 题</span><span className="capsule">{s.status === 'completed' ? '查看结果' : '继续练习'}</span><ChevronRight size={18} /></button>)}</section>}
  </div>;
}
function Stat({ value, label, suffix = '' }: { value: string; label: string; suffix?: string }) { return <div className="stat"><div><strong>{value}</strong><span>{suffix}</span></div><p>{label}</p></div>; }

function Practice({ s, q, state, theme, prefs, busy, paused, onMove, onAnswer, onDraft, onState, onAsk, onPrefs, onFinish, onResult }: {
  s: Session; q: Question; state: QuestionState; theme: string; prefs: Preferences; busy: boolean; paused: boolean;
  onMove: (cursor: number) => Promise<void>; onAnswer: (qid: string, selected: string[]) => Promise<void>; onDraft: (qid: string, selected: string[]) => Promise<void>;
  onState: (qid: string, changes: Partial<QuestionState>) => Promise<void>; onAsk: () => void; onPrefs: (changes: Partial<Preferences>) => Promise<void>; onFinish: () => void; onResult: () => void;
}) {
  const result = s.results[q.id]; const restricted = s.feedback === 'test' && s.status === 'active';
  const [selected, setSelected] = useState<string[]>(() => {
    try { const p = JSON.parse(localStorage.getItem(pendingKey(s.id, q.id)) ?? 'null') as Pending | null; if (p?.body.selected) return p.body.selected as string[]; } catch { /* Use server selection. */ }
    return s.drafts[q.id] ?? [];
  });
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(() => localStorage.getItem('history-note-' + q.id) ?? state.note);
  const [noteStatus, setNoteStatus] = useState('');
  const noteOriginal = useRef(state.note);
  const noteSaving = useRef(false);
  const freshAnswer = useRef(!result);
  const [countdown, setCountdown] = useState(false);
  const moveRef = useRef(onMove); moveRef.current = onMove;
  useEffect(() => { if (result) setSelected(result.selected); }, [result]);
  useEffect(() => {
    if (!freshAnswer.current || s.status !== 'active' || !result?.correct || !prefs.auto_next || busy || paused || noteOpen || restricted || s.cursor >= s.questions.length - 1) { setCountdown(false); return; }
    setCountdown(true); const timer = setTimeout(() => { freshAnswer.current = false; void moveRef.current(s.cursor + 1); }, 1500);
    return () => clearTimeout(timer);
  }, [result, prefs.auto_next, busy, paused, noteOpen, restricted, s.status, s.cursor, s.questions.length]);
  const saveNote = async () => {
    if (note === noteOriginal.current || noteSaving.current) return;
    noteSaving.current = true;
    setNoteStatus('正在保存…');
    try { await onState(q.id, { note }); localStorage.removeItem('history-note-' + q.id); noteOriginal.current = note; setNoteStatus('已保存'); }
    catch { setNoteStatus('暂未保存，草稿已留在本机'); }
    finally { noteSaving.current = false; }
  };
  const choose = (id: string) => {
    if (busy || result || s.status !== 'active') return;
    const next = q.type === 'multiple' ? selected.includes(id) ? selected.filter(v => v !== id) : [...selected, id] : [id];
    setSelected(next);
    if (!restricted && q.type !== 'multiple') void onAnswer(q.id, next); else void onDraft(q.id, next);
  };
  const answerLetters = (ids: string[]) => q.options.map((o, i) => ids.includes(o.id) ? q.type === 'judge' ? o.text : String.fromCharCode(65 + i) : '').filter(Boolean).join('、') || '未作答';
  const completed = restricted ? Object.values(s.drafts).filter(a => a.length).length : Object.keys(s.results).length;
  return <div className="practice-page">
    <div className="practice-heading"><div><p className="eyebrow">{s.title}{s.feedback === 'test' ? ' · 自测' : ''}</p><h1>专注这一题。</h1></div><span className="practice-position"><strong>{s.cursor + 1}</strong><span>/ {s.questions.length}</span></span></div>
    <div className="practice-progress"><i style={{ width: completed / s.questions.length * 100 + '%' }} /></div>
    <div className="question-card">
      <div className="question-meta"><div><span className="capsule blue-capsule">{labels[q.type]}</span><span>{theme}</span></div><div><button className={'icon-button ' + (state.favorite ? 'blue' : '')} aria-label={state.favorite ? '取消收藏' : '收藏本题'} title="收藏本题" onClick={() => void onState(q.id, { favorite: !state.favorite }).catch(() => undefined)}><Bookmark size={21} fill={state.favorite ? 'currentColor' : 'none'} /></button><button className="ai-question-button" onClick={onAsk}><Sparkles size={17} />问 AI</button></div></div>
      <h2 className="question-stem">{q.stem}</h2>
      <p className="answer-hint">{q.type === 'multiple' ? '选择所有正确选项' + (restricted ? '，交卷后统一判分。' : '，选完后提交答案。') : restricted ? '选择答案，交卷后统一判分。' : '点击选项，即可查看答题结果。'}</p>
      <div className={'options ' + (q.type === 'judge' ? 'judge-options' : '')}>{q.options.map((o, i) => {
        const chosen = selected.includes(o.id); const correct = result?.correct_ids.includes(o.id); const wrong = result && chosen && !correct; const missed = q.type === 'multiple' && result && correct && !chosen;
        return <button className={'option ' + (correct ? 'correct' : wrong ? 'incorrect' : chosen ? 'chosen' : '')} key={o.id} disabled={busy || !!result || s.status === 'completed'} onClick={() => choose(o.id)}><span className="option-letter">{q.type === 'judge' ? o.id === 'true' ? '√' : '×' : String.fromCharCode(65 + i)}</span><span className="option-text">{o.text}</span>{correct ? <span className="option-state">{missed && <small>漏选</small>}<Check size={20} /></span> : wrong ? <span className="option-state"><X size={20} /></span> : chosen ? <span className="option-state"><Check size={18} /></span> : null}</button>;
      })}</div>
      {!restricted && q.type === 'multiple' && !result && <button className="primary submit-answer" disabled={!selected.length || busy} onClick={() => void onAnswer(q.id, selected)}>{busy ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}提交答案</button>}
      {busy && q.type !== 'multiple' && <p className="saving-label"><LoaderCircle className="spin" size={15} />正在保存…</p>}
      {result && <div className={'answer-result ' + (result.correct ? 'correct' : 'incorrect')}><div className="result-symbol">{result.correct ? <Check size={21} /> : <X size={21} />}</div><div><strong>{result.correct ? '答对了。' : '这道题，值得再看一次。'}</strong><p>你的答案：{answerLetters(result.selected)}<span>题库参考答案：{answerLetters(result.correct_ids)}</span></p><small>{result.correct ? '如果是猜对的，可以标记“不确定”，以后再练。' : '已加入错题列表，之后可以集中复习。'}</small></div><button className="text-button" onClick={onAsk}>看 AI 讲解<ChevronRight size={17} /></button></div>}
      <div className="question-tools"><button className={'text-button ' + (state.uncertain ? 'blue' : '')} onClick={() => void onState(q.id, { uncertain: !state.uncertain }).catch(() => undefined)}><CircleHelp size={17} />{state.uncertain ? '已标记不确定' : '答对但不确定'}</button>{!restricted && <button className={'text-button ' + (state.mastered ? 'blue' : '')} onClick={() => void onState(q.id, { mastered: !state.mastered }).catch(() => undefined)}><ShieldCheck size={17} />{state.mastered ? '已确认掌握' : '确认已掌握'}</button>}{!restricted && <button className="text-button" onClick={() => setNoteOpen(v => !v)}><BookOpen size={17} />{noteOpen ? '收起笔记' : state.note ? '查看笔记' : '写笔记'}</button>}{!restricted && <button className={'text-button ' + (state.disputed ? 'blue' : '')} onClick={() => void onState(q.id, { disputed: !state.disputed }).catch(() => undefined)}><Flag size={16} />{state.disputed ? '答案待核对' : '标记答案疑问'}</button>}</div>
      {noteOpen && !restricted && <div className="note-panel"><label htmlFor="question-note">自己的记忆笔记</label><textarea id="question-note" rows={4} value={note} placeholder="写下这道题的考点、易混淆之处或自己的记忆方法…" onChange={e => { setNote(e.target.value); localStorage.setItem('history-note-' + q.id, e.target.value); setNoteStatus('草稿待保存'); }} onBlur={() => void saveNote()} /><div><small>{noteStatus || (state.note ? '已保存的笔记' : '笔记会随学习记录同步')}</small><button className="secondary compact" onClick={() => void saveNote()}>保存笔记</button></div></div>}
    </div>
    <div className="practice-controls"><button className="secondary" disabled={s.cursor === 0 || busy} onClick={() => void onMove(s.cursor - 1)}><ArrowLeft size={17} />上一题</button><label className="auto-next-control"><input type="checkbox" checked={prefs.auto_next} disabled={restricted} onChange={e => void onPrefs({ auto_next: e.target.checked })} /><span>{countdown ? '答对了，即将进入下一题…' : '答对后自动下一题'}</span></label>{s.cursor < s.questions.length - 1 ? <button className="primary" disabled={busy} onClick={() => void onMove(s.cursor + 1)}>下一题<ArrowRight size={17} /></button> : restricted ? <button className="primary" disabled={busy} onClick={onFinish}>提交整卷<Check size={17} /></button> : s.status === 'completed' ? <button className="primary" onClick={onResult}>查看结果<ArrowRight size={17} /></button> : <button className="primary" onClick={() => { const i = s.questions.findIndex(v => !s.results[v.id]); void onMove(i); }}>继续未做题<ArrowRight size={17} /></button>}</div>
    <div className="practice-footnote"><span>{completed} / {s.questions.length} 题{restricted ? '已选择' : '已完成'} · 进度自动保存</span>{restricted && <button className="text-button" onClick={onFinish}>提前交卷</button>}</div>
  </div>;
}

function Results({ s, onReview, onHome, onNew, onWrong }: { s: Session; onReview: () => void; onHome: () => void; onNew: () => void; onWrong: () => void }) {
  const correct = Object.values(s.results).filter(r => r.correct).length;
  const wrong = Object.values(s.results).filter(r => !r.correct).length;
  const unanswered = s.questions.length - Object.keys(s.results).length;
  return <div className="results-page"><div className="dialog-symbol"><Check size={29} /></div><p className="eyebrow">{s.title} · 本次练习结果</p><h1>完成一次，理解多一点。</h1><p className="lead">结果和学习记录已经保存，随时可以回看。</p><div className="result-score"><strong>{Math.round(correct / s.questions.length * 100)}<small>%</small></strong><span>本次正确率</span></div><div className="stats-grid result-stats"><Stat value={String(correct)} label="答对" /><Stat value={String(wrong)} label="答错" /><Stat value={String(unanswered)} label="未作答" /><Stat value={String(s.questions.length)} label="总题数" /></div><div className="result-actions"><button className="primary" onClick={onReview}>回看题目<ArrowRight size={17} /></button><button className="secondary" onClick={onWrong}>集中复习错题</button><button className="text-button" onClick={onNew}><Plus size={17} />{s.mode === 'full' ? '开始下一轮' : '再练一组'}</button></div><div className="result-list">{s.questions.map((q, i) => <div key={q.id}><span>{String(i + 1).padStart(2, '0')}</span><p>{q.stem}</p><span className={'capsule ' + (s.results[q.id] ? s.results[q.id].correct ? 'right' : 'wrong' : '')}>{s.results[q.id] ? s.results[q.id].correct ? '答对' : '答错' : '未答'}</span></div>)}</div><button className="text-button" onClick={onHome}><ArrowLeft size={17} />返回学习概览</button></div>;
}

function LaunchDialog({ launch, d, busy, error, onClose, onStart }: { launch: Launch; d: Dashboard; busy: boolean; error: string; onClose: () => void; onStart: (body: Record<string, unknown>) => Promise<void> }) {
  const [feedback, setFeedback] = useState<Feedback>('immediate');
  const [type, setType] = useState<Kind | ''>('');
  const [theme, setTheme] = useState(launch.theme ?? '');
  const [randomOrder, setRandomOrder] = useState(false);
  const [shuffle, setShuffle] = useState(d.prefs.shuffle_options);
  const [reduce, setReduce] = useState(d.prefs.reduce_repeats);
  const [filter, setFilter] = useState('all');
  const paper = launch.mode === 'paper80' || launch.mode === 'paper20';
  const empty = launch.mode === 'review' && !d.stats.due || launch.mode === 'favorites' && !d.stats.favorites;
  return <Dialog onClose={onClose}><div className="dialog-symbol"><BookOpen size={25} /></div><p className="eyebrow">开始一次练习</p><h2>{launch.name ?? modeNames[launch.mode]}</h2><p>{launch.mode === 'paper80' ? '80 道题 · 35 单选 / 35 多选 / 10 判断' : launch.mode === 'paper20' ? '20 道题 · 9 单选 / 9 多选 / 2 判断' : launch.mode === 'full' ? '按历史主题通刷全部 700 道题，每 20 题小结。' : launch.mode === 'favorites' ? '回看你主动收藏的重点题。' : launch.mode === 'review' ? '把错题和不确定的知识，再练清楚。' : '按主题或题型进行专项练习。'}</p>
    {empty ? <div className="empty-state"><Bookmark size={26} /><p>{launch.mode === 'review' ? '目前没有待复习题目。练习中的错题和“不确定”标记会自动出现在这里。' : '还没有收藏题目。做题时点击书签，重点就会保存在这里。'}</p><button className="primary" onClick={onClose}>知道了</button></div> : <>
      {paper && <div className="segmented"><button className={feedback === 'immediate' ? 'selected' : ''} onClick={() => setFeedback('immediate')}>即时练习</button><button className={feedback === 'test' ? 'selected' : ''} onClick={() => setFeedback('test')}>整卷自测</button></div>}
      {paper && <p className="form-caption">{feedback === 'test' ? '交卷后统一看答案。交卷前，AI只给提示。' : '作答后立即显示红绿反馈，可以随时问AI。'}</p>}
      {launch.mode === 'category' && <div className="form-fields"><label>历史主题<select value={theme} onChange={e => setTheme(e.target.value)}><option value="">全部主题</option>{d.themes.map(t => <option key={t.id} value={t.id}>{t.name}（{t.total}题）</option>)}</select></label><label>题型<select value={type} onChange={e => setType(e.target.value as Kind | '')}><option value="">全部题型</option>{Object.entries(labels).map(([k, v]) => <option value={k} key={k}>{v}</option>)}</select></label><Toggle checked={randomOrder} onChange={setRandomOrder} title="随机题序" caption="关闭后按主题顺序练习" /></div>}
      {launch.mode === 'review' && <label className="select-label">复习范围<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">错题与不确定题</option><option value="wrong">仅错题</option><option value="uncertain">仅不确定题</option></select></label>}
      <div className="launch-options"><Toggle title="打乱选项" caption="含有选项引用的题目保留原顺序" checked={shuffle} onChange={setShuffle} />{paper && <Toggle title="减少近期重复" caption="优先抽取近期没练过的题，题型配比保持不变" checked={reduce} onChange={setReduce} />}</div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary" onClick={onClose}>稍后再练</button><button className="primary" disabled={busy} onClick={() => void onStart({ mode: launch.mode, feedback, theme: theme || undefined, type: type || undefined, random_order: randomOrder, shuffle_options: shuffle, reduce_repeats: reduce, review_filter: filter })}>{busy ? <LoaderCircle className="spin" size={18} /> : '开始练习'}<ArrowRight size={17} /></button></div>
    </>}</Dialog>;
}
export function Dialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null); const closeRef = useRef(onClose); closeRef.current = onClose; const title = useId();
  useEffect(() => {
    const previous = document.body.style.overflow; const focus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    const heading = box.current?.querySelector('h2'); if (heading) heading.id = title;
    box.current?.querySelector<HTMLButtonElement>('.dialog-actions .primary, .dialog-close')?.focus();
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', close);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', close); focus?.focus(); };
  }, [title]);
  return <div className="dialog-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby={title} onKeyDown={e => {
    if (e.key !== 'Tab') return;
    const items = box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea, a[href]');
    if (!items?.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }}><button className="icon-button dialog-close" aria-label="关闭对话框" onClick={onClose}><X size={20} /></button>{children}</div></div>;
}
function Toggle({ title, caption, checked, onChange }: { title: string; caption: string; checked: boolean; onChange: (value: boolean) => void }) { return <div className="toggle-row"><div><strong>{title}</strong><p>{caption}</p></div><button className={'switch ' + (checked ? 'on' : '')} role="switch" aria-label={title} aria-checked={checked} onClick={() => onChange(!checked)}><i /></button></div>; }

function Settings({ d, development, onPrefs, onRestore, onLogout }: { d: Dashboard; development: boolean; onPrefs: (value: Partial<Preferences>) => Promise<void>; onRestore: (value: unknown) => Promise<void>; onLogout: () => Promise<void> }) {
  const [backup, setBackup] = useState<{ value: unknown; name: string } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <div className="settings-page"><p className="eyebrow">学习空间</p><h1>按自己的节奏。</h1><p className="lead">调整练习偏好，保管你的学习记录。</p><section className="settings-card"><h2>练习偏好</h2><Toggle title="答对后自动下一题" caption="保存成功后等待1.5秒；答错或AI打开时停留" checked={d.prefs.auto_next} onChange={v => void onPrefs({ auto_next: v })} /><Toggle title="默认打乱选项" caption="新建练习时生效，含选项引用的题目保留原顺序" checked={d.prefs.shuffle_options} onChange={v => void onPrefs({ shuffle_options: v })} /><Toggle title="随机卷默认减少近期重复" caption="优先抽取未练或较久没练过的题" checked={d.prefs.reduce_repeats} onChange={v => void onPrefs({ reduce_repeats: v })} /></section><section className="settings-card"><div className="settings-title"><h2>AI 学习助手</h2><span className="capsule">{d.ai.configured ? '已连接' : '尚未连接'}</span></div><p>{d.ai.configured ? '当前模型：' + d.ai.model : '在服务器配置兼容接口地址、API Key和模型后，即可按题讲解与追问。基础练习功能随时可用。'}</p><p className="form-caption">密钥由服务器保管。生成的解析与对话保存到题目下，可随时回看。</p></section><section className="settings-card"><h2>学习记录与备份</h2><p>保存练习进度、历史作答、收藏、笔记与 AI 内容。</p><div className="data-buttons"><a className="primary" href="/api/export" download><Download size={18} />导出学习记录</a><label className="secondary"><Upload size={18} />从备份恢复<input type="file" accept=".json,application/json" hidden onChange={async e => { const file = e.target.files?.[0]; if (!file) return; try { if (file.size > 20 * 1024 * 1024) throw new Error('文件不能超过20MB。'); setBackup({ value: JSON.parse(await file.text()), name: file.name }); setError(''); } catch { setError('文件不是有效的学习记录备份，请选择导出的JSON文件。'); } e.target.value = ''; }} /></label></div><p className="form-caption">服务器每日北京时间03:00自动备份，保留最近7份；恢复前也会备份当前数据。</p>{error && <p className="error" role="alert">{error}</p>}</section>{!development && <button className="text-button" onClick={() => void onLogout()}>退出复习空间</button>}
    {backup && <Dialog onClose={() => setBackup(null)}><h2>恢复这份学习记录？</h2><p>{backup.name}</p><p>恢复会替换现有学习记录，服务器会先保存当前数据的备份。</p>{error && <p className="error">{error}</p>}<div className="dialog-actions"><button className="secondary" onClick={() => setBackup(null)}>取消</button><button className="primary" disabled={busy} onClick={async () => { setBusy(true); try { await onRestore(backup.value); setBackup(null); } catch (e) { setError(e instanceof Error ? e.message : '恢复失败，原记录未修改。'); } finally { setBusy(false); } }}>{busy ? '正在恢复…' : '确认恢复'}</button></div></Dialog>}
  </div>;
}
