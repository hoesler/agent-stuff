# Python Code Standards

Apply to all Python code that is not a throwaway script or one-off snippet. Treat violations as bugs, not style preferences.

## Basics

- Type-annotate all function signatures (parameters and return types)
- Use `@dataclass` for internal data containers (`frozen=True` for value objects). Use pydantic `BaseModel` at validation boundaries (API input, config, external data). No manual `__init__` boilerplate for either case
- Only use a class when it has meaningful state; if `self` never accesses attributes, use plain functions
- Respect `_private` members — never access from outside the class or module
- Use `__all__` to declare module public API

## Architecture

### Dependency Inversion
Depend on abstractions (`Protocol`, `ABC`), not concrete implementations. Accept dependencies via constructor injection — never create side effects (DB connections, HTTP clients) in `__init__`.

```python
# ❌ def __init__(self): self.db = psycopg2.connect(...)
# ✅
class WeatherRepository(Protocol):
    def get_cached(self, city: str) -> dict | None: ...

class WeatherService:
    def __init__(self, repo: WeatherRepository): self.repo = repo
```

### Law of Demeter
Talk to direct collaborators only. More than one dot reaching into data (not fluent/builder APIs) is a violation.

```python
# ❌ city = order.customer.address.city  — coupled to entire chain
# ✅ city = order.customer_city()  — delegate to direct collaborator
```

### Composition Over Inheritance
Max 1 level of inheritance for behavior. Use `Protocol`-typed attributes to compose capabilities. Framework base classes (Django Model) and ABCs are fine.

```python
# ❌ Animal → Mammal → Pet → Dog (breaks when you need a swimming dog)
# ✅
class Speaker(Protocol):
    def speak(self) -> str: ...

@dataclass
class Animal:
    name: str
    voice: Speaker | None = None  # compose, don't inherit
```

### Separation of Concerns
- No SQL, Redis commands, or HTTP status codes in business logic — hide infrastructure behind a Protocol (Repository Pattern)
- Domain objects hold data and core invariants. Services orchestrate with injected dependencies
- One class = one concern. A class with 10+ methods covering unrelated things is a god object — split it

### Testing Architecture
Deep mock chains (`mock.return_value.foo.return_value.bar`) are a design smell, not a testing problem. If mock setup is longer than test logic, fix the architecture. Use fakes with real behavior for complex dependencies.

## Python-Specific Traps

### Mutable Default Arguments
```python
# ❌ Shared across all calls — appending mutates the default for everyone
def add_item(item: str, items: list[str] = []) -> list[str]: ...

# ✅
def add_item(item: str, items: list[str] | None = None) -> list[str]:
    if items is None:
        items = []
```

### Exception Handling
```python
# ❌ Swallows KeyboardInterrupt, SystemExit, and hides real bugs
except Exception: pass

# ✅ Catch specific exceptions, let unexpected ones propagate
except (ConnectionError, TimeoutError) as e:
    logger.warning("Request failed: %s", e)
    raise
```

### Context Managers
Always use `with` for resources that need cleanup — files, connections, locks. Especially in error paths.
```python
# ❌ conn = db.connect(); cursor = conn.cursor(); ...  # leaked on exception
# ✅ with db.connect() as conn, conn.cursor() as cursor: ...
```

### Blocking Calls in Async Code
Never call blocking I/O (`requests.get`, `time.sleep`, `open()`) inside `async def`. Use `aiohttp`, `asyncio.sleep`, `aiofiles`, or run in an executor.

### Import-Time Side Effects
Module-level code that connects to databases, reads config files, or creates HTTP clients runs on import — breaks testing, CLI tools, and anything that imports the module for type checking.

## Rationalizations to Reject

- "For consistency" — matching existing bad patterns is not a reason to write bad new code
- "Out of scope" — new code follows these standards regardless of surrounding code quality
- "Don't over-engineer" — dependency inversion and typing cost nothing; tight coupling costs everything
- "We'll refactor after [milestone]" — proper patterns cost the same as improper ones at write time
