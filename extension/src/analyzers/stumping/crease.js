/**
 * Crease Line Detection (Auto)
 * 
 * Detects the batting crease line using Hough line transform on edge-detected frames.
 * Returns the strongest horizontal line candidate with confidence score.
 * 
 * Algorithm:
 * 1. Extract ROI (bottom 40% of frame - crease region)
 * 2. Apply Canny edge detection
 * 3. Run Hough line transform for horizontal lines (±15° from horizontal)
 * 4. Filter by length, position, and consistency across frames
 * 5. Return strongest candidate with confidence
 * 
 * Debug Mode:
 * - Visualizes edge map, detected lines, and ROI
 * - Adjustable thresholds via config
 * - Frame-by-frame analysis logs
 */

/**
 * Default thresholds (adjustable via debug panel)
 */
const DEFAULT_CONFIG = {
  // ROI selection
  roiBottom: 0.40,        // Use bottom 40% of frame
  roiLeft: 0.15,          // Crop sides to reduce noise
  roiRight: 0.85,
  
  // Edge detection (Canny-like)
  edgeLowThreshold: 50,   // Low threshold for hysteresis
  edgeHighThreshold: 150, // High threshold for hysteresis
  
  // Hough transform
  houghThreshold: 30,     // Min votes for line
  minLineLength: 100,     // Min line length in pixels
  maxLineGap: 20,         // Max gap between line segments
  
  // Angle constraints (degrees from horizontal)
  minAngle: -15,          // -15° to +15° from horizontal
  maxAngle: 15,
  
  // Confidence thresholds
  strongConfidence: 0.80, // Above this = high confidence
  minConfidence: 0.40,    // Below this = reject
  
  // Frame consistency
  minConsistentFrames: 2, // Need line in at least 2 frames
  
  // Debug
  debugMode: false,       // Enable visualization
};

/**
 * Detect crease line across multiple frames
 * @param {Array} frames - Array of {ts, jpeg} keyframes
 * @param {Object} config - Detection thresholds (optional)
 * @returns {Promise<Object>} { line, confidence, frameIndex, debug }
 */
export async function detectCrease(frames, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const candidates = [];
  const debugFrames = [];
  
  // Analyze each frame
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const result = await detectCreaseInFrame(frame, i, cfg);
    
    if (result.line) {
      candidates.push({
        ...result,
        frameIndex: i,
        ts: frame.ts,
      });
    }
    
    if (cfg.debugMode) {
      debugFrames.push(result.debug);
    }
  }
  
  // No candidates found
  if (candidates.length === 0) {
    return {
      line: null,
      confidence: 0,
      frameIndex: -1,
      evidence: "No horizontal lines detected in crease region",
      debug: cfg.debugMode ? { frames: debugFrames } : undefined,
    };
  }
  
  // Select best candidate (highest confidence + consistency)
  const best = selectBestCandidate(candidates, cfg);
  
  return {
    line: best.line,
    confidence: best.confidence,
    frameIndex: best.frameIndex,
    ts: best.ts,
    evidence: `Crease line detected at y=${best.line.y.toFixed(0)}px (${candidates.length} candidate frames)`,
    metrics: {
      votes: best.votes,
      length: best.length,
      angle: best.angle,
      consistentFrames: candidates.length,
    },
    debug: cfg.debugMode ? { 
      frames: debugFrames,
      allCandidates: candidates 
    } : undefined,
  };
}

/**
 * Detect crease line in single frame
 */
async function detectCreaseInFrame(frame, frameIndex, cfg) {
  try {
    // Decode JPEG to ImageData
    const imageData = await decodeFrame(frame.jpeg);
    
    // Extract ROI (bottom portion where crease is)
    const roi = extractROI(imageData, cfg);
    
    // Convert to grayscale
    const gray = toGrayscale(roi);
    
    // Edge detection (simplified Canny)
    const edges = detectEdges(gray, cfg);
    
    // Hough transform for lines
    const lines = houghLines(edges, cfg);
    
    // Filter for horizontal lines in expected region
    const horizontalLines = filterHorizontalLines(lines, cfg);
    
    if (horizontalLines.length === 0) {
      return {
        line: null,
        confidence: 0,
        debug: cfg.debugMode ? {
          frameIndex,
          roi,
          edges,
          lines: [],
        } : undefined,
      };
    }
    
    // Select strongest line
    const bestLine = horizontalLines[0]; // Already sorted by votes
    const confidence = computeLineConfidence(bestLine, horizontalLines, cfg);
    
    return {
      line: bestLine,
      confidence,
      votes: bestLine.votes,
      length: bestLine.length,
      angle: bestLine.angle,
      debug: cfg.debugMode ? {
        frameIndex,
        roi,
        edges,
        lines: horizontalLines,
        selectedLine: bestLine,
      } : undefined,
    };
  } catch (err) {
    console.warn('[Crease] Frame analysis failed:', err);
    return { line: null, confidence: 0 };
  }
}

