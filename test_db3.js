require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
  const { data: activeTheme, error: themeError } = await supabase
    .from('platform_themes')
    .select('id, name, name_en, light_tokens, dark_tokens')
    .eq('id', 'midnight')
    .eq('is_published', true)
    .maybeSingle();
    
  console.log('Error:', themeError);
}
test();
