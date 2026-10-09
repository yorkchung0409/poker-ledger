/**
 * 集成测试：用 jsdom 真实加载 index.html，走完整用户流程。
 * 覆盖单测测不到的部分：DOM 渲染、事件绑定、localStorage 持久化、账本切换、导入导出。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('C:/Users/WIN/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label}${a === b ? '' : ` (期望 ${b}，实际 ${a})`}`);
}

/**
 * 取用户真正看得见的文本：剔除 script/style。
 * 直接用 body.textContent 会把脚本源码里的 `return NaN`、`=== undefined`
 * 这类字面量算进来，导致误判。
 */
function visibleText(doc) {
  const clone = doc.body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript').forEach(n => n.remove());
  return clone.textContent;
}

/* ===== 颜色工具（WCAG 相对亮度 / 对比度）===== */
function hexParts(h) {
  h = String(h).replace('#', '');
  if (h.length === 3) h = [...h].map(c => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const hexR = h => hexParts(h)[0];
const hexG = h => hexParts(h)[1];
const hexB = h => hexParts(h)[2];
function relLum(h) {
  const f = c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexParts(h);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const la = relLum(a), lb = relLum(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 造一个带 localStorage 的干净环境并加载页面脚本 */
function boot(seed) {
  const store = new Map();
  if (seed) for (const [k, v] of Object.entries(seed)) store.set(k, v);

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://local.test/',
    pretendToBeVisual: true,
    beforeParse(win) {
      // 注意：必须用 defineProperty。jsdom 窗口上已有只读的 localStorage 属性，
      // 直接赋值会静默失败，导致页面用的是 jsdom 自带存储而测试读不到数据。
      Object.defineProperty(win, 'localStorage', {
        configurable: true,
        value: {
          getItem: k => (store.has(k) ? store.get(k) : null),
          setItem: (k, v) => store.set(k, String(v)),
          removeItem: k => store.delete(k),
          clear: () => store.clear(),
        },
      });
      win.confirm = () => true;
      // jsdom 不实现 scrollTo，应用里的「聚焦后把页面拉回去」会打印噪音，这里补个空实现
      win.scrollTo = () => {};
      win.prompt = (msg, def) => def;
      win.alert = () => {};
      win.Blob = class { constructor(parts) { this.parts = parts; } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.crypto.randomUUID = (() => {
        let n = 0;
        return () => `uuid-${++n}`;
      })();
    },
  });
  const win = dom.window;
  const doc = win.document;
  const $ = id => doc.getElementById(id);
  const txt = id => ($(id) ? $(id).textContent : '');

  /** 点击元素 */
  function click(el) {
    if (!el) throw new Error('click: 元素不存在');
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  const q = sel => doc.querySelector(sel);
  const qa = sel => [...doc.querySelectorAll(sel)];

  const api = { win, doc, $, txt, click, q, qa, store,
                /** 页面里 <style> 的 CSS 源码（用于校验色板/布局预算） */
                css: () => (doc.getElementById('s') || doc.querySelector('style')).textContent,
                /** 页面 HTML 源码（用于校验 viewport / 内联表达式） */
                html: () => html,
                raw: () => JSON.parse(store.get('poker-ledger:v1')),
                /** 把当前 localStorage 内容作为种子传给下一个环境 */
                seedRaw: () => store.get('poker-ledger:v1'),
                /** 按 data-f 精确取录入行里的某个输入框（不要用索引，字段会增删） */
                field: (row, f) => [...row.querySelectorAll('input')].find(i => i.dataset.f === f),
                /** 当前所有录入行 */
                prows: () => [...doc.querySelectorAll('.prow')],
                /** 给某行某字段填值并触发 input */
                setField: (row, f, v) => {
                  const el = [...row.querySelectorAll('input')].find(i => i.dataset.f === f);
                  if (!el) throw new Error(`字段 ${f} 不存在`);
                  el.value = v;
                  el.dispatchEvent(new win.Event('input', { bubbles: true }));
                },
                /** 给「买入」格填值（第 1 笔，不点 +） */
                setBuy: (rowIndex, v) => {
                  const el = [...api.prows()[rowIndex].querySelectorAll('input')]
                    .find(i => i.dataset.f === 'buy');
                  if (!el) throw new Error('找不到买入输入框');
                  el.value = String(v);
                  el.dispatchEvent(new win.Event('input', { bubbles: true }));
                },
                /**
                 * 打开选人面板，勾选名单里的人，再点「确认上场」。
                 * 面板是多选的，所以这里一次可以传任意多位 —— 打开一次、勾完、确认。
                 */
                pickPlayers: names => {
                  const list = [].concat(names);
                  api.click($('btnAddRow'));
                  if (!doc.getElementById('ovPickPlayer').classList.contains('show')) {
                    throw new Error('选人面板没打开');
                  }
                  for (const name of list) {
                    const btn = [...doc.querySelectorAll('#pickList .pick')]
                      .find(b => b.textContent.includes(name));
                    if (!btn) throw new Error(`选人列表里没有「${name}」`);
                    api.click(btn);
                  }
                  api.click($('btnConfirmPick'));
                },
                /** 只挑一位（最常用，保留单数形式） */
                pickPlayer: name => api.pickPlayers([name]),
                /** 设置「本局买入」（一手金额，元） */
                setBuyDefault: v => {
                  const el = $('inBuyDefault');
                  el.value = v == null ? '' : String(v);
                  el.dispatchEvent(new win.Event('input', { bubbles: true }));
                },
                /** 依次填一行：{buy, value} */
                fill: (row, vals) => {
                  for (const [f, v] of Object.entries(vals)) api.setField(row, f, String(v));
                },
                /** 在某行追加一笔买入：填金额 -> 点 + / 回车
                 *  注意：追加会触发 renderRows() 重建 DOM，行元素会被替换，
                 *  所以必须按索引重新取行，不能复用旧引用。
                 *  commitOnly=true 表示「格子里已有第 1 笔，这次点 + 只是确认它」
                 *  （不填新值、不改变结余）。 */
                buy: (rowIndex, amount, viaEnter, commitOnly) => {
                  const row = api.prows()[rowIndex];
                  const inp = [...row.querySelectorAll('input')].find(i => i.dataset.f === 'buy');
                  if (!inp) throw new Error('找不到买入输入框');
                  if (!commitOnly) {
                    inp.value = String(amount);
                    inp.dispatchEvent(new win.Event('input', { bubbles: true }));
                  }
                  if (viaEnter) {
                    inp.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
                  } else {
                    const btn = row.querySelector('[data-act="buy"]');
                    if (!btn) throw new Error('找不到买入按钮');
                    api.click(btn);
                  }
                },
                /** 某行「总买入」格子显示的文本（按索引实时取行） */
                /**
                 * 某行「总买入」显示的数字。
                 *
                 * ★ 这一格现在不只是个数字 —— 它同时是买入明细的入口，
                 *   里面还有笔数角标（.tb-badge，绝对定位的右上角上标）。
                 *   所以只读 .tb-num，别把角标一起读进来。
                 */
                tbText: i => {
                  const c = api.prows()[i].querySelector('[data-tb]');
                  if (!c) return '';
                  const n = c.querySelector('.tb-num');
                  return (n ? n.textContent : c.textContent).trim();
                },
                /**
                 * 某行当前已记录的买入笔数。
                 *
                 * ★ 明细入口从「输入框下方独立一行的按钮」改成了「总买入那一格」
                 *   （点汇总看明细，入口有整个单元格那么大，行高也回到单行）。
                 *   笔数现在只作为一个纯信息角标 .tb-badge 贴在数字右侧 ——
                 *   它不可点，点它是穿透到 .tb 上去的。
                 */
                rebuyLabel: i => {
                  const b = api.prows()[i].querySelector('.tb-badge');
                  return b ? b.textContent.trim() : '';
                },
                /** 某行盈亏格显示的文本 */
                pfText: i => {
                  const c = api.prows()[i].querySelector('.pf');
                  return c ? c.textContent.trim() : '';
                },
                /** 某行某个输入框的当前值 */
                fieldIn: (i, f) => {
                  const el = [...api.prows()[i].querySelectorAll('input')].find(x => x.dataset.f === f);
                  return el ? el.value : null;
                } };
  return api;
}

/* ============================================================ */
console.log('=== 1. 首次启动 ===');
{
  const t = boot();
  eq(t.$('ledgerSelect').options.length, 1, '默认创建 1 个账本');
  ok(t.$('ledgerSelect').options[0].text.includes('默认账本'), '账本名为「默认账本」');
  ok(t.$('gameList').textContent.includes('还没有牌局记录'), '显示空状态提示');
  ok(t.$('rankList').textContent.includes('还没有排行'), '排行榜显示空状态');
  eq(t.$('btnAddGame').disabled, true, '无人员时禁用记牌局按钮');
  ok(t.$('stats').textContent.includes('0'), '统计显示 0 场');
  ok(t.q('title').textContent.includes('扑克记分房'), '标题为扑克记分房');

  /* ---- 分区折叠：默认收起 ---- */
  // 注意：jsdom 不做布局，display:none 的元素 .textContent 照样返回内容，
  // 所以不能靠「读不到文字」判断收起 —— 要断言驱动显隐的那个 class / 属性。
  ok(!t.$('secRank').classList.contains('open'), '★ 排行榜默认收起');
  ok(!t.$('secGames').classList.contains('open'), '★ 牌局记录默认收起');
  eq(t.$('headRank').getAttribute('aria-expanded'), 'false', '排行榜 aria-expanded=false');
  eq(t.$('headGames').getAttribute('aria-expanded'), 'false', '牌局记录 aria-expanded=false');
  ok(t.q('#headRank .fold-arrow'), '标题行有折叠箭头');
  ok(t.q('#headRank .fold-hint').textContent.includes('点开'), '收起时提示「点开」');
  // 折叠体必须挂在 .fold-body 上（CSS 靠 .section.open .fold-body 控制显隐）
  ok(t.$('rankList').classList.contains('fold-body'), '★ 排行榜本体是折叠体');
  ok(t.$('gameList').classList.contains('fold-body'), '★ 牌局列表是折叠体');

  // 点标题行展开
  t.click(t.$('headRank'));
  ok(t.$('secRank').classList.contains('open'), '★ 点排行榜标题行展开');
  eq(t.$('headRank').getAttribute('aria-expanded'), 'true', '展开后 aria-expanded=true');
  ok(!t.$('secGames').classList.contains('open'), '只展开被点的那一个（互不影响）');
  // 再点收起
  t.click(t.$('headRank'));
  ok(!t.$('secRank').classList.contains('open'), '★ 再点一次收起');

  // CSS 侧：收起态必须真的 display:none，否则「折叠」只是加了个类
  const cssTxt = t.doc.querySelector('style').textContent;
  ok(/\.fold-body\s*\{\s*display:\s*none/.test(cssTxt), '★ CSS：折叠体默认 display:none');
  ok(/\.section\.open\s+\.fold-body\s*\{\s*display:\s*block/.test(cssTxt),
     '★ CSS：展开态 .section.open 才显示');
  // 空态不应出现 NaN / undefined。
  // 注意：必须排除 <script>，否则会把源码里的 `return NaN` 等字面量当成渲染结果。
  const body1 = visibleText(t.doc);
  ok(!body1.includes('NaN'), '首屏无 NaN');
  ok(!body1.includes('undefined'), '首屏无 undefined');
}

console.log('\n=== 2. 人员管理 ===');
let env;
{
  const t = boot();
  env = t;
  t.click(t.$('btnPlayers'));
  ok(t.$('ovPlayers').classList.contains('show'), '人员弹窗打开');

  const input = t.$('inPlayerName');
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  };

  setVal(input, '老王');   t.click(t.$('btnAddPlayer'));
  setVal(input, '小李');   t.click(t.$('btnAddPlayer'));
  setVal(input, '阿明');   t.click(t.$('btnAddPlayer'));
  eq(t.qa('.ptag').length, 3, '添加 3 位人员');
  ok(t.$('plist').textContent.includes('老王'), '人员标签显示姓名');

  // 重名应被拒绝
  setVal(input, '老王');   t.click(t.$('btnAddPlayer'));
  eq(t.qa('.ptag').length, 3, '重名被拒绝，仍为 3 人');

  // 空名应被拒绝
  setVal(input, '   ');   t.click(t.$('btnAddPlayer'));
  eq(t.qa('.ptag').length, 3, '空名被拒绝');

  eq(t.$('btnAddGame').disabled, false, '有人员后记牌局按钮可用');

  /* ---- 输入框不能被标签列表挤出面板（手机上的真实 bug）----
   *
   * 症状：手机上人员列表长一点，输入框就「不见了」。
   * 原因：输入行原本和标签列表同在一个 overflow-y:auto 的滚动区里，
   *       标签一多就把输入框顶到可视区外，而且没有任何提示可以往上滚。
   *       实测 30 人 / 视口 420px 高时，输入框底边在 481，比视口底还低 61px。
   * 修法：输入行移出滚动区，用 sheet-foot 钉在面板底部。
   *
   * 这里断言的是**结构**（DOM 层级），因为 jsdom 不做布局，
   * 算不出真实坐标；真实坐标用 _shot/measure-players.cjs 在 Chrome 里量。
   */
  {
    const body = t.$('ovPlayers').querySelector('.sheet-body');
    const input = t.$('inPlayerName');
    const foot = t.$('ovPlayers').querySelector('.sheet-foot');
    ok(!body.contains(input), '★ 输入框不在滚动区（sheet-body）里 —— 不会被标签列表挤走');
    ok(foot && foot.contains(input), '★ 输入框钉在 sheet-foot 里（面板底部常驻）');
    ok(foot.contains(t.$('btnAddPlayer')), '★ 「添加」按钮和输入框同处 foot，不会分家');
    ok(foot.contains(t.$('ovPlayers').querySelector('.note')), '★ 说明文字也在 foot 里（与输入框一起常驻）');
    // 标签列表仍必须是滚动区的内容
    ok(body.contains(t.$('plist')), '标签列表留在 sheet-body（它才是该滚的那个）');
    // foot 必须在 body 之后（视觉上在下）
    const kids = [...t.$('ovPlayers').querySelector('.sheet').children]
      .filter(el => el.classList.contains('sheet-body') || el.classList.contains('sheet-foot'));
    eq(kids.map(el => el.classList.contains('sheet-foot')).join(','), 'false,true',
       '★ foot 排在 body 之后（钉在底部）');
    ok(foot.classList.contains('sheet-foot-col'), '★ foot 是竖排变体（输入行 + 说明）');
  }

  /* ---- 选人上场面板（多选）---- */
  // 面板里必须列出人、可多选、已上场的置灰 —— 而不是「点一下自动塞第一个」
  t.click(t.$('btnAddGame'));
  eq(t.qa('.prow').length, 0, '★ 新牌局仍是 0 行（不预填）');
  t.click(t.$('btnAddRow'));
  ok(t.$('ovPickPlayer').classList.contains('show'), '选人面板打开');
  eq(t.qa('#pickList .pick').length, 3, '★ 面板列出全部 3 位人员供挑选');
  eq(t.qa('.prow').length, 0, '★ 仅打开面板不会自动添加任何人');
  ok(t.$('btnConfirmPick').disabled, '★ 一个都没勾时「确认上场」禁用');

  // ★ 多选：点一下是「勾上」，不是「进场」
  const pickOf = name => t.qa('#pickList .pick').find(b => b.textContent.includes(name));
  t.click(pickOf('阿明'));
  eq(t.qa('.prow').length, 0, '★ 勾选后仍不进场（要等确认）');
  ok(pickOf('阿明').classList.contains('on'), '★ 勾选项有选中态');
  ok(t.$('btnConfirmPick').textContent.includes('1'), '★ 确认按钮显示勾选人数');
  ok(!t.$('btnConfirmPick').disabled, '勾了人后确认按钮可用');

  // 再点一次可以取消勾选
  t.click(pickOf('阿明'));
  ok(!pickOf('阿明').classList.contains('on'), '★ 再点一次取消勾选');
  ok(t.$('btnConfirmPick').disabled, '取消到 0 人后确认按钮又禁用');

  // ★ 真·多选：一次勾 3 个，一次确认
  t.click(pickOf('老王'));
  t.click(pickOf('小李'));
  t.click(pickOf('阿明'));
  eq(t.qa('#pickList .pick.on').length, 3, '★ 同时勾中 3 人');
  ok(t.$('btnConfirmPick').textContent.includes('3'), '确认按钮显示「3 人」');
  t.click(t.$('btnConfirmPick'));
  eq(t.qa('.prow').length, 3, '★ 一次确认把 3 人一起放上场（不用开关面板 3 次）');
  ok(!t.$('ovPickPlayer').classList.contains('show'), '确认后自动关面板');

  // 行顺序 = 点选顺序（老王→小李→阿明）
  const nameCol = i => t.qa('.prow')[i].querySelector('input,select').value;
  eq(t.qa('.prow').length, 3, '3 行');
  ok(t.qa('.prow')[0].textContent.includes('老王'), '★ 第 1 行是第一个点的人（老王）');
  ok(t.qa('.prow')[1].textContent.includes('小李'), '★ 第 2 行是第二个点的人（小李）');
  ok(t.qa('.prow')[2].textContent.includes('阿明'), '★ 第 3 行是第三个点的人（阿明）');

  // 再开：全部置灰（3 人都在场上了）
  // 注意：全员在场后 btnAddRow 已禁用，点它不会重绘面板，所以直接调渲染。
  t.win.renderPickList();
  const opts = t.qa('#pickList .pick');
  eq(opts.length, 3, '已在场的人也列出来（不隐藏，避免以为列表缺人）');
  eq(opts.filter(b => b.disabled).length, 3, '★ 已上场的 3 人全部置灰');
  ok(opts.every(b => b.textContent.includes('已上场')), '置灰项都标注「已上场」');

  // 新建并选中：建完人只勾上，仍要确认才进场
  const nin = t.$('inNewPlayerName');
  nin.value = '新同学';
  nin.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  t.click(t.$('btnAddPlayerThenPick'));
  eq(t.qa('.prow').length, 3, '★「新建并选中」不直接进场（仍 3 行）');
  ok(t.$('pickList').textContent.includes('新同学'), '新人出现在选人列表里');
  ok(t.qa('#pickList .pick.on').some(b => b.textContent.includes('新同学')),
     '★ 新人处于勾选态');
  t.click(t.$('btnConfirmPick'));
  eq(t.qa('.prow').length, 4, '确认后新人才进场');
  ok(!t.$('ovPickPlayer').classList.contains('show'), '确认后面板关闭');
  ok(t.$('plist').textContent.includes('新同学'), '新人也进了人员名单');

  ok(t.$('btnAddRow').disabled, '★ 全员上场后「+ 选择人员上场」禁用');

  // 直接调用渲染（按钮已禁用，点不动），验证面板文案
  t.win.renderPickList();
  ok(t.$('pickList').textContent.includes('都已在场上'), '全员上场后面板给提示');
  // ★ 全员上场时仍列出名单（全置灰）—— 否则「谁在场上」就看不到了
  eq(t.qa('#pickList .pick').length, 4, '★ 全员上场时仍列出名单供核对');
  eq(t.qa('#pickList .pick').filter(b => !b.disabled).length, 0, '★ 但没有任何可选项');
  t.click(t.qa('#ovPickPlayer .sheet-close')[0]);

  // ★ 收尾：把这一节造出来的多余状态清掉，避免污染后面复用 env 的小节。
  //   本节的目的是测「加人/选人」交互，结束时应回到「3 位人员、无牌局」的基线。
  //   （新同学是本节为测「新建并上场」而造的，牌局也是临时开的。）
  t.win.closeSheet('ovGame');
  t.click(t.$('btnPlayers'));
  t.click(t.$('plist').querySelector('[data-rmp]') && [...t.qa('[data-rmp]')]
    .find(b => b.closest('.ptag').textContent.includes('新同学')));
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
  eq(t.qa('.ptag').length, 3, '收尾：回到 3 位人员（清掉测试中新建的人）');

  // 持久化：重新加载后人员还在
  const re = boot({ 'poker-ledger:v1': t.seedRaw() });
  eq(re.qa('.ptag').length, 0, '重载后人员标签在弹窗外不显示（正常）');
  eq(re.$('btnAddGame').disabled, false, '重载后记牌局按钮仍可用（人员已持久化）');
}

console.log('\n=== 3. 记录一场牌局（按结余模式）===');
{
  const t = env;
  t.click(t.$('btnPlayers'));
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  };
  setVal(t.$('inPlayerName'), '老王'); t.click(t.$('btnAddPlayer'));
  setVal(t.$('inPlayerName'), '小李'); t.click(t.$('btnAddPlayer'));
  setVal(t.$('inPlayerName'), '阿明'); t.click(t.$('btnAddPlayer'));
  t.click(t.qa('.overlay .sheet-close').find(b => b.dataset.close === 'ovPlayers'));

  t.click(t.$('btnAddGame'));
  ok(t.$('ovGame').classList.contains('show'), '牌局弹窗打开');

  // ★ 新牌局不再自动预填全部人员，从 0 行开始，由用户自己挑谁上场。
  //   （旧行为是 players.map 铺满表格，账本里 12 人、今晚来 5 个就得删 7 行。）
  eq(t.qa('.prow').length, 0, '★ 新牌局从 0 行开始（不预填全部人员）');
  ok(!!t.q('.rows-empty'), '空表显示空态提示');
  ok(t.$('calcHint').textContent.includes('还没有人上场'), '空表时计算区提示「还没有人上场」');
  // 空表不显示表头（空表格配表头像是加载失败）
  eq(t.qa('.prow-head').length, 0, '空表不显示六列表头');

  // 逐个挑选上场
  t.pickPlayers(['老王', '小李', '阿明']);
  eq(t.qa('.prow').length, 3, '挑了 3 人后表格有 3 行');
  ok(!t.$('ovPickPlayer').classList.contains('show'), '选完自动关面板');
  ok(t.$('ovGame').classList.contains('show'), '★ 牌局面板仍开着（选人面板是叠在上面的）');
  eq(t.doc.body.style.overflow, 'hidden', '★ 选人面板关闭后 body 仍锁定（否则背后页面会跟着滑）');

  ok(t.$('calcHint').textContent.includes('还没有人员') || t.$('calcHint').textContent.trim().length > 0,
     '实时计算区有内容');
  // 六列表头：人员 | 买入 | 总买入 | 结余 | 盈亏 | (删除)
  const head = t.qa('.prow-head div').map(d => d.textContent.trim());
  eq(head[0], '人员', '表头 1 人员');
  eq(head[1], '买入', '表头 2 买入');
  eq(head[2], '总买入', '表头 3 总买入');
  eq(head[3], '结余', '表头 4 结余');
  eq(head[4], '盈亏', '表头 5 盈亏');
  ok(t.field(t.prows()[0], 'buy') !== undefined, '每行都有买入输入框');
  ok(t.prows()[0].querySelector('[data-act="buy"]') !== null, '每行都有买入追加按钮');

  // 买入 100/100/100，结余 300/0/0 -> 盈亏 +200/-100/-100（零和平衡）
  const buyins = ['100', '100', '100'];
  const bals = ['300', '0', '0'];
  t.qa('.prow').forEach((row, i) => {
    const buy = t.field(row, 'buy'), val = t.field(row, 'value');
    setVal(buy, buyins[i]);
    setVal(val, bals[i]);
  });

  ok(t.$('calcHint').textContent.includes('已平衡'), '零和校验提示已平衡');
  ok(t.$('calcHint').textContent.includes('200'), '流水显示 200');

  t.click(t.$('btnSaveGame'));
  ok(!t.$('ovGame').classList.contains('show'), '保存后弹窗关闭');
  eq(t.qa('.game').length, 1, '生成 1 张牌局卡');
  // ★ 牌局记录默认收起，但刚保存完必须自动展开 ——
  //   否则「记完一场却看不到自己刚记的」，会让人怀疑没存上。
  ok(t.$('secGames').classList.contains('open'), '★ 保存后「牌局记录」自动展开（刚记的看得见）');
  eq(t.$('headGames').getAttribute('aria-expanded'), 'true', '自动展开后 aria-expanded=true');
  ok(t.$('gameList').textContent.includes('3人'), '牌局卡显示 3 人');
  ok(t.$('stats').textContent.includes('1'), '统计变为 1 场');
  ok(!t.$('gameList').textContent.includes('未平'), '平衡牌局不显示未平标记');

  // 刚保存的牌局默认自动展开，可直接看到明细
  ok(t.$('gameList').textContent.includes('盈亏'), '保存后自动展开显示盈亏列');
  ok(t.$('gameList').textContent.includes('总买入'), '明细表有总买入列');
  ok(t.$('gameList').textContent.includes('买入'), '明细表有买入列');
  ok(!t.$('gameList').textContent.includes('起始买入'), '明细表不再有「起始买入」列（已合并进「买入」）');

  // 点一下收起
  t.click(t.q('[data-toggle]'));
  ok(!t.$('gameList').textContent.includes('总买入'), '点击后收起明细');
  ok(t.$('gameList').textContent.includes('流水'), '收起后仍显示流水概要');

  // 再点展开
  t.click(t.q('[data-toggle]'));
  ok(t.$('gameList').textContent.includes('总买入'), '再次点击展开明细');
  ok(t.$('gameList').textContent.includes('已平衡'), '展开后显示已平衡');
  const body = t.$('gameList').textContent;
  // ★ v20：牌局摘要表里的「净盈亏」也改整元显示（和行内那一列一致）
  ok(body.includes('+200'), '老王 +200 显示正确（整元）');
  ok(body.includes('-100'), '小李 -100 显示正确（整元）');
  ok(!/\+200\.00/.test(body) && !/-\d+\.\d\d/.test(body),
     '★ 摘要表不再出现两位小数（与行内总买入/盈亏的整元写法统一）');

  // 展开状态属于 UI 临时状态，不应写进 localStorage
  ok(!t.seedRaw().includes('_open'), '展开状态不写入 localStorage');

  // 排行榜
  ok(t.$('rankList').textContent.includes('+200.00'), '排行榜老王居首 +200.00');
  const rankRows = t.qa('.rank-row');
  eq(rankRows.length, 3, '排行榜 3 行');
  ok(rankRows[0].textContent.includes('老王'), '第一名是老王');
  ok(rankRows[0].querySelector('.rank-no').textContent.includes('1'), '第一名标记为 1');
}

console.log('\n=== 4. 不平衡牌局应被标红 ===');
{
  const t = boot();
  // 复用上一个环境的数据
  const seed = { 'poker-ledger:v1': env.seedRaw() };
  const t2 = boot(seed);
  t2.win.confirm = () => true;

  // 直接注入一场不平衡的牌局：+300 +200 -400
  // ★ 日期必须比 seed 里已有的牌局更新，否则「最近一场」统计看到的还是旧的平衡场次
  //   （踩过：写 2026-10-09 和 seed 同日，createdAt 又早，于是没成为 latest）
  const data = t2.raw();
  data.ledgers[0].games.push({
    id: 'g-bad', date: '2099-12-31',
    entries: [
      { playerId: 'p1', playerName: '老王', buyIn: 10000, balance: 10300, netProfit: 30000 },
      { playerId: 'p2', playerName: '小李', buyIn: 10000, balance: 10200, netProfit: 20000 },
      { playerId: 'p3', playerName: '阿明', buyIn: 10000, balance: 9600,  netProfit: -40000 },
    ],
    createdAt: '2026-10-09T12:00:00.000Z', _open: true,
  });
  t2.win.localStorage.setItem('poker-ledger:v1', JSON.stringify(data));

  const t3 = boot({ 'poker-ledger:v1': JSON.stringify(data) });
  ok(t3.$('gameList').textContent.includes('未平'), '不平衡牌局显示「未平」标记');
  // 牌局卡底部那行也要摊开赢/输/差，和录入区的口径保持一致
  const br = t3.q('.balance-row');
  ok(!!br, '牌局卡有结算行');
  ok(/赢\s*¥/.test(br.textContent), '★ 结算行显示「赢」侧');
  ok(/输\s*¥/.test(br.textContent), '★ 结算行显示「输」侧');
  ok(/差\s*¥/.test(br.textContent) && br.textContent.includes('未平'),
     '★ 结算行显示「差 ¥X 未平」（不再只说「差额」）');
  ok(t3.$('stats').textContent.includes('未平'),
     `统计卡最近一场显示「未平」（实际: ${t3.$('stats').textContent.replace(/\s+/g, ' ').trim()}）`);
}

console.log('\n=== 5. 六列 + 买入追加 + 行内盈亏 ===');
{
  const t = boot();
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  };
  t.click(t.$('btnPlayers'));
  setVal(t.$('inPlayerName'), '老王'); t.click(t.$('btnAddPlayer'));
  setVal(t.$('inPlayerName'), '小李'); t.click(t.$('btnAddPlayer'));
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
  t.click(t.$('btnAddGame'));

  // 录入方式切换控件应已彻底移除
  eq(t.qa('.seg').length, 0, '不再有录入方式切换按钮');
  eq(t.qa('.segmented').length, 0, '不再有 segmented 容器');

  // 新牌局从 0 行开始 —— 先挑两位上场（不再自动预填）
  t.pickPlayers(['老王', '小李']);

  // 每行盈亏格初始为占位符
  eq(t.qa('.pf').length, 2, '每行有一个盈亏格');
  eq(t.pfText(0), '—', '未输入时盈亏占位符');
  eq(t.tbText(0), '—', '未输入时总买入占位符');

  // ---- 第 1 笔买入 + 结余 ----
  const r0 = t.prows()[0];
  setVal(t.field(r0, 'buy'), '100');
  setVal(t.field(r0, 'value'), '300');
  eq(t.tbText(0), '100', '第 1 笔买入时总买入 = 该笔');
  eq(t.pfText(0), '+200', '盈亏 = 结余 - 总买入');
  ok(t.prows()[0].querySelector('.pf').classList.contains('up'), '盈利标红（涨色）');
  eq(t.rebuyLabel(0), '', '只填格子、未点 + 时不显示笔数角标');

  // ---- 点 + 确认第 1 笔：明细里落 1 笔，格子清空 ----
  t.click(t.prows()[0].querySelector('[data-act="buy"]'));
  eq(t.rebuyLabel(0), '1', '点 + 后角标显示 1 笔');
  eq(t.tbText(0), '100', '确认后总买入仍 = 100');
  eq(t.fieldIn(0, 'buy'), '', '确认后格子清空，可填下一笔');
  eq(t.fieldIn(0, 'value'), '300', '★ 确认第 1 笔不改结余（格子里的数早已计入总买入，不能再加一遍）');
  eq(t.pfText(0), '+200', '★ 确认后盈亏不变');

  // ---- 追加一笔 50：只进明细，结余不动（用户自己报结余） ----
  t.buy(0, 50);
  eq(t.rebuyLabel(0), '2', '追加后角标显示 2 笔');
  eq(t.tbText(0), '150', '追加后总买入 = 100 + 50');
  eq(t.fieldIn(0, 'value'), '300', '★ 追加不改结余（结余只由用户自己输入）');
  eq(t.pfText(0), '+150', '★ 追加买入后盈亏随之变化（总买入涨、结余不变）');
  eq(t.fieldIn(0, 'buy'), '', '追加后格子清空，可继续加');

  // ---- 再追加一笔：回车提交 ----
  t.buy(0, 50, true);
  eq(t.rebuyLabel(0), '3', '第三笔买入记上了');
  eq(t.tbText(0), '200', '三笔买入后总买入 = 100+50+50');
  eq(t.fieldIn(0, 'value'), '300', '结余仍由用户掌握，不被买入推着走');
  eq(t.pfText(0), '+100', '三笔买入后盈亏 = 300 − 200');

  // ---- 展开明细 ----
  eq(t.qa('.rbd').length, 0, '默认不展开买入明细');
  t.click(t.prows()[0].querySelector('[data-act="buyList"]'));
  eq(t.qa('.rbd').length, 1, '点开后显示买入明细');
  eq(t.qa('.rbi').length, 3, '明细里有 3 笔');
  // ★ v20：明细走 fmtCompact —— 整元就不带小数（和总买入列的整元显示保持一致），
  //   但**带角分时仍会显示**（fmtCompact 只在 .00 时省略，不丢信息）。
  ok(t.q('.rbd').textContent.includes('¥50') && !/\.00/.test(t.q('.rbd').textContent),
     '明细显示每笔金额（整元不带小数，与总买入列一致）');

  // ---- 撤销一笔：只回滚总买入，结余不动 ----
  // 明细里是 [100, 50, 50]，点第 3 笔（最后一个 ×）撤销那笔 50
  const dels = t.qa('[data-act="buyDel"]');
  eq(dels.length, 3, '明细里有 3 个撤销按钮');
  t.click(dels[2]);
  eq(t.qa('.rbi').length, 2, '撤销一笔后剩 2 笔');
  eq(t.tbText(0), '150', '撤销 50 后总买入 200 → 150');
  eq(t.fieldIn(0, 'value'), '300', '★ 撤销不改结余（它从未因买入变过）');
  eq(t.pfText(0), '+150', '★ 撤销买入后盈亏回到 300 − 150');

  // ---- 把结余改成用户真实报的数：盈亏随之更新 ----
  setVal(t.field(t.prows()[0], 'value'), '350');
  eq(t.pfText(0), '+200', '用户报结余 350 后盈亏 = 350 − 150 = +200');

  // ---- 说明文案必须和新语义一致 ----
  // 曾经这里写着「总买入和结余同时增加，所以盈亏不变」—— 那是旧设计，
  // 会导致同一个数被计两遍（用户报结余 300，点完 + 变 400）。文案必须跟着改。
  const note = t.q('#ovGame .note').textContent.replace(/\s+/g, ' ');
  ok(/结余不受影响|结余由你自己填/.test(note), '★ 说明文案已改成「买入不动结余」');
  ok(!/总买入和结余.*同时增加/.test(note), '★ 说明文案不再声称「总买入和结余同时增加」');

  // ---- 买入框非法输入不生效 ----
  const bad = [...t.prows()[0].querySelectorAll('input')].find(i => i.dataset.f === 'buy');
  bad.value = '1.234';
  bad.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  t.click(t.prows()[0].querySelector('[data-act="buy"]'));
  eq(t.rebuyLabel(0), '2', '非法买入金额不产生新记录');
  eq(t.tbText(0), '?', '非法输入时总买入显示 ?（提示格式错）');
  // 清掉非法输入后总额回到 150
  bad.value = '';
  bad.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  eq(t.tbText(0), '150', '清空非法输入后总买入回到 150');

  // ---- 小李：买入 300 结余 150 => -150 ----
  const r1 = t.prows()[1];
  setVal(t.field(r1, 'buy'), '300');
  setVal(t.field(r1, 'value'), '150');
  eq(t.pfText(1), '-150', '小李实时盈亏 -150');
  ok(t.prows()[1].querySelector('.pf').classList.contains('down'), '亏损标绿（跌色）');

  // ---- 整体平衡与保存 ----
  // 老王：买入 150，结余 350 => +200；小李调整为 100 => -200，抵消
  setVal(t.field(r1, 'value'), '100');
  eq(t.pfText(1), '-200', '小李调整为 -200 后与老王抵消');
  ok(t.$('calcHint').textContent.includes('已平衡'), '整体平衡');
  t.click(t.$('btnSaveGame'));
  ok(t.$('gameList').textContent.includes('已平衡'), '保存后平衡');

  // 落盘：买入必须存成 buys 明细数组
  const wang = t.raw().ledgers[0].games[0].entries.find(e => e.playerName === '老王');
  ok(Array.isArray(wang.buys), '★ 落盘字段是 buys 数组');
  eq(wang.buys.length, 2, '落盘 2 笔买入明细');
  eq(wang.buys.join(','), '10000,5000', '买入明细按发生顺序、以分存储');
  ok(!('buyIn' in wang), '旧字段 buyIn 不再入库');
  ok(!('rebuys' in wang), '旧字段 rebuys 不再入库');
  ok(!('totalBuy' in wang), '派生字段 totalBuy 不入库');
  ok(!('netProfit' in wang), '派生字段 netProfit 不入库');
}

console.log('\n=== 6. 本局买入：选人时自动记第一笔 ===');
{
  const t = boot();
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  };
  t.click(t.$('btnPlayers'));
  setVal(t.$('inPlayerName'), '老王'); t.click(t.$('btnAddPlayer'));
  setVal(t.$('inPlayerName'), '小李'); t.click(t.$('btnAddPlayer'));
  setVal(t.$('inPlayerName'), '阿明'); t.click(t.$('btnAddPlayer'));
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));

  t.click(t.$('btnAddGame'));

  // ---- 留空：不自动记买入 ----
  eq(t.$('inBuyDefault').value, '', '新牌局的「本局买入」默认留空');
  t.pickPlayers(['老王']);
  eq(t.qa('.prow').length, 1, '留空时仍能上场');
  eq(t.fieldIn(0, 'buy'), '', '★ 本局买入留空 → 不自动记买入（格子空）');
  eq(t.tbText(0), '—', '★ 留空时总买入显示 —（没有买入）');
  eq(t.rebuyLabel(0), '', '★ 留空时没有笔数角标');

  // ---- 填 200：之后加入的人自动记一笔 ----
  t.setBuyDefault('200');
  t.pickPlayer('小李');
  eq(t.qa('.prow').length, 2, '又加入 1 人');
  eq(t.tbText(1), '200', '★ 新人自动记了一笔 200（总买入 200）');
  eq(t.fieldIn(1, 'buy'), '', '★ 自动记的那笔进明细，格子留空（格子只表示「下一笔」）');
  eq(t.rebuyLabel(1), '1', '★ 自动记的买入产生 1 笔的角标');
  // 先加入的老王不受影响（改本局买入不追溯已记好的）
  eq(t.tbText(0), '—', '★ 改「本局买入」不影响已在场上的人（不篡改历史）');

  // ---- 改成 300：再加的人按新值 ----
  t.setBuyDefault('300');
  t.pickPlayer('阿明');
  eq(t.tbText(2), '300', '★ 改成本局买入 300 后，新加入的人记 300');

  /* ---- ★ 刚上桌（有买入、没结余）不能显示成输钱 ----
   * 加了自动记买入之后，新人一进场就带着 200/300 的买入、结余还是空的。
   * 按 盈亏 = 结余 − 总买入 会显示 −200，看着像「刚坐下就输光」。
   * 正确：显示「未结算」，且不计入输赢统计。
   */
  eq(t.pfText(1), '未结算', '★ 有买入但没结余 → 盈亏显示「未结算」（不显示 −200）');
  const pf1 = t.prows()[1].querySelector('.pf');
  ok(pf1.classList.contains('pending'), '★ 未结算的行用 pending 样式（不是 up/down）');
  ok(!pf1.classList.contains('down'), '★ 未结算不当成亏损（不标红/绿）');
  // 计算区也不该把未结算的人算成亏损
  ok(!/差额 ¥2\.00/.test(t.$('calcHint').textContent),
     '★ 未结算的人不参与输赢统计（不凭空造出亏损）');

  // 填上结余后就变成真正的盈亏
  const bal = t.field(t.prows()[1], 'value');
  bal.value = '500';
  bal.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  eq(t.pfText(1), '+300', '★ 填了结余后正常算盈亏（500 − 200 = +300）');
  ok(!t.prows()[1].querySelector('.pf').classList.contains('pending'),
     '★ 结算后不再是 pending 态');

  // ---- 自动记的买入能被撤销（它是普通的一笔，不是特殊数据） ----
  // 撤销的是小李那笔 200（第 2 行）
  t.click(t.prows()[1].querySelector('[data-act="buyList"]'));
  const delBtn = t.qa('[data-act="buyDel"]')[0];
  ok(!!delBtn, '自动记的买入在明细里可看到、可撤销');
  t.click(delBtn);
  eq(t.tbText(1), '—', '★ 自动记的那笔可撤销（不是不可动的隐藏数据）');
  eq(t.rebuyLabel(1), '', '撤销后笔数角标消失');

  // ---- 落盘检查 ----
  // 注意：保存时本局买入格子里是 300（上面最后设过），所以落盘 30000。
  t.click(t.$('btnSaveGame'));
  const g = t.raw().ledgers[0].games[0];
  eq(g.buyDefault, 30000, '★ 本局买入按分落盘（300 → 30000）');

  const mWang = g.entries.find(e => e.playerName === '老王');
  eq(mWang.buys.length, 0, '老王的买入明细为空（当时留空，没自动记）');
  const mLi = g.entries.find(e => e.playerName === '小李');
  eq(mLi.buys.length, 0, '★ 小李那笔被撤销了，落盘 0 笔');
  const mMin = g.entries.find(e => e.playerName === '阿明');
  eq(mMin.buys.join(','), '30000', '★ 阿明落盘 1 笔 300 的买入（按改后的值）');

  // ---- 编辑旧牌局：本局买入要能读回来 ----
  t.click(t.$('gameList').querySelector('[data-edit]'));
  eq(t.$('inBuyDefault').value, '300', '★ 编辑旧牌局时读回本局买入');
  // 编辑态下已确认的买入进明细、格子留空；新加入的人按本局买入再记一笔
  t.setBuyDefault('300');
  t.click(t.$('btnAddRow'));
  ok(t.$('ovPickPlayer').classList.contains('show'), '编辑态也能打开选人面板');
  t.win.closeSheet('ovPickPlayer');
  t.win.closeSheet('ovGame');

  // ---- 三位小数的本局买入应被拒绝 ----
  t.click(t.$('btnAddGame'));
  t.setBuyDefault('12.345');
  t.pickPlayer('老王');
  eq(t.rebuyLabel(0), '', '★ 本局买入三位小数 → 视为无效，不自动记买入');
  eq(t.tbText(0), '—', '无效本局买入不产生总买入');
  t.win.closeSheet('ovGame');
}

