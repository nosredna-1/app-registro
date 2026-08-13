/* Registro de productos: código de barras (ZXing) + OCR (Gemini) */

const $ = (id) => document.getElementById(id);

const KEY_STORAGE = 'gemini_api_key';
const TEL_STORAGE = 'whatsapp_destino';
const GEMINI_MODEL = 'gemini-2.5-flash';

// WhatsApp por defecto. wa.me exige el número internacional completo,
// así que a los 10 dígitos colombianos se les antepone el 57.
const TEL_DEFAULT = '3203210196';
const COD_PAIS = '57';

// Campos del formulario, en el orden en que salen en el mensaje.
const CAMPOS = [
  { id: 'codigo-barras', etiqueta: 'Código de barras' },
  { id: 'codigo-factura', etiqueta: 'Código factura' },
  { id: 'nombre', etiqueta: 'Nombre' },
  { id: 'presentacion', etiqueta: 'Presentación' },
  { id: 'cantidad', etiqueta: 'Cantidad' },
  { id: 'precio-factura', etiqueta: 'Precio factura' },
  { id: 'precio-final', etiqueta: 'Precio final' }
];

/* ---------- API key ---------- */

function getApiKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}

$('btn-config').addEventListener('click', () => {
  $('config').classList.toggle('hidden');
  $('apikey').value = getApiKey();
});

$('btn-save-key').addEventListener('click', () => {
  localStorage.setItem(KEY_STORAGE, $('apikey').value.trim());
  $('config').classList.add('hidden');
  setStatus('ocr-status', 'API key guardada.', 'ok');
});

$('btn-clear-key').addEventListener('click', () => {
  localStorage.removeItem(KEY_STORAGE);
  $('apikey').value = '';
});

/* ---------- Utilidades ---------- */

function setStatus(id, msg, cls = '') {
  const el = $(id);
  el.textContent = msg;
  el.className = 'hint ' + cls;
}

/* ---------- 1. Escáner de código de barras ---------- */

let reader = null;

async function startScan() {
  if (!window.ZXing) {
    setStatus('scan-status', 'No se pudo cargar la librería de escaneo.', 'err');
    return;
  }

  reader = new ZXing.BrowserMultiFormatReader();
  $('scanner-wrap').classList.remove('hidden');
  $('btn-scan').classList.add('hidden');
  $('btn-scan-stop').classList.remove('hidden');
  setStatus('scan-status', 'Apunta la cámara al código...');

  try {
    // Sin deviceId, ZXing pide { facingMode: 'environment' }: la trasera.
    // Enumerar dispositivos no sirve en iOS, donde los labels van vacíos
    // hasta que se concede el permiso de cámara.
    await reader.decodeFromVideoDevice(null, $('video'), (result, err) => {
      if (result) {
        $('codigo-barras').value = result.getText();
        setStatus('scan-status', 'Código leído: ' + result.getText(), 'ok');
        stopScan();
        updateLinks();
      } else if (err && !(err instanceof ZXing.NotFoundException)) {
        console.debug('scan', err);
      }
    });
  } catch (e) {
    const motivo = e.name === 'NotAllowedError'
      ? 'permiso denegado. Habilítalo en los ajustes del navegador.'
      : e.name === 'NotFoundError'
        ? 'no se encontró ninguna cámara.'
        : e.message;
    setStatus('scan-status', 'No se pudo abrir la cámara: ' + motivo, 'err');
    stopScan();
  }
}

function stopScan() {
  if (reader) {
    reader.reset();
    reader = null;
  }
  $('scanner-wrap').classList.add('hidden');
  $('btn-scan').classList.remove('hidden');
  $('btn-scan-stop').classList.add('hidden');
}

$('btn-scan').addEventListener('click', startScan);
$('btn-scan-stop').addEventListener('click', () => {
  stopScan();
  setStatus('scan-status', '');
});

/* ---------- 2a. Editor de imagen (recortar / tachar) ---------- */

const lienzo = $('lienzo');
const ctx = lienzo.getContext('2d');

