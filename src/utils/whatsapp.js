import { supabase } from '../lib/supabase';

// Default order-confirmation WhatsApp number. Prefer the env var; the real
// production value comes from site_settings.order_confirmation_number which
// is managed in the Admin Panel (Settings → أرقام الدفع والتواصل).
const ADMIN_WHATSAPP = import.meta.env.VITE_ADMIN_WHATSAPP || '201122551272';

export async function saveRequestAndOpenWhatsApp({ 
  items, 
  customerNote = "", 
  customerPhone = "", 
  customerCity = "",
  customerAddress = "",
  userId = null,
  subtotal = 0,
  discountAmount = 0,
  shippingFee = 0,
  totalAmount = 0,
  couponId = null,
  paymentMethod = "cod",
  phone = ADMIN_WHATSAPP 
}) {
  try {
    // Use RPC for server-side pricing (no client prices sent to DB)
    let { data: rpcData, error: rpcError } = await supabase.rpc('process_secure_checkout_v2', {
      p_user_id: userId,
      p_items: items,
      p_customer_phone: customerPhone,
      p_customer_city: customerCity,
      p_customer_address: customerAddress,
      p_customer_note: customerNote,
      p_coupon_id: couponId,
      p_payment_method: paymentMethod
    });

    if (rpcError) {
      console.error('RPC Error:', rpcError);
      alert("عذراً، فشل تأكيد الطلب. يرجى المحاولة لاحقاً.");
      return;
    }

    if (rpcData && !rpcData.success) {
      alert("عذراً، فشل تأكيد الطلب: " + rpcData.error);
      return;
    }

    // Build the persuasive message text in Arabic
    let text = "طلب تأكيد عملية شراء جديدة من EG-PARTS\n\n";
    text += "*تفاصيل المنتجات:*\n";

    items.forEach((item) => {
      text += `- ${item.title}`;
      if (item.qty && item.qty > 1) text += ` (الكمية: ${item.qty})`;
      if (item.price) text += ` | ${item.price}\n`;
      else text += `\n`;
    });

    text += `\n*ملخص الحساب:*\n`;
    text += `- الإجمالي الفرعي: ${subtotal} ج.م\n`;
    if (discountAmount > 0) text += `- الخصم: ${discountAmount} ج.م\n`;
    if (shippingFee > 0) text += `- الشحن (${customerCity}): ${shippingFee} ج.م\n`;
    text += `*الإجمالي النهائي: ${totalAmount} ج.م*\n\n`;

    text += `*بيانات الشحن والتوصيل:*\n`;
    text += `- الهاتف: ${customerPhone}\n`;
    text += `- المحافظة: ${customerCity}\n`;
    text += `- العنوان: ${customerAddress}\n`;

    if (customerNote) {
      text += `\n*ملاحظة إضافية:* ${customerNote}\n`;
    }

    text += `\nيرجى تأكيد الطلب والبدء في إجراءات الشحن والتسليم.`;

    const url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  } catch (err) {
    console.error(err);
  }
}
