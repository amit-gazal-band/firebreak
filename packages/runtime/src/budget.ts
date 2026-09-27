/** Shared per-match spend tracker (SPEC §6.3). */
export class Budget {
  tokens = 0;
  usd = 0;
  private perWorld = new Map<string, { tokens: number; usd: number }>();

  constructor(
    readonly limitUsd: number,
    readonly limitTokens: number,
    private onExceeded: (reason: string) => void,
  ) {}

  add(worldId: string, tokens: number, usd: number): void {
    this.tokens += tokens;
    this.usd += usd;
    const w = this.perWorld.get(worldId) ?? { tokens: 0, usd: 0 };
    w.tokens += tokens;
    w.usd += usd;
    this.perWorld.set(worldId, w);
    if (this.usd > this.limitUsd)
      this.onExceeded(`budget_usd: spent $${this.usd.toFixed(2)} > $${this.limitUsd}`);
    else if (this.tokens > this.limitTokens)
      this.onExceeded(`budget_tokens: ${this.tokens} > ${this.limitTokens}`);
  }

  world(worldId: string): { tokens: number; usd: number } {
    return this.perWorld.get(worldId) ?? { tokens: 0, usd: 0 };
  }
}
