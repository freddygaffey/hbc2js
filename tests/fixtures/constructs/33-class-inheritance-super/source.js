// extends with super() in the constructor and super.method() calls.
class Animal {
  constructor(name) {
    this.name = name;
  }
  speak() {
    return this.name + ' makes a sound';
  }
  describe() {
    return 'Animal:' + this.name;
  }
}
class Dog extends Animal {
  constructor(name, breed) {
    super(name);
    this.breed = breed;
  }
  speak() {
    return super.speak() + ' (specifically, barks)';
  }
  describe() {
    return super.describe() + ', breed=' + this.breed;
  }
}
class Puppy extends Dog {
  speak() {
    return super.speak() + ' [in a tiny voice]';
  }
}
const a = new Animal('Generic');
const d = new Dog('Rex', 'Labrador');
const pu = new Puppy('Tiny', 'Poodle');
print(a.speak());
print(d.speak());
print(d.describe());
print(pu.speak());
print(pu instanceof Dog, pu instanceof Animal);
