# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copia arquivos de dependencias
COPY package*.json ./
COPY tsconfig.json ./

# Instala todas as dependencias (incluindo devDependencies para compilar)
RUN npm ci

# Copia o codigo fonte
COPY src/ ./src/

# Compila o TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copia apenas package.json para instalar deps de producao
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o codigo compilado do stage anterior
COPY --from=builder /app/dist ./dist

# Expoe a porta
EXPOSE 3000

# Inicia o servidor compilado
CMD ["node", "dist/server.js"]