let imagenActual = null;   // Image con el estado ya confirmado
let historial = [];        // dataURLs previos, para deshacer
let herramienta = 'tachar';
let trazando = false;
let recorte = null;        // {x, y, w, h} en píxeles del lienzo

const MAX_LADO = 1400;     // reescalado: menos bytes por subida, menos memoria
const MAX_HISTORIAL = 8;

function cargarImagen(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    img.src = src;
  });
}

function pintarBase() {
  lienzo.width = imagenActual.width;
  lienzo.height = imagenActual.height;
  ctx.drawImage(imagenActual, 0, 0);
}

// Guarda el estado antes de una operación destructiva y lo vuelve deshacible.
function apilarHistorial() {
  historial.push(lienzo.toDataURL('image/jpeg', 0.92));
  if (historial.length > MAX_HISTORIAL) historial.shift();
  $('btn-deshacer').disabled = false;
}

// Confirma lo dibujado en el lienzo como nuevo estado base.
async function confirmarLienzo() {
  imagenActual = await cargarImagen(lienzo.toDataURL('image/jpeg', 0.92));
}

async function abrirEditor(file) {
  const original = await cargarImagen(URL.createObjectURL(file));

  // Reescala si el lado mayor pasa de MAX_LADO.
  const escala = Math.min(1, MAX_LADO / Math.max(original.width, original.height));
  const w = Math.round(original.width * escala);
  const h = Math.round(original.height * escala);

  lienzo.width = w;
  lienzo.height = h;
  ctx.drawImage(original, 0, 0, w, h);
  URL.revokeObjectURL(original.src);

  await confirmarLienzo();
  historial = [];
  recorte = null;
  $('btn-deshacer').disabled = true;
  $('btn-recorte-aplicar').classList.add('hidden');
  $('editor').classList.remove('hidden');
  setStatus('ocr-status', '');
  $('btn-analizar').textContent = 'Analizar con Gemini';
}

// Coordenadas del puntero en píxeles del lienzo, no de la pantalla.
function posicion(e) {
  const r = lienzo.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (lienzo.width / r.width),
    y: (e.clientY - r.top) * (lienzo.height / r.height)
  };
}

function dibujarMarcoRecorte() {
  pintarBase();
  if (!recorte) return;
  ctx.save();
  // Oscurece todo y devuelve el brillo solo dentro del marco.
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  ctx.clearRect(recorte.x, recorte.y, recorte.w, recorte.h);
  ctx.drawImage(imagenActual, recorte.x, recorte.y, recorte.w, recorte.h,
                recorte.x, recorte.y, recorte.w, recorte.h);
  ctx.strokeStyle = '#4c8dff';
  ctx.lineWidth = Math.max(2, lienzo.width / 300);
  ctx.strokeRect(recorte.x, recorte.y, recorte.w, recorte.h);
  ctx.restore();
}

let inicio = null;

lienzo.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  lienzo.setPointerCapture(e.pointerId);
  trazando = true;
  inicio = posicion(e);

  if (herramienta === 'tachar') {
    apilarHistorial();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = Math.max(10, lienzo.width / 45);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(inicio.x, inicio.y);
  }
});

lienzo.addEventListener('pointermove', (e) => {
  if (!trazando) return;
  e.preventDefault();
  const p = posicion(e);

  if (herramienta === 'tachar') {
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  } else {
    recorte = {
      x: Math.min(inicio.x, p.x),
      y: Math.min(inicio.y, p.y),
      w: Math.abs(p.x - inicio.x),
      h: Math.abs(p.y - inicio.y)
    };
    dibujarMarcoRecorte();
  }
});

lienzo.addEventListener('pointerup', async () => {
  if (!trazando) return;
  trazando = false;

  if (herramienta === 'tachar') {
    await confirmarLienzo();
  } else {
    // Un marco diminuto suele ser un toque accidental: se descarta.
    const util = recorte && recorte.w > 10 && recorte.h > 10;
    $('btn-recorte-aplicar').classList.toggle('hidden', !util);
    if (!util) {
      recorte = null;
      pintarBase();
    }
  }
});

