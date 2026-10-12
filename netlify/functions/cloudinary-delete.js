const { createHash } = require('node:crypto');
const { authorize, respond } = require('../lib/authorize');

// Se permiten exclusivamente los public_id únicos creados por el flujo firmado de esta web.
function publicId(value, cloudName) {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== 'res.cloudinary.com' || u.username || u.password || u.search || u.hash) return null;
    const prefix = `/${cloudName}/image/upload/`;
    if (!u.pathname.startsWith(prefix)) return null;
    const path = u.pathname.slice(prefix.length).replace(/^v\d+\//, '');
    const match = /^(total-coat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:jpg|jpeg|png|webp)$/i.exec(path);
    return match ? match[1] : null;
  } catch { return null; }
}

// Una referencia puede incluir transformaciones, otra versión o parámetros de URL.
// Estas variantes protegen el activo, pero nunca amplían las URLs admitidas para borrar.
function referencedId(value, cloudName) {
  if (typeof value !== 'string') throw new Error('Referencia de imagen inválida.');
  try {
    const u = new URL(value);
    if (u.hostname !== 'res.cloudinary.com' || !u.pathname.startsWith(`/${cloudName}/image/upload/`)) return null;
    const path = decodeURIComponent(u.pathname);
    return /\/(total-coat\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[^/]+$/i.exec(path)?.[1] || null;
  } catch { return null; }
}

async function usedImages(event, cloudName) {
  // authorize() ya verificó este token y el UID. REST respeta las reglas de Firestore;
  // firebase-admin/firestore requeriría credenciales de servicio y omitiría esas reglas.
  const authorization = event.headers?.authorization || event.headers?.Authorization;
  const project = encodeURIComponent(process.env.FIREBASE_PROJECT_ID);
  const used = new Set();
  const seenTokens = new Set();
  const signal = AbortSignal.timeout(8000); // Presupuesto para el recorrido completo.
  let pageToken = '';
  do {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/trabajos`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.append('mask.fieldPaths', 'imagenes');
    url.searchParams.append('mask.fieldPaths', 'imagenUrl');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.href, {
      method: 'GET', headers: { Authorization: authorization }, signal, redirect: 'error'
    });
    if (!res.ok) throw new Error('No se pudo consultar Firestore.');
    const page = await res.json();
    if (!page || typeof page !== 'object' || Array.isArray(page) || 'error' in page
      || Object.keys(page).some(key => !['documents', 'nextPageToken'].includes(key))
      || ('documents' in page && !Array.isArray(page.documents))
      || ('nextPageToken' in page && typeof page.nextPageToken !== 'string')) throw new Error('Respuesta de Firestore inválida.');
    // REST puede omitir documents para una página vacía. Eso no termina el recorrido
    // si existe nextPageToken. No se devuelve un resultado parcial ante errores.
    for (const document of page.documents || []) {
      if (!document || typeof document.name !== 'string') throw new Error('Documento inválido.');
      const fields = document.fields || {};
      const values = [];
      if (fields.imagenes) {
        if (!fields.imagenes.arrayValue) throw new Error('Lista de imágenes inválida.');
        const images = fields.imagenes.arrayValue.values || [];
        if (!Array.isArray(images)) throw new Error('Lista de imágenes inválida.');
        values.push(...images);
      }
      if (fields.imagenUrl) values.push(fields.imagenUrl);
      for (const value of values) {
        const id = referencedId(value?.stringValue, cloudName);
        if (id) used.add(id);
      }
    }
    pageToken = page.nextPageToken || '';
    if (pageToken && seenTokens.has(pageToken)) throw new Error('Paginación repetida.');
    if (pageToken) seenTokens.add(pageToken);
  } while (pageToken);
  return used;
}
exports.handler = async event => {
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Método no permitido.' });
  const rejected = await authorize(event);
  if (rejected) return rejected;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const key = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !key || !secret) return respond(503, { error: 'Falta configurar Cloudinary en Netlify.' });
  if (!event.body || event.body.length > 15000) return respond(400, { error: 'Solicitud no válida.' });
  let urls;
  try { urls = JSON.parse(event.body).urls; } catch { return respond(400, { error: 'Solicitud no válida.' }); }
  if (!Array.isArray(urls) || !urls.length || urls.length > 10 || urls.some(url => typeof url !== 'string')) return respond(400, { error: 'Seleccioná entre 1 y 10 fotos.' });
  const unique = [...new Set(urls)];
  const invalid = unique.filter(url => !publicId(url, cloudName));
  const valid = unique.filter(url => !invalid.includes(url));
  if (!valid.length) return respond(200, { deleted: [], pending: [], skipped: invalid });
  let used;
  try { used = await usedImages(event, cloudName); }
  catch {
    // No llamar a Cloudinary si permisos, red, timeout o datos impiden verificar referencias.
    return respond(503, { error: 'No se pudo comprobar el uso de las fotos en Firestore. Reintentá la limpieza.', deleted: [], pending: valid, skipped: invalid });
  }
  const referenced = valid.filter(url => used.has(publicId(url, cloudName)));
  // La lectura no bloquea escrituras posteriores. No hay transacción entre ambos servicios.
  // No se intenta borrar fotos antiguas ni fondos del sitio.
  const results = await Promise.all(valid.filter(url => !referenced.includes(url)).map(async url => {
    const params = { invalidate: 'true', public_id: publicId(url, cloudName), timestamp: String(Math.floor(Date.now() / 1000)) };
    const serialized = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const signature = createHash('sha256').update(serialized + secret).digest('hex');
    try {
      const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/destroy`, {
        method: 'POST', body: new URLSearchParams({ ...params, api_key: key, signature }), signal: AbortSignal.timeout(8000)
      });
      const data = await res.json();
      return { url, ok: res.ok && ['ok', 'not found'].includes(data.result) };
    } catch { return { url, ok: false }; }
  }));
  // Mantener las referenciadas pendientes, sin confundirlas con fotos antiguas omitidas.
  return respond(200, { deleted: results.filter(x => x.ok).map(x => x.url), pending: [...referenced, ...results.filter(x => !x.ok).map(x => x.url)], skipped: invalid });
};
