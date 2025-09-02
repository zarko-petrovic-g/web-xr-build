const $ = (id) => document.getElementById(id);
const btn = $('btn');
const overlayRoot = $('overlayRoot');
const textOut = $('textOut');
const canvas = $('gl');

function setOverlay(s){ textOut.textContent = s; }

let xrSession = null;
let gl = null;
let glBinding = null;
let refSpace = null;

let aPos=-1, aUV=-1, uTex=null, uFlipY=null;
let vbo=null;

const fboW = 256, fboH = 448;
let fbo = null, fboTex = null;

let frameCount = 0;
let lastTS = 0, fpsEMA = 0;
const fpsAlpha = 0.15;

let segTex = null;
let dstTex = null;
let maskTex = null;
let blitProgram = null;
let overlayProgram = null;

let locPos = null;
let locUV  = null;
let locTex = null;
let locFlip = null;
let uMask  = null; 
let uAlpha = null;

let model = null;

let bitmap = null;

// Fullscreen quad (x,y,u,v)
const quad = new Float32Array([
  -1, -1, 0, 0,
   1, -1, 1, 0,
  -1,  1, 0, 1,
   1,  1, 1, 1,
]);

// --- Shaders
const vsBlit = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}
`;

const fsBlit = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_texture;
uniform float u_flipY;           // 0.0 = no flip, 1.0 = flip
void main() {
  vec2 uv = vec2(v_texCoord.x, mix(v_texCoord.y, 1.0 - v_texCoord.y, u_flipY));
  gl_FragColor = texture2D(u_texture, uv);
}
`;

const vsOverlay = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_uv;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_uv = a_texCoord;
}
`;

// Samples 1-channel mask; draws yellow with alpha where mask > 0
const fsOverlay = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_mask;
uniform float u_alpha;    // e.g., 0.4
uniform float u_flipY;    // 0.0 or 1.0

void main() {
  vec2 uv = vec2(v_uv.x, mix(v_uv.y, 1.0 - v_uv.y, u_flipY));
  // In WebGL1 with LUMINANCE, the value appears in .r, .g, .b equally
  float m = texture2D(u_mask, uv).r;   // 0..1
  float on = step(0.5/255.0, m);       // treat >0 as on (>=1 in 0..255)
  vec3 yellow = vec3(1.0, 1.0, 0.0);
  gl_FragColor = vec4(yellow, u_alpha * on);
}
`;

function compile(gl, type, src){ const s=gl.createShader(type); gl.shaderSource(s,src); gl.compileShader(s); if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
function link(gl, vsSrc, fsSrc){ const p=gl.createProgram(); gl.attachShader(p, compile(gl,gl.VERTEX_SHADER,vsSrc)); gl.attachShader(p, compile(gl,gl.FRAGMENT_SHADER,fsSrc)); gl.linkProgram(p); if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }

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

    if (!('xr' in navigator)) { console.log('navigator.xr nije dostupan.'); return; }
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) { console.log('immersive-ar nije podržan.'); return; }

    const sessionInit = {
      requiredFeatures: ['camera-access', 'dom-overlay'],
      domOverlay: { root: overlayRoot }
    };
    console.log('Tražim XR sesiju…');
    xrSession = await navigator.xr.requestSession('immersive-ar', sessionInit);
    console.log('XR sesija startovana.');
    
    gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL nije dostupan.');
    if (gl.makeXRCompatible) await gl.makeXRCompatible();

    glBinding = new XRWebGLBinding(xrSession, gl);
    const baseLayer = new XRWebGLLayer(xrSession, gl, { alpha: true });
    xrSession.updateRenderState({ baseLayer });

    refSpace = await xrSession.requestReferenceSpace('local');

    frameCount = 0; fpsEMA = 0; lastTS = performance.now();
    btn.textContent = 'Izađi iz AR';
    xrSession.addEventListener('end', () => { xrSession = null; btn.textContent = 'Uđi u AR'; console.log('XR sesija završena.'); });

    dstTex = createEmptyTexture(fboW, fboH);
    segTex = createEmptyTexture(fboW, fboH);
    maskTex = createEmptyTexture(fboW, fboH);
    
    fbo = gl.createFramebuffer();

    blitProgram = createProgram(vsBlit, fsBlit);
    gl.useProgram(blitProgram);

    locPos = gl.getAttribLocation(blitProgram, 'a_position');
    locUV = gl.getAttribLocation(blitProgram, 'a_texCoord');
    locTex = gl.getUniformLocation(blitProgram, 'u_texture');
    locFlip = gl.getUniformLocation(blitProgram, 'u_flipY');
        
    vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(locPos);
    gl.vertexAttribPointer(locPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(locUV);
    gl.vertexAttribPointer(locUV,  2, gl.FLOAT, false, 16, 8);

    overlayProgram = link(gl, vsOverlay, fsOverlay);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    xrSession.requestAnimationFrame(onXRFrame);
  } catch (e) {
    console.error(e);
    console.log('Greška: ' + e.message);
    setOverlay('// Greška: ' + e.message + '\\n// HTTPS? Dozvole? Chrome/ARCore ažuriran?');
  }
});

