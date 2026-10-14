import copy
import json
from collections import Counter

import httpx
import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient

from backend.legacy_app import BANK, QUESTIONS, Config, create_app
from backend.storage import Store

@pytest.fixture
def client(tmp_path):
    app=create_app(tmp_path/'history.sqlite',Config(dev=True))
    with TestClient(app) as c: yield c

def new(client,mode='paper20',**options):
    r=client.post('/api/sessions',json={'mode':mode,**options})
    assert r.status_code==200,r.text
    return r.json()

def answer(client,s,qid,selected):
    r=client.post('/api/sessions/'+s['id']+'/answers',json={'revision':s['revision'],'question_id':qid,'selected':selected})
    assert r.status_code==200,r.text
    return r.json()

def test_source_bank_preserves_counts_and_stable_ids():
    assert len(QUESTIONS)==700
    assert Counter(q['type'] for q in QUESTIONS.values())=={'single':300,'multiple':300,'judge':100}
    assert len(BANK['themes'])==9
    for q in QUESTIONS.values():
        assert q['theme'] in {t['id'] for t in BANK['themes']}
        assert set(q['answer_ids'])<=set(o['id'] for o in q['options'])
        assert 'answer_ids' not in q['stem']
        assert len(q['options'])==(2 if q['type']=='judge' else 4)
    assert QUESTIONS['single-254']['source_number']==154

@pytest.mark.parametrize(('mode','counts'),[
    ('paper80',{'single':35,'multiple':35,'judge':10}),
    ('paper20',{'single':9,'multiple':9,'judge':2}),
])
def test_frozen_quota_and_resume(client,mode,counts):
    s=new(client,mode,shuffle_options=True,reduce_repeats=True)
    assert Counter(q['type'] for q in s['questions'])==counts
    assert len(set(s['question_ids']))==sum(counts.values())
    assert client.get('/api/sessions/'+s['id'],headers={'Accept-Encoding':'gzip'}).headers.get('content-encoding')=='gzip'
    assert all('answer_ids' not in q and 'source_stem' not in q for q in s['questions'])
    r=client.patch('/api/sessions/'+s['id']+'/progress',json={'revision':s['revision'],'cursor':12}).json()
    reopened=client.get('/api/sessions/'+s['id']).json()
    assert reopened['question_ids']==s['question_ids']
    assert reopened['option_orders']==s['option_orders']
    assert reopened['cursor']==12 and reopened['revision']==r['revision']

def test_full_round_is_independent_and_skips_stay_unanswered(client):
    s=new(client,'full')
    assert len(s['question_ids'])==700
    qid=s['question_ids'][0]
    s=answer(client,s,qid,QUESTIONS[qid]['answer_ids'])
    r=client.patch('/api/sessions/'+s['id']+'/progress',json={'revision':s['revision'],'cursor':50}).json()
    assert len(r['results'])==1 and r['status']=='active'
    assert client.post('/api/sessions/'+s['id']+'/finish',json={'revision':r['revision']}).status_code==400
    other=new(client,'full')
    assert other['id']!=s['id'] and not other['results']
    assert len(client.get('/api/sessions/'+s['id']).json()['results'])==1

def test_multiple_partial_wrong_duplicate_is_idempotent_and_first_stat_immutable(client):
    s=new(client,'category',type='multiple')
    qid=next(q for q in s['question_ids'] if len(QUESTIONS[q]['answer_ids'])>1)
    correct=QUESTIONS[qid]['answer_ids']
    first=answer(client,s,qid,correct[:1])
    assert not first['results'][qid]['correct']
    duplicate=answer(client,s,qid,correct)
    assert duplicate['revision']==first['revision']
    assert duplicate['results'][qid]==first['results'][qid]
    s2=new(client,'category',type='multiple',shuffle_options=True)
    s2=answer(client,s2,qid,correct)
    assert s2['results'][qid]['correct']
    d=client.get('/api/dashboard').json()
    assert d['stats']['first_correct']==0 and d['stats']['wrong']==1
    st=d['states'][qid]
    mastered=client.patch('/api/questions/'+qid+'/state',json={'revision':st['revision'],'mastered':True}).json()
    assert mastered['mastered'] and not mastered['wrong']
    s3=new(client,'category',type='multiple')
    answer(client,s3,qid,correct[:1])
    st=client.get('/api/dashboard').json()['states'][qid]
    assert st['wrong'] and not st['mastered'] and not st['first_correct']

