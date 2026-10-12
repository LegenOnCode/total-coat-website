const { createHash, randomUUID } = require('node:crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const respond = (statusCode, payload) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  body: JSON.stringify(payload)
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { ...respond(405, { error: 'Método no permitido.' }), headers: { ...respond(405, {}).headers, Allow: 'POST' } };
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  const bearer = /^Bearer ([A-Za-z0-9._-]+)$/.exec(header);
  if (!bearer || bearer[1].length > 16384) return respond(401, { error: 'Iniciá sesión para subir fotos.' });

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const admins = (process.env.ADMIN_UIDS || '').split(',').map(uid => uid.trim()).filter(Boolean);
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!projectId || !admins.length || !cloudName || !apiKey || !apiSecret || !preset) {
    return respond(503, { error: 'Falta configurar las subidas en Netlify.' });
  }

  let decoded;
  try {
    // El SDK verifica firma, vencimiento, emisor y proyecto del token de Firebase.
    // La verificación estándar usa certificados públicos; no se requiere una clave privada de Firebase.
    const app = getApps().find(app => app.name === 'total-coat-upload')
      || initializeApp({ projectId }, 'total-coat-upload');
    decoded = await getAuth(app).verifyIdToken(bearer[1]);
  } catch (error) {
    // No imprimir el token ni las credenciales en los registros.
    if (error.code === 'auth/internal-error') return respond(503, { error: 'No se pudo comprobar la sesión. Intentá de nuevo.' });
    return respond(401, { error: 'La sesión no es válida. Volvé a iniciar sesión.' });
  }
  if (!admins.includes(decoded.uid)) return respond(403, { error: 'Tu cuenta no tiene permiso para subir fotos.' });

  // Solo se firman parámetros definidos por el servidor, nunca parámetros enviados por el cliente.
  // Un ID diferente para cada imagen evita reemplazar archivos anteriores.
  const params = {
    overwrite: 'false',
    public_id: `total-coat/${randomUUID()}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    upload_preset: preset
  };
  const serialized = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  const signature = createHash('sha256').update(serialized + apiSecret).digest('hex');
  return respond(200, { cloudName, apiKey, params, signature });
};
