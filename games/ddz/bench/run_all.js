'use strict';
// bench/run_all.js — 一键跑完全部校验（并行）
//
// 用法：
//   node bench/run_all.js            # 快速档（默认，每个测试都是秒级~分钟级）
//   node bench/run_all.js --slow     # 加上强度/耗时分位数等慢测试
//   node bench/run_all.js --only=rules,smoke
//
// 为什么要并行：16 核机器上串行要 3~4 分钟，并行后墙钟 = 最慢的那个测试。
// 为什么要分层：把「每次提交都要跑」的快测和「发布前才跑」的慢测分开，
// 避免把宝贵的迭代时间花在重复验证上。

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SUITES = [
    // name, 脚本, 说明, 档位
    { name: 'rules',   file: 'rules_test.js',    desc: '牌型引擎单测 + fuzz',            tier: 'fast' },
    { name: 'mem',     file: 'memory_test.js',   desc: '记牌器 + 序列化往返',             tier: 'fast' },
    { name: 'replay',  file: 'replay_test.js',   desc: '回放一致性 + 不变量',             tier: 'fast' },
    { name: 'probe',   file: 'ai_probe.js',      desc: '行为断言（刻度/座位/记牌）',       tier: 'fast' },
    { name: 'worker',  file: 'worker_smoke.js',  desc: 'Worker 协议 + 主线程一致性',       tier: 'fast' },
    { name: 'online',  file: 'online_smoke.js',  desc: '联机三端协议冒烟',                 tier: 'fast' },
    { name: 'single',  file: 'single_smoke.js',  desc: '单机端到端（发牌→整局→结算）',    tier: 'fast' },
    { name: 'learner', file: 'learner_test.js',  desc: '学习闭环',                         tier: 'fast' },
    { name: 'smoke',   file: 'smoke.js',         desc: '五级难度决策路径 + 叫分',          tier: 'fast' },
    { name: 'fair',    file: 'blind_fairness.js', desc: '隐藏信息公平性回归',               tier: 'fast' },
    { name: 'endgame', file: 'endgame_test.js',  desc: '盲残局求解器质量',                 tier: 'full' },
    { name: 'duel',    file: 'duel.js',          desc: '位置级 A/B 对决（强度快测）',       tier: 'full' },
    { name: 'latency', file: 'latency_test.js',  desc: '决策耗时分位数',                   tier: 'full' },
    { name: 'strength', file: 'run.js',          desc: '整局配对自对弈（最慢）',            tier: 'full' },
];

const args = process.argv.slice(2);
const wantFull = args.includes('--slow') || args.includes('--all');
const filterArg = args.find(a => a.startsWith('--only='));
const filtered = filterArg ? filterArg.slice('--only='.length).split(',') : null;
const JOBS = Math.max(1, Math.min(8, Math.floor((os.cpus() || { length: 4 }).length / 2)));

const selected = SUITES.filter(t => {
    if (filtered && !filtered.includes(t.name)) return false;
    if (t.tier === 'full' && !wantFull) return false;
    return true;
});

const results = [];
let running = 0, done = 0;
const queue = selected.slice();

function launch() {
    while (running < JOBS && queue.length) {
        const t = queue.shift();
        running++;
        const t0 = Date.now();
        const child = spawn(process.execPath, [path.join(__dirname, t.file)], {
            stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024
        });
        let out = '';
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { out += d; });
        child.on('close', (code) => {
            const dt = (Date.now() - t0) / 1000;
            results.push({ name: t.name, ok: code === 0, dt, out, desc: t.desc });
            running--; done++;
            if (code !== 0) {
                console.log(`\n----- ${t.name} FAILED (exit ${code}) -----\n` + out.split('\n').slice(-25).join('\n'));
            }
            if (done === selected.length) finish();
            else launch();
        });
    }
}

function finish() {
    const order = selected.map(t => t.name);
    results.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    let failed = 0;
    console.log(`\n===== bench summary（${JOBS} 路并行，档位：${wantFull ? '全部' : '快速'}）=====`);
    for (const r of results) {
        if (!r.ok) failed++;
        const summary = (r.out.split('\n').filter(l => l.trim()).pop() || '').slice(0, 62);
        console.log(`${(r.ok ? 'PASS' : 'FAIL').padEnd(5)} ${r.name.padEnd(10)} ${r.dt.toFixed(1).padStart(6)}s  ${summary || r.desc}`);
    }
    const total = results.reduce((a, r) => a + r.dt, 0);
    const wall = results.length ? Math.max(...results.map(r => r.dt)) : 0;
    console.log(`\n串行总耗时 ${total.toFixed(1)}s → 并行墙钟 ${wall.toFixed(1)}s`);
    console.log(`${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
    process.exit(failed ? 1 : 0);
}

launch();
