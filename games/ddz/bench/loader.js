'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAI(file, symbols, rng, params) {
    const abs = path.isAbsolute(file) ? file : path.join(__dirname, '..', file);
    let code = fs.readFileSync(abs, 'utf8');
    let exp = ';globalThis.__AI__ = {};\n';
    for (const s of symbols) exp += `try { globalThis.__AI__[${JSON.stringify(s)}] = ${s}; } catch (e) {}\n`;
    code += exp;

    const mathLike = Object.create(Math);
    if (typeof rng === 'function') mathLike.random = rng;

    const sandbox = {
        self: { postMessage() {}, onmessage: null },
        console,
        Date,
        Math: mathLike,
        JSON,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        navigator: {},
    };
    sandbox.globalThis = sandbox;
    sandbox.self.self = sandbox.self;
    if (params) sandbox.__AI_PARAMS__ = params;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: abs });
    return sandbox.__AI__;
}

module.exports = { loadAI };
