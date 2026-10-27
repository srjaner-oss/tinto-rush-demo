/**
 * Física determinista del deslizamiento (spec sección 4.3).
 * Modelo de fricción constante sobre el eje del swipe:
 *   v(t) = v0 - MU * t
 *   distancia_total = v0² / (2 * MU)
 * Sin aleatoriedad. Mismo swipe = mismo resultado, siempre.
 * Unidades: px de diseño (ancho base 390) y segundos.
 */

// --- Input (spec 4.2) ---
export const V_MIN = 400; // px/s — velocidad mínima de lanzamiento tras clamp
export const V_MAX = 3200; // px/s — velocidad máxima de lanzamiento tras clamp
// Cono de lanzamiento respecto al eje vertical. El spec original decía
// ±25°, pero ese cono hacía inalcanzable la carambola: se amplió en
// tuning de dispositivo (55° → 70°) para que el tiro banqueado funcione.
export const MAX_ANGLE_RAD = (70 * Math.PI) / 180;

// --- Fricción (spec 4.3) ---
// Un swipe a V_MAX recorre esta fracción de la mesa. MU se deriva de aquí
// para que la calibración se mantenga en cualquier alto de pantalla.
export const V_MAX_TRAVEL_FRACTION = 0.95;

export function computeMu(travelLength: number): number {
  'worklet';
  return (V_MAX * V_MAX) / (2 * V_MAX_TRAVEL_FRACTION * travelLength);
}

// Zonas de resultado (spec 4.4): los rangos son dinámicos por cliente y
// viven en difficulty.ts (getZoneRanges). resolveResult los recibe como
// parámetros para que la física quede libre de la curva de dificultad.

// LARGO (6.1.3): fallo por pasarse del punto de destino sin derramar.
// Mismo efecto de juego que CORTO; solo cambia el feedback al jugador.
export type SlideResult = 'PERFECTO' | 'BIEN' | 'CORTO' | 'LARGO' | 'DERRAME';

export interface Launch {
  v0: number; // velocidad inicial ya clampeada (px/s)
  dirX: number; // dirección unitaria del deslizamiento
  dirY: number; // siempre negativa: el pocillo viaja hacia arriba
}

/**
 * Convierte la velocidad del gesto al soltar en un lanzamiento válido.
 * Devuelve null si el swipe no va hacia arriba.
 */
export function buildLaunch(vx: number, vy: number): Launch | null {
  'worklet';
  if (vy >= 0) return null;
  let angle = Math.atan2(vx, -vy); // ángulo respecto al eje vertical
  if (angle > MAX_ANGLE_RAD) angle = MAX_ANGLE_RAD;
  if (angle < -MAX_ANGLE_RAD) angle = -MAX_ANGLE_RAD;
  const speed = Math.min(V_MAX, Math.max(V_MIN, Math.hypot(vx, vy)));
  return { v0: speed, dirX: Math.sin(angle), dirY: -Math.cos(angle) };
}

/** Tiempo total del deslizamiento hasta frenar. */
export function slideDuration(v0: number, mu: number): number {
  'worklet';
  return v0 / mu;
}

/** Distancia total que recorrerá el pocillo: v0² / (2·μ). */
export function slideDistance(v0: number, mu: number): number {
  'worklet';
  return (v0 * v0) / (2 * mu);
}

/** Distancia recorrida en el instante t. Forma cerrada: no acumula error por frame. */
export function distanceAt(v0: number, mu: number, t: number): number {
  'worklet';
  const tc = Math.min(t, v0 / mu);
  return v0 * tc - 0.5 * mu * tc * tc;
}

/** Velocidad restante tras recorrer d px del segmento: v(d) = √(v0² − 2·μ·d). */
export function speedAtDistance(v0: number, mu: number, d: number): number {
  'worklet';
  return Math.sqrt(Math.max(v0 * v0 - 2 * mu * d, 0));
}

// --- Obstáculos (spec 7.1 + tuning por feedback en dispositivo) ---
// Rebote por punto de impacto: la normal de contacto define qué tan
// frontal fue el golpe (f = 1 frontal puro, f = 0 refilón puro).
// Frontal: desvío mínimo, pérdida fuerte (queda corto). Refilón: desvío
// proporcional al ángulo de contacto, pérdida leve.
export interface BounceParams {
  frontalLoss: number; // fracción de velocidad perdida en golpe frontal
  glancingLoss: number; // fracción perdida a refilón puro
  maxDeflectRad: number; // desvío máximo (se da a refilón puro)
}

