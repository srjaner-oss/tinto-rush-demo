/**
 * Entidades y layout del greybox (spec 4.1 y 15.4).
 * Espacio de diseño: 390 px de ancho fijo; el alto se deriva del aspecto
 * real del dispositivo para que la mesa ocupe toda la pantalla.
 */
import {
  MAX_ANGLE_RAD,
  MAX_WALL_BOUNCES,
  TARGET_GOOD_RADIUS,
  circleHitsCircle,
  circleHitsRect,
} from './engine';

import characterContabilidad from '../assets/sprites/characters/contabilidad.svg';
import characterHipster from '../assets/sprites/characters/hipster.svg';
import characterIngeniero from '../assets/sprites/characters/ingeniero.svg';
import characterJefe from '../assets/sprites/characters/jefe.svg';
import characterPracticante from '../assets/sprites/characters/practicante.svg';
import characterRrhh from '../assets/sprites/characters/rrhh.svg';

export const DESIGN_WIDTH = 390; // ancho lógico base (spec 4.1: 390x844)

export const CUP_RADIUS = 22; // radio del pocillo (círculo blanco greybox)
export const CLIENT_RADIUS = 26; // radio del cliente: fija el tamaño del sprite
export const GRAB_RADIUS = 80; // radio alrededor del pocillo donde puede iniciar el swipe

export const MAX_LOST_CLIENTS = 3; // 3 clientes perdidos = fin del turno (spec 3)

export const RESULT_DWELL_MS = 550; // pausa mostrando el resultado antes del siguiente cliente
export const GAME_OVER_DELAY_MS = 350; // del DERRAME al game over; el spec exige < 800 ms (spec 8)

export interface TableLayout {
  designHeight: number; // alto lógico derivado del dispositivo
  tableTopY: number; // borde superior de la mesa: pasarlo es DERRAME
  cupStartX: number; // la "barra" del jugador, centrada abajo
  cupStartY: number;
  maxTravel: number; // recorrido máximo posible del pocillo
}

export function makeTableLayout(designHeight: number): TableLayout {
  const tableTopY = 60; // margen superior: deja aire para el HUD
  const cupStartY = designHeight - 110; // zona inferior de la mesa (spec 4.1)
  return {
    designHeight,
    tableTopY,
    cupStartX: DESIGN_WIDTH / 2,
    cupStartY,
    maxTravel: cupStartY - tableTopY,
  };
}

// --- Multi-cliente (spec 6.1 + 6.1.1): 3 slots en carriles fijos ---
// Cada slot tiene su franja horizontal exclusiva (0 = izquierda, 1 = centro,
// 2 = derecha). Dentro del carril la distancia varía por spawn (curva de
// dificultad) y la lateralidad usa la holgura que deje el footprint; los
// footprints de carriles vecinos nunca se tocan (separación por diseño,
// no probabilística: reemplaza los reintentos con separación mínima).
export const SLOT_COUNT = 3;
// Punto de destino (6.1.2): fusionado con el cliente, este offset por debajo
// del centro del sprite. Con 40: un PERFECTO exacto deja el borde superior
// del pocillo (r=22) 18 px bajo el centro del sprite, y el peor PERFECTO
// hacia el cliente (±18) lo deja justo en el centro — el rostro (mitad
// superior del sprite) nunca queda cubierto al frenar bien.
export const SLOT_AIM_OFFSET_Y = 40;
export const SLOT_RESPAWN_DELAY_MS = 500; // 400-600 ms según 6.1; nunca instantáneo
// El área de juego empieza debajo del HUD, sin excepción (6.1.1)
export const HUD_CLEARANCE = 88; // dp bajo el inset superior reservados para score, combo y vidas
// Barra de paciencia (greybox) sobre cada cliente
export const TIMER_BAR_WIDTH = 48; // px de diseño
export const TIMER_BAR_HEIGHT = 5;
// Centro de la barra respecto al punto de destino: 44 px sobre el centro
// del sprite del cliente (destino + SLOT_AIM_OFFSET_Y + 44)
export const TIMER_BAR_OFFSET_Y = SLOT_AIM_OFFSET_Y + CLIENT_RADIUS + 18;

// Selección de carril por zonas angulares (6.1.11): el swipe elige
// izquierda/centro/derecha con esta frontera respecto a la vertical.
// Generosa por diseño: el cliente lateral más lejano queda a ~13° de la
// barra, así que 7° parte la ambigüedad en mitades. Tuneable.
export const SLOT_ANGLE_BOUNDARY_RAD = (7 * Math.PI) / 180;

