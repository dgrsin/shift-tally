FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Seoul
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY prompts ./prompts
COPY scripts ./scripts
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["node", "--no-warnings=ExperimentalWarning", "src/main.js"]
