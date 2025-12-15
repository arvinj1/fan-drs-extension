/**
 * Wicket-Break Trigger Detector
 * Detects high-motion events (bail-off, ball impact, etc.) via frame-delta spikes
 * Pure JavaScript, canvas-based, <200 LOC
 * 
 * This is a GENERIC event locator - does NOT make dismissal decisions.
 * Can be repurposed for: bail-off, edge detection, ball bounce, impact, etc.
 */

/**
 * Detect wicket-like motion event in frame sequence
 * @param {Array} frames - Array of {ts, dataUrl} keyframes
 * @param {Object} opts - Detection options
 * @returns {Object|null} - {triggered, eventTs, confidence, method, evidence} or null
 */
export async function detectWicketBreak(frames, opts = {}) {
  const {
    minFrames = 12,
    spikeThreshold = 8,      // k*MAD multiplier
    prominenceRatio = 3.0,   // peak/baseline minimum
    cutThreshold = 0.35,     // full-frame delta to reject cuts
    roiSize = 64,            // downsample to 64x64
  } = opts;

  if (!frames || frames.length < minFrames) {
    return { triggered: false, reason: 'Too few frames', confidence: 0 };
  }

  // Try both ROI locations (left-bottom, right-bottom stumps)
  const rois = [
    { name: 'left', x: 0.10, y: 0.60, w: 0.20, h: 0.35 },
    { name: 'right', x: 0.70, y: 0.60, w: 0.20, h: 0.35 },
  ];

  let bestDetection = null;
  let bestScore = 0;

  for (const roi of rois) {
    const detection = await detectInROI(frames, roi, { spikeThreshold, prominenceRatio, cutThreshold, roiSize });
    if (detection && detection.score > bestScore) {
      bestScore = detection.score;
      bestDetection = detection;
    }
  }

  if (!bestDetection) {
    return { triggered: false, reason: 'No significant motion spike detected', confidence: 0 };
  }

  return {
    triggered: true,
    eventTs: bestDetection.eventTs,
    confidence: Math.min(0.9, bestDetection.confidence), // Cap at 0.9
    method: 'frame_delta_spike',
    evidence: {
      roiUsed: bestDetection.roiName,
      prominence: bestDetection.prominence,
      peakDelta: bestDetection.peakDelta,
      baseline: bestDetection.baseline,
    },
  };
}

async function detectInROI(frames, roi, opts) {
  const deltas = [];
  const fullFrameDeltas = [];
  let prevImageData = null;
  let prevFullFrame = null;

  // Compute frame-to-frame deltas
  for (let i = 0; i < frames.length; i++) {
    const imageData = await decodeFrame(frames[i].dataUrl);
    if (!imageData) continue;

    // Extract ROI and compute delta
    const roiData = extractROI(imageData, roi);
    const downsampled = downsample(roiData, opts.roiSize);

    if (prevImageData) {
      const delta = computeDelta(prevImageData, downsampled);
      deltas.push({ ts: frames[i].ts, delta });

      // Full-frame delta for cut detection
      const fullDelta = computeDelta(prevFullFrame, imageData);
      fullFrameDeltas.push(fullDelta);
    }

    prevImageData = downsampled;
    prevFullFrame = imageData;
  }

  if (deltas.length < 3) return null;

  // Compute baseline and MAD
  const deltaValues = deltas.map(d => d.delta);
  const baseline = median(deltaValues);
  const mad = computeMAD(deltaValues, baseline);

  // Find peaks
  const threshold = baseline + opts.spikeThreshold * mad;
  const peaks = deltas
    .map((d, i) => ({ ...d, index: i }))
    .filter(d => d.delta > threshold);

  if (peaks.length === 0) return null;

  // Choose first major peak (earliest significant event)
  let bestPeak = peaks[0];
  let confidence = 0.7;

  // Reduce confidence if multiple peaks (ambiguous)
  if (peaks.length > 2) confidence *= 0.85;

  // Check for camera cut (reject if full-frame delta is too high)
  const fullDeltaAtPeak = fullFrameDeltas[bestPeak.index];
  if (fullDeltaAtPeak > opts.cutThreshold) {
    return null; // Likely a camera cut, not a wicket event
  }

  // Calculate prominence ratio
  const prominence = bestPeak.delta / (baseline + 0.001);
  if (prominence < opts.prominenceRatio) return null;

  // Boost confidence based on prominence
  confidence *= Math.min(1.2, prominence / opts.prominenceRatio);

  return {
    eventTs: bestPeak.ts,
    confidence: Math.min(0.9, confidence),
    roiName: roi.name,
    prominence,
    peakDelta: bestPeak.delta,
    baseline,
    score: prominence * confidence,
  };
}

