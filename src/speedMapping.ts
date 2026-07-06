export const ALLOWED_CFM = [0, 50, 60, 70, 80, 90, 100, 110, 120, 130, 150] as const;
const NON_ZERO_CFM = ALLOWED_CFM.filter(v => v > 0);

/**
 * Map a HomeKit RotationSpeed percent to a supported CFM value.
 * Each 10% step corresponds to one entry of the speed table, so the
 * mapping round-trips exactly with cfmToPercent (10% = 50 CFM ... 100% = 150 CFM).
 */
export function percentToCFM(percent: number): number {
  if (percent <= 0) return 0;
  const index = Math.ceil(percent / 10) - 1;
  const clampedIndex = Math.max(0, Math.min(NON_ZERO_CFM.length - 1, index));
  return NON_ZERO_CFM[clampedIndex];
}

/**
 * Map a device-reported CFM to a HomeKit RotationSpeed percent.
 * 0% is reserved for off; every running speed reports a non-zero percent.
 * Off-table values (from other firmware or models) snap to the nearest entry.
 */
export function cfmToPercent(cfm: number): number {
  if (cfm <= 0) return 0;
  return (nearestIndex(cfm) + 1) * 10;
}

/** Snap an arbitrary CFM value to the nearest supported speed (0 stays 0). */
export function nearestAllowedCFM(cfm: number): number {
  if (cfm <= 0) return 0;
  return NON_ZERO_CFM[nearestIndex(cfm)];
}

function nearestIndex(cfm: number): number {
  let best = 0;
  for (let i = 1; i < NON_ZERO_CFM.length; i++) {
    if (Math.abs(NON_ZERO_CFM[i] - cfm) < Math.abs(NON_ZERO_CFM[best] - cfm)) {
      best = i;
    }
  }
  return best;
}
