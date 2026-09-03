export type SnapshotListener = (
  snapshot: KitchenDisplayProtocol.DisplaySnapshot,
) => void;

export class DisplayEvents {
  readonly #listeners = new Set<SnapshotListener>();

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  publish(snapshot: KitchenDisplayProtocol.DisplaySnapshot): void {
    for (const listener of this.#listeners) {
      listener(snapshot);
    }
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
