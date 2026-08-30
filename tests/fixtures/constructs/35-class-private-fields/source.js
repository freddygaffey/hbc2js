// #private fields and private methods, including in-based brand checks.
// NOTE: private fields are only supported by v99 among the hermesc
// versions this project fetches -- see versions.txt.
class BankAccount {
  #balance;
  #history = [];

  constructor(initial) {
    this.#balance = initial;
  }

  #record(action, amount) {
    this.#history.push(action + ':' + amount);
  }

  deposit(amount) {
    this.#balance += amount;
    this.#record('deposit', amount);
    return this.#balance;
  }

  withdraw(amount) {
    if (amount > this.#balance) {
      throw new Error('insufficient funds');
    }
    this.#balance -= amount;
    this.#record('withdraw', amount);
    return this.#balance;
  }

  get balance() {
    return this.#balance;
  }

  get history() {
    return this.#history.join(',');
  }

  static isAccount(obj) {
    return #balance in obj;
  }
}
const acc = new BankAccount(100);
print('deposit:', acc.deposit(50));
print('withdraw:', acc.withdraw(30));
print('balance:', acc.balance);
print('history:', acc.history);
print('brand check (real account):', BankAccount.isAccount(acc));
print('brand check (plain object):', BankAccount.isAccount({}));
try {
  acc.withdraw(99999);
} catch (e) {
  print('caught:', e.message);
}
