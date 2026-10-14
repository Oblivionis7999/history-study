"""Isolated test server; never used by the production Docker entrypoint."""
import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app import Config, create_app
import httpx
import uvicorn

path = os.environ['AUTH_DATABASE_PATH']
config = Config(dev=True, ai_base='https://mock-provider.test/v1', ai_key='isolated-mock', ai_model='mock-history', ai_daily=10000, ai_global_daily=100000)
app = create_app(path, config)
with app.state.db.connect() as c:
    exists = c.execute("SELECT 1 FROM users WHERE username='e2e_admin'").fetchone()
if not exists: app.state.db.create_user('e2e_admin', '隔离测试管理员', 'e2e-only-test-password', role='admin', admin=True)

def handler(request):
    import json
    payload = json.loads(request.content)
    hint = '禁止揭示' in payload['messages'][0]['content']
    content = '请先回忆历史背景。' if hint else '## 模拟学习讲解\n\n这是隔离测试响应。\n\n- 区分题库答案与分析\n- 注意选项中的时代背景\n\n```text\n复习记录只保存在本机\n```'
    return httpx.Response(200, text='data: ' + json.dumps({'choices': [{'delta': {'content': content}, 'finish_reason': 'stop'}]}) + '\n\ndata: [DONE]\n\n')

app.state.ai_transport = httpx.MockTransport(handler)
if __name__ == '__main__': uvicorn.run(app, host='127.0.0.1', port=8766, proxy_headers=False)
