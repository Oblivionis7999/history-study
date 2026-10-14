import { useMemo, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import type { Dashboard } from './types';
import { labels } from './types';
import { currentBank, due, reviewReason } from './learning';

export default function ReviewExplorer({ d, onStart }: { d: Dashboard; onStart: (body: Record<string, unknown>) => Promise<void> }) {
  const [query, setQuery] = useState(''), [theme, setTheme] = useState(''), [type, setType] = useState(''), [filter, setFilter] = useState(''), [sort, setSort] = useState('due');
  const [busy, setBusy] = useState(false);
  const bank = currentBank();
  const matches = useMemo(() => bank.questions.filter(q => {
    const s = d.states[q.id], term = query.trim().toLowerCase();
    return (!theme || q.theme === theme) && (!type || q.type === type) && (!term || `${q.id} ${q.source_number} ${q.stem} ${q.options.map(o => o.text).join(' ')}`.toLowerCase().includes(term)) && (!filter || !!s && (filter === 'due' ? due(s) : filter === 'frequent' ? (s.wrong_count ?? 0) >= 2 : filter === 'recent' ? s.wrong : Boolean(s[filter as keyof typeof s])));
  }).sort((a, b) => {
    const sa = d.states[a.id], sb = d.states[b.id];
    if (sort === 'recent') return (sb?.last_answered ?? 0) - (sa?.last_answered ?? 0);
    if (sort === 'frequent') return (sb?.wrong_count ?? 0) - (sa?.wrong_count ?? 0);
    return Number(sb?.uncertain ?? false) - Number(sa?.uncertain ?? false) || Number(sb?.wrong ?? false) - Number(sa?.wrong ?? false) || (sa?.due_at ?? Infinity) - (sb?.due_at ?? Infinity);
  }), [query, theme, type, filter, sort, d.states, bank]);
  const start = async (id?: string) => { setBusy(true); try { await onStart({ mode: 'category', query, theme: theme || undefined, type: type || undefined, state_filter: filter || undefined, review_sort: sort, question_id: id, shuffle_options: d.prefs.shuffle_options }); } finally { setBusy(false); } };
  return <div className="explorer-page"><p className="eyebrow">我的复习</p><h1>找到需要再看的一题。</h1><p className="lead">从真实作答记录出发，优先补上不确定的知识。</p>
    <section className="settings-card"><label className="search-field"><Search size={20} /><span className="sr-only">搜索题干、选项或题号</span><input type="search" placeholder="搜索题干、选项、题号，如 single-254" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="filter-grid"><label>主题<select aria-label="主题" value={theme} onChange={e => setTheme(e.target.value)}><option value="">全部历史主题</option>{bank.themes.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></label><label>题型<select aria-label="题型" value={type} onChange={e => setType(e.target.value)}><option value="">全部题型</option>{Object.entries(labels).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label>学习状态<select aria-label="学习状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部题目</option><option value="due">待复习</option><option value="recent">最近答错</option><option value="frequent">多次答错</option><option value="uncertain">不确定</option><option value="favorite">收藏</option><option value="mastered">已掌握</option></select></label><label>排列方式<select aria-label="排列方式" value={sort} onChange={e => setSort(e.target.value)}><option value="due">复习优先级</option><option value="recent">最近复习</option><option value="frequent">答错次数</option></select></label></div>
      <p className="form-caption">答错或不确定优先；连续答对后分别在 1、3、7、14、30 天后提醒。确认掌握后不再进入待复习，之后答错会重新加入。</p>
      <div className="settings-title"><span aria-live="polite">找到 {matches.length} 道题</span><button className="primary" disabled={!matches.length || busy} onClick={() => void start()}>练习筛选结果<ArrowRight size={16} /></button></div>
    </section>
    <section className="settings-card"><h2>各主题学习情况</h2><div className="topic-stat-list">{d.themes.map(t => {
      const states = bank.questions.filter(q => q.theme === t.id).map(q => d.states[q.id]).filter(s => s?.first_correct !== undefined);
      const correct = states.filter(s => s.first_correct).length;
      return <div key={t.id}><strong>{t.name}</strong><span>完成 {t.done}/{t.total} · {Math.round(t.done / t.total * 100)}%</span><span>首答正确率 {states.length ? Math.round(correct / states.length * 100) + '%' : '—'}</span></div>;
    })}</div></section>
    <div className="search-results">{matches.slice(0, 100).map(q => { const s = d.states[q.id]; return <button key={q.id} className="search-result" onClick={() => void start(q.id)} disabled={busy}><div><span className="capsule">{labels[q.type]} · {q.id}</span><p>{q.stem}</p><small>{s ? `${reviewReason(s)} · 连续答对 ${s.streak ?? 0} 次${s.last_answered ? ' · 最近 ' + new Date(s.last_answered * 1000).toLocaleDateString('zh-CN') : ''}` : '尚未作答'}</small></div><ArrowRight size={18} /></button>; })}{matches.length > 100 && <p className="form-caption">展示前 100 条，练习时包含全部筛选结果。可继续缩小筛选范围。</p>}</div>
  </div>;
}
