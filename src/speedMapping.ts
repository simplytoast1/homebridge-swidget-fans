export const ALLOWED_CFM = [0, 50, 60, 70, 80, 90, 100, 110, 120, 130, 150] as const;
const NON_ZERO_CFM = ALLOWED_CFM.filter(v => v > 0);

export function percentToCFM(percent: number): number {
  if (percent <= 0) return 0;
  const index = Math.round((percent / 100) * (NON_ZERO_CFM.length - 1));
  const clampedIndex = Math.max(0, Math.min(NON_ZERO_CFM.length - 1, index));
  return NON_ZERO_CFM[clampedIndex];
}

export function cfmToPercent(cfm: number): number {
  if (cfm <= 0) return 0;
  const index = NON_ZERO_CFM.indexOf(cfm);
  if (index === -1) return 0;
  return Math.round((index / (NON_ZERO_CFM.length - 1)) * 100);
}
