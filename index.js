// 小小桌宠 · 独立 SillyTavern 扩展
// 形变引擎参考并移植自作者自己的 duangduang：WebGL 网格、局部高斯权重与弹簧回弹。
// 本扩展移除页面选图/原图抓取，改为独立桌宠 PNG 舞台与可调自由笔刷。
import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

const EXT = 'littlepet';
const DEFAULTS = { enabled: true, ballX: 1, ballY: .58, brush: 24, strength: 72, softness: 76, feedback: 100 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function cfg() {
    if (!extension_settings[EXT]) extension_settings[EXT] = {};
    const c = extension_settings[EXT];
    for (const [k, v] of Object.entries(DEFAULTS)) if (c[k] === undefined) c[k] = v;
    return c;
}
function save() { try { saveSettingsDebounced(); } catch {} }

const DB_NAME = 'little-pet-assets';
function openAssetDB() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('当前浏览器不支持本地图片存储'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('assets');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('打开图片仓库失败'));
    });
}
async function putPetImage(blob) {
    const db = await openAssetDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readwrite');
        tx.objectStore('assets').put(blob, 'pet-image');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error || new Error('保存图片失败')); };
    });
}
async function getPetImage() {
    const db = await openAssetDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readonly');
        const req = tx.objectStore('assets').get('pet-image');
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error || new Error('读取图片失败')); };
    });
}
async function putAsset(key, value) {
    const db = await openAssetDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readwrite');
        tx.objectStore('assets').put(value, key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error || new Error('保存选区失败')); };
    });
}
async function getAsset(key) {
    const db = await openAssetDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readonly');
        const req = tx.objectStore('assets').get(key);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error || new Error('读取选区失败')); };
    });
}
async function clearAsset(key) {
    const db = await openAssetDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readwrite');
        tx.objectStore('assets').delete(key);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error || new Error('清除选区失败')); };
    });
}
async function clearPetImage() {
    const db = await openAssetDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readwrite');
        tx.objectStore('assets').delete('pet-image');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error || new Error('删除图片失败')); };
    });
}

const BALL = '<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="lp-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f8c9d9"/><stop offset="1" stop-color="#d78eae"/></linearGradient></defs><path d="M32 5c-15 0-26 11-26 26 0 14 11 27 26 27s26-13 26-27C58 16 47 5 32 5Z" fill="url(#lp-g)"/><path d="M18 25c2-5 7-8 13-8" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".8"/><circle cx="23" cy="34" r="2.7" fill="#765565"/><circle cx="41" cy="34" r="2.7" fill="#765565"/><path d="M28 42q4 4 8 0" fill="none" stroke="#765565" stroke-width="2.4" stroke-linecap="round"/></svg>';

let maskMode = 'paint';
let maskStroke = null;
let pet = { maskCanvas: null, maskCtx: null, maskOverlay: null, maskOverlayCtx: null, maskPixels: null, image: null, url: '', gl: null, program: null, texture: null, positionBuffer: null, uvBuffer: null, indexBuffer: null, cols: 36, rows: 36, positions: null, uvs: null, indices: null, indexCount: 0, width: 0, height: 0, raf: 0, pointer: null, cx: 0, cy: 0, pullX: 0, pullY: 0, vx: 0, vy: 0 };

