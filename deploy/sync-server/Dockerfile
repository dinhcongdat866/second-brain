FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
# The classic y-websocket server reads HOST/PORT from env.
ENV HOST=0.0.0.0 PORT=1234
EXPOSE 1234
CMD ["node", "./node_modules/y-websocket/bin/server.js"]
