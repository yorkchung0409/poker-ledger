/**
 * 从 index.html 中抽取纯逻辑函数并测试。
 * 直接读真实代码，避免测的是副本而实际跑的又不是它。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

/**
 * 抽取 index.html 里的纯函数测试。
 *
 * 需要跨两段取：
 *   段一：金额工具（parseCents / fmt*），从 `const KEY =` 到数据层初始化 `let db = load()`
 *   段二：计算函数（normalizeEntry / gameStats / pairDebts），从「计算」分区注释到 `function totals()`
 *
 * 中间那段（load/save/ledger 等）依赖 localStorage 与全局状态，跳过它。
 * 只取不依赖全局状态的纯函数，保证测的是线上真正跑的那份代码。
 */
const cut = (fromMarker, toMarker) => {
  const a = html.indexOf(fromMarker);
  const b = toMarker ? html.indexOf(toMarker, a) : html.length;
  if (a < 0 || b < 0 || b <= a) {
    console.error(`FAIL: 抽取失败 —— 找不到 "${fromMarker}" 到 "${toMarker}"`);
    process.exit(1);
  }
  return html.slice(a, b);
};

const segUtil = cut('const KEY =', 'let db = load()');
const segCalc = cut('function normalizeEntry(', 'function totals()');
const segCalcHead = 'function normalizeEntry(';

// 包一层函数，这样 return 才合法（顶层 return 是语法错误）
const code = `(function (crypto, localStorage) {
${segUtil.replace(/const KEY = [^\n]*\n/, '')}
${segCalcHead}${segCalc.slice(segCalcHead.length)}
return { parseCents, fmtCents, fmtSigned, fmtCompact, todayStr, normalizeEntry, gameStats };
})`;

