import hashlib
import json
import sqlite3
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import httpx
import pytest
from fastapi.testclient import TestClient
from backend.accounts import Accounts, digest
from backend.app import Config, create_app
from backend.bank import BANK, QUESTIONS

PASSWORD = 'isolated-test-password-123'
HEADERS = {'X-Study-Request': '1'}

@pytest.fixture
def app(tmp_path):
    app = create_app(tmp_path/'accounts.sqlite', Config(dev=True))
    app.state.admin = app.state.db.create_user('administrator', '测试管理员', PASSWORD, role='admin', admin=True)
    return app

def login(client, username='administrator', password=PASSWORD):
    return client.post('/api/auth/login', json={'username': username, 'password': password}, headers=HEADERS)

def client(app): return TestClient(app, headers=HEADERS)

def test_auth_invites_profiles_and_user_boundaries(app):
    with client(app) as admin, client(app) as a, client(app) as b:
        assert a.get('/api/bank').status_code == 401
        assert login(admin).status_code == 200
        invite = admin.post('/api/admin/invites', json={'max_uses': 2, 'days': 1}).json()
        for browser, name in [(a, 'alice'), (b, 'bob')]:
            r = browser.post('/api/auth/register', json={'username': name, 'display_name': name, 'password': PASSWORD, 'invite': invite['code']})
            assert r.status_code == 200
            assert login(browser, name).status_code == 200
            assert browser.get('/api/admin').status_code == 403
        ua, ub = a.get('/api/auth/me').json()['user'], b.get('/api/auth/me').json()['user']
        assert ua['id'] != ub['id'] and 'password_hash' not in ua
        assert a.get('/api/bank', headers={'X-Study-User': ub['id']}).status_code == 401
        assert a.patch('/api/auth/profile', json={'display_name': '新名字'}).status_code == 200
        assert a.get('/api/auth/me').json()['user']['id'] == ua['id']
        assert a.post('/api/auth/register', json={'username': 'third', 'display_name': '第三人', 'password': PASSWORD, 'invite': invite['code']}).status_code == 400
        for route in ['/api/export', '/api/dashboard', '/api/sessions', '/api/ai/history/single-1']:
            assert a.get(route).status_code == 404
        assert a.post('/api/restore', json={}).status_code == 404

def test_invite_expiry_disable_and_atomic_consumption(app):
    db = app.state.db
    with client(app) as c:
        login(c)
        code = c.post('/api/admin/invites', json={'max_uses': 1}).json()
        def register(i):
            try: return db.create_user('concurrent'+str(i), '测试', PASSWORD, invite=code['code'])
            except Exception: return None
        with ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(register, range(2)))
        assert sum(r is not None for r in results) == 1
        code = c.post('/api/admin/invites', json={}).json()
        c.delete('/api/admin/invites/'+code['id'])
        assert c.post('/api/auth/register', json={'username': 'disabledinvite', 'display_name': '测试', 'password': PASSWORD, 'invite': code['code']}).status_code == 400
        code = c.post('/api/admin/invites', json={}).json()
        with db.connect() as conn: conn.execute('UPDATE invites SET expires_at=? WHERE id=?', (time.time()-1, code['id']))
        assert c.post('/api/auth/register', json={'username': 'expiredinvite', 'display_name': '测试', 'password': PASSWORD, 'invite': code['code']}).status_code == 400