function shader(gl, type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || '着色器编译失败');
    return s;
}
function initGL(canvas) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true })
        || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('当前浏览器没有可用的 WebGL');
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl, gl.VERTEX_SHADER, 'attribute vec2 aPosition; attribute vec2 aUv; uniform vec2 uSize; varying vec2 vUv; void main(){ vUv=aUv; gl_Position=vec4(aPosition.x/uSize.x*2.0-1.0, 1.0-aPosition.y/uSize.y*2.0, 0.0, 1.0); }'));
    gl.attachShader(p, shader(gl, gl.FRAGMENT_SHADER, 'precision mediump float; uniform sampler2D uTexture; varying vec2 vUv; void main(){ gl_FragColor=texture2D(uTexture,vUv); }'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || '着色器链接失败');
    gl.useProgram(p);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return { gl, program: p, texture, positionBuffer: gl.createBuffer(), uvBuffer: gl.createBuffer(), indexBuffer: gl.createBuffer() };
}
function buildMesh(width, height) {
    const cols = 36, rows = clamp(Math.round(cols * height / width), 18, 64);
    const positions = new Float32Array((cols + 1) * (rows + 1) * 2);
    const uvs = new Float32Array(positions.length), indices = [];
    for (let y = 0; y <= rows; y++) for (let x = 0; x <= cols; x++) {
        const k = y * (cols + 1) + x;
        uvs[k * 2] = x / cols; uvs[k * 2 + 1] = y / rows;
    }
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const a = y * (cols + 1) + x, b = a + 1, c = a + cols + 1, d = c + 1;
        indices.push(a, b, c, b, d, c);
    }
    return { cols, rows, positions, uvs, indices: new Uint16Array(indices) };
}
function uploadTexture() {
    const gl = pet.gl;
    if (!gl || !pet.image) return;
    gl.bindTexture(gl.TEXTURE_2D, pet.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pet.image);
}
function prepareCanvas() {
    const canvas = document.querySelector('#lp-pet-canvas');
    if (!canvas || !pet.image) return false;
    // 保留原图像素尺寸，超出视口的部分在舞台内部滚动查看。
    const scale = 1;
    const w = Math.max(1, Math.round(pet.image.naturalWidth * scale));
    const h = Math.max(1, Math.round(pet.image.naturalHeight * scale));
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px'; canvas.style.display = 'block';
    const wrap = document.querySelector('#lp-canvas-wrap');
    if (wrap) { wrap.style.width = w + 'px'; wrap.style.height = h + 'px'; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    pet.width = w; pet.height = h;
    if (!pet.gl) Object.assign(pet, initGL(canvas));
    const mesh = buildMesh(w, h);
    pet.cols = mesh.cols; pet.rows = mesh.rows;
    pet.positions = mesh.positions; pet.uvs = mesh.uvs; pet.indices = mesh.indices;
    pet.indexCount = mesh.indices.length;
    const gl = pet.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, pet.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, pet.uvs, gl.STATIC_DRAW);
    const uvLoc = gl.getAttribLocation(pet.program, 'aUv');
    gl.enableVertexAttribArray(uvLoc); gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pet.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, pet.indices, gl.STATIC_DRAW);
    gl.viewport(0, 0, canvas.width, canvas.height);
    uploadTexture(); drawPet();
    return true;
}
function drawPet() {
    const gl = pet.gl;
    if (!gl || !pet.positions) return;
    const c = cfg();
    const brushRadius = Math.max(12, Math.min(pet.width, pet.height) * Number(c.brush) / 100);
    // 反馈范围独立于选区笔刷，按 duang 原版局部高斯反馈半径调节。
    const feedbackScale = clamp(Number(c.feedback) / 100, .5, 2.5);
    const feedbackRadius = Math.max(8, Math.min(pet.width, pet.height) * .17 * feedbackScale);
    const radius2 = feedbackRadius * feedbackRadius;
    const softness = clamp(Number(c.softness) / 100, .25, 1);
    const displacement = Math.hypot(pet.pullX, pet.pullY);
    for (let y = 0; y <= pet.rows; y++) for (let x = 0; x <= pet.cols; x++) {
        const k = y * (pet.cols + 1) + x;
        const px = x / pet.cols * pet.width, py = y / pet.rows * pet.height;
        const dx = px - pet.cx, dy = py - pet.cy, d2 = dx * dx + dy * dy;
        const maskWeight = maskAtUv(x / pet.cols, y / pet.rows);
        const weight = Math.exp(-d2 / (radius2 * softness)) * maskWeight;
        const edge = Math.exp(-d2 / (radius2 * 2.1)) * maskWeight;
        const squeeze = Math.min(.34, displacement / Math.max(brushRadius, 1) * .34) * weight;
        pet.positions[k * 2] = clamp(px + pet.pullX * weight - dx * squeeze * .42 + pet.pullX * edge * .12, 0, pet.width);
        pet.positions[k * 2 + 1] = clamp(py + pet.pullY * weight - dy * squeeze * .42 + pet.pullY * edge * .12, 0, pet.height);
    }
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.useProgram(pet.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, pet.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, pet.positions, gl.DYNAMIC_DRAW);
    const posLoc = gl.getAttribLocation(pet.program, 'aPosition');
    gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, pet.uvBuffer);
    const uvLoc = gl.getAttribLocation(pet.program, 'aUv');
    gl.enableVertexAttribArray(uvLoc); gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, pet.indexBuffer);
    gl.uniform2f(gl.getUniformLocation(pet.program, 'uSize'), pet.width, pet.height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, pet.texture);
    gl.uniform1i(gl.getUniformLocation(pet.program, 'uTexture'), 0);
    gl.drawElements(gl.TRIANGLES, pet.indexCount, gl.UNSIGNED_SHORT, 0);
}
function stopFrame() { if (pet.raf) cancelAnimationFrame(pet.raf); pet.raf = 0; }
function animate() {
    pet.raf = 0;
    if (pet.pointer) {
        drawPet();
        return;
    }
    pet.vx += -pet.pullX * .16; pet.vy += -pet.pullY * .16;
    pet.vx *= .78; pet.vy *= .78;
    pet.pullX += pet.vx; pet.pullY += pet.vy;
    drawPet();
    const moving = Math.abs(pet.pullX) + Math.abs(pet.pullY) + Math.abs(pet.vx) + Math.abs(pet.vy) > .12;
    if (moving || pet.pointer) pet.raf = requestAnimationFrame(animate);
    else { pet.pullX = pet.pullY = pet.vx = pet.vy = 0; drawPet(); }
}
function wake() { if (!pet.raf) pet.raf = requestAnimationFrame(animate); }
function pointerPosition(e) {
    const r = e.currentTarget.getBoundingClientRect();
    return [clamp(e.clientX - r.left, 0, r.width), clamp(e.clientY - r.top, 0, r.height)];
}
function bindPetTouch() {
    const canvas = document.querySelector('#lp-pet-canvas');
    if (!canvas || canvas.dataset.bound) return;
    canvas.dataset.bound = '1';
    canvas.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const [x, y] = pointerPosition(e);
        if (maskAtPoint(x, y) < .12) return;
        pet.pointer = { id: e.pointerId, startX: x, startY: y };
        pet.cx = x; pet.cy = y;
        try { canvas.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault(); wake();
    });
    canvas.addEventListener('pointermove', e => {
        if (!pet.pointer || pet.pointer.id !== e.pointerId) return;
        const [x, y] = pointerPosition(e), p = pet.pointer;
        pet.cx = x; pet.cy = y;
        const radius = Math.max(12, Math.min(pet.width, pet.height) * Number(cfg().brush) / 100);
        const limit = radius * .82 * Number(cfg().strength) / 72;
        const damp = v => Math.sign(v) * Math.pow(Math.abs(v), .88);
        pet.pullX = clamp(damp(x - p.startX) * .72, -limit, limit);
        pet.pullY = clamp(damp(y - p.startY) * .72, -limit, limit);
        wake(); e.preventDefault();
    });
    const release = e => {
        if (!pet.pointer || (e && e.pointerId !== pet.pointer.id)) return;
        try { canvas.releasePointerCapture(pet.pointer.id); } catch {}
        pet.pointer = null; wake();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('lostpointercapture', release);
}
function prepareMaskOverlay() {
    const overlay = document.querySelector('#lp-mask-overlay');
    const canvas = document.querySelector('#lp-pet-canvas');
    if (!overlay || !canvas || !pet.image) return;
    overlay.width = canvas.width; overlay.height = canvas.height;
    overlay.style.width = canvas.style.width; overlay.style.height = canvas.style.height;
    overlay.style.display = 'block';
    pet.maskOverlay = overlay; pet.maskOverlayCtx = overlay.getContext('2d');
    paintMaskOverlay();
}
function refreshMaskPixels() {
    if (!pet.maskCtx || !pet.maskCanvas) { pet.maskPixels = null; return; }
    pet.maskPixels = pet.maskCtx.getImageData(0, 0, pet.maskCanvas.width, pet.maskCanvas.height);
}
function maskAtUv(u, v) {
    if (!pet.maskPixels || !pet.maskCanvas) return 0;
    const x = clamp(Math.round(u * (pet.maskCanvas.width - 1)), 0, pet.maskCanvas.width - 1);
    const y = clamp(Math.round(v * (pet.maskCanvas.height - 1)), 0, pet.maskCanvas.height - 1);
    return pet.maskPixels.data[(y * pet.maskCanvas.width + x) * 4 + 3] / 255;
}
function maskAtPoint(x, y) {
    if (!pet.width || !pet.height) return 0;
    return maskAtUv(x / pet.width, y / pet.height);
}
function paintMaskOverlay() {
    if (!pet.maskOverlayCtx || !pet.maskCanvas) return;
    const ctx = pet.maskOverlayCtx, canvas = pet.maskOverlay;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(pet.maskCanvas, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = 'rgba(238, 139, 183, .48)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
}
async function savePetMask() {
    if (!pet.maskCanvas) return;
    const blob = await new Promise(resolve => pet.maskCanvas.toBlob(resolve, 'image/png'));
    if (blob) await putAsset('pet-mask', blob);
}
async function loadPetMask() {
    if (!pet.image) return;
    pet.maskCanvas = document.createElement('canvas');
    pet.maskCanvas.width = pet.image.naturalWidth;
    pet.maskCanvas.height = pet.image.naturalHeight;
    pet.maskCtx = pet.maskCanvas.getContext('2d', { willReadFrequently: true });
    const saved = await getAsset('pet-mask');
    if (saved) {
        const url = URL.createObjectURL(saved);
        try {
            const bitmap = await createImageBitmap(saved);
            pet.maskCtx.drawImage(bitmap, 0, 0, pet.maskCanvas.width, pet.maskCanvas.height);
            bitmap.close?.();
        } finally {}
    }
    refreshMaskPixels();
    prepareMaskOverlay();
    drawPet();
}
function bindMaskEditor() {
    const overlay = document.querySelector('#lp-mask-overlay');
    if (!overlay || overlay.dataset.bound) return;
    overlay.dataset.bound = '1';
    const point = e => {
        const r = overlay.getBoundingClientRect();
        return [(e.clientX - r.left) / r.width * pet.maskCanvas.width, (e.clientY - r.top) / r.height * pet.maskCanvas.height];
    };
    const stroke = (x, y) => {
        if (!pet.maskCtx) return;
        const size = Number(document.querySelector('#lp-mask-brush')?.value || 32);
        const rect = overlay.getBoundingClientRect();
        const radius = Math.max(2, size * pet.maskCanvas.width / Math.max(1, rect.width));
        const g = pet.maskCtx.createRadialGradient(x, y, 0, x, y, radius);
        g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.68, 'rgba(255,255,255,.82)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        pet.maskCtx.save();
        pet.maskCtx.globalCompositeOperation = maskMode === 'erase' ? 'destination-out' : 'source-over';
        pet.maskCtx.fillStyle = g;
        pet.maskCtx.beginPath(); pet.maskCtx.arc(x, y, radius, 0, Math.PI * 2); pet.maskCtx.fill();
        pet.maskCtx.restore();
        paintMaskOverlay();
    };
    overlay.addEventListener('pointerdown', e => {
        if (!maskMode || !pet.maskCanvas) return;
        maskStroke = { id: e.pointerId };
        try { overlay.setPointerCapture(e.pointerId); } catch {}
        const [x, y] = point(e); stroke(x, y); e.preventDefault();
    });
    overlay.addEventListener('pointermove', e => {
        if (!maskStroke || maskStroke.id !== e.pointerId) return;
        const [x, y] = point(e); stroke(x, y); e.preventDefault();
    });
    const end = async e => {
        if (!maskStroke || (e && e.pointerId !== maskStroke.id)) return;
        maskStroke = null;
        refreshMaskPixels(); paintMaskOverlay(); drawPet();
        try { await savePetMask(); } catch (err) { toast(err.message || '选区保存失败'); }
    };
    overlay.addEventListener('pointerup', end);
    overlay.addEventListener('pointercancel', end);
    overlay.addEventListener('lostpointercapture', end);
}
function setImage(blob) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob), img = new Image();
        img.onload = async () => {
            if (pet.url) URL.revokeObjectURL(pet.url);
            pet.url = url; pet.image = img;
            try {
                prepareCanvas(); bindPetTouch();
                await loadPetMask();
                resolve();
            } catch (err) { reject(err); }
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败，请使用 PNG、JPG 或 WebP')); };
        img.src = url;
    });
}
function toast(message) {
    const el = document.querySelector('#lp-toast');
    if (!el) return;
    el.textContent = message; el.classList.add('is-visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('is-visible'), 2200);
}
function placeBall() {
    const ball = document.querySelector('#lp-ball');
    if (!ball) return;
    const c = cfg(), w = ball.offsetWidth || 54, h = ball.offsetHeight || 54;
    ball.style.left = clamp(c.ballX * (innerWidth - w), 0, innerWidth - w) + 'px';
    ball.style.top = clamp(c.ballY * (innerHeight - h), 0, innerHeight - h) + 'px';
}
function mount() {
    if (document.querySelector('#little-pet-root')) return;
    const root = document.createElement('div');
    root.id = 'little-pet-root';
    root.innerHTML = '<button id="lp-ball" type="button" aria-label="打开小小桌宠" title="小小桌宠">' + BALL + '</button>' +
      '<section id="lp-panel" class="lp-panel" aria-hidden="true">' +
        '<header class="lp-header"><div><b>小小桌宠</b><small>摸摸它，看看会不会 DUANG</small></div><button class="lp-close" type="button" aria-label="关闭">×</button></header>' +
        '<div class="lp-stage" id="lp-stage"><div class="lp-empty" id="lp-empty"><span class="lp-empty-mark">＋</span><b>放一张 PNG 进来</b><small>建议使用透明背景的角色立绘</small><button id="lp-upload" type="button">选择图片</button></div><div id="lp-canvas-wrap"><canvas id="lp-pet-canvas" aria-label="触摸并拖动桌宠"></canvas><canvas id="lp-mask-overlay" aria-label="涂抹互动选区"></canvas></div></div>' +
        '<div class="lp-toolbar"><label class="lp-file-label">更换图片<input id="lp-file" type="file" accept="image/png,image/webp,image/jpeg"></label><button id="lp-reset" type="button">恢复形变</button><button id="lp-remove" type="button">移除图片</button></div>' +
        '<div class="lp-mask-tools"><span>互动选区</span><button id="lp-mask-paint" type="button" class="is-active">涂抹选区</button><button id="lp-mask-erase" type="button">擦除选区</button><button id="lp-mask-clear" type="button">清空选区</button><button id="lp-mask-preview" type="button">互动预览</button><button id="lp-mask-release" type="button">放出桌宠</button><label>选区笔刷 <input id="lp-mask-brush" type="range" min="8" max="100" value="32"><output id="lp-mask-brush-value">32</output></label></div>' +
        '<div class="lp-controls">' +
          '<label><span>笔刷范围 <output id="lp-brush-value"></output></span><input id="lp-brush" type="range" min="10" max="45" step="1"></label>' +
          '<label><span>摇晃强度 <output id="lp-strength-value"></output></span><input id="lp-strength" type="range" min="25" max="120" step="1"></label>' +
          '<label><span>边缘柔和 <output id="lp-softness-value"></output></span><input id="lp-softness" type="range" min="30" max="100" step="1"></label>' +
          '<label><span>反馈范围 <output id="lp-feedback-value"></output></span><input id="lp-feedback" type="range" min="50" max="250" step="5"></label>' +
          '<p>先涂抹角色上允许互动的区域，再切换到互动预览。只有选区内可以拖动，选区外不会形变。</p></div><div id="lp-toast" role="status" aria-live="polite"></div></section>';
    document.body.append(root);
    const panel = root.querySelector('#lp-panel'), ball = root.querySelector('#lp-ball');
    const open = () => { panel.classList.add('is-open'); panel.setAttribute('aria-hidden', 'false'); ball.classList.add('is-active'); };
    const close = () => { panel.classList.remove('is-open'); panel.setAttribute('aria-hidden', 'true'); ball.classList.remove('is-active'); };
    ball.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const r = ball.getBoundingClientRect();
        ball._drag = { id: e.pointerId, dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
        try { ball.setPointerCapture(e.pointerId); } catch {}
    });
    ball.addEventListener('pointermove', e => {
        const d = ball._drag;
        if (!d || d.id !== e.pointerId) return;
        if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
        d.moved = true;
        ball.style.left = clamp(e.clientX - d.dx, 0, innerWidth - ball.offsetWidth) + 'px';
        ball.style.top = clamp(e.clientY - d.dy, 0, innerHeight - ball.offsetHeight) + 'px';
    });
    const ballEnd = e => {
        const d = ball._drag;
        if (!d || d.id !== e.pointerId) return;
        ball._drag = null;
        try { ball.releasePointerCapture(d.id); } catch {}
        if (d.moved) {
            const r = ball.getBoundingClientRect(), c = cfg();
            c.ballX = r.left + r.width / 2 > innerWidth / 2 ? 1 : 0;
            c.ballY = clamp(r.top / Math.max(1, innerHeight - ball.offsetHeight), 0, 1);
            save(); placeBall();
        } else if (panel.classList.contains('is-open')) close(); else open();
    };
    ball.addEventListener('pointerup', ballEnd); ball.addEventListener('pointercancel', ballEnd);
    root.querySelector('.lp-close').addEventListener('click', close);
    root.querySelector('#lp-upload').addEventListener('click', () => root.querySelector('#lp-file').click());
    const collapsePet = () => {
        const floating = root.querySelector('#lp-float');
        const canvas = root.querySelector('#lp-pet-canvas');
        const overlay = root.querySelector('#lp-mask-overlay');
        if (!floating || !canvas) return;
        root.querySelector('#lp-canvas-wrap').append(canvas);
        floating.remove();
    };
    const setMaskMode = mode => {
        if (mode && root.querySelector('#lp-float')) collapsePet();
        maskMode = mode;
        root.querySelector('#lp-mask-paint').classList.toggle('is-active', mode === 'paint');
        root.querySelector('#lp-mask-erase').classList.toggle('is-active', mode === 'erase');
        root.querySelector('#lp-mask-preview').classList.toggle('is-active', mode === null);
        const overlay = root.querySelector('#lp-mask-overlay');
        if (overlay) overlay.style.pointerEvents = mode ? 'auto' : 'none';
        toast(mode === 'paint' ? '涂抹要允许互动的区域' : mode === 'erase' ? '擦除不需要互动的区域' : '互动预览已开启');
    };
    root.querySelector('#lp-mask-paint').addEventListener('click', () => setMaskMode('paint'));
    root.querySelector('#lp-mask-erase').addEventListener('click', () => setMaskMode('erase'));
    root.querySelector('#lp-mask-preview').addEventListener('click', () => setMaskMode(null));
    root.querySelector('#lp-mask-release').addEventListener('click', () => {
        if (!pet.image) return toast('请先选择桌宠图片');
        if (!pet.maskPixels || !pet.maskPixels.data.some((v, i) => i % 4 === 3 && v > 24)) return toast('先涂抹至少一块互动选区');
        setMaskMode(null);
        if (root.querySelector('#lp-float')) return;
        const floating = document.createElement('div');
        floating.id = 'lp-float';
        floating.innerHTML = '<div class="lp-float-handle"><span>小小桌宠</span><button type="button" aria-label="收起桌宠">收起</button></div>';
        floating.append(root.querySelector('#lp-pet-canvas'));
        root.append(floating);
        const c = cfg();
        const place = () => {
            const w = floating.offsetWidth || pet.width, h = floating.offsetHeight || pet.height + 30;
            floating.style.left = clamp(Number(c.petFloatX ?? .72) * Math.max(0, innerWidth - w), 0, Math.max(0, innerWidth - w)) + 'px';
            floating.style.top = clamp(Number(c.petFloatY ?? .68) * Math.max(0, innerHeight - h), 0, Math.max(0, innerHeight - h)) + 'px';
        };
        floating.querySelector('button').addEventListener('click', () => {
            const canvas = root.querySelector('#lp-pet-canvas');
            root.querySelector('#lp-canvas-wrap').append(canvas);
            floating.remove();
            setMaskMode('paint');
        });
        const handle = floating.querySelector('.lp-float-handle');
        let drag = null;
        handle.addEventListener('pointerdown', e => {
            if (e.target.closest('button')) return;
            const r = floating.getBoundingClientRect();
            drag = { id:e.pointerId, dx:e.clientX-r.left, dy:e.clientY-r.top };
            try { handle.setPointerCapture(e.pointerId); } catch {}
        });
        handle.addEventListener('pointermove', e => {
            if (!drag || drag.id !== e.pointerId) return;
            floating.style.left = clamp(e.clientX-drag.dx, 0, innerWidth-floating.offsetWidth) + 'px';
            floating.style.top = clamp(e.clientY-drag.dy, 0, innerHeight-floating.offsetHeight) + 'px';
        });
        const end = e => {
            if (!drag || drag.id !== e.pointerId) return;
            drag = null;
            const r = floating.getBoundingClientRect();
            c.petFloatX = r.left / Math.max(1, innerWidth-floating.offsetWidth);
            c.petFloatY = r.top / Math.max(1, innerHeight-floating.offsetHeight);
            save();
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
        place();
        window.addEventListener('resize', place);
        toast('桌宠已放出，可以直接触摸选区互动');
    });
    root.querySelector('#lp-mask-clear').addEventListener('click', async () => {
        if (!pet.maskCtx) return;
        pet.maskCtx.clearRect(0, 0, pet.maskCanvas.width, pet.maskCanvas.height);
        refreshMaskPixels(); paintMaskOverlay(); await savePetMask(); drawPet(); toast('互动选区已清空');
    });
    const maskBrush = root.querySelector('#lp-mask-brush');
    maskBrush.addEventListener('input', () => { root.querySelector('#lp-mask-brush-value').value = maskBrush.value; });
    bindMaskEditor();
    root.querySelector('#lp-file').addEventListener('change', async e => {
        const file = e.target.files && e.target.files[0]; e.target.value = '';
        if (!file) return;
        if (!file.type.startsWith('image/')) return toast('请选择图片文件');
        try {
            await putPetImage(file); await setImage(file);
            root.querySelector('#lp-empty').hidden = true; toast('桌宠图片已保存');
        } catch (err) { toast(err.message || '图片载入失败'); }
    });
    root.querySelector('#lp-reset').addEventListener('click', async () => {
        try { const blob = await getPetImage(); if (blob) { await setImage(blob); toast('形变已复位'); } }
        catch (err) { toast(err.message); }
    });
    root.querySelector('#lp-remove').addEventListener('click', async () => {
        collapsePet();
        await clearPetImage(); await clearAsset('pet-mask'); stopFrame(); pet.pointer = null; pet.image = null;
        pet.maskCanvas = pet.maskCtx = pet.maskPixels = null;
        if (pet.url) URL.revokeObjectURL(pet.url); pet.url = '';
        const canvas = root.querySelector('#lp-pet-canvas');
        canvas.width = 1; canvas.height = 1; canvas.style.width = '0'; canvas.style.height = '0'; canvas.style.display = 'none';
        root.querySelector('#lp-empty').hidden = false; toast('已移除桌宠图片');
    });
    for (const key of ['brush', 'strength', 'softness', 'feedback']) {
        const input = root.querySelector('#lp-' + key), output = root.querySelector('#lp-' + key + '-value');
        input.value = cfg()[key]; output.value = cfg()[key] + '%';
        input.addEventListener('input', () => {
            cfg()[key] = Number(input.value); output.value = input.value + '%'; save();
            if (pet.image) drawPet();
        });
    }
    placeBall();
    window.addEventListener('resize', () => { placeBall(); if (pet.image) prepareCanvas(); });
    getPetImage().then(blob => {
        if (blob) setImage(blob).then(() => { root.querySelector('#lp-empty').hidden = true; setMaskMode('paint'); })
            .catch(err => toast(err.message || '上次的桌宠图片载入失败'));
    }).catch(err => console.warn('[小小桌宠] 本地图片仓库不可用', err));
}
function init() {
    if (window.__littlePetReady) return;
    window.__littlePetReady = true;
    mount();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
