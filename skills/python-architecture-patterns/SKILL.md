---
name: python-architecture-patterns
description: Use when writing Python classes or functions that interact with external services (databases, APIs, caches), organizing business logic, or designing testable code - prevents coupling, god objects, and leaky abstractions
---

# Python Architecture Patterns

## Overview

**Architecture determines testability.** If your code requires deep mock chains or real databases to test, the design needs work.

**Core principles:**
- Depend on abstractions (Protocol, ABC), not concrete implementations
- Separate domain logic from infrastructure
- Use classes for state, functions for stateless logic
- Type-annotate everything, use dataclasses for data

## When to Use

Use this skill when:
- Creating classes that talk to databases, APIs, or external services
- Adding caching, notifications, or other infrastructure concerns
- Organizing business logic in models, services, or controllers
- Tests require extensive mocking or real services to run
- Refactoring existing code with mixed concerns
- Designing domain objects or data structures

**Don't use for:**
- Pure algorithms or data processing (no external dependencies)
- Throwaway scripts

## Quick Reference

| Smell | Detection | Fix |
|-------|-----------|-----|
| **Hardcoded Side Effects in `__init__`** | Constructor opens DB, creates HTTP client | Dependency Injection - pass dependencies in |
| **Global State** | Module-level DB/cache clients | Inject dependencies, use factories |
| **Leaky Abstractions** | SQL queries, HTTP codes in business logic | Repository Pattern, Adapter Pattern |
| **Fat Model/Controller** | Model/view has 10+ methods, mixed concerns | Service Layer, separate domain objects |
| **God Object** | One class referenced everywhere | Single Responsibility - split by concern |
| **No Abstraction Layer** | Direct library calls (boto3, requests) everywhere | Protocol/ABC for interfaces |
| **Deep Mock Chains** | `mock.return_value.foo.return_value.bar` | Fix architecture - test real logic with fake deps |
| **Stateless Class** | Class with no attributes, only methods | Use plain functions instead |
| **Deep Inheritance** | 3+ levels of class hierarchy | Composition - objects contain other objects |
| **Manual `__init__` boilerplate** | `self.x = x; self.y = y` for data containers | Use `@dataclass` |
| **Missing Type Hints** | `def process(data):` with no annotations | Add parameter and return type annotations |

## Python Idioms

### 1. Type Hints - Always

Every function and method should have type annotations for parameters and return values. Type hints serve as documentation, enable IDE support, and catch errors before runtime.

**❌ Bad - No type information:**
```python
def process(data):
    result = transform(data)
    return result

def find_users(filters, limit):
    ...
```

**✅ Good - Typed signatures:**
```python
def process(data: dict[str, Any]) -> ProcessedResult:
    result = transform(data)
    return result

def find_users(filters: UserFilters, limit: int = 100) -> list[User]:
    ...
```

For complex types, use type aliases to keep signatures readable:
```python
type UserId = str
type Permissions = dict[UserId, set[Role]]

def check_access(permissions: Permissions, user_id: UserId, role: Role) -> bool:
    ...
```

### 2. dataclasses for Data Objects

Since Python 3.7, `@dataclass` is the standard way to define classes that primarily hold data. They reduce boilerplate, provide `__init__`, `__repr__`, `__eq__` automatically, and naturally discourage method sprawl.

**❌ Bad - Manual boilerplate:**
```python
class User:
    def __init__(self, id: str, email: str, name: str, active: bool = True):
        self.id = id
        self.email = email
        self.name = name
        self.active = active
```

**✅ Good - dataclass:**
```python
from dataclasses import dataclass

@dataclass
class User:
    id: str
    email: str
    name: str
    active: bool = True

    def verify_password(self, password: str) -> bool:
        """Core domain logic belongs here - invariants and identity checks."""
        return check_password(password, self.password_hash)
```

Use `frozen=True` for immutable value objects:
```python
@dataclass(frozen=True)
class Money:
    amount: Decimal
    currency: str
```

**When NOT to use dataclass:** Classes whose primary purpose is behavior with injected dependencies (services, handlers). These hold dependencies as state and orchestrate operations — they aren't data containers.

### 3. Functions vs. Classes - Use Classes Only for State

A class is warranted when it holds meaningful state (including injected dependencies). If a class has no attributes and only methods, it should be functions instead.

**❌ Bad - Class as function namespace:**
```python
class MathHelper:
    def calculate_tax(self, amount: float, rate: float) -> float:
        return amount * rate

    def format_currency(self, amount: float) -> str:
        return f"${amount:.2f}"

# Caller must instantiate for no reason
helper = MathHelper()
tax = helper.calculate_tax(100, 0.19)
```

