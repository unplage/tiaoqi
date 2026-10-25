'use strict';
// icons/make_icons.js — 生成 PWA 图标（像素风斗地主：三张牌 + 地主金冠）
// 纯 Node 实现（仅用内置 zlib 手写 PNG 编码），无第三方依赖、不参与运行时。
// 用法： node icons/make_icons.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ======================== 最小 PNG 编码器 ========================
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;                 // filter: None
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;                     // 8bit / RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// ======================== 像素画布 ========================
const G = 32;                                       // 逻辑像素网格（32×32）
class Canvas {
    constructor(w, h) { this.w = w; this.h = h; this.buf = Buffer.alloc(w * h * 4, 0); }
    set(x, y, [r, g, b, a = 255]) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const i = (y * this.w + x) * 4;
        if (a >= 255) { this.buf[i] = r; this.buf[i + 1] = g; this.buf[i + 2] = b; this.buf[i + 3] = 255; return; }
        const sa = a / 255, da = this.buf[i + 3] / 255;
        const oa = sa + da * (1 - sa);
        this.buf[i] = Math.round((r * sa + this.buf[i] * da * (1 - sa)) / (oa || 1));
        this.buf[i + 1] = Math.round((g * sa + this.buf[i + 1] * da * (1 - sa)) / (oa || 1));
        this.buf[i + 2] = Math.round((b * sa + this.buf[i + 2] * da * (1 - sa)) / (oa || 1));
        this.buf[i + 3] = Math.round(oa * 255);
    }
    rect(x0, y0, w, h, color) {
        for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, color);
    }
    // 斜切矩形：每一行横向偏移 shift(row)，用于像素风"扇形"牌
    shearedRect(x0, y0, w, h, shear, color) {
        for (let r = 0; r < h; r++) {
            const off = Math.round(shear * r / Math.max(1, h - 1));
            for (let c = 0; c < w; c++) this.set(x0 + c + off, y0 + r, color);
        }
    }
    blit(sprite, x0, y0, palette) {
        for (let r = 0; r < sprite.length; r++) {
            const row = sprite[r];
            for (let c = 0; c < row.length; c++) {
                const key = row[c];
                if (key === '.' || key === ' ') continue;
                const col = palette[key];
                if (col) this.set(x0 + c, y0 + r, col);
            }
        }
    }
}

// ======================== 调色板（与应用 UI 一致） ========================
const C = {
    bg:      [26, 26, 46, 255],      // #1a1a2e 深蓝背景
    bgGlow:  [36, 36, 70, 255],      // #242446 中心微亮
    bgEdge:  [16, 16, 32, 255],      // #101020 暗角
    card:    [247, 247, 240, 255],   // 牌面
    cardEdge:[14, 14, 26, 255],      // 牌边框
    gold:    [255, 215, 0, 255],     // #ffd700 金冠
    goldDark:[184, 134, 11, 255],    // #b8860b 金冠暗部
    red:     [231, 76, 60, 255],     // #e74c3c 红桃/方块
    black:   [24, 24, 38, 255],      // 黑桃
    white:   [255, 255, 255, 255]
};

// 5×5 花色点阵
const SPADES = [
    '..X..',
    '.XXX.',
    'XXXXX',
    '..X..',
    '.XXX.'
];
const HEARTS = [
    '.X.X.',
    'XXXXX',
    'XXXXX',
    '.XXX.',
    '..X..'
];
const DIAMONDS = [
    '..X..',
    '.XXX.',
    'XXXXX',
    '.XXX.',
    '..X..'
];
// 13×5 地主金冠
const CROWN = [
    'X.....X.....X',
    'XX...XXX...XX',
    'XXXXXXXXXXXXX',
    'XXXXXXXXXXXXX',
    '.XXXXXXXXXXX.'
];

// 画一张牌（带描边 + 斜切 + 左上角花色）
function drawCard(cv, x0, y0, w, h, shear, pip, pipColor) {
    // 描边（比牌面大一圈）
    cv.shearedRect(x0 - 1, y0 - 1, w + 2, h + 2, shear, C.cardEdge);
    cv.shearedRect(x0, y0, w, h, shear, C.card);
    // 花色点（5×5），放在左上角，跟随斜切偏移
    const row = Math.max(1, Math.floor(h * 0.18));
    const off = Math.round(shear * row / Math.max(1, h - 1));
    cv.blit(pip, x0 + 1 + off, y0 + row, { X: pipColor });
}