console.log('\n=== 7. 输入校验 ===');
{
  const t = boot();
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  };
  t.click(t.$('btnPlayers'));
  setVal(t.$('inPlayerName'), 'A'); t.click(t.$('btnAddPlayer'));
  setVal(t.$('inPlayerName'), 'B'); t.click(t.$('btnAddPlayer'));
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
  t.click(t.$('btnAddGame'));
  t.pickPlayers(['A', 'B']);   // 新牌局从 0 行开始，先挑两人

  // 三位小数应被拒绝（阻断性错误 -> 红色）
  const buy = t.field(t.prows()[0], 'buy');
  setVal(buy, '1.234');
  ok(t.$('calcHint').textContent.includes('两位小数'), '三位小数被拒绝并提示');
  ok(t.$('calcHint').classList.contains('bad'), '格式错误时提示区标红');

  // 修正格式后：格式问题解除。
  // 注意：此时两人结余都没填 → 都算「未结算」，不参与输赢统计，
  // win = loss = 0 反而是平衡的，所以这里不该有 warn。
  setVal(buy, '1.23');
  ok(!t.$('calcHint').classList.contains('bad'), '格式修正后不再标红');
  ok(!t.$('calcHint').classList.contains('warn'),
     '★ 全都没结算时不算「账目未平」（未结算不是亏损）');

  // 真造一个不平衡：给 A 填结余、B 不填 → A 赢、B 未结算 → 不平衡
  // （若把 B 的空结余当 0，B 会被算成输 1.23，那是错的）
  const balA = t.field(t.prows()[0], 'value');
  setVal(balA, '5');
  ok(t.$('calcHint').classList.contains('warn'), '有人结算且不平 → 橙色提醒');
  ok(t.$('calcHint').textContent.includes('未结算'), '★ 提示区标注还有 N 人未结算');

  /* ---- ★ 未平提示要摊开「赢 / 输 / 差」，不能只给一个孤立差额 ----
   * 只有「差额 ¥300」看不出差在哪：是赢家多赢了，还是输家少输了？
   * 把两侧原值都显示出来，方向与差距同时可见。
   */
  {
    const txt = t.$('calcHint').textContent.replace(/\s+/g, ' ');
    ok(/赢\s*¥/.test(txt), '★ 未平时显示「赢」侧金额');
    ok(/输\s*¥/.test(txt), '★ 未平时显示「输」侧金额');
    ok(/差\s*¥/.test(txt), '★ 未平时显示「差」额');
    ok(txt.includes('未平'), '★ 用「未平」而不是「请检查」（账不平不等于填错）');
    ok(!txt.includes('请检查'), '★ 旧文案「请检查」已移除');
    // 「差 X 未平」是唯一要动手的地方，要单独可定位
    const gap = t.q('#calcHint .sum-gap');
    ok(!!gap, '★ 「差 … 未平」有独立元素可定位');
    ok(gap && gap.textContent.includes('未平'), '该元素文案含「未平」');
  }

  /* ---- ★ 提示条必须排在「静态说明文字」之前 ----
   * 提示条是**动态**的（每改一个数字就变），说明文字是**静态**的（看一次就够）。
   * 以前提示条在 .note 后面，被那一大段说明顶出滚动窗口 ——
   * 填完最后一个人的结余，恰恰看不到「差多少」，等于没提示。
   * jsdom 不做布局，量不了「是否在视野内」，所以这里断言**文档顺序**：
   * 动态信息在静态信息之前，才是正确层级。
   */
  {
    const hint = t.$('calcHint');
    const note = t.q('#ovGame .note');
    const btn = t.$('btnAddRow');
    // compareDocumentPosition 的 FOLLOWING 位 = 4。
    // 不用 Node.DOCUMENT_POSITION_FOLLOWING：Node 全局是在浏览器/jsdom 里，
    // 这段跑在 Node 主进程，直接写数字更稳。
    const FOLLOWING = 4;
    ok(!!note, '录入面板有说明文字块');
    ok(hint && note &&
       (hint.compareDocumentPosition(note) & FOLLOWING) !== 0,
       '★ 提示条在说明文字之前（动态信息排在静态说明前面）');
    ok(hint && btn &&
       (btn.compareDocumentPosition(hint) & FOLLOWING) !== 0,
       '★ 提示条紧跟在「选择人员上场」之后');
  }

  /* ---- ★「差 ¥X 未平」整体不可拆行 ----
   * 拆行后「未平」会孤零零挂到下一行，读起来断。
   * （用 getClientRects().length 在真浏览器里验过：320~430px 均占 1 行。）
   */
  {
    const cssTxt = t.doc.querySelector('style').textContent;
    ok(/\.calc-hint\s+\.sum-gap\s*\{[^}]*white-space:\s*nowrap/.test(cssTxt),
       '★ CSS：「差 X 未平」设了 white-space: nowrap');
  }

  // 两边都填 → 平衡，回到单段「已平衡 · 流水」
  // ★ 只有 A（第 0 行）填了买入 1.23，B 没买入（总买入 0）。
  //   A 结余 5 → 净 +3.77；要平，B 净须 −3.77；B 无买入，故结余 = −3.77。
  setVal(t.field(t.prows()[1], 'value'), '-3.77');
  {
    const txt = t.$('calcHint').textContent.replace(/\s+/g, ' ');
    ok(txt.includes('已平衡'),
       `两边都填好后显示「已平衡」（实际: ${txt}）`);
    ok(!/差\s*¥/.test(txt), '★ 平衡时不再显示「差」段（没有两侧可分）');
    ok(!t.$('calcHint').classList.contains('warn'), '平衡时不再橙色提醒');
  }
  // ★ 这里原来写的是 `ok(!cls.contains('warn') === false, ...)` —— 这是个恒假式：
  //   `!boolean === false` 永远是 false，断言永远失败（之前被别处的状态掩盖了）。
  //   改成真正验证「红 / 橙是两种互斥状态」：格式错时只有 bad、不平时候只有 warn。
  {
    const hint = t.$('calcHint');
    // 当前（已平衡）：两个都没有
    ok(!hint.classList.contains('bad') && !hint.classList.contains('warn'),
       '★ 平衡时既不标红也不标橙');

    // 造格式错 → 只有 bad
    setVal(t.field(t.prows()[0], 'buy'), '1.234');
    ok(hint.classList.contains('bad') && !hint.classList.contains('warn'),
       '★ 格式错：只有 bad，没有 warn（红橙互斥）');

    // 修回格式，并破坏平衡（把 B 的结余从 −3.77 改成 0）→ 只有 warn
    setVal(t.field(t.prows()[0], 'buy'), '1.23');
    setVal(t.field(t.prows()[1], 'value'), '0');
    ok(hint.classList.contains('warn') && !hint.classList.contains('bad'),
       '★ 账不平：只有 warn，没有 bad（红橙互斥）');
  }

  // 删除一行后只剩 1 人 -> 不平衡
  t.qa('.prow')[1].querySelector('.del').dispatchEvent(
    new t.win.MouseEvent('click', { bubbles: true }));
  eq(t.qa('.prow').length, 1, '删除行后剩 1 行');

  // 账目不平时仍允许保存（真实场景：先记下来，回头再补）
  eq(t.$('btnSaveGame').disabled, false, '账目不平时保存按钮仍可用');
}