function resizeTextureGPU(srcTex, newW, newH) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);

  // Optional: check FBO
  const stat = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (stat !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incomplete: ' + stat);

  // Draw to the destination texture
  gl.viewport(0, 0, newW, newH);
  gl.useProgram(blitProgram);
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

async function createBitmap(){
  // In the texture’s context
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const pixels = new Uint8ClampedArray(fboW * fboH * 4);
  gl.readPixels(0,0,fboW,fboH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

  // CPU-side bitmap
  const imgData = new ImageData(pixels, fboW, fboH);
  // If upside-down, flip rows first or flip later when you use it
  bitmap = await createImageBitmap(imgData);
}

function printTexture(tex, frameNumber) {
  // Suppose you already have a WebGLRenderingContext `gl`
  // and a texture object `tex` of size width × height.

  // 1. Create and bind a framebuffer
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

  // 2. Attach your texture to the framebuffer’s color attachment
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    tex,
    0
  );

  // 3. Allocate an array to hold the pixels
  // For RGBA/UNSIGNED_BYTE each pixel = 4 bytes
  const width = fboW;   // replace with your texture width
  const height = fboH;  // replace with your texture height
  const pixels = new Uint8Array(width * height * 4);

  // 4. Read pixels into the array
  gl.readPixels(
    0, 0,          // x, y
    width, height, // width, height
    gl.RGBA,       // format
    gl.UNSIGNED_BYTE, // type
    pixels
  );

  // 5. Log the data
  console.log(`#${frameNumber} Pixels array length: ${pixels.length}`);
  console.log(`#${frameNumber} Pixels: ${pixels.join(' ')}`);

  // 6. Cleanup
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
}

// Convert argm.data() → Uint8Array mask (0 or 255), upload to GL
async function updateMaskFromTensor(argm /* tf.Tensor2D [H,W] */, frameNumber) {
  const [H, W] = argm.shape;

  // Get CPU values (Int32Array or Float32Array)
  const vals = await argm.data();  // NOTE: data() is async

  // const parts = [];

  // parts.push(`length: ${vals.length}`);

  // for (let i = 0; i < vals.length; i++) {
  //   parts.push(vals[i]);
  // }

  // console.log(`#${frameNumber} data: ${parts.join(' ')}`);

  // Build 1-byte mask (0 or 255). Reuse array if you want.
  const maskBytes = new Uint8Array(W * H);
  for (let i = 0; i < vals.length; i++) {
    maskBytes[i] = (vals[i] >= 1) ? 255 : 0;
  }

  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, fboW, fboH, gl.LUMINANCE, gl.UNSIGNED_BYTE, maskBytes);

  printTexture(maskTex, frameNumber);
}

