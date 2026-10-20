# Node + ffmpeg para concatenar chunks de vídeo
FROM node:20-alpine

# ffmpeg desde los repos de Alpine (incluye el demuxer concat y -c copy)
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Instalar dependencias primero (mejor cacheo de capas)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

EXPOSE 9200

CMD ["node", "src/server.js"]
