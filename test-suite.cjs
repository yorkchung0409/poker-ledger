/**
 * 扑克记分房 —— 单一测试入口（核心业务 + 集成）
 * ============================================================================
 * 运行：
 *   "C:/Users/WIN/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" test-suite.cjs
 *
 * 测试的是 index.html 里**真实运行的那份代码**：
 *   · A/B/C 三节用 vm 从 index.html 里切出纯函数直接调用，不复制、不打桩；
 *   · D~U 各节用 jsdom 真实加载整个页面，走完整用户流程。
 *
 * ---------------------------------------------------------------------------
 * 覆盖范围（业务能力清单）
 * ---------------------------------------------------------------------------
 * A. 金额解析与格式化（纯函数）
 * B. 金额精确性与零和核算（纯函数）
 * C. 买入明细归一化与旧数据迁移（纯函数）
 * D. 首次启动与空状态
 * E. 人员管理：新增 / 重名与空名拒绝 / 删除 / 持久化
 * F. 选人上场：多选 / 已上场置灰 / 新建并选中 / 全员上场
 * G. 牌局 CRUD：结余→盈亏换算 / 零和校验 / 保存落库 / 编辑 / 删除
 * H. 买入录入生命周期：确认 / 追加 / 撤销 / 非法金额 / 落库形态
 * I. 本局买入默认值：自动记第一笔 / 不追溯已上场者 / 可撤销 / 读回
 * J. 未结算与「真实 0」的区分（结余 0 不被当空值、缺字段老数据）
 * K. 账本管理：新建 / 数据隔离 / 切换 / 删除
 * L. 持久化、导出与损坏数据回退（落库以分为单位 / CSV 对账格式 / 重载）
 * M. 金额边界与大额
 * N. 历史数据兼容与迁移（buyIn / rebuy / rebuys 三种形态）
 * O. 未保存内容保护（点遮罩 / × / Esc 拦截；未触碰不打扰；保存后不询问）
 * P. 写盘失败与失败原子性（保存 / 编辑保存 / 建人员 / 建账本 / 切账本 /
 *    删账本 / 删人员 / 删牌局 / 清空牌局 / 导入 —— 失败均不产生成功状态）
 * Q. 损坏存档保护与恢复副本（原件不被覆盖 / 副本可导出 / 去重持久化）
 * R. 导入校验与导入前快照（非法结构一律不写入；快照写失败整体中止）
 * S. CSV 公式注入防护
 * T. 启动读取失败不得覆盖未知原件
 * U. 渲染健壮性：HTML 转义 / 缺失姓名不显示 undefined / 历史姓名快照
 *
 * ---------------------------------------------------------------------------
 * 本文件**有意不覆盖**（移除的低价值外观断言，回归时不指向真实缺陷）
 * ---------------------------------------------------------------------------
 *   · CSS 像素级列宽预算（各断点 grid-template-columns 数值预算）
 *   · 计算出来的 WCAG 对比度比值与色板变量断言
 *   · 对 CSS / JS 源码文本做正则匹配的断言
 *   · aria-expanded 翻转等无障碍属性细节
 *   · 提示条 / toast 的逐字文案
 * 样式与文案由人工过一遍即可。数据安全类（未知 vs 真实 0、写盘失败原子性、
 * 非法导入拒绝、损坏原件保护、恢复副本、CSV 公式前缀、存储读取守卫）
 * 一条未减。
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('C:/Users/WIN/.workbuddy/binaries/node/workspace/node_modules/jsdom');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

/* ===========================================================================
 * 断言计数
 * ======================================================================== */
let pass = 0, fail = 0;
const sections = [];
let current = null;

function section(title) {
  current = { title, pass: 0, fail: 0 };
  sections.push(current);
  console.log(`\n=== ${title} ===`);
}
function ok(cond, label) {
  if (cond) { pass++; if (current) current.pass++; console.log(`  ✓ ${label}`); }
  else { fail++; if (current) current.fail++; console.log(`  ✗ ${label}`); }
}
function eq(a, b, label) {
  ok(a === b, `${label}${a === b ? '' : ` (期望 ${b}，实际 ${a})`}`);
}

/**
 * 取用户真正看得见的文本：剔除 script/style。
 * 直接用 body.textContent 会把源码里的 `return NaN`、`=== undefined`
 * 这类字面量算进来，导致误判。
 */
function visibleText(doc) {
  const clone = doc.body.cloneNode(true);
  clone.querySelectorAll('script, style, noscript').forEach(n => n.remove());
  return clone.textContent;
}

/* ===========================================================================
 * boot() —— 造一个带可注入故障的 localStorage，并用 jsdom 真实加载页面
 *
 * 故障注入能力（数据安全测试全靠它，一条没减）：
 *   setFailWrites(true | false | (key, value) => boolean)  让写入抛错
 *   store / raw() / seedRaw()                              读真实存储内容
 *   close()                                                关掉这个窗口
 * ======================================================================== */
const OPEN_WINDOWS = new Set();

function boot(seed, options = {}) {
  const store = new Map();
  if (seed) for (const [k, v] of Object.entries(seed)) store.set(k, v);
  let failWrites = options.failSetItem === true;
  const shouldFail = (k, v) => failWrites || (typeof options.failSetItem === 'function' && options.failSetItem(k, v));
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (shouldFail(k, v)) throw new Error('simulated setItem failure');
      store.set(k, String(v));
    },
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    key: i => [...store.keys()][i] ?? null,
  };
  Object.defineProperty(storage, 'length', { get: () => store.size });

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://local.test/',
    pretendToBeVisual: true,
    beforeParse(win) {
      // 必须用 defineProperty：jsdom 窗口上已有只读的 localStorage 属性，
      // 直接赋值会静默失败，导致页面用的是 jsdom 自带存储而测试读不到数据。
      Object.defineProperty(win, 'localStorage', { configurable: true, value: storage });
      win.confirm = () => true;
      win.scrollTo = () => {};               // jsdom 不实现 scrollTo，补空实现避免噪音
      win.prompt = (msg, def) => def;
      win.alert = () => {};
      win.Blob = class { constructor(parts) { this.parts = parts; } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.crypto.randomUUID = (() => { let n = 0; return () => `uuid-${++n}`; })();
    },
  });
  const win = dom.window;
  const doc = win.document;
  OPEN_WINDOWS.add(win);
  const $ = id => doc.getElementById(id);

  const api = {
    win, doc, $, store,
    /** 点击元素（统一冒泡） */
    click(el) {
      if (!el) throw new Error('click: 元素不存在');
      el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
    },
    q: sel => doc.querySelector(sel),
    qa: sel => [...doc.querySelectorAll(sel)],
    /** 给任意输入框赋值并触发 input 事件 */
    set(el, v) {
      if (!el) throw new Error('set: 元素不存在');
      el.value = v;
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
    },
    /** 主存储键的解析结果（注意：这是「存储」的状态，不是运行态） */
    raw: () => JSON.parse(store.get('poker-ledger:v1')),
    /** 存储里的原始字符串（用于「一个字节都不能变」的断言） */
    seedRaw: () => store.get('poker-ledger:v1'),
    /** 运行态（内存里的 db）—— 与存储分开断言，才能证明「落盘成功才替换运行状态」 */
    mem: expr => win.eval(`(${expr})`),
    /** 故障注入：true=全部写入失败，函数=按 key 判定 */
    setFailWrites(value) {
      failWrites = value === true;
      options.failSetItem = typeof value === 'function' ? value : null;
    },
    close() {
      OPEN_WINDOWS.delete(win);
      dom.window.close();
    },
    /** 当前所有录入行 */
    prows: () => [...doc.querySelectorAll('.prow')],
    /** 按 data-f 精确取录入行里的某个输入框（不要用索引，字段会增删） */
    field: (row, f) => [...row.querySelectorAll('input')].find(i => i.dataset.f === f),
    /** 某行某输入框的当前值 */
    fieldIn: (i, f) => {
      const el = api.field(api.prows()[i], f);
      return el ? el.value : null;
    },
    /** 依次填一行：{buy, value} */
    fill: (row, vals) => { for (const [f, v] of Object.entries(vals)) api.set(api.field(row, f), String(v)); },
    /** 某行「总买入」显示的数字（只读 .tb-num，避开笔数角标） */
    tbText: i => {
      const c = api.prows()[i].querySelector('[data-tb]');
      if (!c) return '';
      const n = c.querySelector('.tb-num');
      return (n ? n.textContent : c.textContent).trim();
    },
    /** 某行已记录的买入笔数（角标） */
    buyCount: i => {
      const b = api.prows()[i].querySelector('.tb-badge');
      return b ? b.textContent.trim() : '';
    },
    /** 某行盈亏格显示的文本 */
    pfText: i => {
      const c = api.prows()[i].querySelector('.pf');
      return c ? c.textContent.trim() : '';
    },
    /** 某行的盈亏格元素 */
    pfEl: i => api.prows()[i].querySelector('.pf'),
    /**
     * 在某行追加一笔买入：填金额 -> 点 +（或回车）。
     * 注意：追加会触发 renderRows() 重建 DOM，行元素会被替换，
     *       所以必须按索引重新取行，不能复用旧引用。
     * commitOnly=true 表示「格子里已有第 1 笔，这次点 + 只是确认它」。
     */
    buy: (rowIndex, amount, viaEnter, commitOnly) => {
      const row = api.prows()[rowIndex];
      const inp = api.field(row, 'buy');
      if (!inp) throw new Error('找不到买入输入框');
      if (!commitOnly) api.set(inp, String(amount));
      if (viaEnter) {
        inp.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      } else {
        api.click(row.querySelector('[data-act="buy"]'));
      }
    },
    /** 「本局买入」默认金额（一手，元） */
    setBuyDefault: v => api.set($('inBuyDefault'), v == null ? '' : String(v)),
    /** 打开选人面板，勾选名单里的人，再点「确认上场」（面板是多选，可一次多位） */
    pickPlayers(names) {
      api.click($('btnAddRow'));
      if (!doc.getElementById('ovPickPlayer').classList.contains('show')) {
        throw new Error('选人面板没打开');
      }
      for (const name of [].concat(names)) {
        const btn = api.qa('#pickList .pick').find(b => b.textContent.includes(name));
        if (!btn) throw new Error(`选人列表里没有「${name}」`);
        api.click(btn);
      }
      api.click($('btnConfirmPick'));
    },
    pickPlayer: name => api.pickPlayers([name]),
    /** 在人员面板里连续添加几位人员并关闭面板 */
    addPlayers(names) {
      api.click($('btnPlayers'));
      for (const n of [].concat(names)) { api.set($('inPlayerName'), n); api.click($('btnAddPlayer')); }
      api.click(api.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
    },
    /** 拦截 Blob 内容（导出测试用），返回还原函数 */
    captureBlob() {
      let captured = { text: null, opts: null };
      const Orig = win.Blob;
      win.Blob = function (parts, opts) { captured = { text: parts.join(''), opts }; return new Orig(parts, opts); };
      return {
        get: () => captured,
        restore: () => { win.Blob = Orig; },
      };
    },
    /** 拦截 <a download> 的文件名 */
    captureDownload() {
      let name = null;
      const origCreate = doc.createElement.bind(doc);
      doc.createElement = tag => {
        const el = origCreate(tag);
        if (tag === 'a') el.click = () => { name = el.download; };
        return el;
      };
      return { get: () => name, restore: () => { doc.createElement = origCreate; } };
    },
    /** 让 importData 能同步读到内存里的「文件」 */
    stubFileReader() {
      win.FileReader = class { readAsText(file) { this.result = file.text; this.onload(); } };
    },
  };
  return api;
}

