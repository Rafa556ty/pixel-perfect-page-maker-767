// Police Escape rules (pure, unit-tested). Gap = how far (HUD meters) the
// police Porsche is behind the Lamborghini.

/** The police starts this far behind, in the green zone. */
export const START_GAP = 240;
/** Reaching this gap means the player escaped. */
export const ESCAPE_GAP = 600;
/** The police waits this long (s) before it starts the chase. */
export const START_DELAY = 0.8;
/** Police top speed (km/h): a GT3 RS is fast, capable of 290 km/h in pursuit. */
export const POLICE_MAX = 290;
/** Police acceleration (km/h per s at low speed). */
export const POLICE_ACCEL = 58;

export type Zone = "green" | "yellow" | "orange" | "red";

export function policeZone(gap: number): Zone {
  if (gap >= 220) return "green";
  if (gap >= 120) return "yellow";
  if (gap >= 50) return "orange";
  return "red";
}

/** 0 = police on the player, 1 = escaped. */
export const escapeProgress = (gap: number) => Math.max(0, Math.min(1, gap / ESCAPE_GAP));

/** Police acceleration step (km/h) for one frame, never above POLICE_MAX. */
export function policeSpeedStep(speed: number, dt: number, cap = Infinity) {
  const target = Math.min(POLICE_MAX, cap);
  if (speed > target) return Math.max(target, speed - 150 * dt);
  const a = POLICE_ACCEL * (1 - (speed / POLICE_MAX) ** 2) + 4;
  return Math.min(target, speed + a * dt);
}