def test_selftest_hides_feedback_and_tracks_unanswered_separately(client):
    s=new(client,feedback='test',shuffle_options=True)
    qid=s['question_ids'][0]
    s=answer(client,s,qid,QUESTIONS[qid]['answer_ids'])
    assert not s['results'] and 'correct_ids' not in json.dumps(s)
    assert client.get('/api/dashboard').json()['stats']['answered']==0
    assert client.get('/api/ai/history/'+qid,params={'session_id':s['id'],'channel':'solution'}).status_code==403
    finished=client.post('/api/sessions/'+s['id']+'/finish',json={'revision':s['revision']}).json()
    assert finished['status']=='completed' and len(finished['results'])==1
    assert finished['results'][qid]['correct']
    assert client.get('/api/dashboard').json()['stats']['wrong']==0
    assert client.get('/api/ai/history/'+qid,params={'session_id':s['id']}).status_code==200
    again=client.post('/api/sessions/'+s['id']+'/finish',json={'revision':1}).json()
    assert again['revision']==finished['revision']

def test_conflicts_and_disk_restart(client):
    s=new(client)
    r=client.patch('/api/sessions/'+s['id']+'/progress',json={'revision':s['revision'],'cursor':2})
    assert r.status_code==200
    assert client.patch('/api/sessions/'+s['id']+'/progress',json={'revision':s['revision'],'cursor':3}).status_code==409
    another=create_app(client.app.state.db.path,Config(dev=True))
    with TestClient(another) as fresh:
        resumed=fresh.get('/api/sessions/'+s['id']).json()
        assert resumed['cursor']==2 and resumed['question_ids']==s['question_ids']

def test_export_restore_includes_preferences_notes_and_backups(client):
    s=new(client)
    qid=s['question_ids'][0]
    answer(client,s,qid,QUESTIONS[qid]['answer_ids'])
    st=client.get('/api/dashboard').json()['states'][qid]
    client.patch('/api/questions/'+qid+'/state',json={'revision':st['revision'],'favorite':True,'uncertain':True,'note':'我自己的复习笔记'})
    client.put('/api/preferences',json={'auto_next':True})
    snapshot=client.get('/api/export').json()
    assert 'ai_key' not in json.dumps(snapshot) and snapshot['records']['prefs'][0]['id']=='main'
    client.put('/api/preferences',json={'auto_next':False})
    r=client.post('/api/restore',json=snapshot)
    assert r.status_code==200,r.text
    d=client.get('/api/dashboard').json()
    assert d['prefs']['auto_next'] and d['states'][qid]['note']=='我自己的复习笔记'
    assert d['stats']['favorites']==1 and d['stats']['uncertain']==1
    assert list((client.app.state.db.path.parent/'backups').glob('*.sqlite'))
    invalid=copy.deepcopy(snapshot); del invalid['records']['state'][0]['favorite']
    assert client.post('/api/restore',json=invalid).status_code==400
    assert client.get('/api/dashboard').json()['stats']==d['stats']
    for _ in range(9): client.app.state.db.backup()
    assert len(list((client.app.state.db.path.parent/'backups').glob('*.sqlite')))==7

def test_password_cookie_csrf_and_rate_limit(tmp_path):
    cfg=Config(dev=False,password_hash=PasswordHasher().hash('example-password'),secret='test-secret-'*5)
    with TestClient(create_app(tmp_path/'auth.sqlite',cfg),base_url='https://testserver') as c:
        assert c.get('/api/dashboard').status_code==401
        assert c.post('/api/auth/login',json={'password':'wrong'}).status_code==401
        login=c.post('/api/auth/login',json={'password':'example-password'})
        cookie=login.headers['set-cookie']
        assert 'HttpOnly' in cookie and 'Secure' in cookie and 'SameSite=strict' in cookie
        assert c.get('/api/dashboard').status_code==200
        assert c.post('/api/sessions',headers={'origin':'https://evil.example'},json={'mode':'paper20'}).status_code==403
        assert c.post('/api/auth/logout').status_code==200
        assert c.get('/api/dashboard').status_code==401
        for _ in range(4): c.post('/api/auth/login',json={'password':'wrong'})
        assert c.post('/api/auth/login',json={'password':'wrong'}).status_code==429

def ai_app(tmp_path,handler):
    app=create_app(tmp_path/'ai.sqlite',Config(dev=True,ai_base='https://mock.invalid/v1',ai_key='fake-test-key',ai_model='test-model'))
    app.state.ai_transport=httpx.MockTransport(handler)
    return app

