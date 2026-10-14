import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
const bank=JSON.parse(readFileSync('data/questions.json','utf8'));
const questions=Object.fromEntries(bank.questions.map((q: any)=>[q.id,q]));
mkdirSync('artifacts/screenshots',{recursive:true});

let errors:string[]=[];
test.beforeEach(async ({page,request})=>{
  errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await request.put('/api/preferences',{data:{auto_next:false}});
});
test.afterEach(()=>expect(errors).toEqual([]));

async function create(request:any,mode:string,extra:Record<string,unknown>={}){
  const response=await request.post('/api/sessions',{data:{mode,...extra}});
  expect(response.ok()).toBeTruthy(); return response.json();
}

test('Apple overview has all entry cards and theme totals',async({page})=>{
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'温故，知新。'})).toBeVisible();
  await expect(page.locator('.theme-card')).toHaveCount(9);
  await expect(page.locator('.mode-card').filter({hasText:'35 单选 · 35 多选 · 10 判断'})).toBeVisible();
  await expect(page.locator('.mode-card').filter({hasText:'9 单选 · 9 多选 · 2 判断'})).toBeVisible();
  await page.screenshot({path:'artifacts/screenshots/desktop-home.png',fullPage:true});
});

test('single answer colors, navigation and refresh persist',async({page,request})=>{
  const s=await create(request,'category',{type:'single',shuffle_options:true});
  const q=s.questions[0]; const wrong=q.options.findIndex((o:any)=>!questions[q.id].answer_ids.includes(o.id));
  await page.goto('/?session='+s.id);
  await page.locator('.option').nth(wrong).click();
  await expect(page.locator('.option.incorrect')).toHaveCount(1);
  await expect(page.locator('.option.correct')).toHaveCount(1);
  await page.getByRole('button',{name:'下一题',exact:true}).click();
  await expect(page.locator('.practice-position strong')).toHaveText('2');
  await page.getByRole('button',{name:'上一题',exact:true}).click();
  await expect(page.locator('.practice-position strong')).toHaveText('1');
  await page.reload();
  await expect(page.locator('.option.incorrect')).toHaveCount(1);
  await page.getByRole('button',{name:'问 AI',exact:true}).click();
  await expect(page.locator('.ai-context')).toContainText(q.stem);
  await expect(page.locator('.ai-empty')).toContainText('连接 AI 接口后');
  await expect(page.getByRole('button',{name:'讲解本题',exact:true})).toBeDisabled();
  await expect.poll(async()=>page.locator('.question-card').evaluate(e=>e.getBoundingClientRect().right)).toBeLessThanOrEqual(1082);
  await page.screenshot({path:'artifacts/screenshots/desktop-question-ai.png',fullPage:true});
});

test('multiple selection waits for submit and marks missed options',async({page,request})=>{
  let s=await create(request,'category',{type:'multiple'});
  const cursor=s.questions.findIndex((q:any)=>questions[q.id].answer_ids.length>1);
  s=await (await request.patch('/api/sessions/'+s.id+'/progress',{data:{revision:s.revision,cursor}})).json();
  const q=s.questions[cursor], correct=questions[q.id].answer_ids;
  await page.goto('/?session='+s.id);
  await page.locator('.option').nth(q.options.findIndex((o:any)=>o.id===correct[0])).click();
  await expect(page.locator('.option.chosen')).toHaveCount(1);
  await expect(page.locator('.answer-result')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'提交答案',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'提交答案',exact:true}).click();
  await expect(page.locator('.answer-result.incorrect')).toBeVisible();
  await expect(page.locator('.option.correct')).toHaveCount(correct.length);
  await expect(page.getByText('漏选',{exact:true})).toHaveCount(correct.length-1);
});

