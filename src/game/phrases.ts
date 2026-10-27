/**
 * Frases del modo racha (spec sección 5): expresiones colombianas que
 * aparecen en pantalla con cada PERFECTO mientras el combo está en x3+.
 *
 * Lista editable: agregar o quitar líneas sin tocar lógica.
 * Selección aleatoria sin repetir la frase inmediatamente anterior
 * (nextRachaPhrase). Mantenerlas cortas: viven RACHA_PHRASE_DURATION_MS
 * en pantalla, bajo el texto de resultado.
 */

// Duración de la frase en pantalla. El estado RESULT dura ~550 ms; la
// frase lo sobrevive para alcanzar a leerse (tuning: 550 + 300).
export const RACHA_PHRASE_DURATION_MS = 850;
export const RACHA_PHRASES = [
  '¡Qué nota!',
  '¡Qué berraquera!',
  '¡Qué chimba!',
  '¡Del carajo!',
  '¡Uy, qué nivel!',
  '¡Tan pro!',
  '¡Ese es!',
  '¡Sumercé sí sabe!',
  '¡Ave María!',
  '¡Con toda!',
];

// Índice de la última frase mostrada, para no repetirla de inmediato.
let lastIndex = -1;

/** Siguiente frase de racha: aleatoria, distinta a la anterior. */
export function nextRachaPhrase(): string {
  let index = Math.floor(Math.random() * RACHA_PHRASES.length);
  if (index === lastIndex) index = (index + 1) % RACHA_PHRASES.length;
  lastIndex = index;
  return RACHA_PHRASES[index];
}
