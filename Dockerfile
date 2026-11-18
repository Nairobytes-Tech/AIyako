FROM node:22
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
ENV QVAC_CONFIG_PATH=/app/qvac.config.json
EXPOSE 3000
CMD ["npm", "run", "server"]
