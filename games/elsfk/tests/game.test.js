const fs=require('fs'), vm=require('vm');
require('./dom-stub.js');
const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx=vm.createContext(Object.assign(global,{window:global.window,document:global.document,console}));
vm.runInContext(script.replace(/window\.addEventListener\('load'[\s\S]*?\}\);\s*$/m,''),ctx,{filename:'game.js'});
const run=(code)=>vm.runInContext(code,ctx);
let pass=0,fail=0;
function t(name,fn){ try{ const r=fn(); if(r===true){pass++;console.log('  ✓ '+name);} else {fail++;console.log('  ✗ '+name+'  → '+r);} }catch(e){ fail++; console.log('  ✗ '+name+'  → 异常: '+e.message); } }
function eq(a,b){ return a===b?true:`期望 ${b}，实际 ${a}`; }
// 铺满指定行（cols 为 12）
const fillRows=(ys)=>run(`resetBoard(); for(const y of [${ys}]) for(let x=0;x<COLS;x++) board[y][x]=1; board[5][0]=1;`);

console.log('\n【1】官方计分：基础分');
t('Single = 100×level', ()=>{ fillRows('23'); run('score=0;level=1;lines=0;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();'); return eq(run('score'),100); });
t('Double = 300×level', ()=>{ fillRows('22,23'); run('score=0;level=1;lines=0;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();'); return eq(run('score'),300); });
t('Triple = 500×level', ()=>{ fillRows('21,22,23'); run('score=0;level=1;lines=0;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();'); return eq(run('score'),500); });
t('Tetris = 800×level', ()=>{ fillRows('20,21,22,23'); run('score=0;level=1;lines=0;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();'); return eq(run('score'),800); });
t('level 参与乘数（Double level3 = 900）', ()=>{ fillRows('22,23'); run('score=0;level=3;lines=0;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();'); return eq(run('score'),900); });
t('Combo 追加 50×combo×level（连续两次 = 100 + 150）', ()=>{
  fillRows('23'); run('score=0;level=1;lines=0;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();');
  const s1=run('score');
  fillRows('23');
  run('clearLines();');
  const s2=run('score');
  return (s1===100 && s2===250) ? true : `第一次 ${s1}（期望100），第二次 ${s2}（期望250）`;
});

console.log('\n【2】T-Spin 判定（3 角规则 + 前后角 + Mini/Full）');
// 经典 T-Spin Single 布局：T 位于 x=4,y=21（凸起在 (5,21)，横排 (4..6,22)）
const setupTSpin=(corners)=>{
  run(`resetBoard();
    for(let x=0;x<COLS;x++) if(!(x>=4&&x<=6)) board[22][x]=1;
    board[22][4]=0; board[22][5]=0; board[22][6]=0;
    board[21][4]=${corners.tl?1:0}; board[21][6]=${corners.tr?1:0};
    board[23][4]=${corners.bl?1:0}; board[23][6]=${corners.br?1:0};
    currentPiece={shape:SHAPES[2].shape,color:3,name:"T",rotation:0};
    currentX=4; currentY=21; lastActionWasRotation=true; lastKickDy=0;`);
};
t('最后一步不是旋转 → 不是 T-Spin', ()=>{ setupTSpin({tl:1,tr:1,bl:1,br:0}); run('lastActionWasRotation=false;'); return eq(run('detectTSpin()'),'none'); });
t('前两角 + 后一角 → 正式 T-Spin', ()=>{ setupTSpin({tl:1,tr:1,bl:1,br:0}); return eq(run('detectTSpin()'),'full'); });
t('前两角 + 后两角 → 正式 T-Spin', ()=>{ setupTSpin({tl:1,tr:1,bl:1,br:1}); return eq(run('detectTSpin()'),'full'); });
t('只有 1 个前角 + 2 个后角 → Mini T-Spin', ()=>{ setupTSpin({tl:0,tr:1,bl:1,br:1}); return eq(run('detectTSpin()'),'mini'); });
t('只占 2 角 → 不是 T-Spin', ()=>{ setupTSpin({tl:1,tr:0,bl:0,br:0}); return eq(run('detectTSpin()'),'none'); });
t('最近一次旋转纵向位移 2 格时，Mini 升级为正式 T-Spin', ()=>{ setupTSpin({tl:0,tr:1,bl:1,br:1}); run('lastKickDy=-2;'); return eq(run('detectTSpin()'),'full'); });
t('Mini T-Spin Single = 200×level', ()=>{
  setupTSpin({tl:0,tr:1,bl:1,br:1});
  run('score=0;level=1;comboCount=0;backToBack=false; tSpinType="mini"; lines=0; for(let x=0;x<COLS;x++) if(!(x>=4&&x<=6)) board[23][x]=1; board[23][4]=0;board[23][5]=0;board[23][6]=0; board[5][0]=1; merge(); clearLines();');
  return eq(run('score'),200);
});
t('正式 T-Spin Single = 800×level', ()=>{
  setupTSpin({tl:1,tr:1,bl:1,br:0});
  run('score=0;level=1;comboCount=0;backToBack=false; tSpinType="full"; lines=0; for(let x=0;x<COLS;x++) if(!(x>=4&&x<=6)) board[23][x]=1; board[23][4]=0;board[23][5]=0;board[23][6]=0; board[5][0]=1; merge(); clearLines();');
  return eq(run('score'),800);
});
t('T-Spin Double = 1200×level', ()=>{
  run(`resetBoard(); score=0;level=1;lines=0;comboCount=0;backToBack=false;
    for(let x=0;x<COLS;x++){ if(x!==5) board[21][x]=1; if(!(x>=4&&x<=6)) board[22][x]=1; }
    board[23][4]=1; board[23][6]=1; board[5][0]=1;
    currentPiece={shape:SHAPES[2].shape,color:3,name:"T",rotation:0}; currentX=4; currentY=21;
    tSpinType="full"; merge(); clearLines();`);
  return eq(run('score'),1200);
});

