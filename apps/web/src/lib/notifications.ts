export async function notificationRequest(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/backend/notifications/${path}`, {
    cache: 'no-store',
    signal,
    ...(body !== undefined
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error?.message ?? 'Notification request failed');
  return data;
}
