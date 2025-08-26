
const $ = (id) => document.getElementById(id);
const btn = $('btn');
const everyN = $('everyN');
const showFull = $('showFull');
const sampleNowBtn = $('sampleNow');
const statusEl = $('status');
const overlayRoot = $('overlayRoot');
const textOut = $('textOut');
const canvas = $('gl');

function setStatus(s){ console.log(s); statusEl.textContent = s; }
function setOverlay(s){ textOut.textContent = s; }

let xrSession = null;
let gl = null;
let glBinding = null;
let refSpace = null;

let aPos=-1, aUV=-1, uTex=null, uFlipY=null;
let vbo=null;

const fboW = 256, fboH = 448;
let fbo = null, fboTex = null;

let frameCount = 0, sampleEvery = 2, manualSample=false;
let lastTS = 0, fpsEMA = 0;
const fpsAlpha = 0.15;

let maskOffscreenCanvas = null;
let segTex = null;
let dstTex = null;
let program = null;

let locPos = null;
let locUV  = null;
let locTex = null;
let locFlip = null;

let model = null;

let tfWorker = null;

// Two reusable readback buffers (double buffer to overlap worker work)
let rbIndex = 0;
const readbacks = [
  new Uint8Array(fboW * fboH * 4),
  new Uint8Array(fboW * fboH * 4),
];

let overlayProgram = null;
let uMaskLoc   = null;
let uTintLoc   = null;
let uThreshLoc = null;
let uAlphaLoc  = null;

// Fullscreen quad (x,y,u,v)
const quad = new Float32Array([
  -1, -1, 0, 0,
   1, -1, 1, 0,
  -1,  1, 0, 1,
   1,  1, 1, 1,
]);

// --- Shaders
const vsSource = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

const fsSource = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_texture;
uniform float u_flipY;           // 0.0 = no flip, 1.0 = flip
void main() {
  vec2 uv = vec2(v_texCoord.x, mix(v_texCoord.y, 1.0 - v_texCoord.y, u_flipY));
  gl_FragColor = texture2D(u_texture, uv);
}
`;

function createShader(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
function createProgram(vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, createShader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, createShader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

// Common texture setup
function setTexParams() {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINE_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function createEmptyTexture(w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  setTexParams();
  return t;
}

btn.addEventListener('click', async () => {
  try {
    if (xrSession) { await xrSession.end(); return; }

    if (!('xr' in navigator)) { setStatus('navigator.xr nije dostupan.'); return; }
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) { setStatus('immersive-ar nije podržan.'); return; }

    sampleEvery = Math.max(1, parseInt(everyN.value,10) || 2);
    manualSample = false;

    const sessionInit = {
      requiredFeatures: ['camera-access', 'dom-overlay'],
      domOverlay: { root: overlayRoot }
    };
    setStatus('Tražim XR sesiju…');
    xrSession = await navigator.xr.requestSession('immersive-ar', sessionInit);
    setStatus('XR sesija startovana.');
    
    gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL nije dostupan.');
    if (gl.makeXRCompatible) await gl.makeXRCompatible();

    glBinding = new XRWebGLBinding(xrSession, gl);
    const baseLayer = new XRWebGLLayer(xrSession, gl);
    xrSession.updateRenderState({ baseLayer });

    refSpace = await xrSession.requestReferenceSpace('local');

    frameCount = 0; fpsEMA = 0; lastTS = performance.now();
    btn.textContent = 'Izađi iz AR';
    xrSession.addEventListener('end', () => { xrSession = null; btn.textContent = 'Uđi u AR'; setStatus('XR sesija završena.'); });

    dstTex = createEmptyTexture(fboW, fboH);
    segTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, segTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fboW, fboH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    fbo = gl.createFramebuffer();

    // Use PACK_ALIGNMENT=1 to avoid row padding mismatches
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    program = createProgram(vsSource, fsSource);
    gl.useProgram(program);

    locPos = gl.getAttribLocation(program, 'a_position');
    locUV = gl.getAttribLocation(program, 'a_texCoord');
    locTex = gl.getUniformLocation(program, 'u_texture');
    locFlip = gl.getUniformLocation(program, 'u_flipY');
        
    vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(locUV);
    gl.vertexAttribPointer(locUV,  2, gl.FLOAT, false, 16, 8);


    const overlayProgram = createProgram(vsSource, fsOverlay);
    const uMaskLoc   = gl.getUniformLocation(overlayProgram, 'u_mask');
    const uTintLoc   = gl.getUniformLocation(overlayProgram, 'u_tint');
    const uThreshLoc = gl.getUniformLocation(overlayProgram, 'u_thresh');
    const uAlphaLoc  = gl.getUniformLocation(overlayProgram, 'u_alpha');

    // Start TF worker
    tfWorker = new Worker('./tf-worker-bytes.js', { type: 'module' });
    tfWorker.postMessage({ type: 'init', modelUrl: './tfjs/model.json', width: fboW, height: fboH });

    // Receive mask bitmap back and upload into segTex
    tfWorker.onmessage = (e) => {
      const { type, bitmap } = e.data || {};
      if (type === 'mask' && bitmap) {
        gl.bindTexture(gl.TEXTURE_2D, segTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        bitmap.close();
      }
    };

    xrSession.requestAnimationFrame(onXRFrame);
  } catch (e) {
    console.error(e);
    setStatus('Greška: ' + e.message);
    setOverlay('// Greška: ' + e.message + '\\n// HTTPS? Dozvole? Chrome/ARCore ažuriran?');
  }
});

sampleNowBtn.addEventListener('click', () => { manualSample = true; });

function resizeTextureGPU(srcTex, newW, newH) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);

  // Optional: check FBO
  const stat = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (stat !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete: ' + stat);

  // Draw to the destination texture
  gl.viewport(0, 0, newW, newH);
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(locTex, 0);
  //gl.uniform1f(locFlip, 1.0); // <-- flip ON during blit
  gl.uniform1f(locFlip, 0.0); // <-- flip OFF during blit
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // Unbind FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return dstTex;
}

function sendDstTexToWorker() {
  // Bind FBO with dstTex attached
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);

  // Read pixels from FBO → current buffer
  const buf = readbacks[rbIndex];
  gl.readPixels(0, 0, fboW, fboH, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  // NOTE: readPixels origin is bottom-left; tell worker to flip if needed
  const flippedY = true;

  // Transfer the underlying ArrayBuffer to the worker (zero-copy transfer)
  tfWorker.postMessage(
    { type: 'frameRGBA', width: fboW, height: fboH, buffer: buf.buffer, flippedY },
    [buf.buffer]
  );

  // After transfer, buf.buffer is detached; recreate the view for next time
  readbacks[rbIndex] = new Uint8Array(fboW * fboH * 4);
  rbIndex ^= 1; // swap 0<->1

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function drawToCanvas(tex) {
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(locTex, 0);
  gl.uniform1f(locFlip, 0.0); // <-- flip OFF when drawing to the screen
  gl.clearColor(0,0,0,1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

const fsOverlay = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_mask;
uniform vec4 u_tint;   // e.g., vec4(0.0, 1.0, 0.0, 1.0) for green
uniform float u_thresh; // treat mask > thresh as "on"
uniform float u_alpha;  // overlay transparency

void main() {
  float m = texture2D(u_mask, v_texCoord).r; // 0..1 from red channel
  float on = step(u_thresh, m);               // 1.0 where class>0
  gl_FragColor = vec4(u_tint.rgb, u_alpha * on);
}
`;