console.log('\n【3】Back-to-Back ×1.5');
t('连续 Tetris：800 → 1200', ()=>{
  fillRows('20,21,22,23'); run('score=0;level=1;lines=0;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();');
  const s1=run('score');
  run('comboCount=0;');                       // 中间一次未消行的锁定会断开连击
  fillRows('20,21,22,23'); run('clearLines();');
  const s2=run('score')-s1;
  return (s1===800 && s2===1200) ? true : `第一次 ${s1}，第二次增量 ${s2}`;
});
t('Single 会打断 B2B 链', ()=>{ fillRows('23'); run('tSpinType="none";comboCount=0;'); run('clearLines();'); return eq(run('backToBack'),false); });
t('T-Spin 也是「困难」消行，可触发 B2B', ()=>{ run('backToBack=true;'); fillRows('23'); run('tSpinType="full";comboCount=0;'); run('clearLines();'); return eq(run('backToBack'),true); });

console.log('\n【4】Perfect Clear');
t('B2B Tetris PC = 1200 + 3200 = 4400', ()=>{
  run('resetBoard(); for(let y=20;y<24;y++) for(let x=0;x<COLS;x++) board[y][x]=1; score=0;level=1;lines=0;comboCount=0;backToBack=true;tSpinType="none";'); run('clearLines();');
  return eq(run('score'),4400);
});
t('普通 Tetris PC = 800 + 2000 = 2800', ()=>{
  run('resetBoard(); for(let y=20;y<24;y++) for(let x=0;x<COLS;x++) board[y][x]=1; score=0;level=1;lines=0;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();');
  return eq(run('score'),2800);
});
t('非满盘时不触发 PC（Single = 100）', ()=>{
  run('resetBoard(); for(let x=0;x<COLS;x++) board[23][x]=1; board[10][0]=1; score=0;level=1;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();');
  return eq(run('score'),100);
});
t('Perfect Clear 单行 = 100 + 800 = 900', ()=>{
  run('resetBoard(); for(let x=0;x<COLS;x++) board[23][x]=1; score=0;level=1;comboCount=0;backToBack=false;tSpinType="none";'); run('clearLines();');
  return eq(run('score'),900);
});


console.log('\n【5】锁延迟不再把方块「传送」到地板');
t('锁延迟中横向移动不会下坠', ()=>{
  run('resetBoard(); currentPiece={shape:SHAPES[0].shape,color:1,name:"I",rotation:0}; currentX=4; currentY=10; isLocking=true; lockTimer=performance.now(); lockMoveCount=0;');
  const y0=run('currentY'); run('move(-1);'); return eq(run('currentY'),y0);
});
t('锁延迟中旋转不会下坠', ()=>{
  run('currentY=10; isLocking=true; lockTimer=performance.now(); lockMoveCount=0; currentPiece={...SHAPES[0],rotation:0};');
  const y0=run('currentY'); run('rotatePiece();'); return eq(run('currentY'),y0);
});
t('锁延迟计数达上限会锁定', ()=>{
  run('restart(); currentY=5; isLocking=true; lockTimer=performance.now(); lockMoveCount=14;');
  run('__before=currentPiece; move(-1);');
  const changed=run('currentPiece!==__before');
  return changed===true ? true : '方块未被锁定';
});

