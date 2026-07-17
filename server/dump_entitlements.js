const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: 'c:/Users/Admin/Desktop/Osama/server/.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function dump() {
    const tables = [
        'feature_definitions',
        'plans',
        'plan_versions',
        'plan_feature_limits',
        'store_feature_overrides',
        'store_addons',
        'feature_usage',
        'policy_decisions'
    ];

    const results = {};
    for (const table of tables) {
        const { data, error } = await supabase.from(table).select('*').limit(50);
        if (error) {
            results[table] = `ERROR: ${error.message}`;
        } else {
            results[table] = data;
        }
    }
    console.log(JSON.stringify(results, null, 2));
}

dump();
