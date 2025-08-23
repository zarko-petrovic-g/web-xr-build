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

const fboW = 488, fboH = 256;
let fbo = null, fboTex = null;

let frameCount = 0, sampleEvery = 2, manualSample=false;
let lastTS = 0, fpsEMA = 0;
const fpsAlpha = 0.15;

let dstTex = null;
let program = null;

let locPos = null;
let locUV  = null;
let locTex = null;
let locFlip = null;

let model = null;

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
    fbo = gl.createFramebuffer();

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

async function processSegmentation(canvas) {
  console.time("fromPixels")
  const t = tf.browser.fromPixels(canvas);
  console.timeEnd("fromPixels")
  const img = t.expandDims(0).toFloat().div(255);
  console.time("inference")
  const preds = await model.predict(img);
  console.timeEnd("inference");
  const argm = preds.argMax(-1).squeeze();
  const mask = await argm.data();
  const backend = tf.backend(); 
  const texture = backend.getTexture(gpuData.dataId);
  argm.dispose(); preds.dispose(); img.dispose();
  return texture; 
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

    console.time("drawToCanvas");
    drawToCanvas(dstTex);
    console.timeEnd("drawToCanvas");
    
    console.time("processSegmentation");
    const segTex = await processSegmentation(canvas);
    console.timeEnd("processSegmentation");

    console.time("drawToCanvas");
    drawToCanvas(segTex);
    console.timeEnd("drawToCanvas");

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

await tf.setBackend("webgl");
await tf.ready();
console.time("loadModel")
setOverlay("Loading model...");
model = await tf.loadGraphModel("./tfjs/model.json");
console.timeEnd("loadModel")
setOverlay("Model loaded");







