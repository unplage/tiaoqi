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

  const land=S.land;S.land=31;const c31=xz.expandCost(0);S.land=32;const c32=xz.expandCost(0);S.land=land;
  check(c32>c31*1.12,'拓荒成本在 30 次后未继续加速');

  S.fame=130;S.famePaid=1;S.coin=1000;
  check(xz.fameLevel()===1,'晋升捐纳未锁定等级');
  const donation=xz.fameDonation(2);
  check(donation>0,'晋升捐纳金额为 0');
  xz.payPromotion();
  check(xz.fameLevel()===2,'缴纳捐纳后未晋升');
  check(Math.abs(S.coin-(1000-donation))<1,'晋升捐纳未扣款');

  const tileIdx=xz.b2i(17,11);
  S.arrears=0;const policy0=xz.rateParts(tileIdx).policy;
  S.arrears=3;const policy1=xz.rateParts(tileIdx).policy;
  check(policy1<policy0,'维护欠费未降低生产');
  S.arrears=0;

  check(xz.festivalCost()>200,'节庆成本未随村庄规模增长');
  S.pop=10;S.coin=1000;S.dividendBonus=0;
  xz.payDividend();
  check(S.dividendBonus===4,'村民分红未提升幸福加成');
  check(S.coin<1000,'村民分红未扣款');

  S.coin=10000;xz.ensureMarket();S.market.prices.rice=xz.marketDef('rice').base;
  xz.buyShares('rice',2);
  check(Math.floor(S.market.shares.rice)===2,'买入股票未到账');
  check(S.coin<10000,'买入股票未扣手续费');
  xz.marketTick();
  check(S.market.prices.rice>=xz.marketDef('rice').base*.5-1&&S.market.prices.rice<=xz.marketDef('rice').base*2+1,'股价越过上下限');
  const beforeDiv=S.coin;
  xz.marketDividend();
  check(S.coin>=beforeDiv,'证券分红异常');
  const beforeSell=S.coin;
  xz.sellShares('rice',1);
  check(Math.floor(S.market.shares.rice)===1,'卖出股票未减少持股');
  check(S.coin>beforeSell,'卖出股票未回款');

  S.fame=100000;S.famePaid=9;S.coin=1000000;S.mat=1000;S.stone=1000;
  xz.buildVillageProject('archway');
  check(!!S.projects.archway,'装饰工程未建成');
  check(xz.fameLevel()>=6,'装饰工程等级门槛异常');

  S.coin=5000;S.fame=100000;S.famePaid=9;
  xz.activateSkin('bamboo',1);
  check(!!xz.activeSkin()&&xz.activeSkin().id==='bamboo','皮肤未启用');
  const cvStyle=sandbox.document.getElementById('game').style;
  check(/hue-rotate|saturate|sepia|brightness/.test(cvStyle.filter||''),'皮肤未应用到画布滤镜');
  check(/solid/.test(cvStyle.outline||''),'皮肤未应用到画布边框');
  check(/青竹庭院/.test(sandbox.document.getElementById('skinBadge').textContent||''),'皮肤徽章未显示');
  check(S.coin<5000,'皮肤购买未扣款');
  const skinned=xz.skinCat('farm')[0];
  xz.removeSkin();
  check(!xz.activeSkin(),'卸下皮肤后仍然生效');
  check(xz.skinCat('farm')[0]!==skinned,'皮肤未改变建筑配色');
  S.skin={id:'bamboo',expires:S.day-1};
  check(!xz.activeSkin(),'过期皮肤仍然展示');
  xz.applySkinFx();
  check(!cvStyle.filter,'过期后画布滤镜未清除');
  check(/到期/.test(sandbox.document.getElementById('skinBadge').textContent||''),'过期提示未显示');
  const renewCoin=S.coin;
  xz.activateSkin('bamboo',1);
  check(!!xz.activeSkin(),'续费后皮肤未恢复');
  check(S.coin<renewCoin,'续费未扣款');
  S.fame=0;S.famePaid=1;S.coin=1000000;
  xz.activateSkin('ink',1);
  check(!xz.activeSkin()||xz.activeSkin().id!=='ink','稀有皮肤等级门槛失效');

  S.qi=999;
  check(xz.prestigeInfo().eligible,'主线完成后未获得迁村资格');
  const villagesBefore=xz.META.villages||0,pointsBefore=xz.META.points||0,prestigeCoin=xz.S.coin;
  xz.performPrestige(5);
  const S2=xz.S;
  check(S2.qi===0,'迁村后主线进度未重置');
  check(S2.tiles.every(t=>!t),'迁村后地块未清空');
  check((xz.META.villages||0)===villagesBefore+1,'迁村次数未累计');
  const expected=5+Math.min(20,Math.floor(prestigeCoin/10000));
  check((xz.META.points||0)===pointsBefore+expected,'迁村未获得政绩点');
  finish();
});
function finish(){
  if(fails.length){console.error('✗ '+fails.join('\n✗ '));process.exitCode=1;}
  else console.log('✓ xiangzhang 回归检查通过');
}