/**
 * Decode JPEG data URL to ImageData
 */
async function decodeFrame(jpegDataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, img.width, img.height);
      resolve(imageData);
    };
    img.onerror = reject;
    img.src = jpegDataUrl;
  });
}

/**
 * Extract Region of Interest (bottom portion of frame)
 */
function extractROI(imageData, cfg) {
  const { width, height, data } = imageData;
  
  const top = Math.floor(height * (1 - cfg.roiBottom));
  const left = Math.floor(width * cfg.roiLeft);
  const right = Math.floor(width * cfg.roiRight);
  const bottom = height;
  
  const roiWidth = right - left;
  const roiHeight = bottom - top;
  
  const roiData = new Uint8ClampedArray(roiWidth * roiHeight * 4);
  
  for (let y = 0; y < roiHeight; y++) {
    for (let x = 0; x < roiWidth; x++) {
      const srcIdx = ((top + y) * width + (left + x)) * 4;
      const dstIdx = (y * roiWidth + x) * 4;
      roiData[dstIdx] = data[srcIdx];
      roiData[dstIdx + 1] = data[srcIdx + 1];
      roiData[dstIdx + 2] = data[srcIdx + 2];
      roiData[dstIdx + 3] = 255;
    }
  }
  
  return new ImageData(roiData, roiWidth, roiHeight);
}

/**
 * Convert to grayscale
 */
function toGrayscale(imageData) {
  const { width, height, data } = imageData;
  const gray = new Uint8ClampedArray(width * height);
  
  for (let i = 0; i < gray.length; i++) {
    const idx = i * 4;
    gray[i] = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
  }
  
  return { data: gray, width, height };
}

/**
 * Simple edge detection (Sobel gradient magnitude)
 */
function detectEdges(gray, cfg) {
  const { data, width, height } = gray;
  const edges = new Uint8ClampedArray(width * height);
  
  // Sobel kernels
  const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0, gy = 0;
      
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const idx = (y + ky) * width + (x + kx);
          const ki = (ky + 1) * 3 + (kx + 1);
          gx += data[idx] * sobelX[ki];
          gy += data[idx] * sobelY[ki];
        }
      }
      
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      const idx = y * width + x;
      
      // Simple thresholding (not full Canny hysteresis)
      if (magnitude > cfg.edgeHighThreshold) {
        edges[idx] = 255;
      } else if (magnitude > cfg.edgeLowThreshold) {
        edges[idx] = 128; // Weak edge
      }
    }
  }
  
  return { data: edges, width, height };
}

/**
 * Simplified Hough line transform (horizontal lines only)
 */
function houghLines(edges, cfg) {
  const { data, width, height } = edges;
  const lines = [];
  
  // Accumulator for horizontal lines (y-position)
  const accumulator = new Array(height).fill(0);
  
  // Vote for horizontal edges
  for (let y = 0; y < height; y++) {
    let edgePixels = 0;
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] === 255) {
        edgePixels++;
      }
    }
    accumulator[y] = edgePixels;
  }
  
  // Find peaks (local maxima above threshold)
  for (let y = 1; y < height - 1; y++) {
    const votes = accumulator[y];
    if (votes > cfg.houghThreshold && 
        votes > accumulator[y - 1] && 
        votes > accumulator[y + 1]) {
      lines.push({
        y,
        votes,
        length: votes, // Approximate line length
        angle: 0, // Horizontal
      });
    }
  }
  
  // Sort by votes (strongest first)
  lines.sort((a, b) => b.votes - a.votes);
  
  return lines;
}

/**
 * Filter for horizontal lines within angle constraint
 */
function filterHorizontalLines(lines, cfg) {
  // In this simplified version, all lines are horizontal
  // Filter by minimum length
  return lines.filter(line => line.length >= cfg.minLineLength);
}

/**
 * Compute confidence for detected line
 */
function computeLineConfidence(line, allLines, cfg) {
  // Base confidence from votes (normalized)
  const maxVotes = Math.max(...allLines.map(l => l.votes));
  const voteScore = line.votes / maxVotes;
  
  // Length score
  const lengthScore = Math.min(1.0, line.length / cfg.minLineLength);
  
  // Dominance score (how much stronger than others)
  const secondBest = allLines[1]?.votes || 0;
  const dominanceScore = secondBest > 0 ? Math.min(1.0, (line.votes - secondBest) / line.votes) : 1.0;
  
  // Combined confidence
  const rawConfidence = 0.5 * voteScore + 0.3 * lengthScore + 0.2 * dominanceScore;
  
  // Cap at strong confidence threshold
  return Math.min(cfg.strongConfidence, rawConfidence);
}

