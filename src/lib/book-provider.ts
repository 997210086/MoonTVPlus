import {
  BookCatalogResult,
  BookDetail,
  BookListItem,
  BookSearchFailure,
  BookSearchResult,
  BookSource,
} from './book.types';
import { legadoClient } from './legado.client';
import { opdsClient } from './opds.client';

const DEFAULT_SEARCH_SOURCE_LIMIT = 16;
const DEFAULT_SEARCH_CONCURRENCY = 4;

function sourceKind(source?: Pick<BookSource, 'type'>) {
  return source?.type === 'legado' || (source as BookSource | undefined)?.legado
    ? 'legado'
    : 'opds';
}

function positiveInt(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(max, Math.floor(parsed))
    : fallback;
}

function isUsableSearchSource(source: BookSource) {
  if (
    source.enabled === false ||
    source.capabilities?.searchSupported === false
  )
    return false;
  try {
    const url = new URL(source.url);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.hostname.endsWith('.invalid')
    );
  } catch {
    return false;
  }
}

function hasDynamicRule(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return /@js:|<js>|java\.|this\.|cache\./i.test(text);
}

function searchSourceScore(source: BookSource) {
  if (source.type !== 'legado' || !source.legado) return 100;
  let score = 0;
  if (!hasDynamicRule(source.legado.searchUrl)) score += 50;
  if (!hasDynamicRule(source.legado.ruleSearch)) score += 25;
  if (!hasDynamicRule(source.legado.ruleContent)) score += 15;
  if (!source.legado.enabledCookieJar) score += 10;
  return score;
}

function selectSearchSources(sources: BookSource[]) {
  const limit = positiveInt(
    process.env.BOOK_SEARCH_MAX_SOURCES,
    DEFAULT_SEARCH_SOURCE_LIMIT,
    40
  );
  const usable = sources.filter(isUsableSearchSource);
  const selected = usable
    .map((source, index) => ({
      source,
      index,
      score: searchSourceScore(source),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((item) => item.source);
  return { sources: selected, availableSources: usable.length };
}

export class BookProvider {
  async getSources(): Promise<BookSource[]> {
    const [opdsSources, legadoSources] = await Promise.all([
      opdsClient.getSources().catch(() => []),
      legadoClient.getSources().catch(() => []),
    ]);
    return [
      ...opdsSources.map((source) => ({
        ...source,
        type: source.type || ('opds' as const),
      })),
      ...legadoSources,
    ];
  }

  async getSourceById(sourceId: string): Promise<BookSource> {
    const sources = await this.getSources();
    const source = sources.find((item) => item.id === sourceId);
    if (!source) throw new Error('未找到对应的电子书源');
    return source;
  }

  async getCatalog(
    sourceId: string,
    href?: string
  ): Promise<BookCatalogResult> {
    const source = await this.getSourceById(sourceId);
    return sourceKind(source) === 'legado'
      ? legadoClient.getCatalog(sourceId, href)
      : opdsClient.getCatalog(sourceId, href);
  }

  async getSearchSources(sourceId?: string): Promise<BookSource[]> {
    return (await this.getSearchSourceSelection(sourceId)).sources;
  }

  async getSearchSourceSelection(sourceId?: string): Promise<{
    sources: BookSource[];
    availableSources: number;
  }> {
    if (sourceId)
      return {
        sources: [await this.getSourceById(sourceId)],
        availableSources: 1,
      };
    return selectSearchSources(await this.getSources());
  }

  async searchBooksSource(
    q: string,
    source: BookSource
  ): Promise<{ source: BookSource; results: BookListItem[] }> {
    return sourceKind(source) === 'legado'
      ? legadoClient.searchBooksSource(q, source)
      : opdsClient.searchBooksSource(q, source);
  }

  async searchBooks(q: string, sourceId?: string): Promise<BookSearchResult> {
    const { sources, availableSources } = await this.getSearchSourceSelection(
      sourceId
    );
    const results: BookListItem[] = [];
    const failedSources: BookSearchFailure[] = [];
    const concurrency = positiveInt(
      process.env.BOOK_SEARCH_CONCURRENCY,
      DEFAULT_SEARCH_CONCURRENCY,
      8
    );
    for (let offset = 0; offset < sources.length; offset += concurrency) {
      await Promise.all(
        sources.slice(offset, offset + concurrency).map(async (source) => {
          try {
            const sourceResult = await this.searchBooksSource(q, source);
            results.push(...sourceResult.results);
          } catch (error) {
            failedSources.push({
              sourceId: source.id,
              sourceName: source.name,
              error: (error as Error).message,
            });
          }
        })
      );
    }
    return {
      results,
      failedSources,
      searchedSources: sources.length,
      availableSources,
    };
  }

  async getBookDetail(
    sourceId: string,
    href: string,
    fallback?: Partial<BookDetail>
  ): Promise<BookDetail> {
    const source = await this.getSourceById(sourceId);
    return sourceKind(source) === 'legado'
      ? legadoClient.getBookDetail(sourceId, href, fallback)
      : opdsClient.getBookDetail(sourceId, href, fallback);
  }

  async getPreferredAcquisition(
    sourceId: string,
    href: string
  ): Promise<{ format: 'epub' | 'pdf' | 'chapters'; href: string }> {
    const source = await this.getSourceById(sourceId);
    if (sourceKind(source) === 'legado') {
      const detail = await legadoClient.getBookDetail(sourceId, href);
      const chapters =
        detail.acquisitionLinks.find(
          (item) => item.type === 'application/x-legado-chapters+json'
        ) || detail.acquisitionLinks[0];
      if (!chapters?.href) throw new Error('当前书籍没有可用章节目录');
      return { format: 'chapters', href: chapters.href };
    }
    return opdsClient.getPreferredAcquisition(sourceId, href);
  }
}

export const bookProvider = new BookProvider();