// Escala visual del sprite de personaje (6.1.12): solo dibujo — la
// colisión (CLIENT_RADIUS), los targets y los carriles no cambian.
export const CHARACTER_SPRITE_VISUAL_SCALE = 1.3;

// Footprint lateral de un slot (recalculado para 6.1.2/6.1.12): todo se
// centra en la x del destino, así que manda el mayor de: radio BIEN (55),
// sprite del cliente (2·26·1.3 ⇒ ±33.8) y barra de paciencia (48 ⇒ ±24).
// Sigue mandando el radio BIEN, el ancho de carril no cambia.
export const SLOT_FOOTPRINT_HALF = Math.max(
  TARGET_GOOD_RADIUS,
  CLIENT_RADIUS * CHARACTER_SPRITE_VISUAL_SCALE,
  TIMER_BAR_WIDTH / 2,
);
export const SLOT_WALL_MARGIN = 4; // px del borde de pantalla al footprint extremo
export const SLOT_LANE_PADDING = 12; // px mínimos OBLIGATORIOS entre footprints vecinos

// Separación de profundidad (6.1.3): distancia mínima en Y entre los puntos
// de destino de slots activos, para que no aparezcan a la misma altura.
// El rango propio multi-cliente (SLOT_DIST, spec 6.1.7) da span de sobra
// para los 3 slots (2 × 70 = 140 ≪ ~360 de span típico).
export const SLOT_MIN_DEPTH_SEPARATION = 70;

export interface SlotLane {
  center: number; // centro x del carril (px de diseño)
  halfRange: number; // variación lateral máxima del target dentro del carril
}

/**
 * Carril fijo del slot. Con DESIGN_WIDTH 390: carriles de ~127 px; el
 * footprint (±55) más el padding dejan ±2.7 px de variación lateral — el
 * ancho de pantalla no da para más sin solapar radios BIEN. Garantía dura:
 * corridos al peor caso, dos footprints vecinos quedan a SLOT_LANE_PADDING.
 */
export function getSlotLane(slot: number): SlotLane {
  const usable = DESIGN_WIDTH - 2 * SLOT_WALL_MARGIN;
  const laneWidth = usable / SLOT_COUNT;
  return {
    center: SLOT_WALL_MARGIN + laneWidth * (slot + 0.5),
    halfRange: Math.max(0, (laneWidth - 2 * SLOT_FOOTPRINT_HALF - SLOT_LANE_PADDING) / 2),
  };
}

/**
 * Elige un valor en [low, high] a distancia ≥ separation de los valores en
 * `taken`, garantizado por construcción (muestrea uniforme SOLO sobre los
 * subintervalos permitidos, no por reintentos). Si la separación no cabe en
 * el rango, devuelve el candidato que maximiza la separación mínima.
 * `rand` en [0,1) lo pone quien llama: la aleatoriedad vive en el spawn.
 */
export function pickSeparatedValue(
  low: number,
  high: number,
  taken: readonly number[],
  separation: number,
  rand: number,
): number {
  if (high <= low) return low;
  const sorted = [...taken].sort((a, b) => a - b);
  // Subintervalos de [low, high] fuera de las bandas (t ± separation)
  const segments: Array<[number, number]> = [];
  let cursor = low;
  for (const t of sorted) {
    const bandLow = t - separation;
    if (bandLow > cursor) segments.push([cursor, Math.min(bandLow, high)]);
    cursor = Math.max(cursor, t + separation);
    if (cursor >= high) break;
  }
  if (cursor < high) segments.push([cursor, high]);
  const total = segments.reduce((sum, [a, b]) => sum + (b - a), 0);
  if (total > 0) {
    let offset = rand * total;
    for (const [a, b] of segments) {
      if (offset <= b - a) return a + offset;
      offset -= b - a;
    }
    return segments[segments.length - 1][1];
  }
  // No cabe: bordes y puntos medios entre ocupados, el de mayor separación
  const candidates = [low, high];
  for (let i = 0; i < sorted.length - 1; i++) candidates.push((sorted[i] + sorted[i + 1]) / 2);
  let best = low;
  let bestSep = -Infinity;
  for (const c of candidates) {
    let minSep = Infinity;
    for (const t of sorted) minSep = Math.min(minSep, Math.abs(c - t));
    if (minSep > bestSep) {
      bestSep = minSep;
      best = c;
    }
  }
  return best;
}

