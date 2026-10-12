const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const first = 'https://res.cloudinary.com/test-cloud/image/upload/v123/total-coat/11111111-1111-4111-8111-111111111111.jpg';
const second = first.replaceAll('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
const document = fields => ({ name: 'projects/test-project/databases/(default)/documents/trabajos/example', fields });
const string = stringValue => ({ stringValue });

// Cargar el código real en un contexto aislado. No leer variables reales, instalar
// dependencias ni contactar servicios. Solo Firebase y fetch se simulan.
function setup({ uid = 'admin-test', authError, rows = [], pages, firestoreStatus = 200, firestoreError, invalidJson = false, destroyResult = 'ok' } = {}) {
  const calls = [];
  const verified = [];
  let pageIndex = 0;
  const cache = new Map();
  const env = {
    FIREBASE_PROJECT_ID: 'test-project', ADMIN_UIDS: 'admin-test',
    CLOUDINARY_CLOUD_NAME: 'test-cloud', CLOUDINARY_API_KEY: 'test-key', CLOUDINARY_API_SECRET: 'test-secret'
  };
  const firebase = {
    'firebase-admin/app': { getApps: () => [], initializeApp: () => ({}) },
    'firebase-admin/auth': { getAuth: () => ({ verifyIdToken: async token => {
      verified.push(token);
      if (authError) throw authError;
      return { uid };
    } }) }
  };
  async function fetch(url, options) {
    calls.push({ url, options });
    if (url.startsWith('https://firestore.googleapis.com/')) {
      const page = pages ? pages[pageIndex++] : { body: { documents: rows }, status: firestoreStatus, error: firestoreError, invalidJson };
      assert.ok(page, 'No se esperaba otra consulta a Firestore');
      if (page.error) throw page.error;
      return { ok: (page.status ?? 200) === 200, json: async () => {
        if (page.invalidJson) throw new SyntaxError('Invalid JSON');
        return page.body;
      } };
    }
    assert.match(url, /^https:\/\/api\.cloudinary\.com\/v1_1\/test-cloud\/image\/destroy$/);
    return { ok: true, json: async () => ({ result: destroyResult }) };
  }
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const module = { exports: {} };
    cache.set(filename, module.exports);
    const localRequire = name => {
      if (firebase[name]) return firebase[name];
      if (name.startsWith('node:')) return require(name);
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), `${name}.js`));
      throw new Error(`Unexpected dependency: ${name}`);
    };
    const context = vm.createContext({ module, exports: module.exports, require: localRequire, process: { env }, fetch, URL, URLSearchParams, AbortSignal });
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return module.exports;
  }
  const { handler } = load(path.join(root, 'netlify/functions/cloudinary-delete.js'));
  const event = { httpMethod: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ urls: [first] }) };
  return { calls, verified, event, run: async (input = event) => {
    const response = await handler(input);
    return { status: response.statusCode, body: JSON.parse(response.body) };
  } };
}

test('rechaza sesión ausente, token inválido y UID no autorizado antes de consultar servicios', async () => {
  for (const scenario of [
    { headers: {}, status: 401 },
    { authError: { code: 'auth/argument-error' }, status: 401 },
    { uid: 'other-user', status: 403 }
  ]) {
    const fixture = setup(scenario);
    if (scenario.headers) fixture.event.headers = scenario.headers;
    assert.equal((await fixture.run()).status, scenario.status);
    assert.equal(fixture.calls.length, 0);
  }
});

test('conserva referencias actuales, antiguas y variantes del mismo activo', async () => {
  const transformed = first.replace('/v123/', '/c_fill,w_300/v456/').replace('.jpg', '.webp?download=1');
  for (const fields of [
    { imagenes: { arrayValue: { values: [string(first)] } } },
    { imagenUrl: string(first) },
    { imagenes: { arrayValue: { values: [string(transformed)] } } },
    { imagenes: { arrayValue: {} }, imagenUrl: string(first) }
  ]) {
    const fixture = setup({ rows: [document({}), document(fields)] });
    const response = await fixture.run();
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { deleted: [], pending: [first], skipped: [] });
    assert.equal(fixture.calls.length, 1);
  }
});

test('consulta toda la colección con el token verificado y borra solo activos no referenciados', async () => {
  const fixture = setup({ rows: [document({ imagenUrl: string(first) })] });
  fixture.event.headers = { Authorization: 'Bearer test-token' };
  fixture.event.body = JSON.stringify({ urls: [first, second, second] });
  const response = await fixture.run();
  assert.deepEqual(fixture.verified, ['test-token']);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { deleted: [second], pending: [first], skipped: [] });
  const [query, destroy] = fixture.calls;
  const queryUrl = new URL(query.url);
  assert.equal(queryUrl.pathname, '/v1/projects/test-project/databases/(default)/documents/trabajos');
  assert.equal(queryUrl.searchParams.get('pageSize'), '100');
  assert.deepEqual(queryUrl.searchParams.getAll('mask.fieldPaths'), ['imagenes', 'imagenUrl']);
  assert.equal(queryUrl.searchParams.has('pageToken'), false);
  assert.equal(query.options.method, 'GET');
  assert.equal(query.options.headers.Authorization, 'Bearer test-token');
  assert.equal(query.options.redirect, 'error');
  assert.ok(query.options.signal instanceof AbortSignal);
  assert.equal(query.options.body, undefined);
  const params = destroy.options.body;
  assert.equal(params.get('public_id'), 'total-coat/22222222-2222-4222-8222-222222222222');
  assert.equal(params.get('invalidate'), 'true');
  const serialized = `invalidate=true&public_id=${params.get('public_id')}&timestamp=${params.get('timestamp')}`;
  assert.equal(params.get('signature'), require('node:crypto').createHash('sha256').update(serialized + 'test-secret').digest('hex'));
});

