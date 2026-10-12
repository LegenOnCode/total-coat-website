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
  // No se intenta borrar fotos antiguas ni fondos del sitio.
  const results = await Promise.all(unique.filter(url => !invalid.includes(url)).map(async url => {
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
  return respond(200, { deleted: results.filter(x => x.ok).map(x => x.url), pending: results.filter(x => !x.ok).map(x => x.url), skipped: invalid });
};
