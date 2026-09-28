# Hub-only image: serves the web UI and relays to agents. It does not run Claude Code itself,
# so the Claude Agent SDK (an optional dependency) is left out.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=optional --omit=dev && npm cache clean --force
COPY hub ./hub
COPY public ./public
COPY scripts ./scripts
# Named volumes inherit this ownership, so the non-root user can write its data.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3456 \
    DATA_DIR=/data \
    EMBEDDED_AGENT=false
VOLUME /data
EXPOSE 3456
USER node
CMD ["node", "hub/index.js"]
