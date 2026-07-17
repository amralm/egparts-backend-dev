require('dotenv').config({path: '../.env'});
const { createClient } = require('@supabase/supabase-js');
if (!process.env.SUPABASE_URL) process.env.SUPABASE_URL = process.env.VITE_SUPABASE_URL;
if (!process.env.SUPABASE_SERVICE_KEY) process.env.SUPABASE_SERVICE_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function addCol() {
    const res = await supabase.rpc('exec_sql', {
        sql_string: "ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS business_type text DEFAULT 'general';"
    });
    console.log(res);
}
addCol();
