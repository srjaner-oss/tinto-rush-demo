/**
 * Curva de dificultad completa (spec sección 6). Único archivo de tuning:
 * ajustar valores aquí, nunca tocar lógica en otros módulos.
 *
 * Fase 1 (greybox): SOLO distancia variable del cliente. Obstáculos, timers,
 * superficies y pedidos especiales llegan en fases posteriores.
 * Unidades: px de diseño (ancho base 390).
 */

export const DIFFICULTY = {
  // Clientes 1-5: onboarding implícito, distancias cómodas (spec 6)
  DIST_MIN_EASY: 260, // px — distancia mínima pocillo→objetivo al inicio
  DIST_MAX_EASY: 420, // px — distancia máxima al inicio

  // La rampa abre el rango hasta estos extremos (cortas y largas difíciles)
  DIST_MIN_FULL: 180, // px — distancias muy cortas: casi no hay margen de v0
  DIST_MAX_FULL: 600, // px — distancias muy largas: cerca del tope de la mesa
  RAMP_END_CLIENT: 12, // cliente en el que la rampa alcanza el rango completo

  // Onboarding: los primeros clientes tiran distancias menos extremas
  EARLY_CLIENT_COUNT: 7, // clientes con varianza de distancia reducida
  EARLY_VARIANCE_FACTOR: 0.75, // recorta 25% el rango de distancia alrededor de su centro

  // Obstáculos estáticos (spec 6): mesa limpia al inicio, luego 1 por
  // envío, dobles en la franja 13-20 (y de ahí en adelante en fase 2)
  OBSTACLES_START_CLIENT: 6, // primer cliente con obstáculo
  OBSTACLES_DOUBLE_CLIENT: 13, // primer cliente con 2 obstáculos
};

/** Cuántos obstáculos estáticos ve el siguiente cliente (spec 6). */
export function getObstacleCount(clientsServed: number): number {
  const client = clientsServed + 1;
  if (client < DIFFICULTY.OBSTACLES_START_CLIENT) return 0;
  if (client < DIFFICULTY.OBSTACLES_DOUBLE_CLIENT) return 1;
  return 2;
}

/**
 * Zonas de resultado dinámicas: amplias al inicio (perdonan mientras el
 * jugador calibra la mano) y cierran hasta los valores del spec 4.4.
 * Rangos en px respecto al punto objetivo.
 */
export const ZONES = {
  PERFECT_EARLY: 30, // px — ±PERFECTO clientes 1-5
  GOOD_EARLY: 100, // px — ±BIEN clientes 1-5
  PERFECT_FINAL: 18, // px — ±PERFECTO desde el cliente 22 (spec 4.4)
  GOOD_FINAL: 55, // px — ±BIEN desde el cliente 22 (spec 4.4)
  RAMP_START_CLIENT: 5, // último cliente con zonas amplias
  RAMP_END_CLIENT: 22, // primer cliente con zonas finales; entre ambos: lineal
};

export interface ZoneRanges {
  perfect: number; // px — |stop − target| ≤ perfect ⇒ PERFECTO
  good: number; // px — |stop − target| ≤ good ⇒ BIEN
}

/**
 * Rangos de zona para el cliente actual. `clientsServed` es 0-based:
 * clientsServed 0-4 ⇔ clientes 1-5.
 */
export function getZoneRanges(clientsServed: number): ZoneRanges {
  const client = clientsServed + 1;
  const span = ZONES.RAMP_END_CLIENT - ZONES.RAMP_START_CLIENT;
  const t = Math.min(1, Math.max(0, (client - ZONES.RAMP_START_CLIENT) / span));
  return {
    perfect: ZONES.PERFECT_EARLY + (ZONES.PERFECT_FINAL - ZONES.PERFECT_EARLY) * t,
    good: ZONES.GOOD_EARLY + (ZONES.GOOD_FINAL - ZONES.GOOD_EARLY) * t,
  };
}

// --- Distancia de slots multi-cliente (spec 6.1.7) ---
// El modelo multi-cliente usa su propio rango, amplio desde el primer spawn:
// con 3 clientes simultáneos la variedad visual la da el rango completo, no
// la progresión. getTargetDistance (arriba) queda para el modelo un-cliente.
export const SLOT_DIST = {
  MIN: 180, // px — el cliente más cercano posible al pocillo
  MAX: 600, // px — el más lejano (se capa al alto real de la mesa)
};

/**
 * Distancia del target de un slot. `rand` en [0,1) lo pone el spawn (0 = la
 * más corta, 1 = la más larga); `maxDistance` capa al alto real de la mesa.
 */
export function getSlotDistance(rand: number, maxDistance: number): number {
  const max = Math.min(SLOT_DIST.MAX, maxDistance);
  const min = Math.min(SLOT_DIST.MIN, max);
  return min + (max - min) * rand;
}

// --- Paciencia por cliente (spec 6.1) ---
// Cada cliente entra con su cuenta regresiva individual. Si llega a cero,
// se va indignado y cuenta como cliente perdido (mismo contador que CORTO).
export const PATIENCE = {
  TIMER_START: 9, // s — paciencia con 0 clientes atendidos
  TIMER_DECAY: 0.05, // s — que pierde el timer por cliente atendido
  TIMER_MIN: 3.5, // s — piso: nunca menos que esto
};

/** Paciencia del próximo cliente: timer(n) = max(MIN, START − n·DECAY). */
export function getPatienceDuration(clientsServed: number): number {
  return Math.max(
    PATIENCE.TIMER_MIN,
    PATIENCE.TIMER_START - clientsServed * PATIENCE.TIMER_DECAY,
  );
}

/** Interpolación lineal de la rampa según clientes atendidos. */
function ramp(from: number, to: number, clientsServed: number): number {
  const t = Math.min(1, clientsServed / DIFFICULTY.RAMP_END_CLIENT);
  return from + (to - from) * t;
}

/**
 * Distancia del objetivo para el siguiente cliente.
 * `rand` en [0,1) lo provee quien llama: la aleatoriedad vive en el spawn,
 * NUNCA en la física. `maxDistance` limita al alto real de la mesa.
 */
export function getTargetDistance(
  clientsServed: number,
  rand: number,
  maxDistance: number,
): number {
  let min = ramp(DIFFICULTY.DIST_MIN_EASY, DIFFICULTY.DIST_MIN_FULL, clientsServed);
  let max = Math.min(
    ramp(DIFFICULTY.DIST_MAX_EASY, DIFFICULTY.DIST_MAX_FULL, clientsServed),
    maxDistance,
  );
  if (clientsServed < DIFFICULTY.EARLY_CLIENT_COUNT) {
    // Primeros clientes: mismo centro, rango 15% más angosto
    const mid = (min + max) / 2;
    const half = ((max - min) / 2) * DIFFICULTY.EARLY_VARIANCE_FACTOR;
    min = mid - half;
    max = mid + half;
  }
  return min + (max - min) * rand;
}