// ======================== 图标合成 ========================
function buildIcon(scale) {
    const cv = new Canvas(G, G);
    // 背景：中心微亮的径向渐变（分 4 档，保持像素感）
    const cx = 15.5, cy = 16.5, maxR = 22;
    for (let y = 0; y < G; y++) {
        for (let x = 0; x < G; x++) {
            const d = Math.hypot(x - cx, y - cy) / maxR;
            let col = C.bg;
            if (d < 0.45) col = C.bgGlow;
            else if (d > 0.92) col = C.bgEdge;
            cv.set(x, y, col);
        }
    }
    // 金冠（地主帽）
    cv.blit(CROWN, 9, 4, { X: C.gold });
    cv.rect(10, 8, 12, 1, C.goldDark);
    cv.rect(15, 5, 2, 2, C.red);          // 冠上红宝石
    // 三张扇形牌：左（斜切向左）、右（斜切向右）、中间（最后画，压在最上层）
    drawCard(cv, 2, 13, 8, 12, -1.6, HEARTS, C.red);
    drawCard(cv, 22, 13, 8, 12, 1.6, DIAMONDS, C.red);
    drawCard(cv, 12, 10, 9, 14, 0, SPADES, C.black);
    return cv;
}

// 放大到目标尺寸（最近邻，保持硬像素边缘）
function upscale(cv, size) {
    const out = Buffer.alloc(size * size * 4);
    const cell = size / G;
    for (let y = 0; y < size; y++) {
        const gy = Math.min(G - 1, Math.floor(y / cell));
        for (let x = 0; x < size; x++) {
            const gx = Math.min(G - 1, Math.floor(x / cell));
            const si = (gy * G + gx) * 4, di = (y * size + x) * 4;
            out[di] = cv.buf[si]; out[di + 1] = cv.buf[si + 1];
            out[di + 2] = cv.buf[si + 2]; out[di + 3] = cv.buf[si + 3];
        }
    }
    return out;
}

// maskable 安全区：把 32×32 基准画布整体缩到 factor 居中，四周补背景色
function shrink(cv, size, factor) {
    const out = Buffer.alloc(size * size * 4);
    const cell = (size / G) * factor;              // 每个逻辑像素占多少目标像素
    const off = (size - cell * G) / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const di = (y * size + x) * 4;
            const gx = Math.floor((x - off) / cell);
            const gy = Math.floor((y - off) / cell);
            if (gx < 0 || gy < 0 || gx >= G || gy >= G) {
                out[di] = C.bg[0]; out[di + 1] = C.bg[1]; out[di + 2] = C.bg[2]; out[di + 3] = 255;
                continue;
            }
            const si = (gy * G + gx) * 4;
            out[di] = cv.buf[si]; out[di + 1] = cv.buf[si + 1];
            out[di + 2] = cv.buf[si + 2]; out[di + 3] = cv.buf[si + 3];
        }
    }
    return out;
}

const dir = __dirname;
const base = buildIcon();

// 常规图标（完整构图）
for (const size of [64, 128, 192, 512]) {
    fs.writeFileSync(path.join(dir, `icon-${size}.png`), encodePNG(size, size, upscale(base, size)));
}
// maskable 版本：内容缩到 70% 居中，四周留出被圆形/异形裁切的安全区
for (const msize of [192, 512]) {
    const name = msize === 512 ? 'icon-512-maskable.png' : 'icon-192-maskable.png';
    fs.writeFileSync(path.join(dir, name), encodePNG(msize, msize, shrink(base, msize, 0.70)));
}
// iOS apple-touch-icon（不透明、无圆角，交给系统裁切）
{
    const size = 180;
    fs.writeFileSync(path.join(dir, 'apple-touch-icon.png'), encodePNG(size, size, upscale(base, size)));
}
// favicon（32×32）
{
    const size = 32;
    fs.writeFileSync(path.join(dir, 'favicon.png'), encodePNG(size, size, upscale(base, size)));
}
console.log('图标已生成：icon-64/128/192/512.png, icon-192/512-maskable.png, apple-touch-icon.png, favicon.png');
