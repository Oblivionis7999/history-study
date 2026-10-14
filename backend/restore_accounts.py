"""Offline account DB recovery. Requires an explicit confirmation flag."""
import argparse
import contextlib
import os
import shutil
import sqlite3
import time
from pathlib import Path

def recover(path, filename):
    path = Path(path).resolve(); folder = path.parent/'account-backups'
    source = (folder/filename).resolve()
    if source.parent != folder.resolve() or source.suffix != '.sqlite' or not source.name.startswith('accounts-') or not source.is_file(): raise ValueError('请选择账号备份目录内的有效文件名。')
    with contextlib.closing(sqlite3.connect(source.as_uri()+'?mode=ro', uri=True)) as c:
        if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise ValueError('备份完整性校验失败。')
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if tables != {'users','sessions','invites','limits','settings'}: raise ValueError('不是V2账号备份。')
        if not c.execute("SELECT 1 FROM users WHERE role='admin' AND disabled=0").fetchone(): raise ValueError('备份中没有有效管理员。')
    saved = path.parent/('before-account-restore-'+str(time.time_ns())); saved.mkdir(mode=0o700)
    for suffix in ['', '-wal', '-shm']:
        original = path.parent/(path.name+suffix)
        if original.exists(): shutil.copy2(original, saved/original.name)
    staged = path.parent/('.account-restore-'+str(time.time_ns())+'.sqlite')
    shutil.copy2(source, staged)
    # Restored credentials must not resurrect old sessions.
    with contextlib.closing(sqlite3.connect(staged)) as c:
        c.execute('DELETE FROM sessions'); c.commit(); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.execute('PRAGMA journal_mode=DELETE')
    if os.name != 'nt': staged.chmod(0o600)
    for suffix in ['-wal','-shm']: (path.parent/(path.name+suffix)).unlink(missing_ok=True)
    os.replace(staged, path)
    return saved

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='先停止API，再恢复账号数据库；保留当前文件并撤销旧会话。')
    parser.add_argument('filename', nargs='?'); parser.add_argument('--list', action='store_true'); parser.add_argument('--confirm-stopped', action='store_true')
    args = parser.parse_args(); path = Path(os.getenv('AUTH_DATABASE_PATH','.runtime/accounts.sqlite'))
    if args.list:
        for item in sorted((path.parent/'account-backups').glob('accounts-*.sqlite')): print(item.name)
    elif args.filename and args.confirm_stopped: print('已恢复；原文件保存在：'+recover(path,args.filename).name)
    else: parser.error('恢复前必须停止API并提供 --confirm-stopped；可先使用 --list。')
