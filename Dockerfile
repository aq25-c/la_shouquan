# 授权许可服务端 —— 运行时零依赖，不需要 npm install
FROM node:24-alpine

WORKDIR /app

# 只复制运行所需内容：Node 24 直接执行 TypeScript（原生类型剥离）
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    TZ=Asia/Shanghai

# 数据卷（SQLite 库 + Ed25519 签名密钥）
RUN mkdir -p /data && chown -R node:node /data /app

USER node

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 优雅退出由 server.ts 处理 SIGTERM
CMD ["node", "src/server.ts"]
