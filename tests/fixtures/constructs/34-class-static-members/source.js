// Static methods, static properties, and static initializer blocks.
// NOTE: static fields and static {} blocks are only supported by v99
// among the hermesc versions this project fetches -- see versions.txt.
class IdGenerator {
  static nextId = 1;
  static prefix;
  static {
    IdGenerator.prefix = 'ID';
  }
  static generate() {
    return IdGenerator.prefix + '-' + (IdGenerator.nextId++);
  }
  static reset() {
    IdGenerator.nextId = 1;
  }
}
print(IdGenerator.generate());
print(IdGenerator.generate());
print(IdGenerator.generate());
IdGenerator.reset();
print('after reset:', IdGenerator.generate());
print('prefix=' + IdGenerator.prefix);