// --- Personajes (spec 8): sprite asignado al azar por cliente ---
// Tamaños del viewBox de los sprites (verificados en los archivos). El render
// se dimensiona SIEMPRE con estas constantes, nunca con svg.width(): un SVG
// exportado sin width/height reporta tamaño 0 y fallaría en silencio.
export const CHARACTER_SPRITE_VIEWBOX = 1024; // personajes: 1024x1024
export const TABLE_SPRITE_VIEWBOX_W = 1170; // mesa.svg: 1170x2532
export const TABLE_SPRITE_VIEWBOX_H = 2532;

export const CHARACTER_SPRITES = [
  characterContabilidad,
  characterHipster,
  characterIngeniero,
  characterJefe,
  characterPracticante,
  characterRrhh,
] as const;

// Índice del último personaje asignado, para no repetirlo de inmediato
// (mismo patrón que nextRachaPhrase en phrases.ts).
let lastCharacterIndex = -1;

/**
 * Siguiente personaje: aleatorio, distinto al inmediatamente anterior y a
 * los excluidos (los que ya están sentados en otros slots, spec 6.1).
 * Con 6 personajes y máximo 2 exclusiones el pool nunca queda vacío, pero
 * se protege igual por si la lista de sprites se acorta.
 */
export function nextCharacterIndex(exclude: readonly number[] = []): number {
  const pool: number[] = [];
  for (let i = 0; i < CHARACTER_SPRITES.length; i++) {
    if (i !== lastCharacterIndex && !exclude.includes(i)) pool.push(i);
  }
  const index =
    pool.length > 0
      ? pool[Math.floor(Math.random() * pool.length)]
      : Math.floor(Math.random() * CHARACTER_SPRITES.length);
  lastCharacterIndex = index;
  return index;
}

// --- Obstáculos estáticos (spec 7.1), tamaños greybox en px de diseño ---
export type ObstacleKind = 'celular' | 'portatil' | 'arepa';

export interface Obstacle {
  kind: ObstacleKind;
  x: number; // centro
  y: number; // centro
  halfW: number; // arepa: halfW = halfH = radio
  halfH: number;
}

// Celular: bloquea un carril angosto. Rebota con castigo fuerte de velocidad.
export const CELULAR_HALF_W = 22;
export const CELULAR_HALF_H = 39;
// Portátil abierto: bloquea carril ancho (120x72, proporción del 150x90
// original). Choque = DERRAME.
export const PORTATIL_HALF_W = 60;
export const PORTATIL_HALF_H = 36;
// Arepa en plato: rebote suave según punto de impacto. No mata.
export const AREPA_RADIUS = 36;

// Knockback visual al ser golpeado (actualiza la posición real del obstáculo)
export const AREPA_KNOCKBACK_MAX = 40; // px de desplazamiento máximo
export const CELULAR_KNOCKBACK_MAX = 20; // px — la mitad de la arepa
export const KNOCKBACK_MIN = 8; // px mínimos: hasta el golpe más suave se nota
export const KNOCKBACK_FULL_SPEED = 1600; // px/s del pocillo a partir de la cual empuja el tope

const OBSTACLE_SIZES: Record<ObstacleKind, { halfW: number; halfH: number }> = {
  celular: { halfW: CELULAR_HALF_W, halfH: CELULAR_HALF_H },
  portatil: { halfW: PORTATIL_HALF_W, halfH: PORTATIL_HALF_H },
  arepa: { halfW: AREPA_RADIUS, halfH: AREPA_RADIUS },
};

// Colocación: todo obstáculo debe ser 100% legible antes del swipe y no
// puede invadir ni la zona de resultado ni la salida del pocillo (spec 7.3)
export const OBSTACLE_TARGET_CLEARANCE = 50; // px entre la banda BIEN y el obstáculo más alto
export const OBSTACLE_START_CLEARANCE = 110; // px libres encima del pocillo
export const OBSTACLE_SIDE_MARGIN = 12; // px mínimos al borde de la mesa
export const OBSTACLE_MIN_SLOT = 95; // px de franja vertical por obstáculo; si no caben, van menos

const OBSTACLE_KINDS: ObstacleKind[] = ['celular', 'portatil', 'arepa'];

// Fair play del spawn: siempre debe existir al menos una ruta pasable hacia
// el cliente, contando la carambola (rebote en pared) como ruta válida.
const ROUTE_MARGIN = 4; // px de holgura extra del pocillo al validar rutas
const ROUTE_STEP = 8; // px entre muestras de la ruta
const ROUTE_ANGLE_STEP_DEG = 2.5; // barrido de ángulos de lanzamiento
const SPAWN_ATTEMPTS_PER_COUNT = 4; // intentos por cantidad antes de bajar a menos obstáculos