test('no borra si Firestore rechaza, falla, expira o devuelve datos inválidos', async () => {
  for (const scenario of [
    { firestoreStatus: 403 }, { firestoreStatus: 503 },
    { firestoreError: new Error('network') },
    { firestoreError: new DOMException('timeout', 'TimeoutError') },
    { invalidJson: true }, { rows: null }, { rows: {} },
    { pages: [{ body: { error: { status: 'PERMISSION_DENIED' } } }] },
    { pages: [{ body: null }] }, { pages: [{ body: [] }] },
    { pages: [{ body: { nextPageToken: 123 } }] },
    { rows: [document({ imagenes: { stringValue: first } })] },
    { rows: [document({ imagenes: { arrayValue: { values: [{ integerValue: '1' }] } } })] },
    { rows: [document({ imagenUrl: { nullValue: null } })] }
  ]) {
    const fixture = setup(scenario);
    const response = await fixture.run();
    assert.equal(response.status, 503);
    assert.deepEqual(response.body.deleted, []);
    assert.deepEqual(response.body.pending, [first]);
    assert.equal(fixture.calls.length, 1);
  }
});

test('mantiene restricción de URLs y no consulta servicios para imágenes antiguas', async () => {
  const fixture = setup();
  const urls = [first.replace('test-cloud', 'other-cloud'), first.replace('https:', 'http:'), first + '?x=1', first.replace('/total-coat/', '/backgrounds/'), first.replace('/v123/', '/c_fill/v123/')];
  fixture.event.body = JSON.stringify({ urls });
  assert.deepEqual((await fixture.run()).body, { deleted: [], pending: [], skipped: urls });
  assert.equal(fixture.calls.length, 0);
});

test('conserva una imagen referenciada únicamente en la segunda página', async () => {
  const token = 'next+/=&token';
  const fixture = setup({ pages: [
    { body: { documents: [document({})], nextPageToken: token } },
    { body: { documents: [document({ imagenes: { arrayValue: { values: [string(first)] } } })] } }
  ] });
  const response = await fixture.run();
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { deleted: [], pending: [first], skipped: [] });
  assert.equal(fixture.calls.length, 2); // Solo Firestore, nunca Cloudinary.
  const [firstPage, secondPage] = fixture.calls;
  const url = new URL(secondPage.url);
  assert.equal(url.searchParams.get('pageToken'), token);
  assert.deepEqual(url.searchParams.getAll('mask.fieldPaths'), ['imagenes', 'imagenUrl']);
  assert.equal(url.searchParams.get('pageSize'), '100');
  assert.equal(secondPage.options.headers.Authorization, 'Bearer test-token');
  assert.equal(secondPage.options.signal, firstPage.options.signal);
});

test('no borra ninguna imagen si falla una página posterior, aunque las anteriores estén vacías', async () => {
  for (const failure of [
    { status: 403, body: {} }, { status: 503, body: { documents: [] } },
    { error: new Error('network') },
    { error: new DOMException('timeout', 'TimeoutError') },
    { invalidJson: true },
    { body: { error: { status: 'PERMISSION_DENIED' }, documents: [] } },
    { body: null }, { body: [] }, { body: { documents: null } },
    { body: { nextPageToken: 123 } },
    { body: { documents: [], nextPageToken: 'second-page' } }
  ]) {
    const fixture = setup({ pages: [
      { body: { documents: [], nextPageToken: 'second-page' } }, failure
    ] });
    fixture.event.body = JSON.stringify({ urls: [first, second] });
    const response = await fixture.run();
    assert.equal(response.status, 503);
    assert.deepEqual(response.body.deleted, []);
    assert.deepEqual(response.body.pending, [first, second]);
    assert.equal(fixture.calls.length, 2);
    assert.ok(fixture.calls.every(call => call.url.startsWith('https://firestore.googleapis.com/')));
  }
});

test('recorre páginas vacías con token y solo borra después de terminar todas las páginas', async () => {
  const fixture = setup({ pages: [
    { body: { nextPageToken: 'second-page' } },
    { body: { documents: [document({})], nextPageToken: 'third-page' } },
    { body: {} } // REST permite omitir documents en una respuesta vacía exitosa.
  ] });
  assert.deepEqual((await fixture.run()).body, { deleted: [first], pending: [], skipped: [] });
  assert.equal(fixture.calls.length, 4);
  assert.equal(new URL(fixture.calls[2].url).searchParams.get('pageToken'), 'third-page');
  assert.ok(fixture.calls.slice(0, 3).every(call => call.url.startsWith('https://firestore.googleapis.com/')));
  assert.ok(fixture.calls[3].url.startsWith('https://api.cloudinary.com/'));
});

test('mantiene límites de solicitud y método', async () => {
  for (const change of [{ httpMethod: 'GET' }, { body: '{' }, { body: JSON.stringify({ urls: [] }) }, { body: JSON.stringify({ urls: Array(11).fill(first) }) }]) {
    const fixture = setup();
    const response = await fixture.run({ ...fixture.event, ...change });
    assert.equal(response.status, change.httpMethod ? 405 : 400);
    assert.equal(fixture.calls.length, 0);
  }
});

test('una colección vacía permite limpiar y not found es idempotente', async () => {
  const fixture = setup({ destroyResult: 'not found' });
  assert.deepEqual((await fixture.run()).body, { deleted: [first], pending: [], skipped: [] });
});

test('los fallos de Cloudinary permanecen pendientes para reintentar', async () => {
  const fixture = setup({ destroyResult: 'error' });
  assert.deepEqual((await fixture.run()).body, { deleted: [], pending: [first], skipped: [] });
});
