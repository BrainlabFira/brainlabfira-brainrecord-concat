# Brainlabrecord Concat Service

Microservicio que concatena **bajo demanda** los chunks de vídeo de una grabación
(guardados por la app de escritorio en MinIO) en un único MP4, **sin recomprimir**
(`ffmpeg -f concat -c copy`, instantáneo y sin pérdida de calidad).

Es el **único componente con credenciales de MinIO**: la app de escritorio sube
por presigned URLs que pide aquí.

## Cómo encaja

```
App escritorio  →  pide una presigned URL a POST /upload-url
                   sube cada chunk directo a MinIO
                   recordings/{userId}/{fecha}/{recId}/chunk_NNN.mp4

Este servicio   →  lista las grabaciones (GET /recordings)
                   y, al pedir una, descarga sus chunks, los concatena,
                   cachea el resultado y lo devuelve
                   recordings/concatenated/{userId}/{fecha}/{recId}.mp4
```

La concatenación es **por grabación** (no por fecha) y se hace **en el servidor**
(no en el equipo del empleado, que se apaga al cerrar sesión).

> El tercer nivel de la ruta (`recId`) es el id que genera la app:
> `rec_YYYYMMDD_HHMMSS`. Las grabaciones antiguas usan el id del fichaje, y el
> servicio trata ambos igual: solo ve carpetas.

## Autenticación

Todos los endpoints salvo `/health` exigen el JWT de Supabase de la app:

```
Authorization: Bearer <access_token>
```

El servicio valida el token, mapea el email a `numericUserId` en `public.users`
y aplica el aislamiento. **El control de acceso vive aquí**, no en el cliente:
ocultar una pestaña en la app es cosmético.

| Rol | Puede |
|---|---|
| `role_id = 1` (admin) | Listar y ver las grabaciones de **todos** |
| Resto | Solo las de **su** carpeta |

El rol que cuenta como administrador se configura con `ADMIN_ROLE_ID`.

## Endpoints

### `GET /recordings`

Lista las grabaciones con su número de fragmentos y tamaño.

| Query param | Efecto |
|---|---|
| `?all=1` | Las de todos los usuarios (**solo administradores**, 403 si no) |

```bash
curl -H "Authorization: Bearer $TOKEN" http://192.168.1.175:9210/recordings
```

```json
{
  "isAdmin": false,
  "userId": 6,
  "recordings": [
    {
      "userId": "6", "fecha": "2026-10-20", "recId": "rec_20261020_123350",
      "chunks": 1, "bytes": 3789897, "lastModified": "2026-10-20T10:36:12.141Z"
    }
  ]
}
```

### `GET /concat/:userId/:fecha/:recId`

Devuelve el MP4 concatenado. Devuelve 403 si la carpeta no es tuya y no eres admin.

| Query param | Efecto |
|---|---|
| `?raw=1` | Devuelve el audio con las **pistas separadas** en vez de mezclado (ver abajo) |
| `?download=1` | Fuerza descarga (Content-Disposition attachment) |
| `?force=1` | Re-concatena aunque ya exista en caché |
| `?token=...` | Token por query, para un `<video src>` o una pestaña del navegador, que no pueden enviar cabeceras |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://192.168.1.175:9210/concat/6/2026-10-20/rec_20261020_123350 \
  --output grabacion.mp4
```

## Audio: pistas separadas para transcripción

La app **no mezcla** las dos fuentes de audio: las graba en canales distintos.

```
canal izquierdo  ←  micrófono         (la voz de quien graba)
canal derecho    ←  audio del sistema (el resto de participantes)
```

Esto se hizo pensando en la transcripción: **la diarización —saber quién dice
qué— sale gratis**, porque el canal lo dice. No hay que separar voces de oído,
que es la parte que peor funciona de cualquier pipeline de transcripción.
Además evita el problema de los solapamientos: cuando dos personas hablan a la
vez, una pista mezclada es casi intranscribible.

### Para escuchar el vídeo (por defecto)

`GET /concat/...` devuelve el audio **mezclado a mono**. Se oye por los dos
auriculares, como cualquier vídeo. Es lo que usan el reproductor de la app y
quien solo quiere revisar una grabación.

### Para transcribir: `?raw=1`

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://192.168.1.175:9210/concat/6/2026-10-20/rec_20261020_123350?raw=1" \
  --output grabacion.mp4
```