console.log('\n=== 7. 账本管理与切换 ===');
{
  const t = boot();
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  };
  // 账本 A 加人
  t.click(t.$('btnPlayers'));
  setVal(t.$('inPlayerName'), '老王'); t.click(t.$('btnAddPlayer'));
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
  t.click(t.$('btnAddGame'));
  t.pickPlayer('老王');   // 新牌局从 0 行开始
  t.qa('.prow').forEach(row => {
    const buy = t.field(row, 'buy'), val = t.field(row, 'value');
    setVal(buy, '100'); setVal(val, '100');
  });
  t.click(t.$('btnSaveGame'));
  eq(t.qa('.game').length, 1, '账本 A 有 1 场牌局');

  // 新建账本 B
  t.win.prompt = () => '另一批人';
  t.click(t.$('btnLedgers'));
  ok(t.$('ovLedgers').classList.contains('show'), '账本弹窗打开');
  t.click(t.$('btnNewLedger'));
  eq(t.$('ledgerSelect').options.length, 2, '现在有 2 个账本');
  ok(t.$('ledgerSelect').options[1].text.includes('另一批人'), '新账本名为「另一批人」');

  // 账本 B 应为空（数据隔离）
  eq(t.qa('.game').length, 0, '新账本无牌局记录（数据隔离）');
  ok(t.$('rankList').textContent.includes('还没有排行'), '新账本排行榜为空');
  eq(t.$('btnAddGame').disabled, true, '新账本无人员，按钮禁用');

  // 切回账本 A
  t.click(t.$('btnLedgers'));
  const itemA = t.qa('[data-ledger]').find(el => el.textContent.includes('默认账本'));
  t.click(itemA);
  eq(t.qa('.game').length, 1, '切回账本 A 后牌局回来了');
  eq(t.$('btnAddGame').disabled, false, '账本 A 人员仍在');

  // 单账本时不显示删除按钮
  t.click(t.$('btnLedgers'));
  ok(t.$('btnDelLedger'), '多账本时显示删除账本按钮');
}