def test_ai_stream_context_shuffled_labels_cache_and_hint_isolation(tmp_path):
    calls=[]
    def handler(request):
        assert request.headers['authorization']=='Bearer fake-test-key'
        calls.append(json.loads(request.content))
        chunk={'choices':[{'delta':{'content':'这是测试解析。'},'finish_reason':None}]}
        return httpx.Response(200,headers={'content-type':'text/event-stream'},text='data: '+json.dumps(chunk)+'\n\ndata: [DONE]\n\n')
    with TestClient(ai_app(tmp_path,handler)) as c:
        test=new(c,feedback='test')
        qid=next(q for q in test['question_ids'] if QUESTIONS[q]['type']=='single')
        s=new(c,'full',shuffle_options=True)
        s=answer(c,s,qid,QUESTIONS[qid]['answer_ids'])
        body={'question_id':qid,'session_id':s['id'],'action':'explain'}
        r=c.post('/api/ai/chat',json=body)
        assert r.status_code==200 and '"type": "delta"' in r.text and '"type": "done"' in r.text
        assert 'content-encoding' not in r.headers
        context=json.loads(calls[0]['messages'][0]['content'].split('本题上下文：')[1])
        order=s['option_orders'][qid]
        assert context['题库参考答案']==[chr(65+order.index(i)) for i in QUESTIONS[qid]['answer_ids']]
        assert context['当前选择']==context['题库参考答案']
        assert c.post('/api/ai/chat',json=body).status_code==200 and len(calls)==1
        assert len(c.get('/api/ai/history/'+qid,params={'session_id':s['id']}).json()['messages'])==4
        testqid=qid
        assert c.post('/api/ai/chat',json={'question_id':testqid,'session_id':test['id'],'action':'explain'}).status_code==403
        assert c.post('/api/ai/chat',json={'question_id':testqid,'session_id':test['id'],'action':'hint'}).status_code==200
        hint_context=json.loads(calls[-1]['messages'][0]['content'].split('本题上下文：')[1])
        assert '题库参考答案' not in hint_context
        assert not any('这是测试解析' in m['content'] for m in calls[-1]['messages'])
        snapshot=c.get('/api/export').json()
        assert c.post('/api/restore',json=snapshot).status_code==200

def test_ai_failure_does_not_save_partial_answer_or_block_quiz(tmp_path):
    with TestClient(ai_app(tmp_path,lambda r:httpx.Response(429,text='secret upstream details'))) as c:
        s=new(c); qid=s['question_ids'][0]
        r=c.post('/api/ai/chat',json={'question_id':qid,'session_id':s['id'],'action':'explain'})
        assert '"type": "error"' in r.text and 'secret upstream details' not in r.text
        assert not c.get('/api/ai/history/'+qid,params={'session_id':s['id']}).json()['messages']
        assert answer(c,s,qid,QUESTIONS[qid]['answer_ids'])['results'][qid]['correct']

def test_unconfigured_ai_is_explicit_and_quiz_still_works(client):
    s=new(client); qid=s['question_ids'][0]
    assert not client.get('/api/dashboard').json()['ai']['configured']
    assert client.post('/api/ai/chat',json={'question_id':qid,'session_id':s['id'],'action':'explain'}).status_code==503
    assert answer(client,s,qid,QUESTIONS[qid]['answer_ids'])['results'][qid]['correct']

def test_offline_sqlite_recovery_from_a_corrupt_current_database(tmp_path):
    from backend.restore_sqlite import recover
    path=tmp_path/'history.sqlite'
    with TestClient(create_app(path,Config(dev=True))) as c:
        s=new(c)
        qid=s['question_ids'][0]
        answer(c,s,qid,QUESTIONS[qid]['answer_ids'])
        backup=c.app.state.db.backup()
    path.write_bytes(b'damaged database for recovery test')
    offline=Store.__new__(Store); offline.path=path
    preserved=recover(offline,backup.name)
    assert (preserved/'history.sqlite').read_bytes()==b'damaged database for recovery test'
    with TestClient(create_app(path,Config(dev=True))) as c:
        assert c.get('/api/sessions/'+s['id']).json()['results'][qid]['correct']
    with pytest.raises(ValueError): recover(offline,'../history.sqlite')

def test_incomplete_ai_stream_is_not_saved_and_can_retry(tmp_path):
    chunk={'choices':[{'delta':{'content':'只有半句话'},'finish_reason':None}]}
    app=ai_app(tmp_path,lambda r:httpx.Response(200,text='data: '+json.dumps(chunk)+'\n\n'))
    with TestClient(app) as c:
        s=new(c); qid=s['question_ids'][0]
        body={'question_id':qid,'session_id':s['id'],'action':'explain'}
        for _ in range(2):
            r=c.post('/api/ai/chat',json=body)
            assert r.status_code==200 and '"type": "error"' in r.text and '"type": "done"' not in r.text
        assert not c.get('/api/ai/history/'+qid,params={'session_id':s['id']}).json()['messages']

@pytest.mark.parametrize('finish_reason',['stop','length'])
def test_nonstream_ai_compatibility_and_partial_response_handling(tmp_path,finish_reason):
    def handler(request):
        assert json.loads(request.content)['stream'] is False
        return httpx.Response(200,json={'choices':[{'message':{'content':'完整响应测试'},'finish_reason':finish_reason}]})
    app=ai_app(tmp_path,handler); app.state.config.ai_stream=False
    with TestClient(app) as c:
        s=new(c); qid=s['question_ids'][0]
        r=c.post('/api/ai/chat',json={'question_id':qid,'session_id':s['id'],'action':'explain'})
        assert ('"type": "done"' in r.text)==(finish_reason=='stop')
        history=c.get('/api/ai/history/'+qid,params={'session_id':s['id']}).json()['messages']
        assert bool(history)==(finish_reason=='stop')
