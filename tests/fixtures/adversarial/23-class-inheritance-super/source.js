// OOP: class inheritance with super in constructor and methods

class Animal {
  constructor(name) {
    this.name = name;
  }

  speak() {
    return this.name + ' makes sound';
  }
}

class Dog extends Animal {
  constructor(name, breed) {
    super(name);
    this.breed = breed;
  }

  speak() {
    const base = super.speak();
    return base + ' (woof)';
  }

  getInfo() {
    return this.name + '-' + this.breed;
  }
}

const dog = new Dog('Rex', 'Labrador');
print('name:', dog.name);
print('breed:', dog.breed);
print('speak:', dog.speak());
print('info:', dog.getInfo());