console.log('\n=== 8. 数据持久化与备份 ===');
{
  const t = boot();
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  };
  t.click(t.$('btnPlayers'));
  setVal(t.$('inPlayerName'), '老王'); t.click(t.$('btnAddPlayer'));
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
  t.click(t.$('btnAddGame'));
  t.pickPlayer('老王');   // 新牌局从 0 行开始
  t.qa('.prow').forEach(row => {
    const buy = t.field(row, 'buy'), val = t.field(row, 'value');
    setVal(buy, '50'); setVal(val, '75');
  });
  t.click(t.$('btnSaveGame'));

  // 落盘检查：金额以「分」为整数存储
  const saved = t.raw();
  const g = saved.ledgers[0].games[0];
  eq(g.entries[0].buys.join(','), '5000', '买入以分存储 [5000]');
  eq(g.entries[0].balance, 7500, '结余以分存储 7500');
  // 盈亏是派生值（结余 − 总买入），不入库；由 normalizeEntry 还原
  ok(!('netProfit' in g.entries[0]), '盈亏是派生值，不入库');
  ok(!('totalBuy' in g.entries[0]), '总买入是派生值，不入库');
  ok(!('buyIn' in g.entries[0]), '旧字段 buyIn 不再入库');
  ok(!('rebuys' in g.entries[0]), '旧字段 rebuys 不再入库');

  // 导出
  t.click(t.$('btnData'));
  ok(t.$('ovData').classList.contains('show'), '数据弹窗打开');
  let downloaded = null;
  const origCreate = t.doc.createElement.bind(t.doc);
  t.doc.createElement = tag => {
    const el = origCreate(tag);
    if (tag === 'a') el.click = () => { downloaded = el.download; };
    return el;
  };
  t.click(t.$('btnExport'));
  ok(downloaded && downloaded.includes('扑克记分房备份'), '导出文件名正确');
  ok(downloaded && downloaded.endsWith('.json'), '导出为 json 文件');

  // —— v20 新增：Excel 明细 CSV（因为界面改整元显示，得给对账留一条出路）——
  ok(!!t.$('btnExportCsv'), '★ 数据弹窗里有「导出 Excel 明细」按钮');
  let csvBlob = null;
  const origBlob = t.win.Blob;
  t.win.Blob = function (parts, opts) { csvBlob = { text: parts.join(''), opts }; return new origBlob(parts, opts); };
  let csvName = null;
  t.doc.createElement = tag => {
    const el = origCreate(tag);
    if (tag === 'a') el.click = () => { csvName = el.download; };
    return el;
  };
  t.click(t.$('btnExportCsv'));
  ok(csvBlob && /text\/csv/.test(csvBlob.opts.type), '★ 导出的是 CSV');
  ok(csvBlob && csvBlob.text.charCodeAt(0) === 0xFEFF, '★ 带 UTF-8 BOM（否则 Excel 打开中文乱码）');
  ok(!!csvName && /\.csv$/.test(csvName), '★ 文件名为 .csv');
  {
    const rows = csvBlob.text.replace(/^\uFEFF/, '').split('\r\n');
    eq(rows[0], '日期,人员,买入,总买入,结余,净盈亏', '★ CSV 表头正确');
    ok(rows.length > 1, '★ CSV 有数据行');
    // 数值列必须带两位小数（这是对账用的），且不带 ¥（否则 Excel 认成文本）
    const cells = rows[1].split(',');
    ok(/^\d+\.\d\d$/.test(cells[3]), `★ 总买入列是「${cells[3]}」—— 带两位小数、不带 ¥`);
    ok(/^-?\d+\.\d\d$/.test(cells[5]), `★ 净盈亏列是「${cells[5]}」—— 带符号与两位小数`);
    ok(!/¥/.test(csvBlob.text), '★ CSV 里不出现 ¥（让 Excel 识别为数字）');
  }
  t.win.Blob = origBlob;

  // 重新加载验证持久化
  const seedRaw = t.seedRaw();
  const t2 = boot({ 'poker-ledger:v1': seedRaw });
  eq(t2.qa('.game').length, 1, '重载后牌局仍在');
  // ★ 刷新回默认：折叠状态不持久化，重载后两个分区都应回到「收起」
  ok(!t2.$('secRank').classList.contains('open'), '★ 重载后排行榜回到默认收起');
  ok(!t2.$('secGames').classList.contains('open'), '★ 重载后牌局记录回到默认收起');
  // 展开状态是 UI 临时状态，不持久化，所以重载后默认收起（概要仍显示流水）
  ok(!t2.$('gameList').textContent.includes('净盈亏'), '重载后默认收起明细');
  ok(t2.$('gameList').textContent.includes('流水'), '重载后仍显示流水概要');
  ok(t2.$('rankList').textContent.includes('+25.00'), '重载后排行榜净盈亏正确');
  t2.click(t2.q('[data-toggle]'));
  ok(t2.$('gameList').textContent.includes('+25'), '展开后净盈亏正确（整元）');

  // 损坏数据不应崩溃
  const t3 = boot({ 'poker-ledger:v1': '{损坏的 JSON' });
  eq(t3.$('ledgerSelect').options.length, 1, '数据损坏时回退到默认账本');
  ok(t3.$('gameList').textContent.includes('还没有牌局记录'), '数据损坏时显示空状态而非崩溃');

  // 空数据结构不应崩溃
  const t4 = boot({ 'poker-ledger:v1': '{"ledgers":[]}' });
  eq(t4.$('ledgerSelect').options.length, 1, '空账本列表回退到默认账本');

  // 缺字段的旧数据应被补齐
  const t5 = boot({ 'poker-ledger:v1': JSON.stringify({
    version: 1, currentId: 'x',
    ledgers: [{ id: 'x', name: '老数据', createdAt: '', updatedAt: '' }],
  }) });
  eq(t5.$('ledgerSelect').options.length, 1, '缺 players/games 字段的老数据可加载');
  ok(t5.$('gameList').textContent.includes('还没有牌局记录'), '老数据显示空状态');
}