function elegirHerramienta(cual) {
  herramienta = cual;
  $('tool-tachar').classList.toggle('activa', cual === 'tachar');
  $('tool-recortar').classList.toggle('activa', cual === 'recortar');
  $('editor-hint').textContent = cual === 'tachar'
    ? 'Arrastra el dedo sobre lo que quieras ocultar.'
    : 'Arrastra para marcar el área que quieres conservar.';
  recorte = null;
  $('btn-recorte-aplicar').classList.add('hidden');
  pintarBase();
}

$('tool-tachar').addEventListener('click', () => elegirHerramienta('tachar'));
$('tool-recortar').addEventListener('click', () => elegirHerramienta('recortar'));

$('btn-recorte-aplicar').addEventListener('click', async () => {
  if (!recorte) return;
  apilarHistorial();

  const { x, y, w, h } = recorte;
  lienzo.width = Math.round(w);
  lienzo.height = Math.round(h);
  ctx.drawImage(imagenActual, x, y, w, h, 0, 0, lienzo.width, lienzo.height);

  await confirmarLienzo();
  recorte = null;
  $('btn-recorte-aplicar').classList.add('hidden');
});

$('btn-deshacer').addEventListener('click', async () => {
  const previo = historial.pop();
  if (!previo) return;
  imagenActual = await cargarImagen(previo);
  pintarBase();
  recorte = null;
  $('btn-recorte-aplicar').classList.add('hidden');
  $('btn-deshacer').disabled = historial.length === 0;
});

$('photo').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';   // permite volver a elegir la misma foto
  if (!file) return;

  try {
    await abrirEditor(file);
  } catch (err) {
    setStatus('ocr-status', 'Error: ' + err.message, 'err');
  }
});

/* ---------- 2b. OCR con Gemini ---------- */

