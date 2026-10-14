import base64
import hashlib
import json
import sqlite3
import uuid
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from backend.migrate_legacy import export_legacy, read_records
from backend.legacy_app import create_app, Config
from backend.bank import QUESTIONS
from fastapi.testclient import TestClient

def test_export_preserves_source_backup_and_all_records(tmp_path):
    source=tmp_path/'legacy.sqlite'; owner=str(uuid.uuid4()); password='test-migration-passphrase'
    with TestClient(create_app(source,Config(dev=True))) as c:
        s=c.post('/api/sessions',json={'mode':'paper20'}).json(); qid=s['question_ids'][0]
        c.post('/api/sessions/'+s['id']+'/answers',json={'revision':s['revision'],'question_id':qid,'selected':QUESTIONS[qid]['answer_ids']})
        state=c.get('/api/dashboard').json()['states'][qid]
        c.patch('/api/questions/'+qid+'/state',json={'revision':state['revision'],'note':'legacy migration sentinel','favorite':True})
    original=source.read_bytes()
    output=tmp_path/'export.json'; result=export_legacy(source,output,owner,password)
    assert source.read_bytes()==original
    assert result['answered']==1 and result['notes']==1
    preserved=tmp_path/result['preserved_database']
    assert read_records(preserved)==read_records(source)
    encrypted=json.loads(output.read_text()); payload=encrypted.pop('payload')
    key=hashlib.pbkdf2_hmac('sha256',password.encode(),base64.b64decode(encrypted['salt']),600000,32)
    plain=AESGCM(key).decrypt(base64.b64decode(payload['iv']),base64.b64decode(payload['data']),json.dumps(encrypted,ensure_ascii=False,separators=(',',':')).encode())
    data=json.loads(plain)
    assert data['owner']==owner and data['states'][qid]['note']=='legacy migration sentinel'
    assert data['sessions'][s['id']]['results'][qid]['correct']
    assert b'legacy migration sentinel' not in output.read_bytes()
    with pytest.raises(ValueError): export_legacy(source,output,owner,password)
    with TestClient(create_app(preserved,Config(dev=True))) as c:
        assert c.get('/api/dashboard').json()['states'][qid]['favorite']
    # Wrong SQLite structure is rejected instead of silently exporting an empty bank.
    wrong=tmp_path/'wrong.sqlite'; sqlite3.connect(wrong).close()
    with pytest.raises(ValueError): read_records(wrong)
