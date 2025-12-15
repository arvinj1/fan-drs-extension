/**
 * Bail-off detection heuristic (no ML)
 * Uses frame-diff + ROI change scoring to estimate bail-off moment
 * Conservative approach: only returns detection when confidence is high
 */

/**
 * Detect bail-off moment from keyframes using lightweight CV heuristics
 * @param {Array} frames - Array of {ts, jpeg} keyframe objects
 * @param {Object} options - Detection options
 * @returns {Object|null} - {bailOffTs, confidence, method} or null if not detected
 */
export async function detectBailOff(frames, options = {}) {
  if (!frames || frames.length < 10) {
    return null;
  }

  try {
    // Convert frames to ImageData for processing
    const imageDataFrames = await framesToImageData(frames);
    
    // Define ROI candidates (stumps typically on left or right side)
    const roiCandidates = [
      { name: 'right', x: 0.60, y: 0.45, w: 0.25, h: 0.35 },  // Right stumps
      { name: 'left', x: 0.15, y: 0.45, w: 0.25, h: 0.35 },   // Left stumps
    ];
    
    // Try each ROI and pick the one with strongest signal
    let bestDetection = null;
    let bestScore = 0;
    
    for (const roi of roiCandidates) {
      const detection = detectInROI(imageDataFrames, frames, roi, options);
      if (detection && detection.score > bestScore) {
        bestScore = detection.score;
        bestDetection = detection;
      }
    }
    
    // Conservative threshold: only return if we're confident
    const confidenceThreshold = options.minConfidence || 0.65;
    
    if (bestDetection && bestDetection.confidence >= confidenceThreshold) {
      return {
        bailOffTs: bestDetection.ts,
        confidence: bestDetection.confidence,
        method: 'frame_diff_roi',
        roiUsed: bestDetection.roiName,
      };
    }
    
    return null;
  } catch (error) {
    console.error('[Bail Detection] Error:', error);
    return null;
  }
}

/**
 * Convert JPEG data URLs to ImageData objects
 */
async function framesToImageData(frames) {
  const results = [];
  
  for (const frame of frames) {
    try {
      const imageData = await jpegToImageData(frame.jpeg);
      results.push({
        ts: frame.ts,
        imageData,
      });
    } catch (err) {
      console.warn('[Bail Detection] Failed to decode frame:', err);
    }
  }
  
  return results;
}

/**
 * Decode JPEG data URL to ImageData
 */
function jpegToImageData(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      resolve(imageData);
    };
    
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = dataUrl;
  });
}

/**
 * Detect bail-off in a specific ROI
 */
function detectInROI(imageDataFrames, originalFrames, roi, options) {
  if (imageDataFrames.length < 3) return null;
  
  const downsampleSize = options.downsampleSize || 64;
  
  // Extract and downsample ROI from each frame
  const roiFrames = imageDataFrames.map(frame => {
    const roiData = extractROI(frame.imageData, roi);
    const downsampled = downsampleImageData(roiData, downsampleSize, downsampleSize);
    return {
      ts: frame.ts,
      data: downsampled,
    };
  });
  
  // Compute inter-frame deltas (mean absolute difference)
  const deltas = [];
  for (let i = 1; i < roiFrames.length; i++) {
    const delta = computeFrameDelta(roiFrames[i - 1].data, roiFrames[i].data);
    deltas.push({
      ts: roiFrames[i].ts,
      delta,
      index: i,
    });
  }
  
  if (deltas.length === 0) return null;
  
  // Compute baseline and MAD (median absolute deviation)
  const deltaValues = deltas.map(d => d.delta);
  const median = computeMedian(deltaValues);
  const mad = computeMAD(deltaValues, median);
  
  // Find spike: delta > baseline + k * MAD
  const k = options.spikeThreshold || 8;  // Conservative threshold
  const threshold = median + k * mad;
  
  let candidateSpike = null;
  let maxDelta = 0;
  
  for (const d of deltas) {
    if (d.delta > threshold && d.delta > maxDelta) {
      maxDelta = d.delta;
      candidateSpike = d;
    }
  }
  
  if (!candidateSpike) return null;
  
  // Anti-cut check: ensure this isn't a camera cut
  // Check if whole-frame delta is also huge (indicating scene change)
  const wholeFrameDelta = computeWholeFrameDelta(
    imageDataFrames[candidateSpike.index - 1].imageData,
    imageDataFrames[candidateSpike.index].imageData
  );
  
  // If whole frame changed drastically, it's likely a cut, not a bail-off
  const cutThreshold = options.cutThreshold || 0.35;
  if (wholeFrameDelta > cutThreshold) {
    return null;  // Reject as camera cut
  }
  
  // Compute confidence based on spike strength
  const spikeStrength = (candidateSpike.delta - median) / (mad || 1);
  const confidence = Math.min(0.95, 0.5 + spikeStrength * 0.05);
  
  return {
    ts: candidateSpike.ts,
    confidence: Math.max(0, Math.min(1, confidence)),
    score: candidateSpike.delta,
    roiName: roi.name,
  };
}

