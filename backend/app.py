import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import random
import re
import secrets
import time
from collections import Counter
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field
from .storage import Store
from .backup import validate_records
from .bank import ROOT, BANK, QUESTIONS, THEME_ORDER, TITLES, DEFAULT_PREFS

load_dotenv(ROOT/'.env')

@dataclass
class Config:
    dev: bool = os.getenv('DEV_MODE','0')=='1'
    password_hash: str = os.getenv('ACCESS_PASSWORD_HASH','')
    secret: str = os.getenv('SESSION_SECRET','')
    ai_base: str = os.getenv('AI_BASE_URL','').rstrip('/')
    ai_key: str = os.getenv('AI_API_KEY','')
    ai_model: str = os.getenv('AI_MODEL','')
    ai_stream: bool = os.getenv('AI_STREAM','1')=='1'

class Login(BaseModel):
    password: str = Field(max_length=256)

class NewSession(BaseModel):
    mode: str
    feedback: str = 'immediate'
    theme: str | None = None
    type: str | None = None
    random_order: bool = False
    shuffle_options: bool = False
    reduce_repeats: bool = False
    review_filter: str = 'all'

class Progress(BaseModel):
    revision: int
    cursor: int | None = None
    question_id: str | None = None
    selected: list[str] | None = None

class Answer(BaseModel):
    revision: int
    question_id: str
    selected: list[str]

class Finish(BaseModel):
    revision: int

class StateChange(BaseModel):
    revision: int
    favorite: bool | None = None
    uncertain: bool | None = None
    mastered: bool | None = None
    disputed: bool | None = None
    note: str | None = Field(default=None,max_length=12000)

class Chat(BaseModel):
    question_id: str
    session_id: str
    action: str = 'explain'
    message: str = Field(default='',max_length=5000)

def empty_state(qid):
    return {'id':qid,'favorite':False,'uncertain':False,'wrong':False,'mastered':False,'disputed':False,'note':'','revision':0}

def session_or_404(c,sid):
    s=Store.get(c,'session',sid)
    if not s: raise HTTPException(404,'练习不存在。')
    return s

def check_revision(data,rev):
    if data['revision']!=rev:
        raise HTTPException(409,'这份记录已在另一处更新，请重新加载最新记录。')

def validate_selected(qid,selected):
    if qid not in QUESTIONS or len(set(selected))!=len(selected): raise HTTPException(400,'选项无效。')
    q=QUESTIONS[qid]
    if not set(selected)<=set(o['id'] for o in q['options']): raise HTTPException(400,'选项无效。')
    if q['type']!='multiple' and len(selected)>1: raise HTTPException(400,'此题只能选择一个选项。')

def grade(qid,selected):
    q=QUESTIONS[qid]
    return {'selected':selected,'correct_ids':q['answer_ids'],'correct':set(selected)==set(q['answer_ids']),'answered_at':time.time()}

def record_result(c,qid,result):
    state=Store.get(c,'state',qid) or empty_state(qid)
    if 'first_correct' not in state:
        state['first_correct']=result['correct']
    state['last_answered']=time.time()
    if not result['correct']:
        state['wrong']=True; state['mastered']=False
    Store.put(c,'state',qid,state)

def summary(s):
    done=len(s['results']) if s['feedback']=='immediate' or s['status']=='completed' else sum(bool(v) for v in s['drafts'].values())
    return {k:s[k] for k in ['id','mode','title','feedback','status','cursor','created_at','updated_at']} | {'total':len(s['question_ids']),'answered':done,'correct':sum(r['correct'] for r in s['results'].values()),'revision':s['revision']}

def public_session(s):
    questions=[]
    for qid in s['question_ids']:
        q=QUESTIONS[qid]
        options={o['id']:o for o in q['options']}
        questions.append({k:q[k] for k in ['id','type','stem','theme','shuffle_safe','source_number']} | {'options':[options[id] for id in s['option_orders'][qid]]})
    return s | {'questions':questions}

def ai_ready(cfg):
    return bool(cfg.ai_base and cfg.ai_key and cfg.ai_model)