def test_password_rotation_logout_revoke_disable_and_reset(app):
    with client(app) as admin, client(app) as a, client(app) as another:
        login(admin)
        user = admin.post('/api/admin/users', json={'username': 'alice', 'display_name': 'A', 'password': PASSWORD}).json()
        login(a, 'alice'); login(another, 'alice')
        old = a.cookies.get('history_session')
        assert a.post('/api/auth/password', json={'current_password': PASSWORD, 'new_password': PASSWORD+'new'}).status_code == 200
        assert another.get('/api/bank').status_code == 401
        assert app.state.db.session(old) is None
        assert login(a, 'alice', PASSWORD).status_code == 401
        assert login(a, 'alice', PASSWORD+'new').status_code == 200
        assert admin.patch('/api/admin/users/'+user['id'], json={'disabled': True}).status_code == 200
        assert a.get('/api/bank').status_code == 401
        admin.patch('/api/admin/users/'+user['id'], json={'disabled': False, 'new_password': PASSWORD})
        assert login(a, 'alice').status_code == 200
        login(another, 'alice')
        assert a.post('/api/auth/revoke-all').status_code == 200
        assert another.get('/api/bank').status_code == 401
        login(a, 'alice'); token = a.cookies.get('history_session')
        a.post('/api/auth/logout')
        assert app.state.db.session(token) is None
        assert admin.patch('/api/admin/users/'+app.state.admin['id'], json={'disabled': True}).status_code == 400

def test_cookie_csrf_expiry_fixation_and_rate_limit(tmp_path):
    app = create_app(tmp_path/'accounts.sqlite', Config(dev=False, public_origin='https://study.test'))
    app.state.db.create_user('alice', 'A', PASSWORD, admin=True)
    with TestClient(app, base_url='https://study.test') as c:
        body = {'username': 'alice', 'password': PASSWORD}
        assert c.post('/api/auth/login', json=body).status_code == 403
        assert c.post('/api/auth/login', json=body, headers=HEADERS|{'Origin':'https://evil.test'}).status_code == 403
        r = c.post('/api/auth/login', json=body, headers=HEADERS|{'Origin':'https://study.test'})
        assert r.status_code == 200
        for flag in ['HttpOnly', 'Secure', 'SameSite=strict']: assert flag in r.headers['set-cookie']
        token = c.cookies.get('history_session')
        assert login(c, 'alice').status_code == 200
        assert token != c.cookies.get('history_session') and app.state.db.session(token) is None
        with app.state.db.connect() as conn: conn.execute('UPDATE sessions SET expires_at=?', (time.time()-1,))
        assert c.get('/api/bank').status_code == 401
        for i in range(12): r = c.post('/api/auth/login', json={'username':'invaliduser', 'password':'bad'}, headers=HEADERS|{'X-Forwarded-For':str(i)})
        assert r.status_code == 429
        # A noisy account does not lock another user behind the same public IP.
        assert login(c, 'alice').status_code == 200

def test_identity_database_is_separate_and_persistent(app):
    path = app.state.db.path
    with client(app) as c:
        login(c); token = c.cookies.get('history_session')
        c.get('/api/bank')
    db = Accounts(path)
    assert db.session(token)['username'] == 'administrator'
    with db.connect() as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert tables == {'users','sessions','invites','limits','settings'}
        row = conn.execute('SELECT password_hash FROM users').fetchone()[0]
        assert row.startswith('$argon2id$') and PASSWORD not in row
        assert conn.execute('SELECT token_hash FROM sessions').fetchone()[0] == digest(token)
    for _ in range(8): backup = db.backup()
    assert len(list(backup.parent.glob('accounts-*.sqlite'))) == 7
    assert sqlite3.connect(backup).execute('PRAGMA integrity_check').fetchone()[0] == 'ok'

def test_bank_count_and_byte_for_byte_baseline():
    import subprocess
    current = Path('data/questions.json').read_bytes().replace(b'\r\n', b'\n')
    baseline = subprocess.check_output(['git','show','v1.0.0:data/questions.json'])
    assert hashlib.sha256(current).digest() == hashlib.sha256(baseline).digest()
    assert len(QUESTIONS) == 700 and len(BANK['themes']) == 9
    assert {kind:sum(q['type']==kind for q in QUESTIONS.values()) for kind in ['single','multiple','judge']} == {'single':300,'multiple':300,'judge':100}