/** 关掉所有还开着的 jsdom 窗口，避免进程挂住 */
function closeAllWindows() {
  for (const w of [...OPEN_WINDOWS]) { try { w.close(); } catch { /* 已关 */ } }
  OPEN_WINDOWS.clear();
}

/** 分别记录主存档、完整运行态与草稿，不把存储状态当作内存状态。 */
function failureSnapshot(t) {
  return {
    raw: t.seedRaw(),
    db: t.mem('JSON.stringify({db, currentId})'),
    draft: t.mem(`JSON.stringify({rows, editGameId, sheetSnapshot, pickSel,
      sheet: canonicalSheetState(),
      playerName: document.getElementById('inPlayerName').value,
      newPlayerName: document.getElementById('inNewPlayerName').value})`),
  };
}
function checkFailureUnchanged(t, before, label) {
  const after = failureSnapshot(t);
  eq(after.raw, before.raw, `${label}：主存档逐字节不变`);
  eq(after.db, before.db, `${label}：完整内存 db 与 currentId 不变`);
  eq(after.draft, before.draft, `${label}：行/日期/默认买入/编辑状态/选人及姓名草稿不变`);
}

/** 造一位人员并打开录入面板把人挑进表格 —— 多处复用的起手式 */
function stageGame(t, name = '老王') {
  t.win.eval(`db.ledgers[0].players=[{id:'p1',name:'${name}'}]; render();`);
  t.click(t.$('btnAddGame'));
  t.pickPlayer(name);
}

/** 造一个只有一位人员、零牌局的存储种子 */
const seedOneLedger = () => ({
  'poker-ledger:v1': JSON.stringify({
    version: 1, currentId: 'L',
    ledgers: [{ id: 'L', name: '旧', players: [{ id: 'p1', name: '老王' }], games: [] }],
  }),
});

/* ===========================================================================
 * A / B / C —— 纯函数：从 index.html 切出真实实现，用 vm 直接调用
 * ======================================================================== */
const cut = (fromMarker, toMarker) => {
  const a = html.indexOf(fromMarker);
  const b = toMarker ? html.indexOf(toMarker, a) : html.length;
  if (a < 0 || b < 0 || b <= a) {
    console.error(`FAIL: 抽取失败 —— 找不到 "${fromMarker}" 到 "${toMarker}"`);
    process.exit(1);
  }
  return html.slice(a, b);
};
// 段一：金额工具（parseCents / fmt*）；段二：计算函数（normalizeEntry / gameStats）。
// 中间那段（load/save/ledger 等）依赖 localStorage 与全局状态，跳过它。
const segUtil = cut('const KEY =', 'let db = load()');
const segCalc = cut('function normalizeEntry(', 'function totals()');
const coreCode = `(function () {
${segUtil}
${segCalc}
return { parseCents, fmtCents, fmtSigned, fmtCompact, normalizeEntry, gameStats };
})`;
const { parseCents, fmtCents, fmtSigned, fmtCompact, normalizeEntry, gameStats } =
  vm.runInNewContext(coreCode, { console, Date })();

section('A. 金额解析与格式化（纯函数）');
{
  const C = parseCents;
  // 合法输入：0 / 空 / 省略整数位 / 一位与两位小数 / 负数 / 尾随零
  eq([C('0'), C(''), C('   '), C('100'), C('1.5')].join(','), '0,0,0,10000,150', '合法输入：零/空/空格/整数/一位小数');
  eq([C('1.05'), C('0.01'), C('.5'), C('-1.23'), C('100.00')].join(','), '105,1,50,-123,10000',
     '合法输入：两位小数/最小单位/省略整数位/负数/尾随零');
  eq([C(null), C(undefined), C('\t\n'), C('0.00'), C('-.5'), C('1.')].join(','), '0,0,0,0,-50,100',
     '空值/空白/真实零/负小数/尾随小数点保持兼容');
  for (const text of ['-', '.', '-.', ' - ', ' . ', ' -. ']) {
    ok(Number.isNaN(C(text)), `★ 无数字金额 ${JSON.stringify(text)} 返回 NaN`);
  }
  // 非法输入必须返回 NaN（阻断性错误），否则会静默记错账
  const bad = ['abc', '1.234', '1.2.3', '1e5', '1,000', '¥100', '--5'].map(v => Number.isNaN(C(v)));
  ok(bad.every(Boolean), '★ 非法输入全部返回 NaN（字母/三位小数/双小数点/科学计数/千分位/货币符号/双负号）');

  // 格式化：结算与汇总必须显示给人看得懂的金额
  eq([fmtCents(0), fmtCents(123456), fmtCents(-123456)].join('|'), '0.00|1234.56|-1234.56', 'fmtCents 零/多位/负数');
  eq([fmtSigned(0), fmtSigned(5000), fmtSigned(-5000)].join('|'), '0.00|+50.00|-50.00', 'fmtSigned 零不带符号/正带+/负带-');
  eq([fmtCompact(10000), fmtCompact(1050)].join('|'), '100|10.50', 'fmtCompact 整元省小数/非整元保留两位');
}

section('B. 金额精确性与零和核算（纯函数）');
{
  // 前提校验：原生浮点确实会出错，所以我们才有整数分这一套
  eq(0.1 + 0.2 === 0.3, false, '前提：原生浮点加法会失真');
  eq(parseCents('0.1') + parseCents('0.2'), parseCents('0.3'), '★ 分单位 0.1+0.2 精确等于 0.3');
  const amounts = ['0.1', '0.2', '0.3', '1234.56', '0.05', '99.99'];
  eq(amounts.reduce((s, a) => s + parseCents(a), 0), parseCents('1335.20'),
     '★ 6 笔金额累加精确（原生浮点得 1335.1999999999998）');
  let acc = 0;
  for (let i = 0; i < 1000; i++) acc = acc + parseCents('0.07') - parseCents('0.07');
  eq(acc, 0, '1000 次加减后归零');

  // 结余 <-> 盈亏 换算（录入两种口径）
  eq(parseCents('300') - parseCents('100'), parseCents('200'), '结余模式算盈亏：300−100=+200');
  eq(parseCents('200') + parseCents('-150'), parseCents('50'), '亏损换算：200−150=50');

  // 零和校验：直接调用 index.html 里的真实 gameStats
  const game = (...nets) => ({ entries: nets.map(n => ({ netProfit: n, buys: [], balance: n })) });
  const okGame = game(parseCents('300'), parseCents('200'), parseCents('-500'));
  const badGame = game(parseCents('300'), parseCents('200'), parseCents('-400'));
  eq([gameStats(okGame).balanced, gameStats(okGame).diff, gameStats(okGame).flow].join(','), 'true,0,50000',
     '★ 平衡牌局：判定平衡、差额 0、流水 50000');
  eq([gameStats(badGame).balanced, gameStats(badGame).diff].join(','), 'false,10000',
     '★ 凭空多出 100 的牌局被识别为不平衡，差额 100');
  eq([gameStats(badGame).win, gameStats(badGame).loss].join(','), '50000,40000', '不平衡时赢方/输方合计正确');
  eq([gameStats(game(0, 0)).balanced, gameStats(game()).balanced, gameStats(game(parseCents('10'), 0)).balanced].join(','),
     'true,true,false', '全员打平 / 空牌局视为平衡；单人赢钱必然不平衡');

  // ★ 已结算的部分刚好抵消，但还有人没报结余 —— 此时绝不能宣称「已平衡」
  const withPending = { entries: [
    { buys: [10000], balance: 30000 },
    { buys: [30000], balance: 10000 },
    { buys: [10000] },                       // 还没报结余 → 未结算
  ] };
  const st = gameStats(withPending);
  eq([st.balanced, st.pending, st.diff].join(','), 'false,1,0',
     '★ 已结算部分抵消但有人未结算 → 不平衡 + 标出 1 人未结算（不能当作已平衡）');
}

section('C. 买入明细归一化与旧数据迁移（纯函数）');
{
  const base = { playerId: 'p', playerName: 'X' };
  const N = normalizeEntry;

  const a = N({ ...base, buys: [10000], balance: 30000 });
  eq([a.buys.length, a.totalBuy, a.netProfit].join(','), '1,10000,20000', '单笔买入：1 笔 / 总买入 100 / 盈亏 +200');
  const m = N({ ...base, buys: [10000, 10000, 5000, 5000], balance: 45000 });
  eq([m.buys.length, m.totalBuy, m.netProfit].join(','), '4,30000,15000', '多笔买入：4 笔 / 总买入 300 / 盈亏 +150');

  // ★ 核心不变量：笔数不同但总额相同，总买入与盈亏必须一致
  const s1 = N({ ...base, buys: [30000], balance: 45000 });
  const s2 = N({ ...base, buys: [10000, 10000, 5000, 5000], balance: 45000 });
  eq([s1.totalBuy === s2.totalBuy, s1.netProfit === s2.netProfit].join(','), 'true,true',
     '★ 买入笔数不影响总买入与盈亏');

  // 迁移 ①：旧 {buyIn, rebuys[]} → buys[]，起始买入成为第 1 笔（迁移必须无损）
  const legacy1 = N({ ...base, buyIn: 10000, rebuys: [15000], balance: 40000 });
  eq([legacy1.buys.join(','), legacy1.totalBuy, legacy1.netProfit].join(','), '10000,15000,25000,15000',
     '★ 迁移 buyIn+补买 → 2 笔按序，总买入与盈亏都不变');

  // 迁移 ②③：只有 buyIn / 更老的标量 rebuy
  const legacy2 = N({ ...base, buyIn: 5000, balance: 8000 });
  const legacy3 = N({ ...base, rebuy: 15000, balance: 40000 });
  eq([legacy2.totalBuy, legacy2.netProfit].join(','), '5000,3000', '迁移：只有 buyIn 时总买入 = 起始买入，盈亏正确');
  eq([legacy3.buys.join(','), legacy3.netProfit].join(','), '15000,25000', '迁移：标量 rebuy → 1 笔且金额与盈亏不变');

  // 迁移 ④：完全没有买入字段 / 完全没有结余字段
  const none = N({ ...base, balance: 8000 });
  const unknown = N({ ...base });
  eq([none.buys.length, none.totalBuy, none.netProfit].join(','), '0,0,8000',
     '无买入字段：明细空、总买入 0、盈亏 = 结余');
  eq([String(unknown.balance), String(unknown.netProfit)].join(','), 'null,null',
     '★ 没有结余字段时归一化为 null（不是 0）→ 未结算');

  // 幂等 + 脏数据过滤
  const twice = N(N({ ...base, buys: [10000, 5000], balance: 20000 }));
  eq([twice.buys.join(','), twice.totalBuy].join(','), '10000,5000,15000', '★ 归一化幂等（重复调用不改变数据）');
  const dirty = N({ ...base, buys: [5000, -100, 0, NaN, 5000], balance: 30000 });
  eq([dirty.buys.join(','), dirty.totalBuy].join(','), '5000,5000,10000', '★ 过滤掉负数/0/NaN 项，合计只含有效项');

  // ★ 核心不变量：追加买入且结余同步增加时，盈亏不变
  const before = N({ ...base, buys: [10000], balance: 15000 }).netProfit;
  const after = N({ ...base, buys: [10000, 10000], balance: 25000 }).netProfit;
  eq(before, after, '★ 追加买入 100 且结余同步 +100 时盈亏不变（该值 = 5000）');
}