def create_app(db_path=None,config=None):
    cfg=config or Config()
    db=Store(db_path or os.getenv('DATABASE_PATH',str(ROOT/'.runtime/history.sqlite')))
    login_attempts={}; ai_active=set()

    async def backup_loop():
        last=None
        while True:
            now=datetime.now(ZoneInfo('Asia/Shanghai'))
            if now.hour>=3 and last!=now.date():
                try:
                    await asyncio.to_thread(db.backup); last=now.date()
                except Exception:
                    logging.exception('Automatic database backup failed')
            await asyncio.sleep(60)

    @asynccontextmanager
    async def lifespan(app):
        task=asyncio.create_task(backup_loop())
        yield
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass

    app=FastAPI(title='史纲 Study',lifespan=lifespan)
    app.add_middleware(GZipMiddleware,minimum_size=1024,compresslevel=5)
    app.state.db=db; app.state.config=cfg

    def authorized(request):
        if cfg.dev:
            return request.client and request.client.host in {'127.0.0.1','::1','testclient'}
        token=request.cookies.get('history_session','')
        try:
            encoded,signature=token.split('.')
            expected=hmac.new(cfg.secret.encode(),encoded.encode(),hashlib.sha256).hexdigest()
            if not cfg.secret or not hmac.compare_digest(signature,expected): return False
            return time.time()<int(base64.urlsafe_b64decode(encoded+'='*((-len(encoded))%4)))
        except (ValueError,TypeError): return False

    @app.middleware('http')
    async def gate(request,call_next):
        public=request.url.path in {'/api/health','/api/auth/login','/api/auth/me'}
        if request.url.path.startswith('/api') and not public and not authorized(request):
            return JSONResponse({'detail':'请先输入访问密码。'},status_code=401)
        origin=request.headers.get('origin')
        if request.method not in {'GET','HEAD','OPTIONS'} and origin and urlparse(origin).netloc!=request.headers.get('host'):
            return JSONResponse({'detail':'请求来源不匹配。'},status_code=403)
        response=await call_next(request)
        response.headers['Cache-Control']='no-store'
        response.headers['X-Content-Type-Options']='nosniff'
        return response

    @app.get('/api/health')
    def health(): return {'ok':True,'bank_count':len(QUESTIONS),'version':BANK['version']}

    @app.get('/api/auth/me')
    def me(request:Request): return {'authenticated':bool(authorized(request)),'development':cfg.dev}

    @app.post('/api/auth/login')
    def login(body:Login,request:Request,response:Response):
        ip=request.client.host if request.client else 'unknown'
        attempts=[t for t in login_attempts.get(ip,[]) if t>time.time()-60]
        if len(attempts)>=5: raise HTTPException(429,'尝试次数过多，请一分钟后重试。')
        if len(cfg.secret)<32 or not cfg.password_hash: raise HTTPException(503,'请先在服务器配置访问密码和会话密钥。')
        try: valid=PasswordHasher().verify(cfg.password_hash,body.password)
        except (VerificationError,InvalidHashError): valid=False
        if not valid:
            login_attempts[ip]=attempts+[time.time()]
            raise HTTPException(401,'访问密码不正确。')
        encoded=base64.urlsafe_b64encode(str(int(time.time()+30*86400)).encode()).decode().rstrip('=')
        sig=hmac.new(cfg.secret.encode(),encoded.encode(),hashlib.sha256).hexdigest()
        response.set_cookie('history_session',f'{encoded}.{sig}',httponly=True,secure=not cfg.dev,samesite='strict',max_age=30*86400,path='/')
        return {'ok':True}

    @app.post('/api/auth/logout')
    def logout(response:Response):
        response.delete_cookie('history_session'); return {'ok':True}

    @app.get('/api/dashboard')
    def dashboard():
        with db.transaction() as c:
            states={s['id']:s for s in Store.all(c,'state')}
            sessions=Store.all(c,'session')
            prefs=Store.get(c,'prefs','main') or DEFAULT_PREFS
        answered=[s for s in states.values() if 'first_correct' in s]
        due=[s for s in states.values() if s['wrong'] or s['uncertain']]
        themes=[]
        for t in BANK['themes']:
            ids=[q['id'] for q in QUESTIONS.values() if q['theme']==t['id']]
            themes.append(t|{'total':len(ids),'done':sum('first_correct' in states.get(id,{}) for id in ids),'due':sum(states.get(id,{}).get('wrong',False) or states.get(id,{}).get('uncertain',False) for id in ids)})
        return {'title':BANK['title'],'version':BANK['version'],'total':len(QUESTIONS),'counts':dict(Counter(q['type'] for q in QUESTIONS.values())),
                'stats':{'answered':len(answered),'first_correct':sum(s['first_correct'] for s in answered),'due':len(due),'wrong':sum(s['wrong'] for s in states.values()),'uncertain':sum(s['uncertain'] for s in states.values()),'favorites':sum(s['favorite'] for s in states.values()),'mastered':sum(s['mastered'] for s in states.values())},
                'themes':themes,'states':states,'sessions':[summary(s) for s in sessions[:30]],'prefs':prefs,
                'ai':{'configured':ai_ready(cfg),'model':cfg.ai_model if ai_ready(cfg) else ''}}

    @app.put('/api/preferences')
    def preferences(body:dict):
        with db.transaction() as c:
            prefs=(Store.get(c,'prefs','main') or DEFAULT_PREFS.copy()).copy()
            for key in DEFAULT_PREFS:
                if key in body:
                    if not isinstance(body[key],bool): raise HTTPException(400,'设置必须为开关。')
                    prefs[key]=body[key]
            return Store.put(c,'prefs','main',prefs)

    @app.post('/api/sessions')
    def new_session(body:NewSession):
        if body.mode not in TITLES or body.feedback not in {'immediate','test'}: raise HTTPException(400,'练习模式无效。')
        if body.feedback=='test' and body.mode not in {'paper80','paper20'}: raise HTTPException(400,'此模式不支持整卷自测。')
        with db.transaction() as c:
            states={s['id']:s for s in Store.all(c,'state')}
            pool=list(QUESTIONS.values())
            if body.mode=='category':
                if body.theme: pool=[q for q in pool if q['theme']==body.theme]
                if body.type: pool=[q for q in pool if q['type']==body.type]
            if body.mode=='review':
                if body.review_filter not in {'all','wrong','uncertain'}: raise HTTPException(400,'复习筛选无效。')
                pool=[q for q in pool if (states.get(q['id'],{}).get('wrong',False) if body.review_filter=='wrong' else states.get(q['id'],{}).get('uncertain',False) if body.review_filter=='uncertain' else states.get(q['id'],{}).get('wrong',False) or states.get(q['id'],{}).get('uncertain',False))]
            if body.mode=='favorites': pool=[q for q in pool if states.get(q['id'],{}).get('favorite',False)]
            if not pool: raise HTTPException(400,'这里暂时没有题目，先去练习或收藏几道题。')
            if body.mode in {'paper80','paper20'}:
                quota={'single':35,'multiple':35,'judge':10} if body.mode=='paper80' else {'single':9,'multiple':9,'judge':2}
                selected=[]
                for kind,n in quota.items():
                    group=[q for q in pool if q['type']==kind]
                    random.shuffle(group)
                    if body.reduce_repeats:
                        group.sort(key=lambda q:int((states.get(q['id'],{}).get('last_answered',0)+8*3600)//86400))
                    selected.extend(group[:n])
                pool=selected; random.shuffle(pool)
            elif body.random_order: random.shuffle(pool)
            else: pool.sort(key=lambda q:(THEME_ORDER[q['theme']],q['order'],q['type']))
            orders={}
            for q in pool:
                ids=[o['id'] for o in q['options']]
                if body.shuffle_options and q['shuffle_safe'] and q['type']!='judge': random.shuffle(ids)
                orders[q['id']]=ids
            title=TITLES[body.mode]
            if body.mode=='category' and body.theme:
                title=next((t['name'] for t in BANK['themes'] if t['id']==body.theme),title)
            sid=secrets.token_hex(12)
            s={'id':sid,'mode':body.mode,'title':title,'feedback':body.feedback,'status':'active','question_ids':[q['id'] for q in pool],
               'option_orders':orders,'cursor':0,'drafts':{},'results':{},'created_at':time.time(),'bank_version':BANK['version']}
            Store.put(c,'session',sid,s)
        return public_session(s)

    @app.get('/api/sessions/{sid}')
    def get_session(sid:str):
        with db.transaction() as c: return public_session(session_or_404(c,sid))

    @app.patch('/api/sessions/{sid}/progress')
    def progress(sid:str,body:Progress):
        with db.transaction() as c:
            s=session_or_404(c,sid); check_revision(s,body.revision)
            if body.cursor is not None:
                if not 0<=body.cursor<len(s['question_ids']): raise HTTPException(400,'题号超出范围。')
                s['cursor']=body.cursor
            if body.question_id is not None:
                if body.question_id not in s['question_ids']: raise HTTPException(400,'题目不在当前练习中。')
                validate_selected(body.question_id,body.selected or [])
                if body.question_id not in s['results'] and s['status']=='active': s['drafts'][body.question_id]=body.selected or []
            Store.put(c,'session',sid,s)
            return public_session(s)

    @app.post('/api/sessions/{sid}/answers')
    def answer(sid:str,body:Answer):
        with db.transaction() as c:
            s=session_or_404(c,sid)
            if body.question_id not in s['question_ids']: raise HTTPException(400,'题目不在当前练习中。')
            if body.question_id in s['results']: return public_session(s)
            if s['status']!='active': raise HTTPException(400,'练习已经结束。')
            check_revision(s,body.revision); validate_selected(body.question_id,body.selected)
            if not body.selected: raise HTTPException(400,'请先选择答案。')
            s['drafts'][body.question_id]=body.selected
            if s['feedback']=='immediate':
                result=grade(body.question_id,body.selected)
                s['results'][body.question_id]=result
                record_result(c,body.question_id,result)
                if len(s['results'])==len(s['question_ids']): s['status']='completed'
            Store.put(c,'session',sid,s)
            return public_session(s)

    @app.post('/api/sessions/{sid}/finish')
    def finish(sid:str,body:Finish):
        with db.transaction() as c:
            s=session_or_404(c,sid)
            if s['status']=='completed': return public_session(s)
            check_revision(s,body.revision)
            if s['feedback']=='test':
                for qid,selected in s['drafts'].items():
                    if selected:
                        result=grade(qid,selected); s['results'][qid]=result; record_result(c,qid,result)
                s['status']='completed'
            elif len(s['results'])!=len(s['question_ids']):
                raise HTTPException(400,'请先完成剩余题目；你可以直接退出，下次继续。')
            Store.put(c,'session',sid,s)
            return public_session(s)

    @app.patch('/api/questions/{qid}/state')
    def change_state(qid:str,body:StateChange):
        if qid not in QUESTIONS: raise HTTPException(404,'题目不存在。')
        with db.transaction() as c:
            state=Store.get(c,'state',qid) or empty_state(qid)
            check_revision(state,body.revision)
            for k,v in body.model_dump(exclude={'revision'},exclude_none=True).items(): state[k]=v
            if body.mastered is True: state['wrong']=False; state['uncertain']=False
            if body.uncertain is True: state['mastered']=False
            return Store.put(c,'state',qid,state)

    @app.get('/api/export')
    def export():
        with db.transaction() as c:
            payload={'format':'history-study-v1','bank_version':BANK['version'],'exported_at':time.time(),
                     'records':{k:Store.all(c,k) for k in ['session','state','chat','cache','prefs']}}
        return Response(json.dumps(payload,ensure_ascii=False),media_type='application/json',headers={'Content-Disposition':'attachment; filename="history-study-backup.json"'})

    @app.post('/api/restore')
    async def restore(request:Request):
        raw=await request.body()
        if len(raw)>20*1024*1024: raise HTTPException(413,'备份文件不能超过20MB。')
        try: payload=json.loads(raw)
        except (ValueError,UnicodeDecodeError): raise HTTPException(400,'备份不是有效JSON。')
        if not isinstance(payload,dict) or payload.get('format')!='history-study-v1' or payload.get('bank_version')!=BANK['version']:
            raise HTTPException(400,'备份格式或题库版本不匹配。')
        records=payload.get('records',{})
        try:
            validate_records(records,QUESTIONS,BANK['version'],TITLES,DEFAULT_PREFS)
        except (ValueError,KeyError,TypeError): raise HTTPException(400,'备份记录校验失败，原数据未修改。')
        await asyncio.to_thread(db.backup)
        with db.transaction() as c:
            for kind,items in records.items():
                c.execute('DELETE FROM records WHERE kind=?',(kind,))
                for item in items: Store.put(c,kind,item['id'],item)
        return {'ok':True}

    # AI routes are registered separately so their error/cancellation paths can be tested.
    from .ai import register_ai
    register_ai(app,db,cfg,QUESTIONS,Chat,session_or_404,ai_active)
    return app

app=create_app()
