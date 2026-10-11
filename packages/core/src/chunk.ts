export function chunkText(text: string, maxLen: number): string[] {
  if (maxLen <= 0) throw new Error("maxLen must be > 0");
  if (text.length === 0) return [""];
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    const splitAt = findSplit(window);
    const chunk = rest.slice(0, splitAt).trimEnd();
    if (chunk.length === 0) {
      chunks.push(rest.slice(0, maxLen));
      rest = rest.slice(maxLen);
    } else {
      chunks.push(chunk);
      rest = rest.slice(splitAt).trimStart();
    }
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function findSplit(window: string): number {
  const para = window.lastIndexOf("\n\n");
  if (para >= Math.floor(window.length * 0.4)) return para;
  const line = window.lastIndexOf("\n");
  if (line >= Math.floor(window.length * 0.4)) return line;
  const space = window.lastIndexOf(" ");
  if (space >= Math.floor(window.length * 0.4)) return space;
  return avoidSurrogate(window, window.length);
}

function avoidSurrogate(text: string, index: number): number {
  if (index <= 0) return index;
  const code = text.charCodeAt(index - 1);
  if (code >= 0xd800 && code <= 0xdbff) return Math.max(1, index - 1);
  return index;
}
