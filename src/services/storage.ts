/**
 * Persistencia local con MMKV (spec sección 16).
 * Solo lecturas al arrancar y escrituras puntuales al game over;
 * nada toca el disco durante la partida.
 */
import { createMMKV } from 'react-native-mmkv';

const storage = createMMKV();

// Claves del modelo de datos local (spec 16)
const KEY_HIGH_SCORE = 'highScore';
const KEY_TOP_CLIENTS = 'topClientes'; // máximo de clientes atendidos en una partida

export function getStoredHighScore(): number {
  return storage.getNumber(KEY_HIGH_SCORE) ?? 0;
}

export function setStoredHighScore(value: number): void {
  storage.set(KEY_HIGH_SCORE, value);
}

export function getStoredTopClients(): number {
  return storage.getNumber(KEY_TOP_CLIENTS) ?? 0;
}

export function setStoredTopClients(value: number): void {
  storage.set(KEY_TOP_CLIENTS, value);
}
