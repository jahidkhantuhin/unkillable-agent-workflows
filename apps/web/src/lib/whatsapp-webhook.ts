import { apiURL } from './server-auth';
/** A single public web tunnel forwards the original form/signature to the local API. */
export async function forwardWhatsApp(
  request: Request,
  kind: 'webhook' | 'status',
) {
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/x-www-form-urlencoded')
  )
    return new Response('Form encoding required', { status: 415 });
  if (!request.body) return new Response('Body required', { status: 400 });
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 65536) {
        await reader.cancel();
        return new Response('Request too large', { status: 413 });
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const response = await fetch(`${apiURL}/notifications/whatsapp/${kind}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': request.headers.get('x-twilio-signature') ?? '',
      },
      body: new TextDecoder().decode(bytes),
      cache: 'no-store',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    });
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'text/xml',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('WhatsApp callback unavailable', {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