const sandbox = { crypto: { randomUUID: () => 'test-uuid' }, localStorage: null, Date, console };
const api = vm.runInNewContext(code, sandbox)(sandbox.crypto, sandbox.localStorage);
const { parseCents, fmtCents, fmtSigned, fmtCompact, normalizeEntry, gameStats } = api;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL ${label}`); }
}
function eq(actual, expected, label) {
  if (Object.is(actual, expected)) { pass++; }
  else { fail++; console.log(`  FAIL ${label}\n       期望 ${expected}，实际 ${actual}`); }
}

console.log('=== parseCents 解析 ===');
eq(parseCents('0'), 0, '零');
eq(parseCents(''), 0, '空字符串');
eq(parseCents('   '), 0, '纯空格');
eq(parseCents('100'), 10000, '整数');
eq(parseCents('1.5'), 150, '一位小数');
eq(parseCents('1.05'), 105, '两位小数');
eq(parseCents('0.01'), 1, '最小单位');
eq(parseCents('.5'), 50, '省略整数位');
eq(parseCents('-20'), -2000, '负数');
eq(parseCents('-1.23'), -123, '负数带小数');
eq(parseCents('100.00'), 10000, '尾随零');

console.log('\n=== parseCents 拒绝非法输入（返回 NaN）===');
eq(Number.isNaN(parseCents('abc')), true, '字母');
eq(Number.isNaN(parseCents('1.234')), true, '三位小数（必须拒绝）');
eq(Number.isNaN(parseCents('1.2.3')), true, '两个小数点');
eq(Number.isNaN(parseCents('1e5')), true, '科学计数法');
eq(Number.isNaN(parseCents('--5')), true, '双负号');
eq(Number.isNaN(parseCents('1,000')), true, '千分位逗号');
eq(Number.isNaN(parseCents('¥100')), true, '带货币符号');

console.log('\n=== fmtCents 格式化 ===');
eq(fmtCents(0), '0.00', '零');
eq(fmtCents(5), '0.05', '分位');
eq(fmtCents(100), '1.00', '整元');
eq(fmtCents(123456), '1234.56', '多位');
eq(fmtCents(-123456), '-1234.56', '负数');
eq(fmtCents(10), '0.10', '前导零');

console.log('\n=== fmtSigned 符号 ===');
eq(fmtSigned(0), '0.00', '零不带符号');
eq(fmtSigned(5000), '+50.00', '正数带 +');
eq(fmtSigned(-5000), '-50.00', '负数带 -');

console.log('\n=== fmtCompact 紧凑显示 ===');
eq(fmtCompact(0), '0', '零');
eq(fmtCompact(10000), '100', '整元省略小数');
eq(fmtCompact(1050), '10.50', '非整元保留两位');
eq(fmtCompact(-10000), '-100', '负整元');

console.log('\n=== 浮点陷阱回归（0.1+0.2 类问题）===');
// 经典浮点错误：0.1 + 0.2 !== 0.3
eq(0.1 + 0.2 === 0.3, false, '原生浮点确实会出错（前提校验）');
// 用整数分则完全准确
eq(parseCents('0.1') + parseCents('0.2'), parseCents('0.3'), '分单位 0.1+0.2=0.3');
// 典型的德州记账场景：多人数金额累加。原生浮点得 1335.1999999999998，分单位得精确 1335.20
const amounts = ['0.1', '0.2', '0.3', '1234.56', '0.05', '99.99'];
const sumCents = amounts.reduce((s, a) => s + parseCents(a), 0);
eq(sumCents, parseCents('1335.20'), '6 笔金额累加精确');
eq(amounts.reduce((s, a) => s + parseFloat(a), 0) !== 1335.20, true,
   '同一组数据用原生浮点会失真（对照）');
// 反复加减不失真
let acc = 0;
for (let i = 0; i < 1000; i++) acc = acc + parseCents('0.07') - parseCents('0.07');
eq(acc, 0, '1000 次加减后归零');

console.log('\n=== 零和校验逻辑（用真实 gameStats）===');
// 直接调用 index.html 里的真实实现。它接收牌局对象，内部经 entriesOf 归一化。
const game = (...nets) => ({ entries: nets.map(n => ({ netProfit: n, buys: [], balance: n })) });

// 一场平衡的牌局：赢 500 / 输 500
const okGame = game(parseCents('300'), parseCents('200'), parseCents('-500'));
eq(gameStats(okGame).balanced, true, '平衡牌局判定');
eq(gameStats(okGame).flow, 50000, '流水 = 赢家净盈亏之和');
eq(gameStats(okGame).diff, 0, '平衡时差额为 0');

// 不平衡：有人凭空多出 100
const badGame = game(parseCents('300'), parseCents('200'), parseCents('-400'));
eq(gameStats(badGame).balanced, false, '不平衡牌局被识别');
eq(gameStats(badGame).diff, 10000, '差额 = 100');
eq(gameStats(badGame).win, 50000, '赢方合计');
eq(gameStats(badGame).loss, 40000, '输方合计');

// 全员零盈亏（练牌局）
eq(gameStats(game(0, 0)).balanced, true, '全员打平视为平衡');
// 空牌局
eq(gameStats(game()).balanced, true, '空牌局不报错');
// 只有一人赢钱（其余为 0）—— 必然不平衡
eq(gameStats(game(parseCents('10'), 0)).balanced, false, '单人赢钱必然不平衡');

console.log('\n=== 录入模式换算（结余 <-> 盈亏）===');
// 按结余录入：买入 100，结余 300 -> 盈亏 +200
const buyInC = parseCents('100'), balanceC = parseCents('300');
eq(balanceC - buyInC, parseCents('200'), '结余模式算盈亏');
// 换成盈亏模式：买入 100，盈亏 +200 -> 结余 300
eq(buyInC + parseCents('200'), balanceC, '盈亏模式算结余');
// 亏损场景：买入 200，结余 50 -> 盈亏 -150
eq(parseCents('50') - parseCents('200'), parseCents('-150'), '亏损换算');

console.log('\n=== normalizeEntry 买入归一化（buys 单一事实来源）===');
{
  const base = { playerId: 'p', playerName: 'X' };

  // 单笔买入
  const a = normalizeEntry({ ...base, buys: [10000], balance: 30000 });
  eq(a.buys.length, 1, '单笔买入保留 1 笔');
  eq(a.totalBuy, 10000, '单笔时总买入 = 该笔');
  eq(a.netProfit, 20000, '单笔时盈亏 = 结余 - 买入');

  // 多笔买入：总买入 = 各项之和
  const m = normalizeEntry({ ...base, buys: [10000, 10000, 5000, 5000], balance: 45000 });
  eq(m.buys.length, 4, '保留 4 笔买入明细');
  eq(m.totalBuy, 30000, '总买入 = 100+100+50+50');
  eq(m.netProfit, 15000, '盈亏 = 结余 - 总买入');

  // ★ 笔数不同但总额相同的两笔，总买入与盈亏必须一致
  const s1 = normalizeEntry({ ...base, buys: [30000], balance: 45000 });
  const s2 = normalizeEntry({ ...base, buys: [10000, 10000, 5000, 5000], balance: 45000 });
  eq(s1.totalBuy, s2.totalBuy, '★ 买入笔数不影响总买入');
  eq(s1.netProfit, s2.netProfit, '★ 买入笔数不影响盈亏');

  // ---- 迁移 ①：旧 {buyIn, rebuys[]} → buys[]，起始买入成为第 1 笔 ----
  const legacy1 = normalizeEntry({ ...base, buyIn: 10000, rebuys: [15000], balance: 40000 });
  eq(legacy1.buys.length, 2, '旧 buyIn+1 笔补买 → 2 笔买入');
  eq(legacy1.buys[0], 10000, '起始买入成为第 1 笔');
  eq(legacy1.buys[1], 15000, '补买成为第 2 笔');
  eq(legacy1.totalBuy, 25000, '迁移后总买入不变');
  eq(legacy1.netProfit, 15000, '迁移后盈亏不变（迁移必须无损）');

  // ---- 迁移 ②：只有 buyIn，没有 rebuys ----
  const legacy2 = normalizeEntry({ ...base, buyIn: 5000, balance: 8000 });
  eq(legacy2.buys.length, 1, '只有 buyIn 时 → 1 笔');
  eq(legacy2.totalBuy, 5000, '总买入 = 起始买入');
  eq(legacy2.netProfit, 3000, '盈亏正确');

  // ---- 迁移 ③：更老的标量 rebuy（没有 buyIn）----
  const legacy3 = normalizeEntry({ ...base, rebuy: 15000, balance: 40000 });
  eq(legacy3.buys.length, 1, '旧标量 rebuy → 1 笔');
  eq(legacy3.buys[0], 15000, '迁移后金额不变');
  eq(legacy3.totalBuy, 15000, '迁移后总买入不变');
  eq(legacy3.netProfit, 25000, '迁移后盈亏不变');

  // ---- 迁移 ④：什么买入字段都没有 ----
  const none = normalizeEntry({ ...base, balance: 8000 });
  eq(none.buys.length, 0, '没有买入字段时明细为空');
  eq(none.totalBuy, 0, '总买入为 0');
  eq(none.netProfit, 8000, '盈亏 = 结余（没有本金）');

  // ---- 迁移幂等：已经是新格式的再归一化不变 ----
  const twice = normalizeEntry(normalizeEntry({ ...base, buys: [10000, 5000], balance: 20000 }));
  eq(twice.buys.length, 2, '★ 归一化幂等（重复调用不改变数据）');
  eq(twice.totalBuy, 15000, '★ 幂等后总买入不变');

  // 脏数据：负数、0、NaN 项被过滤
  const dirty = normalizeEntry({ ...base, buys: [5000, -100, 0, NaN, 5000], balance: 30000 });
  eq(dirty.buys.length, 2, '过滤掉负数/0/NaN 项');
  eq(dirty.totalBuy, 10000, '过滤后合计只含有效项');

  // ★ 核心不变量：买入 + 结余同步 + 同一金额 => 盈亏不变
  const before = normalizeEntry({ ...base, buys: [10000], balance: 15000 }).netProfit;
  const after = normalizeEntry({ ...base, buys: [10000, 10000], balance: 25000 }).netProfit;
  eq(before, after, '★ 追加买入 100 且结余同步 +100 时盈亏不变（核心不变量）');
  eq(after, 5000, '该不变量下的盈亏值正确');

  // ★ 撤销买入：总额与结余同步回落，盈亏仍不变
  const undone = normalizeEntry({ ...base, buys: [10000], balance: 15000 }).netProfit;
  eq(undone, after, '★ 撤销买入后盈亏回到买入前的值');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail > 0) { console.log(`失败 ${fail} 项`); process.exit(1); }
console.log('全部通过');