/**
 * ¿Una ruta lanzada con este ángulo llega limpia a la altura del cliente?
 * Marcha el rayo con reflexión en paredes (máx MAX_WALL_BOUNCES, como la
 * física real). Conservador: cualquier obstáculo bloquea, incluso los que
 * rebotan — la ruta garantizada es una ruta sin contacto.
 */
function routeIsClear(
  angleRad: number,
  obstacles: Obstacle[],
  targetY: number,
  layout: TableLayout,
): boolean {
  let x = layout.cupStartX;
  let y = layout.cupStartY;
  let dx = Math.sin(angleRad);
  let dy = -Math.cos(angleRad);
  let bounces = 0;
  const maxSteps = Math.ceil((layout.maxTravel * (MAX_WALL_BOUNCES + 1)) / ROUTE_STEP);
  for (let i = 0; i < maxSteps; i++) {
    x += dx * ROUTE_STEP;
    y += dy * ROUTE_STEP;
    if (x <= CUP_RADIUS || x >= DESIGN_WIDTH - CUP_RADIUS) {
      bounces += 1;
      if (bounces > MAX_WALL_BOUNCES) return false; // la ruta se derramaría
      x = Math.min(Math.max(x, CUP_RADIUS), DESIGN_WIDTH - CUP_RADIUS);
      dx = -dx;
    }
    if (y <= targetY) return true; // llegó a la altura del cliente
    const r = CUP_RADIUS + ROUTE_MARGIN;
    for (const o of obstacles) {
      if (o.kind === 'arepa') {
        if (circleHitsCircle(x, y, r, o.x, o.y, o.halfW)) return false;
      } else if (circleHitsRect(x, y, r, o.x, o.y, o.halfW, o.halfH)) {
        return false;
      }
    }
  }
  return false;
}

/** ¿Existe al menos una ruta pasable (directa o de carambola)? */
export function hasPassableRoute(
  obstacles: Obstacle[],
  targetY: number,
  layout: TableLayout,
): boolean {
  if (obstacles.length === 0) return true;
  const maxDeg = (MAX_ANGLE_RAD * 180) / Math.PI;
  for (let deg = -maxDeg; deg <= maxDeg; deg += ROUTE_ANGLE_STEP_DEG) {
    if (routeIsClear((deg * Math.PI) / 180, obstacles, targetY, layout)) return true;
  }
  return false;
}

/** Un set de obstáculos candidato, sin validar. */
function rollObstacles(
  n: number,
  zoneTop: number,
  slot: number,
): Obstacle[] {
  const obstacles: Obstacle[] = [];
  for (let i = 0; i < n; i++) {
    const kind = OBSTACLE_KINDS[Math.floor(Math.random() * OBSTACLE_KINDS.length)];
    const { halfW, halfH } = OBSTACLE_SIZES[kind];
    const xMargin = halfW + OBSTACLE_SIDE_MARGIN;
    const ySpan = Math.max(slot - 2 * halfH, 0);
    obstacles.push({
      kind,
      x: xMargin + Math.random() * (DESIGN_WIDTH - 2 * xMargin),
      y: zoneTop + slot * i + halfH + Math.random() * ySpan,
      halfW,
      halfH,
    });
  }
  return obstacles;
}

/**
 * Genera los obstáculos del siguiente envío. Aleatoriedad de spawn (tipo y
 * posición), nunca de física: una vez en la mesa, todo es determinista.
 * `goodRange` es el rango BIEN vigente: la zona de resultado queda limpia.
 * Garantía de fair play: solo devuelve sets con ruta pasable; si tras
 * varios intentos no la hay, baja la cantidad (hasta mesa limpia).
 */
export function makeObstacles(
  count: number,
  targetY: number,
  goodRange: number,
  layout: TableLayout,
): Obstacle[] {
  const zoneTop = targetY + goodRange + OBSTACLE_TARGET_CLEARANCE;
  const zoneBottom = layout.cupStartY - OBSTACLE_START_CLEARANCE;
  // Cliente muy cerca: caben menos obstáculos (o ninguno)
  let n = count;
  while (n > 0 && (zoneBottom - zoneTop) / n < OBSTACLE_MIN_SLOT) n -= 1;
  for (let m = n; m > 0; m--) {
    const slot = (zoneBottom - zoneTop) / m;
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS_PER_COUNT; attempt++) {
      const candidate = rollObstacles(m, zoneTop, slot);
      if (hasPassableRoute(candidate, targetY, layout)) return candidate;
    }
  }
  return [];
}
