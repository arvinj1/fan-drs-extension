/**
 * Bail-off detection heuristic (no ML)
 * Uses frame-diff + ROI change scoring to estimate bail-off moment
 * Conservative approach: only returns detection when confidence is high
 */

/**
 * Detect bail-off moment from keyframes using lightweight CV heuristics
 * @param {Array} frames - Array of {ts, jpeg} keyframe objects
 * @param {Object} options - Detection options
 * @returns {Object|null} - {bailOffTs, confidence, method, roiUsed, artifacts} or null
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
    const allDetections = []; // For debug
    
    for (const roi of roiCandidates) {
      const detection = detectInROI(imageDataFrames, frames, roi, options);
      if (detection) {
        allDetections.push({ ...detection, roi });
        if (detection.score > bestScore) {
          bestScore = detection.score;
          bestDetection = detection;
        }
      }
    }
    
    // Conservative threshold: only return if we're confident
    const confidenceThreshold = options.minConfidence || 0.65;
    
    if (bestDetection && bestDetection.confidence >= confidenceThreshold) {
      const result = {
        bailOffTs: bestDetection.ts,
        confidence: bestDetection.confidence,
        method: 'frame_diff_roi',
        roiUsed: bestDetection.roiName,
        frameIndex: bestDetection.frameIndex,
      };
      
      // Add debug artifacts if requested
      if (options.debugMode) {
        result.artifacts = {
          deltaMasks: bestDetection.deltaMasks,
          deltas: bestDetection.deltas,
          roi: bestDetection.roi,
          allDetections,
        };
      }
      
      return result;
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
 * Returns detection with debug artifacts
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
  const deltaMasks = []; // For visualization
  
  for (let i = 1; i < roiFrames.length; i++) {
    const delta = computeFrameDelta(roiFrames[i - 1].data, roiFrames[i].data);
    deltas.push({
      ts: roiFrames[i].ts,
      delta,
      index: i,
    });
    
    // Create delta mask for debug visualization
    if (options.debugMode) {
      const mask = createDeltaMask(roiFrames[i - 1].data, roiFrames[i].data);
      deltaMasks.push({ ts: roiFrames[i].ts, mask });
    }
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
    frameIndex: candidateSpike.index,
    deltaMasks: options.debugMode ? deltaMasks : undefined,
    deltas,
    roi,
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
/**
 * Create delta mask (heat map) for visualization
 * Shows per-pixel difference between two frames
 */
function createDeltaMask(imageData1, imageData2) {
  const { width, height } = imageData1;
  const data1 = imageData1.data;
  const data2 = imageData2.data;
  const maskData = new Uint8ClampedArray(width * height * 4);
  
  for (let i = 0; i < data1.length; i += 4) {
    const r1 = data1[i];
    const g1 = data1[i + 1];
    const b1 = data1[i + 2];
    
    const r2 = data2[i];
    const g2 = data2[i + 1];
    const b2 = data2[i + 2];
    
    // Compute per-pixel delta
    const delta = (Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2)) / 3;
    
    // Map to heat color (blue = low, red = high)
    if (delta < 30) {
      // Blue (minimal change)
      maskData[i] = 0;
      maskData[i + 1] = 0;
      maskData[i + 2] = 100 + delta * 2;
    } else if (delta < 60) {
      // Yellow (moderate change)
      maskData[i] = 100 + (delta - 30) * 5;
      maskData[i + 1] = 100 + (delta - 30) * 5;
      maskData[i + 2] = 0;
    } else {
      // Red (high change)
      maskData[i] = 255;
      maskData[i + 1] = Math.max(0, 255 - (delta - 60) * 2);
      maskData[i + 2] = 0;
    }
    maskData[i + 3] = 255;
  }
  
  return new ImageData(maskData, width, height);
}

/**
 * Create debug visualization for bail-off detection
 * Shows: Delta timeline + spike frame + heat map
 */
export function createBailOffDebugVisualization(artifacts, frameIndex) {
  if (!artifacts || !artifacts.deltaMasks) return null;
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  // Layout: Delta graph (top) + Heat map (bottom)
  const graphHeight = 150;
  const maskWidth = artifacts.deltaMasks[0].mask.width * 4; // Scale up 4x
  const maskHeight = artifacts.deltaMasks[0].mask.height * 4;
  
  canvas.width = Math.max(800, maskWidth);
  canvas.height = graphHeight + maskHeight + 40;
  
  // Fill background
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Draw delta timeline
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth = 2;
  ctx.beginPath();
  
  const deltas = artifacts.deltas;
  const maxDelta = Math.max(...deltas.map(d => d.delta));
  const xStep = (canvas.width - 40) / deltas.length;
  
  deltas.forEach((d, i) => {
    const x = 20 + i * xStep;
    const y = graphHeight - 20 - (d.delta / maxDelta) * (graphHeight - 40);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
    
    // Highlight spike frame
    if (d.index === frameIndex) {
      ctx.save();
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  });
  ctx.stroke();
  
  // Labels
  ctx.fillStyle = '#fff';
  ctx.font = '12px monospace';
  ctx.fillText('Frame Delta Timeline (spike = bail-off)', 20, 20);
  ctx.fillText(`Max: ${maxDelta.toFixed(3)}`, canvas.width - 120, 20);
  
  // Draw delta mask (heat map) for spike frame
  const spikeFrameDelta = artifacts.deltaMasks.find(dm => 
    deltas.findIndex(d => d.ts === dm.ts) + 1 === frameIndex
  );
  
  if (spikeFrameDelta) {
    ctx.fillText('Bail-off frame heat map:', 20, graphHeight + 25);
    
    // Scale up mask 4x
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = spikeFrameDelta.mask.width;
    tempCanvas.height = spikeFrameDelta.mask.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(spikeFrameDelta.mask, 0, 0);
    
    ctx.drawImage(tempCanvas, 20, graphHeight + 35, maskWidth, maskHeight);
    
    // Draw ROI box
    if (artifacts.roi) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.strokeRect(20, graphHeight + 35, maskWidth, maskHeight);
      ctx.fillStyle = '#fbbf24';
      ctx.font = '10px monospace';
      ctx.fillText(artifacts.roi.name.toUpperCase() + ' ROI', 25, graphHeight + 50);
    }
  }
  
  return canvas;
}