console.log('\n=== 9. 金额边界与大额 ===');
{
  const t = boot();
  const setVal = (el, v) => {
    el.value = v;
    el.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  };
  t.click(t.$('btnPlayers'));
  setVal(t.$('inPlayerName'), 'A'); t.click(t.$('btnAddPlayer'));
  setVal(t.$('inPlayerName'), 'B'); t.click(t.$('btnAddPlayer'));
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
  t.click(t.$('btnAddGame'));
  t.pickPlayers(['A', 'B']);   // 新牌局从 0 行开始
  // 大额 + 角分：A 买入 100000.55 结余 99999.54（输 1.01），B 买入 0 结余 1.01
  t.qa('.prow').forEach((row, i) => {
    const buy = t.field(row, 'buy'), val = t.field(row, 'value');
    setVal(buy, i === 0 ? '100000.55' : '0');
    setVal(val, i === 0 ? '99999.54' : '1.01');
  });
  ok(t.$('calcHint').textContent.includes('已平衡'), '大额角分场景精确平衡');
  t.click(t.$('btnSaveGame'));
  ok(t.$('gameList').textContent.includes('99999.54') || t.$('gameList').textContent.includes('99,999'),
     '大额正确显示');
  ok(!visibleText(t.doc).includes('NaN'), '大额不产生 NaN');
  ok(!visibleText(t.doc).includes('undefined'), '大额不产生 undefined');
  ok(!visibleText(t.doc).includes('Infinity'), '大额不产生 Infinity');
}

console.log('\n=== 10. 渲染健壮性 ===');
{
  const t = boot();
  // 人员名含 HTML 特殊字符，必须被转义而非注入
  t.click(t.$('btnPlayers'));
  const inp = t.$('inPlayerName');
  inp.value = '<img src=x onerror=alert(1)>';
  inp.dispatchEvent(new t.win.Event('input', { bubbles: true }));
  t.click(t.$('btnAddPlayer'));
  eq(t.doc.querySelectorAll('img').length, 0, '恶意姓名未被注入为 HTML');
  ok(t.$('plist').textContent.includes('<img'), '恶意姓名按纯文本显示');
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
  ok(t.$('rankList').textContent.includes('<img'), '排行榜同样转义');

  // 空 ledger 名字不应导致 select 崩溃
  const d = t.raw();
  d.ledgers[0].name = '';
  const t2 = boot({ 'poker-ledger:v1': JSON.stringify(d) });
  ok(t2.$('ledgerSelect').options.length === 1, '空名账本可正常渲染');
}

