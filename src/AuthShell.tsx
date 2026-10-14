import { useEffect, useRef, useState } from 'react';
import { BookOpen, LockKeyhole } from 'lucide-react';
import App from './App';
import { remote } from './api';
import type { AIConfig, Bank, User } from './types';
import { configureLearning, emptyData, validateData } from './learning';
import { activeEpoch, createVault, hasVault, lockVault, readData, unlockVault } from './vault';

export function broadcastAccount() { try { localStorage.setItem('history-auth-event', crypto.randomUUID()); } catch { /* The current tab still locks. */ } }
export default function AuthShell() {
  const [user, setUser] = useState<User | null>(null), [loading, setLoading] = useState(true), [unlocked, setUnlocked] = useState(false);
  const [exists, setExists] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState('');
  const [register, setRegister] = useState(false), [username, setUsername] = useState(''), [display, setDisplay] = useState(''), [password, setPassword] = useState(''), [invite, setInvite] = useState('');
  const [phrase, setPhrase] = useState(''), [confirm, setConfirm] = useState(''), [recovery, setRecovery] = useState(false), [code, setCode] = useState('');
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const generation = useRef(0);
  const clear = () => { generation.current++; lockVault(); setUnlocked(false); setReady(false); setPassword(''); setPhrase(''); setConfirm(''); setCode(''); setRecovery(false); };
  const load = async () => {
    clear(); const token = generation.current;
    try { const r = await remote<{ user: User | null; open_registration: boolean }>('/auth/me'); if (token !== generation.current) return; setUser(r.user); setOpen(r.open_registration); setError(''); }
    catch (e) { setUser(null); setError(e instanceof Error ? e.message : '无法连接服务器。请联网登录；已保存的本机记录不会删除。'); }
    finally { if (token === generation.current) setLoading(false); }
  };
  useEffect(() => {
    void load();
    const changed = (e: StorageEvent) => { if (e.key === 'history-auth-event') void load(); };
    const expired = () => { clear(); setUser(null); setError('登录已失效，本机记录已锁定。请重新登录。'); };
    window.addEventListener('storage', changed); window.addEventListener('study-auth-expired', expired);
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('study-auth-expired', expired); clear(); };
  }, []);
  useEffect(() => {
    if (!user) return;
    let live = true;
    Promise.all([remote<Bank>('/bank'), remote<AIConfig>('/config'), hasVault(user.id)]).then(([bank, config, exists]) => {
      if (!live) return; configureLearning(bank, config); setExists(exists); setReady(true);
    }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [user?.id]);
  useEffect(() => {
    if (!unlocked || !user) return;
    const check = () => { if (!document.hidden && navigator.onLine) void remote<{ user: User | null }>('/auth/me').then(r => { if (!r.user || r.user.id !== user.id) void load(); }).catch(() => undefined); };
    const timer = setInterval(check, 60000); document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [user?.id, unlocked]);
  const logout = async () => {
    clear(); setUser(null);
    try { await remote('/auth/logout', 'POST'); setError(''); }
    catch { setError('本机已锁定。服务器暂时不可达，会话撤销尚未确认；联网后请重新登录并撤销所有会话。'); }
    broadcastAccount(); history.replaceState({}, '', '/');
  };
  if (loading) return <div className="loading-screen"><BookOpen size={36} /><p>正在连接你的学习空间…</p></div>;
  if (user && unlocked) return <App key={user.id + ':' + activeEpoch()} user={user} onLogout={logout} onLock={() => { clear(); setReady(true); }} />;
  return <main className="login-page"><section className="login-card"><BookOpen size={34} className="blue" /><p className="eyebrow">700 道题 · 9 个主题 · 你的学习空间</p><h1>史纲 Study</h1>
    {!user ? <><p>登录账号，在这台设备继续复习。</p><form onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        if (register) { await remote('/auth/register', 'POST', { username, password, display_name: display, invite }); setRegister(false); setError('账号创建成功，请登录。'); }
        else { const r = await remote<{ user: User }>('/auth/login', 'POST', { username, password }); clear(); setUser(r.user); broadcastAccount(); }
      } catch (e) { setError(e instanceof Error ? e.message : '网络连接失败，请重试。'); }
      finally { setPassword(''); setBusy(false); }
    }}><label htmlFor="username">用户名</label><input id="username" autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} pattern="[a-zA-Z0-9_-]{3,32}" required />
      {register && <><label htmlFor="display-name">显示名称</label><input id="display-name" maxLength={40} value={display} onChange={e => setDisplay(e.target.value)} required /><label htmlFor="invite-code">邀请码{open && '（开放注册时可留空）'}</label><input id="invite-code" value={invite} onChange={e => setInvite(e.target.value)} required={!open} /></>}
      <label htmlFor="login-password">登录密码</label><input id="login-password" type="password" minLength={register ? 12 : 1} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required />
      <button className="primary" disabled={busy}>{busy ? '处理中…' : register ? '创建账号' : '登录'}</button></form><button className="text-button" disabled={busy} onClick={() => { setRegister(v => !v); setError(''); setPassword(''); }}>{register ? '已有账号，去登录' : '使用邀请码注册'}</button><p className="form-caption">忘记登录密码请联系管理员。登录密码重置不影响独立的本机解锁口令。</p></> : <>
      <p className="account-name">{user.display_name} <span>@{user.username}</span></p>
      {!ready ? <p role="status">正在读取账号与本机空间…</p> : code ? <div className="recovery-box"><h2>保存本机恢复密钥</h2><p>这是忘记解锁口令时恢复此设备记录的凭据。请保存到你信任的密码管理器或离线位置；服务器无法找回。</p><code>{code}</code><button className="secondary" onClick={() => {
        const blob = new Blob([`史纲 Study 本机恢复密钥\n用户 ID：${user.id}\n恢复密钥：${code}\n仅适用于此设备密钥；跨设备请导出加密学习备份。`], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'study-recovery-key.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
      }}>下载恢复密钥</button><button className="primary" onClick={() => { setCode(''); setUnlocked(true); }}>我已妥善保存，进入学习</button></div> : <><LockKeyhole size={25} className="blue" /><h2>{exists ? '解锁本机学习记录' : '建立本机加密空间'}</h2><p className="form-caption">{exists ? '请输入独立的本机解锁口令。记录保留在此浏览器，退出账号不会删除。' : '设置与登录密码分开的本机口令。学习记录加密保存到此浏览器；其他设备通过导出、导入迁移。'}</p><form onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError(''); const token = generation.current;
        try {
          if (exists) { await unlockVault(user.id, phrase, recovery); validateData(await readData()); if (token === generation.current) setUnlocked(true); }
          else { if (phrase !== confirm) throw new Error('两次本机解锁口令不同。'); const code = await createVault(user.id, phrase, emptyData(user.id)); if (token === generation.current) { setCode(code); setExists(true); } }
        } catch (e) { lockVault(); setError(e instanceof Error ? e.message : '本机存储不可用。'); }
        finally { setPhrase(''); setConfirm(''); setBusy(false); }
      }}><label htmlFor="unlock-password">{recovery ? '恢复密钥' : '本机解锁口令'}</label><input id="unlock-password" type="password" autoComplete="off" minLength={exists ? 1 : 12} maxLength={256} value={phrase} onChange={e => setPhrase(e.target.value)} required />
        {!exists && <><label htmlFor="confirm-unlock">确认本机解锁口令</label><input id="confirm-unlock" type="password" minLength={12} maxLength={256} autoComplete="off" value={confirm} onChange={e => setConfirm(e.target.value)} required /></>}
        <button className="primary" disabled={busy || !ready}>{busy ? '正在解锁…' : !ready ? '正在准备题库…' : exists ? '解锁学习空间' : '创建加密空间'}</button></form>
        {exists && <button className="text-button" onClick={() => { setRecovery(v => !v); setPhrase(''); }}>{recovery ? '使用本机口令解锁' : '忘记本机口令，使用恢复密钥'}</button>}</>}
      <button className="text-button" disabled={busy} onClick={() => void logout()}>退出并切换账号</button></>}
    {error && <p className="error" role="alert">{error}</p>}
    <p className="local-disclosure">清除网站数据、卸载浏览器、隐私模式退出或系统清理可能丢失本机记录，请定期导出加密备份。AI 开启时，本题、当前选择和追问会发送给服务器及模型供应商。</p>
  </section></main>;
}
