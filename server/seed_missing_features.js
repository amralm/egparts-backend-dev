const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
require('dotenv').config({ path: 'c:/Users/Admin/Desktop/Osama/server/.env' });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const missingFeatures = [
    { key: 'bandwidth.gb', name: 'Bandwidth', desc: 'Data transfer limit in GB', type: 'LIMIT', unit: 'GB', period: 'MONTHLY', cat: 'Infrastructure' },
    { key: 'email_messages_month', name: 'Email Messages', desc: 'Monthly email sending limit', type: 'QUOTA', unit: 'message', period: 'MONTHLY', cat: 'Messaging' },
    { key: 'sms.messages.monthly', name: 'SMS Messages', desc: 'Monthly SMS sending limit', type: 'QUOTA', unit: 'message', period: 'MONTHLY', cat: 'Messaging' },
    { key: 'push_notifications_month', name: 'Push Notifications', desc: 'Monthly push notifications', type: 'QUOTA', unit: 'notification', period: 'MONTHLY', cat: 'Messaging' },
    { key: 'webhooks.max', name: 'Webhooks', desc: 'Max active webhooks', type: 'LIMIT', unit: 'webhook', period: 'LIFETIME', cat: 'Integrations' },
    { key: 'integrations.max', name: 'Integrations', desc: 'Max active external integrations', type: 'LIMIT', unit: 'integration', period: 'LIFETIME', cat: 'Integrations' },
    { key: 'jobs.monthly', name: 'Background Jobs', desc: 'Monthly background jobs execution', type: 'QUOTA', unit: 'job', period: 'MONTHLY', cat: 'System' },
    { key: 'exports.monthly', name: 'Data Exports', desc: 'Monthly export operations', type: 'QUOTA', unit: 'export', period: 'MONTHLY', cat: 'Data' },
    { key: 'imports.monthly', name: 'Data Imports', desc: 'Monthly import operations', type: 'QUOTA', unit: 'import', period: 'MONTHLY', cat: 'Data' },
    { key: 'reports.generated.monthly', name: 'Report Generation', desc: 'Monthly generated reports', type: 'QUOTA', unit: 'report', period: 'MONTHLY', cat: 'Analytics' },
    { key: 'audit.retention.days', name: 'Audit Log Retention', desc: 'Days to keep audit logs', type: 'LIMIT', unit: 'days', period: 'LIFETIME', cat: 'Security' },
    { key: 'db.rows.max', name: 'Database Rows', desc: 'Maximum database rows per tenant', type: 'LIMIT', unit: 'row', period: 'LIFETIME', cat: 'Infrastructure' },
    { key: 'uploaded_images', name: 'Uploaded Images', desc: 'Limit on uploaded images count', type: 'LIMIT', unit: 'image', period: 'LIFETIME', cat: 'Media' },
    { key: 'uploaded_files', name: 'Uploaded Files', desc: 'Limit on uploaded files count', type: 'LIMIT', unit: 'file', period: 'LIFETIME', cat: 'Media' },
    { key: 'image.processing.monthly', name: 'Image Processing', desc: 'Monthly image processing ops', type: 'QUOTA', unit: 'operation', period: 'MONTHLY', cat: 'Media' },
    { key: 'pdf.generation.monthly', name: 'PDF Generation', desc: 'Monthly PDF generation ops', type: 'QUOTA', unit: 'document', period: 'MONTHLY', cat: 'Media' },
    { key: 'warehouses.max', name: 'Warehouses', desc: 'Max warehouses allowed', type: 'LIMIT', unit: 'warehouse', period: 'LIFETIME', cat: 'Inventory' },
    { key: 'pos.devices.max', name: 'POS Devices', desc: 'Max active POS devices', type: 'LIMIT', unit: 'device', period: 'LIFETIME', cat: 'Sales' },
    { key: 'api.keys.max', name: 'API Keys', desc: 'Max active API keys', type: 'LIMIT', unit: 'key', period: 'LIFETIME', cat: 'API' },
    { key: 'multi_currency.enabled', name: 'Multi Currency', desc: 'Enable multi-currency support', type: 'BOOLEAN', unit: null, period: 'LIFETIME', cat: 'Commerce' },
    { key: 'white_label.enabled', name: 'White Label', desc: 'Remove platform branding', type: 'BOOLEAN', unit: null, period: 'LIFETIME', cat: 'Branding' },
    { key: 'sso.enabled', name: 'SSO Login', desc: 'Enable Single Sign-On', type: 'BOOLEAN', unit: null, period: 'LIFETIME', cat: 'Security' },
    { key: 'custom_css.enabled', name: 'Custom CSS', desc: 'Allow custom CSS overrides', type: 'BOOLEAN', unit: null, period: 'LIFETIME', cat: 'Branding' }
];

async function seedFeatures() {
    for (const feat of missingFeatures) {
        const payload = {
            id: crypto.randomUUID(),
            key: feat.key,
            display_name: feat.name,
            description: feat.desc,
            feature_type: feat.type,
            unit: feat.unit,
            reset_period: feat.period,
            category: feat.cat,
            is_active: true,
            billing_type: 'INCLUDED',
            visible_to_customer: true,
            visible_to_admin: true,
            schema_version: 1
        };

        const { error } = await supabase.from('feature_definitions').upsert(payload, { onConflict: 'key' });
        if (error) {
            console.error(`Error inserting ${feat.key}:`, error.message);
        } else {
            console.log(`Inserted/Updated: ${feat.key}`);
        }
    }
    console.log("Seeding complete.");
}

seedFeatures();
