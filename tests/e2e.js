/* 端到端冒烟测试：npm i && npx playwright install chromium && npm test
   AI 接口用本地假响应，不需要真实 Key */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
let failed = 0;
function check(name, ok, detail){ console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); if(!ok) failed++; }

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if(p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if(!file.startsWith(ROOT) || !fs.existsSync(file)){ res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const BASE = 'http://localhost:' + server.address().port + '/';
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  let reply = '';
  await ctx.route('https://api.deepseek.com/**', r => r.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ choices: [{ message: { content: reply } }] })
  }));
  const clean = () => page.evaluate(() => { ['guide','intro'].forEach(id => { const g = document.getElementById(id); if(g) g.remove(); }); document.querySelectorAll('.dlg__mask, .save-warn').forEach(m => m.remove()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await clean();
  check('内嵌 SheetJS 版本为 0.20.3', await page.evaluate(() => window.XLSX && window.XLSX.version === '0.20.3'));

  /* 示例数据载入与还原：快照需保留用户复盘，顶栏入口保持单行 */
  const personal = await page.evaluate(() => {
    const marker = 'sample-reflection-' + Date.now();
    state.reflections = (state.reflections || []).concat([{ id: marker, date: '2026-11-01', range: '本周', mine: marker, ai: '' }]);
    const todoCount = state.todos.length;
    saveState(state);
    return { marker, todoCount };
  });
  await page.click('#btn-sample');
  await page.waitForFunction(() => document.getElementById('sampleBtnText').textContent === '退出示例');
  await page.waitForTimeout(800);
  const sampleTodos = await page.evaluate(() => state.todos.length);
  const desktopRows = [];
  for(const width of [1440, 1280]){
    await page.setViewportSize({ width, height: 960 });
    await page.waitForTimeout(300);
    desktopRows.push(await page.evaluate(() => {
      const buttons = Array.from(document.querySelector('.topbar__actions').children);
      const rects = buttons.map(button => button.getBoundingClientRect());
      return buttons.some(button => button.id === 'btn-ai') &&
        rects.length > 0 &&
        Math.max(...rects.map(r => r.top)) - Math.min(...rects.map(r => r.top)) <= 2 &&
        Math.min(...rects.map(r => r.left)) >= 0 &&
        Math.max(...rects.map(r => r.right)) <= window.innerWidth;
    }));
    await page.screenshot({ path: path.join(SHOTS, `home-demo-${width}.png`) });
  }
  await page.click('#btn-sample');
  await page.waitForFunction(() => document.getElementById('sampleBtnText').textContent === '示例数据');
  const restored = await page.evaluate(marker => ({
    todoCount: state.todos.length,
    reflection: state.reflections.some(r => r.mine === marker)
  }), personal.marker);
  check('示例数据载入并恢复原数据，且页面无错误',
    sampleTodos > 0 && restored.todoCount === personal.todoCount && restored.reflection &&
    desktopRows.every(Boolean) && errors.length === 0,
    JSON.stringify({ sampleTodos, restored, desktopRows, errors }));

  /* v5 自然语言速建：保留日期、时间、优先级与番茄提示 */
  const beforeQuickAdd = await page.evaluate(() => state.todos.length);
  await page.click('#btn-add-todo');
  await page.fill('[data-nlp-input]', '周五18:00交读书笔记 紧急 2番茄');
  await page.click('[data-nlp-apply]');
  await page.click('[data-dlg-save]');
  const quickTodo = await page.evaluate(() => state.todos.find(t =>
    t.title.indexOf('读书笔记') !== -1 && /T18:00$/.test(t.due) && t.priority === 'high' &&
    t.note.indexOf('2 个番茄') !== -1
  ));
  check('自然语言速建仍可创建周五读书笔记待办',
    await page.evaluate(() => state.todos.length) === beforeQuickAdd + 1 && !!quickTodo,
    JSON.stringify(quickTodo || null));

  /* 1. XSS：恶意备份里的待办标题不能执行 */
  const xss = await page.evaluate(() => {
    const due = new Date(Date.now() + 3600e3);
    const s = JSON.parse(JSON.stringify(state));
    s.todos = [{ id: 'x', title: '<img src=x onerror="window.__xss=1">', due: ymdOf(due) + 'T' + pad2(due.getHours()) + ':00', priority: 'high', done: false }];
    importBackupText(JSON.stringify({ app: 'little-steps', version: 1, exportedAt: new Date().toISOString(), state: s }));
    return new Promise(r => setTimeout(() => r(state.todos.length === 1 && !window.__xss), 800));
  });
  check('备份导入不执行脚本', xss);
  await clean();

  /* 2. AI 任务拆解 → 加入待办 */
  await page.click('#btn-ai');
  await page.fill('[data-ai-key]', 'sk-test');
  await page.click('[data-ai-save]');
  await page.click('[data-ai-tab=plan]');
  await page.fill('[data-ai-goal]', '完成课程论文');
  reply = '```json\n[{"title":"确定提纲","due":"2030-01-01T20:00","priority":"high","pomos":2,"tip":"列三级标题"},{"title":"<b>查文献</b>","due":"2030-01-02T15:00","priority":"mid","pomos":3}]\n```';
  await page.click('[data-ai-plan]');
  await page.waitForSelector('.ai-task');
  check('AI 返回内容按文本显示', await page.evaluate(() => !document.querySelector('.ai-task b')));
  await page.screenshot({ path: path.join(SHOTS, 'ai-task-breakdown.png') });
  await page.click('[data-ai-plan-add]');
  const aiTodos = await page.evaluate(() => state.todos.filter(t => t.source === 'ai'));
  const todoFields = ['id','title','due','priority','remindBefore','pomos','done','note','calendar'];
  check('AI 步骤按 v5 待办格式加入清单',
    aiTodos.length === 2 && aiTodos.every(t => todoFields.every(k => Object.prototype.hasOwnProperty.call(t, k))),
    JSON.stringify(aiTodos));

  /* 3. AI 课表识别 → 导入核对表 */
  await clean();
  await page.click('#btn-ai');
  await page.click('[data-ai-tab=course]');
  await page.fill('[data-ai-course-text]', '周一1-2节 高等数学 A101');
  reply = '[{"name":"高等数学","day":1,"start":1,"end":2,"place":"A101","fromWeek":1,"toWeek":16,"weekType":"all"}]';
  await page.click('[data-ai-course]');
  await page.waitForSelector('[data-import-review]:not([hidden])');
  await page.waitForTimeout(800);
  const rows = await page.evaluate(() => importParsedCourses.map(r => [r.name, r.day, r.startLabel, r.endLabel].join(',')));
  check('AI 课表进入导入核对', rows[0] === '高等数学,1,1,2', rows.join(';'));
  await page.screenshot({ path: path.join(SHOTS, 'ai-course-review.png') });

  /* 4. 成长复盘保存记录 */
  await clean();
  await page.click('#btn-ai');
  await page.click('[data-ai-tab=reflect]');
  await page.fill('[data-ai-mine]', '这周有点拖延');
  reply = '本周开了个好头。\n· 每天至少一个番茄';
  await page.click('[data-ai-reflect]');
  await page.waitForSelector('[data-ai-reflect-result] .ai-text');
  check('复盘记录已保存', await page.evaluate(() => state.reflections.length >= 1));

  /* 5. 备份里不含 AI Key */
  check('AI Key 不进入 state', await page.evaluate(() => JSON.stringify(state).indexOf('sk-test') < 0));

  /* 6. 存储失败有提示 */
  await clean();
  const warned = await page.evaluate(() => { const o = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error('quota'); }; saveState(state); Storage.prototype.setItem = o; return !!document.querySelector('.save-warn'); });
  check('保存失败给出提示', warned);

  /* 7. PWA */
  check('Service Worker 已注册', await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())));

  /* 8. 手机端 */
  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await m.goto(BASE, { waitUntil: 'networkidle' });
  await m.evaluate(() => { ['guide','intro'].forEach(id => { const g = document.getElementById(id); if(g) g.remove(); }); });
  await m.waitForTimeout(1000);
  const mobileLayout = await m.evaluate(() => {
    const r = document.getElementById('btn-ai').getBoundingClientRect();
    return r.bottom <= window.innerHeight - 44;
  });
  check('手机端 AI 入口可见且不与底栏重叠', await m.isVisible('#btn-ai') && mobileLayout);
  await m.screenshot({ path: path.join(SHOTS, 'mobile-home-390.png') });

  await clean();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.click('#btn-sample');
  await page.waitForFunction(() => document.getElementById('sampleBtnText').textContent === '退出示例');
  await page.waitForTimeout(800);
  await page.click('#btn-review');
  await page.waitForSelector('#reviewPage:not([hidden])');
  await page.click('[data-review-range="semester"]');
  await page.screenshot({ path: path.join(SHOTS, 'semester-review.png') });
  check('页面无脚本错误', errors.length === 0, errors.join(' | '));
  await browser.close();
  server.close();
  console.log(failed ? failed + ' 项失败' : '全部通过');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
