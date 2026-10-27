/**
 * Pantalla de juego (spec 4, 6.1 y 15.3).
 * - El game loop corre en un worklet de Reanimated (useFrameCallback, UI thread).
 * - Skia dibuja la escena leyendo SharedValues: cero setState por frame.
 * - React solo renderiza HUD y overlay de game over, actualizados por resultado.
 * - Multi-cliente (spec 6.1-6.1.2): 3 slots en carriles fijos con distancia
 *   variable por spawn; el punto de destino va fusionado con el sprite del
 *   cliente y cada slot tiene su timer de paciencia. El swipe elige slot
 *   por drift lateral.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  ImageSVG,
  Line,
  Rect,
  fitbox,
  rect,
  useSVG,
  vec,
} from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  runOnJS,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { Hud } from '../components/Hud';
import { getObstacleCount, getPatienceDuration, getSlotDistance } from '../game/difficulty';
import {
  AREPA_BOUNCE,
  BOUNCE_SEPARATION_EPS,
  CELULAR_BOUNCE,
  COLLISION_STEP,
  MAX_ANGLE_RAD,
  MAX_WALL_BOUNCES,
  OVERSHOOT_SPILL_DISTANCE,
  TARGET_GOOD_RADIUS,
  WALL_BOUNCE_LOSS,
  buildLaunch,
  circleHitsCircle,
  circleHitsRect,
  computeBounce,
  computeMu,
  distanceAt,
  effectivePerfectWindow,
  rectClosestPoint,
  resolveDistanceResult,
  slideDuration,
  speedAtDistance,
  type SlideResult,
} from '../game/engine';
import {
  AREPA_KNOCKBACK_MAX,
  CELULAR_KNOCKBACK_MAX,
  CHARACTER_SPRITES,
  CHARACTER_SPRITE_VIEWBOX,
  CHARACTER_SPRITE_VISUAL_SCALE,
  CLIENT_RADIUS,
  CUP_RADIUS,
  DESIGN_WIDTH,
  GAME_OVER_DELAY_MS,
  GRAB_RADIUS,
  HUD_CLEARANCE,
  KNOCKBACK_FULL_SPEED,
  KNOCKBACK_MIN,
  MAX_LOST_CLIENTS,
  RESULT_DWELL_MS,
  SLOT_AIM_OFFSET_Y,
  SLOT_ANGLE_BOUNDARY_RAD,
  SLOT_COUNT,
  SLOT_MIN_DEPTH_SEPARATION,
  SLOT_RESPAWN_DELAY_MS,
  TABLE_SPRITE_VIEWBOX_H,
  TABLE_SPRITE_VIEWBOX_W,
  TIMER_BAR_HEIGHT,
  TIMER_BAR_OFFSET_Y,
  TIMER_BAR_WIDTH,
  getSlotLane,
  makeObstacles,
  makeTableLayout,
  nextCharacterIndex,
  pickSeparatedValue,
  type Obstacle,
} from '../game/entities';
import { PHASE, useGameStore, type GamePhase } from '../game/stateMachine';
import { GameOver } from './GameOver';

import tableSprite from '../assets/sprites/table/mesa.svg';

// Greybox 6.1: obstáculos fuera mientras se valida la mecánica multi-cliente
// limpia. Su física y render siguen intactos; se reintegran en tarea aparte.
const OBSTACLES_ENABLED = false;

// Overlay de calibración (6.1.1-6.1.11): dibuja las zonas 1D reales de la
// evaluación — bandas de distancia (PERFECTO amarilla, BIEN blanca, frontera
// de DERRAME punteada) alineadas con la trayectoria ideal hacia cada
// cliente. Apagar aquí cuando cierre el gate; no borrar.
const DEBUG_TARGET_ZONES = true;
const DEBUG_BAND_HALF_WIDTH = 45; // semiancho transversal de las bandas (solo visual)

// Guía de apuntado: línea punteada corta. Muestra dirección, nunca
// distancia — predecir la distancia es la habilidad del jugador (spec 4.2).
const GUIDE_LENGTH = 90; // px de diseño
const AIM_DEADZONE = 6; // px de arrastre mínimos para mostrar la guía

// Colores greybox de lo que aún no tiene arte final (pocillo y obstáculos)
const COLOR_EDGE = '#1d130b'; // borde superior: zona de derrame
const COLOR_CUP = '#ffffff'; // pocillo blanco, contraste alto (spec 9)
const COLOR_TINTO = '#4a2c17'; // el tinto adentro del pocillo
const COLOR_TARGET = '#e8c66a'; // radio PERFECTO del overlay de calibración
const COLOR_CELULAR = '#2f3542'; // celular: rect angosto oscuro
const COLOR_PORTATIL = '#57606f'; // portátil: rect ancho gris
const COLOR_AREPA = '#f0d9a8'; // arepa: círculo maíz

// Amortiguación corta del knockback de obstáculos
const KNOCK_SPRING = { damping: 16, stiffness: 380, mass: 0.6 };

export default function Game() {
  const { width, height } = useWindowDimensions();
  // Escala uniforme: 390 px de diseño = ancho real; el alto se deriva.
  const scale = width / DESIGN_WIDTH;
  const layout = useMemo(() => makeTableLayout(height / scale), [height, scale]);
  // μ calibrada para que V_MAX recorra el 95% de la mesa de ESTE dispositivo
  const mu = useMemo(() => computeMu(layout.maxTravel), [layout]);

  // Techo del área de juego (6.1.1): el target más alto debe dejar su barra
  // de paciencia debajo del HUD (score y vidas) y su radio BIEN dentro de la
  // mesa. En px de diseño.
  const insets = useSafeAreaInsets();
  const slotYMin = useMemo(
    () =>
      Math.max(
        layout.tableTopY + TARGET_GOOD_RADIUS + 8,
        (insets.top + HUD_CLEARANCE) / scale + TIMER_BAR_OFFSET_Y,
      ),
    [layout, insets.top, scale],
  );

  // Arte SVG (fase 3, vigente): mesa de fondo y los 6 personajes precargados
  // para que el reemplazo de slot no parpadee. useSVG carga async: hasta que
  // el asset llega, ese elemento no se dibuja.
  const tableSvg = useSVG(tableSprite);
  const characterSvgs = [
    useSVG(CHARACTER_SPRITES[0]),
    useSVG(CHARACTER_SPRITES[1]),
    useSVG(CHARACTER_SPRITES[2]),
    useSVG(CHARACTER_SPRITES[3]),
    useSVG(CHARACTER_SPRITES[4]),
    useSVG(CHARACTER_SPRITES[5]),
  ];

  const phase = useGameStore((s) => s.phase);

  // --- Estado del worklet (UI thread). React nunca lee esto por frame. ---
  const phaseSv = useSharedValue<number>(PHASE.IDLE);
  const cupX = useSharedValue(layout.cupStartX);
  const cupY = useSharedValue(layout.cupStartY);
  // Lanzamiento activo. El deslizamiento va por segmentos: el rebote de la
  // arepa relanza la forma cerrada desde el punto de impacto (determinista).
  const v0 = useSharedValue(0);
  const dirX = useSharedValue(0);
  const dirY = useSharedValue(-1);
  const slideT = useSharedValue(0); // segundos desde el inicio del segmento
  const segStartX = useSharedValue(layout.cupStartX); // origen del segmento actual
  const segStartY = useSharedValue(layout.cupStartY);
  const segDist = useSharedValue(0); // px ya recorridos del segmento (para muestreo)
  const wallBounces = useSharedValue(0); // carambolas de este lanzamiento (máx 2)
  // Knockback de obstáculos: offset animado por slot (máx 2 obstáculos).
  // Se suma a la posición base también en las colisiones (posición real).
  const obs0dx = useSharedValue(0);
  const obs0dy = useSharedValue(0);
  const obs1dx = useSharedValue(0);
  const obs1dy = useSharedValue(0);
  // Apuntado (vector de arrastre en px de diseño)
  const aimX = useSharedValue(0);
  const aimY = useSharedValue(0);
  const aiming = useSharedValue(0);

  // --- Slots multi-cliente (spec 6.1) ---
  // Vida y paciencia en SharedValues (el worklet las tickea por frame);
  // el personaje de cada slot en estado React (cambia solo al reemplazar).
  const slot0Alive = useSharedValue(0);
  const slot1Alive = useSharedValue(0);
  const slot2Alive = useSharedValue(0);
  const slot0Left = useSharedValue(0);
  const slot1Left = useSharedValue(0);
  const slot2Left = useSharedValue(0);
  const slot0Total = useSharedValue(1);
  const slot1Total = useSharedValue(1);
  const slot2Total = useSharedValue(1);
  const slotAlive = useMemo(
    () => [slot0Alive, slot1Alive, slot2Alive],
    [slot0Alive, slot1Alive, slot2Alive],
  );
  const slotTimeLeft = useMemo(
    () => [slot0Left, slot1Left, slot2Left],
    [slot0Left, slot1Left, slot2Left],
  );
  const slotTimeTotal = useMemo(
    () => [slot0Total, slot1Total, slot2Total],
    [slot0Total, slot1Total, slot2Total],
  );
  // Posición del target de cada slot (px de diseño), variable por spawn (6.1.1)
  const slot0X = useSharedValue(DESIGN_WIDTH / 2);
  const slot1X = useSharedValue(DESIGN_WIDTH / 2);
  const slot2X = useSharedValue(DESIGN_WIDTH / 2);
  const slot0Y = useSharedValue(200);
  const slot1Y = useSharedValue(200);
  const slot2Y = useSharedValue(200);
  const slotXs = useMemo(() => [slot0X, slot1X, slot2X], [slot0X, slot1X, slot2X]);
  const slotYs = useMemo(() => [slot0Y, slot1Y, slot2Y], [slot0Y, slot1Y, slot2Y]);
  const targetSlot = useSharedValue(0); // slot al que va el tiro en curso
  // Evaluación 1D (6.1.11): distancia recta al cliente al lanzar, y
  // recorrido acumulado a través de los segmentos (rebotes incluidos)
  const travelPlanned = useSharedValue(0);
  const travelDone = useSharedValue(0);
  const [slotCharacters, setSlotCharacters] = useState<number[]>([0, 1, 2]);
  const slotCharactersRef = useRef(slotCharacters);
  const respawnTimeouts = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Obstáculos del envío (inertes con OBSTACLES_ENABLED = false)
  const [obstacles, setObstacles] = useState<Obstacle[]>([]);
  const obstaclesSv = useSharedValue<Obstacle[]>([]);

  // --- Spawn de slot (JS thread): la aleatoriedad vive aquí, nunca en física ---
  const spawnSlot = useCallback(
    (slot: number) => {
      // Sin repetir el personaje anterior ni los sentados en otros slots
      const seated: number[] = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        if (i !== slot && slotAlive[i].value === 1) seated.push(slotCharactersRef.current[i]);
      }
      const characters = [...slotCharactersRef.current];
      characters[slot] = nextCharacterIndex(seated);
      slotCharactersRef.current = characters;
      setSlotCharacters(characters);
      // Posición dentro del carril fijo del slot (6.1.1): la lateralidad
      // solo usa la holgura del carril, garantizada por diseño
      const clientsServed = useGameStore.getState().clientsServed;
      const maxDistance = layout.cupStartY - slotYMin;
      const lane = getSlotLane(slot);
      slotXs[slot].value = lane.center + (Math.random() * 2 - 1) * lane.halfRange;
      // Profundidad (6.1.3 + 6.1.7): el rango propio multi-cliente (amplio
      // desde el primer spawn) se muestrea solo fuera de las bandas de
      // ±SLOT_MIN_DEPTH_SEPARATION de los otros slots activos — separación
      // garantizada por construcción, sin reintentos
      const yNear = layout.cupStartY - getSlotDistance(0, maxDistance);
      const yFar = layout.cupStartY - getSlotDistance(1, maxDistance);
      const takenYs: number[] = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        if (i !== slot && slotAlive[i].value === 1) takenYs.push(slotYs[i].value);
      }
      slotYs[slot].value = pickSeparatedValue(
        yFar, // y menor: el cliente más lejano
        yNear, // y mayor: el más cercano
        takenYs,
        SLOT_MIN_DEPTH_SEPARATION,
        Math.random(),
      );
      // Paciencia según clientes atendidos totales (spec 6.1)
      const patience = getPatienceDuration(clientsServed);
      slotTimeTotal[slot].value = patience;
      slotTimeLeft[slot].value = patience;
      slotAlive[slot].value = 1;
    },
    [slotAlive, slotTimeLeft, slotTimeTotal, slotXs, slotYs, layout, slotYMin],
  );

  const clearRespawnTimeouts = useCallback(() => {
    respawnTimeouts.current.forEach(clearTimeout);
    respawnTimeouts.current = [];
  }, []);

  // Reemplazo de slot con delay corto: nunca instantáneo (spec 6.1)
  const scheduleRespawn = useCallback(
    (slot: number) => {
      const handle = setTimeout(() => {
        if (useGameStore.getState().phase !== 'GAME_OVER') spawnSlot(slot);
      }, SLOT_RESPAWN_DELAY_MS);
      respawnTimeouts.current.push(handle);
    },
    [spawnSlot],
  );

  const resetCup = useCallback(() => {
    cupX.value = layout.cupStartX;
    cupY.value = layout.cupStartY;
    segStartX.value = layout.cupStartX;
    segStartY.value = layout.cupStartY;
    segDist.value = 0;
    wallBounces.value = 0;
    slideT.value = 0;
    aiming.value = 0;
  }, [layout, cupX, cupY, segStartX, segStartY, segDist, wallBounces, slideT, aiming]);

  // Arranque y REINTENTAR: pocillo a la barra y los 3 slots poblados
  const initRun = useCallback(() => {
    clearRespawnTimeouts();
    resetCup();
    // (Rama inerte: al reintegrar obstáculos habrá que recalcular su zona
    // contra las posiciones variables de los slots, no contra slotYMin)
    const nextObstacles = OBSTACLES_ENABLED
      ? makeObstacles(getObstacleCount(0), slotYMin, TARGET_GOOD_RADIUS, layout)
      : [];
    setObstacles(nextObstacles);
    obstaclesSv.value = nextObstacles;
    obs0dx.value = 0;
    obs0dy.value = 0;
    obs1dx.value = 0;
    obs1dy.value = 0;
    for (let slot = 0; slot < SLOT_COUNT; slot++) spawnSlot(slot);
  }, [
    clearRespawnTimeouts,
    resetCup,
    layout,
    slotYMin,
    obstaclesSv,
    obs0dx,
    obs0dy,
    obs1dx,
    obs1dy,
    spawnSlot,
  ]);

  useEffect(() => {
    initRun();
    return clearRespawnTimeouts;
  }, [initRun, clearRespawnTimeouts]);

  const syncPhase = useCallback((to: GamePhase) => {
    useGameStore.getState().setPhase(to);
  }, []);

  const triggerGameOver = useCallback(() => {
    const st = useGameStore.getState();
    // Idempotente: un CORTO al límite y un timer venciéndose casi a la vez
    // no deben commitear récords dos veces (borraría los flags de récord)
    if (st.phase === 'GAME_OVER') return;
    st.commitRunRecords(); // compara y persiste récords (MMKV) antes de mostrar
    st.setPhase('GAME_OVER');
    phaseSv.value = PHASE.GAME_OVER;
  }, [phaseSv]);

  // --- Paciencia agotada (6.1): el worklet ya apagó el slot; aquí se
  // descuenta el cliente perdido y se decide fin de turno o reemplazo ---
  const handleClientTimeout = useCallback(
    (slot: number) => {
      const store = useGameStore.getState();
      if (store.phase === 'GAME_OVER') return;
      store.loseClient();
      if (useGameStore.getState().lostClients >= MAX_LOST_CLIENTS) {
        triggerGameOver();
        return;
      }
      scheduleRespawn(slot);
    },
    [scheduleRespawn, triggerGameOver],
  );

  // --- Resultado del tiro (JS thread): puntúa, decide NEXT o GAME_OVER ---
  const handleResult = useCallback(
    (result: SlideResult, slot: number) => {
      const store = useGameStore.getState();
      store.setPhase('RESULT');
      store.applyResult(result);
      // Fin de turno solo por DERRAME (6.1.5): los corazones ya solo los
      // quita el timer de paciencia, que gestiona su propio game over
      if (result === 'DERRAME') {
        setTimeout(triggerGameOver, GAME_OVER_DELAY_MS);
      } else {
        // Atendido: el slot quedó vacío y entra reemplazo tras el delay.
        // CORTO/LARGO: el cliente sigue en su slot esperando el reintento.
        if (result === 'PERFECTO' || result === 'BIEN') scheduleRespawn(slot);
        setTimeout(() => {
          resetCup();
          useGameStore.getState().setPhase('IDLE');
          phaseSv.value = PHASE.IDLE;
        }, RESULT_DWELL_MS);
      }
    },
    [scheduleRespawn, resetCup, triggerGameOver, phaseSv],
  );

  // REINTENTAR: reset síncrono, sin animaciones ni cargas (< 1 s, spec 2)
  const handleRetry = useCallback(() => {
    useGameStore.getState().reset();
    initRun();
    phaseSv.value = PHASE.IDLE;
  }, [initRun, phaseSv]);

  // --- Game loop (worklet, UI thread) ---
  // 1) Timers de paciencia: corren en todo estado de juego. El slot al que
  //    va el tiro queda protegido durante SLIDING/RESULT: ese tiro decide
  //    su suerte, no el reloj (evita la doble pérdida en el mismo frame).
  // 2) Deslizamiento: integra la forma cerrada de 4.3 muestreando cada
  //    COLLISION_STEP px (sin túnel). Portátil = DERRAME; arepa y celular
  //    rebotan por punto de impacto. Sin cambios respecto a fase 2.
  useFrameCallback((frame) => {
    const ph = phaseSv.value;
    if (ph === PHASE.GAME_OVER) return;
    const dt = (frame.timeSincePreviousFrame ?? 16.7) / 1000;
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (slotAlive[i].value !== 1) continue;
      if (i === targetSlot.value && (ph === PHASE.SLIDING || ph === PHASE.RESULT)) continue;
      const left = slotTimeLeft[i].value - dt;
      slotTimeLeft[i].value = Math.max(left, 0);
      if (left <= 0) {
        slotAlive[i].value = 0; // se apaga aquí: un solo aviso a JS
        runOnJS(handleClientTimeout)(i);
      }
    }
    if (ph !== PHASE.SLIDING) return;
    slideT.value += dt;
    const total = slideDuration(v0.value, mu);
    const t = Math.min(slideT.value, total);
    const dNew = distanceAt(v0.value, mu, t);
    const dPrev = segDist.value;
    const span = dNew - dPrev;
    const steps = Math.max(1, Math.ceil(span / COLLISION_STEP));
    for (let i = 1; i <= steps; i++) {
      const d = dPrev + (span * i) / steps;
      const rawX = segStartX.value + dirX.value * d;
      // Carambola: al tocar una pared lateral se refleja el ángulo con
      // pérdida leve; el tercer toque es DERRAME por borde. El punto de
      // contacto se resuelve analítico (determinista, sin depender del dt).
      // Solo cuenta si el pocillo va HACIA la pared (dirX ≠ 0 garantizado).
      if (
        (rawX <= CUP_RADIUS && dirX.value < 0) ||
        (rawX >= DESIGN_WIDTH - CUP_RADIUS && dirX.value > 0)
      ) {
        const boundary = rawX <= CUP_RADIUS ? CUP_RADIUS : DESIGN_WIDTH - CUP_RADIUS;
        const dWall = (boundary - segStartX.value) / dirX.value;
        const yWall = segStartY.value + dirY.value * dWall;
        cupX.value = boundary;
        cupY.value = yWall;
        wallBounces.value += 1;
        if (wallBounces.value > MAX_WALL_BOUNCES) {
          phaseSv.value = PHASE.RESULT; // se cayó de la mesa: DERRAME por borde
          runOnJS(handleResult)('DERRAME', targetSlot.value);
          return;
        }
        const speedBefore = speedAtDistance(v0.value, mu, dWall);
        const inward = boundary === CUP_RADIUS ? 1 : -1;
        const sx = boundary + inward * BOUNCE_SEPARATION_EPS;
        cupX.value = sx;
        segStartX.value = sx;
        segStartY.value = yWall;
        dirX.value = -dirX.value; // reflexión del ángulo
        v0.value = speedBefore * (1 - WALL_BOUNCE_LOSS);
        travelDone.value += dWall; // recorrido del segmento cerrado (6.1.11)
        segDist.value = 0;
        slideT.value = 0;
        return; // el segmento nuevo arranca el próximo frame
      }
      // Clamp defensivo solo para render (el rebote ya maneja el cruce)
      const x = Math.min(Math.max(rawX, CUP_RADIUS), DESIGN_WIDTH - CUP_RADIUS);
      const y = segStartY.value + dirY.value * d;
      cupX.value = x;
      cupY.value = y;
      const obs = obstaclesSv.value;
      for (let j = 0; j < obs.length; j++) {
        const o = obs[j];
        // Posición real = base + knockback acumulado
        const offX = j === 0 ? obs0dx.value : obs1dx.value;
        const offY = j === 0 ? obs0dy.value : obs1dy.value;
        const ox = o.x + offX;
        const oy = o.y + offY;
        if (o.kind === 'portatil') {
          if (circleHitsRect(x, y, CUP_RADIUS, ox, oy, o.halfW, o.halfH)) {
            phaseSv.value = PHASE.RESULT; // choque con portátil = DERRAME
            runOnJS(handleResult)('DERRAME', targetSlot.value);
            return;
          }
          continue;
        }
        // Arepa y celular: rebote por punto de impacto
        let nx = 0;
        let ny = 0;
        let sepX = 0;
        let sepY = 0;
        if (o.kind === 'arepa') {
          if (!circleHitsCircle(x, y, CUP_RADIUS, ox, oy, o.halfW)) continue;
          const dx = x - ox;
          const dy = y - oy;
          const len = Math.hypot(dx, dy);
          nx = len > 0 ? dx / len : -dirX.value;
          ny = len > 0 ? dy / len : -dirY.value;
          const sep = o.halfW + CUP_RADIUS + BOUNCE_SEPARATION_EPS;
          sepX = ox + nx * sep;
          sepY = oy + ny * sep;
        } else {
          if (!circleHitsRect(x, y, CUP_RADIUS, ox, oy, o.halfW, o.halfH)) continue;
          const cp = rectClosestPoint(x, y, ox, oy, o.halfW, o.halfH);
          let dx = x - cp.x;
          let dy = y - cp.y;
          let len = Math.hypot(dx, dy);
          if (len === 0) {
            // Centro dentro del rect: normal desde el centro del obstáculo
            dx = x - ox;
            dy = y - oy;
            len = Math.hypot(dx, dy);
          }
          nx = len > 0 ? dx / len : -dirX.value;
          ny = len > 0 ? dy / len : -dirY.value;
          sepX = cp.x + nx * (CUP_RADIUS + BOUNCE_SEPARATION_EPS);
          sepY = cp.y + ny * (CUP_RADIUS + BOUNCE_SEPARATION_EPS);
        }
        const params = o.kind === 'arepa' ? AREPA_BOUNCE : CELULAR_BOUNCE;
        const speedBefore = speedAtDistance(v0.value, mu, d);
        const bounce = computeBounce(dirX.value, dirY.value, nx, ny, params);
        // Knockback del obstáculo en la dirección del impacto: mínimo
        // perceptible, proporcional a la velocidad, con tope
        const cap = o.kind === 'arepa' ? AREPA_KNOCKBACK_MAX : CELULAR_KNOCKBACK_MAX;
        const push = Math.min(
          cap,
          Math.max(KNOCKBACK_MIN, (cap * speedBefore) / KNOCKBACK_FULL_SPEED),
        );
        let kx = offX + dirX.value * push;
        let ky = offY + dirY.value * push;
        const kLen = Math.hypot(kx, ky);
        if (kLen > cap) {
          kx = (kx / kLen) * cap;
          ky = (ky / kLen) * cap;
        }
        if (j === 0) {
          obs0dx.value = withSpring(kx, KNOCK_SPRING);
          obs0dy.value = withSpring(ky, KNOCK_SPRING);
        } else {
          obs1dx.value = withSpring(kx, KNOCK_SPRING);
          obs1dy.value = withSpring(ky, KNOCK_SPRING);
        }
        // Segmento nuevo desde la posición separada (sin superposición)
        const sx = Math.min(Math.max(sepX, CUP_RADIUS), DESIGN_WIDTH - CUP_RADIUS);
        cupX.value = sx;
        cupY.value = sepY;
        segStartX.value = sx;
        segStartY.value = sepY;
        v0.value = speedBefore * bounce.speedFactor;
        dirX.value = bounce.dirX;
        dirY.value = bounce.dirY;
        travelDone.value += d; // recorrido del segmento cerrado (6.1.11)
        segDist.value = 0;
        slideT.value = 0;
        return; // el segmento nuevo arranca el próximo frame
      }
    }
    segDist.value = dNew;
    if (slideT.value >= total) {
      phaseSv.value = PHASE.RESULT;
      // Resultado en 1D (6.1.11): recorrido total vs distancia ideal recta
      const slot = targetSlot.value;
      const result = resolveDistanceResult(
        travelDone.value + dNew,
        travelPlanned.value,
        cupY.value,
        layout.tableTopY,
        CUP_RADIUS,
      );
      // Solo el cliente atendido deja la mesa (6.1.5): con CORTO/LARGO se
      // queda esperando el reintento, con su timer
      if (result === 'PERFECTO' || result === 'BIEN') slotAlive[slot].value = 0;
      runOnJS(handleResult)(result, slot);
    }
  });

  // --- Gesto único: swipe desde el pocillo hacia arriba (spec 4.2) ---
  // Input bloqueado fuera de IDLE/AIMING: la guardia es phaseSv.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .onBegin((e) => {
          if (phaseSv.value !== PHASE.IDLE) return;
          const dx = e.x / scale - cupX.value;
          const dy = e.y / scale - cupY.value;
          if (dx * dx + dy * dy > GRAB_RADIUS * GRAB_RADIUS) return;
          phaseSv.value = PHASE.AIMING;
          aiming.value = 1;
          aimX.value = 0;
          aimY.value = 0;
          runOnJS(syncPhase)('AIMING');
        })
        .onUpdate((e) => {
          if (phaseSv.value !== PHASE.AIMING) return;
          aimX.value = e.translationX / scale;
          aimY.value = e.translationY / scale;
        })
        .onEnd((e) => {
          if (phaseSv.value !== PHASE.AIMING) return;
          aiming.value = 0;
          // Se captura velocidad (px/s) y ángulo del gesto al soltar
          const launch = buildLaunch(e.velocityX / scale, e.velocityY / scale);
          if (launch === null) {
            phaseSv.value = PHASE.IDLE;
            runOnJS(syncPhase)('IDLE');
            return;
          }
          // Selección de carril por zonas angulares amplias (6.1.11): el
          // gesto grueso decide izquierda/centro/derecha; el grado exacto
          // no importa. Solo si ese carril está vacío (reemplazo en curso)
          // se cae al cliente vivo con ángulo más cercano al gesto.
          const launchAngle = Math.atan2(launch.dirX, -launch.dirY);
          let chosen =
            launchAngle < -SLOT_ANGLE_BOUNDARY_RAD
              ? 0
              : launchAngle > SLOT_ANGLE_BOUNDARY_RAD
                ? 2
                : 1;
          if (slotAlive[chosen].value !== 1) {
            chosen = -1;
            let bestDiff = Infinity;
            for (let i = 0; i < SLOT_COUNT; i++) {
              if (slotAlive[i].value !== 1) continue;
              const angleTo = Math.atan2(
                slotXs[i].value - cupX.value,
                cupY.value - slotYs[i].value,
              );
              const diff = Math.abs(angleTo - launchAngle);
              if (diff < bestDiff) {
                bestDiff = diff;
                chosen = i;
              }
            }
          }
          if (chosen === -1) {
            // Mesa momentáneamente vacía: no hay a quién tirarle
            phaseSv.value = PHASE.IDLE;
            runOnJS(syncPhase)('IDLE');
            return;
          }
          targetSlot.value = chosen;
          // Distancia ideal del tiro (6.1.11): recta del pocillo al cliente
          const plannedDx = slotXs[chosen].value - cupX.value;
          const plannedDy = slotYs[chosen].value - cupY.value;
          travelPlanned.value = Math.hypot(plannedDx, plannedDy);
          travelDone.value = 0;
          v0.value = launch.v0;
          dirX.value = launch.dirX;
          dirY.value = launch.dirY;
          slideT.value = 0;
          segStartX.value = cupX.value;
          segStartY.value = cupY.value;
          segDist.value = 0;
          wallBounces.value = 0;
          phaseSv.value = PHASE.SLIDING;
          runOnJS(syncPhase)('SLIDING');
        })
        .onFinalize(() => {
          // Gesto cancelado por el sistema mientras se apuntaba
          if (phaseSv.value !== PHASE.AIMING) return;
          aiming.value = 0;
          phaseSv.value = PHASE.IDLE;
          runOnJS(syncPhase)('IDLE');
        }),
    [
      scale,
      phaseSv,
      cupX,
      cupY,
      aimX,
      aimY,
      aiming,
      v0,
      dirX,
      dirY,
      slideT,
      segStartX,
      segStartY,
      segDist,
      wallBounces,
      slotAlive,
      slotXs,
      slotYs,
      targetSlot,
      travelPlanned,
      travelDone,
      syncPhase,
    ],
  );

  // --- Valores derivados para Skia (px de pantalla) ---
  const cupCx = useDerivedValue(() => cupX.value * scale);
  const cupCy = useDerivedValue(() => cupY.value * scale);

  // Slots: opacidad (visible solo con cliente) y ancho de la barra de paciencia
  const slot0Opacity = useDerivedValue(() => slot0Alive.value);
  const slot1Opacity = useDerivedValue(() => slot1Alive.value);
  const slot2Opacity = useDerivedValue(() => slot2Alive.value);
  const slot0TimerW = useDerivedValue(
    () => (slot0Left.value / slot0Total.value) * TIMER_BAR_WIDTH * scale,
  );
  const slot1TimerW = useDerivedValue(
    () => (slot1Left.value / slot1Total.value) * TIMER_BAR_WIDTH * scale,
  );
  const slot2TimerW = useDerivedValue(
    () => (slot2Left.value / slot2Total.value) * TIMER_BAR_WIDTH * scale,
  );
  const slotOpacities = [slot0Opacity, slot1Opacity, slot2Opacity];
  const slotTimerWidths = [slot0TimerW, slot1TimerW, slot2TimerW];

  // Cada slot se dibuja relativo al centro de su target: un solo transform
  // dinámico por slot y todo lo interno queda en coordenadas fijas
  const slot0Transform = useDerivedValue(() => [
    { translateX: slot0X.value * scale },
    { translateY: slot0Y.value * scale },
  ]);
  const slot1Transform = useDerivedValue(() => [
    { translateX: slot1X.value * scale },
    { translateY: slot1Y.value * scale },
  ]);
  const slot2Transform = useDerivedValue(() => [
    { translateX: slot2X.value * scale },
    { translateY: slot2Y.value * scale },
  ]);
  const slotTransforms = [slot0Transform, slot1Transform, slot2Transform];

  // Overlay 1D (6.1.11): rotación que alinea el eje local +y de cada slot
  // con la dirección cliente → punto de lanzamiento (la banda de distancia
  // vive a lo largo de esa línea; −y = sobrepaso)
  const slot0BandRotation = useDerivedValue(() => [
    { rotate: Math.atan2(-(layout.cupStartX - slot0X.value), layout.cupStartY - slot0Y.value) },
  ]);
  const slot1BandRotation = useDerivedValue(() => [
    { rotate: Math.atan2(-(layout.cupStartX - slot1X.value), layout.cupStartY - slot1Y.value) },
  ]);
  const slot2BandRotation = useDerivedValue(() => [
    { rotate: Math.atan2(-(layout.cupStartX - slot2X.value), layout.cupStartY - slot2Y.value) },
  ]);
  const slotBandRotations = [slot0BandRotation, slot1BandRotation, slot2BandRotation];
  // Semianchos reales de las ventanas 1D, con la misma fórmula de la
  // resolución: si cambia CUP_OVERLAP_FRACTION, el overlay sigue la verdad
  const perfectHalf = useMemo(() => effectivePerfectWindow(CUP_RADIUS), []);
  const goodHalf = CUP_RADIUS + TARGET_GOOD_RADIUS;

  // Sprite del cliente: centrado en su slot, escalado al diámetro base por
  // la escala visual de 6.1.12 (solo dibujo: colisión y targets intactos).
  // Dimensionado por el viewBox (constante), nunca por svg.width().
  const clientSpriteScale =
    (CLIENT_RADIUS * 2 * CHARACTER_SPRITE_VISUAL_SCALE * scale) / CHARACTER_SPRITE_VIEWBOX;
  const clientSpriteOffset = (CHARACTER_SPRITE_VIEWBOX * clientSpriteScale) / 2;

  // Knockback: los obstáculos se dibujan en su posición base, trasladados
  // por el offset animado de su slot
  const obs0Transform = useDerivedValue(() => [
    { translateX: obs0dx.value * scale },
    { translateY: obs0dy.value * scale },
  ]);
  const obs1Transform = useDerivedValue(() => [
    { translateX: obs1dx.value * scale },
    { translateY: obs1dy.value * scale },
  ]);

  const renderObstacle = (o: Obstacle) =>
    o.kind === 'arepa' ? (
      <Circle cx={o.x * scale} cy={o.y * scale} r={o.halfW * scale} color={COLOR_AREPA} />
    ) : (
      <Rect
        x={(o.x - o.halfW) * scale}
        y={(o.y - o.halfH) * scale}
        width={o.halfW * 2 * scale}
        height={o.halfH * 2 * scale}
        color={o.kind === 'celular' ? COLOR_CELULAR : COLOR_PORTATIL}
      />
    );

  const guideOpacity = useDerivedValue(() =>
    aiming.value === 1 && aimY.value < -AIM_DEADZONE ? 0.5 : 0,
  );
  const guideP1 = useDerivedValue(() => vec(cupX.value * scale, cupY.value * scale));
  const guideP2 = useDerivedValue(() => {
    // Mismo clamp de ángulo que el lanzamiento: la guía nunca miente
    let angle = Math.atan2(aimX.value, -aimY.value);
    if (angle > MAX_ANGLE_RAD) angle = MAX_ANGLE_RAD;
    if (angle < -MAX_ANGLE_RAD) angle = -MAX_ANGLE_RAD;
    return vec(
      (cupX.value + Math.sin(angle) * GUIDE_LENGTH) * scale,
      (cupY.value - Math.cos(angle) * GUIDE_LENGTH) * scale,
    );
  });

  return (
    <View style={styles.container}>
      <GestureDetector gesture={pan}>
        <Canvas style={styles.canvas}>
          {/* Mesa: mesa.svg a pantalla completa, escala tipo cover (spec 4.1).
              El tamaño de origen sale del viewBox (constante), y el width/height
              del ImageSVG fija el contenedor por si el SVG no trae tamaño. */}
          {tableSvg && (
            <Group
              transform={fitbox(
                'cover',
                rect(0, 0, TABLE_SPRITE_VIEWBOX_W, TABLE_SPRITE_VIEWBOX_H),
                rect(0, 0, width, height),
              )}
            >
              <ImageSVG
                svg={tableSvg}
                width={TABLE_SPRITE_VIEWBOX_W}
                height={TABLE_SPRITE_VIEWBOX_H}
              />
            </Group>
          )}
          {/* Borde superior: pasar de aquí es DERRAME */}
          <Rect x={0} y={0} width={width} height={layout.tableTopY * scale} color={COLOR_EDGE} />
          {/* Slots (6.1 + 6.1.2): cliente y barra de paciencia, relativos al
              punto de destino (fusionado con el cliente: el sprite se dibuja
              SLOT_AIM_OFFSET_Y encima del origen del grupo). Sin cuadro
              target aparte. El grupo entero se apaga con el slot vacío. */}
          {[0, 1, 2].map((i) => {
            const clientSvg = characterSvgs[slotCharacters[i]];
            return (
              <Group key={i} opacity={slotOpacities[i]} transform={slotTransforms[i]}>
                {clientSvg && (
                  <Group
                    transform={[
                      { translateX: -clientSpriteOffset },
                      { translateY: -SLOT_AIM_OFFSET_Y * scale - clientSpriteOffset },
                      { scale: clientSpriteScale },
                    ]}
                  >
                    <ImageSVG
                      svg={clientSvg}
                      width={CHARACTER_SPRITE_VIEWBOX}
                      height={CHARACTER_SPRITE_VIEWBOX}
                    />
                  </Group>
                )}
                {/* Overlay de calibración (DEBUG_TARGET_ZONES): bandas de
                    distancia 1D reales, alineadas con la trayectoria ideal.
                    BIEN blanca, PERFECTO amarilla; la línea punteada roja es
                    la frontera de DERRAME por sobrepaso (lado lejano) */}
                {DEBUG_TARGET_ZONES && (
                  <Group transform={slotBandRotations[i]}>
                    <Rect
                      x={-DEBUG_BAND_HALF_WIDTH * scale}
                      y={-goodHalf * scale}
                      width={DEBUG_BAND_HALF_WIDTH * 2 * scale}
                      height={goodHalf * 2 * scale}
                      color="#ffffff"
                      opacity={0.15}
                    />
                    <Rect
                      x={-DEBUG_BAND_HALF_WIDTH * scale}
                      y={-perfectHalf * scale}
                      width={DEBUG_BAND_HALF_WIDTH * 2 * scale}
                      height={perfectHalf * 2 * scale}
                      color={COLOR_TARGET}
                      opacity={0.3}
                    />
                    <Line
                      p1={vec(-DEBUG_BAND_HALF_WIDTH * scale, -OVERSHOOT_SPILL_DISTANCE * scale)}
                      p2={vec(DEBUG_BAND_HALF_WIDTH * scale, -OVERSHOOT_SPILL_DISTANCE * scale)}
                      color="#f26d6d"
                      strokeWidth={1.5}
                      opacity={0.8}
                    >
                      <DashPathEffect intervals={[6, 6]} />
                    </Line>
                  </Group>
                )}
                {/* Barra de paciencia (fondo + restante) */}
                <Rect
                  x={(-TIMER_BAR_WIDTH / 2) * scale}
                  y={(-TIMER_BAR_OFFSET_Y - TIMER_BAR_HEIGHT / 2) * scale}
                  width={TIMER_BAR_WIDTH * scale}
                  height={TIMER_BAR_HEIGHT * scale}
                  color="#ffffff"
                  opacity={0.2}
                />
                <Rect
                  x={(-TIMER_BAR_WIDTH / 2) * scale}
                  y={(-TIMER_BAR_OFFSET_Y - TIMER_BAR_HEIGHT / 2) * scale}
                  width={slotTimerWidths[i]}
                  height={TIMER_BAR_HEIGHT * scale}
                  color="#ffffff"
                  opacity={0.9}
                />
              </Group>
            );
          })}
          {/* Obstáculos (inertes en este greybox: OBSTACLES_ENABLED = false) */}
          {obstacles[0] && <Group transform={obs0Transform}>{renderObstacle(obstacles[0])}</Group>}
          {obstacles[1] && <Group transform={obs1Transform}>{renderObstacle(obstacles[1])}</Group>}
          {/* Guía de dirección mientras se apunta (línea punteada corta) */}
          <Line p1={guideP1} p2={guideP2} color="#ffffff" strokeWidth={3} opacity={guideOpacity}>
            <DashPathEffect intervals={[10, 10]} />
          </Line>
          {/* El pocillo protagonista */}
          <Circle cx={cupCx} cy={cupCy} r={CUP_RADIUS * scale} color={COLOR_CUP} />
          <Circle cx={cupCx} cy={cupCy} r={CUP_RADIUS * 0.72 * scale} color={COLOR_TINTO} />
        </Canvas>
      </GestureDetector>
      <Hud />
      {phase === 'GAME_OVER' && <GameOver onRetry={handleRetry} />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLOR_EDGE },
  canvas: { flex: 1 },
});