console.log('\n=== 11. 买入明细（核心：买入是本金，不改结余）===');
{
  const t = boot();
  // 建 3 人，用 data-f 精确填字段
  t.click(t.$('btnPlayers'));
  ['老王', '小李', '阿明'].forEach(n => {
    t.$('inPlayerName').value = n;
    t.$('inPlayerName').dispatchEvent(new t.win.Event('input', { bubbles: true }));
    t.click(t.$('btnAddPlayer'));
  });
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
  t.click(t.$('btnAddGame'));
  t.pickPlayers(['老王', '小李', '阿明']);   // 新牌局从 0 行开始

  // 老王：买入 100（第 1 笔）+ 追加 100 + 追加 50，结余用户自己报 400
  //       => 总买入 250，盈亏 +150
  t.setField(t.prows()[0], 'buy', '100');
  t.buy(0, 100, false, true);   // 第 1 笔 100 已填在格子里，点 + 只做「确认」
  t.buy(0, 100);
  t.buy(0, 50);
  t.setField(t.prows()[0], 'value', '400');
  // 小李：买入 250，结余 100 => 盈亏 -150
  t.fill(t.prows()[1], { buy: '250', value: '100' });
  // 阿明：买入 100，结余 100 => 盈亏 0
  t.fill(t.prows()[2], { buy: '100', value: '100' });

  eq(t.tbText(0), '250', '老王总买入 = 100 + 100 + 50');
  eq(t.rebuyLabel(0), '3', '三笔买入都记上了');

  ok(t.$('calcHint').textContent.includes('已平衡'), '含多笔买入时零和平衡');
  ok(!t.$('calcHint').textContent.includes('总投入'), 'v21：计算区不再显示总投入（各行已有总买入列）');

  t.click(t.$('btnSaveGame'));

  // 落盘：buys 数组必须被持久化
  const g = t.raw().ledgers[0].games[0];
  const wang = g.entries.find(e => e.playerName === '老王');
  ok(Array.isArray(wang.buys), 'buys 是数组');
  eq(wang.buys.join(','), '10000,10000,5000', '落盘 3 笔买入明细（分）');
  eq(wang.balance, 40000, '结余以分存储');
  ok(!('buyIn' in wang), '旧字段 buyIn 不入库');
  ok(!('rebuys' in wang), '旧字段 rebuys 不入库');

  // 盈亏应从明细还原出来：400 - (100+100+50) = +150
  const restored = t.raw().ledgers[0].games[0].entries.find(e => e.playerName === '老王');
  const sum1 = restored.buys.reduce((a, b) => a + b, 0);
  eq(restored.balance - sum1, 15000, '★ 从落盘数据还原盈亏 = +150');

  // 编辑该牌局，再追加 100。结余不动 -> 盈亏随总买入变化，但「已报的结余」没被动过
  t.click(t.q('[data-edit]'));
  eq(t.rebuyLabel(0), '3', '编辑时买入明细被正确载入（3 笔全在明细里，格子是空的）');
  eq(t.fieldIn(0, 'buy'), '', '★ 编辑时格子留空，避免和已有明细打架');
  eq(t.tbText(0), '250', '编辑时总买入正确还原');
  eq(t.fieldIn(0, 'value'), '400', '编辑时结余正确还原');

  t.buy(0, 100);
  eq(t.rebuyLabel(0), '4', '编辑时追加第 4 笔');
  eq(t.fieldIn(0, 'value'), '400', '★ 追加不改结余（用户没说过结余变了）');
  eq(t.pfText(0), '+50', '★ 追加后盈亏 = 400 − 350');

  t.click(t.$('btnSaveGame'));
  const wang2 = t.raw().ledgers[0].games[0].entries.find(e => e.playerName === '老王');
  eq(wang2.buys.length, 4, '四笔买入都落盘');
  eq(wang2.buys.join(','), '10000,10000,5000,10000', '四笔按发生顺序落盘');
  eq(wang2.balance, 40000, '★ 结余仍是用户报的 400，没被买入推走');

  // 明细表：买入列 + 总买入列（不再有「补买」这个概念）
  ok(t.$('gameList').textContent.includes('总买入'), '明细表含总买入列');
  ok(!t.$('gameList').textContent.includes('补买'), '★ 界面已无「补买」字样');

  // 排行榜：投入 + 输赢（不再标注含补买）
  ok(t.$('rankList').textContent.includes('投入'), '排行榜显示投入');
  ok(!t.$('rankList').textContent.includes('含补买'), '★ 排行榜已无「含补买」字样');
}

console.log('\n=== 12. 旧数据兼容与迁移 ===');
{
  // 三种历史数据的形态都要能读：
  //   g1 — v1 远古版：连 rebuy 都没有
  //   g2 — v2 版：rebuy 是标量总额（要迁移成明细）
  //   g3 — v3 版：rebuys 已是数组（原样保留）
  const legacy = {
    version: 1, currentId: 'L1',
    ledgers: [{
      id: 'L1', name: '旧账本', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      players: [
        { id: 'p1', name: '老王' },
        { id: 'p2', name: '小李' },
      ],
      games: [
        {
          id: 'g1', date: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z',
          entries: [
            { playerId: 'p1', playerName: '老王', buyIn: 10000, balance: 30000, netProfit: 20000 },
            { playerId: 'p2', playerName: '小李', buyIn: 30000, balance: 10000, netProfit: -20000 },
          ],
        },
        {
          id: 'g2', date: '2026-01-02', createdAt: '2026-01-02T00:00:00.000Z',
          entries: [
            // 标量 rebuy 150：迁移后应变成 rebuys:[15000]，盈亏仍 +150
            { playerId: 'p1', playerName: '老王', buyIn: 10000, rebuy: 15000, balance: 40000, netProfit: 15000 },
            { playerId: 'p2', playerName: '小李', buyIn: 40000, rebuy: 0, balance: 25000, netProfit: -15000 },
          ],
        },
        {
          id: 'g3', date: '2026-01-03', createdAt: '2026-01-03T00:00:00.000Z',
          entries: [
            { playerId: 'p1', playerName: '老王', buyIn: 10000, rebuys: [10000, 5000], balance: 40000 },
            { playerId: 'p2', playerName: '小李', buyIn: 40000, rebuys: [], balance: 25000 },
          ],
        },
      ],
    }],
  };
  const t = boot({ 'poker-ledger:v1': JSON.stringify(legacy) });

  eq(t.qa('.game').length, 3, '三种历史数据都能正常加载');
  // 排行榜用 fmtCompact，整数不显示 .00
  ok(t.$('rankList').textContent.includes('+500'), '旧数据排行榜正确（老王累计 +500）');
  ok(t.$('stats').textContent.includes('3'), '统计显示 3 场');

  // 三种形态的盈亏都应算对：g1 +200, g2 +150, g3 +150 -> 老王累计 +500
  ok(t.$('rankList').textContent.includes('+500'), '★ 三种数据形态的盈亏汇总正确（+500）');

  // 展开明细，检查渲染（每点一次都会重渲染，必须按 id 重新取节点）
  for (const id of ['g1', 'g2', 'g3']) {
    const tg = t.qa('[data-toggle]').find(b => b.dataset.toggle === id);
    if (tg) t.click(tg);
  }
  const body = t.$('gameList').textContent;
  ok(!body.includes('undefined'), '旧数据渲染无 undefined');
  ok(!body.includes('NaN'), '旧数据渲染无 NaN');
  ok(body.includes('总买入'), '明细表有总买入列');
  ok(body.includes('已平衡'), '展开后三场都显示已平衡');
  eq(t.qa('#settleSection').length, 0, '结算方案区块已彻底移除');

  // 编辑 g2（标量 rebuy 的那场），迁移后应把「起始买入」和「追加」合成两条明细
  // 展开后编辑按钮才可见；用牌局 id 定位而不是位置索引
  const edit2 = t.qa('[data-edit]').find(b => b.dataset.edit === 'g2');
  ok(!!edit2, '找到 g2 的编辑按钮');
  t.click(edit2);
  // ★ 迁移链：buyIn:100 + 标量 rebuy:150
  //   → buys = [10000, 15000]（起始买入成为第 1 笔，标量追加成第 2 笔）
  //   总额 250 与盈亏 +150 都不变，只是从「一个总数」还原成「两笔」
  eq(t.rebuyLabel(0), '2', '★ 迁移后明细 = 2 笔（起始买入 100 + 追加 150）');
  eq(t.tbText(0), '250', '★ 迁移后总买入 = 100 + 150');
  eq(t.pfText(0), '+150', '★ 迁移后盈亏不变 +150');
  t.click(t.$('btnSaveGame'));   // 必须保存；直接关弹窗不会写回

  // 存回去后，入库形态应统一成 buys 数组，且不含旧字段与派生字段
  const saved = t.raw().ledgers[0];
  const g2 = saved.games.find(g => g.id === 'g2');
  const e1 = g2.entries.find(e => e.playerName === '老王');
  ok(Array.isArray(e1.buys), '存回后 buys 是数组');
  eq(e1.buys.length, 2, '起始买入 + 标量追加 = 2 笔明细');
  eq(e1.buys.join(','), '10000,15000', '金额无损、按发生顺序');
  ok(!('buyIn' in e1), '旧字段 buyIn 不入库');
  ok(!('rebuy' in e1), '旧字段 rebuy 不入库');
  ok(!('rebuys' in e1), '旧字段 rebuys 不入库');
  ok(!('totalBuy' in e1), '派生字段 totalBuy 不入库');
  ok(!('netProfit' in e1), '派生字段 netProfit 不入库');
}

/* ============================================================
   13. 行布局：七列必须放得进手机屏（防止再次横向溢出）
   ------------------------------------------------------------
   纯布局问题 jsdom 量不出来（它不算样式），所以这里改为直接
   解析 CSS 源码：把每个断点的列宽取出来，按断点宽度算总宽，
   断言不超过可用宽度。这样「把列写宽了」会被测试立刻拦住。
   ============================================================ */
console.log('\n=== 13. 行布局：列宽预算 ===');

/** 把一段 grid-template-columns 的 px 值解析成数组 */
function parseCols(str) {
  const m = String(str).match(/grid-template-columns:\s*([^;]+);/);
  if (!m) return null;
  return m[1].trim().split(/\s+/).map(v => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  });
}

/** 取某个 media query 块内的 .prow 列宽（minmax 取它的最小值） */
function colsInMedia(css, query) {
  const i = css.indexOf(query);
  ok(i >= 0, `找到断点 ${query}`);
  if (i < 0) return null;
  // 从断点起往后找 .prow { ... grid-template-columns ... }
  const seg = css.slice(i, i + 1600);
  const m = seg.match(/\.prow\s*,\s*\.prow-head\s*\{[^}]*grid-template-columns:\s*([^;]+);/);
  if (!m) return null;
  // minmax(60px, 1.4fr) → 取 60；其余 npx → n
  return m[1].trim().split(/\s+(?![^(]*\))/).map(v => {
    const mm = v.match(/minmax\(\s*([\d.]+)px/);
    return mm ? parseFloat(mm[1]) : parseFloat(v);
  });
}

const cssSrc = html.match(/<style>([\s\S]*?)<\/style>/)[1];

// —— 默认（桌面弹窗）——
{
  const m = cssSrc.match(/\.prow\s*\{[^}]*grid-template-columns:\s*([^;]+);/);
  ok(!!m, '默认断点取到列宽');
  const raw = m[1].trim().replace(/\s+/g, ' ');
  // 按顶层空格切分，minmax(...) 内部的逗号空格不能算分隔符
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of raw) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) { if (cur) parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  eq(parts.length, 6, '默认断点是 6 列（人员/买入/总买入/结余/盈亏/删除）');

  // 只有「人员」列允许弹性，且必须带 minmax 上限，防止宽屏下把别的列挤没
  ok(/minmax\(/.test(parts[0]), '★ 人员列用 minmax 限幅（不是裸 1fr，避免宽屏吃光空间）');
  const rest = parts.slice(1);
  ok(rest.every(p => /^\d+px$/.test(p)), '其余 5 列都是固定 px');

  const fixed = rest.reduce((a, p) => a + parseFloat(p), 0);
  const minPeople = parseFloat(raw.match(/minmax\((\d+)px/)[1]);
  const gapM = cssSrc.match(/\.prow\s*\{[^}]*gap:\s*(\d+)px[^}]*\}/);
  const gap = gapM ? Number(gapM[1]) : 0;

  // 最窄桌面：561px 视口 − overlay 左右 20×2 − sheet-body 左右 18×2
  const availMin = 561 - 40 - 36;
  const needMin = fixed + minPeople + gap * 5;
  ok(needMin <= availMin,
    `★ 最窄桌面不溢出：列和 ${needMin}px ≤ ${availMin}px（561px 视口）`);

  // 最宽桌面：sheet 上限 640px − body 左右 36px
  const availMax = 640 - 36;
  const needMaxFixed = fixed + minPeople + gap * 5;
  ok(needMaxFixed <= availMax,
    `宽屏也能铺下：固定部分 ${needMaxFixed}px ≤ ${availMax}px`);

  // 买入列要够放「输入框 + 按钮」
  ok(parseFloat(rest[0]) >= 80, `桌面买入列 ${rest[0]} 够放输入框 + 按钮`);
}

