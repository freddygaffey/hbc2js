// F24-3 regression: hermesc reuses the same register for a class's
// constructor and its .prototype whenever nothing keeps a live reference to
// the prototype object across the CreateBaseClass/CreateDerivedClass
// instruction (verified by disassembly at v98 and v99 -- see
// docs/BUGS.md and docs/specs/passes/24-class-recover.md section 1.4/6.6).
// Static-only classes with an unused `new` trigger this for both opcodes:
// `CreateBaseClass rX, rX, ...` for the base class below, and
// `CreateDerivedClass rY, rY, ...` for the derived one. Before the fix, the
// emitter's second `set()` clobbered the constructor value with
// `<ctor>.prototype`, so the static installs landed on the prototype and the
// later bare `new` calls threw "is not a constructor" against the
// decompiled output even though the real bytecode is unaffected.
class Base {
  static make() { return 1; }
}
print(Base.make());
new Base();

class Super {
  static tag() { return 2; }
}
class Sub extends Super {
  static tag() { return 3; }
}
print(Super.tag(), Sub.tag());
new Sub();
print(4);