console.log('\n【6】resize 不再清空棋盘');
t('updateCanvasSize 后棋盘内容保留', ()=>{
  run('resetBoard(); board[20][3]=1; board[10][5]=2;'); run('updateCanvasSize();');
  return (run('board[20][3]')===1 && run('board[10][5]')===2) ? true : '棋盘被清空';
});

console.log('\n【7】暂存还原出生朝向');
t('旋转过的方块暂存后再取出，形状回到 0 态', ()=>{
  run('restart(); currentPiece={...SHAPES[2],rotation:0}; currentX=4; currentY=5; rotatePiece();');
  const rot=run('currentPiece.rotation'); run('holdPiece();');
  const rot2=run('heldPiece.rotation');
  const same=run('JSON.stringify(heldPiece.shape)===JSON.stringify(SHAPES[2].shape)');
  return (rot===1 && rot2===0 && same===true) ? true : `旋转后=${rot} 暂存后=${rot2} 形状还原=${same}`;
});

console.log('\n【8】重力曲线');
t('等级越高越快，下限 30ms', ()=>{
  run('level=1;updateSpeed();'); const s1=run('dropSpeed');
  run('level=10;updateSpeed();'); const s10=run('dropSpeed');
  run('level=20;updateSpeed();'); const s20=run('dropSpeed');
  return (s1>s10 && s10>=s20 && s20>=30) ? true : `L1=${s1} L10=${s10} L20=${s20}`;
});
t('难度缩放生效（EXPERT 更快）', ()=>{
  run('level=5;currentDifficulty="NORMAL";updateSpeed();'); const n=run('dropSpeed');
  run('currentDifficulty="EXPERT";updateSpeed();'); const e=run('dropSpeed');
  return e<n ? true : `NORMAL=${n} EXPERT=${e}`;
});

console.log('\n【9】统计');
t('maxCombo 记录过程最大值', ()=>{
  run('restart(); maxCombo=0; comboCount=7; maxCombo=Math.max(maxCombo,comboCount); comboCount=0; updatePlayerStats();');
  return eq(run('playerStats.maxCombo'),7);
});
t('T-Spin 只在消行时计数', ()=>{
  run('playerStats.tSpinCount=0;');
  run('resetBoard(); score=0;level=1;comboCount=0;backToBack=false;tSpinType="full"; clearLines();');
  return eq(run('playerStats.tSpinCount'),0);
});

console.log('\n【10】7 袋随机 & Next 队列');
t('每袋 7 种方块各一', ()=>{ run('initBags();'); return eq(run('bag.map(b=>b.name).sort().join(",")'),'I,J,L,O,S,T,Z'); });
t('Next 队列始终 3 个', ()=>{ run('restart();'); const a=run('nextQueue.length'); run('spawnPiece();'); const b=run('nextQueue.length'); return (a===3&&b===3)?true:`a=${a} b=${b}`; });
t('每日挑战使用固定种子（两次生成序列一致）', ()=>{
  const s1=run('(function(){dailyRng=seedRandom(dailySeed()); let o=[]; for(let i=0;i<8;i++) o.push(pullPiece(dailyRng).name); return o.join(",");})()');
  const s2=run('(function(){dailyRng=seedRandom(dailySeed()); let o=[]; for(let i=0;i<8;i++) o.push(pullPiece(dailyRng).name); return o.join(",");})()');
  return s1===s2 ? true : '两次序列不同';
});

console.log('\n【11】模式目标');
t('Sprint 目标 40 行', ()=>{ run('restart(); gameMode="SPRINT"; lines=39; '); run('board[23].fill(1); clearLines();'); return eq(run('lines>=40'),true); });
t('马拉松目标 150 行', ()=>{ run('restart(); gameMode="MARATHON"; lines=149;'); run('board[23].fill(1); clearLines();'); return eq(run('lines>=150'),true); });

console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail?1:0);
