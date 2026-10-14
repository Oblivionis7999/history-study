import asyncio
import ipaddress
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.middleware.gzip import GZipMiddleware
from .accounts import Accounts, digest, password_hash, public_user, verify
from .bank import ROOT, BANK, QUESTIONS

load_dotenv(ROOT / '.env')

@dataclass
class Config:
    dev: bool = os.getenv('DEV_MODE', '0') == '1'
    public_origin: str = os.getenv('PUBLIC_ORIGIN', '').rstrip('/')
    trusted_proxies: str = os.getenv('TRUSTED_PROXY_CIDRS', '')
    session_hours: int = int(os.getenv('SESSION_HOURS', '12'))
    ai_base: str = os.getenv('AI_BASE_URL', '').rstrip('/')
    ai_key: str = os.getenv('AI_API_KEY', '')
    ai_model: str = os.getenv('AI_MODEL', '')
    ai_stream: bool = os.getenv('AI_STREAM', '1') == '1'
    ai_minute: int = int(os.getenv('AI_USER_PER_MINUTE', '6'))
    ai_daily: int = int(os.getenv('AI_USER_DAILY', '80'))
    ai_global_daily: int = int(os.getenv('AI_GLOBAL_DAILY', '500'))
    ai_concurrency: int = int(os.getenv('AI_CONCURRENCY', '3'))
    ai_max_tokens: int = int(os.getenv('AI_MAX_TOKENS', '1800'))

class Login(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=128)

class Registration(Login):
    display_name: str = Field(min_length=1, max_length=40)
    invite: str = Field(default='', max_length=128)

class PasswordChange(BaseModel):
    current_password: str = Field(max_length=128)
    new_password: str = Field(min_length=12, max_length=128)

class Invite(BaseModel):
    days: int = Field(default=7, ge=1, le=90)
    max_uses: int = Field(default=1, ge=1, le=100)

class AccountUpdate(BaseModel):
    disabled: bool | None = None
    new_password: str | None = Field(default=None, min_length=12, max_length=128)

class Settings(BaseModel):
    open_registration: bool
    ai_enabled: bool
    ai_daily: int = Field(ge=0, le=10000)
    ai_global_daily: int = Field(ge=0, le=100000)

