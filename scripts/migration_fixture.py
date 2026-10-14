"""Generate a synthetic V1 database and export it for end-to-end migration tests."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from backend.legacy_app import create_app, Config
from backend.bank import QUESTIONS
from backend.migrate_legacy import export_legacy

def make(folder, owner):
    folder = Path(folder); folder.mkdir(parents=True, exist_ok=True)
    source = folder/'legacy.sqlite'
    with TestClient(create_app(source, Config(dev=True))) as client:
        s = client.post('/api/sessions', json={'mode':'category','type':'single'}).json()
        qid = s['question_ids'][0]
        client.post('/api/sessions/'+s['id']+'/answers', json={'revision':s['revision'],'question_id':qid,'selected':QUESTIONS[qid]['answer_ids']})
        state = client.get('/api/dashboard').json()['states'][qid]
        client.patch('/api/questions/'+qid+'/state', json={'revision':state['revision'],'note':'V1 synthetic migration note','favorite':True})
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    target = folder/'history-study-backup-migration.json'
    result = export_legacy(source, target, owner, 'isolated-migration-password')
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before
    with TestClient(create_app(source, Config(dev=True))) as client:
        assert client.get('/api/dashboard').json()['states'][qid]['note'] == 'V1 synthetic migration note'
    print(json.dumps({'qid':qid,'session':s['id'],'path':str(target),'source_unchanged':True,'counts':result}))

if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('folder'); parser.add_argument('owner'); args=parser.parse_args()
    make(args.folder,args.owner)
