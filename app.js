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

let aPos=-1, aUV=-1, uTex=null, uFlipY=null;
let vbo=null;

const fboW = 488, fboH = 256;
let fbo = null, fboTex = null;

let frameCount = 0, sampleEvery = 2, manualSample=false;
let lastTS = 0, fpsEMA = 0;
const fpsAlpha = 0.15;

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
    break;
  }

  if (!cameraOk) {
    setOverlay(`// Nema pristupa kameri u XR (view.camera=null).\n// Proveri: HTTPS, permission prompt, Chrome verziju, ARCore.\n// Ako je u <iframe>, treba allow="xr-spatial-tracking; camera".`);
    return;
  }

  const willSample = manualSample || (frameCount % sampleEvery === 0);
  if (willSample) {
    manualSample = false;
    const t0 = performance.now();

    const t1 = performance.now();
    const ms = (t1 - t0);

    setOverlay(`// FPS≈${fpsEMA.toFixed(1)} | Camera ${camW}x${camH} | Frame ${frameCount} | Every ${sampleEvery} | read+convert ms=${ms.toFixed(2)}`);
  } else {
    setOverlay(`// FPS≈${fpsEMA.toFixed(1)} | Camera ${camW}x${camH} | Frame ${frameCount} | Every ${sampleEvery}`);
  }

  frameCount++;
}
