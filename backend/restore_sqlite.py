"""Offline recovery: run only while the API service is stopped."""
import argparse
import contextlib
import os
import shutil
import sqlite3
import time
from pathlib import Path
from .bank import BANK, QUESTIONS, TITLES, DEFAULT_PREFS
from .backup import validate_records
from .storage import Store

def recover(store, filename):
    folder=store.path.parent/'backups'
    source=(folder/filename).resolve()
    if source.parent!=folder.resolve() or not source.name.startswith('history-') or source.suffix!='.sqlite' or not source.is_file():
        raise ValueError('请选择备份目录内的有效SQLite文件名。')
    with contextlib.closing(sqlite3.connect(source)) as c:
        if c.execute('PRAGMA integrity_check').fetchone()[0]!='ok':
            raise ValueError('备份数据库完整性校验失败。')
        c.row_factory=sqlite3.Row
        validate_records({k:Store.all(c,k) for k in ['session','state','chat','cache','prefs']},QUESTIONS,BANK['version'],TITLES,DEFAULT_PREFS)
    # Keep the pre-recovery files together, including journal sidecars.
    current=store.path.parent/('before-restore-'+str(time.time_ns()))
    current.mkdir()
    for name in [store.path.name,store.path.name+'-wal',store.path.name+'-shm']:
        path=store.path.parent/name
        if path.is_file():
            shutil.copy2(path,current/name)
    staged=store.path.parent/('.restore-'+str(time.time_ns())+'.sqlite')
    shutil.copy2(source,staged)
    # All paths below are checked inside the explicitly configured runtime folder.
    for suffix in ['-wal','-shm']:
        (store.path.parent/(store.path.name+suffix)).unlink(missing_ok=True)
    os.replace(staged,store.path)
    return current

if __name__=='__main__':
    parser=argparse.ArgumentParser(description='停服务后的SQLite恢复')
    parser.add_argument('filename',nargs='?')
    parser.add_argument('--list',action='store_true')
    args=parser.parse_args()
    runtime=Path(os.getenv('DATABASE_PATH',str(Path(__file__).resolve().parents[1]/'.runtime/history.sqlite')))
    if args.list:
        for p in sorted((runtime.parent/'backups').glob('history-*.sqlite')): print(p.name)
    elif args.filename:
        # Avoid opening a possibly damaged current DB before copying its snapshot.
        store=Store.__new__(Store); store.path=runtime
        try: saved=recover(store,args.filename)
        except (ValueError,KeyError,TypeError,sqlite3.Error,OSError) as e: raise SystemExit('恢复失败：'+str(e))
        print('已恢复。恢复前文件保存在：'+str(saved))
    else: parser.print_help()
