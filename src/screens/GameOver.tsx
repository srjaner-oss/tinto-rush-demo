/**
 * Overlay de game over (spec 3 y 8): score de la partida y botón REINTENTAR
 * gigante (~40% de la pantalla). El reintento es un reset síncrono: del tap
 * al nuevo intento pasa mucho menos de 1 segundo (pilar 2 del spec).
 * High score, monedas, revivir y compartir llegan en fases posteriores.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useGameStore } from '../game/stateMachine';

interface Props {
  onRetry: () => void;
}

export function GameOver({ onRetry }: Props) {
  const score = useGameStore((s) => s.score);
  const clientsServed = useGameStore((s) => s.clientsServed);
  const lastResult = useGameStore((s) => s.lastResult);
  const highScore = useGameStore((s) => s.highScore);
  const topClients = useGameStore((s) => s.topClients);
  const newHighScore = useGameStore((s) => s.newHighScore);
  const newTopClients = useGameStore((s) => s.newTopClients);

  return (
    <View style={styles.overlay}>
      <Text style={styles.title}>
        {lastResult === 'DERRAME' ? '¡SE REGÓ EL TINTO!' : 'FIN DEL TURNO'}
      </Text>
      <View style={styles.records}>
        <Text style={[styles.record, styles.recordScore, newHighScore && styles.recordNew]}>
          PUNTAJE MÁX. {highScore}
          {newHighScore ? '  ¡NUEVO!' : ''}
        </Text>
        <Text style={[styles.record, newTopClients && styles.recordNew]}>
          MÁX. CLIENTES {topClients}
          {newTopClients ? '  ¡NUEVO!' : ''}
        </Text>
      </View>
      <Text style={styles.score}>{score}</Text>
      <Text style={styles.detail}>{clientsServed} clientes atendidos</Text>
      <Pressable
        style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
        onPress={onRetry}
      >
        <Text style={styles.retryText}>REINTENTAR</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000cc',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  title: {
    color: '#f26d6d',
    fontSize: 26,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  records: {
    alignItems: 'center',
    gap: 4,
    marginBottom: 10,
  },
  record: {
    color: '#ffffff88',
    fontSize: 16,
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'],
  },
  recordScore: {
    // El puntaje máximo pesa levemente más que la línea de clientes
    fontSize: 19,
  },
  recordNew: {
    // Récord roto en esta partida: destacado en el mostaza de marca
    color: '#f6a41b',
  },
  score: {
    color: '#ffffff',
    fontSize: 72,
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'],
  },
  detail: {
    color: '#ffffffaa',
    fontSize: 16,
    marginBottom: 36,
  },
  retry: {
    // Botón dominante: ~40% del alto de la pantalla (spec 8)
    width: '100%',
    height: '40%',
    borderRadius: 24,
    backgroundColor: '#e8c66a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryPressed: {
    backgroundColor: '#d4b455',
  },
  retryText: {
    color: '#3b2a1e',
    fontSize: 40,
    fontWeight: 'bold',
  },
});
