'use strict';

/**
 * Egyptian-tailored conversational abandoned cart templates.
 * Designed to feel natural, human, and anti-spam with an explicit opt-out.
 */
const ABANDONED_CART_TEMPLATES = {
  friendly_reminder: {
    id: 'friendly_reminder',
    name: 'تذكير ودي بسيط',
    template: `أهلاً {customer_name} 👋
لاحظنا إنك سبت حاجات مميزة في سلتك في متجر {store_name} 🛒

حابب تكمل طلبك؟ السلة بتاعتك محفوظة وتقدر ترجعلها من هنا بضغطة واحدة:
{recovery_url}

لو محتاج أي مساعدة إحنا معاك في أي وقت!
(رد بـ "إيقاف" لو حابب تلغي التذكيرات)`,
  },
  friendly_discount: {
    id: 'friendly_discount',
    name: 'تذكير السلة المتروكة (افتراضي)',
    template: `يا هلا {customer_name} 👋
سبت منتجات في سلتك في {store_name} ومستنياك 🛍️

تقدر ترجع لسلتك وتكمل طلبك بكل سهولة من الرابط المباشر ده:
{recovery_url}

لو واجهتك أي مشكلة في إتمام الطلب، ابعتلنا وهنساعدك فوراً!
(رد بـ "إيقاف" لو حابب تلغي التذكيرات)`,
  },
  urgency_stock: {
    id: 'urgency_stock',
    name: 'تنبيه قرب نفاذ الكمية',
    template: `أهلاً {customer_name} ✨
حابين نفكرك إن المنتجات اللي اخترتها في سلتك في {store_name} عليها إقبال والكمية محدودة ⏳

تقدر تضمن حجز طلبك وتكمله دلوقتي من الرابط ده:
{recovery_url}

إحنا دايماً في خدمتك لأي استفسار!
(رد بـ "إيقاف" لو حابب تلغي التذكيرات)`,
  },
};

/**
 * Render abandoned cart template with variables
 */
function renderAbandonedCartMessage(templateKey, vars = {}) {
  const tplObj = ABANDONED_CART_TEMPLATES[templateKey] || ABANDONED_CART_TEMPLATES.friendly_discount;
  let text = tplObj.template;

  const customerName = vars.customerName ? vars.customerName.trim() : 'يا فندم';
  const storeName = vars.storeName ? vars.storeName.trim() : 'المتجر';
  const recoveryUrl = vars.recoveryUrl || '';

  text = text.replace(/\{customer_name\}/g, customerName);
  text = text.replace(/\{store_name\}/g, storeName);
  text = text.replace(/\{recovery_url\}/g, recoveryUrl);

  return text;
}

module.exports = {
  ABANDONED_CART_TEMPLATES,
  renderAbandonedCartMessage,
};
