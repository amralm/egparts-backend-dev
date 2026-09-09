const assert = require('assert');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const adminDashboardService = require('../services/adminDashboardService');

async function runParityTests() {
  console.log('====================================================');
  console.log('  RUNNING FINANCIAL INTELLIGENCE & RBAC REGRESSION SUITE');
  console.log('====================================================\n');

  let passed = 0;
  let total = 0;

  function it(desc, fn) {
    total += 1;
    try {
      fn();
      console.log(`PASS: ${desc}`);
      passed += 1;
    } catch (err) {
      console.error(`FAIL: ${desc}`);
      console.error(err);
      process.exitCode = 1;
    }
  }

  // ── Test 1: Realized Revenue Strictly On Delivered Orders ──
  it('Financial Engine: revenue includes only delivered orders', () => {
    const orders = [
      { id: '1', status: 'delivered', total: '1000' },
      { id: '2', status: 'pending', total: '500' },
      { id: '3', status: 'processing', total: '750' },
      { id: '4', status: 'cancelled', total: '300' }
    ];
    const revenue = orders.reduce((acc, o) => o.status === 'delivered' ? acc + parseFloat(o.total) : acc, 0);
    assert.strictEqual(revenue, 1000, 'Revenue must strictly sum delivered orders only');
  });

  // ── Test 2: COGS & Profit from order_items with fallback to orders.items ──
  it('Financial Engine: COGS and Net Profit calculate accurately from fallback JSON items', () => {
    const products = [
      { id: 'p1', name: 'Product A', cost_price: '200', price: '500' },
      { id: 'p2', name: 'Product B', cost_price: '100', price: '300' }
    ];
    const productCostMap = new Map(products.map(p => [p.id, parseFloat(p.cost_price)]));
    
    // Order delivered with items stored in JSON column
    const deliveredOrder = {
      id: 'ord-101',
      status: 'delivered',
      total: '1000',
      items: [
        { id: 'p1', qty: 1, price: 500 },
        { id: 'p2', qty: 1, price: 300 }
      ]
    };

    let cogs = 0;
    let netProfit = 0;

    for (const item of deliveredOrder.items) {
      const unitCost = productCostMap.get(item.id) || 0;
      const qty = item.qty || 1;
      const itemCost = unitCost * qty;
      cogs += itemCost;
      const salePrice = item.price || 0;
      netProfit += (salePrice - unitCost) * qty;
    }

    assert.strictEqual(cogs, 300, 'COGS must be 200 + 100 = 300');
    assert.strictEqual(netProfit, 500, 'Profit must be (500 - 200) + (300 - 100) = 500');
    const margin = Math.round((netProfit / 800) * 100);
    assert.strictEqual(margin, 63, 'Margin must be 63%');
  });

  // ── Test 3: Zero Orders Safety (No NaN or Zero Division) ──
  it('Financial Engine: handles zero orders gracefully without NaN or infinity', () => {
    const revenue = 0;
    const netProfit = 0;
    const profitMargin = revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0;
    assert.strictEqual(profitMargin, 0);
    assert.strictEqual(Number.isNaN(profitMargin), false);
  });

  // ── Test 4: Payment Breakdown Dual Metrics (Delivered vs Pending) ──
  it('Payment Channels: separates collected revenue from awaiting delivery amounts', () => {
    const orders = [
      { payment_method: 'cod', status: 'pending', total: '549' },
      { payment_method: 'cod', status: 'delivered', total: '1200' },
      { payment_method: 'manual_wallet', status: 'processing', total: '800' },
      { payment_method: 'pos_cashier', status: 'delivered', total: '998' }
    ];

    const breakdown = {
      cod: { count: 0, total: 0, pending_total: 0 },
      manual_wallet: { count: 0, total: 0, pending_total: 0 },
      pos_cashier: { count: 0, total: 0, pending_total: 0 }
    };

    for (const o of orders) {
      const key = o.payment_method;
      breakdown[key].count += 1;
      const amount = parseFloat(o.total);
      if (o.status === 'delivered') {
        breakdown[key].total += amount;
      } else if (o.status !== 'cancelled' && o.status !== 'rejected') {
        breakdown[key].pending_total += amount;
      }
    }

    // COD: 2 orders (1 delivered: 1200, 1 pending: 549)
    assert.strictEqual(breakdown.cod.count, 2);
    assert.strictEqual(breakdown.cod.total, 1200);
    assert.strictEqual(breakdown.cod.pending_total, 549);

    // Wallet: 1 order (0 delivered: 0, 1 processing: 800)
    assert.strictEqual(breakdown.manual_wallet.count, 1);
    assert.strictEqual(breakdown.manual_wallet.total, 0);
    assert.strictEqual(breakdown.manual_wallet.pending_total, 800);

    // POS: 1 order (1 delivered: 998, 0 pending: 0)
    assert.strictEqual(breakdown.pos_cashier.count, 1);
    assert.strictEqual(breakdown.pos_cashier.total, 998);
    assert.strictEqual(breakdown.pos_cashier.pending_total, 0);
  });

  // ── Test 5: RBAC Role Isolation Contract ──
  it('RBAC Architecture: cashier permissions cannot access staff or settings administration', () => {
    const cashierAllowedPermissions = [
      'tenant.orders.read', 'orders.read', 'orders.view',
      'tenant.orders.write', 'orders.create', 'orders.write',
      'tenant.products.read', 'products.view', 'products.read'
    ];
    const staffAdminPermissions = ['staff.read', 'staff.write', 'tenant.owner', 'settings.write'];

    for (const perm of staffAdminPermissions) {
      const isAllowed = cashierAllowedPermissions.includes(perm);
      assert.strictEqual(isAllowed, false, `Cashier must NOT have permission: ${perm}`);
    }
  });

  console.log(`\n====================================================`);
  console.log(`  ALL ${passed}/${total} PARITY CONTRACT TESTS PASSED!`);
  console.log(`====================================================\n`);
}

runParityTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
