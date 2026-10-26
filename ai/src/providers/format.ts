/**
 * Turning a model id into something a reader recognises.
 *
 * On its own, with no imports, because the configuration needs it to
 * build the picker's labels and the providers need it too — and a
 * provider importing the configuration that imports it back would be a
 * cycle.
 */

/** "claude-sonnet-5-5" -> "Claude Sonnet 5.5"; unknown shapes pass through. */
export function formatAnthropicModel (model: string): string {
  const parts = model.split('-')
  if (parts[0] !== 'claude' || parts.length < 2) { return model }
  const rest = parts.slice(1).filter(part => !/^\d{8}$/.test(part))
  const name = rest[0]
  if (!name) { return model }
  const version = rest.slice(1).join('.')
  const title = name.charAt(0).toUpperCase() + name.slice(1)
  return version ? `Claude ${title} ${version}` : `Claude ${title}`
}