/* ===========================================================================
 * D ~ U —— 集成：jsdom 真实加载 index.html，走完整用户流程
 * ======================================================================== */

section('D. 首次启动与空状态');
{
  const t = boot();
  eq(t.$('ledgerSelect').options.length, 1, '默认创建 1 个账本');
  ok(t.$('ledgerSelect').options[0].text.includes('默认账本')
     && t.$('gameList').textContent.includes('还没有牌局记录')
     && t.$('rankList').textContent.includes('还没有排行'), '账本名为默认账本，牌局与排行榜都是空状态');
  eq(t.$('btnAddGame').disabled, true, '★ 无人员时禁用记牌局按钮');
  const firstPaint = visibleText(t.doc);
  ok(!firstPaint.includes('NaN') && !firstPaint.includes('undefined'), '首屏无 NaN / undefined');
  t.close();
}

section('E. 人员管理：新增 / 校验 / 删除 / 持久化');
{
  const t = boot();
  t.click(t.$('btnPlayers'));
  ok(t.$('ovPlayers').classList.contains('show'), '人员弹窗打开');
  ['老王', '小李', '阿明'].forEach(n => { t.set(t.$('inPlayerName'), n); t.click(t.$('btnAddPlayer')); });
  eq(t.qa('.ptag').length, 3, '添加 3 位人员');
  ok(t.$('plist').textContent.includes('老王'), '人员标签显示姓名');

  t.set(t.$('inPlayerName'), '老王'); t.click(t.$('btnAddPlayer'));
  t.set(t.$('inPlayerName'), '   '); t.click(t.$('btnAddPlayer'));
  eq(t.qa('.ptag').length, 3, '★ 重名与空名都被拒绝，仍为 3 人');
  eq(t.$('btnAddGame').disabled, false, '有人员后记牌局按钮可用');

  t.win.confirm = () => true;
  t.click(t.qa('[data-rmp]').find(b => b.closest('.ptag').textContent.includes('小李')));
  eq([t.qa('.ptag').length, t.raw().ledgers[0].players.length].join(','), '2,2', '★ 删除人员后 UI 与存储都是 2 人');

  const re = boot({ 'poker-ledger:v1': t.seedRaw() });
  re.click(re.$('btnPlayers'));
  eq(re.qa('.ptag').length, 2, '★ 重载后人员仍在（已持久化）');
  re.close();
  t.close();
}

section('F. 选人上场：多选 / 已上场置灰 / 新建并选中');
{
  const t = boot();
  t.addPlayers(['老王', '小李', '阿明']);
  t.click(t.$('btnAddGame'));
  t.click(t.$('btnAddRow'));
  eq([t.$('ovPickPlayer').classList.contains('show'), t.qa('#pickList .pick').length, t.qa('.prow').length].join(','),
     'true,3,0', '★ 选人面板打开、列出全部 3 人，且不自动添加任何人');

  const pickOf = name => t.qa('#pickList .pick').find(b => b.textContent.includes(name));
  const before = t.qa('.prow').length;
  t.click(pickOf('阿明'));
  t.click(pickOf('阿明'));
  eq([t.qa('.prow').length, t.$('btnConfirmPick').disabled].join(','), `${before},true`,
     '★ 勾选不等于进场；勾选可取消，取消到 0 人时确认按钮禁用');

  ['老王', '小李', '阿明'].forEach(n => t.click(pickOf(n)));
  t.click(t.$('btnConfirmPick'));
  eq(t.qa('.prow').length, 3, '★ 一次确认把 3 人一起放上场');
  ok(!t.$('ovPickPlayer').classList.contains('show') && t.$('ovGame').classList.contains('show'),
     '确认后关掉选人面板，而牌局面板仍开着');
  ok(t.prows()[0].textContent.includes('老王') && t.prows()[1].textContent.includes('小李')
     && t.prows()[2].textContent.includes('阿明'), '★ 行顺序 = 点选顺序');

  // 新建并选中：建完只勾上，仍要确认才进场
  t.set(t.$('inNewPlayerName'), '新同学');
  t.click(t.$('btnAddPlayerThenPick'));
  eq(t.qa('.prow').length, 3, '★「新建并选中」不直接进场');
  ok(t.qa('#pickList .pick.on').some(b => b.textContent.includes('新同学')), '★ 新人处于勾选态');
  t.click(t.$('btnConfirmPick'));
  ok(t.qa('.prow').length === 4 && t.$('plist').textContent.includes('新同学'), '确认后新人才进场并进了人员名单');

  t.win.renderPickList();
  const picks = t.qa('#pickList .pick');
  eq([t.$('btnAddRow').disabled, picks.length, picks.filter(b => !b.disabled).length].join(','), 'true,4,0',
     '★ 全员上场：添加入口禁用，名单仍列出但无可选项（否则看不出谁在场上）');
  t.close();
}

section('G. 牌局 CRUD：结余→盈亏 / 零和校验 / 保存 / 编辑 / 删除');
{
  const t = boot();
  t.addPlayers(['老王', '小李', '阿明']);
  t.win.eval(`(() => {
    const counts = { renderRows: 0, updateCalc: 0 };
    const oldRenderRows = renderRows;
    const oldUpdateCalc = updateCalc;
    renderRows = (...args) => { counts.renderRows++; return oldRenderRows(...args); };
    updateCalc = (...args) => { counts.updateCalc++; return oldUpdateCalc(...args); };
    window.__v26Counts = counts;
  })()`);
  t.click(t.$('btnAddGame'));
  eq(t.win.eval('[__v26Counts.renderRows, __v26Counts.updateCalc].join(",")'), '1,1',
     '★ 空表 renderRows 不重复触发 updateCalc，外层调用一次即可');
  eq(t.qa('.prow').length, 0, '★ 新牌局从 0 行开始（不预填全部人员）');
  ok(t.$('calcHint').textContent.includes('还没有人上场'), '空表时计算区提示还没有人上场');

  // 批量确认 3 人：逐人入行但只在确认完成后统一刷新一次。
  t.pickPlayers(['老王', '小李', '阿明']);
  eq(t.win.eval('[__v26Counts.renderRows, __v26Counts.updateCalc].join(",")'), '2,2',
     '★ 批量确认 3 人只额外触发一次 renderRows 与一次 updateCalc');
  t.qa('.prow').forEach((row, i) => { t.set(t.field(row, 'buy'), '100'); t.set(t.field(row, 'value'), ['300', '0', '0'][i]); });
  eq([t.pfText(0), t.pfText(1)].join(','), '+200,-100', '★ 结余→盈亏换算：300−100=+200，0−100=-100');
  ok(t.$('calcHint').textContent.includes('已平衡'), '零和校验提示已平衡');

  t.click(t.$('btnSaveGame'));
  eq([t.$('ovGame').classList.contains('show'), t.qa('.game').length].join(','), 'false,1', '★ 保存后面板关闭并生成 1 张牌局卡');
  ok(t.$('gameList').textContent.includes('3人') && t.$('stats').textContent.includes('1')
     && !t.$('gameList').textContent.includes('未平'), '牌局卡显示 3 人、统计 1 场、平衡牌局无未平标记');
  eq([t.$('rankList').textContent.includes('+200.00'), t.qa('.rank-row').length,
      t.qa('.rank-row')[0].textContent.includes('老王')].join(','), 'true,3,true', '★ 排行榜 3 行，老王居首 +200.00');

  // 刚保存自动展开（刚记完必须看得见），可收起可再展开
  ok(t.$('gameList').textContent.includes('总买入') && t.$('gameList').textContent.includes('盈亏'),
     '★ 保存后自动展开显示明细表');
  t.click(t.q('[data-toggle]'));
  ok(!t.$('gameList').textContent.includes('总买入') && t.$('gameList').textContent.includes('流水'),
     '★ 点一下收起明细，流水概要仍在');
  t.click(t.q('[data-toggle]'));
  ok(t.$('gameList').textContent.includes('总买入'), '再次点击展开明细');

  // v25：明细表 4 列（人员/总买入/结余/盈亏），无独立「买入」列；
  // 多笔买入时总买入格带笔数角标，单笔不带
  {
    const ths = [...t.qa('.card.game table.detail thead th')].map(x => x.textContent.trim());
    eq(ths.join('|'), '人员|总买入|结余|盈亏', '★ v25 明细表为 4 列，无独立买入列');
    ok(!t.q('.card.game table.detail').textContent.includes('+1 笔'),
       '★ v25 明细表不再显示「+N 笔」文本');
  }

  // 编辑：改结余 → 盈亏与排行榜随之变化，且是更新而非新增
  t.click(t.$('gameList').querySelector('[data-edit]'));
  t.set(t.field(t.prows()[0], 'value'), '250');
  eq(t.pfText(0), '+150', '★ 编辑时改结余 250 → 盈亏 +150');
  t.click(t.$('btnSaveGame'));
  eq([t.raw().ledgers[0].games.length, t.raw().ledgers[0].games[0].entries[0].balance].join(','), '1,25000',
     '★ 编辑是更新而不是新增一场，结果已落盘');
  ok(t.$('rankList').textContent.includes('+150.00'), '排行榜随编辑更新');

  // 删除牌局
  t.win.confirm = () => true;
  t.click(t.$('headGames'));
  t.click(t.q('[data-del]'));
  eq([t.qa('.game').length, t.raw().ledgers[0].games.length].join(','), '0,0', '★ 删除牌局后 UI 与存储都为空');
  t.close();
}

// 无数字金额必须走真实保存拒绝路径，而不只是纯函数返回 NaN。
{
  for (const field of ['buy', 'value', 'default']) {
    for (const text of ['-', '.', '-.', ' - ', ' . ', ' -. ']) {
      const t = boot(seedOneLedger());
      stageGame(t);
      t.fill(t.prows()[0], { buy: '100', value: '100' });
      t.setBuyDefault('100');
      const input = field === 'default' ? t.$('inBuyDefault') : t.field(t.prows()[0], field);
      t.set(input, text);
      const before = failureSnapshot(t);
      let writes = 0;
      const setItem = t.win.localStorage.setItem;
      t.win.localStorage.setItem = (...args) => { writes++; setItem(...args); };
      t.$('inDate').focus();
      t.click(t.$('btnSaveGame'));
      const label = `拒绝 ${field}=${JSON.stringify(text)}`;
      eq(writes, 0, `${label}：不尝试写盘`);
      checkFailureUnchanged(t, before, label);
      ok(t.$('ovGame').classList.contains('show'), `${label}：面板保持打开`);
      eq(t.doc.activeElement, input, `${label}：聚焦对应错误金额输入`);
      t.close();
    }
  }
  for (const [text, cents, balance] of [['0', 0, 0], ['0.00', 0, 0], ['', 0, null], ['   ', 0, null], ['.5', 50, 50]]) {
    const t = boot(seedOneLedger());
    stageGame(t);
    t.setBuyDefault(text);
    t.fill(t.prows()[0], { buy: text, value: text });
    t.click(t.$('btnSaveGame'));
    const game = t.raw().ledgers[0].games[0];
    ok(!!game && !t.$('ovGame').classList.contains('show'), `${JSON.stringify(text)}：真实保存成功并关闭面板`);
    eq(game?.buyDefault, cents, `${JSON.stringify(text)}：默认买入保持零/空白/小数语义`);
    eq(JSON.stringify(game?.entries[0].buys), JSON.stringify(cents > 0 ? [cents] : []),
       `${JSON.stringify(text)}：零和空白不生成买入，小数以分保存`);
    eq(game?.entries[0].balance, balance, `${JSON.stringify(text)}：真实零已结算，空白未结算，小数正确`);
    t.close();
  }
}

