import { useEffect, useRef, useState } from 'react';
import { ArrowUp, BookOpen, CircleHelp, LoaderCircle, Sparkles, Square, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { api, labels } from './api';
import type { Message, Question, Session } from './api';

export default function AIPanel({ q, s, configured, onClose }: { q: Question; s: Session; configured: boolean; onClose: () => void }) {
  const restricted = s.feedback === 'test' && s.status !== 'completed';
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [channel, setChannel] = useState<'hint' | 'solution'>(restricted ? 'hint' : 'solution');
  const controller = useRef<AbortController | null>(null);
  const current = useRef(q.id); current.current = q.id;
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    controller.current?.abort(); setBusy(false); setError(''); setInput('');
    const scope = restricted ? 'hint' : 'solution'; setChannel(scope); setMessages([]);
    api<{ messages: Message[] }>('/ai/history/' + q.id + '?session_id=' + s.id + '&channel=' + scope).then(r => { if (live) setMessages(r.messages); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; controller.current?.abort(); };
  }, [q.id, s.id, restricted]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [messages, busy]);

  const send = async (action: string, text = '') => {
    if (busy || !configured) return;
    const id = q.id; const scope = action === 'hint' ? 'hint' : 'solution';
    const prompts: Record<string, string> = { explain: '讲解本题', options: '分析各选项', hint: '给我思考提示', memory: '整理记忆方法' };
    const prompt = text || prompts[action];
    setBusy(true); setError(''); setInput('');
    const abort = new AbortController(); controller.current = abort;
    let completed = false;
    try {
      let history = messages;
      if (scope !== channel) {
        const r = await api<{ messages: Message[] }>('/ai/history/' + id + '?session_id=' + s.id + '&channel=' + scope);
        history = r.messages; setChannel(scope);
      }
      if (current.current !== id) return;
      setMessages([...history, { role: 'user', text: prompt }, { role: 'assistant', text: '' }]);
      const response = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', signal: abort.signal, body: JSON.stringify({ question_id: id, session_id: s.id, action, message: text }) });
      if (!response.ok) { const data = await response.json(); throw new Error(typeof data.detail === 'string' ? data.detail : 'AI连接失败，请重试。'); }
      if (!response.body) throw new Error('接口未返回回答。');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const line = block.split('\n').find(v => v.startsWith('data:'));
          if (!line) continue;
          const data = JSON.parse(line.slice(5));
          if (current.current !== id) return;
          if (data.type === 'error') throw new Error(data.text);
          if (data.type === 'done') completed = true;
          if (data.type === 'delta') setMessages(m => { const next = [...m]; const last = next[next.length - 1]; if (last?.role === 'assistant') next[next.length - 1] = { ...last, text: last.text + data.text }; return next; });
        }
      }
      if (!completed) throw new Error('连接中断，完整解析尚未保存，请重试。');
    } catch (e) {
      if (current.current === id) {
        setError(e instanceof DOMException && e.name === 'AbortError' ? '已停止生成，未保存完整解析。' : e instanceof Error ? e.message : '连接失败，请重试。');
        if (text) setInput(text);
      }
    } finally { if (!completed) abort.abort(); if (current.current === id) setBusy(false); }
  };
  return <aside className="ai-sidebar"><div className="ai-header"><div className="ai-title"><Sparkles size={22} /><div><h2>AI 学习助手</h2><span>围绕这一题，学得更清楚。</span></div></div><button className="icon-button" aria-label="收起AI侧栏" onClick={onClose}><X size={20} /></button></div><div className="ai-context"><span>{labels[q.type]} · 第 {s.cursor + 1} 题</span><p>{q.stem}</p><small>题目与当前选择已自动带入</small></div><div className="ai-quick">{!restricted && <><button disabled={!configured || busy} onClick={() => void send('explain')}><BookOpen size={14} />讲解本题</button><button disabled={!configured || busy} onClick={() => void send('options')}>分析选项</button></>}<button disabled={!configured || busy} onClick={() => void send('hint')}><CircleHelp size={14} />给我提示</button>{!restricted && <button disabled={!configured || busy} onClick={() => void send('memory')}>记忆方法</button>}</div><div className="ai-messages">{!configured ? <div className="ai-empty"><Sparkles size={30} /><h3>题目已就位。</h3><p>连接 AI 接口后，就能直接讲解这道题，不用复制题目。</p><small>请在服务器配置接口地址、API Key 和模型。</small></div> : messages.length === 0 ? <div className="ai-empty"><Sparkles size={30} /><h3>{restricted ? '先给你一点提示。' : '从一个问题开始。'}</h3><p>{restricted ? '自测交卷前只提供思考方向，交卷后可以看完整讲解。' : '选择上方的快捷提问，或直接说出你不理解的地方。'}</p></div> : messages.map((m, i) => <div className={'ai-message ' + m.role} key={i}>{m.role === 'assistant' && <div className="assistant-name"><Sparkles size={13} />AI 学习助手</div>}{m.text ? <ReactMarkdown components={{ img: () => null, a: ({ href, children }) => <a href={href} children={children} target="_blank" rel="noopener noreferrer" /> }}>{m.text}</ReactMarkdown> : busy ? <LoaderCircle className="spin" size={19} /> : <span className="muted">未生成完整回答</span>}{m.options?.some((o, j) => o.id !== q.options[j]?.id) && <details className="ai-option-snapshot"><summary>这条历史解析的选项顺序</summary>{m.options.map(o => <p key={o.id}>{o.label} · {o.text}</p>)}</details>}</div>)}{error && <div className="ai-error" role="alert">{error}</div>}<div ref={bottom} /></div><div className="ai-input-wrap"><textarea aria-label="向AI追问" placeholder={configured ? restricted || channel === 'hint' ? '追问提示，不提前看答案…' : '还有哪里不理解？' : '连接 AI 后即可追问'} rows={2} disabled={!configured} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (input.trim()) void send(restricted || channel === 'hint' ? 'hint' : 'custom', input.trim()); } }} /><button className="primary ai-send" aria-label={busy ? '停止生成' : '发送追问'} disabled={!configured || (!busy && !input.trim())} onClick={() => busy ? controller.current?.abort() : void send(restricted || channel === 'hint' ? 'hint' : 'custom', input.trim())}>{busy ? <Square size={15} /> : <ArrowUp size={18} />}</button></div><p className="ai-footnote">{restricted ? '自测模式 · 交卷前只提供提示' : 'AI 解析供学习参考，判分依据题库答案。'}</p></aside>;
}
