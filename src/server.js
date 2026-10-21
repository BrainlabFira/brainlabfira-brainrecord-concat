'use strict';

const express = require('express');
const Minio = require('minio');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// ── Config (env vars, mismos nombres que la app de escritorio) ──────────────
const PORT = parseInt(process.env.PORT ?? '9200', 10);
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? '192.168.1.175';
const MINIO_PORT = parseInt(process.env.MINIO_PORT ?? '9100', 10);
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? '';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? '';
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'recordings';
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';

// Prefijo donde se guardan los vídeos ya concatenados (caché en el mismo bucket)
const CONCAT_PREFIX = process.env.CONCAT_PREFIX ?? 'concatenated';
// ffmpeg: en el contenedor está en PATH; en local puedes apuntar a un binario
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';

// Supabase — para validar los JWT de la app de escritorio y mapear a numericUserId
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
// Minutos de validez de las presigned URLs de subida
const UPLOAD_URL_EXPIRY_SEC = parseInt(process.env.UPLOAD_URL_EXPIRY_SEC ?? '900', 10);

const minio = new Minio.Client({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

// Cliente aparte para FIRMAR las presigned URLs de subida con el endpoint PÚBLICO.
// El cliente 'minio' de arriba usa el hostname interno (minio:9000) que la app del
// empleado NO puede resolver. Las URLs firmadas deben apuntar al endpoint público
// (p.ej. 192.168.1.175:9100) para que el PC del empleado pueda subir el chunk.
const MINIO_PUBLIC_ENDPOINT = process.env.MINIO_PUBLIC_ENDPOINT ?? '192.168.1.175';
const MINIO_PUBLIC_PORT = parseInt(process.env.MINIO_PUBLIC_PORT ?? '9100', 10);
const MINIO_PUBLIC_USE_SSL = process.env.MINIO_PUBLIC_USE_SSL === 'true';

const minioPublic = new Minio.Client({
  endPoint: MINIO_PUBLIC_ENDPOINT,
  port: MINIO_PUBLIC_PORT,
  useSSL: MINIO_PUBLIC_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

// No usamos Realtime aquí (solo auth.getUser + queries), pero createClient
// instancia RealtimeClient igualmente, que necesita WebSocket (no nativo en Node 20).
// Pasamos 'ws' como transport para que no falle al arrancar.
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket },
    })
  : null;

const app = express();
app.use(express.json());

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

// ── Auth: validar JWT de Supabase y mapear a numericUserId ──────────────────
// Cache email → numericUserId (el mapeo no cambia; evita consultar en cada subida)
const userIdCache = new Map();

// Valida el JWT y devuelve el usuario de Supabase Auth (o null si inválido).
async function getAuthUser(token) {
  if (!supabase || !token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch {
    return null;
  }
}

// Mapea el email del usuario autenticado a su numericUserId de public.users.
// Busca por company_email, con fallback a personal_email (igual que la app).
async function resolveNumericUserId(email) {
  if (!email) return null;
  if (userIdCache.has(email)) return userIdCache.get(email);

  let { data } = await supabase
    .from('users')
    .select('id')
    .eq('company_email', email)
    .maybeSingle();

  if (!data) {
    ({ data } = await supabase
      .from('users')
      .select('id')
      .eq('personal_email', email)
      .maybeSingle());
  }

  const id = data ? data.id : null;
  if (id !== null) userIdCache.set(email, id);
  return id;
}

// ── Rol: quién puede ver las grabaciones de OTROS ───────────────────────────
// role_id = 1 en public.users es administrador. El resto solo ve lo suyo.
//
// Se comprueba AQUÍ y no en el cliente a propósito: ocultar una pestaña en la
// app es cosmético — cualquiera con un token válido podría llamar al endpoint
// igualmente. El control real tiene que estar en el servidor.
const ADMIN_ROLE_ID = parseInt(process.env.ADMIN_ROLE_ID ?? '1', 10);

// Cache email → { id, isAdmin }. El rol cambia muy de tanto en tanto, así que
// se cachea con un TTL corto en vez de consultarlo en cada petición.
const profileCache = new Map();
const PROFILE_TTL_MS = 5 * 60 * 1000;

async function resolveProfile(email) {
  if (!email) return null;

  const cached = profileCache.get(email);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.value;

  let { data } = await supabase
    .from('users')
    .select('id, role_id')
    .eq('company_email', email)
    .maybeSingle();

  if (!data) {
    ({ data } = await supabase
      .from('users')
      .select('id, role_id')
      .eq('personal_email', email)
      .maybeSingle());
  }

  if (!data) return null;

  const value = { id: data.id, isAdmin: data.role_id === ADMIN_ROLE_ID };
  profileCache.set(email, { at: Date.now(), value });
  return value;
}

// Resuelve el perfil a partir de la cabecera Authorization. Devuelve null si
// el token no es válido o el usuario no está en public.users.
async function authenticate(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const user = await getAuthUser(token);
  if (!user) return null;
  return resolveProfile(user.email);
}

// ── Nombres de usuario ──────────────────────────────────────────────────────
// Un listado de admin puede traer decenas de grabaciones de muchos usuarios.
// Resolver el nombre de uno en uno serían decenas de consultas, así que se
// piden todos los id de golpe con un .in().
const nameCache = new Map();
const NAME_TTL_MS = 10 * 60 * 1000;

function fullName(row) {
  return [row.user_name, row.user_surname_1, row.user_surname_2]
    .filter(Boolean)
    .join(' ')
    .trim();
}

async function resolveUserNames(ids) {
  const result = new Map();
  const missing = [];

  for (const id of ids) {
    const hit = nameCache.get(String(id));
    if (hit && Date.now() - hit.at < NAME_TTL_MS) result.set(String(id), hit.name);
    else missing.push(id);
  }

  if (missing.length > 0 && supabase) {
    const { data } = await supabase
      .from('users')
      .select('id, user_name, user_surname_1, user_surname_2, company_email')
      .in('id', missing);

    for (const row of data ?? []) {
      // Si no hay nombre, el email es mejor etiqueta que un número suelto.
      const name = fullName(row) || row.company_email || `Usuario ${row.id}`;
      nameCache.set(String(row.id), { at: Date.now(), name });
      result.set(String(row.id), name);
    }
  }

  return result;
}

// Lista las grabaciones (carpetas de tercer nivel) bajo un prefijo, con el
// número de fragmentos y el tamaño total de cada una.
//
// La ruta es {userId}/{fecha}/{recId}/chunk_NNN.mp4, así que agrupamos por los
// tres primeros segmentos. Se ignora el prefijo de los concatenados: son
// resultados cacheados, no grabaciones en sí.
function listRecordings(prefix) {
  return new Promise((resolve, reject) => {
    const groups = new Map();
    const stream = minio.listObjectsV2(MINIO_BUCKET, prefix, true);

    stream.on('data', (obj) => {
      if (!obj.name.endsWith('.mp4')) return;
      if (obj.name.startsWith(`${CONCAT_PREFIX}/`)) return;

      const parts = obj.name.split('/');
      if (parts.length < 4) return; // no tiene la forma esperada

      const [userId, fecha, recId] = parts;
      const key = `${userId}/${fecha}/${recId}`;

      const g = groups.get(key) ?? {
        userId, fecha, recId,
        chunks: 0, bytes: 0, lastModified: null,
      };
      g.chunks++;
      g.bytes += obj.size ?? 0;
      const mod = obj.lastModified ? new Date(obj.lastModified) : null;
      if (mod && (!g.lastModified || mod > g.lastModified)) g.lastModified = mod;
      groups.set(key, g);
    });

    stream.on('error', reject);
    stream.on('end', () => {
      const list = Array.from(groups.values()).map((g) => ({
        ...g,
        lastModified: g.lastModified ? g.lastModified.toISOString() : null,
      }));
      // Más recientes primero.
      list.sort((a, b) => (b.lastModified ?? '').localeCompare(a.lastModified ?? ''));
      resolve(list);
    });
  });
}

// Lista los objetos de un prefijo, devueltos ordenados por nombre (chunk_001, 002…)
function listChunks(prefix) {
  return new Promise((resolve, reject) => {
    const objects = [];
    const stream = minio.listObjectsV2(MINIO_BUCKET, prefix, true);
    stream.on('data', (obj) => {
      if (obj.name.endsWith('.mp4')) objects.push(obj.name);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(objects.sort()));
  });
}

// Comprueba si un objeto existe (para servir el concatenado cacheado)
async function objectExists(name) {
  try {
    await minio.statObject(MINIO_BUCKET, name);
    return true;
  } catch {
    return false;
  }
}

// Concatena los chunks sin recomprimir (-c copy) usando el demuxer concat de ffmpeg
function ffmpegConcat(listFilePath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFilePath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ];
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg salió con código ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// Mezcla los dos canales de audio a mono, dejando el vídeo intacto (-c:v copy).
//
// La app graba el micrófono en el canal izquierdo y el audio del sistema en el
// derecho, lo que permite separarlos luego para transcribir. Pero escuchar ese
// fichero tal cual es incómodo: cada parte suena por un auricular, y si en la
// grabación nadie habló al micro, el lado izquierdo está mudo.
//
// Por eso se sirve una versión mezclada. El original NO se toca: sigue en
// MinIO con los canales separados, que es lo que necesita la transcripción.
function ffmpegMixDown(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-c:v', 'copy',           // el vídeo no se recomprime
      '-af', 'pan=stereo|c0=c0+c1|c1=c0+c1',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ];
    const proc = spawn(FFMPEG_PATH, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg (mixdown) salió con código ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// ── Endpoint de subida: entrega una presigned URL para subir un chunk ────────
// POST /upload-url   { "objectName": "6/2026-06-18/306/chunk_005.mp4" }
// Header: Authorization: Bearer <jwt de Supabase>
// La app NO tiene credenciales de MinIO: pide aquí una URL firmada temporal.
// Seguridad estricta: el usuario solo puede subir a SU propia carpeta ({numericUserId}/...).
app.post('/upload-url', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Servicio de auth no configurado' });
  }

  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const objectName = req.body?.objectName;

  if (!token) return res.status(401).json({ error: 'Falta token' });
  if (!objectName || typeof objectName !== 'string') {
    return res.status(400).json({ error: 'Falta objectName' });
  }

  // Solo se permiten claves de la forma {userId}/{fecha}/{fichajeId}/chunk_NNN.mp4
  // sin '..' ni caracteres raros (evita path traversal / sobrescribir otras rutas).
  if (!/^\d+\/[\w-]+\/[\w-]+\/chunk_\d+\.mp4$/.test(objectName)) {
    return res.status(400).json({ error: 'objectName con formato inválido' });
  }

  // 1. Validar el JWT
  const user = await getAuthUser(token);
  if (!user) return res.status(401).json({ error: 'Token inválido o expirado' });

  // 2. Mapear a numericUserId
  const numericUserId = await resolveNumericUserId(user.email);
  if (numericUserId === null) {
    return res.status(403).json({ error: 'Usuario no encontrado en public.users' });
  }

  // 3. Comprobar que la carpeta del objeto es la suya
  const objectUserId = objectName.split('/')[0];
  if (objectUserId !== String(numericUserId)) {
    log(`[upload-url] RECHAZADO: ${user.email} (id ${numericUserId}) intentó subir a ${objectName}`);
    return res.status(403).json({ error: 'No puedes subir a la carpeta de otro usuario' });
  }

  try {
    // 4. Generar presigned PUT URL temporal (con el endpoint público)
    const url = await minioPublic.presignedPutObject(MINIO_BUCKET, objectName, UPLOAD_URL_EXPIRY_SEC);
    log(`[upload-url] OK ${user.email} → ${objectName} (expira ${UPLOAD_URL_EXPIRY_SEC}s)`);
    return res.json({ url, expiresInSec: UPLOAD_URL_EXPIRY_SEC });
  } catch (err) {
    log('[upload-url] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Listado de grabaciones ──────────────────────────────────────────────────
// GET /recordings          → las del usuario autenticado
// GET /recordings?all=1    → las de TODOS (solo administradores)
// Header: Authorization: Bearer <jwt de Supabase>
app.get('/recordings', async (req, res) => {
  const profile = await authenticate(req);
  if (!profile) return res.status(401).json({ error: 'No autenticado' });

  const wantsAll = req.query.all === '1';
  if (wantsAll && !profile.isAdmin) {
    return res.status(403).json({ error: 'Solo los administradores pueden ver todas las grabaciones' });
  }

  // Sin ?all, cada uno ve lo suyo: el prefijo lo fija el servidor a partir del
  // JWT, así que no hay forma de pedir la carpeta de otro.
  const prefix = wantsAll ? '' : `${profile.id}/`;

  try {
    const recordings = await listRecordings(prefix);

    // Añadir el nombre de cada usuario: un "Usuario 6" no le dice nada a quien
    // revisa las grabaciones.
    const ids = [...new Set(recordings.map((r) => r.userId))];
    const names = await resolveUserNames(ids);
    for (const r of recordings) {
      r.userName = names.get(String(r.userId)) ?? `Usuario ${r.userId}`;
    }

    // Búsqueda por nombre, fecha o id de grabación. Se filtra AQUÍ y no en el
    // cliente para que el listado de un admin con muchos usuarios no tenga que
    // viajar entero en cada tecla.
    const q = (req.query.q ?? '').toString().trim().toLowerCase();
    const filtered = q
      ? recordings.filter((r) =>
          r.userName.toLowerCase().includes(q) ||
          r.recId.toLowerCase().includes(q) ||
          r.fecha.includes(q))
      : recordings;

    // Lista de usuarios con grabaciones, para el desplegable de filtro.
    const users = ids
      .map((id) => ({ id, name: names.get(String(id)) ?? `Usuario ${id}` }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      isAdmin: profile.isAdmin,
      userId: profile.id,
      users,
      recordings: filtered,
    });
  } catch (err) {
    log('Error listando grabaciones:', err.message);
    res.status(500).json({ error: 'No se pudieron listar las grabaciones' });
  }
});

// ── Endpoint principal ──────────────────────────────────────────────────────
// GET /concat/:userId/:fecha/:fichajeId
//   ?force=1   → re-concatena aunque exista en caché
//   ?download=1 → fuerza descarga (Content-Disposition attachment)
//
// Requiere autenticación: antes era público, así que cualquiera en la red que
// adivinara la ruta podía descargar la grabación de cualquier empleado.
app.get('/concat/:userId/:fecha/:fichajeId', async (req, res) => {
  const { userId, fecha, fichajeId } = req.params;
  const force = req.query.force === '1';
  const download = req.query.download === '1';

  // Validación básica para evitar path traversal
  if ([userId, fecha, fichajeId].some((p) => /[^\w-]/.test(p))) {
    return res.status(400).json({ error: 'Parámetros inválidos' });
  }

  // El token puede venir por cabecera (app) o por query (un <video src> del
  // navegador no puede poner cabeceras).
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  if (queryToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }

  const profile = await authenticate(req);
  if (!profile) return res.status(401).json({ error: 'No autenticado' });

  // Aislamiento: solo tus grabaciones, salvo que seas administrador.
  if (String(profile.id) !== String(userId) && !profile.isAdmin) {
    return res.status(403).json({ error: 'No puedes acceder a grabaciones de otro usuario' });
  }

  const sourcePrefix = `${userId}/${fecha}/${fichajeId}/`;
  const outputObject = `${CONCAT_PREFIX}/${userId}/${fecha}/${fichajeId}.mp4`;

  // Por defecto se sirve la versión mezclada, que es la que se escucha bien.
  // Con ?raw=1 se entrega el original con los canales separados, que es lo que
  // necesita el pipeline de transcripción.
  const raw = req.query.raw === '1';
  const mixedObject = `${CONCAT_PREFIX}/${userId}/${fecha}/${fichajeId}_mix.mp4`;
  const servedObject = raw ? outputObject : mixedObject;

  try {
    // 1. Si ya está en caché y no se fuerza, sírvelo directamente
    if (!force && (await objectExists(servedObject))) {
      log(`Cache hit: ${servedObject}`);
      return streamObject(res, servedObject, download, `${fichajeId}.mp4`, req);
    }

    // 1b. El concatenado existe pero falta su versión mezclada (p. ej. una
    // grabación anterior a este cambio): se genera solo la mezcla, sin
    // repetir la concatenación.
    if (!raw && !force && (await objectExists(outputObject))) {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-'));
      try {
        const src = path.join(workDir, 'src.mp4');
        const out = path.join(workDir, 'mix.mp4');
        await minio.fGetObject(MINIO_BUCKET, outputObject, src);
        await ffmpegMixDown(src, out);
        await minio.fPutObject(MINIO_BUCKET, mixedObject, out, { 'Content-Type': 'video/mp4' });
        log(`Mezcla generada: ${mixedObject}`);
        return streamObject(res, mixedObject, download, `${fichajeId}.mp4`, req);
      } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }

    // 2. Listar chunks del fichaje
    const chunks = await listChunks(sourcePrefix);
    if (chunks.length === 0) {
      return res.status(404).json({ error: `No hay chunks en ${sourcePrefix}` });
    }
    log(`Concatenando ${chunks.length} chunks de ${sourcePrefix}`);

    // 3. Descargar chunks a un dir temporal
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-'));
    try {
      const localPaths = [];
      for (let i = 0; i < chunks.length; i++) {
        const local = path.join(workDir, `chunk_${String(i).padStart(4, '0')}.mp4`);
        await minio.fGetObject(MINIO_BUCKET, chunks[i], local);
        localPaths.push(local);
      }

      // 4. Crear lista para el demuxer concat
      const listFile = path.join(workDir, 'list.txt');
      fs.writeFileSync(
        listFile,
        localPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n')
      );

      // 5. Concatenar (sin recomprimir)
      const outputLocal = path.join(workDir, 'output.mp4');
      await ffmpegConcat(listFile, outputLocal);

      // 6. Subir el original (canales separados) a MinIO como caché
      await minio.fPutObject(MINIO_BUCKET, outputObject, outputLocal, {
        'Content-Type': 'video/mp4',
      });
      log(`Concatenado y cacheado: ${outputObject}`);

      // 7. Y la versión mezclada, que es la que se sirve para escuchar. El
      // vídeo se copia sin recomprimir, así que cuesta poco.
      const mixLocal = path.join(workDir, 'mix.mp4');
      await ffmpegMixDown(outputLocal, mixLocal);
      await minio.fPutObject(MINIO_BUCKET, mixedObject, mixLocal, {
        'Content-Type': 'video/mp4',
      });
      log(`Mezcla cacheada: ${mixedObject}`);

      return streamObject(res, servedObject, download, `${fichajeId}.mp4`, req);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } catch (err) {
    log('ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Hace streaming de un objeto de MinIO hacia la respuesta HTTP
// Sirve el objeto, con soporte de peticiones por rango (HTTP 206).
//
// El Range es lo que permite SALTAR por el vídeo en un reproductor: sin él, el
// navegador solo puede descargar el archivo entero desde el principio, así que
// mover la barra a la mitad de una grabación de una hora no funciona.
// `req` llega para leer la cabecera Range.
async function streamObject(res, objectName, download, filename, req) {
  const stat = await minio.statObject(MINIO_BUCKET, objectName);
  const total = stat.size;

  if (download) {
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
  res.setHeader('Content-Type', 'video/mp4');
  // Anunciar que aceptamos rangos; sin esto el reproductor ni lo intenta.
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req?.headers?.range;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;

  if (match) {
    let start = match[1] === '' ? null : parseInt(match[1], 10);
    let end = match[2] === '' ? null : parseInt(match[2], 10);

    // "bytes=-500" = los últimos 500 bytes.
    if (start === null) {
      if (end === null) return res.status(416).end();
      start = Math.max(0, total - end);
      end = total - 1;
    } else if (end === null) {
      end = total - 1;
    }

    if (start >= total || start > end) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    end = Math.min(end, total - 1);

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);

    const partial = await minio.getPartialObject(
      MINIO_BUCKET, objectName, start, end - start + 1
    );
    return partial.pipe(res);
  }

  res.setHeader('Content-Length', total);
  const stream = await minio.getObject(MINIO_BUCKET, objectName);
  stream.pipe(res);
}

// ── Distribución de la app de escritorio ────────────────────────────────────
// Los instaladores y el manifiesto de actualización viven en un prefijo aparte
// del bucket, subidos a mano con `npm run publish` desde el proyecto de la app.
//
//   releases/latest.yml                        ← manifiesto que lee la app
//   releases/Brainlabrecord Setup 1.0.0.exe    ← instalador
//
// La app usa `autoUpdater.addAuthHeader()`, así que las peticiones llegan con
// Authorization normal. Se acepta además el token por query para poder pegar
// el enlace de descarga en un navegador. Sin token se rechaza: una app de
// grabación de pantalla no debería poder bajarla cualquiera que pase por la red.
const RELEASES_PREFIX = process.env.RELEASES_PREFIX ?? 'releases';

async function authenticateDownload(req, res) {
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  if (queryToken && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${queryToken}`;
  }
  const profile = await authenticate(req);
  if (!profile) {
    res.status(401).json({ error: 'No autenticado' });
    return null;
  }
  return profile;
}

// Sirve cualquier fichero del prefijo de releases: el manifiesto, el instalador
// y los .blockmap que electron-updater usa para descargas diferenciales.
app.get('/updates/:file', async (req, res) => {
  if (!(await authenticateDownload(req, res))) return;

  const file = req.params.file;
  // Sin barras ni '..': el nombre viaja en la URL y acaba en una clave de MinIO.
  if (file.includes('/') || file.includes('\\') || file.includes('..')) {
    return res.status(400).json({ error: 'Nombre de archivo inválido' });
  }

  const objectName = `${RELEASES_PREFIX}/${file}`;
  if (!(await objectExists(objectName))) {
    return res.status(404).json({ error: `No existe ${file}` });
  }

  try {
    const stat = await minio.statObject(MINIO_BUCKET, objectName);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader(
      'Content-Type',
      file.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream'
    );
    // El manifiesto no se cachea: es justo lo que hay que releer para saber si
    // hay versión nueva.
    if (file.endsWith('.yml')) res.setHeader('Cache-Control', 'no-cache');

    const stream = await minio.getObject(MINIO_BUCKET, objectName);
    stream.pipe(res);
  } catch (err) {
    log('Error sirviendo update:', err.message);
    res.status(500).json({ error: 'No se pudo servir el archivo' });
  }
});

// Atajo para la descarga inicial: resuelve el instalador de la última versión
// leyendo el manifiesto, para no tener que saber el número de versión.
app.get('/download', async (req, res) => {
  if (!(await authenticateDownload(req, res))) return;

  try {
    const manifest = `${RELEASES_PREFIX}/latest.yml`;
    if (!(await objectExists(manifest))) {
      return res.status(404).json({ error: 'No hay ninguna versión publicada' });
    }

    // latest.yml es YAML sencillo generado por electron-builder; basta con
    // sacar la línea 'path:' en vez de añadir una dependencia de YAML.
    const chunks = [];
    const stream = await minio.getObject(MINIO_BUCKET, manifest);
    for await (const c of stream) chunks.push(c);
    const yml = Buffer.concat(chunks).toString('utf-8');

    const match = /^path:\s*(.+)$/m.exec(yml);
    if (!match) {
      return res.status(500).json({ error: 'El manifiesto no indica el instalador' });
    }
    const file = match[1].trim().replace(/^["']|["']$/g, '');

    const objectName = `${RELEASES_PREFIX}/${file}`;
    const stat = await minio.statObject(MINIO_BUCKET, objectName);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    const dl = await minio.getObject(MINIO_BUCKET, objectName);
    dl.pipe(res);
  } catch (err) {
    log('Error en /download:', err.message);
    res.status(500).json({ error: 'No se pudo servir el instalador' });
  }
});

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  log(`Concat service escuchando en puerto ${PORT}`);
  log(`MinIO: ${MINIO_ENDPOINT}:${MINIO_PORT} bucket=${MINIO_BUCKET}`);
});
