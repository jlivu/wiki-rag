# -- DEV DOCKERFILE --
# -- DO NOT USE IN PRODUCTION! --

FROM node:22.23.4-bookworm-slim
LABEL maintainer="doft.gov.vu"

ENV NODE_ENV=development
WORKDIR /app

# Tesseract reads the text in images and in scanned PDF pages; poppler's
# pdftoppm renders a PDF page to a PNG for it, and pdfinfo counts the
# pages. Together they add about 110 MB to the image, most of it libicu,
# which tesseract-ocr depends on.
#
# ffmpeg and ffprobe read the videos in the media folder: ffprobe for the
# duration and which streams a file has, ffmpeg to pull out the audio for
# whisper.cpp, the frames to OCR and any embedded subtitle track. About
# 150 MB more, and the only way to get timestamps out of a video.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng \
      poppler-utils \
      ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first, so editing the source does not reinstall them.
# docker-compose.ai.yml keeps /app/node_modules in a volume of its own,
# seeded from this layer, so the bind-mounted source does not hide it.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 4000

CMD ["npm", "run", "dev"]
