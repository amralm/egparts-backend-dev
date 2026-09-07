const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { Client } = require('pg');

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres.pfubitpzrmgrnzalcsgr:eE7YmFwa4I0RWIyN@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres';

async function runOrdersAtomicRegressionTests() {
  console.log('====================================================');
  console.log('  RUNNING REGRESSION TEST SUITE: create_order_atomic');
  console.log('====================================================\n');

  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  // Find an active product with stock >= 10 for deterministic testing
  const prodRes = await client.query(`
    SELECT id, name, price, stock_quantity, store_id
    FROM public.products
    WHERE is_active = true AND stock_quantity >= 10 AND store_id IS NOT NULL
    LIMIT 1;
  `);

  if (prodRes.rows.length === 0) {
    throw new Error('No test product found with sufficient stock');
  }

  const testProduct = prodRes.rows[0];
  console.log(`Using Test Product: "${testProduct.name}" (ID: ${testProduct.id}, Store: ${testProduct.store_id})`);

  const testCases = [
    {
      name: 'Case 1: Standard Order WITHOUT Coupon (p_coupon_code = NULL)',
      couponCode: null,
      paymentMethod: 'manual_wallet',
      items: [{ id: testProduct.id, qty: 1 }]
    },
    {
      name: 'Case 2: Order with Empty String Coupon (p_coupon_code = "")',
      couponCode: '',
      paymentMethod: 'cod',
      items: [{ id: testProduct.id, qty: 1 }]
    },
    {
      name: 'Case 3: Order with Whitespace Coupon (p_coupon_code = "   ")',
      couponCode: '   ',
      paymentMethod: 'manual_wallet',
      items: [{ id: testProduct.id, qty: 1 }]
    },
    {
      name: 'Case 4: Order with Invalid/Non-Existent Coupon (p_coupon_code = "FAKE_XYZ")',
      couponCode: 'FAKE_XYZ_COUPON_999',
      paymentMethod: 'cod',
      items: [{ id: testProduct.id, qty: 1 }]
    },
    {
      name: 'Case 5: Order with Duplicate Cart Items (Consolidation & Deadlock Check)',
      couponCode: null,
      paymentMethod: 'manual_wallet',
      items: [
        { id: testProduct.id, qty: 1 },
        { id: testProduct.id, qty: 2 }
      ]
    },
    {
      name: 'Case 6: Order with Percentage Coupon (33.33% Recurring Precision & Scale Check)',
      isPercentageCouponTest: true,
      paymentMethod: 'manual_wallet',
      items: [{ id: testProduct.id, qty: 1 }]
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const tc of testCases) {
    process.stdout.write(`• Testing [${tc.name}] ... `);
    const idempotencyKey = `reg-test-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    let testCouponCode = tc.couponCode;
    let createdCouponId = null;

    try {
      if (tc.isPercentageCouponTest) {
        testCouponCode = `REG_PERC_${Date.now()}`;
        const couponRes = await client.query(`
          INSERT INTO public.coupons (
            code, store_id, discount_percentage, is_active, min_order_value, applies_to
          ) VALUES ($1, $2, 33.33, true, 0, 'all')
          RETURNING id;
        `, [testCouponCode, testProduct.store_id]);
        createdCouponId = couponRes.rows[0]?.id;
      }

      const res = await client.query(`
        SELECT public.create_order_atomic(
          p_user_id => NULL,
          p_items => $1::jsonb,
          p_phone => '01099887766',
          p_city => 'القاهرة',
          p_address => 'شارع التحرير مبنى 10',
          p_customer_note => 'Regression automated test',
          p_payment_method => $2,
          p_coupon_code => $3,
          p_idempotency_key => $4,
          p_auth_source => 'otp',
          p_metadata => '{"test": true}'::jsonb,
          p_store_id => $5,
          p_location_url => NULL
        ) AS result;
      `, [
        JSON.stringify(tc.items),
        tc.paymentMethod,
        testCouponCode,
        idempotencyKey,
        testProduct.store_id
      ]);

      const orderResult = res.rows[0]?.result;
      if (!orderResult || orderResult.success !== true || !orderResult.id) {
        throw new Error(`RPC returned unsuccessful payload: ${JSON.stringify(orderResult)}`);
      }

      // Check scale precision for percentage coupon
      if (tc.isPercentageCouponTest) {
        const orderDbRes = await client.query(
          'SELECT total::text, discount::text FROM public.orders WHERE id = $1',
          [orderResult.id]
        );
        const dbTotal = orderDbRes.rows[0]?.total;
        const dbDiscount = orderDbRes.rows[0]?.discount;

        const totalDecimals = (dbTotal.split('.')[1] || '').length;
        const discountDecimals = (dbDiscount.split('.')[1] || '').length;

        if (totalDecimals > 2 || discountDecimals > 2) {
          throw new Error(`Scale violation: total has ${totalDecimals} decimals (${dbTotal}), discount has ${discountDecimals} decimals (${dbDiscount})`);
        }
      }

      // Total quantity of test product in this test case
      const totalQty = tc.items.reduce((sum, it) => sum + (it.qty || 1), 0);

      // Clean up test order immediately
      await client.query('DELETE FROM public.order_items WHERE order_id = $1', [orderResult.id]);
      await client.query('DELETE FROM public.order_tracking WHERE order_id = $1', [orderResult.id]);
      await client.query('DELETE FROM public.inventory_adjustments WHERE order_id = $1', [orderResult.id]);
      await client.query('DELETE FROM public.orders WHERE id = $1', [orderResult.id]);

      // Restore deducted stock
      await client.query(`
        UPDATE public.products
        SET stock_quantity = stock_quantity + $1,
            stock = COALESCE(stock, stock_quantity) + $1
        WHERE id = $2;
      `, [totalQty, testProduct.id]);

      if (createdCouponId) {
        await client.query('DELETE FROM public.coupons WHERE id = $1', [createdCouponId]);
      }

      console.log(`PASSED! (Order ID: ${orderResult.id}, Total: ${orderResult.total} EGP)`);
      passed++;
    } catch (err) {
      console.log(`FAILED!`);
      console.error(`  Error message: ${err.message}`);
      if (createdCouponId) {
        try {
          await client.query('DELETE FROM public.coupons WHERE id = $1', [createdCouponId]);
        } catch (e) {
          // ignore cleanup error
        }
      }
      failed++;
    }
  }

  await client.end();

  console.log('\n====================================================');
  console.log(`  RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runOrdersAtomicRegressionTests().catch((e) => {
    console.error('Fatal regression suite error:', e);
    process.exit(1);
  });
}

module.exports = { runOrdersAtomicRegressionTests };
