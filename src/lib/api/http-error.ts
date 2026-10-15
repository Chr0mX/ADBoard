/**
 * One readable sentence for a failed agent request. Reverse proxies and
 * Cloudflare answer errors with whole HTML pages; the UI shows a line instead.
 */
export function httpErrorMessage(status: number, body: string, fallback: string): string {
  const text = body.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const message = parsed.error ?? parsed.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    } catch {
      // not JSON after all
    }
  }
  const html = /^<!doctype|^<html|<body[\s>]/i.test(text);
  if (text && !html) return text.length > 300 ? `${text.slice(0, 300)}…` : text;

  switch (status) {
    case 413:
      return "File too large for the proxy. Cloudflare accepts at most 100 MB per upload on Free and Pro plans.";
    case 502:
    case 503:
    case 504:
      return `The proxy could not reach Rasiel (${status}). Check that Rasiel is running and the proxy forwards to the right port.`;
    case 520:
    case 521:
    case 522:
    case 523:
    case 525:
    case 526:
      return `Cloudflare could not reach the server behind it (${status}). Check the proxy host and the Cloudflare SSL mode.`;
    case 524:
      return "Cloudflare timed out waiting for Rasiel (524). The request ran longer than 100 seconds.";
    case 0:
      return fallback;
    default:
      return html ? `${fallback} (${status})` : fallback;
  }
}

/** Error for a non-OK response, reading its body once. */
export async function responseError(res: Response, fallback: string): Promise<Error> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    // body unavailable
  }
  return new Error(httpErrorMessage(res.status, body, `${fallback}: ${res.status}`));
}
