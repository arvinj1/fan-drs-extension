/**
 * Stumping Analyzer
 * Orchestrates stumping detection: bail-off, crease, foot position
 */

import { detectBailOff } from './bail_detection.js';
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
    hasFoot: false,
  };

  // 1. Bail-off detection (manual override or auto-detect)
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

  // 2. Crease line detection (Phase 2 - stub for now)
  // TODO: Implement crease detection
  evidenceList.push(
    evidence(
      'crease_pending',
      1.0,
      0,
      0,
      'Crease line detection not yet implemented (Phase 2)',
      { phase: 2 }
    )
  );

  // 3. Foot position tracking (Phase 2 - stub for now)
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
  // Phase 1: Only bail-off contributes
  const confidence = critical.hasBailOff ? bailOffConfidence : 0;

  return {
    critical,
    evidenceList,
    confidence,
    bailOff: bailOffTs ? { ts: bailOffTs, method: bailOffMethod, confidence: bailOffConfidence } : null,
    crease: null, // Phase 2
    foot: null,   // Phase 2
  };
}
