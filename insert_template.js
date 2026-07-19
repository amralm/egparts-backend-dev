const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function addTemplate() {
  const template = {
    code: 'platform_password_reset',
    channel: 'whatsapp',
    language: 'ar',
    subject: 'رابط استعادة كلمة المرور',
    body_text: 'مرحباً،\nلقد تم إصدار رابط استعادة كلمة المرور لحسابك في منصة EG Parts بناءً على طلب الإدارة.\n\nالرابط صالح لمدة قصيرة. يرجى الدخول إليه عبر:\n{{reset_link}}\n\nإذا لم تطلب ذلك، يرجى تجاهل هذه الرسالة.',
    body_html: 'مرحباً،<br>لقد تم إصدار رابط استعادة كلمة المرور لحسابك في منصة EG Parts بناءً على طلب الإدارة.<br><br>الرابط صالح لمدة قصيرة. يرجى الدخول إليه عبر:<br>{{reset_link}}<br><br>إذا لم تطلب ذلك، يرجى تجاهل هذه الرسالة.',
    is_active: true
  };

  const { data, error } = await supabase.from('notification_templates').upsert([template], { onConflict: 'code,channel,language' });
  if (error) {
    console.error('Error inserting template:', error);
  } else {
    console.log('Template inserted successfully');
  }
}

addTemplate();