**✅ Good - Plain functions:**
```python
def calculate_tax(amount: float, rate: float) -> float:
    return amount * rate

def format_currency(amount: float) -> str:
    return f"${amount:.2f}"

# Direct call
tax = calculate_tax(100, 0.19)
```

**✅ Good - Class with state (injected dependencies):**
```python
class TaxService:
    def __init__(self, tax_rates: TaxRateRepository):
        self.tax_rates = tax_rates

    def calculate(self, amount: float, country: str) -> float:
        rate = self.tax_rates.get_rate(country)
        return amount * rate
```

**Rule of thumb:** If `self` is only used to call other methods on the same class (never to access attributes), you have functions pretending to be a class.

### 4. Composition Over Inheritance

Deep inheritance hierarchies make code rigid and hard to change. Prefer composing objects from smaller, focused components.

**❌ Bad - Deep inheritance:**
```python
class Animal:
    def __init__(self, name: str):
        self.name = name

class Mammal(Animal):
    def breathe(self) -> str:
        return "breathing air"

class Pet(Mammal):
    def __init__(self, name: str, owner: str):
        super().__init__(name)
        self.owner = owner

class Dog(Pet):
    def speak(self) -> str:
        return "woof"

# What about a swimming dog? A pet fish? Hierarchy breaks down.
```

**✅ Good - Composition:**
```python
from dataclasses import dataclass, field
from typing import Protocol

class Speaker(Protocol):
    def speak(self) -> str: ...

class Swimmer(Protocol):
    def swim(self) -> str: ...

@dataclass
class DogVoice:
    def speak(self) -> str:
        return "woof"

@dataclass
class DogPaddle:
    def swim(self) -> str:
        return "paddle paddle"

@dataclass
class Animal:
    name: str
    owner: str | None = None
    voice: Speaker | None = None
    swimming: Swimmer | None = None

# Composable - any combination works
dog = Animal("Rex", owner="Alice", voice=DogVoice(), swimming=DogPaddle())
fish = Animal("Nemo", swimming=FishSwim())
```

**When inheritance IS appropriate:**
- Extending framework base classes (Django Model, Flask View) — the framework requires it
- Simple, shallow hierarchies (1 level deep) with genuine is-a relationships
- Abstract base classes defining an interface (ABC with abstract methods)

**Rule of thumb:** If you're at 3+ levels of inheritance, or you find yourself needing multiple inheritance or mixins to compose features, switch to composition.

### 5. Encapsulation Conventions

Python has no `private` keyword, but the underscore conventions matter. Follow them.

- `_name`: Internal. Other modules and classes should not access this.
- `__name`: Name-mangled. Use sparingly, mainly to avoid collisions in inheritance.
- No underscore: Public API. Considered stable and safe to use externally.

```python
class ConnectionPool:
    def __init__(self, max_size: int):
        self.max_size = max_size        # Public config
        self._connections: list = []     # Internal state
        self._lock = threading.Lock()    # Internal mechanism

    def acquire(self) -> Connection:     # Public API
        with self._lock:
            return self._get_or_create()

    def _get_or_create(self) -> Connection:  # Internal implementation
        ...
```

For modules, use `__all__` to declare the public API:
```python
__all__ = ["ConnectionPool", "PoolConfig"]  # Only these are part of the public API
```

Just because Python allows accessing `_internal` attributes doesn't mean you should. Treat the leading underscore as a contract.

## Architecture Patterns

### 1. Dependency Injection (Not Hardcoded Side Effects)

**❌ Bad - Hardcoded in `__init__`:**
```python
class WeatherService:
    def __init__(self, api_key: str):
        # Side effects - impossible to test without real DB/API
        self.db = psycopg2.connect(host='localhost', database='weather')
        self.http = requests.Session()
        self.api_key = api_key
```

**✅ Good - Dependencies Injected:**
```python
from typing import Protocol

class WeatherRepository(Protocol):
    def get_cached(self, city: str) -> dict | None: ...
    def save(self, city: str, data: dict) -> None: ...

class HTTPClient(Protocol):
    def get(self, url: str) -> dict: ...

class WeatherService:
    def __init__(
        self,
        repository: WeatherRepository,
        http_client: HTTPClient,
        api_key: str,
    ):
        # No side effects - just store dependencies
        self.repository = repository
        self.http_client = http_client
        self.api_key = api_key

    def get_weather(self, city: str) -> dict:
        cached = self.repository.get_cached(city)
        if cached:
            return cached

        data = self.http_client.get(f"/weather?city={city}&key={self.api_key}")
        self.repository.save(city, data)
        return data
```

**Why this matters:**
- Test with `FakeRepository` and `FakeHTTPClient` - no real DB/network needed
- Swap PostgreSQL for Redis without changing `WeatherService`
- No side effects in constructor

### 2. Repository Pattern (Not Leaky Abstractions)