section('H. 买入录入生命周期：确认 / 追加 / 撤销 / 非法金额 / 落库形态');
{
  const t = boot();
  t.addPlayers(['老王', '小李']);
  t.win.eval(`(() => {
    const counts = { updateCalc: 0 };
    const oldUpdateCalc = updateCalc;
    updateCalc = (...args) => { counts.updateCalc++; return oldUpdateCalc(...args); };
    window.__v26Counts = counts;
  })()`);
  t.click(t.$('btnAddGame'));
  t.pickPlayers(['老王', '小李']);

  // 填进格子但没点 + 时，先按格子里已有的数算
  t.fill(t.prows()[0], { buy: '100', value: '300' });
  eq([t.tbText(0), t.pfText(0), t.buyCount(0)].join(','), '100,+200,',
     '第 1 笔买入：总买入 100、盈亏 +200，未点 + 时没有笔数角标');

  // 点 + 确认第 1 笔：明细里落 1 笔，格子清空，结余与盈亏都不变
  t.buy(0, 100, false, true);
  eq([t.buyCount(0), t.tbText(0), t.fieldIn(0, 'buy'), t.fieldIn(0, 'value'), t.pfText(0)].join(','),
     '1,100,,300,+200',
     '★ 点 + 确认第 1 笔：角标 1 笔、格子清空、结余 300 不变、盈亏 +200 不变');
  eq(t.win.eval(`(() => { const b = document.querySelector('[data-tb="0"]'); return [b.dataset.act, b.getAttribute('aria-expanded')].join(','); })()`),
     'buyList,false', '★ 买入确认后角标同步挂上明细入口且保持收起态');

  // 追加：只进明细，结余不动，盈亏随总买入变化
  t.buy(0, 50);
  eq([t.buyCount(0), t.tbText(0), t.fieldIn(0, 'value'), t.pfText(0)].join(','), '2,150,300,+150',
     '★ 追加 50：总买入 150、结余仍 300、盈亏随之变 +150');

  // 回车提交第三笔（与点 + 等价）
  t.buy(0, 50, true);
  eq([t.buyCount(0), t.tbText(0), t.fieldIn(0, 'value'), t.pfText(0)].join(','), '3,200,300,+100',
     '★ 回车也能提交：三笔共 200、结余仍由用户掌握、盈亏 = 300 − 200');

  // 展开明细 → 撤销一笔
  const calcBeforeToggle = t.win.eval('window.__v26Counts.updateCalc');
  t.click(t.prows()[0].querySelector('[data-act="buyList"]'));
  eq(t.win.eval('window.__v26Counts.updateCalc'), calcBeforeToggle,
     '★ 买入明细展开只重绘行，不重复计算统计');
  eq([t.qa('.rbi').length, t.qa('[data-act="buyDel"]').length].join(','), '3,3', '点开后明细里 3 笔，每笔都有撤销按钮');
  t.click(t.qa('[data-act="buyDel"]')[2]);
  eq([t.qa('.rbi').length, t.tbText(0), t.fieldIn(0, 'value'), t.pfText(0)].join(','), '2,150,300,+150',
     '★ 撤销 50：剩 2 笔、总买入回到 150、结余不变、盈亏回到 +150');
  eq(t.buyCount(0), '2', '★ 撤销后角标同步回退为剩余买入笔数');

  // 用户改报真实结余 → 盈亏跟着更新
  t.set(t.field(t.prows()[0], 'value'), '350');
  eq(t.pfText(0), '+200', '★ 用户报结余 350 后盈亏 = 350 − 150 = +200');

  // 非法金额：不得产生新记录，且提示格式错
  const buyInput = () => [...t.prows()[0].querySelectorAll('input')].find(i => i.dataset.f === 'buy');
  t.set(buyInput(), '1.234');
  t.click(t.prows()[0].querySelector('[data-act="buy"]'));
  eq([t.buyCount(0), t.tbText(0)].join(','), '2,?', '★ 非法买入金额不产生新记录，总买入显示 ? 提示格式错');
  t.set(buyInput(), '');
  eq(t.tbText(0), '150', '清空非法输入后总买入回到 150');
  ok(t.q('[data-tb="0"]').dataset.act === 'buyList', '★ 输入清空不误删已有买入角标入口');

  // 零和收尾：老王 +200（买入 150、结余 350），小李 -200（买入 300、结余 100）
  t.fill(t.prows()[1], { buy: '300', value: '100' });
  eq([t.pfText(1), t.$('calcHint').textContent.includes('已平衡')].join(','), '-200,true',
     '★ 小李 -200 与老王 +200 抵消，整体已平衡');
  t.click(t.$('btnSaveGame'));

  // 落库形态：buys 明细数组是唯一事实来源，派生字段与旧字段都不入库
  const wang = t.raw().ledgers[0].games[0].entries.find(e => e.playerName === '老王');
  ok(Array.isArray(wang.buys), '★ 落盘字段是 buys 数组');
  eq(wang.buys.join(','), '10000,5000', '★ 买入明细按发生顺序、以分存储');
  ok(!('buyIn' in wang) && !('rebuys' in wang), '★ 旧字段 buyIn / rebuys 不再入库');
  ok(!('totalBuy' in wang) && !('netProfit' in wang), '★ 派生字段不入库（由 normalizeEntry 还原）');

  // v25：多笔买入的人在明细表总买入格带笔数角标；单笔的不带
  {
    const rows = [...t.qa('.card.game table.detail tbody tr')];
    const wangRow = rows.find(r => r.textContent.includes('老王'));
    const liRow = rows.find(r => r.textContent.includes('小李'));
    ok(wangRow.querySelector('.buy-badge') && wangRow.querySelector('.buy-badge').textContent === '2笔',
       '★ v25 追加过买入的人总买入格显示 2笔 角标');
    ok(liRow && !liRow.querySelector('.buy-badge'),
       '★ v25 单笔买入的人不显示角标（无增量信息不加噪音）');
  }

  // 编辑时明细要能读回来，格子留空避免与已有明细打架
  t.click(t.$('gameList').querySelector('[data-edit]'));
  eq([t.buyCount(0), t.fieldIn(0, 'buy'), t.tbText(0), t.fieldIn(0, 'value')].join(','), '2,,150,350',
     '★ 编辑时买入明细被正确载入，格子留空，总买入与结余都还原');
  t.close();
}

section('I. 本局买入默认值：自动记第一笔 / 不追溯 / 可撤销 / 读回');
{
  const t = boot();
  t.addPlayers(['老王', '小李', '阿明']);
  t.click(t.$('btnAddGame'));
  eq(t.$('inBuyDefault').value, '', '新牌局的「本局买入」默认留空');
  t.pickPlayer('老王');
  eq([t.fieldIn(0, 'buy'), t.tbText(0)].join(','), ',—', '★ 本局买入留空 → 不自动记买入，总买入显示 —');

  t.setBuyDefault('200');
  t.pickPlayer('小李');
  eq([t.tbText(1), t.buyCount(1), t.tbText(0)].join(','), '200,1,—',
     '★ 新人自动记一笔 200 并产生角标；已在场的老王不受影响（不篡改历史）');

  t.setBuyDefault('300');
  t.pickPlayer('阿明');
  eq(t.tbText(2), '300', '★ 改成本局买入 300 后，新加入的人记 300');

  // ★ 刚上桌（有买入、没结余）不能显示成输钱
  eq(t.pfText(1), '未结算', '★ 有买入但没结余 → 显示「未结算」（不显示 -200）');
  ok(t.pfEl(1).classList.contains('pending') && !t.pfEl(1).classList.contains('down')
     && !/差额 ¥2\.00/.test(t.$('calcHint').textContent),
     '★ 未结算的行是 pending 态，且不参与输赢统计（不凭空造出亏损）');
  // 全员都还没报结余时，不能宣称「已平衡」（已结算部分是 0:0，但那是空集）
  const hint0 = t.$('calcHint').textContent;
  ok(hint0.includes('未结算') && !hint0.includes('已平衡'),
     `★ 全员未结算时不显示已平衡（实际: ${hint0.replace(/\s+/g, ' ').trim()}）`);
  t.set(t.field(t.prows()[1], 'value'), '500');
  eq([t.pfText(1), t.pfEl(1).classList.contains('pending')].join(','), '+300,false',
     '★ 填了结余后正常算盈亏（500 − 200），不再是 pending 态');

  // 自动记的买入是普通的一笔，可撤销
  t.click(t.prows()[1].querySelector('[data-act="buyList"]'));
  t.click(t.qa('[data-act="buyDel"]')[0]);
  eq([t.tbText(1), t.buyCount(1)].join(','), '—,', '★ 自动记的那笔可撤销（不是不可动的隐藏数据）');
  ok(!t.q('[data-tb="1"]').dataset.act && !t.q('[data-tb="1"]').hasAttribute('aria-expanded'),
     '★ 撤销最后一笔后角标与明细入口一起移除');

  // 落盘
  t.click(t.$('btnSaveGame'));
  const g = t.raw().ledgers[0].games[0];
  const buysOf = name => g.entries.find(e => e.playerName === name).buys.join(',') || '0';
  eq([g.buyDefault, buysOf('老王'), buysOf('小李'), buysOf('阿明')].join(','), '30000,0,0,30000',
     '★ 本局买入按分落盘；老王无买入、小李被撤销、阿明落盘 1 笔 300');

  // 编辑旧牌局要能读回本局买入
  t.click(t.$('gameList').querySelector('[data-edit]'));
  eq(t.$('inBuyDefault').value, '300', '★ 编辑旧牌局时读回本局买入');

  // 三位小数的本局买入应被拒绝
  t.win.closeSheet('ovGame', true);
  t.click(t.$('btnAddGame'));
  t.setBuyDefault('12.345');
  t.pickPlayer('老王');
  eq([t.buyCount(0), t.tbText(0)].join(','), ',—', '★ 本局买入三位小数 → 视为无效，不自动记买入');
  t.close();
}