// —— ≤480px 断点（手机）：也是 6 列 ——
{
  const cols = colsInMedia(cssSrc, '@media (max-width: 480px)');
  ok(!!cols && cols.length === 6, '★ 480 断点是 6 列');
  const total = cols.reduce((a, b) => a + b, 0) + 3 * 5;
  // 390px 屏 − 12px×2 内边距 = 366px
  const avail = 390 - 24;
  ok(total <= avail, `★ 390px 屏不溢出：列和 ${total}px ≤ ${avail}px`);
  // 买入列（第 2 个）要塞得下输入框 + 内嵌 + 按钮
  ok(cols[1] >= 60, `买入列 ${cols[1]}px 够放输入框 + 按钮`);

  // 起始买入列必须真的被隐藏，而不是仅靠列数变化
  ok(!/input\[data-f="buyIn"\]/.test(cssSrc),
    '★ 不再有「起始买入」输入框（已合并进「买入」）');
  ok(!/\.prow-head\s*>\s*div:nth-child\(3\)/.test(cssSrc.replace(/\s+/g, ' ')),
    '★ 不再靠隐藏第 3 列来腾宽度（6 列本身够窄）');
}

// —— ≤380px 断点（小屏）——
{
  const cols = colsInMedia(cssSrc, '@media (max-width: 380px)');
  ok(!!cols && cols.length === 6, '380 断点是 6 列（人员/买入/总买入/结余/盈亏/删除）');
  const total = cols.reduce((a, b) => a + b, 0) + 2 * 5;
  // ★ 这一档只对 360~380px 负责 —— 320px 由下面 ≤340px 那一档单独兜
  //   （380 这套列需求 301px，320px 只有 296px 可用，物理上放不下）。
  //   历史教训：原来只卡 360px，320px 溢出 21px 一直没被发现，
  //   结果浏览器去挤人员列，表现成「名字被压扁」。
  const avail360 = 360 - 24;   // 336
  ok(total <= avail360, `★ 360px 屏不溢出：列和 ${total}px ≤ ${avail360}px`);
  // v20 起买入框能吃下 4 位数：80 − 4 − 32 = 44px ≥ 「10000」43px
  ok(cols[1] >= 80, `★ 小屏买入列 ${cols[1]}px ≥ 80（文字 44px，够写「10000」）`);
  // ★ v20：这两列改整元显示后需求大降（实测 12px 字号下
  //   「20000」34px + 8 角标槽 = 42；「+20000」42），
  //   断言跟着改成整元下限 —— 别再拿带小数的老数字卡，那会锁死省下来的空间。
  ok(cols[2] >= 42, `★ 小屏总买入列 ${cols[2]}px ≥ 42（整元「20000」34 + 8 角标槽）`);
  ok(cols[4] >= 42, `★ 小屏盈亏列 ${cols[4]}px ≥ 42（整元「+20000」需要 42px）`);
  // 结余列要放 4 位数「1200」(35px) + 内边距
  ok(cols[3] >= 45, `★ 小屏结余列 ${cols[3]}px ≥ 45（4 位数 1200 需要 35px + 内边距）`);
  // 人员列：3 字名 49px + 左内边距 3 + 自绘箭头 10
  ok(cols[0] >= 54, `★ 小屏人员列 ${cols[0]}px ≥ 54（3 字名 + 自绘箭头）`);
}

// —— ≤340px 断点（极窄屏，实际就是 320px）——
{
  const cols = colsInMedia(cssSrc, '@media (max-width: 340px)');
  ok(!!cols && cols.length === 6, '★ 340 断点存在且是 6 列（320px 单独一档）');
  const total = cols.reduce((a, b) => a + b, 0) + 2 * 5;
  const avail320 = 320 - 24;   // 296
  ok(total <= avail320, `★ 320px 屏不溢出：列和 ${total}px ≤ ${avail320}px`);
  // ★ v20 前：320px 是唯一必须做减法的档，只保 3 位数。
  //   v20 去掉两位小数后腾出 25px，**320px 也能写 4 位数了** ——
  //   断言相应上调，把这来之不易的空间**锁死**，防止以后又被人改回去。
  ok(cols[1] >= 72,
     `★ 320px 买入列 ${cols[1]}px ≥ 72（文字 38px，够写「1000」35px）`);
  ok(cols[2] >= 42, `★ 320px 总买入列 ${cols[2]}px ≥ 42（整元「20000」34 + 8 角标槽）`);
  ok(cols[4] >= 42, `★ 320px 盈亏列 ${cols[4]}px ≥ 42（整元「+20000」42px）`);
  // 结余：48 − 6 内边距 = 42px ≥ 「1200」35px
  ok(cols[3] >= 48,
     `★ 320px 结余列 ${cols[3]}px ≥ 48（可写 42px，够写 4 位数「1200」）`);
}

// —— v20：总买入 / 盈亏 改「整元显示」（去掉两位小数）换宽度 ——
{
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  ok(/function fmtYuan\s*\(/.test(js), '★ 新增 fmtYuan（整元显示）');
  ok(/function fmtSignedYuan\s*\(/.test(js), '★ 新增 fmtSignedYuan（带符号整元）');

  // 取整规则：四舍五入，且对负数对称（−150.50 → −151，不是 −150）
  ok(/Math\.round\(Math\.abs\(/.test(js),
     '★ fmtYuan 用 Math.round(abs/100) —— 负数也对称取整');

  // ★ 这两列是唯一走 fmtYuan 的地方
  ok(/txt = fmtYuan\(totalBuy\)/.test(js), '★ 总买入列走 fmtYuan');
  ok(/cell\.textContent = fmtSignedYuan\(profit\)/.test(js), '★ 盈亏列走 fmtSignedYuan');

  // ★ 反过来：结算/零和/存档**不能**受影响 —— 它们仍用 fmtCents
  ok(/差 ¥\$\{fmtCents\(/.test(js), '★ 未平提示仍用 fmtCents（判定走精确分）');
  ok(/已平衡 · 流水 ¥\$\{fmtCents\(/.test(js), '★ 平衡提示仍用 fmtCents');
  ok(!/总投入 <b class="num">/.test(js), '★ 总投入渲染已从计算区移除（fmtCents 仍守结算）');

  // ★ 整元化后省下的宽度必须真的分给了买入框，而不是凭空消失
  //   （具体列宽由上面 380 / 340 两档的断言卡住）
  ok(/\.rbc-in input \{ padding-left: 4px !important; padding-right: 30px !important; \}/.test(cssSrc),
     '★ 320px 档买入框右内边距仍收到 30px（把省下的宽度让给文字）');
}

// —— 防缩放：viewport + CSS 字号 + JS 兜底 ——
{
  // ① viewport 必须禁掉缩放
  const vp = html.match(/<meta name="viewport" content="([^"]+)"/)[1];
  ok(/maximum-scale=1/.test(vp), '★ viewport 含 maximum-scale=1');
  ok(/user-scalable=no/.test(vp), '★ viewport 含 user-scalable=no');

  // ② 所有真输入框字号必须 ≥16px，否则 iOS 聚焦仍会强制放大整页
  const inputRule = cssSrc.match(/\.prow select,\s*\.prow input\s*\{[^}]*\}/)[0];
  const fs = parseFloat(inputRule.match(/font-size:\s*([\d.]+)px/)[1]);
  ok(fs >= 16, `★ 输入框字号 ${fs}px ≥ 16px（iOS 聚焦不放大）`);

  // 媒体查询里不能再把输入框字号压到 16px 以下
  const mobileBlocks = cssSrc.match(/@media \(max-width: 480px\)[\s\S]*?\n  \}/)[0];
  const tooSmall = /font-size:\s*1[0-5](\.\d)?px/.test(
    (mobileBlocks.match(/\.prow select,[^}]*\}/) || [''])[0]);
  ok(!tooSmall, '★ 手机断点未把输入框字号压到 16px 以下');

  // ③ JS 兜底：iOS 忽略 user-scalable=no，必须拦住 gesturestart 与双击
  ok(/gesturestart/.test(html), '★ JS 拦了 gesturestart（iOS 双指缩放）');
  ok(/lastTouch/.test(html) && /300/.test(html), '★ JS 拦了 300ms 内双击放大');
}

// —— DOM 结构：买入格 = [输入框 + + 按钮] 上行、[明细开关] 下行 ——
{
  const seed = {
    version: 1,
    currentId: 'L1',
    ledgers: [{
      id: 'L1', name: '默认账本',
      players: [{ id: 'p1', name: '阿强' }],
      games: [], createdAt: '', updatedAt: '',
    }],
  };
  const t = boot({ 'poker-ledger:v1': JSON.stringify(seed) });
  t.click(t.$('btnAddGame'));
  t.pickPlayer('阿强');   // 新牌局从 0 行开始

  const cell = t.prows()[0].querySelector('.rbc');
  ok(!!cell, '买入格存在');
  ok(!!cell.querySelector('.rbc-in input[data-f="buy"]'), '买入格内有输入框');
  ok(!!cell.querySelector('.rbb[data-act="buy"]'), '买入格内有 + 按钮');
  // ★ 买入格里**不再**有明细开关 —— 它已经挪到「总买入」那一格
  ok(!cell.querySelector('.rbl'), '买入格里没有明细开关（已挪走）');
  ok(!cell.querySelector('.rbc > button:not(.rbb)'), '买入格里只有输入框和 + 按钮（单行）');

  /* ---- ★ 明细入口 = 「总买入」那一格 ----
   * 演进过程（每一步都踩了坑，记下来免得再走回头路）：
   *   ① 13×13px 小角标压在输入框右上角 → 手机点不中，且没有成长空间（放大就盖住数字）
   *   ② 挪到输入框下方独立成行 → 点得到了，但每行被撑成两行，看着很乱
   *   ③ 最终：挂在「总买入」上 —— 「总买入 = 各笔之和」，点汇总看构成最自然，
   *      而且它有整个单元格那么大（58~62 × 37~41px），行高也回到单行。
   */
  {
    const cssTxt2 = t.doc.querySelector('style').textContent;
    // .rbl 这一族已经删干净
    ok(!/\.rbl\b/.test(cssTxt2), '★ 旧的 .rbl 明细开关样式已彻底移除');
    ok(!/rbl-caret/.test(cssTxt2), '★ 旧的 rbl-caret 箭头已彻底移除');
    ok(!/tb-caret/.test(cssTxt2), '★ 展开箭头已彻底移除（窄屏放不下，靠底边实线表达展开）');
    // .tb 变成按钮
    const tbRule = cssTxt2.match(/\.tb\s*\{[^}]*\}/)[0];
    ok(/cursor:\s*pointer/.test(tbRule), '★ .tb 是 cursor:pointer（可点）');
    // ★ 不能用 flex：角标要绝对定位叠在数字右上角，横向不能占位 ——
    //   总买入列在窄屏只有 58px，「400.00 + 角标 + 箭头」并排会把数字截成「400...」。
    ok(/position:\s*relative/.test(tbRule), '★ .tb 是相对定位容器（角标绝对定位挂在它身上）');
    ok(!/display:\s*flex/.test(tbRule), '★ .tb 不用 flex（角标不占横向空间才能不截断数字）');
    ok(/font-family:\s*inherit/.test(tbRule) && /border:\s*none/.test(tbRule),
       '★ .tb 作为 button 重置了浏览器默认外观');
    // ★ 角标必须是「绝对定位的上标」—— 只有这样它才不占横向空间，
    //   62px 的列才装得下完整的 400.00 而不被截断。
    const badgeRule = cssTxt2.match(/\.tb-badge\s*\{[^}]*\}/)[0];
    ok(/position:\s*absolute/.test(badgeRule), '★ 笔数角标是绝对定位（不占横向空间）');
    ok(/top:\s*-3px/.test(badgeRule) && /right:\s*0/.test(badgeRule),
      '★ 笔数角标贴在右上角且整体上提 3px（实测不压数字：数字 y[364,380] vs 角标 y[351,362]）');
    ok(/pointer-events:\s*none/.test(badgeRule),
      '★ 笔数角标 pointer-events:none（点击穿透到 .tb）');
    const numRule = cssTxt2.match(/\.tb-num\s*\{[^}]*\}/)[0];
    // ★ 让位宽度必须是 8px 而不是 14px —— 踩过两次坑：
    //   14px → 窄屏 58−14=44 < 数字需要的 47 → ellipsis 自己把数字截断
    //   0px  → 角标与数字末位重叠 4~6×3~4px
    //   8px  → 58−0(tb右内边距)−8 = 50 ≥ 47 ✓ 既不截断也不重叠
    ok(/padding-right:\s*8px/.test(numRule), '★ .tb-num 右留 8px（刚好等于角标宽，不多不少）');
    ok(!/padding-right:\s*14px/.test(numRule), '★ 不再用 14px 让位（那会把数字挤成省略号）');
    ok(/text-overflow:\s*ellipsis/.test(numRule), '★ .tb-num 超长才省略（正常不该触发）');
    // .tb 右内边距必须为 0：把那 4px 还给数字（见 .tb-num 说明）
    ok(/padding:\s*9px 0 9px 0/.test(tbRule), '★ .tb 右内边距归零，4px 让给数字');
  }

  // 还没记过买入：不可点，也没有角标
  {
    const tb0 = t.prows()[0].querySelector('[data-tb]');
    ok(!tb0.dataset.act, '★ 没记过买入时总买入格不可点（没有 data-act）');
    ok(!tb0.hasAttribute('aria-expanded'), '★ 没记过买入时没有 aria-expanded');
    ok(!tb0.querySelector('.tb-badge'), '★ 没记过买入时不显示笔数角标');
    ok(!tb0.querySelector('.tb-caret'), '★ 没记过买入时不显示展开箭头');
    eq(t.tbText(0), '—', '没记过买入时总买入显示占位「—」');
  }

  // 记一笔：总买入格变成可点入口，出现角标 1 和箭头
  t.setField(t.prows()[0], 'buy', '50');
  t.click(t.prows()[0].querySelector('[data-act="buy"]'));
  {
    const tb1 = t.prows()[0].querySelector('[data-tb]');
    eq(tb1.dataset.act, 'buyList', '★ 记过买入后总买入格成为明细入口');
    eq(tb1.getAttribute('aria-expanded'), 'false', '未展开时 aria-expanded=false');
    const badge = tb1.querySelector('.tb-badge');
    ok(!!badge, '★ 出现笔数角标');
    eq(badge.textContent.trim(), '1', '角标显示 1');
    // ★ 角标必须是纯信息，不是可点元素 —— 否则又变成「小得点不中」的老问题
    ok(badge.tagName !== 'BUTTON', '★ 笔数角标不是按钮（纯信息，不可点）');
    ok(!badge.dataset.act, '★ 笔数角标没有 data-act（点击穿透到父级 .tb）');
    eq(t.tbText(0), '50', '总买入数字与角标互不干扰（只读 .tb-num 拿到纯数字）');
  }

  // 展开明细：aria-expanded 翻转（CSS 靠它旋转箭头 + 高亮底边）
  t.click(t.prows()[0].querySelector('[data-tb]'));
  {
    const tb2 = t.prows()[0].querySelector('[data-tb]');
    eq(tb2.getAttribute('aria-expanded'), 'true', '★ 展开后 aria-expanded=true');
    ok(!!t.prows()[0].querySelector('.rbd'), '展开后出现明细面板');
    // 再点一次收起
    t.click(tb2);
    const tb3 = t.prows()[0].querySelector('[data-tb]');
    eq(tb3.getAttribute('aria-expanded'), 'false', '★ 再点一次收起');
    ok(!t.prows()[0].querySelector('.rbd'), '收起后明细面板消失');
  }

  /* ---- ★ 行高必须回到单行 ----
   * jsdom 不做布局，量不了真实高度，所以断言驱动布局的 CSS：
   * 所有单元格都在 grid-row 1，只有明细面板另起第 2 行。
   */
  {
    const cssTxt3 = t.doc.querySelector('style').textContent;
    ok(/\.prow\s*>\s*\*\s*\{[^}]*grid-row:\s*1\s*;/.test(cssTxt3),
       '★ 所有单元格回到第 1 行（单行布局）');
    ok(/\.rbd\s*\{[^}]*grid-row:\s*2/.test(cssTxt3),
       '★ 明细面板另起第 2 行（展开时才占位）');
    ok(!/grid-row:\s*1\s*\/\s*3/.test(cssTxt3),
       '★ 不再有跨两行的网格布局（那是方案 C 的两行来源）');
  }

  // + 按钮：深色主题下必须是「实心主色 + 深色文字」。
  // 注意：浅色半透明底在深色输入框上会糊成一团，看着像乱码 —— 所以不能再退回 --primary-soft。
  const rbbRule = cssSrc.match(/\.rbb\s*\{[^}]*\}/)[0];
  ok(/background:\s*var\(--primary\)/.test(rbbRule), '★ + 按钮用实心主色（深色主题下不能是半透明浅色）');
  ok(/color:\s*var\(--primary-ink\)/.test(rbbRule), '★ + 按钮文字用 primary-ink（对比度 6.94 ✓）');
  /* ---- ★ + 按钮也要够大 ----
   * 原来 17×24px，挤在 22px 的右侧内边距里，拇指很难独立命中。
   * 现在 30×28 + 透明热区外扩（实际约 40×44）。
   */
  ok(/width:\s*30px/.test(rbbRule), '★ + 按钮宽 30px（原 17px，太窄点不中）');
  ok(/height:\s*28px/.test(rbbRule), '★ + 按钮高 28px（原 24px）');
  ok(/\.rbb::after\s*\{[^}]*left:\s*-8px/.test(cssSrc),
     '★ + 按钮有透明热区外扩');
  // 输入框右侧必须给 + 按钮让位，否则数字会钻到按钮下面
  const rbcIn = cssSrc.match(/\.rbc-in input\s*\{[^}]*\}/)[0];
  const padRight = parseFloat(rbcIn.match(/padding-right:\s*([\d.]+)px/)[1]);
  const rbbW = parseFloat(rbbRule.match(/width:\s*([\d.]+)px/)[1]);
  ok(padRight > rbbW, `★ 输入框右内边距 ${padRight}px > 按钮宽 ${rbbW}px（文字不压按钮）`);
}