**❌ Bad - SQL in Business Logic:**
```python
def get_products():
    cache_key = 'products:all'
    cached = cache.get(cache_key)  # Redis-specific
    if cached:
        return json.loads(cached)

    result = db.query("SELECT * FROM products")  # SQL in app code
    cache.setex(cache_key, 300, json.dumps(result))
    return result
```

**✅ Good - Repository Abstraction:**
```python
from typing import Protocol

class ProductRepository(Protocol):
    def get_all(self) -> list[Product]: ...

class CachedProductRepository:
    def __init__(self, cache: Cache, db: ProductDB, ttl: int = 300):
        self.cache = cache
        self.db = db
        self.ttl = ttl

    def get_all(self) -> list[Product]:
        cached = self.cache.get('products:all')
        if cached:
            return cached

        products = self.db.get_all_products()
        self.cache.set('products:all', products, ttl=self.ttl)
        return products

# Business logic depends on Protocol, not Redis/SQL
def get_products(repo: ProductRepository) -> list[Product]:
    return repo.get_all()
```

**Why this matters:**
- Business logic doesn't know about Redis, SQL, or caching strategy
- Test with `FakeProductRepository` returning fixed data
- Swap caching strategy without changing business logic

### 3. Service Layer (Not Fat Models/Controllers)

**❌ Bad - God Object with mixed concerns:**
```python
class User:
    def __init__(self, id, email, password_hash):
        self.id = id
        self.email = email
        self.password_hash = password_hash

    def login(self, password): ...
    def logout(self): ...
    def update_profile(self, new_email): ...
    def generate_reset_token(self): ...
    def verify_reset_token(self, token): ...
    def reset_password(self, token, new_password): ...
    # ... 10 more methods - God Object
```

**✅ Good - dataclass + Service Layer:**
```python
from dataclasses import dataclass

# Domain object - data and core invariants only
@dataclass
class User:
    id: str
    email: str
    password_hash: str

    def verify_password(self, password: str) -> bool:
        return check_password(password, self.password_hash)

# Service orchestrates operations (has state: injected dependencies)
class AuthenticationService:
    def __init__(self, user_repo: UserRepository, session_manager: SessionManager):
        self.user_repo = user_repo
        self.session_manager = session_manager

    def login(self, email: str, password: str) -> Session:
        user = self.user_repo.get_by_email(email)
        if not user or not user.verify_password(password):
            raise AuthenticationError("Invalid credentials")
        return self.session_manager.create(user.id)

class PasswordResetService:
    def __init__(self, user_repo: UserRepository, token_generator: TokenGenerator):
        self.user_repo = user_repo
        self.token_generator = token_generator

    def request_reset(self, email: str) -> str:
        user = self.user_repo.get_by_email(email)
        return self.token_generator.generate(user.id)
```

**Why this matters:**
- `User` has one responsibility - represent a user with its core invariants
- Services hold dependencies (legitimate state) and orchestrate operations
- Easy to find where logic lives (auth vs. password reset)

### 4. Adapter Pattern (Not Leaky Infrastructure)

**❌ Bad - Infrastructure details everywhere:**
```python
def send_order_confirmation_email(order: Order, user: User) -> None:
    smtp = smtplib.SMTP('smtp.gmail.com', 587)
    smtp.login(config.email, config.password)
    smtp.sendmail(config.email, user.email, f"Order {order.id}...")
    smtp.quit()

def send_order_confirmation_sms(order: Order, user: User) -> None:
    from twilio.rest import Client
    client = Client(config.twilio_sid, config.twilio_token)
    client.messages.create(body=f"Order {order.id}...", from_=config.phone, to=user.phone)
```

**✅ Good - Notification Interface:**
```python
from typing import Protocol

class NotificationChannel(Protocol):
    def send(self, recipient: str, message: str) -> None: ...

class EmailChannel:
    def __init__(self, smtp_config: SMTPConfig):
        self.config = smtp_config

    def send(self, recipient: str, message: str) -> None:
        smtp = smtplib.SMTP(self.config.host, self.config.port)
        smtp.login(self.config.user, self.config.password)
        smtp.sendmail(self.config.from_email, recipient, message)
        smtp.quit()

class SMSChannel:
    def __init__(self, twilio_client: TwilioClient):
        self.client = twilio_client

    def send(self, recipient: str, message: str) -> None:
        self.client.messages.create(
            body=message,
            from_=self.client.phone_number,
            to=recipient,
        )

class NotificationService:
    def __init__(self, channels: list[NotificationChannel]):
        self.channels = channels

    def notify(self, recipient: str, message: str) -> None:
        for channel in self.channels:
            channel.send(recipient, message)

def send_order_confirmation(order: Order, user: User, notifier: NotificationService) -> None:
    message = f"Order {order.id} confirmed. Total: ${order.total}"
    notifier.notify(user.contact, message)
```

