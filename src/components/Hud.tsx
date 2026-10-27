/**
 * HUD mínimo (spec 11): score arriba al centro, pocillos de vida arriba a la
 * derecha, texto del resultado al centro durante RESULT. Nada más.
 * Solo se re-renderiza cuando cambia el store (por resultado, no por frame).
 */
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SlideResult } from '../game/engine';
import { MAX_LOST_CLIENTS } from '../game/entities';
import { RACHA_PHRASE_DURATION_MS } from '../game/phrases';
import { RACHA_THRESHOLD, comboMultiplier, useGameStore } from '../game/stateMachine';

const RACHA_COLOR = '#ff9a3d'; // borde cálido del modo racha

const RESULT_COLORS: Record<SlideResult, string> = {
  PERFECTO: '#ffd24a',
  BIEN: '#7ddb7d',
  CORTO: '#f5a25c',
  LARGO: '#e88ab5', // pasado de largo (6.1.3): distinto del CORTO naranja
  DERRAME: '#f26d6d',
};

const RESULT_LABELS: Record<SlideResult, string> = {
  PERFECTO: '¡PERFECTO!',
  BIEN: 'BIEN',
  CORTO: 'CORTO...',
  LARGO: 'TE PASASTE', // fallo por exceso (6.1.3), mismo castigo que CORTO
  DERRAME: '¡DERRAME!',
};

export function Hud() {
  const score = useGameStore((s) => s.score);
  const lostClients = useGameStore((s) => s.lostClients);
  const phase = useGameStore((s) => s.phase);
  const lastResult = useGameStore((s) => s.lastResult);
  const comboStreak = useGameStore((s) => s.comboStreak);
  const rachaPhrase = useGameStore((s) => s.rachaPhrase);
  const clearRachaPhrase = useGameStore((s) => s.clearRachaPhrase);

  // La frase vive su propio timer: sobrevive al estado RESULT para
  // alcanzar a leerse (RACHA_PHRASE_DURATION_MS, tuneable en phrases.ts)
  useEffect(() => {
    if (rachaPhrase === null) return;
    const timer = setTimeout(clearRachaPhrase, RACHA_PHRASE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [rachaPhrase, clearRachaPhrase]);

  const multiplier = comboMultiplier(comboStreak);
  const rachaActive = multiplier >= RACHA_THRESHOLD;

  // Insets reales del dispositivo (cámara/notch arriba, gestos abajo):
  // el HUD nunca queda debajo de la cámara ni pegado al borde inferior
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[styles.overlay, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      pointerEvents="none"
    >
      {rachaActive && <View style={styles.rachaBorder} />}
      <Text style={[styles.score, { top: insets.top + 8 }]}>{score}</Text>
      {comboStreak >= 2 && (
        <Text style={[styles.combo, { top: insets.top + 50 }, rachaActive && { color: RACHA_COLOR }]}>
          x{multiplier}
        </Text>
      )}
      <View style={[styles.lives, { top: insets.top + 18 }]}>
        {Array.from({ length: MAX_LOST_CLIENTS }, (_, i) => (
          <View
            key={i}
            style={[styles.life, i < MAX_LOST_CLIENTS - lostClients ? null : styles.lifeLost]}
          />
        ))}
      </View>
      {phase === 'RESULT' && lastResult !== null && (
        <View style={styles.resultWrap}>
          <Text style={[styles.result, { color: RESULT_COLORS[lastResult] }]}>
            {RESULT_LABELS[lastResult]}
          </Text>
        </View>
      )}
      {rachaPhrase !== null && (
        <View style={styles.resultWrap}>
          <Text style={styles.expression}>{rachaPhrase}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  score: {
    // top dinámico: inset superior + 8
    position: 'absolute',
    alignSelf: 'center',
    color: '#ffffff',
    fontSize: 34,
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'],
  },
  combo: {
    // Bajo el score (spec 11: HUD mínimo); top dinámico: inset + 50
    position: 'absolute',
    alignSelf: 'center',
    color: '#ffffffcc',
    fontSize: 22,
    fontWeight: 'bold',
  },
  rachaBorder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: 6,
    borderColor: RACHA_COLOR,
  },
  expression: {
    // Bajo el texto de resultado (fontSize 44), en wrapper propio para
    // quedarse quieta cuando RESULT termina y el resultado desaparece
    marginTop: 110,
    color: RACHA_COLOR,
    fontSize: 26,
    fontWeight: 'bold',
    textShadowColor: '#00000088',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 2 },
  },
  lives: {
    // top dinámico: inset superior + 18
    position: 'absolute',
    right: 16,
    flexDirection: 'row',
    gap: 8,
  },
  life: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#ffffff',
  },
  lifeLost: {
    backgroundColor: '#ffffff22',
  },
  resultWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  result: {
    fontSize: 44,
    fontWeight: 'bold',
    textShadowColor: '#00000088',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 2 },
  },
});