function drawYellowOverlay(alpha = 0.4, flipY = 0.0, frameNumber) {
  if (!maskTex){
    console.log(`#${frameNumber} drawYellowOverlay maskTex nije dostupan.`);
    return;
  } 

  gl.useProgram(overlayProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, maskTex);
  gl.uniform1i(uMask, 0);
  gl.uniform1f(uAlpha, alpha);
  gl.uniform1f(uFlipY, flipY); // set 1.0 if your mask appears upside down

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.disable(gl.BLEND);
}

async function processSegmentation(frameNumber) {
  let now = performance.now();
  const t = tf.browser.fromPixels(bitmap); // (H,W,3)
  console.log(`#${frameNumber}  fromPixels ${performance.now() - now}`);

  const img = t.expandDims(0).toFloat().div(255);

  now = performance.now();
  const preds = await model.predict(img); // (1,H,W,C)
  console.log(`#${frameNumber}  infer ${performance.now() - now}`);

  now = performance.now();
  const argm = preds.argMax(-1).squeeze(); // (H,W)
    
// Update GL mask once per inference (or every N frames)
  await updateMaskFromTensor(argm, frameNumber);
    
  console.log(`#${frameNumber}  segToTex ${performance.now() - now}`);

  t.dispose();  img.dispose();  preds.dispose();  argm.dispose();
}

let ms = 0;
let msTotal = 0;
let sampleCount = 0;
const sampleCountMax = 30;

let processingFrame = false;

async function onXRFrame(t, frame) {
  xrSession.requestAnimationFrame(onXRFrame);
  
  let now = performance.now();
  const dt = now - lastTS; lastTS = now;
  const fps = 1000 / Math.max(1, dt);
  fpsEMA = fpsEMA ? (fpsAlpha*fps + (1-fpsAlpha)*fpsEMA) : fps;
  
  let frameNumber = frameCount++;
  console.log(`#${frameNumber} -----------------: ${dt.toFixed(1)}`);

  if (processingFrame) {
    console.log(`#${frameNumber} skipped`);
    return;
  }

  processingFrame = true;
  
  const pose = frame.getViewerPose(refSpace);
  if (!pose){
    console.log('Viewer pose nije dostupan.');
    processingFrame = false;
    return;
  } 

  const glLayer = xrSession.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); 
  
    // Render camera to XR view
  let camTex = null, camW=0, camH=0, cameraOk=false;
  for (const view of pose.views) {
    const vp = glLayer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    const cam = view.camera;
    if (!cam) continue;
    const tex = glBinding.getCameraImage(cam);
    console.log(`#${frameNumber} getCameraImage ${performance.now() - now}`);
    if (!tex) continue;
    cameraOk = true;
    camTex = tex; camW = cam.width||0; camH = cam.height||0;
    break;
  }

  if (!cameraOk) {
    processingFrame = false;
    setOverlay(`// Nema pristupa kameri u XR (view.camera=null).\n// Proveri: HTTPS, permission prompt, Chrome verziju, ARCore.\n// Ako je u <iframe>, treba allow="xr-spatial-tracking; camera".`);
    return;
  }

  now = performance.now();
  resizeTextureGPU(camTex, fboW, fboH);
  console.log(`#${frameNumber} resizeTextureGPU ${performance.now() - now}`);   

  now = performance.now();
  await createBitmap();
  console.log(`#${frameNumber} createBitmap ${performance.now() - now}`);

  now = performance.now();
  await processSegmentation(frameNumber);
  console.log(`#${frameNumber} processSegmentation ${performance.now() - now}`);
  
  // In your XR frame loop, every frame:
  now = performance.now();
  drawYellowOverlay(0.4, /*flipY=*/0.0);
  console.log(`#${frameNumber} drawYellowOverlay ${performance.now() - now}`);
  
  setOverlay(`// FPS≈${fpsEMA.toFixed(1)} | Frame ${frameNumber}`);

  processingFrame = false;

  console.log(`#${frameNumber} completed`);
}

await tf.setBackend("webgpu");
console.time("loadModel")
setOverlay("Loading model...");
model = await tf.loadGraphModel("./tfjs/model.json");
console.timeEnd("loadModel")
setOverlay("Model loaded");







