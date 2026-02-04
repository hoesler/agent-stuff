---
name: python-architecture-patterns
description: Use when writing Python classes or functions that interact with external services (databases, APIs, caches), organizing business logic, or designing testable code - prevents coupling, god objects, and leaky abstractions
---

# Python Architecture Patterns

## Overview

**Architecture determines testability.** If your code requires deep mocking or real databases to test, the design is wrong.

**Core principle:** Depend on abstractions (Protocol, ABC), not concrete implementations. Separate domain logic from infrastructure.

## When to Use

Use this skill when:
- Creating classes that talk to databases, APIs, or external services
- Adding caching, notifications, or other infrastructure concerns
- Organizing business logic in models, services, or controllers
- Tests require extensive mocking or real services to run
- Refactoring existing code with mixed concerns

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
| **Mock the Service** | Testing requires mocking your own code | Fix architecture - test real logic with fake deps |

## Core Patterns

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
        api_key: str
    ):
        # No side effects - just store dependencies
        self.repository = repository
        self.http_client = http_client
        self.api_key = api_key

    def get_weather(self, city: str) -> dict:
        # Use injected dependencies
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
    # Infrastructure details leak everywhere
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
    def get_all(self) -> list[dict]: ...

class CachedProductRepository:
    def __init__(self, cache, db, ttl: int = 300):
        self.cache = cache
        self.db = db
        self.ttl = ttl

    def get_all(self) -> list[dict]:
        cached = self.cache.get('products:all')
        if cached:
            return cached

        products = self.db.get_all_products()
        self.cache.set('products:all', products, ttl=self.ttl)
        return products

# Business logic depends on Protocol, not Redis/SQL
def get_products(repo: ProductRepository):
    return repo.get_all()
```

**Why this matters:**
- Business logic doesn't know about Redis, SQL, or caching strategy
- Test with `FakeProductRepository` returning fixed data
- Swap caching strategy without changing business logic

### 3. Service Layer (Not Fat Models/Controllers)

**❌ Bad - Business Logic in Model:**
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

**✅ Good - Service Layer + Domain Object:**
```python
# Domain object - just data and core invariants
class User:
    def __init__(self, id: str, email: str, password_hash: str):
        self.id = id
        self.email = email
        self.password_hash = password_hash

    def verify_password(self, password: str) -> bool:
        # Core domain logic only
        return check_password(password, self.password_hash)

# Service orchestrates operations
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
- `User` has one responsibility - represent a user
- Services are testable with fake repositories
- Easy to find where logic lives (auth vs. password reset)

### 4. Adapter Pattern (Not Leaky Infrastructure)

**❌ Bad - Twilio Details Everywhere:**
```python
def send_order_confirmation_email(order, user):
    smtp = smtplib.SMTP('smtp.gmail.com', 587)
    smtp.login(config.email, config.password)
    smtp.sendmail(config.email, user.email, f"Order {order.id}...")
    smtp.quit()

def send_order_confirmation_sms(order, user):
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
    def __init__(self, smtp_config):
        self.config = smtp_config

    def send(self, recipient: str, message: str) -> None:
        smtp = smtplib.SMTP(self.config.host, self.config.port)
        smtp.login(self.config.user, self.config.password)
        smtp.sendmail(self.config.from_email, recipient, message)
        smtp.quit()

class SMSChannel:
    def __init__(self, twilio_client):
        self.client = twilio_client

    def send(self, recipient: str, message: str) -> None:
        self.client.messages.create(
            body=message,
            from_=self.client.phone_number,
            to=recipient
        )

class NotificationService:
    def __init__(self, channels: list[NotificationChannel]):
        self.channels = channels

    def notify(self, recipient: str, message: str) -> None:
        for channel in self.channels:
            channel.send(recipient, message)

# Use
def send_order_confirmation(order, user, notifier: NotificationService):
    message = f"Order {order.id} confirmed. Total: ${order.total}"
    notifier.notify(user.contact, message)
```

**Why this matters:**
- Add Slack/push notifications without changing `NotificationService`
- Test with `FakeChannel` that records sent messages
- No duplication - notification logic is centralized

## Testing Architecture

### When You Need Deep Mocks, The Design Is Wrong

**❌ Bad - Mocking Your Own Code:**
```python
def test_process_payment():
    with patch('module.PaymentService') as mock_service:
        mock_service.return_value.process_payment.return_value = Mock(status="success")
        # Testing the mock, not the code
```

**✅ Good - Test Real Logic with Fake Dependencies:**
```python
class FakePaymentGateway:
    def charge(self, amount: float) -> dict:
        return {"status": "success", "transaction_id": "fake_123"}

def test_process_payment():
    gateway = FakePaymentGateway()
    service = PaymentService(gateway)  # Real service, fake gateway
    result = service.process_payment(amount=50.00)
    assert result.status == "success"
```

**Integration tests for adapters:**
```python
@pytest.mark.integration
def test_real_payment_gateway():
    # Test that adapter correctly calls real API (sandbox environment)
    gateway = StripeGateway(api_key=TEST_KEY)
    result = gateway.charge(amount=1.00)  # Minimal real charge
    assert result["status"] in ["success", "pending"]
```

