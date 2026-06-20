// Seeded pseudo-random number generator — the foundation of a reproducible Luthadel.
// One seed builds one identical city (its collision world `ROOFS` + push/pull `METALS`),
// which is exactly what multiplayer needs: the authoritative server and every client must
// generate the *same* map from a shared seed. (See PVP_ARCHITECTURE.md, Phase 0.)
//
// mulberry32: tiny, fast, decent distribution, and deterministic across V8 (browser === Node),
// so the future server and the client will agree bit-for-bit.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
