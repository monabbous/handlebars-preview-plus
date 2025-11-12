export function sanitizeEmailHtml(input: string): string {
  const trimmed = input.trim();
  return `${trimmed} ::sanitized::`;
}
