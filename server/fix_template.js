const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: 'C:/Users/Admin/Desktop/Osama/server/.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function fix() {
  const { data, error } = await supabase.from('notification_templates').insert([{
    code: 'tenant_invitation',
    channel: 'email',
    language: 'ar',
    subject: 'دعوة إدارة متجر EG-PARTS',
    body_html: '<p>مرحباً،</p><p>لقد تمت دعوتك لتفعيل حساب الإدارة.</p><p><a class="button" href="{{activation_link}}">قبول الدعوة</a></p><p>تنتهي الصلاحية خلال {{expires_hours}} ساعة.</p>',
    body_text: 'قبول الدعوة: {{activation_link}}',
    version: 1,
    is_active: true
  }]).select();
  
  if (error) console.error('Error:', error);
  else console.log('Successfully inserted Arabic template:', data);
}

fix();
