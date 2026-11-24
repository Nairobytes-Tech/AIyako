FROM node:22

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY qvac.config.json ./
COPY prompts ./prompts
COPY src/systemPrompt.js ./src/systemPrompt.js
COPY services/model-server ./services/model-server

ENV PORT=8000
ENV QVAC_CONFIG_PATH=/app/qvac.config.json
EXPOSE 8000

CMD ["node", "services/model-server/server.js"]