// Decode JPEG dataUrl to ImageData using offscreen canvas
async function decodeFrame(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Extract ROI from ImageData
function extractROI(imageData, roi) {
  const { width, height, data } = imageData;
  const x = Math.floor(roi.x * width);
  const y = Math.floor(roi.y * height);
  const w = Math.floor(roi.w * width);
  const h = Math.floor(roi.h * height);

  const roiData = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const srcIdx = ((y + row) * width + (x + col)) * 4;
      const dstIdx = (row * w + col) * 4;
      roiData[dstIdx] = data[srcIdx];
      roiData[dstIdx + 1] = data[srcIdx + 1];
      roiData[dstIdx + 2] = data[srcIdx + 2];
      roiData[dstIdx + 3] = data[srcIdx + 3];
    }
  }

  return new ImageData(roiData, w, h);
}

// Downsample ImageData to target size
function downsample(imageData, targetSize) {
  const { width, height, data } = imageData;
  const scaleX = width / targetSize;
  const scaleY = height / targetSize;
  const downsampled = new Uint8ClampedArray(targetSize * targetSize * 4);

  for (let y = 0; y < targetSize; y++) {
    for (let x = 0; x < targetSize; x++) {
      const srcX = Math.floor(x * scaleX);
      const srcY = Math.floor(y * scaleY);
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (y * targetSize + x) * 4;

      downsampled[dstIdx] = data[srcIdx];
      downsampled[dstIdx + 1] = data[srcIdx + 1];
      downsampled[dstIdx + 2] = data[srcIdx + 2];
      downsampled[dstIdx + 3] = data[srcIdx + 3];
    }
  }

  return new ImageData(downsampled, targetSize, targetSize);
}

// Compute mean absolute difference (luma-based)
function computeDelta(imgData1, imgData2) {
  const data1 = imgData1.data;
  const data2 = imgData2.data;
  let sum = 0;
  const n = data1.length / 4;

  for (let i = 0; i < data1.length; i += 4) {
    const luma1 = 0.299 * data1[i] + 0.587 * data1[i + 1] + 0.114 * data1[i + 2];
    const luma2 = 0.299 * data2[i] + 0.587 * data2[i + 1] + 0.114 * data2[i + 2];
    sum += Math.abs(luma1 - luma2);
  }

  return sum / (n * 255); // Normalize to [0, 1]
}

// Median of array
function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Median Absolute Deviation
function computeMAD(arr, median) {
  const deviations = arr.map(x => Math.abs(x - median));
  return median(deviations);
}

/*
 * INLINE TEST HARNESS (comment out in production)
 * 
 * const frames = [
 *   { ts: 0.0, dataUrl: 'data:image/jpeg;base64,...' },
 *   { ts: 0.25, dataUrl: 'data:image/jpeg;base64,...' },
 *   // ... 60 frames
 * ];
 * 
 * const result = await detectWicketBreak(frames, {
 *   minFrames: 12,
 *   spikeThreshold: 8,
 *   prominenceRatio: 3.0,
 * });
 * 
 * console.log(result);
 * // { triggered: true, eventTs: 3.75, confidence: 0.87, method: 'frame_delta_spike', evidence: {...} }
 */