export const AREPA_BOUNCE: BounceParams = {
  frontalLoss: 0.65, // 60-70%: frena y queda corto
  glancingLoss: 0.18, // 15-20%: roce leve
  maxDeflectRad: (30 * Math.PI) / 180,
};

export const CELULAR_BOUNCE: BounceParams = {
  frontalLoss: 0.8, // castigo mayor que la arepa
  glancingLoss: 0.3,
  maxDeflectRad: (30 * Math.PI) / 180,
};

export const BOUNCE_SEPARATION_EPS = 0.5; // px extra al separar pocillo y obstáculo
export const COLLISION_STEP = 12; // px máx entre muestras de colisión (evita túnel a V_MAX)

// --- Carambola: rebote en las paredes laterales de la mesa ---
// Reflexión del ángulo (se invierte la componente X), utilizable a
// propósito para esquivar obstáculos.
export const WALL_BOUNCE_LOSS = 0.1; // pierde 10% por pared: el tiro banqueado a V_MAX alcanza distancias medias
export const MAX_WALL_BOUNCES = 2; // el tercer toque de pared es DERRAME por borde

/** Colisión pocillo (círculo) vs celular/portátil (rectángulo centrado). */
export function circleHitsRect(
  cx: number,
  cy: number,
  r: number,
  ox: number,
  oy: number,
  halfW: number,
  halfH: number,
): boolean {
  'worklet';
  const dx = Math.max(Math.abs(cx - ox) - halfW, 0);
  const dy = Math.max(Math.abs(cy - oy) - halfH, 0);
  return dx * dx + dy * dy <= r * r;
}

/** Colisión pocillo vs arepa (círculo vs círculo). */
export function circleHitsCircle(
  cx: number,
  cy: number,
  r: number,
  ox: number,
  oy: number,
  or: number,
): boolean {
  'worklet';
  const dx = cx - ox;
  const dy = cy - oy;
  const rr = r + or;
  return dx * dx + dy * dy <= rr * rr;
}

