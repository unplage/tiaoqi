// 极简 DOM/Canvas 模拟，用于在 Node 中跑 index.html 的游戏逻辑
class Ctx2D {
  constructor(){ this.fillStyle='#000'; this.strokeStyle='#000'; this.lineWidth=1; this.globalAlpha=1; }
  fillRect(){} strokeRect(){} clearRect(){} drawImage(){} beginPath(){} moveTo(){} lineTo(){}
  stroke(){} fill(){} arc(){} closePath(){} save(){} restore(){} setTransform(){} translate(){} scale(){} createPattern(){return null;}
}
class El {
  constructor(tag,id){ this.tagName=(tag||'div').toUpperCase(); this.id=id||''; this.style={ setProperty(k,v){this[k]=v;}, removeProperty(k){delete this[k];}, getPropertyValue(k){return this[k]||'';} }; this.classList={
    _s:new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(c,f){ f===undefined? (this._s.has(c)?this._s.delete(c):this._s.add(c)) : (f?this._s.add(c):this._s.delete(c)); }, contains(c){return this._s.has(c);}
  }; this.children=[]; this._ctx=new Ctx2D(); this.offsetWidth=32; this.offsetHeight=32; this.width=32; this.height=32;
    this.value=''; this.checked=false; this.textContent=''; this.innerHTML=''; this.dataset={}; this.parentElement=null; }
  getContext(){ return this._ctx; }
  get offsetLeft(){ return 0; } get offsetTop(){ return 0; }
  getBoundingClientRect(){ return {left:0,top:0,width:this.offsetWidth,height:this.offsetHeight,right:this.offsetWidth,bottom:this.offsetHeight}; }
  appendChild(c){ c.parentElement=this; this.children.push(c); return c; }
  removeChild(c){ this.children.splice(this.children.indexOf(c),1); }
  remove(){ if(this.parentElement) this.parentElement.removeChild(this); }
  addEventListener(t,f){ (this._ev||(this._ev={}))[t]=(this._ev[t]||[]).concat(f); }
  removeEventListener(){}
  dispatch(t,ev){ ((this._ev||{})[t]||[]).forEach(f=>f(ev||{})); }
  closest(){ return null; }
  querySelectorAll(){ return []; }
  setPointerCapture(){}
}
const els={};
function mk(id,tag){ const e=new El(tag,id); els[id]=e; return e; }
['canvas','holdCanvas','nextPieceCanvas','nextPieceCanvas2','nextPieceCanvas3','dangerVignette','banner','sidePanel',
 'nextPieceContainer','boardWrap','gameArea','gameOver','gameOverTitle','gameOverSub','finalScore','finalLines',
 'leaderboardPanel','leaderboardList','settingsPanel','statsContent','score','level','lines','combo','highScore','timer',
 'timerDisplay','pauseBtn','difficultySelect','pieceModeSelect','gridSizeSelect','gameModeSelect','ghostPieceCheck',
 'landingPointCheck','soundCheck','vibrateCheck','dasSlider','arrSlider','dasValue','arrValue','dasPresets','arrPresets',
 'topBar','touchControls','btnLeft','btnRight','btnDown','btnRotate','btnHardDrop','btnHold'].forEach(id=>mk(id, id==='canvas'||id.endsWith('Canvas')?'canvas':'div'));
global.window={ addEventListener(){}, devicePixelRatio:2, innerWidth:390, innerHeight:844, visualViewport:null, location:{href:'http://x/'} };
global.document={
  getElementById:id=>els[id]||null,
  createElement:tag=>new El(tag),
  addEventListener(){}, body:new El('body'), documentElement:new El('html'), hidden:false,
  getComputedStyle:()=>({getPropertyValue:p=>p==='--grid-bg'?'#0f1525':(p==='--accent'?'#4fc3f7':'')})
};
global.navigator={ vibrate(){} };
global.performance={ now:()=>Date.now() };
global.requestAnimationFrame=()=>0; global.cancelAnimationFrame=()=>{};
global.alert=()=>{}; global.confirm=()=>true;
global.indexedDB=undefined;
module.exports={els,El};
