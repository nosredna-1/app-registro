# Registro de productos

Webapp estática (sin build, sin backend) para registrar productos rápido desde el móvil:

1. **Código de barras** — escaneo con la cámara usando [ZXing](https://github.com/zxing-js/library) (EAN, UPC, Code128, QR…).
2. **OCR** — foto de la etiqueta que se edita antes de salir del dispositivo (recortar y tachar
   con el dedo sobre un `<canvas>`) y solo se envía a la **Gemini API** (`gemini-2.5-flash`) al
   pulsar *Analizar*. Devuelve nombre, presentación, cantidad, precio y código en JSON.
3. **Datos** — código de barras, código factura, nombre, presentación, cantidad, precio factura
   y precio final (todos editables a mano).
4. **Acciones** — enlace de búsqueda en Google y enlace de WhatsApp con todos los campos.

La imagen se reescala a 1400 px de lado mayor antes de subirla. Los fallos pasajeros de Gemini
(429 por cuota, 5xx por saturación, caídas de red) se reintentan solos hasta 3 veces con backoff
exponencial (1.5 s, 3 s); los demás fallan de una y dejan el botón listo para reintentar a mano.

## Uso

```bash
python3 -m http.server 8000
```

Abre `http://localhost:8000`.

La cámara necesita **HTTPS o localhost**; si lo publicas, usa un host con TLS (GitHub Pages, Netlify, Vercel…).

## API key

Pulsa **API key** en la cabecera y pega tu clave de [Google AI Studio](https://aistudio.google.com/apikey). Se guarda en `localStorage` del navegador.

⚠️ La clave viaja desde el navegador del usuario, así que es visible para quien use la app. Está bien para uso personal o interno; para algo público, mueve la llamada a Gemini a un backend propio.

## Archivos

- `index.html` — estructura
- `styles.css` — estilos (claro/oscuro automático)
- `app.js` — escáner, llamada a Gemini y generación de enlaces
