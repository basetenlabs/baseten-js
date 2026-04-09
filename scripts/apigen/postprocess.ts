/**
 * Post-processes generated .d.ts to keep only the root-level schema
 * type aliases and the components type (which they reference).
 * Strips paths, webhooks, operations, $defs, and parameter/response/
 * requestBody root types.
 */

export function postprocessDts(source: string): string {
  const lines = source.split("\n");
  const result: string[] = [];
  let skipping = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!skipping) {
      // Skip multi-line top-level declarations we don't need
      if (/^export (type|interface) (paths|webhooks|operations|\$defs)\b/.test(line)) {
        skipping = true;
        braceDepth = 0;
      }

      // Skip single-line root types for non-schema components
      if (/^export type (Response|Parameter|RequestBody|Header)[A-Z]/.test(line)) {
        continue;
      }
    }

    if (skipping) {
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }
      if (braceDepth <= 0 && (line.endsWith(";") || line === "};" || line === "}")) {
        skipping = false;
      }
      continue;
    }

    result.push(line);
  }

  // Clean up multiple blank lines
  return result.join("\n").replace(/\n{3,}/g, "\n\n");
}
