/**
 * Máquina de estados explícita del juego (spec 4.5):
 *   IDLE → AIMING → SLIDING → RESULT → NEXT | GAME_OVER
 * Sin estados implícitos. NEXT no es un estado persistente: es la
 * transición RESULT → IDLE que hace el spawn del siguiente cliente.
 *
 * La fase viaja por dos canales sincronizados:
 *  - un SharedValue numérico (PHASE) que leen los worklets sin cruzar de hilo
 *  - este store de zustand, que solo consumen HUD y pantallas (spec 15.3)
 */
import { create } from 'zustand';

import {
  getStoredHighScore,
  getStoredTopClients,
  setStoredHighScore,
  setStoredTopClients,
} from '../services/storage';
import type { SlideResult } from './engine';
import { MAX_LOST_CLIENTS } from './entities';
import { nextRachaPhrase } from './phrases';

export type GamePhase = 'IDLE' | 'AIMING' | 'SLIDING' | 'RESULT' | 'GAME_OVER';

// Ids numéricos para SharedValue: los worklets comparan números, no strings.
export const PHASE = {
  IDLE: 0,
  AIMING: 1,
  SLIDING: 2,
  RESULT: 3,
  GAME_OVER: 4,
} as const;
export type PhaseId = (typeof PHASE)[keyof typeof PHASE];

// Tabla de transiciones válidas. Cualquier otra transición es un bug.
// Desde 6.1 el timer de paciencia puede acabar el turno (3er cliente
// perdido) en cualquier estado de juego: X → GAME_OVER es válido siempre.
const TRANSITIONS: Record<GamePhase, GamePhase[]> = {
  IDLE: ['AIMING', 'GAME_OVER'],
  AIMING: ['IDLE', 'SLIDING', 'GAME_OVER'], // vuelve a IDLE si el swipe es inválido (hacia abajo)
  SLIDING: ['RESULT', 'GAME_OVER'],
  RESULT: ['IDLE', 'GAME_OVER'], // RESULT → IDLE es NEXT: el pocillo vuelve a la barra
  GAME_OVER: ['IDLE'], // REINTENTAR
};

export function canTransition(from: GamePhase, to: GamePhase): boolean {
  return TRANSITIONS[from].includes(to);
}

// Puntos base por resultado (spec 4.4). Solo PERFECTO multiplica por combo.
// LARGO (6.1.3) castiga exactamente igual que CORTO; solo cambia la etiqueta.
const POINTS: Record<SlideResult, number> = {
  PERFECTO: 100,
  BIEN: 50,
  CORTO: 0,
  LARGO: 0,
  DERRAME: 0,
};

// --- Combo (spec sección 5 + 6.1.8 + 6.1.10) ---
// El nivel de combo sube en 1 con cada PERFECTO (de inmediato) y también
// por racha de BIEN: el primer ciclo de 5 BIEN seguidos sube 2 niveles de
// una vez (x1→x3, activa racha), los ciclos siguientes suben 1. Un PERFECTO
// no corta la racha de BIEN: abona 2 al contador. CORTO, LARGO o DERRAME
// revientan nivel y contador a x1/0. El multiplicador aplica al PERFECTO
// que lo genera: 1er PERFECTO x1, 2do x2... tope x5.
export const COMBO_MAX_MULTIPLIER = 5; // tope del multiplicador (x5)
export const RACHA_THRESHOLD = 3; // modo racha desde combo x3
export const GOOD_STREAK_PER_LEVEL = 5; // BIEN consecutivos por subida de nivel (6.1.8)
export const GOOD_FIRST_CYCLE_LEVELS = 2; // el primer ciclo de BIEN vale 2 niveles: x1→x3 (6.1.10)
export const PERFECT_GOOD_CREDIT = 2; // un PERFECTO abona 2 BIEN al contador (6.1.10)

/** Multiplicador vigente para el nivel de combo actual. */
export function comboMultiplier(comboStreak: number): number {
  return Math.min(Math.max(comboStreak, 1), COMBO_MAX_MULTIPLIER);
}

