const fs=require('fs');
const path=require('path');
const vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
const m=html.match(/<script>([\s\S]*)<\/script>/);
if(!m)throw new Error('未找到游戏脚本');
function makeElement(){
  const e={
    children:[],style:{cssText:''},dataset:{},innerHTML:'',textContent:'',value:'',
    classList:{add(){},remove(){},toggle(){return false},contains(){return false}},
    appendChild(){},removeChild(){},remove(){},addEventListener(){},removeEventListener(){},
    setAttribute(){},select(){},focus(){},closest(){return null},querySelector(){return makeElement()},
    getBoundingClientRect(){return {width:960,height:600,left:0,top:0}},
    getContext(){return ctx},parentNode:{className:''}
  };
  return e;
}
const gradient={addColorStop(){}};
const ctx=new Proxy({},{
  get(t,k){
    if(k in t)return t[k];
    if(k==='createLinearGradient'||k==='createRadialGradient')return ()=>gradient;
    if(k==='measureText')return ()=>({width:10});
    return ()=>{};
  },
  set(t,k,v){t[k]=v;return true;}
});
const store={};
const sandbox={
  console,Math,Date,JSON,Object,Array,String,Number,Boolean,RegExp,Error,Promise,Set,Map,
  Float32Array,Uint8Array,Uint16Array,isFinite,parseInt,parseFloat,
  performance:{now:()=>Date.now()},
  setTimeout:()=>0,clearTimeout(){},setInterval(){},requestAnimationFrame(){return 0},
  localStorage:{getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;},removeItem:k=>{delete store[k];}},
  navigator:{maxTouchPoints:0,userAgent:'node'},
  document:{
    getElementById:id=>store['el_'+id]||(store['el_'+id]=makeElement()),
    createElement:()=>makeElement(),querySelectorAll:()=>[],addEventListener(){},
    body:makeElement(),documentElement:makeElement(),hidden:false,fullscreenElement:null
  },
  screen:{orientation:{lock:async()=>false,unlock:async()=>{}}}
};
sandbox.addEventListener=()=>{};
sandbox.matchMedia=()=>({matches:false,addEventListener(){}});
sandbox.window=sandbox;
sandbox.globalThis=sandbox;
vm.createContext(sandbox);
new vm.Script(m[1]).runInContext(sandbox);
const fails=[];
function check(ok,msg){if(!ok)fails.push(msg);}
setImmediate(()=>{
  const xz=sandbox.window.__xz;
  check(!!xz,'window.__xz 未暴露');
  if(!xz)return finish();
  const S=xz.S,D=xz.D;
  for(const k of ['coin','fame','soil','water','cert'])S[k]=1000;
  S.orders=[];
  for(let i=0;i<300;i++){
    xz.genOrder(true);
    for(const o of S.orders)check(['coin','fame','soil','water','cert'].indexOf(o.res)<0,'订单仍包含特殊资源：'+o.res);
  }
  for(const k of ['coin','fame','soil','water','cert'])check(!xz.hasProduced(k),'hasProduced 未排除特殊资源：'+k);
  const i=xz.b2i(14,11);
  S.tiles[i]={b:'home',lv:2,prog:0,build:0,pendLv:0,h:{},hc:0,paused:false,fallow:false,variety:null,
    anchor:true,ax:14,ay:11,w:1,ftH:1,floors:1,pendingFloor:0};
  xz.recalc();
  const cap=D.popCap;S.pop=cap;
  S.tiles[i].build=5;S.tiles[i].pendLv=3;
  xz.recalc();
  check(D.popCap===cap,'升级期间人口容量被移除');
  check(S.pop===cap,'升级期间人口被压缩');
  function tile(b,x,y){
    return {b:b,lv:1,prog:0,build:0,pendLv:0,h:{},hc:0,paused:false,fallow:false,variety:null,
      anchor:true,ax:x,ay:y,w:1,ftH:1,floors:1,pendingFloor:0};
  }
  const near=xz.b2i(17,11),far=xz.b2i(17,12),other=xz.b2i(18,12);
  S.tiles[near]=tile('wheat',17,11);
  S.tiles[far]=tile('wheat',17,12);
  S.tiles[other]=tile('rice',18,12);
  xz.recalc();
  check(D.roadDist[far]===1,'同类连片建筑未共享临路距离');
  check(D.roadFactor[far]===1,'同类连片建筑未获得满效率');
  check(Math.abs(D.roadFactor[other]-.9)<1e-6,'不同类建筑不应共享临路距离');
  S.sel=near;
  const detail=xz.renderInfo();
  check(detail.indexOf('施有机肥')>=0,'已建农田详情缺少施肥按钮');
  check(detail.indexOf('种绿肥')>=0,'已建农田详情缺少种绿肥按钮');
  xz.setTab('custom');
  check(xz.S.sideTab==='custom','切换到自定义页后被重置');
  check(sandbox.document.getElementById('sideBody').innerHTML.indexOf('pickEmoji')>=0,'自定义页缺少 emoji 选择器');
  check(sandbox.document.getElementById('sideBody').innerHTML.indexOf('cuCat')>=0,'自定义页缺少建造分类选择器');
  const canvas=sandbox.document.getElementById('game');
  const origRect=canvas.getBoundingClientRect;
  canvas.getBoundingClientRect=()=>({width:844,height:390,left:0,top:0});
  xz.resize();
  check(xz.view.VW===960,'画布虚拟宽度未保持 960');
  check(Math.abs(xz.view.VH-444)<2,'画布虚拟高度未按宽高比自适应');
  check(xz.view.ox===0&&xz.view.oy===0,'画布仍有居中黑边偏移');
  canvas.getBoundingClientRect=origRect;
  xz.resize();
  S.tech.automotive=1;
  check(Math.abs(xz.techMul('ind','autoPlant')-1.15)<.001,'汽车科技加成未生效');
  const day=S.day;
  S.lastSave=Date.now()-3600000;
  try{xz.offlineGain(1);}catch(e){fails.push('离线结算异常：'+e.message);}
  check(S.day>day,'离线未推进日期');

  S.yearTheme='drought';
  check(xz.themeProdMul()<1,'旱年未降低产量');
  check(xz.themePriceMul()>1,'旱年未提高价格');
  S.yearTheme='normal';
  check(xz.themeProdMul()===1,'平常年产量乘子不为 1');
  xz.rollYearTheme(true);
  check(typeof xz.yearTheme().id==='string','年度主题滚动后无效');

  xz.META.points=20;
  const prodLv=xz.metaLevel('prod');
  xz.buyMetaUpgrade('prod');
  check(xz.metaLevel('prod')===prodLv+1,'传承升级未提升等级');
  check(xz.metaProdMul()>1,'传承生产加成未生效');

  S.villagers=[];
  xz.spawnVillagerRequest(true);
  check(S.villagers.length===1,'村民诉求未生成');
  if(S.villagers.length){
    const v=S.villagers[0];
    S[v.res]=(S[v.res]||0)+v.amt;
    const coinBefore=S.coin;
    xz.fulfillVillager(0);
    check(S.villagers.length===0,'村民诉求完成后未移除');
    check(S.coin>=coinBefore,'村民诉求未给予金币奖励');
  }

  const code=xz.shareVillage();
  check(/^XZ1-/.test(code),'分享码格式不正确');
  check(xz.BOARD.length>0,'村庄榜未记录');
  check(S.lastShareCode===code,'分享码未写入存档状态');

  const coinBefore=S.coin;
  for(let k=0;k<30;k++)xz.dayAdvance(true);
  check(isFinite(S.coin)&&S.coin>=0,'30 日经济模拟后金币异常');
  check(S.day>1,'30 日经济模拟未推进日期');

  S.qi=999;
  check(xz.prestigeInfo().eligible,'主线完成后未获得迁村资格');
  const villagesBefore=xz.META.villages||0,pointsBefore=xz.META.points||0;
  xz.performPrestige(5);
  const S2=xz.S;
  check(S2.qi===0,'迁村后主线进度未重置');
  check(S2.tiles.every(t=>!t),'迁村后地块未清空');
  check((xz.META.villages||0)===villagesBefore+1,'迁村次数未累计');
  check((xz.META.points||0)===pointsBefore+5,'迁村未获得政绩点');
  finish();
});
function finish(){
  if(fails.length){console.error('✗ '+fails.join('\n✗ '));process.exitCode=1;}
  else console.log('✓ xiangzhang 回归检查通过');
}
