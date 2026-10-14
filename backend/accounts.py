"""Identity-only SQLite store; never stores learning records or AI content."""
import argparse
import contextlib
import getpass
import hashlib
import os
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from fastapi import HTTPException

HASHER = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)
DUMMY_HASH = HASHER.hash(secrets.token_urlsafe(32))

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

def password_hash(password):
    if not isinstance(password, str) or not 12 <= len(password) <= 128:
        raise HTTPException(400, '密码需要 12–128 个字符。')
    return HASHER.hash(password)

def verify(encoded, password):
    try:
        return HASHER.verify(encoded or DUMMY_HASH, password)
    except (VerificationError, InvalidHashError):
        return False

def public_user(row):
    return {k: row[k] for k in ('id', 'username', 'display_name', 'role', 'disabled', 'created_at')}

class Accounts:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(sqlite3.connect(self.path)) as init:
            init.execute('PRAGMA journal_mode=WAL')
        with self.connect() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                    display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('admin','user')),
                    disabled INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL REFERENCES users(id), created_at REAL NOT NULL, expires_at REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
                CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, code_hash TEXT UNIQUE NOT NULL,
                    expires_at REAL NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
                    disabled INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS limits (key TEXT NOT NULL, bucket TEXT NOT NULL,
                    count INTEGER NOT NULL, PRIMARY KEY(key,bucket));
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
                PRAGMA user_version=1;
            ''')
        if os.name != 'nt': self.path.chmod(0o600)

    @contextlib.contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=15)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA foreign_keys=ON')
        try:
            c.execute('BEGIN IMMEDIATE')
            yield c
            c.commit()
        except BaseException:
            c.rollback()
            raise
        finally: c.close()

    def create_user(self, username, display_name, password, role='user', invite=None, admin=False):
        username = username.strip().lower()
        if not re.fullmatch(r'[a-z0-9_-]{3,32}', username):
            raise HTTPException(400, '用户名使用 3–32 位字母、数字、下划线或短横线。')
        if not 1 <= len(display_name.strip()) <= 40:
            raise HTTPException(400, '显示名称需要 1–40 个字符。')
        encoded = password_hash(password)
        with self.connect() as c:
            if not admin:
                row = c.execute('SELECT * FROM invites WHERE code_hash=?', (digest(invite or ''),)).fetchone()
                opened = c.execute("SELECT value FROM settings WHERE key='open_registration'").fetchone()
                if not (opened and opened['value']):
                    if not row or row['disabled'] or row['expires_at'] <= time.time() or row['uses'] >= row['max_uses']:
                        raise HTTPException(400, '邀请码无效、已过期或次数已用完。')
                    c.execute('UPDATE invites SET uses=uses+1 WHERE id=?', (row['id'],))
            uid = str(uuid.uuid4())
            try:
                c.execute('INSERT INTO users VALUES(?,?,?,?,?,0,?)', (uid, username, display_name.strip(), encoded, role, time.time()))
            except sqlite3.IntegrityError:
                raise HTTPException(409, '此用户名不可用。')
            return public_user(c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone())

    def session(self, token):
        if not token: return None
        with self.connect() as c:
            row = c.execute('''SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0''', (digest(token), time.time())).fetchone()
            return public_user(row) if row else None

    def new_session(self, uid, lifetime):
        token = secrets.token_urlsafe(32)
        with self.connect() as c:
            user = c.execute('SELECT disabled FROM users WHERE id=?', (uid,)).fetchone()
            if not user or user['disabled']: raise HTTPException(401, '账号已停用。')
            c.execute('DELETE FROM sessions WHERE expires_at<?', (time.time(),))
            c.execute('INSERT INTO sessions VALUES(?,?,?,?)', (digest(token), uid, time.time(), time.time() + lifetime))
        return token

    def revoke(self, token=None, uid=None):
        with self.connect() as c:
            if uid: c.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
            else: c.execute('DELETE FROM sessions WHERE token_hash=?', (digest(token or ''),))

    def consume(self, limits):
        """Check and increment all quotas atomically; buckets contain no user content."""
        with self.connect() as c:
            for key, bucket, maximum in limits:
                row = c.execute('SELECT count FROM limits WHERE key=? AND bucket=?', (key, bucket)).fetchone()
                if maximum <= 0 or (row and row['count'] >= maximum):
                    raise HTTPException(429, '请求已达频率或当日限额，请稍后再试。', headers={'Retry-After': '60'})
            for key, bucket, _ in limits:
                c.execute('INSERT INTO limits VALUES(?,?,1) ON CONFLICT(key,bucket) DO UPDATE SET count=count+1', (key, bucket))
            c.execute("DELETE FROM limits WHERE (bucket LIKE 'm:%' AND CAST(substr(bucket,3) AS INTEGER)<?) OR (bucket LIKE 'd:%' AND CAST(substr(bucket,3) AS INTEGER)<?)", (int(time.time()/60)-1440, int(time.time()/86400)-8))

    def backup(self):
        folder = self.path.parent / 'account-backups'
        folder.mkdir(exist_ok=True)
        if os.name != 'nt': folder.chmod(0o700)
        target = folder / f'accounts-{time.time_ns()}.sqlite'
        with contextlib.closing(sqlite3.connect(self.path)) as source, contextlib.closing(sqlite3.connect(target)) as dest:
            source.backup(dest)
        if os.name != 'nt': target.chmod(0o600)
        for old in sorted(folder.glob('accounts-*.sqlite'), key=lambda p: p.stat().st_mtime, reverse=True)[7:]: old.unlink()
        return target

def main():
    parser = argparse.ArgumentParser(description='创建管理员；不修改已有账号或旧学习数据库。')
    parser.add_argument('command', choices=['create-admin', 'backup'])
    parser.add_argument('--username')
    parser.add_argument('--password-stdin', action='store_true', help='仅用于隔离自动化环境')
    args = parser.parse_args()
    db = Accounts(os.getenv('AUTH_DATABASE_PATH', '.runtime/accounts.sqlite'))
    if args.command == 'backup':
        print(db.backup().name); return
    username = args.username or input('管理员用户名：')
    if args.password_stdin:
        import sys
        password = sys.stdin.readline().rstrip('\r\n')
    else:
        password = getpass.getpass('管理员密码（至少12字符）：')
        if getpass.getpass('确认密码：') != password: raise SystemExit('两次密码不同，未创建。')
    user = db.create_user(username, username, password, role='admin', admin=True)
    print('已创建管理员，用户 ID：' + user['id'])

if __name__ == '__main__': main()
