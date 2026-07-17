/**
 * Feature Registry - Single Source of Truth
 * 
 * This registry defines all system features using generic, domain-agnostic keys.
 * Do NOT use hardcoded strings anywhere in the application. Use `FEATURES.XYZ`.
 */

const FEATURES = {
    // ---------------------------------------------------------
    // Catalog & Inventory (Generic)
    // ---------------------------------------------------------
    CATALOG_ITEMS_MAX: "catalog.items.max",
    CATALOG_CATEGORIES_MAX: "catalog.categories.max",
    CATALOG_BRANDS_MAX: "catalog.brands.max",

    // ---------------------------------------------------------
    // Sales & CRM (Generic)
    // ---------------------------------------------------------
    SALES_ORDERS_MONTHLY: "sales.orders.monthly",
    CRM_CUSTOMERS_MAX: "crm.customers.max",

    // ---------------------------------------------------------
    // AI Engine (Generic)
    // ---------------------------------------------------------
    AI_MESSAGES_DAILY: "ai.messages.daily",
    AI_REQUESTS_MONTHLY: "ai.requests.monthly",
    AI_OCR_REQUESTS: "ai.ocr.requests",
    AI_ANALYTICS: "ai.analytics.enabled",

    // ---------------------------------------------------------
    // Access & Locations (Generic)
    // ---------------------------------------------------------
    ACCESS_USERS_MAX: "access.users.max",
    ACCESS_ROLES_ADVANCED: "access.roles.advanced",
    ACCESS_LOCATIONS_MAX: "access.locations.max",

    // ---------------------------------------------------------
    // Storage & Infrastructure
    // ---------------------------------------------------------
    STORAGE_GB: "storage.gb",
    INFRASTRUCTURE_BACKUP: "infrastructure.backup.enabled",

    // ---------------------------------------------------------
    // Messaging & Integrations
    // ---------------------------------------------------------
    MESSAGING_WHATSAPP_ENABLED: "messaging.whatsapp.enabled",
    MESSAGING_WHATSAPP_QUOTA: "messaging.whatsapp.monthly",
    MESSAGING_SMS_QUOTA: "messaging.sms.monthly",
    MESSAGING_EMAIL_QUOTA: "messaging.email.monthly",
    PAYMENTS_GATEWAYS_ENABLED: "payments.gateways.enabled",
    BRANDING_CUSTOM_DOMAIN: "branding.custom_domain.enabled",

    // ---------------------------------------------------------
    // Data & System
    // ---------------------------------------------------------
    DATA_EXPORTS_ENABLED: "data.exports.enabled",
    SYSTEM_API_REQUESTS_DAILY: "system.api.requests.daily",
    SYSTEM_WEBHOOKS_ENABLED: "system.webhooks.enabled",
    SYSTEM_BARCODE_ENABLED: "system.barcode.enabled"
};

/**
 * Feature Definitions Metadata
 * Used by the Seed Generator to automatically populate the database.
 */
