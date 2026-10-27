// Genera los sprites vectoriales de fase 3 con la API de Recraft.
// Uso: node scripts/generate-sprites.mjs
// Requiere RECRAFT_API_KEY en .env (raíz). No tiene dependencias: Node 18+ con fetch nativo.
//
// Flujo:
//   1. Crea (o reutiliza de style-id.json) un estilo custom a partir de
//      reference/pocillo-referencia.png con base vector_illustration.
//   2. Genera 11 SVG con ese style_id y los guarda en _review/.
//   3. Reporta créditos consumidos y balance restante (/users/me).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPRITES_DIR = join(ROOT, 'src', 'assets', 'sprites');
const REFERENCE_PNG = join(SPRITES_DIR, 'reference', 'pocillo-referencia.png');
const STYLE_ID_FILE = join(SPRITES_DIR, 'style-id.json');
const REVIEW_DIR = join(SPRITES_DIR, '_review');

const API_BASE = 'https://external.api.recraft.ai/v1';
// Los estilos custom no están soportados en modelos V4: usar V3.
const MODEL = 'recraftv3';
const SIZE_SQUARE = '1024x1024'; // objetos y personajes
const SIZE_PORTRAIT = '1024x1820'; // mesa: fondo vertical a pantalla completa

const SPRITES = [
  {
    file: 'mancha-derrame.svg',
    size: SIZE_SQUARE,
    prompt:
      'Coffee stain spilled on a surface, splash droplets around it, dark brown liquid, flat vector cartoon style, bold black outline, transparent background, single object, no text',
  },
  {
    file: 'mesa.svg',
    size: SIZE_PORTRAIT,
    prompt:
      'Dark wood office desk surface viewed from directly above, warm dark brown tones, subtle vertical wood plank lines, flat vector cartoon style, full frame background, portrait orientation, no objects, no text',
  },
  {
    file: 'obstaculo-celular.svg',
    size: SIZE_SQUARE,
    prompt:
      'Smartphone lying flat, viewed from directly above, dark screen with subtle highlight, flat vector cartoon style, bold black outline, transparent background, single object, no text',
  },
  {
    file: 'obstaculo-portatil.svg',
    size: SIZE_SQUARE,
    prompt:
      'Open laptop viewed from directly above, keyboard and screen visible from top, flat vector cartoon style, bold black outline, transparent background, single object, no text',
  },
  {
    file: 'obstaculo-arepa.svg',
    size: SIZE_SQUARE,
    prompt:
      'Colombian arepa on a small round plate, viewed from directly above, golden corn cake, flat vector cartoon style, bold black outline, transparent background, single object, no text',
  },
  {
    file: 'personaje-contabilidad.svg',
    size: SIZE_SQUARE,
    prompt:
      'Middle-aged office woman seen from directly above (top-down view), seated, reading glasses, cardigan, cartoon character, flat vector style, bold black outline, transparent background, single character, no text',
  },
  {
    file: 'personaje-ingeniero.svg',
    size: SIZE_SQUARE,
    prompt:
      'Office man seen from directly above (top-down view), seated, wearing company pullover hoodie, cartoon character, flat vector style, bold black outline, transparent background, single character, no text',
  },
  {
    file: 'personaje-jefe.svg',
    size: SIZE_SQUARE,
    prompt:
      'Office boss man seen from directly above (top-down view), seated, formal shirt and necktie, cartoon character, flat vector style, bold black outline, transparent background, single character, no text',
  },
  {
    file: 'personaje-ventas.svg',
    size: SIZE_SQUARE,
    prompt:
      'Office man seen from directly above (top-down view), seated, hipster with beard and glasses, cartoon character, flat vector style, bold black outline, transparent background, single character, no text',
  },
  {
    file: 'personaje-practicante.svg',
    size: SIZE_SQUARE,
    prompt:
      'Young office woman seen from directly above (top-down view), seated, casual outfit, cartoon character, flat vector style, bold black outline, transparent background, single character, no text',
  },
  {
    file: 'personaje-rrhh.svg',
    size: SIZE_SQUARE,
    prompt:
      'Office woman seen from directly above (top-down view), seated, wearing lanyard with ID badge, holding water tumbler, cartoon character, flat vector style, bold black outline, transparent background, single character, no text',
  },
];

function loadApiKey() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) {
    throw new Error('.env no existe en la raíz del proyecto');
  }
  const match = readFileSync(envPath, 'utf8').match(/^RECRAFT_API_KEY=(.+)$/m);
  const key = match?.[1].trim();
  if (!key || key === 'PEGAR_AQUI') {
    throw new Error('RECRAFT_API_KEY no está definida en .env');
  }
  return key;
}

