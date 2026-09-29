import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { HistoryModule } from '../src/modules/history/index.js';
import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';

/**
 * Regressions for the Greptile review of AF #173 (semantic sync edge cases).
 * Each case was red before the fix it names.
 */

interface Item { id: string; text: string; ts?: number; channel?: string | null; kind: string; level?: number; cursor?: number }

/** Minimal embed-service: dedup by id, cursor-aware stats, counts requests. */
class FakeService {
  items = new Map<string, Item>();
  calls: string[] = [];
  deleted: string[] = [];
  server!: Server;
  url = '';
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const m = /^\/v1\/index\/([^/]+)\/(stats|upsert|search|delete)$/.exec(req.url ?? '');
        this.calls.push(m?.[2] ?? '?');
        const json = (code: number, o: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (!m) return json(404, {});
        if (m[2] === 'stats') {
          if (this.items.size === 0) return json(404, { error: { message: 'no such namespace' } });
          const by: Record<string, { count: number; max_ts: null; min_ts: null; max_cursor: number | null }> = {};
          for (const it of this.items.values()) {
            const d = by[it.kind] ??= { count: 0, max_ts: null, min_ts: null, max_cursor: null };
            d.count++;
            if (it.cursor !== undefined) d.max_cursor = d.max_cursor === null ? it.cursor : Math.max(d.max_cursor, it.cursor);
          }
          return json(200, { namespace: 'n', model: 'fake', dim: 1, count: this.items.size, by_kind: by });
        }
        if (m[2] === 'upsert') {
          const items = (JSON.parse(body) as { items: Item[] }).items;
          let inserted = 0, unchanged = 0;
          for (const it of items) { if (this.items.get(it.id)?.text === it.text) unchanged++; else inserted++; this.items.set(it.id, it); }
          return json(200, { inserted, updated: 0, unchanged, count: this.items.size });
        }
        if (m[2] === 'delete') {
          const ids = (JSON.parse(body) as { ids: string[] }).ids;
          let n = 0; for (const id of ids) if (this.items.delete(id)) n++;
          this.deleted.push(...ids);
          return json(200, { deleted: n });
        }
        return json(200, { namespace: 'n', hits: [], count_indexed: this.items.size, timing_ms: { embed: 0, search: 0 } });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const a = this.server.address();
    this.url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  }
  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}

type Listener = (e: { type: string; messageId?: string }) => void;

function msg(id: string, ms: number, content: ContentBlock[] | string, metadata?: Record<string, unknown>): StoredMessage {
  return {
    id, sequence: Number(id.replace(/\D/g, '')), participant: 'Linn',
    content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
    timestamp: new Date(ms), metadata,
  } as unknown as StoredMessage;
}

/** Stub CM following the real contracts: inclusive bounds, oldest first, offset then limit, onMessage events. */
class StubCm {
  listeners = new Set<Listener>();
  constructor(public messages: StoredMessage[], public summaries: Array<Record<string, unknown>> = []) {}
  queryMessagesByTime(o: { fromMs?: number; toMs?: number; limit?: number; offset?: number }) {
    const all = this.messages
      .filter((m) => (o.fromMs === undefined || m.timestamp.getTime() >= o.fromMs) && (o.toMs === undefined || m.timestamp.getTime() <= o.toMs))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.sequence - b.sequence);
    const off = o.offset ?? 0;
    return { messages: all.slice(off, o.limit === undefined ? undefined : off + o.limit), totalCount: all.length };
  }
  getSummariesInRange() { return this.summaries; }
  getMessage(id: string) { return this.messages.find((m) => m.id === id) ?? null; }
  getSummary(id: string) { return this.summaries.find((s) => s.id === id) ?? null; }
  onMessage(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }
  edit(id: string, text: string) {
    const m = this.getMessage(id)!;
    (m as { content: ContentBlock[] }).content = [{ type: 'text', text }];
    for (const l of this.listeners) l({ type: 'edit', messageId: id });
  }
  remove(id: string) {
    this.messages = this.messages.filter((m) => m.id !== id);
    for (const l of this.listeners) l({ type: 'remove', messageId: id });
  }
}

