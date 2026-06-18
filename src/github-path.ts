export function encodedPathSegments(segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split("/"))
    .map(encodeURIComponent)
    .join("/");
}

export function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
