FROM node:18-alpine

# 安装 sharp 所需的编译工具
RUN apk add --no-cache --virtual .build-deps python3 make g++

WORKDIR /app
COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]