const T0 = Date.UTC(2026, 8, 22);

describe('semantic sync: Greptile #173 findings', () => {
  const svc = new FakeService();
  before(() => svc.start());
  after(() => svc.stop());
  beforeEach(() => { svc.items.clear(); svc.calls.length = 0; svc.deleted.length = 0; });

  function mod(cm: StubCm): HistoryModule {
    const m = new HistoryModule({ semantic: { url: svc.url, namespace: 'n', syncIntervalMs: 0 } });
    m.bind(cm as unknown as ContextManager);
    return m;
  }

  it('#2 indexes the channel from metadata.channelId (MCPL ingestion shape), not only metadata.external.channelId', async () => {
    const m = mod(new StubCm([
      msg('m1', T0, 'hello from the mcpl side of things', { channelId: 'chan-mcpl' }),
      msg('m2', T0 + 1, 'hello from the legacy discord shape', { external: { channelId: 'chan-ext' } }),
    ]));
    await m.syncSemanticIndex();
    assert.equal(svc.items.get('msg:m1')?.channel, 'chan-mcpl');
    assert.equal(svc.items.get('msg:m2')?.channel, 'chan-ext');
    await m.stop();
  });

  it('#3 more than one page of messages sharing one millisecond are all indexed', async () => {
    const store = Array.from({ length: 600 }, (_, i) => msg(`m${i}`, T0, `same-millisecond message ${i}`));
    const m = mod(new StubCm(store));
    for (let i = 0; i < 5; i++) await m.syncSemanticIndex(10_000);
    assert.equal(svc.items.size, 600);
    await m.stop();
  });

  it('#5 a message backlog larger than the tick budget does not starve new summaries', async () => {
    const store = Array.from({ length: 2000 }, (_, i) => msg(`m${i}`, T0 + i * 1000, `backlog message ${i}`));
    const summaries = [{ id: 's1', level: 1, content: 'a fresh summary', tokens: 3, startMs: T0, endMs: T0 + 1, firstSequence: 0, lastSequence: 1, createdMs: T0 + 5 }];
    const m = mod(new StubCm(store, summaries));
    const r = await m.syncSemanticIndex(300)!;
    assert.equal(r.more, true);
    assert.ok(svc.items.has('sum:s1'), 'summary indexed while the message backlog is still draining');
    await m.stop();
  });

  it('#6 an edit to a message older than the overlap window reaches the index on the next sync', async () => {
    const cm = new StubCm([msg('old', T0, 'the original wording'), msg('new', T0 + 3_600_000, 'an hour later')]);
    const m = mod(cm);
    await m.syncSemanticIndex();
    cm.edit('old', 'the corrected wording');
    await m.syncSemanticIndex();
    assert.equal(svc.items.get('msg:old')?.text, 'the corrected wording');
    await m.stop();
  });

  it('#1 a removed message is deleted from the index on the next sync', async () => {
    const cm = new StubCm([msg('gone', T0, 'something that gets deleted'), msg('kept', T0 + 1, 'something that stays')]);
    const m = mod(cm);
    await m.syncSemanticIndex();
    cm.remove('gone');
    await m.syncSemanticIndex();
    assert.deepEqual(svc.deleted, ['msg:gone']);
    assert.ok(!svc.items.has('msg:gone'));
    assert.ok(svc.items.has('msg:kept'));
    await m.stop();
  });

  it('#8 a short private note is still indexed', async () => {
    const m = mod(new StubCm([msg('t', T0, [{ type: 'tool_use', id: 'x', name: 'think', input: { content: 'wait for Ben' } }] as ContentBlock[])]));
    await m.syncSemanticIndex();
    assert.equal(svc.items.get('msg:t')?.text, '[think] wait for Ben');
    await m.stop();
  });
});
