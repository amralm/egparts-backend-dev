const { supabase } = require('./supabase');
const crypto = require('crypto');

function generateTicketNumber() {
  const randomPart = Math.floor(100000 + Math.random() * 900000);
  return `TCK-${randomPart}`;
}

async function isStaffMember(userId, storeId) {
  if (!userId) return false;
  try {
    const { data: superAdmin } = await supabase
      .from('super_admins')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (superAdmin) return true;

    if (storeId) {
      const { data: storeAdmin } = await supabase
        .from('store_admins')
        .select('user_id')
        .eq('user_id', userId)
        .eq('store_id', storeId)
        .maybeSingle();
      if (storeAdmin) return true;

      const { data: userRole } = await supabase
        .from('user_roles')
        .select('role_id')
        .eq('user_id', userId)
        .eq('store_id', storeId)
        .maybeSingle();
      if (userRole) return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function createTicket({ storeId, userId = null, orderId = null, customerName, customerPhone, customerEmail = null, category = 'order_issue', priority = 'normal', subject, message, attachments = [] }) {
  if (!storeId) throw new Error('معرف المتجر مطلوب');
  if (!customerName || !customerPhone || !subject || !message) {
    throw new Error('الاسم، رقم الهاتف، الموضوع، ومحتوى الرسالة حقول مطلوبة');
  }

  // Normalize priority to allowed enum: low, normal, medium, high, urgent
  const allowedPriorities = ['low', 'normal', 'medium', 'high', 'urgent'];
  const effectivePriority = allowedPriorities.includes(priority) ? priority : 'normal';

  // Normalize category to allowed enum
  const allowedCategories = ['order_issue', 'payment', 'product_inquiry', 'shipping', 'shipping_delay', 'refund_request', 'general', 'other'];
  const effectiveCategory = allowedCategories.includes(category) ? category : 'order_issue';

  const ticketNumber = generateTicketNumber();

  const { data: createdTicket, error: tErr } = await supabase
    .from('store_support_tickets')
    .insert({
      store_id: storeId,
      user_id: userId,
      order_id: orderId,
      ticket_number: ticketNumber,
      customer_name: customerName.trim(),
      customer_phone: customerPhone.trim(),
      customer_email: customerEmail ? customerEmail.trim() : null,
      category: effectiveCategory,
      priority: effectivePriority,
      subject: subject.trim(),
      status: 'open'
    })
    .select()
    .single();

  if (tErr) throw tErr;

  // Insert initial message
  const { error: msgErr } = await supabase
    .from('store_support_messages')
    .insert({
      ticket_id: createdTicket.id,
      sender_type: 'customer',
      sender_id: userId || null,
      message: message.trim(),
      attachments: Array.isArray(attachments) ? attachments : [],
      is_internal_note: false
    });

  if (msgErr) throw msgErr;

  return createdTicket;
}

async function listCustomerTickets(userId, storeId) {
  if (!userId || !storeId) return [];
  const { data, error } = await supabase
    .from('store_support_tickets')
    .select('id, ticket_number, category, subject, status, priority, order_id, created_at, updated_at')
    .eq('store_id', storeId)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

async function getTicketDetails(ticketId, storeId, userId = null, isMerchant = false) {
  let query = supabase
    .from('store_support_tickets')
    .select(`
      *,
      order:orders(id, order_number, total, status, created_at)
    `)
    .eq('id', ticketId)
    .eq('store_id', storeId);

  if (!isMerchant && userId) {
    query = query.eq('user_id', userId);
  }

  const { data: ticket, error } = await query.maybeSingle();
  if (error) throw error;
  if (!ticket) return null;

  // Get messages
  let msgQuery = supabase
    .from('store_support_messages')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true });

  if (!isMerchant) {
    msgQuery = msgQuery.eq('is_internal_note', false);
  }

  const { data: messages, error: msgErr } = await msgQuery;
  if (msgErr) throw msgErr;

  return {
    ...ticket,
    messages: messages || []
  };
}

async function addTicketMessage({ ticketId, storeId, senderType, senderId, message, attachments = [], isInternalNote = false }) {
  if (!ticketId || !message) throw new Error('محتوى الرسالة مطلوب');

  const { data: ticket, error: tErr } = await supabase
    .from('store_support_tickets')
    .select('id, store_id, status')
    .eq('id', ticketId)
    .eq('store_id', storeId)
    .maybeSingle();

  if (tErr) throw tErr;
  if (!ticket) throw new Error('التذكرة غير موجودة');

  const { data, error } = await supabase
    .from('store_support_messages')
    .insert({
      ticket_id: ticketId,
      sender_type: senderType,
      sender_id: senderId || null,
      message: message.trim(),
      attachments: Array.isArray(attachments) ? attachments : [],
      is_internal_note: Boolean(isInternalNote)
    })
    .select()
    .single();

  if (error) throw error;

  // Update ticket updated_at and reopen if customer replied
  const updates = { updated_at: new Date().toISOString() };
  if (senderType === 'customer' && ticket.status === 'closed') {
    updates.status = 'open';
  } else if (senderType === 'merchant' && ticket.status === 'open') {
    updates.status = 'in_progress';
  }

  await supabase
    .from('store_support_tickets')
    .update(updates)
    .eq('id', ticketId);

  return data;
}

async function listStoreTickets(storeId, { status, priority, search, page = 1, limit = 20 }) {
  if (!storeId) throw new Error('معرف المتجر مطلوب');

  let query = supabase
    .from('store_support_tickets')
    .select(`
      id, ticket_number, customer_name, customer_phone, customer_email,
      category, subject, status, priority, order_id, created_at, updated_at,
      order:orders(id, order_number, total, status)
    `, { count: 'exact' })
    .eq('store_id', storeId);

  if (status) query = query.eq('status', status);
  if (priority) query = query.eq('priority', priority);
  if (search) {
    query = query.or(`ticket_number.ilike.%${search}%,customer_name.ilike.%${search}%,customer_phone.ilike.%${search}%,subject.ilike.%${search}%`);
  }

  const offset = (page - 1) * limit;
  query = query
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) throw error;

  return {
    tickets: data || [],
    items: data || [],
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit)
    }
  };
}

async function updateTicketStatus(ticketId, storeId, { status, priority }) {
  if (!ticketId || !storeId) throw new Error('معرف التذكرة والمتجر مطلوبان');

  const updates = {
    updated_at: new Date().toISOString()
  };
  if (status) updates.status = status;
  if (priority) updates.priority = priority;

  const { data, error } = await supabase
    .from('store_support_tickets')
    .update(updates)
    .eq('id', ticketId)
    .eq('store_id', storeId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  isStaffMember,
  createTicket,
  listCustomerTickets,
  getTicketDetails,
  addTicketMessage,
  listStoreTickets,
  updateTicketStatus
};