interface GameStore {
  phase: GamePhase;
  score: number;
  clientsServed: number; // clientes atendidos (PERFECTO o BIEN)
  lostClients: number; // clientes idos por paciencia (6.1.5); MAX_LOST_CLIENTS = fin del turno
  comboStreak: number; // nivel de combo (sube por PERFECTO o racha de BIEN); multiplicador = comboMultiplier()
  goodStreak: number; // BIEN acumulados hacia la próxima subida de nivel (6.1.8/6.1.10)
  goodLevelUps: number; // subidas por vía BIEN en la cadena actual (la 1ª vale 2 niveles, 6.1.10)
  lastResult: SlideResult | null;
  rachaPhrase: string | null; // frase a mostrar con el PERFECTO actual (solo en racha)
  // Récords persistidos (MMKV, spec 16); los flags marcan récord roto en esta partida
  highScore: number;
  topClients: number;
  newHighScore: boolean;
  newTopClients: boolean;
  setPhase: (to: GamePhase) => void;
  applyResult: (result: SlideResult) => void;
  loseClient: () => void; // paciencia agotada (spec 6.1): mismo contador que CORTO
  clearRachaPhrase: () => void; // la agenda el HUD tras RACHA_PHRASE_DURATION_MS
  commitRunRecords: () => void; // al entrar a GAME_OVER: compara y persiste récords
  reset: () => void; // REINTENTAR: debe ser instantáneo (spec: < 1 s)
}

// Estado de UNA partida. Los récords viven fuera: reset() (que hace
// set(INITIAL) con merge) no debe tocarlos.
const INITIAL = {
  phase: 'IDLE' as GamePhase,
  score: 0,
  clientsServed: 0,
  lostClients: 0,
  comboStreak: 0,
  goodStreak: 0,
  goodLevelUps: 0,
  lastResult: null,
  rachaPhrase: null,
  newHighScore: false,
  newTopClients: false,
};

export const useGameStore = create<GameStore>((set) => ({
  ...INITIAL,
  highScore: getStoredHighScore(),
  topClients: getStoredTopClients(),
  setPhase: (to) =>
    set((s) => {
      if (!canTransition(s.phase, to)) {
        console.warn(`Transición de estado inválida: ${s.phase} → ${to}`);
        return s;
      }
      return { phase: to };
    }),
  applyResult: (result) =>
    set((s) => {
      // Nivel de combo (spec 5 + 6.1.10): PERFECTO sube 1 de inmediato y
      // abona 2 BIEN al contador (no lo corta); BIEN suma 1. Al llegar a
      // GOOD_STREAK_PER_LEVEL, el primer ciclo de la cadena sube 2 niveles
      // (x1→x3) y los siguientes 1; el contador vuelve a 0. Cualquier fallo
      // revienta nivel, contador y ciclos. Desde 6.1.5 fallar el tiro NO
      // cuesta corazón: los clientes solo se pierden por paciencia
      // (loseClient) o por DERRAME.
      let comboStreak = s.comboStreak;
      let goodStreak = s.goodStreak;
      let goodLevelUps = s.goodLevelUps;
      if (result === 'PERFECTO' || result === 'BIEN') {
        if (result === 'PERFECTO') {
          comboStreak += 1;
          goodStreak += PERFECT_GOOD_CREDIT;
        } else {
          goodStreak += 1;
        }
        if (goodStreak >= GOOD_STREAK_PER_LEVEL) {
          comboStreak += goodLevelUps === 0 ? GOOD_FIRST_CYCLE_LEVELS : 1;
          goodLevelUps += 1;
          goodStreak = 0;
        }
      } else {
        comboStreak = 0;
        goodStreak = 0;
        goodLevelUps = 0;
      }
      const points =
        result === 'PERFECTO'
          ? POINTS.PERFECTO * comboMultiplier(comboStreak)
          : POINTS[result];
      // La frase se elige aquí (una vez por resultado), nunca en el render
      const rachaPhrase =
        result === 'PERFECTO' && comboMultiplier(comboStreak) >= RACHA_THRESHOLD
          ? nextRachaPhrase()
          : null;
      return {
        lastResult: result,
        comboStreak,
        goodStreak,
        goodLevelUps,
        rachaPhrase,
        score: s.score + points,
        clientsServed:
          result === 'PERFECTO' || result === 'BIEN'
            ? s.clientsServed + 1
            : s.clientsServed,
      };
    }),
  // El cliente se va por timer (6.1): suma al contador de perdidos. No toca
  // el combo: la racha es de PERFECTOs del jugador, no de clientes que se van.
  loseClient: () =>
    set((s) => ({
      lostClients: Math.min(s.lostClients + 1, MAX_LOST_CLIENTS),
    })),
  clearRachaPhrase: () => set({ rachaPhrase: null }),
  commitRunRecords: () =>
    set((s) => {
      const newHighScore = s.score > s.highScore;
      const newTopClients = s.clientsServed > s.topClients;
      if (newHighScore) setStoredHighScore(s.score);
      if (newTopClients) setStoredTopClients(s.clientsServed);
      return {
        newHighScore,
        newTopClients,
        highScore: newHighScore ? s.score : s.highScore,
        topClients: newTopClients ? s.clientsServed : s.topClients,
      };
    }),
  reset: () => set(INITIAL),
}));
