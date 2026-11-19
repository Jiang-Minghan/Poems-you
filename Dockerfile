FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY data ./data

EXPOSE 8787
CMD ["node", "server.js"]