function drawMaskOverlay(maskTex, tint=[0,1,0,1], thresh=1.5/255.0, alpha=0.35) {
  gl.useProgram(overlayProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.uniform1i(uMaskLoc, 0);
  gl.uniform4f(uTintLoc, tint[0], tint[1], tint[2], tint[3]);
  gl.uniform1f(uThreshLoc, thresh);
  gl.uniform1f(uAlphaLoc, alpha);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // reuse your quad bindings
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.disable(gl.BLEND);
}

let ms = 0;
let msTotal = 0;
let sampleCount = 0;
const sampleCountMax = 30;

async function onXRFrame(t, frame) {
  xrSession.requestAnimationFrame(onXRFrame);

  const now = performance.now();
  const dt = now - lastTS; lastTS = now;
  const fps = 1000 / Math.max(1, dt);
  fpsEMA = fpsEMA ? (fpsAlpha*fps + (1-fpsAlpha)*fpsEMA) : fps;

  const pose = frame.getViewerPose(refSpace);
  if (!pose) return;

  const glLayer = xrSession.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Render camera to XR view
  let camTex = null, camW=0, camH=0, cameraOk=false;
  let t0 = 0;
  for (const view of pose.views) {
    const vp = glLayer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    const cam = view.camera;
    if (!cam) continue;
    t0 = performance.now();
    const tex = glBinding.getCameraImage(cam);
    if (!tex) continue;
    cameraOk = true;
    camTex = tex; camW = cam.width||0; camH = cam.height||0;
    break;
  }

  if (!cameraOk) {
    setOverlay(`// Nema pristupa kameri u XR (view.camera=null).\n// Proveri: HTTPS, permission prompt, Chrome verziju, ARCore.\n// Ako je u <iframe>, treba allow="xr-spatial-tracking; camera".`);
    return;
  }

  const willSample = manualSample || (frameCount % sampleEvery === 0);
  if (willSample) {
    manualSample = false;
    
    console.time("resizeTextureGPU");
    resizeTextureGPU(camTex, fboW, fboH);
    console.timeEnd("resizeTextureGPU");

    console.time("sendDstTexToWorker");
    sendDstTexToWorker();
    console.timeEnd("sendDstTexToWorker");
    
    // 3) Draw latest segmentation overlay (segTex) if any
    console.time("drawMaskOverlay");
    drawMaskOverlay(segTex, [0,1,0,1], 1.5/255.0, 0.35);
    console.timeEnd("drawMaskOverlay");

    const t1 = performance.now();
    
    msTotal += t1 - t0;
    sampleCount++;
    if (sampleCount >= sampleCountMax) {
      ms = msTotal / sampleCountMax;
      sampleCount = 0;
      msTotal = 0;
    }
  }

  setOverlay(`// FPS≈${fpsEMA.toFixed(1)} | read+convert=${ms.toFixed(2)} | Camera ${camW}x${camH} | Frame ${frameCount} | Every ${sampleEvery}`);

  frameCount++;
}