def test_offline_identity_recovery_preserves_corruption_and_revokes_sessions(app):
    from backend.restore_accounts import recover
    db=app.state.db
    token=db.new_session(app.state.admin['id'],3600); backup=db.backup()
    db.path.write_bytes(b'corrupt identity fixture')
    preserved=recover(db.path,backup.name)
    assert (preserved/db.path.name).read_bytes()==b'corrupt identity fixture'
    restored=Accounts(db.path)
    assert restored.session(token) is None
    with restored.connect() as c: assert c.execute('SELECT count(*) FROM users').fetchone()[0]==1
    with pytest.raises(ValueError): recover(db.path,'../outside.sqlite')

def ai_body():
    q = next(iter(QUESTIONS.values()))
    return {'question_id':q['id'],'order':[o['id'] for o in q['options']], 'selected':[], 'action':'explain'}

def test_ai_stateless_limits_hint_and_complete_stream(app):
    cfg = app.state.config
    cfg.ai_base='https://provider.test/v1'; cfg.ai_key='test-only'; cfg.ai_model='test'; cfg.ai_daily=2
    requests=[]
    def handler(request):
        payload=json.loads(request.content); requests.append(payload)
        return httpx.Response(200,text='data: '+json.dumps({'choices':[{'delta':{'content':'模拟解析'},'finish_reason':'stop'}]})+'\n\ndata: [DONE]\n\n')
    app.state.ai_transport=httpx.MockTransport(handler)
    with client(app) as c:
        login(c)
        assert c.post('/api/ai/chat',json=ai_body()|{'restricted':True}).status_code==403
        r=c.post('/api/ai/chat',json=ai_body())
        assert '"type": "done"' in r.text
        r=c.post('/api/ai/chat',json=ai_body()|{'action':'hint','restricted':True})
        assert '"type": "done"' in r.text
        context=json.loads(requests[-1]['messages'][0]['content'].split('本题上下文：')[1])
        assert '题库参考答案' not in context and requests[0]['max_tokens'] == cfg.ai_max_tokens
        assert c.post('/api/ai/chat',json=ai_body()).status_code==429
        assert c.get('/api/config').json()['used_today']==2
        with app.state.db.connect() as conn:
            for table in ['users','sessions','invites','limits','settings']:
                assert '模拟解析' not in str([tuple(r) for r in conn.execute('SELECT * FROM '+table)])

@pytest.mark.parametrize('finish', ['length', 'content_filter', None])
def test_partial_ai_never_marked_complete(app,finish):
    cfg=app.state.config; cfg.ai_base='https://provider.test'; cfg.ai_key='test'; cfg.ai_model='test'
    app.state.ai_transport=httpx.MockTransport(lambda r:httpx.Response(200,text='data: '+json.dumps({'choices':[{'delta':{'content':'未完成'},'finish_reason':finish}]})+'\n\ndata: [DONE]\n\n'))
    with client(app) as c:
        login(c); r=c.post('/api/ai/chat',json=ai_body())
        assert '"type": "done"' not in r.text and '"type": "error"' in r.text
        assert not app.state.ai_active

def test_global_ai_limit_and_admin_pause(app):
    cfg=app.state.config; cfg.ai_base='https://provider.test'; cfg.ai_key='test'; cfg.ai_model='test'; cfg.ai_global_daily=1; cfg.ai_stream=False
    app.state.ai_transport=httpx.MockTransport(lambda r:httpx.Response(200,json={'choices':[{'message':{'content':'模拟解析'},'finish_reason':'stop'}]}))
    app.state.db.create_user('alice','A',PASSWORD,admin=True)
    with client(app) as a, client(app) as admin:
        login(a,'alice'); login(admin)
        assert '"type": "done"' in a.post('/api/ai/chat',json=ai_body()).text
        assert admin.post('/api/ai/chat',json=ai_body()).status_code==429
        admin.put('/api/admin/settings',json={'open_registration':False,'ai_enabled':False,'ai_daily':80,'ai_global_daily':500})
        assert a.post('/api/ai/chat',json=ai_body()).status_code==503
