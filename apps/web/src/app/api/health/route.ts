import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/health`,
      { cache: 'no-store', signal: AbortSignal.timeout(3500) },
    );
    return NextResponse.json(await response.json(), {
      status: response.status,
    });
  } catch {
    return NextResponse.json({ error: 'API unavailable' }, { status: 503 });
  }
}
