# EG-PARTS Kernel Test Matrix

| Component    | Unit | Integration | Chaos | Load |
| ------------ | ---- | ----------- | ----- | ---- |
| Identity     | ✅    | ✅           | ✅     | ❌    |
| Membership   | ✅    | ✅           | ✅     | ❌    |
| Policy       | ✅    | ✅           | ✅     | ✅    |
| Entitlements | ✅    | ✅           | ✅     | ✅    |
| Events       | ✅    | ✅           | ✅     | ❌    |
| Billing      | ✅    | ✅           | ✅     | ❌    |

### 1. Unit Tests (`tests/kernel/`)
Test the internal logic in complete isolation using Fake Implementations (`FakeRepository`, `FakeClock`, `FakeEventBus`, etc.).
- **Targets:** Parsers, Builders, Factories, EntitlementFacade, Middleware.

### 2. Integration Tests (`tests/integration/`)
Test the actual implementations against real Infrastructure.
- **Targets:** `SupabaseEntitlementRepository`, Redis Cache Provider, API routing.

### 3. Chaos Tests (`tests/chaos/`)
Test system resilience and fault tolerance.
- **Failure Injection:** Simulate DB timeouts (delay 2s), RPC failures, Redis disconnections.
- **Concurrency:** Blast 100 simultaneous consume requests to test Race conditions and Atomicity (Idempotency).
- **Leakage Test:** Test isolation between Store A and Store B consumption.

### 4. Load Tests
Measure performance and latency for high-throughput areas (Policy, Entitlements).
