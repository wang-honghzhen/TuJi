/** Small copy-on-write overlays keep drag previews from copying every cached region.
 * Chains are periodically compacted, so discarded previews do not retain an unbounded history. */
export class PersistentMap<K, V> extends Map<K, V> {
  private base?: Map<K, V>;
  private removed = new Set<K>();
  readonly depth: number;
  constructor(base?: Map<K, V>) {
    super();
    const depth = base instanceof PersistentMap ? base.depth + 1 : 1;
    this.depth = depth > 24 ? 1 : depth;
    this.base = depth > 24 ? new Map(base) : base;
  }
  override get(key: K): V | undefined { return super.has(key) ? super.get(key) : this.removed.has(key) ? undefined : this.base?.get(key); }
  override has(key: K): boolean { return super.has(key) || (!this.removed.has(key) && Boolean(this.base?.has(key))); }
  override set(key: K, value: V): this { this.removed.delete(key); return super.set(key, value); }
  override delete(key: K): boolean { const exists = this.has(key); super.delete(key); this.removed.add(key); return exists; }
  override clear(): void { super.clear(); this.base = undefined; this.removed.clear(); }
  override *entries(): MapIterator<[K, V]> {
    if (this.base) for (const [key, value] of this.base) if (!super.has(key) && !this.removed.has(key)) yield [key, value];
    yield* super.entries();
  }
  override [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
  override *keys(): MapIterator<K> { for (const [key] of this.entries()) yield key; }
  override *values(): MapIterator<V> { for (const [, value] of this.entries()) yield value; }
  override forEach(fn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) fn.call(thisArg, value, key, this);
  }
  override get size(): number { let size = 0; for (const _ of this.keys()) { void _; size++; } return size; }
}