/** Rota una dirección unitaria. Con dir hacia arriba, ángulo positivo desvía a la derecha. */
export function rotateDir(x: number, y: number, angleRad: number): { x: number; y: number } {
  'worklet';
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Punto del rectángulo (centrado en ox,oy) más cercano al centro del pocillo. */
export function rectClosestPoint(
  cx: number,
  cy: number,
  ox: number,
  oy: number,
  halfW: number,
  halfH: number,
): { x: number; y: number } {
  'worklet';
  return {
    x: Math.min(Math.max(cx, ox - halfW), ox + halfW),
    y: Math.min(Math.max(cy, oy - halfH), oy + halfH),
  };
}

/**
 * Rebote según el punto de impacto. `n` es la normal de contacto unitaria
 * (del obstáculo hacia el pocillo). Devuelve la dirección nueva y el factor
 * de velocidad restante. Determinista: solo geometría del impacto.
 */
export function computeBounce(
  dirX: number,
  dirY: number,
  nx: number,
  ny: number,
  params: BounceParams,
): { dirX: number; dirY: number; speedFactor: number } {
  'worklet';
  // Frontalidad: 1 = golpe de frente (dir opuesta a la normal), 0 = refilón
  const f = Math.min(Math.max(-(dirX * nx + dirY * ny), 0), 1);
  // Lado del desvío: hacia la tangente por la que ya pasaba el pocillo
  const side = -dirY * nx + dirX * ny >= 0 ? 1 : -1;
  const deflect = params.maxDeflectRad * (1 - f) * side;
  const rotated = rotateDir(dirX, dirY, deflect);
  const loss = params.glancingLoss + (params.frontalLoss - params.glancingLoss) * f;
  return { dirX: rotated.x, dirY: rotated.y, speedFactor: 1 - loss };
}

// --- Multi-cliente (spec 6.1 + 6.1.3): resultado por superposición de área ---
// Radios de zona alrededor del punto de destino de CADA cliente. Fijos (no
// rampan como las bandas de 4.4); tuneables aquí según manda la adenda.
export const TARGET_PERFECT_RADIUS = 18; // px — zona PERFECTO
export const TARGET_GOOD_RADIUS = 55; // px — zona BIEN
// Fracción del área de la zona PERFECTO que la taza debe cubrir (6.1.4;
// corrige 6.1.3, donde el denominador era el área de la taza y dejaba el
// PERFECTO casi imposible). Solo aplica a PERFECTO; BIEN es por contacto.
// 6.1.6: baja de 2/3 a 1/2 como primer ajuste de calibración.
// Ventanas efectivas con taza r=22: PERFECTO ±19.3 px, BIEN ±77 px.
export const CUP_OVERLAP_FRACTION = 1 / 2;
// Sobrepaso extremo (6.1.9): frenar más allá de esta distancia del centro
// del target, en la dirección de la trayectoria, es DERRAME en vez de
// LARGO — restaura el fallo catastrófico del pilar 2. Queda más allá del
// alcance efectivo de BIEN (55 + 22 = 77): LARGO vive entre 77 y 160.
export const OVERSHOOT_SPILL_DISTANCE = 160;

/**
 * Área de intersección de dos círculos a distancia d (fórmula cerrada de la
 * lente, determinista). Casos degenerados: disjuntos = 0, contenido = área
 * del menor.
 */
export function circleOverlapArea(d: number, r1: number, r2: number): number {
  'worklet';
  if (d >= r1 + r2) return 0;
  const rMin = Math.min(r1, r2);
  if (d <= Math.abs(r1 - r2)) return Math.PI * rMin * rMin;
  const a1 = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const a2 = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const a3 =
    0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  return a1 + a2 - a3;
}

/**
 * Resultado por comparación de UNA sola magnitud (6.1.11): la distancia
 * total recorrida por el pocillo contra la distancia recta del lanzamiento
 * al cliente seleccionado. El desajuste lateral no penaliza — la habilidad
 * fina vuelve a ser solo la distancia, como la barra original de 4.2/4.4.
 * Los umbrales son los de 6.1.4-6.1.9 aplicados en 1D: PERFECTO si la taza
 * (centrada en el desfase |Δ|) cubre CUP_OVERLAP_FRACTION del área de la
 * zona PERFECTO; BIEN por contacto; sobrepaso más allá de
 * OVERSHOOT_SPILL_DISTANCE = DERRAME; el resto, CORTO o LARGO según signo.
 * Las salidas físicas (borde, portátil, 3ª pared) siguen siendo DERRAME
 * por su propio camino (el chequeo de borde entra aquí por stopY).
 */
export function resolveDistanceResult(
  traveled: number,
  planned: number,
  stopY: number,
  tableTopY: number,
  cupRadius: number,
): SlideResult {
  'worklet';
  if (stopY < tableTopY) return 'DERRAME'; // se salió por el borde de la mesa
  const delta = traveled - planned; // >0 se pasó, <0 quedó corto
  const dist = Math.abs(delta);
  const needed =
    Math.PI * TARGET_PERFECT_RADIUS * TARGET_PERFECT_RADIUS * CUP_OVERLAP_FRACTION;
  if (circleOverlapArea(dist, cupRadius, TARGET_PERFECT_RADIUS) >= needed) return 'PERFECTO';
  if (dist < cupRadius + TARGET_GOOD_RADIUS) return 'BIEN';
  if (delta > OVERSHOOT_SPILL_DISTANCE) return 'DERRAME'; // sobrepaso extremo (6.1.9)
  return delta > 0 ? 'LARGO' : 'CORTO';
}

/**
 * Semiancho efectivo de la ventana PERFECTO en 1D: el |Δ| máximo que aún
 * cumple la fracción de área. Bisección determinista sobre la misma fórmula
 * de la resolución. Para el overlay de calibración, no para el hot path.
 */
export function effectivePerfectWindow(cupRadius: number): number {
  const needed =
    Math.PI * TARGET_PERFECT_RADIUS * TARGET_PERFECT_RADIUS * CUP_OVERLAP_FRACTION;
  let lo = 0;
  let hi = cupRadius + TARGET_PERFECT_RADIUS;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (circleOverlapArea(mid, cupRadius, TARGET_PERFECT_RADIUS) >= needed) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Zona de resultado según dónde frena el centro del pocillo (spec 4.4).
 * Modo un-cliente, superado por la adenda 6.1: se conserva como referencia
 * de las bandas originales mientras el gate multi-cliente no cierre.
 * `perfectRange`/`goodRange` son los rangos del cliente actual (difficulty.ts).
 */
export function resolveResult(
  stopY: number,
  targetY: number,
  tableTopY: number,
  perfectRange: number,
  goodRange: number,
): SlideResult {
  'worklet';
  if (stopY < tableTopY) return 'DERRAME'; // se salió por el borde de la mesa
  const delta = stopY - targetY; // >0 frenó antes del objetivo, <0 se pasó
  if (Math.abs(delta) <= perfectRange) return 'PERFECTO';
  if (Math.abs(delta) <= goodRange) return 'BIEN';
  return delta > 0 ? 'CORTO' : 'DERRAME';
}