**Why this matters:**
- Add Slack/push notifications without changing `NotificationService`
- Test with `FakeChannel` that records sent messages
- No duplication - notification logic is centralized

## Testing Architecture

### Prefer Fakes for Complex Behavior, Mocks for Simple Interfaces

Deep mock chains (`mock.return_value.foo.return_value.bar`) are a design smell — they indicate coupled code. But not all mocking is bad. Simple `Mock(spec=...)` or `patch` for environment/time are fine.

**❌ Bad - Deep mock chains (design smell):**
```python
def test_process_payment():
    with patch('module.PaymentService') as mock_service:
        mock_service.return_value.process_payment.return_value = Mock(status="success")
        # Testing the mock, not the code
```

**✅ Good - Fake with behavior for complex dependencies:**
```python
class FakePaymentGateway:
    """Use when the fake needs to track state or simulate behavior."""
    def __init__(self):
        self.charges: list[float] = []

    def charge(self, amount: float) -> ChargeResult:
        self.charges.append(amount)
        return ChargeResult(status="success", transaction_id="fake_123")

def test_process_payment():
    gateway = FakePaymentGateway()
    service = PaymentService(gateway)
    result = service.process_payment(amount=50.00)
    assert result.status == "success"
    assert gateway.charges == [50.00]
```

**✅ Also fine - Simple mock for simple interfaces:**
```python
def test_sends_notification():
    channel = Mock(spec=NotificationChannel)
    service = NotificationService([channel])
    service.notify("user@example.com", "hello")
    channel.send.assert_called_once_with("user@example.com", "hello")
```

**✅ Fine - Patching environment/time:**
```python
def test_token_expiry():
    with patch("module.datetime") as mock_dt:
        mock_dt.now.return_value = datetime(2025, 1, 1, 12, 0, 0)
        token = generate_token(ttl_seconds=3600)
        assert token.expires_at == datetime(2025, 1, 1, 13, 0, 0)
```

**Guidelines:**
- If you're writing a fake class with 10+ methods, a `Mock(spec=...)` might be simpler
- If your mock setup is longer than the test logic, consider a fake or fixing the design
- Mock at boundaries (external APIs, system calls), not your own service classes
- Integration tests should verify that adapters work with real services (sandbox/test environments)

**Integration tests for adapters:**
```python
@pytest.mark.integration
def test_real_payment_gateway():
    gateway = StripeGateway(api_key=TEST_KEY)
    result = gateway.charge(amount=1.00)
    assert result.status in ["success", "pending"]
```

## Working with Legacy Code

When a codebase has module-level clients, coupled code, or other antipatterns:

- **Write new code using proper patterns.** New code doesn't require refactoring old code (Strangler Fig pattern).
- **Don't copy antipatterns for "consistency."** One correct implementation creates an example for future work, not inconsistency.
- **Don't refactor existing code unless asked.** The goal is to stop the spread, not rewrite the codebase.

These patterns add no extra development time — `def process(gateway: Gateway)` takes the same effort as `def process()`. The difference is testability, not speed.

```python
# Coupled version
def process_payment(amount: float) -> None:
    stripe.api_key = "sk_..."
    charge = stripe.Charge.create(amount=amount)
    db.execute("INSERT INTO payments...")

# Clean version - same effort
def process_payment(amount: float, gateway: PaymentGateway, repo: PaymentRepo) -> None:
    charge = gateway.create_charge(amount)
    repo.save_payment(charge)
```

## Red Flags

**Technical smells — apply patterns from this skill in new code:**
- Side effects in `__init__` (DB connections, HTTP clients)
- Module-level database/cache clients
- SQL queries in functions that aren't in a repository
- Import statements inside functions (circular dependency workaround)
- Deep mock chains in tests (`mock.return_value.foo.return_value`)
- `**kwargs` everywhere (hiding the contract)
- One class with 10+ methods doing unrelated things
- Stateless classes (no attributes, only methods)
- Deep inheritance hierarchies (3+ levels)
- Manual `__init__` boilerplate for data containers (use `@dataclass`)
- Missing type hints on function signatures
- Accessing `_internal` members from outside the class/module

**Rationalization smells — don't let these justify bad new code:**
- "For consistency" used to justify matching bad patterns
- "Out of scope" used to avoid doing new code correctly
- "We'll refactor after [milestone]" used to skip patterns that cost nothing extra
- "Don't over-engineer" applied to basic DI or typing

## The Bottom Line

**Architecture is not "over-engineering" — it's making code testable and changeable.**

If you can't test it with fakes, the design is coupled.
If a class has no state, use functions.
If you're building deep hierarchies, use composition.
If your data objects have manual `__init__` boilerplate, use `@dataclass`.
If your functions lack type hints, add them — they cost nothing and prevent errors.
