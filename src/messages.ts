export function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

export function lastUserMessages(
  messages: readonly { type?: unknown; text?: unknown }[],
  count: number,
  maxChars: number,
): string[] {
  if (count <= 0) return []
  return messages
    .flatMap((m) => (m.type === "user" && typeof m.text === "string" && m.text.trim() ? [m.text.trim()] : []))
    .slice(-count)
    .map((text) => clip(text, maxChars))
}