section('J. 未结算与「真实 0」的区分');
{
  // 结余真值 0（打平走人）必须回显成 "0"，不能被当成空值抹掉
  const state = {
    version: 1, currentId: 'L', ledgers: [{
      id: 'L', name: 'T', players: [{ id: 'p1', name: '老王' }, { id: 'p2', name: '小李' }],
      games: [{ id: 'g1', date: '2026-10-01', buyDefault: 20000, entries: [
        { playerId: 'p1', playerName: '老王', buys: [20000], balance: 0 },
        { playerId: 'p2', playerName: '小李', buys: [20000], balance: 40000 },
      ] }],
    }],
  };
  const t = boot({ 'poker-ledger:v1': JSON.stringify(state) });
  t.click(t.$('headGames'));
  t.win.openGameSheet('g1');
  eq(t.q('[data-i="0"][data-f="value"]').value, '0', '★ 结余 0 正确回显成 "0"，不是空');
  ok(t.$('calcHint').textContent.includes('已平衡'), '结余 0 与持平的行仍然零和平衡');
  t.click(t.$('btnSaveGame'));
  eq(t.raw().ledgers[0].games[0].entries[0].balance, 0, '★ 保存后结余仍是 0（没被当成空值抹掉）');
  t.close();

  // 字段缺失的旧数据 → 空 / 未结算，且不被凭空补 0
  const t2 = boot(seedOneLedger());
  t2.win.eval(`db.ledgers[0].players=[{id:'p1',name:'老王'}];
               db.ledgers[0].games=[{id:'g1',date:'2026-10-01',buyDefault:0,
                 entries:[{playerId:'p1',playerName:'老王',buys:[20000]}]}];
               render(); openGameSheet('g1');`);
  eq([t2.q('[data-i="0"][data-f="value"]').value, t2.q('.pf').textContent].join(','), ',未结算',
     '★ 字段缺失的老数据回显为空（不被凭空补 0）且标记未结算');
  t2.close();

  // 同一场里「未知结余」与「真实 0」必须全程区分
  const mixed = {
    version: 1, currentId: 'L', ledgers: [{
      id: 'L', name: '审计账本', players: [{ id: 'p1', name: '未知' }, { id: 'p2', name: '归零' }],
      games: [{ id: 'g-unknown', date: '2099-01-01', entries: [
        { playerId: 'p1', playerName: '未知', buys: [10000] },
        { playerId: 'p2', playerName: '归零', buys: [10000], balance: 0 },
      ] }],
    }],
  };
  const t3 = boot({ 'poker-ledger:v1': JSON.stringify(mixed) });
  const norm = id => t3.win.eval(`normalizeEntry(db.ledgers[0].games[0].entries.find(e => e.playerId === '${id}'))`);
  eq([String(norm('p1').balance), String(norm('p1').netProfit)].join(','), 'null,null',
     '★ 未知结余归一化为 balance:null / 盈亏 null');
  eq(t3.raw().ledgers[0].games[0].entries[1].balance, 0, '★ 真实 0 仍落盘为 0');
  ok(t3.$('stats').textContent.includes('未结算'), '统计识别未知结余为未结算');
  t3.win.openGameSheet('g-unknown');
  eq(t3.fieldIn(0, 'value'), '', '编辑未知结余时输入框保持空白');
  t3.click(t3.$('btnSaveGame'));
  eq(norm('p1').balance, null, '★ 保存未知结余后归一化仍为 balance:null');

  const reloaded = boot({ 'poker-ledger:v1': t3.seedRaw() });
  reloaded.click(reloaded.$('headGames'));
  reloaded.click(reloaded.q('[data-toggle="g-unknown"]'));
  const detail = reloaded.$('gameList').textContent;
  ok(reloaded.$('stats').textContent.includes('未结算'), '重载后统计仍识别未知结余');
  ok(detail.includes('未知') && detail.includes('未结算'), '重载后牌局明细显示未知人员未结算');
  ok(detail.includes('归零') && !detail.includes('归零未结算'), '★ 真实 0 不被显示为未结算');

  const csv = reloaded.captureBlob();
  reloaded.click(reloaded.$('btnData'));
  reloaded.click(reloaded.$('btnExportCsv'));
  csv.restore();
  ok(csv.get().text.replace(/^﻿/, '').split('\r\n')
      .some(r => r.startsWith('2099-01-01,未知,') && r.endsWith(',,')),
     '★ 未知结余导出 CSV 时结余与净盈亏为空');
  reloaded.close();
  t3.close();
}

section('K. 账本管理：新建 / 数据隔离 / 切换 / 删除');
{
  const t = boot();
  t.addPlayers(['老王']);
  t.click(t.$('btnAddGame'));
  t.pickPlayer('老王');
  t.fill(t.prows()[0], { buy: '100', value: '100' });
  t.click(t.$('btnSaveGame'));
  eq(t.qa('.game').length, 1, '账本 A 有 1 场牌局');

  t.win.prompt = () => '另一批人';
  t.click(t.$('btnLedgers'));
  t.click(t.$('btnNewLedger'));
  eq([t.$('ledgerSelect').options.length, t.$('ledgerSelect').options[1].text.includes('另一批人')].join(','),
     '2,true', '★ 新建账本成功，出现在下拉里');
  eq([t.qa('.game').length, t.$('rankList').textContent.includes('还没有排行'), t.$('btnAddGame').disabled].join(','),
     '0,true,true', '★ 新账本数据隔离：无牌局、无排行、无人员时按钮禁用');

  t.click(t.$('btnLedgers'));
  t.click(t.qa('[data-ledger]').find(el => el.textContent.includes('默认账本')));
  eq([t.qa('.game').length, t.$('btnAddGame').disabled].join(','), '1,false', '★ 切回账本 A 后牌局与人员都回来了');

  // 删除当前账本 → 切回首个账本，且持久化
  t.win.confirm = () => true;
  const delId = t.win.eval('currentId');
  const fallbackId = t.raw().ledgers.find(l => l.id !== delId).id;
  ok(t.$('btnDelLedger'), '多账本时显示删除账本按钮');
  t.click(t.$('btnLedgers'));
  t.click(t.$('btnDelLedger'));
  ok(!t.raw().ledgers.some(l => l.id === delId), '★ 删除账本后该账本消失');
  eq(t.raw().currentId, fallbackId, '★ 删除当前账本后切回首个账本');
  const afterDel = boot({ 'poker-ledger:v1': t.seedRaw() });
  eq(afterDel.raw().currentId, fallbackId, '重载后仍停留在切回的账本');
  afterDel.close();
  t.close();
}

section('L. 持久化、导出与损坏数据回退');
{
  const t = boot();
  t.addPlayers(['老王']);
  t.click(t.$('btnAddGame'));
  t.pickPlayer('老王');
  t.fill(t.prows()[0], { buy: '50', value: '75' });
  t.click(t.$('btnSaveGame'));

  // 落库检查：金额一律以「分」为整数存储
  const e0 = t.raw().ledgers[0].games[0].entries[0];
  eq([e0.buys.join(','), e0.balance].join(','), '5000,7500', '★ 买入与结余都以分存储');
  ok(!('netProfit' in e0) && !('totalBuy' in e0) && !('buyIn' in e0),
     '★ 盈亏/总买入是派生值、旧字段 buyIn，均不入库');

  // 导出 JSON 备份
  t.click(t.$('btnData'));
  const dl = t.captureDownload();
  t.click(t.$('btnExport'));
  dl.restore();
  ok(dl.get() && dl.get().endsWith('.json'), '★ 导出为 json 备份文件');

  // 导出 Excel 明细 CSV：界面改整元显示后留给对账的出路，格式必须真能用
  const csv = t.captureBlob();
  const csvName = t.captureDownload();
  t.click(t.$('btnExportCsv'));
  csv.restore();
  const name = csvName.get();
  csvName.restore();
  const csvText = csv.get().text;
  ok(/text\/csv/.test(csv.get().opts.type) && /\.csv$/.test(name || ''), '★ 导出的是 CSV 文件');
  eq([csvText.charCodeAt(0) === 0xFEFF, csvText.replace(/^﻿/, '').split('\r\n')[0]].join(','),
     'true,日期,人员,买入,总买入,结余,净盈亏', '★ CSV 带 UTF-8 BOM（否则 Excel 中文乱码）且表头正确');
  {
    const cells = csvText.replace(/^﻿/, '').split('\r\n')[1].split(',');
    ok(/^\d+\.\d\d$/.test(cells[3]) && /^-?\d+\.\d\d$/.test(cells[5]) && !/¥/.test(csvText),
       '★ 金额列带两位小数、不带 ¥（Excel 才认成数字）');
  }

  const t2 = boot({ 'poker-ledger:v1': t.seedRaw() });
  eq([t2.qa('.game').length, t2.$('rankList').textContent.includes('+25.00')].join(','), '1,true',
     '★ 重载后牌局与排行榜净盈亏都正确');
  t2.close();
  t.close();

  // 损坏 / 残缺数据不得崩溃
  const broken = boot({ 'poker-ledger:v1': '{损坏的 JSON' });
  const emptyList = boot({ 'poker-ledger:v1': '{"ledgers":[]}' });
  const t5 = boot({ 'poker-ledger:v1': JSON.stringify({
    version: 1, currentId: 'x', ledgers: [{ id: 'x', name: '老数据', createdAt: '', updatedAt: '' }],
  }) });
  eq([broken.$('ledgerSelect').options.length, broken.$('gameList').textContent.includes('还没有牌局记录')].join(','),
     '1,true', '★ 数据损坏时回退到默认账本并显示空状态（而非崩溃）');
  eq([emptyList.$('ledgerSelect').options.length, t5.$('ledgerSelect').options.length].join(','), '1,1',
     '★ 空账本列表、缺 players/games 的老数据都能加载');
  broken.close(); emptyList.close(); t5.close();
}

section('M. 金额边界与大额');
{
  const t = boot();
  t.addPlayers(['A', 'B']);
  t.click(t.$('btnAddGame'));
  t.pickPlayers(['A', 'B']);
  // 大额 + 角分：A 买入 100000.55 结余 99999.54（输 1.01），B 买入 0 结余 1.01
  t.fill(t.prows()[0], { buy: '100000.55', value: '99999.54' });
  t.fill(t.prows()[1], { buy: '0', value: '1.01' });
  t.click(t.$('btnSaveGame'));
  ok(t.$('gameList').textContent.includes('已平衡'), '★ 大额角分场景精确平衡并保存');
  const shown = visibleText(t.doc);
  ok(!shown.includes('NaN') && !shown.includes('undefined') && !shown.includes('Infinity'),
     '★ 大额不产生 NaN / undefined / Infinity');
  t.close();
}