console.log('\n=== 14. 深色主题：色板与对比度 ===');

{
  const t = boot();
  const css = t.css();

  // 取 :root 里的变量
  const rootBlock = css.match(/:root\s*\{[^}]*\}/)[0];
  const tok = name => {
    const m = rootBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`));
    return m ? m[1] : null;
  };

  // 必须是深色主题
  const bg = tok('bg');
  ok(!!bg, '定义了 --bg');
  const bgLum = relLum(bg);
  ok(bgLum < 0.05, `★ 页面底色是深色（相对亮度 ${bgLum.toFixed(3)} < 0.05）`);

  // ★ 中国习惯：红=赢、绿=输。参考页是绿=赢（欧美），这里必须反过来。
  const win = tok('win'), lose = tok('lose');
  const winIsRed = /^#[fF]/.test(win) || hexR(win) > hexB(win) * 1.6;
  ok(winIsRed, `★ --win 是红色系（${win}）— 中国习惯红=赢`);
  ok(hexG(lose) > hexR(lose) * 1.6, `★ --lose 是绿色系（${lose}）— 中国习惯绿=输`);

  // 对比度硬门槛（正文 4.5、大字 3.0）
  const pairs = [
    ['text', 'card', 4.5, '正文 on 卡片'],
    ['text', 'bg', 4.5, '正文 on 页面底色'],
    ['muted', 'card', 4.5, '弱化文字 on 卡片'],
    ['primary', 'card', 4.5, '主色数字 on 卡片'],
    ['win', 'card', 4.5, '赢（红）on 卡片'],
    ['lose', 'card', 4.5, '输（绿）on 卡片'],
    ['gold', 'card', 3.0, '金色角标 on 卡片'],
    ['primary-ink', 'primary', 4.5, '主按钮文字 on 主色'],
    ['gold-ink', 'gold', 4.5, '金色上的文字'],
  ];
  for (const [fg, bgn, min, label] of pairs) {
    const v = contrast(tok(fg), tok(bgn));
    ok(v >= min, `★ ${label} 对比度 ${v.toFixed(2)} ≥ ${min}`);
  }

  // 参考页的蓝底白字只有 2.72（不合格），我们改用了深色字
  const onBlue = contrast('#ffffff', tok('primary'));
  const inkOnBlue = contrast(tok('primary-ink'), tok('primary'));
  ok(onBlue < 4.5, `记录：白字压主色只有 ${onBlue.toFixed(2)}，不合格（参考页就是这么做的，我们没抄）`);
  ok(inkOnBlue >= 4.5, `★ 深色字压主色 ${inkOnBlue.toFixed(2)}，达标（替代白字方案）`);

  // 主色必须是蓝色系（参考页的 --blue 是 #5b9dff）
  ok(hexB(tok('primary')) > hexR(tok('primary')), `主色是蓝色系（${tok('primary')}）`);

  // 柱子不能贴顶（贴顶会像骨架屏）
  ok(/f \/ max \* 35/.test(t.html()), '★ 柱状图最高只占容器 35/40 高（不贴顶）');

  /* ---------- 顶栏：必须和全站同一套冷色，不能再留墨绿 ---------- */
  // 历史：顶栏原来是墨绿渐变（--felt），呼应扑克桌。
  // 但整站在深色化后变成冷蓝灰体系，留一块绿等于两个色系硬拼，
  // 视觉上像两个 App 缝在一起。改成「同色系更深」+ 底边主色细线。
  const topbar = css.match(/\.topbar\s*\{[^}]*\}/)[0];
  ok(!/--felt/.test(css), '★ --felt 墨绿变量已彻底移除');
  ok(!/--felt/.test(topbar), '★ 顶栏不再引用 --felt');
  ok(/background:\s*var\(--topbar\)/.test(topbar), '★ 顶栏底色改用 --topbar（同色系）');

  const top = tok('topbar');
  ok(!!top, '定义了 --topbar');
  // 顶栏必须比页面底色更深（滚动时能压住下方内容），而不是靠色相拉开
  ok(relLum(top) < bgLum, `★ 顶栏比页面底色更深（${relLum(top).toFixed(4)} < ${bgLum.toFixed(4)}）`);
  // 且仍是中性深色（RGB 三通道接近，不带明显色相）——
  // 这是「不再有绿色块」的量化判据：max−min 不超过 12
  const tp = hexParts(top);
  const spread = Math.max(...tp) - Math.min(...tp);
  ok(spread <= 12, `★ 顶栏是中性深色（通道极差 ${spread} ≤ 12，没有残留色相）`);

  // 顶栏上的文字对比度
  ok(contrast(tok('text'), top) >= 4.5,
     `★ 主标题 on 顶栏 对比度 ${contrast(tok('text'), top).toFixed(2)} ≥ 4.5`);
  ok(contrast(tok('muted'), top) >= 4.5,
     `★ 副标题 on 顶栏 对比度 ${contrast(tok('muted'), top).toFixed(2)} ≥ 4.5`);
  // 下拉框/按钮：改成 surface + 描边，不再是白色半透明蒙层
  ok(!/rgba\(255,\s*255,\s*255/.test(css), '★ 顶栏控件不再用白色半透明蒙层（改用 surface + 描边）');
  const sel = css.match(/\.ledger-select\s*\{[^}]*\}/)[0];
  ok(/background:\s*var\(--surface\)/.test(sel), '下拉框底色用 surface');
  ok(/border:\s*1px solid var\(--line\)/.test(sel), '下拉框有 1px 描边（不再是无线框蒙层）');
  // 描边要看得见：与顶栏对比 ≥1.5
  ok(contrast(tok('line'), top) >= 1.5,
     `★ 下拉框描边 on 顶栏 对比度 ${contrast(tok('line'), top).toFixed(2)} ≥ 1.5（边框可见）`);
  // 品牌标识靠一条主色细线，不用投影（深色里投影等于看不见）
  ok(/border-bottom:\s*1px solid var\(--topbar-line\)/.test(topbar), '★ 顶栏用底边主色细线做分层');
  ok(!/box-shadow/.test(topbar), '★ 顶栏不再用投影（深色主题里投影会让边缘糊掉）');
}

console.log(`\n${'='.repeat(50)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail > 0) { console.log(`失败 ${fail} 项`); process.exit(1); }
console.log('集成测试全部通过');