## Working with Legacy Code

**The Situation:** Codebase has module-level clients, coupled code, or other antipatterns. Team says "match the existing pattern for consistency."

**The Trap:** Using "consistency" to justify copying bad patterns.

**The Reality:**
- Consistency with antipatterns is not a virtue - it's spreading technical debt
- New code doesn't require refactoring old code (Strangler Fig pattern)
- One correct implementation creates an EXAMPLE, not "inconsistency"
- "Too risky to do it right" applies to changing 50 modules, not writing 1 new one

**The Response:**
"I'll implement the new feature correctly. It won't touch existing modules. This shows what good looks like for future work."

**Never:**
- Copy antipatterns for "consistency"
- Accept "out of scope" as reason to write bad NEW code
- Believe "we'll refactor later" (later never comes - tech debt is permanent)

## "No Time for Clean Code"

**The Claim:** "Clean architecture takes longer. We need it NOW. Ship the quick fix, refactor after [demo/launch/funding]."

**The LIE:** Clean code does NOT take longer to write.

**The Reality:**
- Dependency injection = passing parameters (same time as not passing them)
- Using Protocols = type hints (same time as any type)
- Repository pattern = function that wraps calls (same time as inline calls)
- **Writing `def process(gateway: Gateway)` takes THE SAME TIME as `def process()`**

**The Response:**
"I can implement this correctly in the same time. These patterns don't add development time."

**Challenge These False Assumptions:**
- "Clean code takes longer" ← FALSE - challenge anyone who claims this
- "We'll refactor after [milestone]" ← Tech debt is permanent. "Later" never comes.
- "This is just a [demo/prototype/POC]" ← Demo code BECOMES production code. Always.
- "45 minutes isn't enough for clean code" ← Passing parameters takes seconds, not minutes.

**Example:**
```python
# "Quick fix" version - 2 minutes to write
def process_payment(amount):
    stripe.api_key = "sk_..."
    charge = stripe.Charge.create(amount=amount)
    db.execute("INSERT INTO payments...")

# Clean version - also 2 minutes to write
def process_payment(amount, gateway: PaymentGateway, repo: PaymentRepo):
    charge = gateway.create_charge(amount)
    repo.save_payment(charge)
```

Both take the same time. The difference is testability, not development speed.

## Common Mistakes (Rationalization Table)

| Excuse | Reality |
|--------|---------|
| "Team does it this way" | Team patterns can be wrong. Evaluate on principles. |
| "Framework pattern" (Django models) | Frameworks show what's *possible*, not what's *best*. |
| "Efficient" (global state) | Efficient for first use case, nightmare for testing/maintenance. |
| "Don't over-engineer" | Abstraction ≠ over-engineering when it enables testing/flexibility. |
| "Mock everything" | If you need deep mocks, fix the design. |
| "Direct and simple" | Simple now = complex later if design is coupled. |
| "Just get it done" | Technical debt compounds. Do it right the first time. |
| "Tests should never touch X" | Some integration tests are essential. Mock at boundaries, not everywhere. |
| **"Match existing patterns for consistency"** | **Don't copy bad patterns. Create good examples. Strangler Fig.** |
| **"Too risky to change existing code"** | **New code doesn't require changing old code.** |
| **"No time for architecture"** | **Architecture doesn't take longer. Challenge this assumption.** |
| **"We'll refactor after [milestone]"** | **Tech debt is permanent. Later never comes.** |
| **"This is just a demo/prototype"** | **Demo code becomes production. Always.** |
| **"Clean code is idealism, not pragmatism"** | **Pragmatic = testable. Skipping patterns = idealistic hope it won't break.** |
| **"Documenting the debt is enough"** | **Documentation doesn't fix bad code.** |

## Red Flags - STOP and Refactor

**Technical smells:**
- Side effects in `__init__` (DB connections, HTTP clients)
- Module-level database/cache clients
- SQL queries in functions that aren't in a repository
- Import statements inside functions (circular dependency workaround)
- Mocking your own service classes in tests
- Copying code patterns instead of finding abstraction
- `**kwargs` everywhere (hiding the contract)
- One class with 10+ methods doing unrelated things

**Rationalization smells:**
- "For consistency" used to justify matching bad patterns
- "Out of scope" used to avoid doing NEW code correctly
- "After [demo/launch/funding]" promises of refactoring
- "Just a [prototype/demo/POC]" to skip architecture
- "Clean code takes longer" without measuring
- "Pragmatic" used to mean "skip patterns"
- "No company = no clean code" false dichotomy

**If you hit these, STOP. Apply patterns above before continuing.**

## Real-World Impact

**Before (coupled design):**
- Can't test without spinning up PostgreSQL
- Can't add SMS without duplicating email code
- Changing cache library touches 20 files
- Tests mock 5 layers deep

**After (clean architecture):**
- Tests run in milliseconds with fakes
- Add notification channels in one place
- Swap infrastructure with config change
- Tests verify real business logic

## The Bottom Line

**Architecture is not "over-engineering" - it's making code testable and changeable.**

If you can't test it with fakes, the design is coupled.
If you're copying code patterns, you're missing the abstraction.
If frameworks dictate your design, you've inverted the dependency.