section('N. 历史数据兼容与迁移（buyIn / rebuy / rebuys 三种形态）');
{
  // g1 — v1 远古版：连 rebuy 都没有；g2 — v2 版：rebuy 是标量总额；g3 — v3 版：rebuys 已是数组
  const legacy = {
    version: 1, currentId: 'L1',
    ledgers: [{
      id: 'L1', name: '旧账本', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      players: [{ id: 'p1', name: '老王' }, { id: 'p2', name: '小李' }],
      games: [
        { id: 'g1', date: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z', entries: [
          { playerId: 'p1', playerName: '老王', buyIn: 10000, balance: 30000, netProfit: 20000 },
          { playerId: 'p2', playerName: '小李', buyIn: 30000, balance: 10000, netProfit: -20000 },
        ] },
        { id: 'g2', date: '2026-01-02', createdAt: '2026-01-02T00:00:00.000Z', entries: [
          { playerId: 'p1', playerName: '老王', buyIn: 10000, rebuy: 15000, balance: 40000, netProfit: 15000 },
          { playerId: 'p2', playerName: '小李', buyIn: 40000, rebuy: 0, balance: 25000, netProfit: -15000 },
        ] },
        { id: 'g3', date: '2026-01-03', createdAt: '2026-01-03T00:00:00.000Z', entries: [
          { playerId: 'p1', playerName: '老王', buyIn: 10000, rebuys: [10000, 5000], balance: 40000 },
          { playerId: 'p2', playerName: '小李', buyIn: 40000, rebuys: [], balance: 25000 },
        ] },
      ],
    }],
  };
  const t = boot({ 'poker-ledger:v1': JSON.stringify(legacy) });
  eq([t.qa('.game').length, t.$('stats').textContent.includes('3')].join(','), '3,true',
     '★ 三种历史数据都能正常加载');
  // g1 +200, g2 +150, g3 +150 -> 老王累计 +500
  ok(t.$('rankList').textContent.includes('+500'), '★ 三种数据形态的盈亏汇总正确（老王累计 +500）');

  ['g1', 'g2', 'g3'].forEach(id => {
    const tg = t.qa('[data-toggle]').find(b => b.dataset.toggle === id);
    if (tg) t.click(tg);
  });
  const body = t.$('gameList').textContent;
  ok(!body.includes('undefined') && !body.includes('NaN'), '旧数据渲染无 undefined / NaN');
  ok(body.includes('已平衡'), '★ 展开后三场都显示已平衡');

  // 编辑 g2（标量 rebuy 那场）：迁移后应把起始买入和追加合成两条明细
  t.click(t.qa('[data-edit]').find(b => b.dataset.edit === 'g2'));
  eq([t.buyCount(0), t.tbText(0), t.pfText(0)].join(','), '2,250,+150',
     '★ 迁移后明细 = 2 笔（起始买入 100 + 追加 150），总买入 250，盈亏不变 +150');
  t.click(t.$('btnSaveGame'));

  const e1 = t.raw().ledgers[0].games.find(g => g.id === 'g2').entries.find(e => e.playerName === '老王');
  ok(Array.isArray(e1.buys), '存回后 buys 是数组');
  eq(e1.buys.join(','), '10000,15000', '★ 金额无损、按发生顺序');
  ok(!('buyIn' in e1) && !('rebuy' in e1) && !('rebuys' in e1), '★ 三个旧字段都不再入库');
  ok(!('totalBuy' in e1) && !('netProfit' in e1), '★ 派生字段不入库');
  t.close();
}

