require('dotenv').config();
const assert = require('assert');
const { supabase } = require('../services/supabase');
const supportService = require('../services/supportService');
const platformReportService = require('../services/platformReportService');

async function runSupportAndReportsTest() {
  console.log('🧪 Starting E2E Support Tickets & Platform Abuse Reports Test...');

  // 1. Get test store
  const { data: store, error: sErr } = await supabase
    .from('stores')
    .select('id, name, subdomain')
    .limit(1)
    .single();

  if (sErr || !store) {
    throw new Error('Test store not found: ' + (sErr?.message || 'empty'));
  }
  console.log(`📌 Using test store: ${store.name} (${store.id})`);

  // 2. Customer creates a store support ticket
  const ticket = await supportService.createTicket({
    storeId: store.id,
    customerName: 'أحمد محمود (اختبار)',
    customerPhone: '01012345678',
    customerEmail: 'ahmed.test@example.com',
    category: 'order_issue',
    subject: 'استفسار عن موعد توصيل الشحنة E2E',
    message: 'السلام عليكم، أود الاستفسار عن موعد وصول طلبي ورقم البوليصة.'
  });

  assert(ticket && ticket.id, 'Ticket creation must return valid ticket with ID');
  assert(ticket.ticket_number.startsWith('TCK-'), 'Ticket number must start with TCK-');
  console.log(`✅ [1/6] Store ticket created: ${ticket.ticket_number} (ID: ${ticket.id})`);

  // 3. Merchant adds a reply and an internal note
  const merchantMsg = await supportService.addTicketMessage({
    ticketId: ticket.id,
    storeId: store.id,
    senderType: 'merchant',
    message: 'أهلاً بك يا فندم، تم شحن الطلب ورقم البوليصة هو EG123456.',
    isInternalNote: false
  });
  assert(merchantMsg && merchantMsg.id, 'Merchant message must be inserted');

  const internalNote = await supportService.addTicketMessage({
    ticketId: ticket.id,
    storeId: store.id,
    senderType: 'merchant',
    message: 'تم التواصل مع شركة الشحن لتسريع التسليم.',
    isInternalNote: true
  });
  assert(internalNote && internalNote.id, 'Internal note must be inserted');
  console.log('✅ [2/6] Merchant public reply and internal note added');

  // 4. Verify Customer isolation (Internal notes must NEVER be visible to customer)
  const customerView = await supportService.getTicketDetails(ticket.id, store.id, null, false);
  assert(customerView && customerView.messages, 'Customer view must return messages');
  const hasInternalInCustomerView = customerView.messages.some(m => m.is_internal_note);
  assert(!hasInternalInCustomerView, 'SECURITY BREACH: Internal note leaked to customer view!');
  console.log('✅ [3/6] Verified Customer View Isolation (0 internal notes leaked)');

  // 5. Merchant updates ticket status to resolved
  const updatedTicket = await supportService.updateTicketStatus(ticket.id, store.id, {
    status: 'resolved'
  });
  assert.strictEqual(updatedTicket.status, 'resolved', 'Ticket status must be resolved');
  console.log('✅ [4/6] Ticket status updated to resolved');

  // 6. Submit Platform Abuse Report
  const abuseReport = await platformReportService.createReport({
    storeId: store.id,
    reporterName: 'سارة خالد (مشتري)',
    reporterPhone: '01298765432',
    reporterEmail: 'sara.test@example.com',
    reasonCategory: 'fraud_scam',
    description: 'تم تحويل المبلغ عبر فودافون كاش ولم يتم إرسال أي إثبات أو رد.'
  });

  assert(abuseReport && abuseReport.id, 'Platform abuse report must be created');
  assert.strictEqual(abuseReport.status, 'pending', 'Initial status must be pending');
  console.log(`✅ [5/6] Platform abuse report created (ID: ${abuseReport.id})`);

  // 7. Super Admin reviews and updates action on report
  const resolvedReport = await platformReportService.updateReportAction(abuseReport.id, {
    status: 'action_taken',
    adminAction: 'warning_issued',
    adminNotes: 'تم التحقق من إيصال التحويل وتوجيه إنذار رسمي للمتجر لرد المبلغ فوراً.'
  });

  assert.strictEqual(resolvedReport.status, 'action_taken', 'Report status must be action_taken');
  assert.strictEqual(resolvedReport.admin_action, 'warning_issued', 'Admin action must match');
  console.log('✅ [6/6] Super Admin action executed and logged on abuse report');

  // Cleanup test records
  await supabase.from('platform_abuse_reports').delete().eq('id', abuseReport.id);
  await supabase.from('store_support_tickets').delete().eq('id', ticket.id);
  console.log('🧹 Cleaned up test records from Supabase');

  console.log('🎉 ALL 6 Support & Platform Abuse Tests PASSED with 100% integrity!');
}

runSupportAndReportsTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
