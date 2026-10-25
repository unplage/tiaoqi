// 随机操作模糊测试：确保长时间游玩不抛异常
const fs=require('fs'), vm=require('vm'), path=require('path');
require('./dom-stub.js');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const ctx=vm.createContext(Object.assign(global,{window:global.window,document:global.document,console}));
vm.runInContext(script.replace(/window\.addEventListener\('load'[\s\S]*?\}\);\s*$/m,''),ctx,{filename:'game.js'});
const run=(c)=>vm.runInContext(c,ctx);
const modes=['NORMAL','TIMED','SPRINT','ULTRA','MARATHON','SURVIVAL','ZEN','DAILY'];
const diffs=['EASY','NORMAL','HARD','EXPERT'];
const grids=['10x20','12x24','15x30'];
let errors=0, locks=0, games=0;
for(let g=0;g<60;g++){
  try{
    const m=modes[g%modes.length];
    run(`document.getElementById('gameModeSelect').value='${m}';
          document.getElementById('difficultySelect').value='${diffs[g%diffs.length]}';
          document.getElementById('gridSizeSelect').value='${grids[g%grids.length]}';
          applyGridSize('${grids[g%grids.length]}'); restart();`);
    games++;
    for(let i=0;i<400;i++){
      const op=Math.floor(Math.random()*10);
      if(op<3) run('move(Math.random()<0.5?-1:1);');
      else if(op===3) run('rotatePiece();');
      else if(op===4) run('hardDrop();');
      else if(op===5) run('holdPiece();');
      else if(op===6) run('startDAS(1);clearDAS();');
      else if(op===7) run('startSoftDrop();stopSoftDrop();');
      else if(op===8) run('gameLoop(performance.now());');
      else { run('drop();'); if(Math.random()<0.3) run('doLock();'); }
      if(run('gameRunning')===false) break;
    }
    locks++;
  }catch(e){ errors++; console.log('  ✗ 第 '+g+' 局异常: '+e.message+'\n'+e.stack.split('\n').slice(0,3).join('\n')); }
}
console.log(`\n完成 ${games} 局模拟，${locks} 局正常结束，异常 ${errors} 次`);
process.exit(errors?1:0);