section('O. 未保存内容保护（关面板会丢数据）');
{
  const t = boot();
  stageGame(t);
  t.fill(t.prows()[0], { buy: '300', value: '385' });

  // 点遮罩 / × / Esc 走同一条拦截路径
  const beforeClose = failureSnapshot(t);
  let asked = '', confirmCount = 0;
  t.win.confirm = msg => { asked = msg; confirmCount++; return false; };
  t.win.document.querySelectorAll('.overlay')[0]
    .dispatchEvent(new t.win.MouseEvent('click', { bubbles: true }));
  ok(asked.includes('还没保存') && t.$('ovGame').classList.contains('show')
     && t.win.eval('db.ledgers[0].games.length') === 0,
     '★ 点遮罩时拦住了并说明「还没保存」；取消后面板仍开着，数据没落盘');
  eq(confirmCount, 1, '点遮罩确认累计 1 次');
  checkFailureUnchanged(t, beforeClose, '取消遮罩关闭');
  t.click(t.q('[data-i="0"][data-f="buy"]').closest('.sheet').querySelector('[data-close]'));
  eq(confirmCount, 2, '点 × 确认累计 2 次');
  ok(t.$('ovGame').classList.contains('show'), '点 × 也被拦下');
  checkFailureUnchanged(t, beforeClose, '取消 × 关闭');
  t.win.document.dispatchEvent(new t.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  eq(confirmCount, 3, 'Esc 确认累计 3 次');
  ok(t.$('ovGame').classList.contains('show'), '★ Esc 也被拦下');
  checkFailureUnchanged(t, beforeClose, '取消 Esc 关闭');
  t.close();

  // 只有「打开没填」→ 不打扰，直接关
  const t2 = boot();
  let asked2 = false;
  t2.win.confirm = () => { asked2 = true; return true; };
  t2.click(t2.$('btnAddGame'));
  t2.win.closeSheet('ovGame', true);
  t2.win.openGameSheet(null);
  t2.win.document.dispatchEvent(new t2.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  ok(!asked2 && !t2.$('ovGame').classList.contains('show'), '★ 真正未触碰的新面板关闭不弹确认（不打扰）');
  t2.close();

  // 保存成功后关闭不弹确认（force 生效）
  const t3 = boot();
  stageGame(t3);
  t3.fill(t3.prows()[0], { buy: '300', value: '385' });
  let asked3 = false;
  t3.win.confirm = () => { asked3 = true; return true; };
  t3.click(t3.$('btnSaveGame'));
  ok(!asked3 && !t3.$('ovGame').classList.contains('show') && t3.raw().ledgers[0].games.length === 1,
     '★ 保存后关闭不问「要不要丢数据」，牌局已落盘');
  t3.close();
}

section('P. 写盘失败与失败原子性');
{
  // 保存失败：旧存档、运行态、草稿、面板必须全部原样
  const t = boot(seedOneLedger());
  stageGame(t);
  const oldRaw = t.seedRaw();
  t.fill(t.prows()[0], { buy: '300', value: '385' });
  const beforeSave = failureSnapshot(t);
  t.setFailWrites(key => key === 'poker-ledger:v1');
  t.click(t.$('btnSaveGame'));
  checkFailureUnchanged(t, beforeSave, '新牌局保存失败');
  ok(t.seedRaw() === oldRaw && t.mem('db.ledgers[0].games.length') === 0,
     '★ 保存失败不覆盖旧存档，运行态也不增加牌局（落盘成功才替换运行状态）');
  eq([t.fieldIn(0, 'buy'), t.fieldIn(0, 'value'), t.$('ovGame').classList.contains('show')].join(','),
     '300,385,true', '★ 保存失败保留买入与结余草稿，录入面板保持打开');
  ok(!t.$('alertBar').hidden, '★ 保存失败出现常驻告警条（不是静默失败）');
  t.close();

  // 告警条：无可导出原件时按钮隐藏，「知道了」能关掉
  const t2 = boot();
  t2.win.eval('saveBroken = true; render();');
  const shown = !t2.$('alertBar').hidden;
  const noOriginal = t2.$('btnAlertExport').hidden;
  t2.click(t2.$('btnAlertDismiss'));
  ok(shown && noOriginal && t2.$('alertBar').hidden,
     '★ 写盘失败时告警条出现、无原件时导出按钮隐藏、「知道了」可关闭');
  t2.close();

  // 编辑保存失败：整个运行数据库不变，解除故障后重试成功
  const seedEdit = { 'poker-ledger:v1': JSON.stringify({
    version: 1, currentId: 'L', ledgers: [{ id: 'L', name: '旧', players: [{ id: 'p1', name: '老王' }], games: [{
      id: 'g1', date: '2026-01-01', entries: [{ playerId: 'p1', playerName: '老王', buys: [10000], balance: 12000 }],
    }] }],
  }) };
  const t3 = boot(seedEdit);
  t3.win.openGameSheet('g1');
  t3.set(t3.field(t3.prows()[0], 'value'), '130');
  const beforeEdit = failureSnapshot(t3);
  t3.setFailWrites(key => key === 'poker-ledger:v1');
  t3.click(t3.$('btnSaveGame'));
  checkFailureUnchanged(t3, beforeEdit, '编辑保存失败');
  ok(t3.mem('JSON.stringify({db, currentId})') === beforeEdit.db && t3.$('ovGame').classList.contains('show'),
     '★ 编辑保存失败前后整个运行数据库不变，面板保持打开');
  t3.setFailWrites(false);
  t3.click(t3.$('btnSaveGame'));
  eq(t3.raw().ledgers[0].games[0].entries[0].balance, 13000, '★ 解除故障后编辑重试成功');
  t3.close();

  // —— 其余写盘失败路径：每条都必须「运行态没变 + 存储没变 + UI 没成功态」——
  const seedTwo = { 'poker-ledger:v1': JSON.stringify({
    version: 1, currentId: 'A', ledgers: [
      { id: 'A', name: '甲', players: [], games: [] },
      { id: 'B', name: '乙', players: [], games: [] },
    ],
  }) };

  const t4 = boot();
  const raw4 = t4.seedRaw();
  t4.win.prompt = () => '失败账本';
  t4.setFailWrites(key => key === 'poker-ledger:v1');
  t4.click(t4.$('btnLedgers'));
  const beforeNewLedger = failureSnapshot(t4);
  t4.click(t4.$('btnNewLedger'));
  checkFailureUnchanged(t4, beforeNewLedger, '新建账本失败');
  ok(t4.seedRaw() === raw4 && t4.mem('db.ledgers.length') === 1
     && t4.$('ledgerSelect').options.length === 1,
     '★ 新建账本写盘失败：存储、运行态、UI 都不增加账本');
  t4.close();

  const t5 = boot(seedTwo);
  const raw5 = t5.seedRaw();
  t5.win.confirm = () => true;
  t5.setFailWrites(key => key === 'poker-ledger:v1');
  t5.click(t5.$('btnLedgers'));
  const beforeSwitch = failureSnapshot(t5);
  t5.click(t5.qa('[data-ledger="B"]')[0]);
  checkFailureUnchanged(t5, beforeSwitch, '切换账本失败');
  ok(t5.seedRaw() === raw5 && t5.mem('currentId') === 'A' && t5.$('ledgerSelect').value === 'A',
     '★ 切换账本写盘失败：存储、运行态、UI 都停在原账本');
  t5.close();

  const t6 = boot(seedTwo);
  const raw6 = t6.seedRaw();
  t6.win.confirm = () => true;
  t6.setFailWrites(key => key === 'poker-ledger:v1');
  t6.click(t6.$('btnLedgers'));
  const beforeDelLedger = failureSnapshot(t6);
  t6.click(t6.$('btnDelLedger'));
  checkFailureUnchanged(t6, beforeDelLedger, '删除账本失败');
  ok(t6.seedRaw() === raw6 && t6.mem('db.ledgers.length') === 2 && t6.mem('currentId') === 'A',
     '★ 删除账本写盘失败：账本与 currentId 都保持旧值');
  t6.close();

  const seedPlayer = { 'poker-ledger:v1': JSON.stringify({
    version: 1, currentId: 'L', ledgers: [{ id: 'L', name: 'L', players: [{ id: 'p', name: '老王' }], games: [] }],
  }) };
  const t7 = boot(seedPlayer);
  const raw7 = t7.seedRaw();
  t7.win.confirm = () => true;
  t7.setFailWrites(key => key === 'poker-ledger:v1');
  t7.click(t7.$('btnPlayers'));
  const beforeDelPlayer = failureSnapshot(t7);
  t7.click(t7.q('[data-rmp="p"]'));
  checkFailureUnchanged(t7, beforeDelPlayer, '删除人员失败');
  ok(t7.seedRaw() === raw7 && t7.mem('db.ledgers[0].players.length') === 1, '★ 删除人员写盘失败：人员仍在');
  t7.close();

  const t8 = boot(seedPlayer);
  const raw8 = t8.seedRaw();
  t8.setFailWrites(true);
  t8.click(t8.$('btnPlayers'));
  t8.set(t8.$('inPlayerName'), '不应成功');
  const beforeAddPlayer = failureSnapshot(t8);
  t8.click(t8.$('btnAddPlayer'));
  checkFailureUnchanged(t8, beforeAddPlayer, '创建人员失败');
  ok(t8.seedRaw() === raw8 && t8.mem('db.ledgers[0].players.length') === 1, '★ 创建人员写盘失败：不增加人员、不改存档');
  t8.close();

  // 选人面板里「新建并选中」失败：不清空输入、不产生成功选中态
  const t9 = boot(seedPlayer);
  t9.click(t9.$('btnAddGame'));
  t9.click(t9.$('btnAddRow'));
  t9.set(t9.$('inNewPlayerName'), '写盘失败新人');
  t9.setFailWrites(true);
  const beforeAddPick = failureSnapshot(t9);
  t9.click(t9.$('btnAddPlayerThenPick'));
  checkFailureUnchanged(t9, beforeAddPick, '新建并选中失败');
  ok(t9.$('inNewPlayerName').value === '写盘失败新人' && t9.mem('db.ledgers[0].players.length') === 1
     && t9.qa('#pickList .pick.on').length === 0,
     '★ 新建并选中写盘失败：输入保留、不加人、不产生成功选中状态');
  t9.close();

  const seedGame = { 'poker-ledger:v1': JSON.stringify({
    version: 1, currentId: 'A', ledgers: [
      { id: 'A', name: '甲', players: [{ id: 'p', name: '甲员' }], games: [{ id: 'g', date: '2026-01-01', entries: [] }] },
      { id: 'B', name: '乙', players: [], games: [] },
    ],
  }) };
  const t10 = boot(seedGame);
  const raw10 = t10.seedRaw();
  t10.win.confirm = () => true;
  t10.setFailWrites(key => key === 'poker-ledger:v1');
  t10.click(t10.$('headGames'));
  t10.click(t10.q('[data-toggle="g"]'));
  const beforeDelGame = failureSnapshot(t10);
  t10.click(t10.q('[data-del="g"]'));
  checkFailureUnchanged(t10, beforeDelGame, '删除牌局失败');
  ok(t10.seedRaw() === raw10 && t10.mem('db.ledgers[0].games.length') === 1, '★ 删除牌局写盘失败：牌局仍在');
  t10.click(t10.$('btnData'));
  const beforeClear = failureSnapshot(t10);
  t10.click(t10.$('btnClearGames'));
  checkFailureUnchanged(t10, beforeClear, '清空牌局失败');
  ok(t10.seedRaw() === raw10 && t10.mem('db.ledgers[0].games.length') === 1, '★ 清空牌局写盘失败：旧牌局保留、存档不变');
  t10.close();

  const t12 = boot(seedOneLedger());
  const raw12 = t12.seedRaw();
  const importRaw = JSON.stringify({ version: 1, currentId: 'N', ledgers: [{ id: 'N', name: '新', players: [], games: [] }] });
  t12.win.confirm = () => true;
  t12.stubFileReader();
  t12.setFailWrites(key => key === 'poker-ledger:v1' || key.startsWith('poker-ledger:v1:before-import:'));
  const beforeImport = failureSnapshot(t12);
  t12.win.importData({ text: importRaw });
  checkFailureUnchanged(t12, beforeImport, '导入写盘失败');
  ok(t12.seedRaw() === raw12 && t12.mem('db.currentId') === 'L' && t12.$('ledgerSelect').value === 'L',
     '★ 导入写盘失败：不覆盖旧存档、不切换 currentId、UI 保持旧账本');
  t12.close();
}

section('Q. 损坏存档保护与恢复副本');
{
  const good = '{"version":1,"currentId":"L","ledgers":[{"id":"L","name":"我的账本","players":[{"id":"p1","name":"老王"}],"games":[{"id":"g1","date":"2026-10-01","entries":[{"playerId":"p1","playerName":"老王","buyIn":30000,"balance":38500}]}]}]}';
  const truncated = good.slice(0, good.length - 3);

  // 损坏后：出现常驻告警条，并把原件另存一份（可导出，不能被空账本覆盖）
  const t = boot({ 'poker-ledger:v1': truncated });
  const kept = [...t.store.keys()].filter(k => k.startsWith('poker-ledger:v1:broken:'));
  ok(!t.$('alertBar').hidden && kept.length === 1 && t.store.get(kept[0]) === truncated,
     '★ 损坏后出现告警条，原件被逐字节另存一份副本');
  ok(!t.$('btnAlertExport').hidden, '告警条上有「导出原始数据」按钮');
  let clicked = null;
  const origCreate = t.win.URL.createObjectURL;
  t.win.URL.createObjectURL = b => { clicked = b.parts[0]; return 'blob:x'; };
  t.click(t.$('btnAlertExport'));
  t.win.URL.createObjectURL = origCreate;
  eq(clicked, truncated, '★ 点导出拿到的正是损坏原文');
  t.close();

  const okBoot = boot({ 'poker-ledger:v1': good });
  ok(okBoot.$('alertBar').hidden, '存档正常时不显示告警条');
  okBoot.close();

  // ★ 副本写入失败时，损坏主存档绝不被业务写入覆盖
  const broken = '{"version":1,"ledgers":[';
  const t2 = boot({ 'poker-ledger:v1': broken }, {
    failSetItem: key => key.startsWith('poker-ledger:v1:broken:'),
  });
  t2.click(t2.$('btnPlayers'));
  t2.set(t2.$('inPlayerName'), '可以保存');
  const beforeArchiveFailure = failureSnapshot(t2);
  t2.click(t2.$('btnAddPlayer'));
  checkFailureUnchanged(t2, beforeArchiveFailure, '损坏原件副本写失败');
  eq(t2.store.get('poker-ledger:v1'), broken, '★ 副本写入失败时，损坏主存档不被业务写入覆盖');

  // 解除 archive 故障后，业务写入恢复正常
  t2.setFailWrites(false);
  t2.set(t2.$('inPlayerName'), '恢复后可保存');
  t2.click(t2.$('btnAddPlayer'));
  ok(t2.store.get('poker-ledger:v1') !== broken, '★ 恢复 archive 写权限后主存档可通过业务写入更新');

  // 再撞一次新的损坏原件：archive 写失败时仍不能覆盖主 key
  for (const key of [...t2.store.keys()]) {
    if (key.startsWith('poker-ledger:v1:broken:')) t2.store.delete(key);
  }
  t2.setFailWrites(key => key.startsWith('poker-ledger:v1:broken:'));
  t2.store.set('poker-ledger:v1', broken);
  t2.win.eval('brokenRaw = ' + JSON.stringify(broken) + '; brokenArchived = false;');
  t2.set(t2.$('inPlayerName'), '不会覆盖');
  const beforeRepeatArchive = failureSnapshot(t2);
  t2.click(t2.$('btnAddPlayer'));
  checkFailureUnchanged(t2, beforeRepeatArchive, '再次备份损坏原件失败');
  eq(t2.store.get('poker-ledger:v1'), broken, '★ 无法备份损坏原件时不覆盖损坏主存档');
  t2.close();

  // 恢复副本：持久化列表 + 去重 + 可从数据面板导出
  const first = boot({ 'poker-ledger:v1': broken });
  const keys1 = [...first.store.keys()].filter(k => k.startsWith('poker-ledger:v1:broken:'));
  eq(keys1.length, 1, '首次启动持久化一份损坏恢复副本');
  const persisted = Object.fromEntries(first.store);
  first.close();
  const second = boot(persisted);
  const keys2 = [...second.store.keys()].filter(k => k.startsWith('poker-ledger:v1:broken:'));
  eq(keys2.length, 1, '★ 重载恢复列表不重复写入相同原件（去重）');
  const archiveRaw = second.store.get(keys2[0]);
  const exported = second.captureBlob();
  const dl = second.captureDownload();
  second.click(second.$('btnData'));
  const recovery = second.$('recoveryList');
  const archiveButtons = second.qa('#recoveryList button');
  ok(recovery && recovery.textContent.includes('损坏') && archiveButtons.length >= 1,
     '数据面板显示持久化恢复列表并提供导出按钮');
  if (archiveButtons[0]) {
    second.click(archiveButtons[0]);
    eq(exported.get().text, archiveRaw, '★ 恢复副本导出内容逐字节一致');
  }
  exported.restore();
  dl.restore();
  second.close();
}

section('R. 导入校验与导入前快照');
{
  const base = { version: 1, currentId: 'L', ledgers: [{ id: 'L', name: '旧', players: [], games: [] }] };
  // 每一类非法结构都必须被整体拒绝，分别比较存储与完整内存数据库。
  const cases = [
    ['嵌套对象', { ...base, ledgers: [{ ...base.ledgers[0], players: [{}] }] }],
    ['null 人员', { ...base, ledgers: [{ ...base.ledgers[0], players: null }] }],
    ['entries 是对象', { ...base, ledgers: [{ ...base.ledgers[0], games: [{ id: 'g', date: '2026-01-01', entries: {} }] }] }],
    ['危险账本 ID', { ...base, ledgers: [{ ...base.ledgers[0], id: '=L' }] }],
    ['ID 属性注入', { ...base, ledgers: [{ ...base.ledgers[0], id: 'L" onmouseover="x' }] }],
    ['危险人员 ID', { ...base, ledgers: [{ ...base.ledgers[0], players: [{ id: '@p', name: '坏' }] }] }],
    ['重复账本 ID', { ...base, ledgers: [{ id: 'L', name: '一' }, { id: 'L', name: '二' }] }],
    ['重复明细 ID', { ...base, ledgers: [{ ...base.ledgers[0], games: [{ id: 'g', date: '2026-01-01', entries: [{ playerId: 'p' }, { playerId: 'p' }] }] }] }],
    ['非法日期', { ...base, ledgers: [{ ...base.ledgers[0], games: [{ id: 'g', date: '2026-02-30', entries: [] }] }] }],
    ['非法金额', { ...base, ledgers: [{ ...base.ledgers[0], games: [{ id: 'g', date: '2026-01-01', entries: [{ playerId: 'p', buys: [1.5], balance: 0 }] }] }] }],
    ['不安全金额', { ...base, ledgers: [{ ...base.ledgers[0], games: [{ id: 'g', date: '2026-01-01', entries: [{ playerId: 'p', buys: [Number.MAX_SAFE_INTEGER], balance: 0 }] }] }] }],
    ['不支持版本', { ...base, version: 2 }],
  ];
  const rejected = [];
  for (const [label, bad] of cases) {
    const t = boot({ 'poker-ledger:v1': JSON.stringify(base) });
    const before = failureSnapshot(t);
    t.win.confirm = () => true;
    t.stubFileReader();
    t.win.importData({ text: JSON.stringify(bad) });
    checkFailureUnchanged(t, before, `非法导入 ${label}`);
    rejected.push(t.seedRaw() === before.raw && t.raw().ledgers[0].name === '旧');
    t.close();
  }
  ok(rejected.length === cases.length && rejected.every(Boolean),
     `★ ${cases.length} 类非法导入全部被拒，一个字节都没写进存储（` + cases.map(c => c[0]).join('、') + '）');

  // 合法快照导入成功，且导入前先持久化一份旧数据备份
  const imported = { version: 1, currentId: 'N', ledgers: [{ id: 'N', name: '快照', players: [{ id: 'p', name: '快' }], games: [] }] };
  const t2 = boot({ 'poker-ledger:v1': JSON.stringify(base) });
  t2.win.confirm = () => true;
  t2.stubFileReader();
  t2.win.importData({ text: JSON.stringify(imported) });
  eq([t2.raw().currentId, t2.raw().ledgers[0].name,
      [...t2.store.keys()].filter(k => k.startsWith('poker-ledger:v1:before-import:')).length].join(','),
     'N,快照,1', '★ 合法快照导入后数据替换，且导入前持久化了一份旧数据备份');
  t2.close();

  // 快照写盘失败 → 整体中止（不能出现「数据换了但旧数据没备份」）
  const t3 = boot({ 'poker-ledger:v1': JSON.stringify(base) });
  const oldRaw3 = t3.seedRaw();
  t3.win.confirm = () => true;
  t3.stubFileReader();
  t3.setFailWrites(key => key.startsWith('poker-ledger:v1:before-import:'));
  const beforeSnapshot = failureSnapshot(t3);
  t3.win.importData({ text: JSON.stringify(imported) });
  checkFailureUnchanged(t3, beforeSnapshot, '导入前快照写盘失败');
  ok(t3.seedRaw() === oldRaw3 && t3.raw().ledgers[0].name === '旧',
     '★ 快照写盘失败则整体中止：不覆盖旧存档、不替换数据库');
  t3.close();

  // 快照成功，但主 KEY 写失败：快照保留，旧数据库与草稿不能提前替换。
  const t4 = boot(seedOneLedger());
  stageGame(t4);
  t4.fill(t4.prows()[0], { buy: '100', value: '120' });
  t4.click(t4.$('btnData'));
  const beforeMainWrite = failureSnapshot(t4);
  t4.win.confirm = () => true;
  t4.stubFileReader();
  const writes = [];
  t4.setFailWrites(key => { writes.push(key); return key === 'poker-ledger:v1'; });
  t4.win.importData({ text: JSON.stringify(imported) });
  const snapshots = [...t4.store.keys()].filter(k => k.startsWith('poker-ledger:v1:before-import:'));
  ok(snapshots.length === 1 && t4.store.get(snapshots[0]) === beforeMainWrite.raw,
     '★ 导入前快照写成功且逐字节保留旧数据');
  ok(writes.length === 2 && writes[0] === snapshots[0] && writes[1] === 'poker-ledger:v1',
     '★ 导入确实先写快照成功，再尝试主 KEY 并失败');
  checkFailureUnchanged(t4, beforeMainWrite, '导入快照成功但主 KEY 写失败');
  ok(t4.$('ledgerSelect').value === 'L' && t4.$('ovData').classList.contains('show')
     && t4.$('ovGame').classList.contains('show'), '★ 导入主 KEY 写失败保持旧账本和打开的面板');
  t4.close();
}

section('S. CSV 公式注入防护');
{
  const safeState = {
    version: 1, currentId: 'L', ledgers: [{ id: 'L', name: 'CSV', players: [{ id: 'p', name: '=2+2' }], games: [{
      id: 'g', date: '2026-01-01', entries: [{ playerId: 'p', playerName: '=2+2', buys: [100], balance: 100 }],
    }] }],
  };
  const t = boot({ 'poker-ledger:v1': JSON.stringify(safeState) });
  const csv = t.captureBlob();
  t.click(t.$('btnData'));
  t.click(t.$('btnExportCsv'));
  csv.restore();
  ok(csv.get().text.includes("'=2+2"), '★ CSV 对公式前缀姓名增加文本前缀');
  t.close();
}

section('T. 启动读取失败不得覆盖未知原件');
{
  const old = JSON.stringify({ version: 1, currentId: 'L', ledgers: [{ id: 'L', name: '原账本', players: [], games: [] }] });
  const t = boot({ 'poker-ledger:v1': old });
  const get = t.win.localStorage.getItem;
  t.win.localStorage.getItem = key => { if (key === 'poker-ledger:v1') throw new Error('read denied'); return get(key); };
  t.win.eval('db = load(); currentId = db.currentId; render();');
  t.win.localStorage.getItem = get;
  // 读失败意味着我们并不知道存储里是什么 —— 这时任何写入都可能覆盖掉真数据
  const beforeReadGuard = failureSnapshot(t);
  t.win.createPlayer('不能覆盖');
  checkFailureUnchanged(t, beforeReadGuard, '读取失败后禁止覆盖');
  ok(t.seedRaw() === old && t.mem('db.ledgers[0].players.length') === 0,
     '★ 读取曾失败，即便写权限存在也不覆盖未知旧原件；新建失败不虚假提交');
  t.close();
}

section('U. 渲染健壮性：转义 / 缺失字段 / 历史姓名快照');
{
  // 人员名含 HTML 特殊字符，必须被转义而非注入
  const t = boot();
  t.click(t.$('btnPlayers'));
  t.set(t.$('inPlayerName'), '<img src=x onerror=alert(1)>');
  t.click(t.$('btnAddPlayer'));
  t.click(t.qa('.sheet-close').find(b => b.dataset.close === 'ovPlayers'));
  ok(t.doc.querySelectorAll('img').length === 0
     && t.$('plist').textContent.includes('<img') && t.$('rankList').textContent.includes('<img'),
     '★ 恶意姓名未被注入为 HTML，人员列表与排行榜都按纯文本显示');
  // 空账本名不应导致 select 崩溃
  const d = t.raw();
  d.ledgers[0].name = '';
  const t2 = boot({ 'poker-ledger:v1': JSON.stringify(d) });
  eq(t2.$('ledgerSelect').options.length, 1, '空名账本可正常渲染');
  t2.close();

  // 缺失姓名不再显示 undefined
  const t3 = boot();
  t3.win.eval(`db.ledgers[0].players = [];
               db.ledgers[0].games = [{id:'g1',date:'2026-10-01',entries:[{playerId:'pX',balance:10000}]}];
               render();`);
  const rankName = t3.q('.rank-name').textContent;
  ok(rankName && rankName !== 'undefined' && rankName !== 'null'
     && !visibleText(t3.doc).includes('undefined'), '★ 排行榜与整页都不显示字面量 undefined');
  t3.close();
  t.close();

  // 历史姓名快照：删掉人员后历史牌局仍要能读、能编辑
  const seedHist = { 'poker-ledger:v1': JSON.stringify({
    version: 1, currentId: 'B', ledgers: [
      { id: 'A', name: '甲', players: [], games: [] },
      { id: 'B', name: '乙', players: [{ id: 'p', name: '历史名' }], games: [{
        id: 'g', date: '2026-01-01', entries: [{ playerId: 'p', playerName: '历史名', buys: [10000], balance: 10000 }],
      }] },
    ],
  }) };
  const t4 = boot(seedHist);
  t4.click(t4.$('headGames'));
  t4.click(t4.q('[data-toggle="g"]'));
  t4.click(t4.$('btnPlayers'));
  t4.win.confirm = () => true;
  t4.click(t4.q('[data-rmp]'));
  t4.click(t4.q('[data-close="ovPlayers"]'));
  ok(t4.raw().currentId === 'B' && t4.$('gameList').textContent.includes('历史名'),
     '★ 启动恢复持久化 currentId；删除人员后历史牌局仍保留姓名');
  t4.win.eval('db.ledgers[1].players = [{id:"p",name:"历史名"}]; currentId = "B"; render();');

  // dirty 检测的粒度：哪些改动算「有未保存内容」
  let asked = 0;
  t4.win.confirm = () => { asked++; return false; };
  t4.win.openGameSheet('g');
  ok(t4.$('ovGame').classList.contains('show'), '★ 删人后的历史牌局仍可打开编辑');
  t4.click(t4.q('#ovGame [data-close="ovGame"]'));
  eq(asked, 0, '★ dirty：不改内容关闭，确认累计 0 次');
  ok(!t4.$('ovGame').classList.contains('show'), '未改内容直接关闭');
  t4.win.closeSheet('ovGame', true);
  t4.win.openGameSheet('g');
  t4.set(t4.q('#inDate'), '2026-01-02');
  const beforeDateClose = failureSnapshot(t4);
  t4.click(t4.q('#ovGame [data-close="ovGame"]'));
  eq(asked, 1, '★ dirty：改日期后关闭，确认累计 1 次');
  ok(t4.$('ovGame').classList.contains('show'), '取消丢弃日期修改后面板保持打开');
  checkFailureUnchanged(t4, beforeDateClose, '取消丢弃日期修改');
  t4.win.closeSheet('ovGame', true);
  eq(asked, 1, '强制关闭不额外询问，确认累计仍为 1 次');
  t4.win.openGameSheet('g');
  t4.set(t4.q('#inBuyDefault'), '20');
  const beforeDefaultClose = failureSnapshot(t4);
  t4.click(t4.q('#ovGame [data-close="ovGame"]'));
  eq(asked, 2, '★ dirty：改本局买入后关闭，确认累计 2 次');
  ok(t4.$('ovGame').classList.contains('show'), '取消丢弃本局买入修改后面板保持打开');
  checkFailureUnchanged(t4, beforeDefaultClose, '取消丢弃本局买入修改');
  t4.win.closeSheet('ovGame', true);
  eq(asked, 2, '再次强制关闭不额外询问，确认累计仍为 2 次');
  t4.win.openGameSheet('g');
  const del = t4.q('.prow .del');
  ok(!!del, '历史牌局存在可删除录入行');
  t4.click(del);
  eq(t4.prows().length, 0, 'dirty 场景确实删光录入行');
  const beforeDeleteClose = failureSnapshot(t4);
  t4.click(t4.q('#ovGame [data-close="ovGame"]'));
  eq(asked, 3, '★ dirty：删光行后关闭，确认累计 3 次');
  ok(t4.$('ovGame').classList.contains('show'), '取消丢弃删行修改后面板保持打开');
  checkFailureUnchanged(t4, beforeDeleteClose, '取消丢弃删行修改');
  t4.close();
}

/* ===========================================================================
 * 汇总
 * ======================================================================== */
closeAllWindows();

console.log(`\n${'='.repeat(56)}`);
console.log('分节断言数');
for (const s of sections) {
  console.log(`  ${String(s.pass + s.fail).padStart(3)}  ${s.title}`);
}
console.log(`${'='.repeat(56)}`);
console.log(`断言总数 ${pass + fail}　通过 ${pass}　失败 ${fail}`);
if (fail > 0) { console.log('存在失败项'); process.exit(1); }
console.log('全部通过');