def create_app(db_path=None, config=None):
    cfg = config or Config()
    db = Accounts(db_path or os.getenv('AUTH_DATABASE_PATH', str(ROOT / '.runtime/accounts.sqlite')))
    proxies = [ipaddress.ip_network(v.strip()) for v in cfg.trusted_proxies.split(',') if v.strip()]

    async def backup_loop():
        last = None
        while True:
            now = datetime.now(ZoneInfo('Asia/Shanghai'))
            if now.hour >= 3 and last != now.date():
                try:
                    await asyncio.to_thread(db.backup); last = now.date()
                except Exception:
                    logging.error('Account backup failed; check storage permissions and capacity.')
            await asyncio.sleep(60)

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(backup_loop())
        yield
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass

    app = FastAPI(title='史纲 Study V2', lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)
    app.state.db = db
    app.state.config = cfg
    app.state.ai_active = set()

    def client_ip(request):
        remote = request.client.host if request.client else 'unknown'
        try:
            if any(ipaddress.ip_address(remote) in net for net in proxies):
                for entry in reversed(request.headers.get('x-forwarded-for', '').split(',')):
                    candidate = ipaddress.ip_address(entry.strip())
                    if not any(candidate in net for net in proxies): return str(candidate)
        except ValueError: pass
        return remote

    def throttle(request, username=''):
        minute = 'm:' + str(int(time.time() / 60))
        ip = client_ip(request)
        db.consume([('auth:' + digest(ip + ':' + username.lower()), minute, 10), ('auth-ip:' + digest(ip), minute, 120)])

    @app.middleware('http')
    async def gate(request, call_next):
        path = request.url.path
        if request.headers.get('content-length', '').isdigit() and int(request.headers['content-length']) > 256 * 1024:
            return JSONResponse({'detail': '请求过大。'}, status_code=413)
        public = path in {'/api/health', '/api/auth/me', '/api/auth/login', '/api/auth/register'}
        user = await asyncio.to_thread(db.session, request.cookies.get('history_session'))
        request.state.user = user
        if request.headers.get('x-study-user') and (not user or user['id'] != request.headers['x-study-user']):
            return JSONResponse({'detail': '账号已切换，请重新登录。'}, status_code=401)
        if path.startswith('/api') and not public and not user:
            return JSONResponse({'detail': '登录已过期或账号已停用，请重新登录。'}, status_code=401)
        if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            origin = request.headers.get('origin')
            expected = cfg.public_origin or ('http' if cfg.dev else 'https') + '://' + request.headers.get('host', '')
            if request.headers.get('x-study-request') != '1' or (origin and origin != expected):
                return JSONResponse({'detail': '请求来源校验失败。'}, status_code=403)
        try: response = await call_next(request)
        except Exception:
            logging.error('Unhandled request failure (request body is never logged).')
            return JSONResponse({'detail': '服务暂时不可用，请稍后重试。'}, status_code=500)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    def admin(request):
        if not request.state.user or request.state.user['role'] != 'admin': raise HTTPException(403, '需要管理员权限。')
        return request.state.user

    def cookie(response, uid):
        lifetime = max(1, min(cfg.session_hours, 168)) * 3600
        token = db.new_session(uid, lifetime)
        response.set_cookie('history_session', token, httponly=True, secure=not cfg.dev, samesite='strict', max_age=lifetime, path='/')

    @app.get('/api/health')
    def health():
        return {'ok': True, 'bank_count': len(QUESTIONS), 'version': BANK['version'], 'app_version': '2.0.0'}

    @app.get('/api/auth/me')
    def me(request: Request):
        with db.connect() as c: setting = c.execute("SELECT value FROM settings WHERE key='open_registration'").fetchone()
        return {'user': request.state.user, 'development': cfg.dev, 'open_registration': bool(setting and setting['value'])}

    @app.post('/api/auth/login')
    def login(body: Login, request: Request, response: Response):
        throttle(request, body.username)
        with db.connect() as c: row = c.execute('SELECT * FROM users WHERE username=?', (body.username.strip().lower(),)).fetchone()
        valid = verify(row['password_hash'] if row else None, body.password)
        if not row or not valid or row['disabled']: raise HTTPException(401, '用户名或密码不正确，或账号已停用。')
        db.revoke(token=request.cookies.get('history_session'))
        cookie(response, row['id'])
        return {'user': public_user(row)}

    @app.post('/api/auth/register')
    def register(body: Registration, request: Request):
        throttle(request, body.username)
        return {'user': db.create_user(body.username, body.display_name, body.password, invite=body.invite)}

    @app.post('/api/auth/logout')
    def logout(request: Request, response: Response):
        db.revoke(token=request.cookies.get('history_session'))
        response.delete_cookie('history_session', path='/')
        return {'ok': True}

    @app.post('/api/auth/revoke-all')
    def revoke_all(request: Request, response: Response):
        db.revoke(uid=request.state.user['id'])
        response.delete_cookie('history_session', path='/')
        return {'ok': True}

    @app.post('/api/auth/password')
    def change_password(body: PasswordChange, request: Request, response: Response):
        uid = request.state.user['id']
        throttle(request, uid)
        encoded = password_hash(body.new_password)
        with db.connect() as c:
            row = c.execute('SELECT password_hash FROM users WHERE id=?', (uid,)).fetchone()
            if not verify(row['password_hash'], body.current_password): raise HTTPException(400, '当前密码不正确。')
            c.execute('UPDATE users SET password_hash=? WHERE id=?', (encoded, uid))
            c.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
        response.delete_cookie('history_session', path='/')
        return {'ok': True}

    @app.patch('/api/auth/profile')
    def profile(body: dict, request: Request):
        name = body.get('display_name')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40: raise HTTPException(400, '显示名称需要 1–40 个字符。')
        with db.connect() as c: c.execute('UPDATE users SET display_name=? WHERE id=?', (name.strip(), request.state.user['id']))
        return {'ok': True}

    @app.get('/api/bank')
    def bank():
        # Local grading delivers answers. Self-test is a learning UX, not anti-cheat.
        return {k: BANK[k] for k in ('title', 'version', 'themes')} | {'questions': [{k: q[k] for k in ('id', 'type', 'stem', 'theme', 'shuffle_safe', 'source_number', 'options', 'answer_ids')} for q in QUESTIONS.values()]}

    @app.get('/api/config')
    def configuration(request: Request):
        with db.connect() as c:
            settings = dict(c.execute('SELECT key,value FROM settings').fetchall())
            used = c.execute('SELECT count FROM limits WHERE key=? AND bucket=?', ('ai-user:' + request.state.user['id'], 'd:' + str(int(time.time()/86400)))).fetchone()
        return {'configured': bool(cfg.ai_base and cfg.ai_key and cfg.ai_model and settings.get('ai_enabled', 1)), 'model': cfg.ai_model,
                'cache_scope': digest(cfg.ai_base + ':' + cfg.ai_model + ':v2'), 'daily_limit': settings.get('ai_daily', cfg.ai_daily), 'used_today': used['count'] if used else 0}

    @app.get('/api/admin')
    def overview(request: Request):
        admin(request)
        with db.connect() as c:
            return {'users': [public_user(row) for row in c.execute('SELECT * FROM users ORDER BY created_at')],
                    'invites': [dict(row) for row in c.execute('SELECT id,expires_at,max_uses,uses,disabled FROM invites')],
                    'settings': {'open_registration': 0, 'ai_enabled': 1, 'ai_daily': cfg.ai_daily, 'ai_global_daily': cfg.ai_global_daily} | dict(c.execute('SELECT key,value FROM settings').fetchall()),
                    'active_sessions': c.execute('SELECT count(*) FROM sessions WHERE expires_at>?', (time.time(),)).fetchone()[0],
                    'bank_count': len(QUESTIONS), 'ai_configured': bool(cfg.ai_base and cfg.ai_key and cfg.ai_model)}

    @app.post('/api/admin/users')
    def create_user(body: Registration, request: Request):
        admin(request)
        return db.create_user(body.username, body.display_name, body.password, admin=True)

    @app.patch('/api/admin/users/{uid}')
    def update_user(uid: str, body: AccountUpdate, request: Request):
        current = admin(request)
        if uid == current['id']: raise HTTPException(400, '不能停用或重置当前管理员；修改自己的密码请使用账号设置。')
        encoded = password_hash(body.new_password) if body.new_password else None
        with db.connect() as c:
            row = c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
            if not row: raise HTTPException(404, '账号不存在。')
            if row['role'] == 'admin' and body.disabled and c.execute("SELECT count(*) FROM users WHERE role='admin' AND disabled=0").fetchone()[0] <= 1:
                raise HTTPException(400, '必须保留一个有效管理员。')
            if body.disabled is not None: c.execute('UPDATE users SET disabled=? WHERE id=?', (int(body.disabled), uid))
            if encoded: c.execute('UPDATE users SET password_hash=? WHERE id=?', (encoded, uid))
            c.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
        return {'ok': True}

    @app.post('/api/admin/users/{uid}/revoke')
    def revoke_user(uid: str, request: Request):
        admin(request); db.revoke(uid=uid)
        return {'ok': True}

    @app.post('/api/admin/invites')
    def invite(body: Invite, request: Request):
        admin(request)
        code, iid = secrets.token_urlsafe(24), secrets.token_hex(16)
        expires = time.time() + body.days * 86400
        with db.connect() as c: c.execute('INSERT INTO invites VALUES(?,?,?,?,0,0)', (iid, digest(code), expires, body.max_uses))
        return {'id': iid, 'code': code, 'expires_at': expires}

    @app.delete('/api/admin/invites/{iid}')
    def disable_invite(iid: str, request: Request):
        admin(request)
        with db.connect() as c: c.execute('UPDATE invites SET disabled=1 WHERE id=?', (iid,))
        return {'ok': True}

    @app.put('/api/admin/settings')
    def settings(body: Settings, request: Request):
        admin(request)
        with db.connect() as c:
            for key, value in body.model_dump().items(): c.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, int(value)))
        return {'ok': True}

    from .ai import register_ai
    register_ai(app, db, cfg, QUESTIONS)
    return app

app = create_app()