const FEATURE_DEFINITIONS_METADATA = [
    // Catalog
    {
        key: FEATURES.CATALOG_ITEMS_MAX,
        display_name: "عناصر الكتالوج المسموحة",
        description: "الحد الأقصى لعدد العناصر (منتجات، خدمات، سيارات، الخ)",
        feature_type: "LIMIT",
        category: "Catalog",
        subcategory: "Items",
        unit: "item",
        reset_period: "LIFETIME",
        upgrade_priority: 10,
        billing_type: "INCLUDED",
        icon: "inventory_2"
    },
    {
        key: FEATURES.CATALOG_CATEGORIES_MAX,
        display_name: "التصنيفات المسموحة",
        description: "الحد الأقصى للتصنيفات",
        feature_type: "LIMIT",
        category: "Catalog",
        subcategory: "Categories",
        unit: "category",
        reset_period: "LIFETIME",
        upgrade_priority: 9,
        billing_type: "INCLUDED",
        icon: "category"
    },
    {
        key: FEATURES.CATALOG_BRANDS_MAX,
        display_name: "العلامات التجارية المسموحة",
        description: "الحد الأقصى للعلامات التجارية / الماركات",
        feature_type: "LIMIT",
        category: "Catalog",
        subcategory: "Brands",
        unit: "brand",
        reset_period: "LIFETIME",
        upgrade_priority: 8,
        billing_type: "INCLUDED",
        icon: "branding_watermark"
    },
    // Sales
    {
        key: FEATURES.SALES_ORDERS_MONTHLY,
        display_name: "الطلبات الشهرية",
        description: "حد الطلبات التي يمكن استقبالها شهرياً",
        feature_type: "LIMIT",
        category: "Sales",
        subcategory: "Orders",
        unit: "order",
        reset_period: "MONTHLY",
        upgrade_priority: 10,
        billing_type: "INCLUDED",
        icon: "shopping_cart"
    },
    // CRM
    {
        key: FEATURES.CRM_CUSTOMERS_MAX,
        display_name: "العملاء",
        description: "حد عدد العملاء المسجلين",
        feature_type: "LIMIT",
        category: "CRM",
        subcategory: "Customers",
        unit: "customer",
        reset_period: "LIFETIME",
        upgrade_priority: 5,
        billing_type: "INCLUDED",
        icon: "people"
    },
    // AI
    {
        key: FEATURES.AI_MESSAGES_DAILY,
        display_name: "رسائل الذكاء الاصطناعي اليومية",
        description: "عدد الرسائل المتاحة لمساعد الذكاء الاصطناعي يومياً",
        feature_type: "QUOTA",
        category: "AI",
        subcategory: "Messages",
        unit: "message",
        reset_period: "DAILY",
        upgrade_priority: 10,
        billing_type: "INCLUDED",
        icon: "smart_toy"
    },
    {
        key: FEATURES.AI_REQUESTS_MONTHLY,
        display_name: "طلبات الذكاء الاصطناعي الشهرية",
        description: "عدد الطلبات المعقدة شهرياً",
        feature_type: "QUOTA",
        category: "AI",
        subcategory: "Requests",
        unit: "request",
        reset_period: "MONTHLY",
        upgrade_priority: 9,
        billing_type: "INCLUDED",
        icon: "auto_awesome"
    },
    {
        key: FEATURES.AI_OCR_REQUESTS,
        display_name: "قراءة المستندات بالذكاء الاصطناعي",
        description: "عدد الصور أو المستندات المسموح قراءتها شهرياً",
        feature_type: "QUOTA",
        category: "AI",
        subcategory: "Vision",
        unit: "image",
        reset_period: "MONTHLY",
        upgrade_priority: 7,
        billing_type: "METERED",
        icon: "document_scanner"
    },
    {
        key: FEATURES.AI_ANALYTICS,
        display_name: "تحليلات الذكاء الاصطناعي",
        description: "تحليل ذكي للبيانات والمبيعات",
        feature_type: "BOOLEAN",
        category: "AI",
        subcategory: "Analytics",
        reset_period: "LIFETIME",
        upgrade_priority: 8,
        billing_type: "SUBSCRIPTION",
        icon: "query_stats"
    },
    // Users & Access
    {
        key: FEATURES.ACCESS_USERS_MAX,
        display_name: "المستخدمون / الموظفون",
        description: "عدد حسابات المستخدمين المسموح بها",
        feature_type: "LIMIT",
        category: "Access",
        subcategory: "Users",
        unit: "user",
        reset_period: "LIFETIME",
        upgrade_priority: 10,
        billing_type: "INCLUDED",
        icon: "badge"
    },
    {
        key: FEATURES.ACCESS_ROLES_ADVANCED,
        display_name: "صلاحيات متقدمة",
        description: "تخصيص دقيق للصلاحيات",
        feature_type: "BOOLEAN",
        category: "Access",
        subcategory: "Roles",
        reset_period: "LIFETIME",
        upgrade_priority: 6,
        billing_type: "SUBSCRIPTION",
        icon: "admin_panel_settings"
    },
    {
        key: FEATURES.ACCESS_LOCATIONS_MAX,
        display_name: "المواقع / الفروع",
        description: "عدد المواقع أو الفروع المسموح بها",
        feature_type: "LIMIT",
        category: "Access",
        subcategory: "Locations",
        unit: "location",
        reset_period: "LIFETIME",
        upgrade_priority: 10,
        billing_type: "INCLUDED",
        icon: "store"
    },
    // Storage
    {
        key: FEATURES.STORAGE_GB,
        display_name: "مساحة التخزين",
        description: "مساحة التخزين الإجمالية بالجيجابايت",
        feature_type: "LIMIT",
        category: "Storage",
        subcategory: "Media",
        unit: "GB",
        reset_period: "LIFETIME",
        upgrade_priority: 10,
        billing_type: "INCLUDED",
        icon: "cloud"
    },
    // Infrastructure
    {
        key: FEATURES.INFRASTRUCTURE_BACKUP,
        display_name: "نسخ احتياطي تلقائي",
        description: "أخذ نسخ احتياطية دورية للبيانات",
        feature_type: "BOOLEAN",
        category: "Infrastructure",
        subcategory: "Backups",
        reset_period: "LIFETIME",
        upgrade_priority: 6,
        billing_type: "SUBSCRIPTION",
        icon: "backup"
    },
    // Messaging
    {
        key: FEATURES.MESSAGING_WHATSAPP_ENABLED,
        display_name: "الربط مع واتساب",
        description: "تفعيل إرسال الإشعارات عبر واتساب",
        feature_type: "BOOLEAN",
        category: "Messaging",
        subcategory: "Channels",
        reset_period: "LIFETIME",
        upgrade_priority: 8,
        billing_type: "SUBSCRIPTION",
        icon: "chat"
    },
    {
        key: FEATURES.MESSAGING_WHATSAPP_QUOTA,
        display_name: "رسائل واتساب",
        description: "رصيد رسائل واتساب الشهري",
        feature_type: "QUOTA",
        category: "Messaging",
        subcategory: "Channels",
        unit: "message",
        reset_period: "MONTHLY",
        upgrade_priority: 8,
        billing_type: "METERED",
        icon: "send"
    },
    {
        key: FEATURES.MESSAGING_SMS_QUOTA,
        display_name: "رسائل SMS",
        description: "رصيد رسائل SMS الشهري",
        feature_type: "QUOTA",
        category: "Messaging",
        subcategory: "Channels",
        unit: "message",
        reset_period: "MONTHLY",
        upgrade_priority: 7,
        billing_type: "METERED",
        icon: "sms"
    },
    {
        key: FEATURES.MESSAGING_EMAIL_QUOTA,
        display_name: "رسائل البريد الإلكتروني",
        description: "رصيد رسائل البريد الإلكتروني الشهري",
        feature_type: "QUOTA",
        category: "Messaging",
        subcategory: "Channels",
        unit: "email",
        reset_period: "MONTHLY",
        upgrade_priority: 6,
        billing_type: "INCLUDED",
        icon: "email"
    },
    {
        key: FEATURES.PAYMENTS_GATEWAYS_ENABLED,
        display_name: "بوابات الدفع",
        description: "تفعيل بوابات الدفع الإلكتروني",
        feature_type: "BOOLEAN",
        category: "Payments",
        subcategory: "Gateways",
        reset_period: "LIFETIME",
        upgrade_priority: 9,
        billing_type: "SUBSCRIPTION",
        icon: "payments"
    },
    {
        key: FEATURES.BRANDING_CUSTOM_DOMAIN,
        display_name: "نطاق مخصص",
        description: "ربط متجرك بنطاق خاص",
        feature_type: "BOOLEAN",
        category: "Branding",
        subcategory: "Domain",
        reset_period: "LIFETIME",
        upgrade_priority: 10,
        billing_type: "SUBSCRIPTION",
        icon: "language"
    },
    // System
    {
        key: FEATURES.SYSTEM_API_REQUESTS_DAILY,
        display_name: "طلبات API اليومية",
        description: "حد استخدام الواجهة البرمجية",
        feature_type: "RATE_LIMIT",
        category: "System",
        subcategory: "API",
        unit: "request",
        reset_period: "DAILY",
        upgrade_priority: 4,
        billing_type: "INCLUDED",
        icon: "api"
    },
    {
        key: FEATURES.DATA_EXPORTS_ENABLED,
        display_name: "تصدير البيانات",
        description: "تصدير البيانات إلى Excel/CSV",
        feature_type: "BOOLEAN",
        category: "System",
        subcategory: "Data",
        reset_period: "LIFETIME",
        upgrade_priority: 5,
        billing_type: "SUBSCRIPTION",
        icon: "download"
    },
    {
        key: FEATURES.SYSTEM_WEBHOOKS_ENABLED,
        display_name: "الويب هوك (Webhooks)",
        description: "ربط المتجر بالأنظمة الخارجية",
        feature_type: "BOOLEAN",
        category: "System",
        subcategory: "Integrations",
        reset_period: "LIFETIME",
        upgrade_priority: 7,
        billing_type: "SUBSCRIPTION",
        icon: "webhook"
    },
    {
        key: FEATURES.SYSTEM_BARCODE_ENABLED,
        display_name: "الباركود والملصقات",
        description: "طباعة الباركود والملصقات",
        feature_type: "BOOLEAN",
        category: "System",
        subcategory: "Hardware",
        reset_period: "LIFETIME",
        upgrade_priority: 6,
        billing_type: "SUBSCRIPTION",
        icon: "qr_code_scanner"
    }
];

class FeatureRegistry {
    /**
     * Get a feature definition by its key (e.g. 'catalog.items.max')
     * @param {string} key 
     */
    static getDefinition(key) {
        return FEATURE_DEFINITIONS_METADATA.find(f => f.key === key);
    }

    /**
     * Get all feature definitions
     */
    static getAllDefinitions() {
        return FEATURE_DEFINITIONS_METADATA;
    }
}

module.exports = {
    FEATURES,
    FEATURE_DEFINITIONS_METADATA,
    FeatureRegistry
};