const API_KEY = loadApiKey();

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${API_KEY}`, ...options.headers },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> HTTP ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function getBalance() {
  try {
    const me = await api('/users/me');
    return me.credits;
  } catch (err) {
    console.warn(`No se pudo consultar el balance: ${err.message}`);
    return null;
  }
}

async function getOrCreateStyleId() {
  if (existsSync(STYLE_ID_FILE)) {
    try {
      const saved = JSON.parse(readFileSync(STYLE_ID_FILE, 'utf8'));
      if (typeof saved.style_id === 'string' && saved.style_id.length > 0) {
        console.log(`Reutilizando estilo existente: ${saved.style_id}`);
        return saved.style_id;
      }
    } catch {
      console.warn('style-id.json ilegible, se creará un estilo nuevo');
    }
  }

  if (!existsSync(REFERENCE_PNG)) {
    throw new Error(`No existe la imagen de referencia: ${REFERENCE_PNG}`);
  }

  console.log('Creando estilo custom a partir de pocillo-referencia.png...');
  const form = new FormData();
  form.append('style', 'vector_illustration');
  form.append(
    'file1',
    new Blob([readFileSync(REFERENCE_PNG)], { type: 'image/png' }),
    'pocillo-referencia.png'
  );
  const created = await api('/styles', { method: 'POST', body: form });
  if (!created.id) {
    throw new Error(`Create style no devolvió id: ${JSON.stringify(created)}`);
  }

  writeFileSync(
    STYLE_ID_FILE,
    JSON.stringify(
      {
        style_id: created.id,
        base_style: 'vector_illustration',
        reference: 'reference/pocillo-referencia.png',
        creation_time: created.creation_time ?? null,
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Estilo creado y guardado en style-id.json: ${created.id}`);
  return created.id;
}

async function generateSprite(styleId, { file, prompt, size }) {
  const body = {
    prompt,
    style_id: styleId,
    model: MODEL,
    size,
    n: 1,
    response_format: 'url',
  };
  const result = await api('/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const url = result.data?.[0]?.url;
  if (!url) {
    throw new Error(`Respuesta sin URL de imagen: ${JSON.stringify(result)}`);
  }

  const download = await fetch(url);
  if (!download.ok) {
    throw new Error(`Descarga fallida (HTTP ${download.status}) desde ${url}`);
  }
  const buffer = Buffer.from(await download.arrayBuffer());

  const looksLikeSvg = buffer.subarray(0, 200).toString('utf8').trimStart().startsWith('<');
  if (!looksLikeSvg) {
    // La API devolvió raster: se guarda igual para inspección, pero se marca.
    const fallback = file.replace(/\.svg$/, '.png');
    writeFileSync(join(REVIEW_DIR, fallback), buffer);
    throw new Error(`El resultado no es SVG; guardado como ${fallback} para inspección`);
  }

  writeFileSync(join(REVIEW_DIR, file), buffer);
}

async function main() {
  mkdirSync(REVIEW_DIR, { recursive: true });

  const balanceBefore = await getBalance();
  if (balanceBefore !== null) console.log(`Balance inicial: ${balanceBefore} unidades`);

  // Si el create style falla, se aborta: sin estilo no tiene sentido generar.
  const styleId = await getOrCreateStyleId();

  const ok = [];
  const failed = [];
  for (const sprite of SPRITES) {
    process.stdout.write(`Generando ${sprite.file}... `);
    try {
      await generateSprite(styleId, sprite);
      console.log('OK');
      ok.push(sprite.file);
    } catch (err) {
      console.log('FALLÓ');
      console.error(`  ${err.message}`);
      failed.push({ file: sprite.file, error: err.message });
    }
  }

  const balanceAfter = await getBalance();

  console.log('\n===== RESUMEN =====');
  console.log(`Generados (${ok.length}/${SPRITES.length}):`);
  for (const f of ok) console.log(`  src/assets/sprites/_review/${f}`);
  if (failed.length > 0) {
    console.log(`Fallidos (${failed.length}):`);
    for (const f of failed) console.log(`  ${f.file}: ${f.error}`);
  }
  if (balanceBefore !== null && balanceAfter !== null) {
    console.log(`Unidades consumidas: ${balanceBefore - balanceAfter}`);
    console.log(`Balance restante: ${balanceAfter} unidades`);
  }

  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(`\nERROR FATAL: ${err.message}`);
  process.exit(1);
});
