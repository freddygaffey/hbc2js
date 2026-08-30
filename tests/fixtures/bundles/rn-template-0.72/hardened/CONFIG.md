# rn-template-0.72/hardened — config only, binary not committed

Per `docs/DECISIONS.md` D13/D16 (C4: hardened builds of C3), one obfuscated
variant of `../index.android.bundle` was to be compiled with hermesc v94
`-O` and committed here. It was generated and measured, then deleted:

| Stage | Size |
|---|---|
| `index.android.bundle` (input, unminified original) | 804 KB |
| `index.android.obf.bundle` (javascript-obfuscator output) | 8.82 MB |
| `index.android.hbc` (hermesc v94 `-O` compiled) | 6.74 MB |

6.74 MB exceeds the 3 MB commit threshold for this fixture, so per the task
spec **neither the obfuscated `.bundle` nor the compiled `.hbc` is committed**
— only this config file and the exact regeneration command.

## javascript-obfuscator config used (pinned `javascript-obfuscator@5.6.0`)

Same as `tests/fixtures/OBFUSCATION.md`'s construct-fixture config, except
`controlFlowFlatteningThreshold` is lowered to keep output size manageable
on a real ~800 KB bundle (a full `1.0` threshold, as used for the small
`constructs/` fixtures, was even larger — not measured to completion here
since 0.75 already exceeds the cap):

```json
{
  "controlFlowFlattening": true,
  "controlFlowFlatteningThreshold": 0.75,
  "stringArray": true,
  "stringArrayRotate": true,
  "stringArrayShuffle": true,
  "stringArrayEncoding": ["rc4"],
  "deadCodeInjection": true,
  "numbersToExpressions": true,
  "splitStrings": true,
  "selfDefending": false,
  "compact": false
}
```

## Exact regeneration command

```sh
cd /tmp/hardened-regen   # any scratch dir — do not add javascript-obfuscator
                          # as a repo dependency (see tests/fixtures/OBFUSCATION.md)
npm init -y
npm install javascript-obfuscator@5.6.0

node -e '
const fs = require("fs");
const JavaScriptObfuscator = require("javascript-obfuscator");
const src = fs.readFileSync("/Users/fred/hbc2js/tests/fixtures/bundles/rn-template-0.72/index.android.bundle", "utf8");
const result = JavaScriptObfuscator.obfuscate(src, {
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  stringArray: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayEncoding: ["rc4"],
  deadCodeInjection: true,
  numbersToExpressions: true,
  splitStrings: true,
  selfDefending: false,
  compact: false,
});
fs.writeFileSync("index.android.obf.bundle", result.getObfuscatedCode());
'

/path/to/tools/hermesc/v94/hermesc -O -emit-binary -out=index.android.hbc index.android.obf.bundle
# -> 6.74 MB as of 2026-08-30; re-measure if javascript-obfuscator or the
#    source bundle ever changes, and only commit if a future run drops
#    at or under 3 MB (e.g. a lower controlFlowFlatteningThreshold).
```

If a smaller variant is ever wanted for the gate/sweep, the obvious knob to
try first is lowering `controlFlowFlatteningThreshold` further (it directly
controls how much of the bundle's control flow gets the expensive
dispatcher-loop rewrite that dominates the size increase — see
`tests/fixtures/OBFUSCATION.md`'s control-check findings on `constructs/`
for why: control-flow flattening multiplies basic-block count and
instruction count several-fold per function it touches).
