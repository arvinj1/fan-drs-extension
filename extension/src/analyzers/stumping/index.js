/**
 * Stumping Analyzer
 * Orchestrates stumping detection: bail-off, crease, stump, foot position
 */

import { detectBailOff } from './bail_detection.js';
import { detectCrease } from './crease.js';
import { detectStumps } from './stump_detection.js';
import { evidence } from '../schema.js';

/**
 * Analyze stumping decision
 * @param {Object} params
 * @param {Array} params.frames - Keyframes for analysis window
 * @param {Object} params.window - {t0, t1} time window
 * @param {Object} params.challenge - Manual selections from Challenge Mode
 * @param {string} params.mode - Analysis mode (A/B/C)
 * @returns {Promise<Object>} Analysis result
 */
export async function runStumping({ frames, window, challenge = {}, mode = 'B' }) {
  const evidenceList = [];
  const critical = {
    requiresCriticalSignals: true,
    hasBailOff: false,
    hasCrease: false,
    hasStumps: false,
    hasFoot: false,
  };

  // Get debug config from sidebar (if available)
  const debugConfig = window.parent?.fanDRSDebugConfig || {};
  const debugMode = debugConfig.enabled || false;

  // 1. Stump detection (auto-detect)
  let stumps = [];
  let stumpConfidence = 0;
  
  const stumpDetection = await detectStumps(frames, {
    debugMode,
    minConfidence: 0.50,
  });
  
  if (stumpDetection && stumpDetection.stumps.length >= 2) {
    stumps = stumpDetection.stumps;
    stumpConfidence = stumpDetection.confidence;
    critical.hasStumps = stumpConfidence >= 0.50;
    
    evidenceList.push(
      evidence(
        'stumps_detected',
        1.0,                      // weight: critical signal
        stumpConfidence,          // reliability: detection confidence
        0.75,                     // quality: auto-detection
        `Detected ${stumps.length} stumps with ${Math.round(stumpConfidence * 100)}% confidence`,
        { 
          count: stumps.length,
          positions: stumps.map(s => s.x),
          confidence: stumpConfidence,
          frameIndex: stumpDetection.frameIndex
        }
      )
    );
  } else {
    evidenceList.push(
      evidence(
        'stumps_missing',
        1.0,
        0,
        0,
        'Stumps not detected. Camera angle may be unsuitable.',
        { reason: 'auto_detection_failed' }
      )
    );
  }

  // 2. Bail-off detection (manual override or auto-detect)
  let bailOffTs = null;
  let bailOffConfidence = 0;
  let bailOffMethod = null;

  if (challenge.bailOffTs != null) {
    // User manually selected bail-off frame
    bailOffTs = challenge.bailOffTs;
    bailOffConfidence = 1.0; // Manual selection = 100% reliability
    bailOffMethod = 'manual';
    critical.hasBailOff = true;
    
    evidenceList.push(
      evidence(
        'bail_off_manual',
        1.0,   // weight: critical signal
        1.0,   // reliability: user confirmed
        0.9,   // quality: user selection
        `User selected bail-off at ${bailOffTs.toFixed(2)}s`,
        { ts: bailOffTs, method: 'manual' }
      )
    );
  } else {
    // Attempt auto-detection
    const detection = await detectBailOff(frames, {
      debugMode,
      minConfidence: 0.65,
      spikeThreshold: 8,
      cutThreshold: 0.35,
    });

    if (detection) {
      bailOffTs = detection.bailOffTs;
      bailOffConfidence = detection.confidence;
      bailOffMethod = detection.method;
      critical.hasBailOff = true;

      evidenceList.push(
        evidence(
          'bail_off_auto',
          1.0,                    // weight: critical signal
          detection.confidence,   // reliability: CV confidence
          0.8,                    // quality: auto-detection
          `Auto-detected bail-off at ${bailOffTs.toFixed(2)}s (${Math.round(detection.confidence * 100)}% confidence)`,
          { ts: bailOffTs, method: 'auto', roiUsed: detection.roiUsed }
        )
      );
    } else {
      evidenceList.push(
        evidence(
          'bail_off_missing',
          1.0,
          0,
          0,
          'Bail-off not detected. Use Challenge Mode to manually select.',
          { reason: 'auto_detection_failed' }
        )
      );
    }
  }

  // 3. Crease line detection
  let creaseY = null;
  let creaseConfidence = 0;
  
  const creaseDetection = await detectCrease(frames, {
    debugMode,
    minConfidence: 0.40,
  });
  
  if (creaseDetection.line) {
    creaseY = creaseDetection.line.y;
    creaseConfidence = creaseDetection.confidence;
    critical.hasCrease = creaseConfidence >= 0.50;
    
    evidenceList.push(
      evidence(
        'crease_detected',
        1.0,                      // weight: critical signal
        creaseConfidence,         // reliability: detection confidence
        0.75,                     // quality: auto-detection (heuristic)
        creaseDetection.evidence,
        { 
          y: creaseY, 
          confidence: creaseConfidence,
          metrics: creaseDetection.metrics 
        }
      )
    );
  } else {
    evidenceList.push(
      evidence(
        'crease_missing',
        1.0,
        0,
        0,
        'Crease line not detected. Low contrast or unclear frame.',
        { reason: 'auto_detection_failed' }
      )
    );
  }

  // 4. Foot position tracking (Phase 2 - stub for now)
  // TODO: Implement foot tracking
  evidenceList.push(
    evidence(
      'foot_pending',
      1.0,
      0,
      0,
      'Foot position tracking not yet implemented (Phase 2)',
      { phase: 2 }
    )
  );

  // Calculate overall confidence
  // Phase 1: Stumps + Bail-off + Crease contribute (Foot pending)
  let confidence = 0;
  const signals = [critical.hasStumps, critical.hasBailOff, critical.hasCrease].filter(Boolean).length;
  
  if (signals >= 2) {
    // At least 2 critical signals present
    confidence = (
      (critical.hasStumps ? stumpConfidence * 0.3 : 0) +
      (critical.hasBailOff ? bailOffConfidence * 0.4 : 0) +
      (critical.hasCrease ? creaseConfidence * 0.3 : 0)
    );
  } else if (signals === 1) {
    // Only 1 signal - partial confidence
    confidence = Math.max(stumpConfidence, bailOffConfidence, creaseConfidence) * 0.4;
  }

  return {
    critical,
    evidenceList,
    confidence,
    stumps: stumps.length > 0 ? { stumps, confidence: stumpConfidence, frameIndex: stumpDetection.frameIndex } : null,
    bailOff: bailOffTs ? { ts: bailOffTs, method: bailOffMethod, confidence: bailOffConfidence } : null,
    crease: creaseY ? { y: creaseY, confidence: creaseConfidence, frameIndex: creaseDetection.frameIndex } : null,
    foot: null,   // Phase 2
  };
}