Devuelve el fichero original, con los canales intactos. A partir de ahí:

```bash
# Solo la voz de quien grabó
ffmpeg -i grabacion.mp4 -af "pan=mono|c0=c0" -ar 16000 -ac 1 empleado.wav

# Solo el resto de participantes
ffmpeg -i grabacion.mp4 -af "pan=mono|c0=c1" -ar 16000 -ac 1 remoto.wav
```

> `-ar 16000 -ac 1` es lo que esperan Whisper y la mayoría de modelos de
> transcripción: mono a 16 kHz. Pasarles el MP4 directamente funciona, pero
> convertir antes evita que el modelo lo haga por su cuenta.

Después se transcribe cada WAV por separado y se combinan por marca de tiempo.
Cada segmento ya viene etiquetado con su interlocutor según el fichero del que
salga.

### Comprobar qué hay en cada canal

Si una grabación suena solo por un lado, es que esa fuente estaba en silencio
(por ejemplo, nadie habló al micrófono). Para verificarlo:

```bash
ffmpeg -i grabacion.mp4 -af "pan=mono|c0=c0,astats" -f null -   # izquierdo
ffmpeg -i grabacion.mp4 -af "pan=mono|c0=c1,astats" -f null -   # derecho
```

Un `RMS level dB` cercano a −100 significa silencio; alrededor de −30 indica
que hay contenido.

### Dónde vive cada versión

| Objeto en MinIO | Qué es |
|---|---|
| `{userId}/{fecha}/{recId}/chunk_NNN.mp4` | Los fragmentos originales, canales separados |
| `concatenated/{userId}/{fecha}/{recId}.mp4` | Concatenado, **canales separados** (lo que sirve `?raw=1`) |
| `concatenated/{userId}/{fecha}/{recId}_mix.mp4` | Concatenado y mezclado a mono (lo que se sirve por defecto) |

La mezcla es una transformación de salida: **el original nunca se modifica**.
El vídeo se copia sin recomprimir (`-c:v copy`), así que generarla cuesta poco.

### `POST /upload-url`

Devuelve una presigned PUT URL para subir un chunk. El usuario solo puede subir
a su propia carpeta.

```json
{ "objectName": "6/2026-10-20/rec_20261020_123350/chunk_001.mp4" }
```

### `GET /health`

Healthcheck. Sin autenticación.

## Puertos

El servicio escucha en el **9200 dentro del contenedor**, publicado en el
**9210** del host. Desde fuera, la URL es `http://192.168.1.175:9210`.

## Configuración

Las credenciales van en un `.env` (ignorado por git), que el `docker-compose.yml`
lee con `${VAR}`:

```bash
cp .env.example .env   # y rellenar
```

| Variable | Para qué |
|---|---|
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | Acceso a MinIO |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Validar los JWT de la app |
| `ADMIN_ROLE_ID` | `role_id` que puede ver las grabaciones de todos (por defecto `1`) |

El compose falla al arrancar si falta alguna de las obligatorias, en vez de
levantar el servicio a medias.

## Despliegue (Docker, junto a MinIO)

El `docker-compose.yml` usa la red externa `proxy` (la misma que MinIO), así que
se conecta por nombre de contenedor (`minio:9000`) sin pasar por la IP.

```bash
docker compose up -d --build
```

> Requiere que la red `proxy` exista (la crea el compose de MinIO). Si no:
> `docker network create proxy`

## Ejecución local (sin Docker, para pruebas)

Necesitas Node 20+ y ffmpeg instalado (o `FFMPEG_PATH` apuntando al binario).
Al correr fuera de Docker hay que descomentar en el `.env` las variables que
normalmente aporta el compose (`PORT`, `MINIO_ENDPOINT`, `MINIO_PORT`…), y
apuntar `MINIO_ENDPOINT` a la IP pública en vez del hostname interno.

```bash
npm install
cp .env.example .env
npm start
```

## Caché

El primer acceso a una grabación la concatena y guarda **dos** resultados en
`recordings/concatenated/`: el original con los canales separados y la versión
mezclada. Los siguientes accesos sirven el archivo cacheado directamente.

Una grabación anterior a la mezcla genera su `_mix.mp4` la primera vez que se
pide, sin repetir la concatenación.

Usa `?force=1` para regenerar ambos (p. ej. si se añadieron chunks).
