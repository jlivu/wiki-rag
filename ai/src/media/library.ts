/**
 * The media folder: where videos live, and what is in it.
 *
 * Videos are deliberately not Wiki.js assets. Wiki.js keeps uploads in its
 * database and loads a whole file into memory the first time it is asked
 * for, so a recording could not be seeked until it had been cached, and
 * the nightly dump would carry every video in all fourteen days of
 * backups. They sit in a folder on this Mac instead, mounted read-only
 * into the container, indexed from there and served from there.
 *
 * Nothing here writes to the folder.
 */
import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** What a browser can play, and what we can read. */
export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'] as const
/** A subtitle file beside the video is used instead of transcribing it. */
export const SUBTITLE_EXTENSIONS = ['.srt', '.vtt'] as const

/** Folders that are someone else's business, not ours. */
const SKIP_FOLDERS = new Set(['.git', 'node_modules', '@eaDir', '.Trash'])
/** Deep enough for any sensible arrangement, shallow enough to be safe. */
const MAX_DEPTH = 8

export interface MediaFile {
  /** Relative to the media folder, with forward slashes. */
  path: string
  fileName: string
  /** Lower case, with the dot. */
  ext: string
  fileSize: number
  modifiedAt: string
  /** The .srt or .vtt beside it, relative, or null. */
  subtitlePath: string | null
  /** Size and time of that subtitle file, so a change to it is noticed. */
  subtitleStamp: string
}

export function isVideoPath (path: string): boolean {
  return VIDEO_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext))
}

export function isSubtitlePath (path: string): boolean {
  return SUBTITLE_EXTENSIONS.some(ext => path.toLowerCase().endsWith(ext))
}

/**
 * What decides whether a video has to be read again.
 *
 * Size and modification time rather than the bytes: hashing a gigabyte on
 * every scan would cost more than the indexing it is meant to avoid. The
 * subtitle file counts too, because replacing one changes the transcript
 * without touching the video.
 */
export function sourceHashOf (file: MediaFile): string {
  return createHash('sha256')
    .update(`${file.fileSize}:${file.modifiedAt}:${file.subtitleStamp}`)
    .digest('hex')
}

/** A title to show when the file name is all we have. */
export function titleFrom (fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ').trim()
  if (base.length === 0) { return fileName }
  return base.charAt(0).toUpperCase() + base.slice(1)
}

export class MediaLibrary {
  readonly #root: string

  constructor (root: string) {
    this.#root = resolve(root)
  }

  get root (): string {
    return this.#root
  }

  /** False when the folder is not mounted, which switches videos off. */
  async available (): Promise<boolean> {
    try {
      return (await stat(this.#root)).isDirectory()
    } catch {
      return false
    }
  }

  /** Every video in the folder, with the subtitle file beside it. */
  async list (): Promise<MediaFile[]> {
    const found: MediaFile[] = []
    const subtitles = new Map<string, { path: string, stamp: string }>()
    const videos: Array<{ path: string, size: number, modified: Date }> = []

    await this.#walk('', 0, (path, size, modified) => {
      if (isVideoPath(path)) {
        videos.push({ path, size, modified })
      } else if (isSubtitlePath(path)) {
        // Keyed by the name without its extension, so demo.srt is found
        // for demo.mp4. A .vtt wins over a .srt of the same name.
        const stem = path.replace(/\.[^.]+$/, '')
        const existing = subtitles.get(stem)
        if (!existing || path.toLowerCase().endsWith('.vtt')) {
          subtitles.set(stem, { path, stamp: `${size}:${modified.toISOString()}` })
        }
      }
    })

    for (const video of videos) {
      const stem = video.path.replace(/\.[^.]+$/, '')
      const subtitle = subtitles.get(stem)
      found.push({
        path: video.path,
        fileName: video.path.split('/').pop() ?? video.path,
        ext: extensionOf(video.path),
        fileSize: video.size,
        modifiedAt: video.modified.toISOString(),
        subtitlePath: subtitle?.path ?? null,
        subtitleStamp: subtitle?.stamp ?? ''
      })
    }

    return found.sort((a, b) => a.path.localeCompare(b.path))
  }

  /**
   * The absolute path of one relative path, or null.
   *
   * Everything that reaches the filesystem goes through here: a path that
   * climbs out of the folder, or is absolute to begin with, is refused
   * rather than cleaned up, so a request for ../../etc/passwd cannot be
   * turned into something that resolves.
   */
  resolveFile (relativePath: string): string | null {
    const cleaned = relativePath.replace(/^\/+/, '')
    if (cleaned.length === 0 || isAbsolute(cleaned) || cleaned.includes('\0')) { return null }
    const full = resolve(this.#root, cleaned)
    const inside = relative(this.#root, full)
    if (inside.length === 0 || inside.startsWith('..') || isAbsolute(inside)) { return null }
    if (inside.split(sep).some(part => part.startsWith('.'))) { return null }
    return full
  }

  async #walk (
    folder: string,
    depth: number,
    seen: (path: string, size: number, modified: Date) => void
  ): Promise<void> {
    if (depth > MAX_DEPTH) { return }
    let entries
    try {
      entries = await readdir(join(this.#root, folder), { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      // Dot files, macOS resource forks and the folders above.
      if (entry.name.startsWith('.') || SKIP_FOLDERS.has(entry.name)) { continue }
      const path = folder.length > 0 ? `${folder}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await this.#walk(path, depth + 1, seen)
        continue
      }
      if (!entry.isFile()) { continue }
      if (!isVideoPath(path) && !isSubtitlePath(path)) { continue }
      try {
        const info = await stat(join(this.#root, path))
        seen(path, info.size, info.mtime)
      } catch {
        // Gone between the listing and the stat; the next scan will see it.
      }
    }
  }
}

function extensionOf (path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}