test('20 question selftest withholds solutions and separates 19 unanswered',async({page,request})=>{
  await page.goto('/');
  await page.locator('.mode-card').filter({hasText:'20 题小卷'}).click();
  await page.getByRole('button',{name:'整卷自测',exact:true}).click();
  await page.getByRole('button',{name:'开始练习',exact:true}).click();
  await expect(page.getByRole('heading',{name:'专注这一题。'})).toBeVisible();
  const id=new URL(page.url()).searchParams.get('session');
  const s=await (await request.get('/api/sessions/'+id)).json();
  const q=s.questions[0]; const index=q.options.findIndex((o:any)=>questions[q.id].answer_ids.includes(o.id));
  await page.locator('.option').nth(index).click();
  await expect(page.locator('.option.chosen')).toHaveCount(1);
  await expect(page.locator('.answer-result')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'写笔记',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'问 AI',exact:true}).click();
  await expect(page.getByRole('button',{name:'讲解本题',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'给我提示',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'收起AI侧栏',exact:true}).click();
  await page.getByRole('button',{name:'提前交卷',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('已选择 1 / 20 题');
  await page.getByRole('button',{name:'确认交卷',exact:true}).click();
  await expect(page.getByRole('heading',{name:'完成一次，理解多一点。'})).toBeVisible();
  await expect(page.locator('.result-stats .stat').nth(2).locator('strong')).toHaveText('19');
  await page.screenshot({path:'artifacts/screenshots/desktop-results.png',fullPage:true});
});

test('auto-next moves fresh correct answers and stops during review',async({page,request})=>{
  await request.put('/api/preferences',{data:{auto_next:true}});
  const s=await create(request,'category',{type:'single'});
  const q=s.questions[0]; const index=q.options.findIndex((o:any)=>questions[q.id].answer_ids.includes(o.id));
  await page.goto('/?session='+s.id);
  await page.locator('.option').nth(index).click();
  await expect(page.locator('.practice-position strong')).toHaveText('2',{timeout:6000});
  await page.getByRole('button',{name:'上一题',exact:true}).click();
  await expect(page.locator('.practice-position strong')).toHaveText('1');
  await page.waitForTimeout(1800);
  await expect(page.locator('.practice-position strong')).toHaveText('1');
  await page.getByRole('button',{name:'下一题',exact:true}).click();
  const q2=s.questions[1]; const index2=q2.options.findIndex((o:any)=>questions[q2.id].answer_ids.includes(o.id));
  await page.getByRole('button',{name:'问 AI',exact:true}).click();
  await page.locator('.option').nth(index2).click();
  await expect(page.locator('.answer-result.correct')).toBeVisible();
  await page.waitForTimeout(1800);
  await expect(page.locator('.practice-position strong')).toHaveText('2');
});

test('offline submission keeps draft through reload, and notes sync',async({page,request})=>{
  const s=await create(request,'category',{type:'single'});
  const q=s.questions[0], index=q.options.findIndex((o:any)=>!questions[q.id].answer_ids.includes(o.id));
  await page.route('**/api/sessions/*/answers',route=>route.abort('failed'));
  await page.goto('/?session='+s.id);
  await page.locator('.option').nth(index).click();
  await expect(page.locator('.notice')).toBeVisible();
  await page.unroute('**/api/sessions/*/answers');
  await page.reload();
  await expect(page.locator('.option.chosen')).toHaveCount(1);
  await page.locator('.option').nth(index).click();
  await expect(page.locator('.answer-result.incorrect')).toBeVisible();
  await page.getByRole('button',{name:'收藏本题',exact:true}).click();
  await expect(page.getByRole('button',{name:'取消收藏',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'写笔记',exact:true}).click();
  await page.getByLabel('自己的记忆笔记').fill('复习测试笔记：记住历史背景。');
  await page.getByRole('button',{name:'保存笔记',exact:true}).click();
  await expect(page.locator('.note-panel small')).toHaveText('已保存');
  await page.reload();
  await expect(page.getByRole('button',{name:'取消收藏',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'查看笔记',exact:true}).click();
  await expect(page.getByLabel('自己的记忆笔记')).toHaveValue('复习测试笔记：记住历史背景。');
});

test('phone drawers and question controls fit the viewport',async({page,request})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'温故，知新。'})).toBeVisible();
  await expect(page.locator('.left-sidebar')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.screenshot({path:'artifacts/screenshots/phone-home.png',fullPage:true});
  await page.getByRole('button',{name:'展开导航',exact:true}).click();
  await expect(page.locator('.left-sidebar')).toBeVisible();
  await page.getByRole('button',{name:'收起导航',exact:true}).click();
  const s=await create(request,'paper20');
  await page.goto('/?session='+s.id);
  await page.getByRole('button',{name:'问 AI',exact:true}).click();
  await expect(page.locator('.ai-sidebar')).toBeVisible();
  expect(await page.locator('.ai-sidebar').evaluate(e=>e.getBoundingClientRect().right<=window.innerWidth)).toBeTruthy();
  await page.screenshot({path:'artifacts/screenshots/phone-ai.png'});
  await page.getByRole('button',{name:'收起AI侧栏',exact:true}).click();
  await expect(page.getByRole('button',{name:'下一题',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await page.screenshot({path:'artifacts/screenshots/phone-question.png',fullPage:true});
});

test('AI streams in the current question and clears when switching',async({page,request})=>{
  await page.route('**/api/dashboard',async route=>{
    const response=await route.fetch(); const d=await response.json();
    await route.fulfill({json:{...d,ai:{configured:true,model:'ui-test'}}});
  });
  await page.route('**/api/ai/history/**',route=>route.fulfill({json:{messages:[],channel:'solution'}}));
  const sent:string[]=[];
  await page.route('**/api/ai/chat',async route=>{
    sent.push(route.request().postDataJSON().question_id);
    const label=sent.length===1?'第一题的测试解析':'下一题的测试解析';
    await route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({type:'delta',text:label})+'\n\ndata: '+JSON.stringify({type:'done'})+'\n\n'});
  });
  const s=await create(request,'paper20');
  await page.goto('/?session='+s.id);
  await page.getByRole('button',{name:'问 AI',exact:true}).click();
  await page.getByRole('button',{name:'讲解本题',exact:true}).click();
  await expect(page.locator('.ai-message.assistant')).toContainText('第一题的测试解析');
  expect(sent).toEqual([s.question_ids[0]]);
  await page.getByRole('button',{name:'下一题',exact:true}).click();
  await expect(page.locator('.ai-context')).toContainText(s.questions[1].stem);
  await expect(page.locator('.ai-message')).toHaveCount(0);
  await page.getByRole('button',{name:'讲解本题',exact:true}).click();
  await expect(page.locator('.ai-message.assistant')).toContainText('下一题的测试解析');
  expect(sent).toEqual([s.question_ids[0],s.question_ids[1]]);
});
