FROM node:18-alpine

# 安装构建工具（sharp 所需）
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm install -g npm@latest \
    && apk del .build-deps

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]