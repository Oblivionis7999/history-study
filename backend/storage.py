import contextlib
import json
import sqlite3
import threading
import time
from pathlib import Path

class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        with self.transaction() as c:
            c.execute('PRAGMA journal_mode=WAL')
            c.execute('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated REAL NOT NULL, PRIMARY KEY(kind,id))')

    @contextlib.contextmanager
    def transaction(self):
        with self.lock:
            c = sqlite3.connect(self.path, timeout=10)
            c.row_factory = sqlite3.Row
            try:
                c.execute('PRAGMA busy_timeout=10000')
                yield c
                c.commit()
            except BaseException:
                c.rollback()
                raise
            finally:
                c.close()

    @staticmethod
    def get(c, kind, id):
        row = c.execute('SELECT data FROM records WHERE kind=? AND id=?',(kind,id)).fetchone()
        return json.loads(row['data']) if row else None

    @staticmethod
    def all(c, kind):
        return [json.loads(r['data']) for r in c.execute('SELECT data FROM records WHERE kind=? ORDER BY updated DESC',(kind,))]

    @staticmethod
    def put(c, kind, id, data):
        previous = Store.get(c,kind,id)
        data['id'] = id
        data['revision'] = (previous or {}).get('revision',0)+1
        data['updated_at'] = time.time()
        c.execute('INSERT INTO records(kind,id,data,updated) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated=excluded.updated',
                  (kind,id,json.dumps(data,ensure_ascii=False),data['updated_at']))
        return data

    def backup(self):
        folder = self.path.parent/'backups'; folder.mkdir(exist_ok=True)
        target = folder/f'history-{time.strftime("%Y%m%d-%H%M%S",time.gmtime())}-{time.time_ns()}.sqlite'
        with self.lock:
            with contextlib.closing(sqlite3.connect(self.path)) as source, contextlib.closing(sqlite3.connect(target)) as destination:
                source.backup(destination)
            for old in sorted(folder.glob('history-*.sqlite'),key=lambda p:p.stat().st_mtime,reverse=True)[7:]:
                old.unlink()
        return target
