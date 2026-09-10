export type Rng = { readonly state: number; readonly value: number };

const MASK = 0xffffffff;

export const nextRng = (state: number): Rng => {
  let x = state >>> 0;
  if (x === 0) x = 0x9e3779b9;
  x ^= (x << 13) & MASK;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= (x << 5) & MASK;
  x >>>= 0;
  return { state: x, value: x / 0x100000000 };
};

export const seedFrom = (text: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h === 0 ? 0x9e3779b9 : h;
};
