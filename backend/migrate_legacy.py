"""Explicit, offline V1 export. Source is read-only; target ownership is mandatory."""
import argparse
import base64
import contextlib
import getpass
import hashlib
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .backup import validate_records
from .bank import BANK, QUESTIONS, TITLES, DEFAULT_PREFS

def read_records(source):
    with contextlib.closing(sqlite3.connect(Path(source).resolve().as_uri() + '?mode=ro', uri=True)) as c:
        if c.execute('PRAGMA integrity_check').fetchone()[0] != 'ok': raise ValueError('旧数据库完整性校验失败。')
        if not c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").fetchone(): raise ValueError('不是第一版学习数据库。')
        records = {kind: [json.loads(row[0]) for row in c.execute('SELECT data FROM records WHERE kind=? ORDER BY updated', (kind,))] for kind in ['session', 'state', 'chat', 'cache', 'prefs']}
    validate_records(records, QUESTIONS, BANK['version'], TITLES, DEFAULT_PREFS)
    return records

def convert(records, owner):
    uuid.UUID(owner)
    prefs = DEFAULT_PREFS.copy()
    if records['prefs']: prefs.update({key: records['prefs'][0][key] for key in DEFAULT_PREFS})
    chats = {c['id']: c['messages'] for c in records['chat']}
    for c in records['cache']:
        chats.setdefault(c['question_id'] + ':solution', [{'role': 'assistant', 'text': c['text']}])
    return {'schema': 2, 'owner': owner, 'bank_version': BANK['version'],
            'sessions': {s['id']: s for s in records['session']}, 'states': {s['id']: s for s in records['state']},
            'prefs': prefs, 'chats': chats, 'cache': {}, 'pending': {}, 'noteDrafts': {}, 'lastBackup': 0, 'dailyTarget': 20}

def encrypt(data, password):
    if not 12 <= len(password) <= 256: raise ValueError('备份口令需要12–256字符。')
    salt, iv = os.urandom(16), os.urandom(12)
    b64 = lambda data: base64.b64encode(data).decode('ascii')
    header = {'format': 'history-study-encrypted-v2', 'owner': data['owner'], 'bank_version': data['bank_version'],
              'exported_at': int(time.time()*1000), 'kdf': 'PBKDF2-SHA256', 'iterations': 600000, 'salt': b64(salt)}
    dump = lambda data: json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    key = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 600000, 32)
    return header | {'payload': {'iv': b64(iv), 'data': b64(AESGCM(key).encrypt(iv, dump(data), dump(header)))}}

def export_legacy(source, target, owner, password):
    source, target = Path(source).resolve(), Path(target).resolve()
    uuid.UUID(owner)
    if not source.is_file() or target.exists() or source == target: raise ValueError('源文件不存在或目标已存在；不会覆盖任何文件。')
    target.parent.mkdir(parents=True, exist_ok=True)
    backup = target.parent / f'legacy-preserved-{time.time_ns()}.sqlite'
    with contextlib.closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as src, contextlib.closing(sqlite3.connect(backup)) as dst:
        src.backup(dst)
    if os.name != 'nt': backup.chmod(0o600)
    records = read_records(backup)
    payload = encrypt(convert(records, owner), password)
    # Exclusive creation prevents overwriting a backup created concurrently.
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(payload, stream, ensure_ascii=False)
        stream.flush(); os.fsync(stream.fileno())
    return {'owner': owner, 'sessions': len(records['session']), 'answered': sum('first_correct' in s for s in records['state']),
            'notes': sum(bool(s['note']) for s in records['state']), 'preserved_database': backup.name, 'encrypted_export': target.name}

def main():
    parser = argparse.ArgumentParser(description='只读备份V1数据库，并为明确指定的新账号导出加密学习备份。')
    parser.add_argument('source')
    parser.add_argument('--inspect', action='store_true', help='仅显示数量，不显示学习内容')
    parser.add_argument('--user-id')
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.inspect:
        records = read_records(args.source)
        print(json.dumps({k: len(v) for k, v in records.items()})); return
    if not args.user_id or not args.output: parser.error('必须明确指定 --user-id 和 --output。')
    password = getpass.getpass('导出备份口令（至少12字符）：')
    if getpass.getpass('确认备份口令：') != password: raise SystemExit('口令不一致，未导出。')
    print(json.dumps(export_legacy(args.source, args.output, args.user_id, password), ensure_ascii=False))

if __name__ == '__main__': main()