/**
 * Extract ROI from ImageData
 * @param {ImageData} imageData - Full frame
 * @param {Object} roi - {x, y, w, h} in normalized coords (0-1)
 */
function extractROI(imageData, roi) {
  const { width, height, data } = imageData;
  
  const x = Math.floor(roi.x * width);
  const y = Math.floor(roi.y * height);
  const w = Math.floor(roi.w * width);
  const h = Math.floor(roi.h * height);
  
  const roiCanvas = document.createElement('canvas');
  roiCanvas.width = w;
  roiCanvas.height = h;
  const ctx = roiCanvas.getContext('2d', { willReadFrequently: true });
  
  // Create temporary canvas with full image
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
  tempCtx.putImageData(imageData, 0, 0);
  
  // Draw ROI portion
  ctx.drawImage(tempCanvas, x, y, w, h, 0, 0, w, h);
  
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Downsample ImageData to target dimensions
 */
function downsampleImageData(imageData, targetWidth, targetHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(imageData, 0, 0);
  
  const outCanvas = document.createElement('canvas');
  outCanvas.width = targetWidth;
  outCanvas.height = targetHeight;
  const outCtx = outCanvas.getContext('2d', { willReadFrequently: true });
  outCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
  
  return outCtx.getImageData(0, 0, targetWidth, targetHeight);
}

/**
 * Compute mean absolute difference between two ImageData frames
 */
function computeFrameDelta(imageData1, imageData2) {
  const data1 = imageData1.data;
  const data2 = imageData2.data;
  const len = Math.min(data1.length, data2.length);
  
  let sum = 0;
  let count = 0;
  
  // Compare RGB (skip alpha), sample every 4th pixel for speed
  for (let i = 0; i < len; i += 16) {  // 16 = 4 pixels * 4 channels
    const r1 = data1[i];
    const g1 = data1[i + 1];
    const b1 = data1[i + 2];
    
    const r2 = data2[i];
    const g2 = data2[i + 1];
    const b2 = data2[i + 2];
    
    sum += Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
    count += 3;
  }
  
  // Normalize to [0, 1]
  return count > 0 ? sum / (count * 255) : 0;
}

/**
 * Compute whole-frame delta (for cut detection)
 */
function computeWholeFrameDelta(imageData1, imageData2) {
  // Downsample both for speed
  const small1 = downsampleImageData(imageData1, 64, 64);
  const small2 = downsampleImageData(imageData2, 64, 64);
  return computeFrameDelta(small1, small2);
}

/**
 * Compute median of array
 */
function computeMedian(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute MAD (median absolute deviation)
 */
function computeMAD(arr, median) {
  if (arr.length === 0) return 0;
  const deviations = arr.map(x => Math.abs(x - median));
  return computeMedian(deviations);
}
