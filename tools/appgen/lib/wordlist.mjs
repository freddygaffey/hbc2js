// tools/appgen/lib/wordlist.mjs — fixed word pools for seeded, distinctive
// screen/app names (docs/specs/09-fuzzing.md §2.1 "seeded names").
// Deliberately small and fixed: determinism depends on this list never
// changing shape under a given seed (see generate.test.ts).

export const SCREEN_ADJECTIVES = [
  "Nebula", "Copper", "Falcon", "Amber", "Quartz", "Cobalt", "Ember", "Willow",
  "Granite", "Indigo", "Sable", "Ochre", "Lyric", "Marble", "Onyx", "Saffron",
];

export const SCREEN_NOUNS = [
  "Ledger", "Compass", "Harbor", "Signal", "Atlas", "Kettle", "Meadow", "Forge",
  "Beacon", "Vault", "Prism", "Anchor", "Grove", "Ridge", "Cove", "Bramble",
];
