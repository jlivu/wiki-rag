# -- DEV DOCKERFILE --
# -- DO NOT USE IN PRODUCTION! --

FROM node:22.23.4-bookworm-slim
LABEL maintainer="doft.gov.vu"

ENV NODE_ENV=development
WORKDIR /app

# Dependencies first, so editing the source does not reinstall them.
# docker-compose.ai.yml keeps /app/node_modules in a volume of its own,
# seeded from this layer, so the bind-mounted source does not hide it.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 4000

CMD ["npm", "run", "dev"]
