/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


// Regression test: /\w/iu must match characters whose Unicode canonical form
// is a word character (e.g. U+212A KELVIN SIGN folds to 'k').

// U+212A KELVIN SIGN should match \w only with /iu flags.
print(/\w/iu.test('\u212A'));
print(/\w/.test('\u212A'));
print(/\w/u.test('\u212A'));
print(/\w/i.test('\u212A'));

// Inverted class: \W with /iu should NOT match KELVIN SIGN.
print(/\W/iu.test('\u212A'));

// U+017F LATIN SMALL LETTER LONG S folds to 's'.
print(/\w/iu.test('\u017F'));
print(/\w/.test('\u017F'));

// Bracket expression with \w.
print(/[\w]/iu.test('\u212A'));
print(/[\w]/iu.test('\u017F'));

// Negated bracket with \W.
print(/[^\w]/iu.test('\u212A'));
