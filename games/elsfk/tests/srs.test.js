// SRS 踢墙表回归测试
// 标准数据来源：Tetris Wiki — Super Rotation System
//   https://tetris.wiki/SRS
// 约定：x 向右为正，y 向上为正；代码应用为 currentX += k[0]; currentY -= k[1];
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractTable(name) {
    const m = html.match(new RegExp(`const ${name} = (\\{[^;]*\\});`));
    if (!m) throw new Error(`未在 index.html 中找到 ${name}`);
    return eval('(' + m[1] + ')');
}

// 官方 JLSTZ 表（Tetris Wiki）
const CANON_JLSTZ = {
    '0>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    '1>0': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    '1>2': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    '2>1': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    '2>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
    '3>2': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    '3>0': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    '0>3': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
};
// 官方 I 表（Tetris Wiki）
const CANON_I = {
    '0>1': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    '1>0': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    '1>2': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
    '2>1': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    '2>3': [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    '3>2': [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    '3>0': [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    '0>3': [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
};

let pass = 0, fail = 0;
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log(`  ✗ ${name}\n      期望 ${e}\n      实际 ${a}`); }
}

console.log('\n【SRS】踢墙表与官方规范一致性');
const wkJ = extractTable('WK_JLSTZ');
const wkI = extractTable('WK_I');
for (const key of Object.keys(CANON_JLSTZ)) check(`JLSTZ ${key}`, wkJ[key], CANON_JLSTZ[key]);
for (const key of Object.keys(CANON_I)) check(`I     ${key}`, wkI[key], CANON_I[key]);

console.log('\n【SRS】旋转状态覆盖完整（8 种转换）');
const expectedKeys = ['0>1','1>0','1>2','2>1','2>3','3>2','3>0','0>3'];
check('JLSTZ 键集合', Object.keys(wkJ).sort(), expectedKeys.slice().sort());
check('I 键集合', Object.keys(wkI).sort(), expectedKeys.slice().sort());

console.log('\n【SRS】踢墙项数量为 5（基础旋转 + 4 次尝试）');
for (const key of expectedKeys) {
    check(`JLSTZ ${key} 项数`, wkJ[key].length, 5);
    check(`I ${key} 项数`, wkI[key].length, 5);
}

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
