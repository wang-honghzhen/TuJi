// One ledger per visibility pass. Cached paths also remember which occupied
// port lists they read, including ports used on ancestor shells.
export class PortLedger {
  constructor(records) {
    this.records = records;
    this.seats = new Map();
    this.versions = new Map();
  }

  get(groupId) {
    let seats = this.seats.get(groupId);
    if (!seats) this.seats.set(groupId, seats = []);
    if (this.reads && !this.reads.has(groupId)) {
      this.reads.set(groupId, { before: this.versions.get(groupId), start: seats.length });
    }
    return seats;
  }

  solve(input, calculate) {
    const old = this.records.get(input);
    if (old && old.changes.every(c => c.before === this.versions.get(c.groupId))) {
      for (const c of old.changes) {
        this.get(c.groupId).push(...c.added);
        this.versions.set(c.groupId, c.after);
      }
      return old.result;
    }

    const reads = new Map();
    this.reads = reads;
    let result;
    try { result = calculate(); }
    finally { this.reads = undefined; }

    const changes = [];
    for (const [groupId, { before, start }] of reads) {
      const added = this.seats.get(groupId).slice(start);
      const previous = old?.changes.find(c => c.groupId === groupId);
      // A recalculation forced by the other end need not invalidate this
      // group's later paths if the existing occupants and new seats match.
      const unchanged = previous && previous.before === before && previous.added.length === added.length &&
        added.every(({ p }, i) => p.x === previous.added[i].p.x &&
          p.y === previous.added[i].p.y && p.z === previous.added[i].p.z);
      const after = !added.length ? before : unchanged ? previous.after : {};
      this.versions.set(groupId, after);
      changes.push({ groupId, before, after, added });
    }
    this.records.set(input, { changes, result });
    return result;
  }
}
