const $ = (id) => document.getElementById(id);
const btn = $('btn');
const everyN = $('everyN');
const showFull = $('showFull');
const sampleNowBtn = $('sampleNow');
const statusEl = $('status');
const overlayRoot = $('overlayRoot');
const textOut = $('textOut');

function setStatus(s){ console.log(s); statusEl.textContent = s; }
function setOverlay(s){ textOut.textContent = s; }

let xrSession = null;
let gl = null;
let glBinding = null;
let refSpace = null;

let program = null;
let aPos=-1, aUV=-1, uTex=null, uFlipY=null;
let vbo=null;

const fboW = 488, fboH = 256;
let fbo = null, fboTex = null;

let frameCount = 0, sampleEvery = 2, manualSample=false;
let lastTS = 0, fpsEMA = 0;
const fpsAlpha = 0.15;

function createShader(gl, type, src){
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
    const info = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('Shader compile error: ' + info);
  }
  return sh;
}
function createProgram(gl, vsSrc, fsSrc){
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)){
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error('Program link error: ' + info);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function drawFullscreen(gl, program, vbo, tex, flipY) {
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const stride = 16;
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(aUV);
  gl.vertexAttribPointer(aUV,  2, gl.FLOAT, false, stride, 8);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(uTex, 0);
  gl.uniform1i(uFlipY, flipY ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function makeFBO(w,h){
  if (fbo) gl.deleteFramebuffer(fbo);
  if (fboTex) gl.deleteTexture(fboTex);
  fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  fboTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fboTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
  const ok = (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE);
  if (!ok) throw new Error('FBO nije kompletan.');
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
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

    const canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL nije dostupan.');
    if (gl.makeXRCompatible) await gl.makeXRCompatible();

    glBinding = new XRWebGLBinding(xrSession, gl);
    const baseLayer = new XRWebGLLayer(xrSession, gl);
    xrSession.updateRenderState({ baseLayer });

    refSpace = await xrSession.requestReferenceSpace('local');

    const VS = `
    attribute vec2 aPos;
    attribute vec2 aUV;
    varying vec2 vUV;
    void main(){
      vUV = aUV;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }`;
    const FS = `
    precision mediump float;
    varying vec2 vUV;
    uniform sampler2D uTex;
    uniform int uFlipY;
    void main(){
      vec2 uv = vUV;
      if (uFlipY == 1) uv.y = 1.0 - uv.y;
      gl_FragColor = texture2D(uTex, uv);
    }`;
    program = createProgram(gl, VS, FS);
    aPos = gl.getAttribLocation(program, 'aPos');
    aUV  = gl.getAttribLocation(program, 'aUV');
    uTex = gl.getUniformLocation(program, 'uTex');
    uFlipY = gl.getUniformLocation(program, 'uFlipY');

    vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1, 0,0,
       1,-1, 1,0,
      -1, 1, 0,1,
      -1, 1, 0,1,
       1,-1, 1,0,
       1, 1, 1,1
    ]), gl.STATIC_DRAW);

    makeFBO(fboW, fboH);

    frameCount = 0; fpsEMA = 0; lastTS = performance.now();
    btn.textContent = 'Izađi iz AR';
    xrSession.addEventListener('end', () => { xrSession = null; btn.textContent = 'Uđi u AR'; setStatus('XR sesija završena.'); });
    xrSession.requestAnimationFrame(onXRFrame);
  } catch (e) {
    console.error(e);
    setStatus('Greška: ' + e.message);
    setOverlay('// Greška: ' + e.message + '\\n// HTTPS? Dozvole? Chrome/ARCore ažuriran?');
  }
});

sampleNowBtn.addEventListener('click', () => { manualSample = true; });

function onXRFrame(t, frame) {
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
  for (const view of pose.views) {
    const vp = glLayer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    const cam = view.camera;
    if (!cam) continue;
    const tex = glBinding.getCameraImage(cam);
    if (!tex) continue;
    cameraOk = true;
    camTex = tex; camW = cam.width||0; camH = cam.height||0;
    // drawFullscreen(gl, program, vbo, camTex, true);
    break;
  }

  if (!cameraOk) {
    setOverlay(`// Nema pristupa kameri u XR (view.camera=null).\n// Proveri: HTTPS, permission prompt, Chrome verziju, ARCore.\n// Ako je u <iframe>, treba allow="xr-spatial-tracking; camera".`);
    return;
  }

  // Downscale into fixed 488x256 FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0,0,fboW,fboH);
  gl.clear(gl.COLOR_BUFFER_BIT);
  drawFullscreen(gl, program, vbo, camTex, true);
  gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);

  // Sampling
  const willSample = manualSample || (frameCount % sampleEvery === 0);
  if (willSample) {
    manualSample = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const buf = new Uint8Array(fboW * fboH * 4);
    const t0 = performance.now();
    gl.readPixels(0,0,fboW,fboH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const arr2d = new Array(fboH);
    for (let y=0; y<fboH; y++) {
      const row = new Array(fboW);
      for (let x=0; x<fboW; x++) {
        const i = (y*fboW + x) * 4;
        row[x] = [buf[i], buf[i+1], buf[i+2]];
      }
      arr2d[y] = row;
    }
    const t1 = performance.now();
    const ms = (t1 - t0);

    let out;
    if (showFull.checked) {
      out = JSON.stringify(arr2d);
    } else {
      const cw = Math.min(16, fboW), ch = Math.min(10, fboH);
      const head = arr2d.slice(0, ch).map(r => r.slice(0, cw));
      out = `// Prikaz prvih ${cw}×${ch} piksela (cekiraj 'Prikaži ceo 2D niz' za kompletan ispis)\n` + JSON.stringify(head);
    }

    setOverlay(`// FPS≈${fpsEMA.toFixed(1)} | Camera ${camW}x${camH} | FBO ${fboW}x${fboH} | Frame ${frameCount} | Every ${sampleEvery} | read+convert ms=${ms.toFixed(2)}\n` + out);
  } else {
    setOverlay(`// FPS≈${fpsEMA.toFixed(1)} | Camera ${camW}x${camH} | FBO ${fboW}x${fboH} | Frame ${frameCount} | Every ${sampleEvery}`);
  }

  frameCount++;
}
