import { NextRequest, NextResponse } from 'next/server';

import { bookProvider } from '@/lib/book-provider';

import { getAuthorizedBooksUsername } from '../_utils';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const username = await getAuthorizedBooksUsername(request);
  if (username instanceof NextResponse) return username;

  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim();
    const sourceId = searchParams.get('sourceId')?.trim() || undefined;
    const offset = Math.max(0, Number(searchParams.get('offset')) || 0);
    const limit = Math.min(
      40,
      Math.max(1, Number(searchParams.get('limit')) || 32)
    );
    if (!q) {
      return NextResponse.json({ results: [], failedSources: [] });
    }
    const batch = await bookProvider.getSearchSourceBatch(
      sourceId,
      offset,
      limit
    );
    const result = await bookProvider.searchBooks(q, sourceId, batch.sources);
    return NextResponse.json({
      ...result,
      searchedSources: offset + batch.sources.length,
      availableSources: batch.availableSources,
      nextOffset: batch.nextOffset,
      exhausted: batch.nextOffset >= batch.availableSources,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
