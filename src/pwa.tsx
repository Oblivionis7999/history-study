import { useEffect, useState } from 'react';
export default function ConnectionNotice() {
  const [online, setOnline] = useState(navigator.onLine), [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    if ('serviceWorker' in navigator && !location.port.startsWith('517')) {
      void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(registration => {
        if (registration.waiting) setWaiting(registration.waiting);
        registration.addEventListener('updatefound', () => { const worker = registration.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) setWaiting(worker); }); });
      }).catch(() => { /* Core local storage does not depend on installation. */ });
    }
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return <>{!online && <div className="connection-notice" role="status">当前离线：已解锁页面可继续做题和本机保存；登录、AI 和重新打开后的身份验证需要联网。</div>}{waiting && <div className="connection-notice" role="status">发现新版本。请确认草稿已保存，再更新页面。<button className="text-button" onClick={() => { navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true }); waiting.postMessage('ACTIVATE_UPDATE'); }}>更新并重新解锁</button><button className="text-button" onClick={() => setWaiting(null)}>稍后</button></div>}</>;
}