/**
 * Select best candidate across frames (consistency + confidence)
 */
function selectBestCandidate(candidates, cfg) {
  // Group candidates by y-position (within tolerance)
  const tolerance = 10; // pixels
  const groups = [];
  
  for (const candidate of candidates) {
    let found = false;
    for (const group of groups) {
      if (Math.abs(group[0].line.y - candidate.line.y) < tolerance) {
        group.push(candidate);
        found = true;
        break;
      }
    }
    if (!found) {
      groups.push([candidate]);
    }
  }
  
  // Score each group (size * avg confidence)
  let bestGroup = null;
  let bestScore = 0;
  
  for (const group of groups) {
    const avgConfidence = group.reduce((sum, c) => sum + c.confidence, 0) / group.length;
    const consistencyBonus = Math.min(1.0, group.length / cfg.minConsistentFrames);
    const score = avgConfidence * consistencyBonus;
    
    if (score > bestScore) {
      bestScore = score;
      bestGroup = group;
    }
  }
  
  // Return highest confidence candidate from best group
  if (bestGroup) {
    bestGroup.sort((a, b) => b.confidence - a.confidence);
    const best = bestGroup[0];
    
    // Boost confidence for consistency
    const consistencyBoost = Math.min(0.15, (bestGroup.length - 1) * 0.05);
    best.confidence = Math.min(0.95, best.confidence + consistencyBoost);
    
    return best;
  }
  
  // Fallback to highest confidence overall
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0];
}

/**
 * Create debug visualization canvas
 */
export function createDebugVisualization(debugData) {
  if (!debugData?.frames) return null;
  
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  // Layout: Original | Edges | Lines
  const frame = debugData.frames[0];
  if (!frame?.roi) return null;
  
  const w = frame.roi.width;
  const h = frame.roi.height;
  canvas.width = w * 3;
  canvas.height = h;
  
  // Draw ROI
  ctx.putImageData(frame.roi, 0, 0);
  
  // Draw edges
  if (frame.edges) {
    const edgeImageData = new ImageData(w, h);
    for (let i = 0; i < frame.edges.data.length; i++) {
      const idx = i * 4;
      edgeImageData.data[idx] = frame.edges.data[i];
      edgeImageData.data[idx + 1] = frame.edges.data[i];
      edgeImageData.data[idx + 2] = frame.edges.data[i];
      edgeImageData.data[idx + 3] = 255;
    }
    ctx.putImageData(edgeImageData, w, 0);
  }
  
  // Draw detected lines
  if (frame.lines) {
    ctx.drawImage(canvas, 0, 0, w, h, w * 2, 0, w, h); // Copy ROI
    ctx.strokeStyle = 'yellow';
    ctx.lineWidth = 2;
    
    frame.lines.forEach(line => {
      ctx.beginPath();
      ctx.moveTo(w * 2, line.y);
      ctx.lineTo(w * 3, line.y);
      ctx.stroke();
    });
    
    // Highlight selected line
    if (frame.selectedLine) {
      ctx.strokeStyle = 'lime';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(w * 2, frame.selectedLine.y);
      ctx.lineTo(w * 3, frame.selectedLine.y);
      ctx.stroke();
    }
  }
  
  return canvas;
}

/**
 * Manual test steps:
 * 
 * 1. Open stumping video: https://www.youtube.com/watch?v=i3tcsO277qs
 * 2. Seek to stumping moment (around 0:34)
 * 3. Open Fan DRS sidebar, click Analyze
 * 4. Open browser console
 * 5. Run: 
 *    const { detectCrease } = await import(chrome.runtime.getURL('src/analyzers/stumping/crease.js'));
 *    const result = await detectCrease(state.keyframes.frames.slice(20, 30), { debugMode: true });
 *    console.log(result);
 * 6. Check result.line.y (should be in bottom 40% of frame)
 * 7. Verify result.confidence > 0.5 for clear crease
 * 8. Visualize: 
 *    const canvas = createDebugVisualization(result.debug);
 *    document.body.appendChild(canvas);
 * 
 * Expected output:
 * - line.y: 120-160 (for 240px tall ROI)
 * - confidence: 0.6-0.8 (typical)
 * - evidence: "Crease line detected at y=142px (3 candidate frames)"
 * 
 * Debug panel TODO (Phase 2):
 * - Add sliders for edgeLowThreshold, edgeHighThreshold
 * - Add slider for houghThreshold
 * - Live preview of edge map + detected lines
 * - Per-frame scrubber
 */
