/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */


function checkArgs() {
  print(arguments.length);
  // check template object
  print(Object.isFrozen(arguments[0]), JSON.stringify(arguments[0]), arguments[0].length);
  // check raw object
  print(Object.isFrozen(arguments[0].raw), JSON.stringify(arguments[0].raw), arguments[0].raw.length);
  // print substitutions
  print(JSON.stringify(Array.prototype.slice.call(arguments, 1)));
}

checkArgs``;
checkArgs`${111}hello${222}`;
checkArgs`${111}hello\n${222}`;
checkArgs`hello ${666} world!`;
(function () {
    return checkArgs;
})()`hello ${666} world!`;
var obj1 = {func: checkArgs};
obj1.func`hello${`world${666}!`}!${888}`;

print(String.raw`hello${1} world${2}\n${3}`);
print(String.raw`hello
world`);
var animal = "dog";
print(String.raw`hello ${animal}!`);
print(String.raw`Hi\u000A there!`);
print(String.raw`\u548C${1 + 1}\u5E73`);
