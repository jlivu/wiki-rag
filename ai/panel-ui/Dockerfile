# -- DEV DOCKERFILE --
# -- DO NOT USE IN PRODUCTION! --
#
# Build context is ai/, not ai/panel-ui/, because the chat app imports the
# schemas in ai/shared.

FROM node:22.23.4-bookworm-slim
LABEL maintainer="doft.gov.vu"

ENV NODE_ENV=development
WORKDIR /app/panel-ui

# Dependencies first, so editing the source does not reinstall them.
# docker-compose.ai.yml keeps /app/panel-ui/node_modules in a volume of its
# own, seeded from this layer, so the bind-mounted source does not hide it.
COPY panel-ui/package.json panel-ui/package-lock.json* ./
RUN npm install

COPY . /app

EXPOSE 5173

CMD ["npm", "run", "dev"]
