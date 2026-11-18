FROM node:22
WORKDIR /app
COPY package.json .
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && npm install --no-audit --no-fund
COPY . .
ENV QVAC_CONFIG_PATH=/app/qvac.config.json
EXPOSE 3000
CMD ["npm", "run", "server"]
