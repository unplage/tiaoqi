/* ==========================================================================
   打地鼠 · 木鱼消遣  —  游戏引擎
   --------------------------------------------------------------------------
   结构:
     1. 常量与配置      6. 场景绘制 (canvas)
     2. 工具函数        7. 音效 (Web Audio)
     3. 存档与设置      8. 反馈特效 (粒子 / 震动 / 飘字)
     4. 状态            9. 界面绑定
     5. 主循环与逻辑   10. 启动
   ========================================================================== */
(() => {
  'use strict';

  /* ======================================================================
     1. 常量与配置
     ====================================================================== */

  const DIFFICULTY = {
    easy: {
      key: 'easy', name: '轻松',
      spawn: [1500, 950],   // 出场间隔 起→终 (ms)
      alive: [1400, 1000],  // 停留时长 起→终 (ms)
      conc: [1, 3],         // 同屏上限 起→终
      time: 90,
      bomb: 0, golden: 0.10, angry: 0.05,
      rank: { S: 1200, A: 780, B: 460, C: 220 },
    },
    medium: {
      key: 'medium', name: '标准',
      spawn: [1150, 560],
      alive: [1150, 760],
      conc: [2, 4],
      time: 60,
      bomb: 0.10, golden: 0.12, angry: 0.12,
      rank: { S: 1800, A: 1150, B: 680, C: 320 },
    },
    hard: {
      key: 'hard', name: '紧张',
      spawn: [900, 380],
      alive: [950, 540],
      conc: [2, 5],
      time: 45,
      bomb: 0.15, golden: 0.13, angry: 0.18,
      rank: { S: 2400, A: 1500, B: 880, C: 420 },
    },
    insane: {
      key: 'insane', name: '地狱',
      spawn: [640, 230],
      alive: [720, 370],
      conc: [3, 7],
      time: 30,
      bomb: 0.20, golden: 0.14, angry: 0.22,
      rank: { S: 3000, A: 1900, B: 1150, C: 540 },
    },
  };

  // 地鼠类型：分值、停留时间系数、权重
  const MOLE_TYPES = {
    normal: { label: '普通地鼠', points: 10, alive: 1.00, weight: 100, cls: '' },
    sleepy: { label: '瞌睡地鼠', points: 5,  alive: 1.45, weight: 16,  cls: 'is-sleepy' },
    angry:  { label: '愤怒地鼠', points: 20, alive: 0.62, weight: 30,  cls: 'is-angry' },
    golden: { label: '黄金地鼠', points: 60, alive: 0.72, weight: 30,  cls: 'is-golden' },
    bomb:   { label: '炸弹',     points: 0,  alive: 1.20, weight: 22,  cls: 'is-bomb' },
  };

  const BOMB_PENALTY = 40;
  const COMBO_WINDOW = 2200;      // 连击保持时间 (ms)
  const MAX_MULT = 8;             // 倍率上限
  const EMPTY_HIT_PENALTY = 5;    // 严格模式：空击扣分
  const ESCAPE_PENALTY = 3;       // 严格模式：逃脱扣分

  const POWERUPS = [
    { id: 'hammer', icon: 'hammer', name: '黄金锤', dur: 6000, desc: '得分翻倍' },
    { id: 'freeze', icon: 'freeze', name: '冰冻',   dur: 4000, desc: '地鼠冻结' },
    { id: 'star',   icon: 'star',   name: '星光',   dur: 5000, desc: '地鼠变金' },
    { id: 'slow',   icon: 'slow',   name: '慢动作', dur: 5000, desc: '时间减速' },
    { id: 'shield', icon: 'shield', name: '护盾',   dur: 0,    desc: '抵消炸弹' },
  ];

  /* 道具图标（内联 SVG，避免依赖 emoji 字体） */
  const POWERUP_ICON = {
    hammer: '<svg viewBox="0 0 16 16" class="powup__ico"><path d="M11.5 1.5 14.5 4.5l-1.6 1.6-3-3zM9.4 3.6 12.4 6.6 6.2 12.8 3.2 9.8z" fill="currentColor"/></svg>',
    freeze: '<svg viewBox="0 0 16 16" class="powup__ico"><path d="M8 1v14M2.2 4.5l11.6 7M13.8 4.5l-11.6 7M8 1l-1.6 2.2M8 1l1.6 2.2M8 15l-1.6-2.2M8 15l1.6-2.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>',
    star:   '<svg viewBox="0 0 16 16" class="powup__ico"><path d="M8 1.2 9.9 5.6l4.8.6-3.5 3.3.9 4.8L8 12l-4.1 2.3.9-4.8L1.3 6.2l4.8-.6z" fill="currentColor"/></svg>',
    slow:   '<svg viewBox="0 0 16 16" class="powup__ico"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.4V8l2.6 1.8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
    shield: '<svg viewBox="0 0 16 16" class="powup__ico"><path d="M8 1 2.8 3.2v4.3c0 3.2 2.2 6.2 5.2 7.5 3-1.3 5.2-4.3 5.2-7.5V3.2z" fill="currentColor"/></svg>',
  };

  const STORE_KEY = 'dds.save.v2';
  const DEFAULT_SETTINGS = {
    sound: true, rich: false, music: false, volume: 0.7,
    vibrate: true, strict: false,
    holes: 9, layout: 'circle', theme: 'meadow',
  };

  /* ======================================================================
     2. 工具函数
     ====================================================================== */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp  = (a, b, t) => a + (b - a) * t;
  const rand  = (a, b) => a + Math.random() * (b - a);
  const randInt = (a, b) => Math.floor(rand(a, b + 1));
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const now = () => performance.now();

  /* ======================================================================
     3. 存档与设置
     ====================================================================== */

  const save = {
    data: { best: {}, settings: { ...DEFAULT_SETTINGS }, stats: { games: 0, hits: 0, total: 0 } },
    load() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          this.data = {
            best: parsed.best || {},
            settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
            stats: { ...this.data.stats, ...(parsed.stats || {}) },
          };
        }
        for (const k of Object.keys(DIFFICULTY)) {
          if (typeof this.data.best[k] !== 'number') this.data.best[k] = 0;
        }
      } catch (e) {
        console.warn('存档读取失败，使用默认设置', e);
      }
      return this.data.settings;
    },
    write() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); }
      catch (e) { console.warn('存档写入失败', e); }
    },
    wipe() {
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* noop */ }
      this.data = {
        best: {}, settings: { ...DEFAULT_SETTINGS },
        stats: { games: 0, hits: 0, total: 0 },
      };
    },
  };

  const settings = save.load();

  /* ======================================================================
     4. 运行状态
     ====================================================================== */

  const state = {
    phase: 'idle',          // idle | countdown | playing | paused | over
    difficulty: 'medium',
    score: 0,
    hits: 0, emptyHits: 0, escapes: 0, goldHits: 0, bombHits: 0,
    combo: 0, maxCombo: 0, mult: 1,
    comboUntil: 0,
    timeLeft: 60, totalTime: 60, elapsed: 0,
    endless: false,
    moles: [],              // 场上活跃地鼠
    power: {},              // 生效中的道具 { id: until }
    shield: false,
    spawnAcc: 0,
    timeScale: 1,
    freezeUntil: 0,
    started: false,
  };

  const holes = [];         // { el, moleEl, nx, ny, mole }
  let boardRect = { w: 0, h: 0 };

  /* ======================================================================
     5. 主循环与游戏逻辑
     ====================================================================== */

  let lastFrame = now();
  let hitStopUntil = 0;

  function loop(t) {
    const dt = Math.min(64, t - lastFrame);
    lastFrame = t;

    if (state.phase === 'playing' && t > hitStopUntil) update(dt);
    updateShake(dt);
    scene.update(dt);
    scene.draw();
    fx.update(dt);
    fx.draw();
    requestAnimationFrame(loop);
  }

  /** 屏幕震动 */
  function updateShake(dt) {
    const wrap = $('#boardWrap');
    if (!wrap) return;
    if (shakeTime > 0) {
      shakeTime -= dt;
      const a = shakeAmp * Math.max(0, shakeTime / 320);
      wrap.style.transform = `translate(${rand(-a, a).toFixed(2)}px, ${rand(-a, a).toFixed(2)}px)`;
      if (shakeTime <= 0) { shakeAmp = 0; wrap.style.transform = ''; }
    } else if (shakeAmp !== 0) {
      shakeAmp = 0;
      wrap.style.transform = '';
    }
  }

  /** 难度随时间线性变难 */
  function progress() {
    if (state.endless) return Math.min(1, state.elapsed / 90000);
    return clamp(state.elapsed / (state.totalTime * 1000), 0, 1);
  }

  function diff() { return DIFFICULTY[state.difficulty]; }

  function update(dt) {
    const t = now();
    state.elapsed += dt;

    /* --- 倒计时（无尽模式不倒计时） --- */
    if (!state.endless) {
      state.timeLeft = Math.max(0, state.totalTime - state.elapsed / 1000);
      updateTimerUI();
      if (state.timeLeft <= 0) { endGame(); return; }
    }

    /* --- 道具计时 --- */
    for (const key of Object.keys(state.power)) {
      const p = state.power[key];
      if (p.until && p.until <= t) {
        delete state.power[key];
        if (key === 'slow') state.timeScale = 1;
        if (key === 'star') {
          state.moles.forEach(m => {
            m.el.classList.remove('is-star');
            if (m.type !== 'golden') m.el.classList.remove('is-golden');
          });
        }
        renderPowerups();
      }
    }
    if (state.power.freeze && state.power.freeze.until <= t) delete state.power.freeze;

    /* --- 连击衰减 --- */
    if (state.combo > 0 && t > state.comboUntil) {
      state.combo = 0; state.mult = 1;
      updateComboUI();
      showComboBanner('连击中断', 'bad');
    }
    updateComboUI();

    /* --- 地鼠出场 --- */
    const p = progress();
    const d = diff();
    const scale = state.power.slow ? 0.55 : 1;
    state.timeScale = scale;
    const interval = lerp(d.spawn[0], d.spawn[1], p) / scale;
    state.spawnAcc += dt;
    while (state.spawnAcc >= interval) {
      state.spawnAcc -= interval;
      const maxConc = Math.round(lerp(d.conc[0], d.conc[1], p));
      if (state.moles.length < maxConc) {
        if (!spawnMole(p)) break;         // 没有空位，下一轮再试
      }
    }

    /* --- 地鼠存活 --- */
    const frozen = !!state.power.freeze;
    for (let i = state.moles.length - 1; i >= 0; i--) {
      const m = state.moles[i];
      if (!frozen) m.age += dt * scale;
      if (m.age >= m.life) {
        escapeMole(m);
        state.moles.splice(i, 1);
      }
    }
  }

  /** 选择地鼠类型 */
  function pickType() {
    const d = diff();
    const list = [];
    for (const [key, def] of Object.entries(MOLE_TYPES)) {
      let w = def.weight;
      if (key === 'bomb') w = d.bomb * 130;
      if (key === 'golden') w = d.golden * 150;
      if (key === 'angry') w = d.angry * 140;
      list.push([key, w]);
    }
    const total = list.reduce((s, [, w]) => s + w, 0);
    let r = Math.random() * total;
    for (const [key, w] of list) {
      r -= w;
      if (r <= 0) return key;
    }
    return 'normal';
  }

  /** 生成一只地鼠 */
  function spawnMole(p) {
    const free = holes.filter(h => !h.mole);
    if (!free.length) return false;
    const hole = pick(free);
    const type = pickType();
    const def = MOLE_TYPES[type];
    const d = diff();

    const life = lerp(d.alive[0], d.alive[1], p) * def.alive * rand(0.9, 1.12);

    hole.mole = { type, def, age: 0, life, el: hole.moleEl, hole };
    state.moles.push(hole.mole);

    // 重置外观
    const el = hole.moleEl;
    el.className = 'mole';
    if (def.cls) el.classList.add(def.cls);
    if (state.power.star) el.classList.add('is-star', 'is-golden');
    if (type === 'golden') el.classList.add('is-golden');
    el.style.transition = 'none';
    el.classList.remove('is-up');
    // 强制重排后恢复过渡，保证弹出动画
    void el.offsetHeight;
    el.style.transition = '';
    el.classList.add('is-up');

    if (type === 'golden') fx.sparkle(hole.cx, hole.cy, 10);
    return true;
  }

  /** 地鼠逃走 */
  function escapeMole(m) {
    m.el.classList.remove('is-up');
    m.el.classList.add('is-leak');
    setTimeout(() => m.el.classList.remove('is-leak'), 320);
    m.hole.mole = null;
    state.escapes++;
    if (state.combo > 0) {
      state.combo = 0; state.mult = 1;
      showComboBanner('溜走了！', 'bad');
    }
    if (settings.strict) {
      state.score = Math.max(0, state.score - ESCAPE_PENALTY);
      floatText(m.hole.cx, m.hole.cy, `-${ESCAPE_PENALTY}`, 'minus');
    }
    updateScoreUI();
  }

  /** 点击洞口 */
  function hitHole(hole, pointerX, pointerY) {
    if (state.phase !== 'playing') return;
    const m = hole.mole;

    if (!m) {
      // 空击
      state.emptyHits++;
      hole.el.classList.remove('is-empty-hit');
      void hole.el.offsetWidth;
      hole.el.classList.add('is-empty-hit');
      fx.dust(hole.cx, hole.cy);
      audio.miss();
      if (settings.strict) {
        state.score = Math.max(0, state.score - EMPTY_HIT_PENALTY);
        floatText(hole.cx, hole.cy, `-${EMPTY_HIT_PENALTY}`, 'minus');
        state.combo = 0; state.mult = 1;
        updateScoreUI();
      }
      return;
    }

    const type = m.type;

    if (type === 'bomb') {
      /* ---- 炸弹 ---- */
      state.bombHits++;
      m.el.classList.remove('is-up');
      m.el.classList.add('is-hit');
      m.hole.mole = null;
      state.moles = state.moles.filter(x => x !== m);

      if (state.shield) {
        state.shield = false;
        delete state.power.shield;
        renderPowerups();
        floatText(hole.cx, hole.cy, '挡下了！', 'plus');
        audio.shield();
        fx.ring(hole.cx, hole.cy, '#7ee7ff');
      } else {
        state.score = Math.max(0, state.score - BOMB_PENALTY);
        floatText(hole.cx, hole.cy, `-${BOMB_PENALTY}`, 'minus');
        showComboBanner('踩到炸弹！', 'bad');
        fx.explode(hole.cx, hole.cy);
        shake(14);
        flash();
        audio.boom();
        state.combo = 0; state.mult = 1;
      }
      updateScoreUI();
      updateComboUI();
      return;
    }

    /* ---- 正常命中 ---- */
    m.el.classList.remove('is-up');
    m.el.classList.add('is-hit');
    m.hole.mole = null;
    state.moles = state.moles.filter(x => x !== m);
    setTimeout(() => m.el.classList.remove('is-hit'), 260);

    state.hits++;
    state.combo++;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
    state.comboUntil = now() + COMBO_WINDOW;
    state.mult = Math.min(MAX_MULT, 1 + Math.floor(state.combo / 3));

    const double = !!state.power.hammer;
    const gain = Math.round(m.def.points * state.mult * (double ? 2 : 1));
    state.score += gain;

    if (type === 'golden') state.goldHits++;

    audio.hit();
    if (type === 'golden') { audio.gold(); fx.sparkle(hole.cx, hole.cy, 22); fx.ring(hole.cx, hole.cy, '#ffd76a'); }
    else fx.dirt(hole.cx, hole.cy);
    floatText(hole.cx, hole.cy, `+${gain}`, type === 'golden' ? 'gold' : 'plus');
    vibrate(type === 'golden' ? [18, 40, 18] : 12);

    // 连击里程碑
    if (state.combo % 5 === 0) {
      showComboBanner(`${state.combo} 连击！`, 'good');
      if (state.combo >= 5) triggerPowerup(state.combo);
      fx.confetti(hole.cx, hole.cy);
      vibrate([20, 40, 20]);
    } else if (state.mult > 1 && state.combo % 3 === 0) {
      showComboBanner(`倍率 ×${state.mult}`, 'good');
    }

    updateScoreUI();
    updateComboUI();
    $('#stageHint')?.classList.add('is-hidden');
  }

  /** 触发道具 */
  function triggerPowerup(combo) {
    const idx = Math.floor((combo - 5) / 5) % POWERUPS.length;
    const p = POWERUPS[idx];
    const t = now();
    if (p.dur) {
      state.power[p.id] = { until: t + p.dur, def: p };
      if (p.id === 'star') state.moles.forEach(m => m.el.classList.add('is-star', 'is-golden'));
    } else {
      state.shield = true;
      state.power[p.id] = { until: 0, def: p };
    }
    renderPowerups();
    fx.confetti(boardRect.w / 2, boardRect.h * 0.3);
    audio.power();
    toast(`${p.name} — ${p.desc}`);
  }

  /* ======================================================================
     6. 场景绘制 (canvas)
     ====================================================================== */

  const scene = (() => {
    const canvas = $('#scene');
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, dpr = 1;
    let skyLayer = null, groundLayer = null;
    let clouds = [], motes = [];
    const theme = () => ({
      sky1: cssVar('--sky-1'), sky2: cssVar('--sky-2'), sky3: cssVar('--sky-3'),
      g1: cssVar('--ground-1'), g2: cssVar('--ground-2'),
      hf: cssVar('--hill-far'), hn: cssVar('--hill-near'),
      night: document.documentElement.dataset.theme === 'night',
    });

    function cssVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildLayers();
      seedParticles();
    }

    function buildLayers() {
      const t = theme();

      /* 天空 */
      skyLayer = document.createElement('canvas');
      skyLayer.width = canvas.width; skyLayer.height = canvas.height;
      const s = skyLayer.getContext('2d');
      s.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = s.createLinearGradient(0, 0, 0, h * 0.55);
      g.addColorStop(0, t.sky1);
      g.addColorStop(0.55, t.sky2);
      g.addColorStop(1, t.sky3);
      s.fillStyle = g;
      s.fillRect(0, 0, w, h);

      // 太阳 / 月亮
      const cx = w * 0.78, cy = h * 0.14, rad = Math.min(w, h) * 0.1;
      const sg = s.createRadialGradient(cx, cy, 0, cx, cy, rad * 2.4);
      sg.addColorStop(0, t.night ? 'rgba(255,255,255,.95)' : 'rgba(255,246,200,.95)');
      sg.addColorStop(0.28, t.night ? 'rgba(220,230,255,.45)' : 'rgba(255,226,140,.55)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      s.fillStyle = sg;
      s.beginPath(); s.arc(cx, cy, rad * 2.4, 0, Math.PI * 2); s.fill();
      s.fillStyle = t.night ? '#f2f5ff' : '#fff3b0';
      s.beginPath(); s.arc(cx, cy, rad * 0.62, 0, Math.PI * 2); s.fill();
      if (t.night) {   // 月牙
        s.globalCompositeOperation = 'destination-out';
        s.beginPath(); s.arc(cx + rad * 0.42, cy - rad * 0.18, rad * 0.58, 0, Math.PI * 2); s.fill();
        s.globalCompositeOperation = 'source-over';
      }

      /* 地面 */
      groundLayer = document.createElement('canvas');
      groundLayer.width = canvas.width; groundLayer.height = canvas.height;
      const gr = groundLayer.getContext('2d');
      gr.setTransform(dpr, 0, 0, dpr, 0, 0);

      const gy = h * 0.30;
      // 远山（平滑起伏）
      const hill = (baseY, amp, freq, phase, color) => {
        gr.fillStyle = color;
        gr.beginPath();
        gr.moveTo(0, h);
        for (let x = 0; x <= w + 8; x += 6) {
          const u = x / w;
          const y = baseY
            - amp * Math.sin(u * Math.PI * 2 * freq + phase)
            - amp * 0.45 * Math.sin(u * Math.PI * 2 * freq * 2.3 + phase * 1.7);
          gr.lineTo(x, y);
        }
        gr.lineTo(w, h); gr.closePath(); gr.fill();
      };
      hill(gy + 34, 34, 1.4, 0.6, t.hf);
      hill(gy + 52, 26, 1.1, 2.4, t.hn);
      // 草地
      const gg = gr.createLinearGradient(0, gy, 0, h);
      gg.addColorStop(0, t.g1);
      gg.addColorStop(1, t.g2);
      gr.fillStyle = gg;
      gr.fillRect(0, gy + 30, w, h - gy);
      // 草丛纹理
      for (let i = 0; i < 420; i++) {
        const x = Math.random() * w;
        const y = gy + 36 + Math.random() * (h - gy - 36);
        const len = 3 + Math.random() * 7;
        gr.strokeStyle = `rgba(255,255,255,${0.025 + Math.random() * 0.05})`;
        gr.lineWidth = 1.2;
        gr.beginPath();
        gr.moveTo(x, y);
        gr.lineTo(x + rand(-2.2, 2.2), y - len);
        gr.stroke();
      }
      // 小花点缀
      for (let i = 0; i < 26; i++) {
        const x = Math.random() * w;
        const y = gy + 60 + Math.random() * (h - gy - 70);
        gr.fillStyle = ['rgba(255,255,255,.5)', 'rgba(255,230,140,.6)', 'rgba(255,180,200,.5)'][i % 3];
        gr.beginPath();
        gr.arc(x, y, 1.4 + Math.random() * 1.4, 0, Math.PI * 2);
        gr.fill();
      }
      // 底部阴影
      const vg = gr.createLinearGradient(0, h * 0.72, 0, h);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,.28)');
      gr.fillStyle = vg;
      gr.fillRect(0, h * 0.72, w, h * 0.28);
    }

    function seedParticles() {
      clouds = Array.from({ length: 4 }, () => ({
        x: Math.random() * w, y: h * rand(0.04, 0.2),
        s: rand(0.6, 1.3), v: rand(4, 11),
      }));
      motes = Array.from({ length: 22 }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: rand(1, 3), vx: rand(-6, 6), vy: rand(-9, -2), a: rand(0.15, 0.5),
      }));
    }

    function update(dt) {
      const t = now() / 1000;
      for (const c of clouds) {
        c.x += (c.v * dt) / 1000;
        if (c.x - 120 * c.s > w) c.x = -140 * c.s;
      }
      for (const m of motes) {
        m.x += (m.vx * dt) / 1000;
        m.y += (m.vy * dt) / 1000;
        if (m.y < -10) { m.y = h + 10; m.x = Math.random() * w; }
        if (m.x < -10) m.x = w + 10;
        if (m.x > w + 10) m.x = -10;
      }
    }

    function draw() {
      if (!w || !skyLayer) return;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(skyLayer, 0, 0, w, h);

      // 云
      ctx.fillStyle = 'rgba(255,255,255,.72)';
      for (const c of clouds) {
        const s = c.s, x = c.x, y = c.y;
        ctx.beginPath();
        ctx.ellipse(x, y, 34 * s, 15 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(x + 22 * s, y + 3 * s, 24 * s, 12 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(x - 22 * s, y + 4 * s, 20 * s, 10 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.drawImage(groundLayer, 0, 0, w, h);

      // 飘浮的花粉
      for (const m of motes) {
        ctx.fillStyle = `rgba(255,255,255,${m.a})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    return { resize, update, draw, get w() { return w; }, get h() { return h; } };
  })();

  /* ======================================================================
     7. 音效 (Web Audio)
     ====================================================================== */

  const audio = (() => {
    let ctx = null, master = null, unlocked = false;
    let musicTimer = null;

    function ensure() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = settings.volume;
      master.connect(ctx.destination);
      return ctx;
    }

    function unlock() {
      const c = ensure();
      if (!c) return;
      if (c.state === 'suspended') c.resume().catch(() => {});
      unlocked = true;
    }

    function env(node, t0, peak, attack, decay) {
      node.gain.setValueAtTime(0.0001, t0);
      node.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
      node.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    }

    /** 木鱼声：短促的木质敲击 */
    function muyu(pitch = 1) {
      const c = ensure(); if (!c || !unlocked || !settings.sound) return;
      const t0 = c.currentTime;
      const g = c.createGain();
      g.connect(master);
      env(g, t0, 0.34, 0.004, 0.13);

      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300 * pitch, t0);
      osc.frequency.exponentialRampToValueAtTime(190 * pitch, t0 + 0.09);
      osc.connect(g);
      osc.start(t0); osc.stop(t0 + 0.16);

      const g2 = c.createGain();
      g2.connect(master);
      env(g2, t0, 0.11, 0.003, 0.07);
      const osc2 = c.createOscillator();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(640 * pitch, t0);
      osc2.connect(g2);
      osc2.start(t0); osc2.stop(t0 + 0.1);

      // 木头敲击的瞬态
      const noise = c.createBufferSource();
      const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.03), c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3;
      noise.buffer = buf;
      const ng = c.createGain(); ng.connect(master);
      env(ng, t0, 0.16, 0.001, 0.03);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.8;
      noise.connect(bp); bp.connect(ng);
      noise.start(t0);
    }

    function miss() {
      const c = ensure(); if (!c || !unlocked || !settings.sound) return;
      const t0 = c.currentTime;
      const g = c.createGain(); g.connect(master);
      env(g, t0, 0.16, 0.005, 0.08);
      const osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(170, t0);
      osc.frequency.exponentialRampToValueAtTime(110, t0 + 0.09);
      osc.connect(g);
      osc.start(t0); osc.stop(t0 + 0.14);
    }

    function gold() {
      if (!settings.rich) return;
      const c = ensure(); if (!c || !unlocked || !settings.sound) return;
      const t0 = c.currentTime;
      [880, 1320, 1760].forEach((f, i) => {
        const g = c.createGain(); g.connect(master);
        const t = t0 + i * 0.05;
        env(g, t, 0.13, 0.006, 0.3);
        const o = c.createOscillator();
        o.type = 'triangle'; o.frequency.value = f;
        o.connect(g); o.start(t); o.stop(t + 0.35);
      });
    }

    function boom() {
      if (!settings.rich) return;
      const c = ensure(); if (!c || !unlocked || !settings.sound) return;
      const t0 = c.currentTime;
      const g = c.createGain(); g.connect(master);
      env(g, t0, 0.5, 0.005, 0.42);
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, t0);
      o.frequency.exponentialRampToValueAtTime(38, t0 + 0.4);
      o.connect(g); o.start(t0); o.stop(t0 + 0.5);

      const n = c.createBufferSource();
      const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.3), c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
      n.buffer = buf;
      const ng = c.createGain(); ng.connect(master);
      env(ng, t0, 0.22, 0.004, 0.28);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
      n.connect(lp); lp.connect(ng); n.start(t0);
    }

    function shield() {
      if (!settings.rich) return;
      const c = ensure(); if (!c || !unlocked || !settings.sound) return;
      const t0 = c.currentTime;
      const g = c.createGain(); g.connect(master);
      env(g, t0, 0.18, 0.006, 0.25);
      const o = c.createOscillator();
      o.type = 'sine'; o.frequency.setValueAtTime(420, t0);
      o.frequency.exponentialRampToValueAtTime(880, t0 + 0.2);
      o.connect(g); o.start(t0); o.stop(t0 + 0.3);
    }

    function power() {
      if (!settings.rich) return;
      const c = ensure(); if (!c || !unlocked || !settings.sound) return;
      const t0 = c.currentTime;
      [523, 659, 784, 1047].forEach((f, i) => {
        const g = c.createGain(); g.connect(master);
        const t = t0 + i * 0.06;
        env(g, t, 0.16, 0.006, 0.22);
        const o = c.createOscillator();
        o.type = 'triangle'; o.frequency.value = f;
        o.connect(g); o.start(t); o.stop(t + 0.28);
      });
    }

    function over() {
      const c = ensure(); if (!c || !unlocked || !settings.sound) return;
      const t0 = c.currentTime;
      [660, 560, 440, 330].forEach((f, i) => {
        const g = c.createGain(); g.connect(master);
        const t = t0 + i * 0.16;
        env(g, t, 0.2, 0.01, 0.4);
        const o = c.createOscillator();
        o.type = 'triangle'; o.frequency.value = f;
        o.connect(g); o.start(t); o.stop(t + 0.45);
      });
    }

    /* 简易背景音乐：五声音阶琶音 */
    function musicStart() {
      if (musicTimer) return;
      const scale = [523.25, 587.33, 698.46, 783.99, 880.0, 1046.5];
      let step = 0;
      musicTimer = setInterval(() => {
        if (!settings.music || !unlocked) return;
        const c = ensure(); if (!c) return;
        const t0 = c.currentTime;
        const f = scale[step % scale.length];
        step++;
        const g = c.createGain(); g.connect(master);
        env(g, t0, 0.045, 0.02, 0.42);
        const o = c.createOscillator();
        o.type = 'triangle'; o.frequency.value = f;
        o.connect(g); o.start(t0); o.stop(t0 + 0.5);
        if (step % 4 === 0) {
          const bg = c.createGain(); bg.connect(master);
          env(bg, t0, 0.035, 0.02, 0.5);
          const bo = c.createOscillator();
          bo.type = 'sine'; bo.frequency.value = 130.81;
          bo.connect(bg); bo.start(t0); bo.stop(t0 + 0.55);
        }
      }, 340);
    }

    function musicStop() { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } }

    function setVolume(v) {
      settings.volume = v;
      if (master) master.gain.value = v;
    }

    return {
      unlock, hit: () => muyu(1), miss, gold, boom, shield, power, over,
      musicStart, musicStop, setVolume,
    };
  })();

  function vibrate(pattern) {
    if (!settings.vibrate) return;
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) { /* noop */ } }
  }

  /* ======================================================================
     8. 反馈特效：粒子 / 飘字 / 震屏
     ====================================================================== */

  const fx = (() => {
    const canvas = $('#fx');
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, dpr = 1;
    const parts = [];

    function resize() {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width; h = r.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function push(p) { parts.push(p); }

    function dirt(x, y) {
      for (let i = 0; i < 14; i++) {
        const a = rand(-Math.PI * 0.9, -Math.PI * 0.1);
        const sp = rand(60, 230);
        push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 620,
               life: rand(0.35, 0.75), max: 0.75, r: rand(2, 4.6),
               c: pick(['#8b5a2b', '#6b4423', '#a9713f', '#4e2e14']), shape: 'dot' });
      }
      push({ x, y, r: 12, life: 0.3, max: 0.3, c: 'rgba(255,235,190,.55)', shape: 'ring', vx: 0, vy: 0, g: 0 });
    }

    function dust(x, y) {
      for (let i = 0; i < 8; i++) {
        const a = rand(-Math.PI, 0);
        const sp = rand(30, 110);
        push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 420,
               life: rand(0.25, 0.5), max: 0.5, r: rand(1.5, 3),
               c: 'rgba(210,190,150,.6)', shape: 'dot' });
      }
    }

    function sparkle(x, y, n = 14) {
      for (let i = 0; i < n; i++) {
        const a = rand(0, Math.PI * 2);
        const sp = rand(40, 190);
        push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, g: 160,
               life: rand(0.4, 0.9), max: 0.9, r: rand(1.6, 3.6),
               c: pick(['#ffe066', '#ffd76a', '#fff4b8', '#ffb703']), shape: 'star' });
      }
    }

    function explode(x, y) {
      for (let i = 0; i < 26; i++) {
        const a = rand(0, Math.PI * 2);
        const sp = rand(80, 330);
        push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 540,
               life: rand(0.4, 0.9), max: 0.9, r: rand(2.5, 6),
               c: pick(['#ff7847', '#ff5470', '#ffc14d', '#8b2b1f', '#ff9f1c']), shape: 'dot' });
      }
      push({ x, y, r: 14, life: 0.45, max: 0.45, c: 'rgba(255,140,60,.8)', shape: 'ring', vx: 0, vy: 0, g: 0 });
    }

    function confetti(x, y) {
      const colors = ['#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#b388eb', '#ff9f1c'];
      for (let i = 0; i < 24; i++) {
        const a = rand(-Math.PI * 0.95, -Math.PI * 0.05);
        const sp = rand(120, 330);
        push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 620,
               life: rand(0.7, 1.4), max: 1.4, r: rand(3, 6),
               c: pick(colors), shape: 'confetti', rot: rand(0, 6.28), vr: rand(-9, 9) });
      }
    }

    function ring(x, y, color) {
      push({ x, y, r: 8, life: 0.4, max: 0.4, c: color, shape: 'ring', vx: 0, vy: 0, g: 0 });
    }

    function update(dt) {
      const s = dt / 1000;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life -= s;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        if (p.shape === 'ring') { p.r += (p.max / p.life) * 90 * s; continue; }
        p.vy += (p.g || 0) * s;
        p.x += p.vx * s;
        p.y += p.vy * s;
        if (p.vr) p.rot += p.vr * s;
      }
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        const k = clamp(p.life / p.max, 0, 1);
        ctx.globalAlpha = k;
        if (p.shape === 'ring') {
          ctx.strokeStyle = p.c;
          ctx.lineWidth = 2.5 * k + 0.5;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.stroke();
        } else if (p.shape === 'star') {
          ctx.fillStyle = p.c;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot || 0);
          ctx.beginPath();
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2;
            ctx.lineTo(Math.cos(a) * p.r * 1.8, Math.sin(a) * p.r * 1.8);
            ctx.lineTo(Math.cos(a + Math.PI / 4) * p.r * 0.6, Math.sin(a + Math.PI / 4) * p.r * 0.6);
          }
          ctx.closePath(); ctx.fill();
          ctx.restore();
        } else if (p.shape === 'confetti') {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot || 0);
          ctx.fillStyle = p.c;
          ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
          ctx.restore();
        } else {
          ctx.fillStyle = p.c;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.4 + k * 0.6), 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    return { resize, update, draw, dirt, dust, sparkle, explode, confetti, ring };
  })();

  /** 屏幕震动 */
  let shakeAmp = 0, shakeTime = 0;
  function shake(amount) {
    if (prefersReducedMotion()) return;
    shakeAmp = Math.max(shakeAmp, amount);
    shakeTime = 320;
    hitStopUntil = now() + 90;   // 命中定格，增强打击感
  }
  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function flash() {
    const v = $('#vignette');
    if (!v) return;
    v.classList.remove('is-flash');
    void v.offsetWidth;
    v.classList.add('is-flash');
  }

  /** 浮动文字 */
  function floatText(x, y, text, kind = 'plus') {
    const wrap = $('#boardWrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = `pop pop--${kind}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y - 22}px`;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 900);
  }

  /* ======================================================================
     9. 界面
     ====================================================================== */

  const ui = {
    score: $('#scoreValue'), time: $('#timeValue'), best: $('#bestValue'),
    timerRing: $('#timerRing'), timerStat: $('#timerStat'),
    comboFill: $('#comboFill'), comboCount: $('#comboCount'), comboMult: $('#comboMult'),
    comboBar: $('#comboBar'), powups: $('#powups'),
    board: $('#board'), boardWrap: $('#boardWrap'),
    countdown: $('#countdown'), banner: $('#comboBanner'),
    toast: $('#toast'), live: $('#live'),
    playBtn: $('#playBtn'), pauseBtn: $('#pauseBtn'), settingsBtn: $('#settingsBtn'),
  };

  const RING = 2 * Math.PI * 19;

  /** 主按钮文字（保留内联图标） */
  function setPlayLabel(text) {
    const span = ui.playBtn.querySelector('span');
    if (span) span.textContent = text;
    else ui.playBtn.textContent = text;
  }

  function updateScoreUI() {
    ui.score.textContent = Math.floor(state.score);
    const b = save.data.best[state.difficulty] || 0;
    ui.best.textContent = Math.max(b, Math.floor(state.score));
  }

  function updateTimerUI() {
    if (state.endless) {
      ui.time.textContent = '∞';
      ui.timerRing.style.strokeDashoffset = 0;
      return;
    }
    const p = clamp(state.timeLeft / state.totalTime, 0, 1);
    ui.time.textContent = Math.ceil(state.timeLeft);
    ui.timerRing.style.strokeDasharray = RING;
    ui.timerRing.style.strokeDashoffset = RING * (1 - p);
    ui.timerRing.classList.toggle('is-low', state.timeLeft <= 10);
    ui.timerStat.classList.toggle('is-urgent', state.timeLeft <= 10 && state.timeLeft > 0);
  }

  function updateComboUI() {
    const has = state.combo > 0;
    ui.comboCount.textContent = state.combo;
    ui.comboMult.textContent = `×${state.mult}`;
    ui.comboBar.classList.toggle('is-hot', state.mult >= 4);
    const left = clamp((state.comboUntil - now()) / COMBO_WINDOW, 0, 1);
    ui.comboFill.style.width = has ? `${left * 100}%` : '0%';
  }

  function renderPowerups() {
    ui.powups.innerHTML = '';
    for (const [id, p] of Object.entries(state.power)) {
      const chip = document.createElement('div');
      chip.className = 'powup';
      chip.dataset.id = id;
      const secs = p.until ? `${Math.ceil((p.until - now()) / 1000)}s` : '∞';
      chip.innerHTML = `${POWERUP_ICON[p.def.icon] || ''}<span class="powup__name">${p.def.name}</span><span class="powup__time">${secs}</span>`;
      chip.title = `${p.def.name} — ${p.def.desc}`;
      chip.setAttribute('aria-label', `${p.def.name}，${p.def.desc}，剩余 ${secs}`);
      ui.powups.appendChild(chip);
    }
  }

  let bannerTimer = null;
  function showComboBanner(text, kind = 'good') {
    const el = ui.banner;
    if (!el) return;
    el.textContent = text;
    el.style.color = kind === 'bad' ? 'var(--danger)' : 'var(--accent)';
    el.classList.remove('is-show');
    void el.offsetWidth;
    el.classList.add('is-show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('is-show'), 1200);
  }

  let toastTimer = null;
  function toast(text, ms = 2200, action = null) {
    ui.toast.textContent = text;
    ui.toast.classList.add('is-show');
    ui.toast.onclick = action || null;
    ui.toast.style.pointerEvents = action ? 'auto' : 'none';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      ui.toast.classList.remove('is-show');
      ui.toast.onclick = null;
    }, ms);
  }

  function announce(text) {
    if (ui.live) ui.live.textContent = text;
  }

  /* ------------------------------- 棋盘布局 ------------------------------ */

  const HOLE_SVG_BACK = `
    <svg class="hole__art" viewBox="0 0 100 125" aria-hidden="true">
      <ellipse cx="50" cy="97" rx="44" ry="34" fill="rgba(0,0,0,.26)"/>
      <ellipse cx="50" cy="75" rx="50" ry="46" fill="url(#rimGrad)"/>
      <ellipse cx="50" cy="69" rx="42" ry="33" fill="#4e2e14"/>
      <ellipse cx="50" cy="69" rx="37" ry="28" fill="url(#wellGrad)"/>
      <path d="M13 69 A37 28 0 0 1 87 69" fill="none" stroke="#8b5a2b" stroke-width="3" opacity=".5"/>
    </svg>`;

  const HOLE_SVG_FRONT = `
    <svg class="hole__art hole__art--front" viewBox="0 0 100 125" aria-hidden="true">
      <path d="M13 69 A37 28 0 0 0 87 69 L87 106 A50 46 0 0 1 13 106 Z" fill="url(#rimGrad)"/>
      <path d="M13 69 A37 28 0 0 0 87 69" fill="none" stroke="#a9713f" stroke-width="2.5" opacity=".55"/>
    </svg>`;

  const MOLE_SVG = `
    <svg viewBox="0 0 70 72" aria-hidden="true">
      <g class="mole__ear-g">
        <circle class="mole__ear" cx="9" cy="18" r="8"/>
        <circle class="mole__ear" cx="61" cy="18" r="8"/>
        <circle class="mole__ear-in" cx="9" cy="19" r="4"/>
        <circle class="mole__ear-in" cx="61" cy="19" r="4"/>
      </g>
      <ellipse class="mole__body" cx="35" cy="62" rx="23" ry="15"/>
      <ellipse class="mole__fur" cx="35" cy="33" rx="26" ry="25"/>
      <ellipse class="mole__muzzle" cx="35" cy="43" rx="18" ry="16"/>
      <g class="mole__brows">
        <path d="M20 24 L31 29"/>
        <path d="M50 24 L39 29"/>
      </g>
      <g class="mole__eyes">
        <ellipse class="mole__eye-white" cx="27" cy="28" rx="5" ry="5.6"/>
        <ellipse class="mole__eye-white" cx="43" cy="28" rx="5" ry="5.6"/>
        <circle class="mole__pupil" cx="27.8" cy="29" r="2.9"/>
        <circle class="mole__pupil" cx="43.8" cy="29" r="2.9"/>
        <circle class="mole__glint" cx="29" cy="26.6" r="1.2"/>
        <circle class="mole__glint" cx="45" cy="26.6" r="1.2"/>
      </g>
      <g class="mole__eyes-closed">
        <path d="M22 29 q5 5 10 0"/>
        <path d="M38 29 q5 5 10 0"/>
      </g>
      <ellipse class="mole__blush" cx="16" cy="40" rx="5.5" ry="3.2"/>
      <ellipse class="mole__blush" cx="54" cy="40" rx="5.5" ry="3.2"/>
      <ellipse class="mole__nose" cx="35" cy="38" rx="6.5" ry="4.6"/>
      <rect class="mole__tooth" x="31.5" y="45" width="3.6" height="6" rx="1.8"/>
      <rect class="mole__tooth" x="34.9" y="45" width="3.6" height="6" rx="1.8"/>
      <g class="mole__whiskers">
        <path d="M18 40 L6 37"/><path d="M18 45 L7 46"/>
        <path d="M52 40 L64 37"/><path d="M52 45 L63 46"/>
      </g>
      <g class="mole__fuse">
        <path d="M35 13 q3 -8 9 -6 q4 2 1 4.5 q-2 1.5 -4 .5"/>
        <circle class="mole__spark" cx="45" cy="7" r="2.8"/>
      </g>
      <g class="mole__zzz">
        <text x="47" y="22" font-size="14" font-weight="700" fill="#eaf3ff">Z</text>
        <text x="57" y="12" font-size="10" font-weight="700" fill="#eaf3ff">z</text>
      </g>
      <g class="mole__shine">
        <path d="M58 18 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" fill="#fff3a8"/>
        <path d="M12 12 l1.4 3.4 3.4 1.4 -3.4 1.4 -1.4 3.4 -1.4 -3.4 -3.4 -1.4 3.4 -1.4z" fill="#fff3a8"/>
      </g>
    </svg>`;

  function buildBoard() {
    const n = clamp(settings.holes, 4, 16);

    // 棋盘保持正方形，尺寸取可用空间的较小值
    const stage = ui.boardWrap.parentElement;
    const avail = stage.getBoundingClientRect();
    const size = Math.max(220, Math.floor(Math.min(avail.width, avail.height, 560)));
    ui.boardWrap.style.width = `${size}px`;
    ui.boardWrap.style.height = `${size}px`;

    const r = ui.board.getBoundingClientRect();
    const w = r.width || 360, h = r.height || 360;
    boardRect = { w, h };

    const holeSize = clamp(
      Math.round(w * (n <= 9 ? 0.158 : n <= 12 ? 0.14 : 0.124)),
      38, Math.round(h * 0.175),
    );
    const boxH = holeSize * 1.25;
    const marginX = holeSize * 0.52;
    const marginY = holeSize * 0.46;
    const region = {
      x0: marginX, x1: w - marginX,
      y0: h * 0.28 + marginY, y1: h - marginY,
    };

    const positions = layoutPositions(n, region, holeSize);

    ui.board.innerHTML = '';
    holes.length = 0;

    positions.forEach((pos, i) => {
      const el = document.createElement('button');
      el.className = 'hole';
      el.type = 'button';
      el.setAttribute('aria-label', `地鼠洞 ${i + 1}`);
      el.style.left = `${pos.x - holeSize / 2}px`;
      el.style.top = `${pos.y - boxH * 0.552}px`;
      el.style.setProperty('--hole', `${holeSize}px`);

      el.insertAdjacentHTML('beforeend', HOLE_SVG_BACK);

      const moleEl = document.createElement('span');
      moleEl.className = 'mole';
      moleEl.innerHTML = MOLE_SVG;
      el.appendChild(moleEl);

      el.insertAdjacentHTML('beforeend', HOLE_SVG_FRONT);

      ui.board.appendChild(el);

      const hole = {
        el, moleEl, nx: pos.nx, ny: pos.ny, mole: null,
        cx: pos.x, cy: pos.y,
      };
      holes.push(hole);

      let lastPointer = 0;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        lastPointer = performance.now();
        hitHole(hole);
        swingHammer(e.clientX, e.clientY);
      });
      el.addEventListener('click', () => {
        if (performance.now() - lastPointer < 700) return;  // 指针已处理，避免重复计分
        hitHole(hole);
      });
    });

    scene.resize();
    fx.resize();
  }

  /** 计算洞位（归一化坐标 + 像素坐标） */
  function layoutPositions(n, region, holeSize) {
    const out = [];
    const rw = region.x1 - region.x0;
    const rh = region.y1 - region.y0;
    const need = holeSize * 1.06;          // 洞心最小间距

    const push = (nx, ny) => {
      out.push({
        nx, ny,
        x: region.x0 + nx * rw,
        y: region.y0 + ny * rh,
      });
    };

    switch (settings.layout) {
      case 'grid': {
        let cols = Math.ceil(Math.sqrt(n));
        let rows = Math.ceil(n / cols);
        while (cols > 1 && (rw / cols < need || rh / rows < need)) {
          if (rw / cols <= rh / rows) cols--; else rows--;
          rows = Math.ceil(n / cols);
        }
        for (let i = 0; i < n; i++) {
          const c = i % cols, r = Math.floor(i / cols);
          const inRow = Math.min(cols, n - r * cols);
          const nx = inRow === 1 ? 0.5 : (c + 0.5) / inRow;
          const ny = rows === 1 ? 0.5 : (r + 0.5) / rows;
          push(nx, ny);
        }
        break;
      }
      case 'arc': {
        const rows = n <= 6 ? 2 : 3;
        const per = Math.ceil(n / rows);
        for (let r = 0; r < rows; r++) {
          const count = Math.min(per, n - r * per);
          const t = rows === 1 ? 0 : r / (rows - 1);
          const y = 0.08 + t * 0.86;
          const span = Math.min(1, (need * count) / rw);
          const start = 0.5 - span / 2;
          for (let i = 0; i < count; i++) {
            const u = count === 1 ? 0.5 : i / (count - 1);
            const nx = clamp(start + span * u, 0, 1);
            push(nx, y + Math.sin(u * Math.PI) * 0.04);
          }
        }
        break;
      }
      case 'scatter': {
        const pts = [];
        let guard = 0;
        while (pts.length < n && guard++ < 1200) {
          const nx = rand(0.03, 0.97), ny = rand(0.03, 0.97);
          const ok = pts.every(p => Math.hypot((p.nx - nx) * rw, (p.ny - ny) * rh) > need);
          if (ok) pts.push({ nx, ny });
        }
        while (pts.length < n) pts.push({ nx: rand(0.1, 0.9), ny: rand(0.1, 0.9) });
        pts.forEach(p => push(p.nx, p.ny));
        break;
      }
      case 'circle':
      default: {
        let rx = rw / 2 * 0.94;
        let ry = rh / 2 * 0.9;
        // 周长需容纳所有洞
        const per = (a, b) => Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
        const needP = n * need;
        const p0 = per(rx, ry);
        if (p0 < needP) {
          const k = Math.sqrt(needP / p0);
          rx *= k; ry *= k;
        }
        const nx = rx / (rw / 2) * 0.5;
        const ny = ry / (rh / 2) * 0.5;

        if (n >= 7) {
          // 双环：外环 + 内环，避免中间留白
          const outer = Math.ceil(n * 0.58);
          const inner = n - outer;
          for (let i = 0; i < outer; i++) {
            const a = (i / outer) * Math.PI * 2 - Math.PI / 2;
            push(0.5 + Math.cos(a) * nx, 0.5 + Math.sin(a) * ny);
          }
          for (let i = 0; i < inner; i++) {
            const a = (i / inner) * Math.PI * 2 - Math.PI / 2 + 0.4;
            push(0.5 + Math.cos(a) * nx * 0.52, 0.5 + Math.sin(a) * ny * 0.52);
          }
        } else {
          for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 - Math.PI / 2;
            push(0.5 + Math.cos(a) * nx, 0.5 + Math.sin(a) * ny);
          }
        }
        break;
      }
    }
    return out;
  }

  /* ------------------------------- 木槌光标 ----------------------------- */

  let hammerEl = null;
  function initHammer() {
    hammerEl = document.createElement('div');
    hammerEl.className = 'hammer is-hidden';
    hammerEl.innerHTML = `
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <g transform="rotate(-20 50 46)">
          <rect x="43" y="30" width="15" height="64" rx="7.5" fill="#d9a066"/>
          <rect x="46" y="34" width="4" height="54" rx="2" fill="#fff" opacity=".25"/>
          <rect x="18" y="14" width="64" height="28" rx="13" fill="#b8793f"/>
          <rect x="24" y="19" width="28" height="8" rx="4" fill="#fff" opacity=".33"/>
          <rect x="18" y="14" width="64" height="28" rx="13" fill="none" stroke="#8d5a2c" stroke-width="2"/>
        </g>
      </svg>`;
    document.body.appendChild(hammerEl);

    let raf = 0, tx = 0, ty = 0;
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      tx = e.clientX; ty = e.clientY;
      hammerEl.classList.remove('is-hidden');
      if (!raf) {
        raf = requestAnimationFrame(() => {
          hammerEl.style.transform = `translate(${tx}px, ${ty}px) rotate(-18deg)`;
          raf = 0;
        });
      }
    }, { passive: true });
  }

  function swingHammer(x, y) {
    if (!hammerEl) return;
    hammerEl.classList.remove('is-swing');
    void hammerEl.offsetWidth;
    hammerEl.classList.add('is-swing');
  }

  /* ------------------------------ 游戏流程 ------------------------------ */

  function resetState(endless) {
    const d = diff();
    state.difficulty = state.difficulty || 'medium';
    state.score = 0;
    state.hits = 0; state.emptyHits = 0; state.escapes = 0;
    state.goldHits = 0; state.bombHits = 0;
    state.combo = 0; state.maxCombo = 0; state.mult = 1; state.comboUntil = 0;
    state.elapsed = 0;
    state.spawnAcc = 0;
    state.power = {};
    state.shield = false;
    state.timeScale = 1;
    state.endless = !!endless;
    state.totalTime = d.time;
    state.timeLeft = d.time;
    state.moles = [];
    holes.forEach(h => {
      h.mole = null;
      h.moleEl.className = 'mole';
    });
    ui.powups.innerHTML = '';
    $('#stageHint')?.classList.remove('is-hidden');
    updateScoreUI();
    updateTimerUI();
    updateComboUI();
  }

  function startCountdown() {
    state.phase = 'countdown';
    const seq = ['3', '2', '1', 'GO!'];
    let i = 0;
    const step = () => {
      if (state.phase !== 'countdown') return;
      ui.countdown.innerHTML = `<span>${seq[i]}</span>`;
      audio.hit();
      i++;
      if (i < seq.length) setTimeout(step, 620);
      else {
        setTimeout(() => {
          ui.countdown.innerHTML = '';
          if (state.phase === 'countdown') beginPlay();
        }, 420);
      }
    };
    step();
  }

  function beginPlay() {
    state.phase = 'playing';
    setPlayLabel('继续');
    ui.pauseBtn.disabled = false;
    setDifficultyEnabled(false);
    if (settings.music) audio.musicStart();
  }

  function startGame(endless = false) {
    audio.unlock();
    resetState(endless);
    closeAllOverlays();
    startCountdown();
  }

  function pauseGame() {
    if (state.phase !== 'playing') return;
    state.phase = 'paused';
    setPlayLabel('继续');
    ui.pauseBtn.disabled = true;
    audio.musicStop();
    state.moles.forEach(m => { m.el.classList.remove('is-up'); });
    state.moles = [];
    holes.forEach(h => { h.mole = null; h.moleEl.className = 'mole'; });
    openOverlay('#pauseOverlay');
  }

  function resumeGame() {
    if (state.phase !== 'paused') return;
    closeOverlay('#pauseOverlay');
    state.phase = 'playing';
    ui.pauseBtn.disabled = false;
    if (settings.music) audio.musicStart();
  }

  function endGame() {
    if (state.phase === 'over') return;
    state.phase = 'over';
    audio.musicStop();
    audio.over();
    state.moles.forEach(m => m.el.classList.remove('is-up'));
    state.moles = [];
    holes.forEach(h => { h.mole = null; h.moleEl.className = 'mole'; });
    setPlayLabel('开始');
    ui.pauseBtn.disabled = true;
    setDifficultyEnabled(true);

    const d = diff();
    const score = Math.floor(state.score);
    const prevBest = save.data.best[state.difficulty] || 0;
    const isRecord = score > prevBest;
    if (isRecord) save.data.best[state.difficulty] = score;
    save.data.stats.games++;
    save.data.stats.hits += state.hits;
    save.data.stats.total += score;
    save.write();

    const attempts = state.hits + state.emptyHits + state.escapes;
    const acc = attempts ? Math.round((state.hits / attempts) * 100) : 0;
    const r = d.rank;
    const rank = score >= r.S ? 'S' : score >= r.A ? 'A' : score >= r.B ? 'B' : score >= r.C ? 'C' : 'D';

    $('#rankBadge').textContent = rank;
    $('#rankBadge').dataset.rank = rank;
    $('#finalScore').textContent = score;
    $('#rHits').textContent = state.hits;
    $('#rAcc').textContent = `${acc}%`;
    $('#rCombo').textContent = state.maxCombo;
    $('#rGold').textContent = state.goldHits;
    $('#rBomb').textContent = state.bombHits;
    $('#rTime').textContent = `${Math.round(state.elapsed / 1000)}s`;
    $('#newRecord').hidden = !isRecord;
    $('#overTitle').textContent = state.endless ? '本局结束' : '时间到！';

    updateScoreUI();
    openOverlay('#overOverlay');
    announce(`游戏结束，得分 ${score}，评级 ${rank}`);
  }

  function quitToHome() {
    state.phase = 'idle';
    state.moles = [];
    holes.forEach(h => { h.mole = null; h.moleEl.className = 'mole'; });
    audio.musicStop();
    setPlayLabel('开始');
    ui.pauseBtn.disabled = true;
    setDifficultyEnabled(true);
    closeAllOverlays();
    openOverlay('#startOverlay');
  }

  function setDifficultyEnabled(on) {
    $$('.chip-btn[data-difficulty]').forEach(b => { b.disabled = !on; });
  }

  /* ------------------------------ 覆盖层 ------------------------------- */

  function openOverlay(sel) {
    const el = $(sel);
    if (el) { el.classList.add('is-open'); }
  }
  function closeOverlay(sel) {
    const el = $(sel);
    if (el) { el.classList.remove('is-open'); }
  }
  function closeAllOverlays() {
    $$('.overlay').forEach(o => o.classList.remove('is-open'));
  }

  /* ------------------------------ 设置面板 ----------------------------- */

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    scene.resize();
  }

  function bindSettings() {
    const toggles = [
      ['#soundToggle', 'sound'],
      ['#richToggle', 'rich'],
      ['#musicToggle', 'music'],
      ['#vibrateToggle', 'vibrate'],
      ['#strictToggle', 'strict'],
    ];
    toggles.forEach(([sel, key]) => {
      const el = $(sel);
      if (!el) return;
      el.setAttribute('aria-checked', String(!!settings[key]));
      el.classList.toggle('is-on', !!settings[key]);
      el.addEventListener('click', () => {
        settings[key] = !settings[key];
        el.setAttribute('aria-checked', String(settings[key]));
        el.classList.toggle('is-on', settings[key]);
        save.write();
        if (key === 'music') { if (settings.music) audio.musicStart(); else audio.musicStop(); }
        if (key === 'sound' && settings.sound) audio.unlock();
      });
    });

    const vol = $('#volumeSlider');
    if (vol) {
      vol.value = Math.round(settings.volume * 100);
      vol.addEventListener('input', () => {
        audio.setVolume(Number(vol.value) / 100);
        save.write();
      });
    }

    const holeSlider = $('#holeSlider');
    const holeValue = $('#holeValue');
    if (holeSlider) {
      holeSlider.value = settings.holes;
      holeValue.textContent = settings.holes;
      holeSlider.addEventListener('input', () => {
        settings.holes = Number(holeSlider.value);
        holeValue.textContent = settings.holes;
        save.write();
        buildBoard();
      });
    }

    $$('#layoutGroup .seg__btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.layout === settings.layout);
      btn.addEventListener('click', () => {
        $$('#layoutGroup .seg__btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        settings.layout = btn.dataset.layout;
        save.write();
        buildBoard();
      });
    });

    $$('#themeGroup .seg__btn').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.theme === settings.theme);
      btn.addEventListener('click', () => {
        $$('#themeGroup .seg__btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
        settings.theme = btn.dataset.theme;
        save.write();
        applyTheme(settings.theme);
      });
    });

    $('#wipeBtn')?.addEventListener('click', () => {
      if (!confirm('确定清除所有记录与设置吗？')) return;
      save.wipe();
      Object.assign(settings, DEFAULT_SETTINGS);
      buildBoard();
      applyTheme(settings.theme);
      toast('已清除所有数据');
      syncSettingsUI();
    });
  }

  function syncSettingsUI() {
    const map = { sound: '#soundToggle', rich: '#richToggle', music: '#musicToggle', vibrate: '#vibrateToggle', strict: '#strictToggle' };
    for (const [key, sel] of Object.entries(map)) {
      const el = $(sel);
      if (el) { el.setAttribute('aria-checked', String(!!settings[key])); el.classList.toggle('is-on', !!settings[key]); }
    }
    const vol = $('#volumeSlider'); if (vol) vol.value = Math.round(settings.volume * 100);
    const hs = $('#holeSlider'); if (hs) { hs.value = settings.holes; $('#holeValue').textContent = settings.holes; }
    $$('#layoutGroup .seg__btn').forEach(b => b.classList.toggle('is-active', b.dataset.layout === settings.layout));
    $$('#themeGroup .seg__btn').forEach(b => b.classList.toggle('is-active', b.dataset.theme === settings.theme));
  }

  /* ------------------------------ 事件绑定 ----------------------------- */

  function bindEvents() {
    $('#startBtn').addEventListener('click', () => startGame(false));
    $('#startEndlessBtn').addEventListener('click', () => startGame(true));
    $('#startRulesBtn').addEventListener('click', () => {
      const p = $('#rulesPanel');
      p.hidden = !p.hidden;
    });
    $('#resumeBtn').addEventListener('click', resumeGame);
    $('#restartBtn').addEventListener('click', () => { closeOverlay('#pauseOverlay'); startGame(state.endless); });
    $('#quitBtn').addEventListener('click', quitToHome);
    $('#againBtn').addEventListener('click', () => startGame(state.endless));
    $('#homeBtn').addEventListener('click', quitToHome);

    ui.playBtn.addEventListener('click', () => {
      if (state.phase === 'idle' || state.phase === 'over') startGame(state.endless);
      else if (state.phase === 'paused') resumeGame();
    });
    ui.pauseBtn.addEventListener('click', pauseGame);

    ui.settingsBtn.addEventListener('click', () => {
      if (state.phase === 'playing') pauseGame();
      openOverlay('#settingsOverlay');
    });
    $('#homeSettingsBtn')?.addEventListener('click', () => openOverlay('#settingsOverlay'));
    $('#closeSettings').addEventListener('click', () => closeOverlay('#settingsOverlay'));
    $('#settingsOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'settingsOverlay') closeOverlay('#settingsOverlay');
    });

    $$('.chip-btn[data-difficulty]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.phase === 'playing' || state.phase === 'countdown') return;
        $$('.chip-btn[data-difficulty]').forEach(b => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-checked', String(b === btn));
        });
        state.difficulty = btn.dataset.difficulty;
        resetState(state.endless);
      });
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        if (document.activeElement && document.activeElement.classList.contains('hole')) return;
        if (state.phase === 'playing') { e.preventDefault(); pauseGame(); }
        else if (state.phase === 'idle' || state.phase === 'over') { e.preventDefault(); startGame(state.endless); }
      }
      if (e.key === 'Escape') {
        if ($('#settingsOverlay').classList.contains('is-open')) closeOverlay('#settingsOverlay');
        else if (state.phase === 'playing') pauseGame();
      }
    });

    // 离开页面自动暂停
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.phase === 'playing') pauseGame();
    });

    // 尺寸变化
    let rt = null;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => { buildBoard(); }, 180);
    });

    // 首次交互解锁音频
    const unlockOnce = () => { audio.unlock(); document.removeEventListener('pointerdown', unlockOnce); };
    document.addEventListener('pointerdown', unlockOnce);
  }

  /* ------------------------------ 安装提示 ----------------------------- */

  let deferredPrompt = null;
  function initInstall() {
    const btn = $('#installBtn');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      if (btn) btn.hidden = false;
    });
    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      if (btn) btn.hidden = true;
      toast('已添加到桌面 🎉');
    });
    btn?.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') toast('正在安装…');
      deferredPrompt = null;
      btn.hidden = true;
    });
  }

  /* ======================================================================
     10. 启动
     ====================================================================== */

  function injectDefs() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.innerHTML = `
      <defs>
        <radialGradient id="wellGrad" cx="50%" cy="38%" r="64%">
          <stop offset="0" stop-color="#000000"/>
          <stop offset="0.6" stop-color="#170c04"/>
          <stop offset="1" stop-color="#3a2210"/>
        </radialGradient>
        <linearGradient id="rimGrad" gradientUnits="userSpaceOnUse" x1="0" y1="29" x2="0" y2="121">
          <stop offset="0" stop-color="#9a6631"/>
          <stop offset="0.55" stop-color="#7b4a1f"/>
          <stop offset="1" stop-color="#4e2e14"/>
        </linearGradient>
      </defs>`;
    document.body.appendChild(svg);
  }

  function boot() {
    injectDefs();
    applyTheme(settings.theme);
    const activeDiff = document.querySelector('.chip-btn[data-difficulty].is-active');
    state.difficulty = DIFFICULTY[activeDiff?.dataset.difficulty] ? activeDiff.dataset.difficulty : 'medium';
    buildBoard();
    bindSettings();
    bindEvents();
    initHammer();
    initInstall();
    syncSettingsUI();
    updateScoreUI();
    updateTimerUI();
    updateComboUI();

    window.addEventListener('sw:update', () => {
      toast('发现新版本，点击此处立即更新', 8000, () => location.reload());
    });

    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 调试入口
  window.__dds = { state, settings, save, holes, startGame, hitHole, audio, fx };
})();