async function askGemini(base64, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(getApiKey())}`;

  const body = {
    contents: [{
      parts: [
        {
          text: 'Lee esta etiqueta, factura o empaque de producto y extrae la información:\n' +
                '- nombre: nombre comercial con marca, sin la presentación.\n' +
                '- presentacion: contenido o empaque, ej. "500 ml", "caja x12", "1 kg".\n' +
                '- cantidad: número de unidades si la imagen es una factura o lista.\n' +
                '- precio: precio como número sin símbolo de moneda ni separador de miles.\n' +
                '- codigo: código de barras o SKU si es legible.\n' +
                'Si un dato no aparece, déjalo como cadena vacía.'
        },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          nombre: { type: 'STRING' },
          presentacion: { type: 'STRING' },
          cantidad: { type: 'STRING' },
          precio: { type: 'STRING' },
          codigo: { type: 'STRING' }
        },
        required: ['nombre', 'presentacion', 'cantidad', 'precio', 'codigo']
      }
    }
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    // Fallo de red: casi siempre pasajero, vale la pena reintentar.
    const err = new Error('sin conexión con Gemini');
    err.reintentable = true;
    throw err;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `HTTP ${res.status}`);
    // 429 = cuota o exceso de peticiones; 5xx = saturación del lado de Google.
    err.reintentable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const err = new Error('respuesta vacía de Gemini');
    err.reintentable = true;
    throw err;
  }
  return JSON.parse(text);
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Reintenta con backoff exponencial solo los fallos pasajeros; un 400 o una
// key inválida fallan de una porque reintentar no los va a arreglar.
async function askGeminiConReintentos(base64, mimeType, intentos = 3) {
  for (let i = 1; ; i++) {
    try {
      setStatus('ocr-status', i === 1 ? 'Leyendo con Gemini...' : `Reintentando (${i}/${intentos})...`);
      return await askGemini(base64, mimeType);
    } catch (err) {
      if (!err.reintentable || i >= intentos) throw err;
      const pausa = 1500 * 2 ** (i - 1);
      setStatus('ocr-status', `Gemini ocupado (${err.message}). Reintento en ${pausa / 1000}s...`);
      await espera(pausa);
    }
  }
}

$('btn-analizar').addEventListener('click', async () => {
  if (!getApiKey()) {
    setStatus('ocr-status', 'Falta la API key de Gemini (botón "API key" arriba).', 'err');
    return;
  }
  if (!imagenActual) return;

  const boton = $('btn-analizar');
  boton.disabled = true;

  try {
    const base64 = lienzo.toDataURL('image/jpeg', 0.9).split(',')[1];
    const out = await askGeminiConReintentos(base64, 'image/jpeg');

    if (out.nombre) $('nombre').value = out.nombre;
    if (out.presentacion) $('presentacion').value = out.presentacion;
    if (out.cantidad) $('cantidad').value = out.cantidad;
    if (out.precio) $('precio-factura').value = out.precio;
    // El escáner manda sobre el OCR para el código de barras.
    if (out.codigo && !$('codigo-barras').value) $('codigo-barras').value = out.codigo;

    setStatus('ocr-status', 'Listo. Revisa y corrige si hace falta.', 'ok');
    boton.textContent = 'Analizar de nuevo';
    updateLinks();
  } catch (err) {
    setStatus('ocr-status', 'Error: ' + err.message + '. Puedes reintentar.', 'err');
    boton.textContent = 'Reintentar análisis';
  } finally {
    boton.disabled = false;
  }
});

/* ---------- 3. Enlaces ---------- */

// Un móvil colombiano de 10 dígitos necesita el 57 delante para wa.me.
function normalizarTel(valor) {
  const d = valor.replace(/\D/g, '');
  return d.length === 10 ? COD_PAIS + d : d;
}

function updateLinks() {
  const valores = CAMPOS.map((c) => ({ ...c, valor: $(c.id).value.trim() }));
  const llenos = valores.filter((c) => c.valor);

  const google = $('link-google');
  const wa = $('link-whatsapp');

  // Google: nombre + presentación + código de barras, lo que haya.
  const query = ['nombre', 'presentacion', 'codigo-barras']
    .map((id) => valores.find((c) => c.id === id).valor)
    .filter(Boolean)
    .join(' ');

  const urlGoogle = query
    ? 'https://www.google.com/search?q=' + encodeURIComponent(query)
    : '';

  if (urlGoogle) {
    google.href = urlGoogle;
    google.classList.remove('disabled');
  } else {
    google.removeAttribute('href');
    google.classList.add('disabled');
  }

  // WhatsApp: mensaje con todos los campos que tengan valor.
  if (llenos.length) {
    const lineas = ['*Producto registrado*', ...llenos.map((c) => `${c.etiqueta}: ${c.valor}`)];

    // El enlace va al final y en línea aparte para que WhatsApp lo detecte
    // como URL y quede pulsable desde el chat.
    if (urlGoogle) lineas.push('', 'Buscar en Google:', urlGoogle);

    const texto = encodeURIComponent(lineas.join('\n'));
    const tel = normalizarTel($('telefono').value);

    wa.href = tel
      ? `https://wa.me/${tel}?text=${texto}`
      : `https://wa.me/?text=${texto}`;
    wa.classList.remove('disabled');
  } else {
    wa.removeAttribute('href');
    wa.classList.add('disabled');
  }
}

[...CAMPOS.map((c) => c.id), 'telefono'].forEach((id) => {
  $(id).addEventListener('input', updateLinks);
});

// El destino se recuerda entre sesiones; si no hay nada, va el predefinido.
$('telefono').value = localStorage.getItem(TEL_STORAGE) || TEL_DEFAULT;
$('telefono').addEventListener('change', () => {
  localStorage.setItem(TEL_STORAGE, $('telefono').value.trim());
});

$('btn-reset').addEventListener('click', () => {
  CAMPOS.forEach((c) => ($(c.id).value = ''));
  $('editor').classList.add('hidden');
  imagenActual = null;
  historial = [];
  setStatus('ocr-status', '');
  setStatus('scan-status', '');
  updateLinks();
});

updateLinks();
