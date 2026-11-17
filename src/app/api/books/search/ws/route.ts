import { NextRequest, NextResponse } from 'next/server';

import { bookProvider } from '@/lib/book-provider';

import { getAuthorizedBooksUsername } from '../../_utils';

export const runtime = 'nodejs';

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request: NextRequest) {
  const username = await getAuthorizedBooksUsername(request);
  if (username instanceof NextResponse) return username;

  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q')?.trim();
  const sourceId = searchParams.get('sourceId')?.trim() || undefined;
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0);
  const limit = Math.min(
    40,
    Math.max(1, Number(searchParams.get('limit')) || 32)
  );

  if (!q) {
    return NextResponse.json({ error: '缺少搜索关键词' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(payload)));
        } catch {
          closed = true;
        }
      };

      try {
        const { sources, availableSources, nextOffset } =
          await bookProvider.getSearchSourceBatch(sourceId, offset, limit);
        let completedSources = 0;
        let totalResults = 0;
        const failedSources: Array<{
          sourceId: string;
          sourceName: string;
          error: string;
        }> = [];

        send({
          type: 'start',
          totalSources: sources.length,
          availableSources,
          nextOffset,
        });

        const concurrency = Math.min(
          8,
          Math.max(1, Number(process.env.BOOK_SEARCH_CONCURRENCY) || 4)
        );
        for (let offset = 0; offset < sources.length; offset += concurrency) {
          await Promise.all(
            sources.slice(offset, offset + concurrency).map(async (source) => {
              try {
                const result = await bookProvider.searchBooksSource(q, source);
                completedSources += 1;
                totalResults += result.results.length;
                send({
                  type: 'source_result',
                  sourceId: source.id,
                  sourceName: source.name,
                  results: result.results,
                  completedSources,
                  totalSources: sources.length,
                });
              } catch (error) {
                const failure = {
                  sourceId: source.id,
                  sourceName: source.name,
                  error: error instanceof Error ? error.message : '未知错误',
                };
                completedSources += 1;
                failedSources.push(failure);
                send({
                  type: 'source_error',
                  ...failure,
                  completedSources,
                  totalSources: sources.length,
                });
              }
            })
          );
        }

        send({
          type: 'complete',
          completedSources,
          totalSources: sources.length,
          searchedSources: offset + sources.length,
          availableSources,
          nextOffset,
          totalResults,
          failedSources,
          exhausted: nextOffset >= availableSources,
        });
      } catch (error) {
        send({
          type: 'error',
          error: error instanceof Error ? error.message : '搜索失败',
        });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // ignore client disconnect races
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
