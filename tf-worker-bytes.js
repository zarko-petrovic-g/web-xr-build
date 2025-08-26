// tf-worker-bytes.js
import 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@latest';
// import 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgpu';
// import 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl';

let model;
let W = 256, H = 448;
let maskCanvas; // for toPixels output (persistent)

self.onmessage = async (e) => {
  const { type } = e.data || {};

  if (type === 'init') {
    const { modelUrl, width, height } = e.data;
    W = width; H = height;
    maskCanvas = new OffscreenCanvas(W, H);

    await tf.setBackend('webgl');  // separate GL context in worker
    await tf.ready();

    console.log("Loading model...");
    model = await tf.loadGraphModel(modelUrl);
    console.log("Model loaded");

    // Warmup once to compile kernels
    const warm = tf.zeros([1, H, W, 3]);
    model.predict(warm).dispose();
    warm.dispose();
    return;
  }

  if (type === 'frameRGBA') {
    const { buffer, width, height, flippedY } = e.data;
    if (!buffer) return;

    // Wrap the transferred bytes as a Uint8ClampedArray for ImageData
    // (no copy: this is a view on the transferred buffer)
    const u8 = new Uint8ClampedArray(buffer);

    // Create ImageData and let tf.browser.fromPixels handle it
    let imageData = new ImageData(u8, width, height);
    let x = tf.browser.fromPixels(imageData); // [H,W,3] ignore alpha

    // If the readback came upside down, fix it here (GPU op)
    if (flippedY) {
      x = tf.reverse(x, [0]); // flip vertically
    }

    // Normalize & infer
    const img = x.expandDims(0).toFloat().div(255); // [1,H,W,3]
    const preds = model.predict(img);               // [1,H,W,C]
    const argm = preds.argMax(-1).squeeze();        // [H,W] int

    // Paint the label map into maskCanvas (RGBA8)
    await tf.browser.toPixels(argm, maskCanvas);

    // Cleanup GPU memory
    x.dispose(); img.dispose(); preds.dispose(); argm.dispose();

    // Send mask back as ImageBitmap
    const bitmap = maskCanvas.transferToImageBitmap();
    self.postMessage({ type: 'mask', bitmap }, [bitmap]);
  }
};
