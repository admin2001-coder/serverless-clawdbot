FROM node:lts AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# --- production image ---
FROM node:lts

WORKDIR /app
COPY package*.json ./
RUN npm install --only=production

COPY --from=builder /app ./

CMD ["npm", "start"]
